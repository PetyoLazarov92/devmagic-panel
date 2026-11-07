import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionInput, ArchiveReason, TrashEntry } from '@devmagic-panel/shared';
import { ARCHIVE_REASONS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobStep } from '../jobs.js';
import type { Secrets } from '../secrets.js';
import { importSql } from './db.js';
import { isPolicyRefusal, mysqlPassword } from './mysql-password.js';
import type { LimitsMemo } from '../mysql-limits.js';
import { readDbPassword } from './wpconfig.js';
import { setConstant } from './wpconfig-edit.js';

/** Deleted sites stay restorable this long, then the panel purges them. */
export const TRASH_DAYS = 14;

export class TrashRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

/**
 * The lines dmp-root trash-list prints: id, domain, deleted-at (epoch), size,
 * panel-made, database, reason and 1 when it holds the database export. An
 * older dmp-root prints the first six only.
 */
export function parseTrashList(text: string, days = TRASH_DAYS): TrashEntry[] {
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((f) => f.length >= 6 && f[0] && f[1])
    .map(([id, domain, deletedAt, size, panelMade, dbName, reason, dump]) => {
      const deleted = Number(deletedAt) * 1000;
      return {
        id: id as string,
        domain: domain as string,
        deletedAt: new Date(deleted).toISOString(),
        purgeAt: new Date(deleted + days * 86_400_000).toISOString(),
        sizeBytes: Number(size) || 0,
        panelMade: panelMade === '1',
        ...(dbName && dbName !== '-' ? { dbName } : {}),
        reason: (ARCHIVE_REASONS as readonly string[]).includes(reason ?? '') ? (reason as ArchiveReason) : 'deleted',
        hasDump: dump === undefined ? Boolean(dbName && dbName !== '-') : dump === '1',
      };
    })
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function listTrash(exec: Executor, dmpRoot: string): Promise<TrashEntry[]> {
  const r = await runRoot(exec, dmpRoot, ['trash-list']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'dmp-root trash-list failed');
  return parseTrashList(r.stdout);
}

/** Drops entries older than TRASH_DAYS; the panel runs it at start and every few hours. */
export const purgeTrash = (exec: Executor, dmpRoot: string) => runRoot(exec, dmpRoot, ['trash-purge', String(TRASH_DAYS)]);

/** Free space where the trash lives, for the remove dialog; STATE_DIR may not exist yet, so its parent is asked. */
export function trashFreeBytes(config: SystemConfig): number | undefined {
  for (const dir of [join(config.STATE_DIR, 'trash'), config.STATE_DIR, dirname(config.STATE_DIR)]) {
    try {
      const fs = statfsSync(dir);
      return fs.bavail * fs.bsize;
    } catch {
      // not there yet; try the parent
    }
  }
  return undefined;
}

export interface TrashContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  secrets: Secrets | null;
  /** Where raised MySQL limits are noted until they are put back. */
  store?: LimitsMemo;
}

const SQL_NAME = /^[A-Za-z0-9_]{1,64}$/;
const sqlString = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Puts a deleted site back: dmp-root restores the folder, vhost, certificate
 * and hosts line when none of them exists again, then the panel recreates the
 * database (and the per-site user, with the password in the restored
 * wp-config.php) and imports the dump. The trash entry goes once all is back.
 */
export async function planTrashRestore(ctx: TrashContext, { id }: Pick<ActionInput<'trash.restore'>, 'id'>, options: { replacingDb?: string } = {}): Promise<JobStep[]> {
  const entry = (await listTrash(ctx.exec, ctx.dmpRoot)).find((e) => e.id === id);
  if (!entry) throw new TrashRefused(`no deleted site ${id}`);
  const mysql = ctx.secrets?.mysql;
  if (entry.dbName) {
    if (!mysql) throw new TrashRefused('Set up the MySQL admin account first (Aura, Machine checks): the database is restored with the site');
    const dbs = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e', 'SHOW DATABASES'], { env: { MYSQL_PWD: mysql.password } });
    if (dbs.code !== 0) throw new TrashRefused(`cannot reach MySQL: ${dbs.stderr.trim()}`);
    // The site it replaces drops its own database first, so that one may exist now.
    if (dbs.stdout.split('\n').includes(entry.dbName) && entry.dbName !== options.replacingDb) throw new TrashRefused(`database ${entry.dbName} exists again; remove it first`);
  }

  const docroot = join(ctx.config.WEB_DIR, entry.domain);
  let dump: string | undefined;
  const steps: JobStep[] = [
    {
      id: 'files',
      label: `Restore the folder, vhost, certificate and hosts line of ${entry.domain}`,
      weight: 4,
      run: async () => {
        const r = await runRoot(ctx.exec, ctx.dmpRoot, ['trash-restore', id], 60 * 60_000);
        dump = /^DUMP=(.+)$/m.exec(r.stdout)?.[1]?.trim();
        return r;
      },
    },
  ];
  if (entry.dbName && mysql) {
    const dbName = entry.dbName;
    steps.push({
      id: 'db',
      label: `Create database ${dbName}`,
      run: async () => {
        const configFile = join(docroot, 'wp-config.php');
        const text = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
        const user = /define\(\s*['"]DB_USER['"]\s*,\s*['"]([A-Za-z0-9_]{1,64})['"]/.exec(text)?.[1];
        const password = readDbPassword(text);
        const sql = (statements: string) => ctx.exec('mysql', ['--user', mysql.user, '--host', mysql.host], { env: { MYSQL_PWD: mysql.password }, input: statements });
        const made = await sql(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        if (made.code !== 0) return made;
        // The per-site user the panel dropped with the site comes back with the same password; a shared account is left alone.
        if (!user || !SQL_NAME.test(user) || user !== dbName.slice(0, 32) || user === mysql.user || password === undefined) return ok(`created ${dbName}`);
        const host = mysql.host === '127.0.0.1' ? '127.0.0.1' : 'localhost';
        const createUser = (pass: string) => sql(`CREATE USER IF NOT EXISTS '${user}'@'${host}' IDENTIFIED BY '${sqlString(pass)}';\nGRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${user}'@'${host}';`);
        const r = await createUser(password);
        if (r.code === 0) return ok(`created ${dbName} and its user ${user}`);
        if (!isPolicyRefusal(r.stderr)) return r;
        // An old, simple password MySQL's policy now refuses: a new one, written to wp-config.php before the user exists with it.
        const fresh = mysqlPassword();
        try {
          writeFileSync(configFile, setConstant(text, 'DB_PASSWORD', fresh));
        } catch (error) {
          return { code: 1, stdout: '', stderr: `MySQL refused the old database password and wp-config.php cannot be updated: ${(error as Error).message}` };
        }
        const again = await createUser(fresh);
        return again.code === 0 ? ok(`created ${dbName} and its user ${user}; MySQL refused the old password, so the user has a new one, also in wp-config.php`) : again;
      },
    });
    steps.push({
      id: 'import',
      label: 'Import the database',
      weight: 6,
      run: async (job) => {
        if (!dump || !existsSync(dump)) return { code: 1, stdout: '', stderr: 'the restored dump is missing; restore again' };
        try {
          return await importSql(ctx.exec, docroot, entry.domain, dump, { job, mysql, memo: ctx.store });
        } finally {
          rmSync(dump, { force: true });
        }
      },
    });
  }
  steps.push({
    id: 'cleanup',
    label: 'Remove the copy from the Archive',
    run: async () => {
      // The site is back by now; an entry already gone takes nothing from it.
      const r = await runRoot(ctx.exec, ctx.dmpRoot, ['trash-delete', id]);
      return r.code !== 0 && /no trash entry/.test(r.stderr) ? ok('the entry was already gone') : r;
    },
  });
  return steps;
}

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput, ArchiveReason } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { forgetCompat } from '../php/compat.js';
import type { Secrets } from '../secrets.js';
import type { RunStore } from '../store.js';
import { readSiteVhosts } from './vhost.js';
import { parseWpConfig } from './wpconfig.js';

export interface RemoveContext {
  config: SystemConfig;
  exec: Executor;
  secrets: Secrets | null;
  dmpRoot: string;
  /** Where how the site was installed is kept; it moves to the archive with the site. */
  store?: RunStore;
  /** Beside the panel's data folder, where the compatibility scanner keeps its cache. */
  uploadsDir?: string;
}

export class RemoveRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const SQL_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** The stamp a removal uses for its database export and trash entry: 20261024-153000, in UTC. */
export const removalStamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** The time a stamp stands for, as an ISO date. */
export const stampDate = (stamp: string) => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;

/**
 * Removes a site, made by the panel or not, into the trash: the database is
 * exported first, then dmp-root archives the folder, vhost, certificate and
 * dump, checks the archive, and only then removes them. The database is
 * dropped last. Deleted sites can be restored until they are purged after
 * TRASH_DAYS days. Hosts lines outside the panel's block stay as they are.
 */
export function planRemove(ctx: RemoveContext, { domain }: Pick<ActionInput<'site.remove'>, 'domain'>, stamp = removalStamp(), reason: ArchiveReason = 'deleted'): JobStep[] {
  const { config, exec } = ctx;
  const vhosts = readSiteVhosts(config);
  const vhost = vhosts.find((v) => v.names[0] === domain);
  if (!vhost?.docroot) throw new RemoveRefused(`no site called ${domain}`);
  const docroot = vhost.docroot;
  const refusal = removalRefusal(config, domain, docroot, vhost.file);
  if (refusal) throw new RemoveRefused(refusal);

  const root = (args: string[], timeoutMs?: number) => runRoot(exec, ctx.dmpRoot, args, timeoutMs);
  const configFile = join(docroot, 'wp-config.php');
  const wp = existsSync(configFile) ? parseWpConfig(readFileSync(configFile, 'utf8')) : null;
  const mysql = ctx.secrets?.mysql;

  // Another site pointing at the same database keeps it.
  const shared = vhosts.some((v) => {
    if (v === vhost || !v.docroot || !wp?.dbName) return false;
    const other = join(v.docroot, 'wp-config.php');
    return existsSync(other) && parseWpConfig(readFileSync(other, 'utf8')).dbName === wp.dbName;
  });
  const dbName = wp?.dbName && SQL_NAME.test(wp.dbName) && !shared ? wp.dbName : null;
  if (dbName && !mysql) throw new RemoveRefused('Set up the MySQL admin account first (Environment page): the database is exported and dropped with the site');
  // Only the per-site user the panel made (the database name, cut to 32 characters) is dropped, and made again on restore.
  const dbUser = dbName && wp?.dbUser && wp.dbUser === dbName.slice(0, 32) && wp.dbUser !== mysql?.user && SQL_NAME.test(wp.dbUser) ? wp.dbUser : null;

  const steps: JobStep[] = [];
  const add = (id: string, label: string, run: JobStep['run'], weight?: number) => steps.push({ id, label, run, ...(weight ? { weight } : {}) });

  add('backup', 'Back up vhosts, certificates and hosts', () => root(['backup']));

  if (dbName) {
    const dir = join(config.BACKUP_DIR, 'sites');
    const sql = join(dir, `${domain}-${stamp}.sql`);
    add('export', `Export database ${dbName}`, async () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const r = await exec('wp', [`--path=${docroot}`, `--url=https://${domain}/`, 'db', 'export', sql, '--skip-plugins', '--skip-themes'], { timeoutMs: 60 * 60_000 });
      if (r.code !== 0) return r;
      await pipeline(createReadStream(sql), createGzip(), createWriteStream(`${sql}.gz`, { mode: 0o600 }));
      rmSync(sql, { force: true });
      return ok(`database exported to ${sql}.gz`);
    }, 4);
  }

  add('archive', 'Archive the site', () => root(['trash-site', domain, stamp, dbName ?? '-', dbUser ?? '-', reason], 60 * 60_000), 6);
  add('remove', 'Remove the vhost, certificate, hosts line and folder', async () => {
    const r = await root(['trash-remove', domain, stamp], 30 * 60_000);
    if (r.code === 0 && ctx.store) {
      ctx.store.archiveInstall(domain, `${domain}-${stamp}`);
      // Its compatibility scans (and those of its installs under a path) were of this copy of the site.
      forgetCompat(ctx.store, ctx.uploadsDir ? dirname(ctx.uploadsDir) : undefined, { domain });
    }
    return r;
  }, 2);

  if (dbName && mysql) {
    add('db', dbUser ? `Drop database ${dbName} and user ${dbUser}` : `Drop database ${dbName}`, async () => {
      const statements = [`DROP DATABASE IF EXISTS \`${dbName}\`;`];
      if (dbUser) statements.push(`DROP USER IF EXISTS '${dbUser}'@'localhost', '${dbUser}'@'127.0.0.1';`);
      const r = await exec('mysql', ['--user', mysql.user, '--host', mysql.host], { env: { MYSQL_PWD: mysql.password }, input: statements.join('\n') });
      return r.code === 0 ? ok(`dropped ${dbName}${dbUser ? ` and ${dbUser}` : ''}`) : r;
    });
  }

  return steps;
}

/**
 * Why a site cannot go to the trash, or null. dmp-root archives the folder at
 * WEB_DIR/<domain> and vhosts named <domain>-ssl.conf or <domain>.conf, the
 * way the panel and devmagic lay sites out; anything else is left to a person.
 */
export function removalRefusal(config: SystemConfig, domain: string, docroot: string, vhostFile: string): string | null {
  if (docroot !== join(config.WEB_DIR, domain)) return `${domain} lives in ${docroot}, not ${join(config.WEB_DIR, domain)}; remove it by hand`;
  if (![`${domain}-ssl.conf`, `${domain}.conf`].includes(basename(vhostFile))) return `${domain}'s vhost is ${basename(vhostFile)}, not ${domain}-ssl.conf; remove it by hand`;
  return null;
}

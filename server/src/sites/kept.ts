import type { ActionInput, KeptDatabaseInfo } from '@devmagic-panel/shared';
import { keptDatabaseName } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import type { LimitsTarget, MysqlAccount } from '../mysql-limits.js';
import { freshStatsSql } from '../mysql-stats.js';
import type { KeptDatabase, RunStore } from '../store.js';
import { type DbContext, DbRefused, flush, isLocalDbHost, limitsTarget, wpFor } from './db.js';
import { siteFor } from './site-actions.js';
import { KEEP_DAYS, keepName, renames, sql, tablesOf } from './swap.js';

/**
 * The databases swaps keep a site's tables from before in: listed per site
 * with when they go, put back with one RENAME TABLE (the tables taken out
 * are kept the same way, so a restore can be undone too), dropped on
 * request, and purged by housekeeping after KEEP_DAYS days. Only databases
 * the panel noted are ever dropped.
 */

const DAY = 86_400_000;
export const purgeAt = (createdAt: string) => new Date(new Date(createdAt).getTime() + KEEP_DAYS * DAY).toISOString();

export interface KeptContext extends DbContext {
  store: RunStore;
}

/** The size of each database that exists, by name; null when the admin account cannot read them. */
async function databaseSizes(exec: Executor, mysql: MysqlAccount, names: readonly string[]): Promise<Map<string, number> | null> {
  if (names.length === 0) return new Map();
  const list = names.map((n) => `'${n}'`).join(', ');
  const r = await exec(
    'mysql',
    [
      '--batch', '--skip-column-names', '--user', mysql.user, '--host', mysql.host, '-e',
      `${await freshStatsSql(exec, mysql)}SELECT s.SCHEMA_NAME, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME WHERE s.SCHEMA_NAME IN (${list}) GROUP BY s.SCHEMA_NAME`,
    ],
    { env: { MYSQL_PWD: mysql.password } },
  );
  if (r.code !== 0) return null;
  return new Map(r.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')).map(([name, size]) => [name as string, Number(size) || 0]));
}

/**
 * A site's kept databases, newest first, with their size and when they go.
 * One dropped by hand since is forgotten.
 */
export async function listKept(store: RunStore, exec: Executor, mysql: MysqlAccount | null | undefined, site: string): Promise<KeptDatabaseInfo[]> {
  const records = store.keptDatabases(site).filter((k) => keptDatabaseName.safeParse(k.name).success);
  const sizes = mysql ? await databaseSizes(exec, mysql, records.map((k) => k.name)) : null;
  const out: KeptDatabaseInfo[] = [];
  for (const k of records) {
    if (sizes && !sizes.has(k.name)) {
      store.removeKeptDatabase(k.name);
      continue;
    }
    const size = sizes?.get(k.name);
    out.push({ name: k.name, reason: k.reason, createdAt: k.createdAt, purgeAt: purgeAt(k.createdAt), ...(size !== undefined ? { sizeBytes: size } : {}) });
  }
  return out;
}

/** The kept database a request names, the site's own, and the admin account to reach it. */
function keptFor(ctx: KeptContext, domain: string, path: string | undefined, name: string): { kept: KeptDatabase; target: LimitsTarget; db: string; docroot: string; host: string } {
  const site = siteFor(ctx.config, domain, path);
  const kept = ctx.store.keptDatabases(site.key).find((k) => k.name === name);
  if (!kept) throw new DbRefused(`${site.host} has no kept database called ${name}`);
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  if (!target) throw new DbRefused('A kept database needs the MySQL admin account (Aura, Machine checks)');
  if (site.wp.dbName !== kept.db) throw new DbRefused(`${name} holds tables of ${kept.db}, but wp-config.php now uses ${site.wp.dbName ?? 'no database'}`);
  return { kept, target, db: kept.db, docroot: site.docroot, host: site.host };
}

const day = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * Puts a kept database's tables back. Out of the site's database go the
 * tables of the same names and, when the kept database says which tables
 * the site had then, every table it did not have, so the database is as it
 * was; they are kept in a new kept database. Tables the site had then and
 * still has, untouched by the swap, stay.
 */
export function planRestoreKept(ctx: KeptContext, { domain, path, name }: ActionInput<'db.restoreKept'>): JobStep[] {
  const { kept, target, db, docroot, host } = keptFor(ctx, domain, path, name);
  return [
    {
      id: 'restore',
      label: `Put back the tables kept on ${day(kept.createdAt)}`,
      run: async () => {
        const back = await tablesOf(target, name);
        if (back.result.code !== 0) return back.result;
        const incoming = back.tables.filter((t) => !t.view).map((t) => t.name).filter((t) => /^[\w$]+$/.test(t));
        if (incoming.length === 0) return { code: 1, stdout: '', stderr: `${name} has no tables to put back` };
        const now = await tablesOf(target, db);
        if (now.result.code !== 0) return now.result;
        // Views stay where they are: only tables move.
        const current = now.tables.filter((t) => !t.view).map((t) => t.name);
        const outgoing = current.filter((t) => incoming.includes(t) || (kept.before !== undefined && !kept.before.includes(t)));
        // Named to the second: one put back the second it was made gets the next second's name.
        const out = keepName(db) === name ? keepName(db, new Date(Date.now() + 1000)) : keepName(db);
        const moves: Array<[string, string, string]> = [...outgoing.map((t): [string, string, string] => [db, out, t]), ...incoming.map((t): [string, string, string] => [name, db, t])];
        const makeOut = outgoing.length > 0 ? [`DROP DATABASE IF EXISTS \`${out}\`;`, `CREATE DATABASE \`${out}\`;`] : [];
        const r = await sql(target, [...makeOut, renames(moves), `DROP DATABASE \`${name}\`;`]);
        if (r.code !== 0) {
          if (makeOut.length > 0) await sql(target, [`DROP DATABASE IF EXISTS \`${out}\`;`]);
          return r;
        }
        ctx.store.removeKeptDatabase(name);
        if (outgoing.length > 0) {
          ctx.store.addKeptDatabase({ name: out, site: kept.site, db, reason: `before putting back the tables kept on ${day(kept.createdAt)}`, createdAt: new Date().toISOString(), before: [...current].sort() });
        }
        return {
          code: 0,
          stdout:
            `${db} has its ${incoming.length} table${incoming.length === 1 ? '' : 's'} from ${day(kept.createdAt)} back` +
            (outgoing.length > 0 ? `; the ${outgoing.length} it had are kept in ${out} for ${KEEP_DAYS} days` : ''),
          stderr: '',
        };
      },
    },
    { id: 'flush', label: 'Flush caches and rewrite rules', run: flush(wpFor(ctx.exec, docroot, host)) },
  ];
}

export async function deleteKept(ctx: KeptContext, { domain, path, name }: ActionInput<'db.deleteKept'>): Promise<ExecResult> {
  const { target } = keptFor(ctx, domain, path, name);
  const r = await sql(target, [`DROP DATABASE IF EXISTS \`${name}\`;`]);
  if (r.code !== 0) return r;
  ctx.store.removeKeptDatabase(name);
  return { code: 0, stdout: `dropped ${name}`, stderr: '' };
}

/**
 * Drops the kept databases older than KEEP_DAYS days, except a site's that a
 * job is working on. Only names the panel noted and that look like its own.
 */
export async function purgeKept(store: RunStore, exec: Executor, mysql: MysqlAccount | null | undefined, busy: (site: string) => boolean, now = Date.now()): Promise<string[]> {
  if (!mysql) return [];
  const dropped: string[] = [];
  const failed: string[] = [];
  let why = '';
  for (const k of store.keptDatabases()) {
    if (new Date(purgeAt(k.createdAt)).getTime() > now || busy(k.site) || !keptDatabaseName.safeParse(k.name).success) continue;
    const r = await sql({ exec, mysql }, [`DROP DATABASE IF EXISTS \`${k.name}\`;`]);
    if (r.code !== 0) {
      failed.push(k.name);
      why ||= r.stderr.trim().split('\n').at(-1) ?? '';
      continue;
    }
    store.removeKeptDatabase(k.name);
    dropped.push(k.name);
  }
  // The others went: say which could not, so the task shows it failed instead of passing them by each hour.
  if (failed.length) throw new Error(`${dropped.length ? `dropped ${dropped.join(', ')}; ` : ''}could not drop ${failed.join(', ')}${why ? `: ${why}` : ''}`);
  return dropped;
}

/** The kept databases with their site as an action takes it (local.shop.com@learn is local.shop.com and /learn), for Drop all now. */
export function keptItems(store: Pick<RunStore, 'keptDatabases'>): Array<{ name: string; domain: string; path?: string; goesAt: string }> {
  return store
    .keptDatabases()
    .filter((k) => keptDatabaseName.safeParse(k.name).success)
    .map((k) => {
      const [domain = '', ...rest] = k.site.split('@');
      return { name: k.name, domain, ...(rest.length ? { path: `/${rest.join('/')}` } : {}), goesAt: purgeAt(k.createdAt) };
    });
}

/** "16 Nov": a day said short, for when a kept database goes. */
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The kept databases still waiting their days, said for the task's note and the storage row: how many, and when the oldest goes. */
export function keptLeft(store: Pick<RunStore, 'keptDatabases'>): string {
  const left = store.keptDatabases().filter((k) => keptDatabaseName.safeParse(k.name).success);
  if (left.length === 0) return '';
  const next = left.map((k) => purgeAt(k.createdAt)).sort()[0] as string;
  return `${left.length} kept, the oldest goes on ${shortDay(next)}`;
}

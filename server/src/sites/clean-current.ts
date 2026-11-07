import { existsSync } from 'node:fs';
import type { ActionInput, CleanPreview } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { type LimitsTarget, withRaisedLimits } from '../mysql-limits.js';
import { cleanStep, type CleanContext, type CleanState, emptiedTables, flushStep, freshStats, newCleanState, pluginsOffStep, sideTables, userStep, wpWithInput } from './clean.js';
import { DbRefused, formatBytes, isLocalDbHost, limitsTarget, wordpressSite } from './db.js';
import { siteFor } from './site-actions.js';
import { freeSpace } from './space.js';
import { sqlModeStatement } from './sql-stream.js';
import { canKeep, dropSide, KEEP_DAYS, keepName, makeSide, sideName, swapIn } from './swap.js';

/**
 * Clean this database: the clean-up of Prepare from production on the
 * database a site has now, like a production one imported before. It is
 * copied into a side database on the MySQL server (no dump file), cleaned
 * there with SQL while the site keeps working, then swapped in with the
 * tables from before kept for KEEP_DAYS days. No address is replaced.
 */

const LOGIN = /^[\w.@+ -]{1,60}$/;
const q = (name: string) => `\`${name}\``;

function query(target: LimitsTarget, sql: string): Promise<ExecResult> {
  const { user, host, password } = target.mysql;
  return target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', sql], { env: { MYSQL_PWD: password } });
}

const rowsOf = (r: ExecResult) =>
  r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));

/**
 * Why the database cannot go through a copy and a swap, or null when it can:
 * triggers do not move with RENAME TABLE, a generated column (VIRTUAL or
 * STORED; not a DEFAULT_GENERATED timestamp) cannot take INSERT ... SELECT *,
 * and the copy needs room on MySQL's disk. Views are no reason: only tables
 * are copied and swapped, so a view stays where it is and, naming its tables
 * by name, reads the clean ones after the swap. leftOutBytes: what the copy
 * leaves out, the rows of the tables the clean-up empties.
 */
export async function copyBlocker(target: LimitsTarget, db: string, free: (path: string) => { bytes: number } = freeSpace, leftOutBytes = 0): Promise<{ blocked: string | null; sizeBytes: number; views?: number }> {
  const in_ = `TABLE_SCHEMA = '${db}'`;
  const r = await query(
    target,
    `${await freshStats(target)}SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE ${in_} AND TABLE_TYPE = 'BASE TABLE'), (SELECT COUNT(*) FROM information_schema.TABLES WHERE ${in_} AND TABLE_TYPE = 'VIEW'), (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${db}'), (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE ${in_} AND (EXTRA LIKE '%VIRTUAL GENERATED%' OR EXTRA LIKE '%STORED GENERATED%')), (SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE ${in_}), @@datadir`,
  );
  if (r.code !== 0) return { blocked: `the MySQL admin account cannot read ${db}: ${r.stderr.trim().split('\n')[0] ?? ''}`, sizeBytes: 0 };
  const [tables = '0', views = '0', triggers = '0', generated = '0', size = '0', datadir = ''] = rowsOf(r)[0] ?? [];
  const sizeBytes = Number(size) || 0;
  if (Number(tables) === 0) return { blocked: `${db} has no tables to clean`, sizeBytes };
  if (Number(triggers) > 0) return { blocked: `${db} has triggers, which cannot move between databases`, sizeBytes };
  if (Number(generated) > 0) return { blocked: `${db} has generated columns, which a copy cannot fill`, sizeBytes };
  const dir = datadir.trim();
  // The copy, with room for its indexes to grow while it is made.
  const need = Math.round(Math.max(0, sizeBytes - leftOutBytes) * 1.2) + 512 * 1024 ** 2;
  if (dir && existsSync(dir) && free(dir).bytes < need) return { blocked: `a copy needs about ${formatBytes(need)} and MySQL's disk has ${formatBytes(free(dir).bytes)} free`, sizeBytes };
  return { blocked: null, sizeBytes, views: Number(views) || 0 };
}

/** The administrators by login, oldest first: a network's super admins from site_admins, else those with the administrator role. */
async function adminLogins(target: LimitsTarget, db: string, prefix: string, multisite: boolean): Promise<string[]> {
  const t = (name: string) => `${q(db)}.${q(`${prefix}${name}`)}`;
  if (multisite) {
    const r = await query(target, `SELECT meta_value FROM ${t('sitemeta')} WHERE meta_key = 'site_admins' LIMIT 1`);
    return r.code === 0 ? [...r.stdout.matchAll(/s:\d+:"([^"]+)"/g)].map((m) => m[1] as string).filter((l) => LOGIN.test(l)) : [];
  }
  const r = await query(
    target,
    `SELECT u.user_login FROM ${t('users')} u JOIN ${t('usermeta')} m ON m.user_id = u.ID WHERE m.meta_key = '${prefix}capabilities' AND m.meta_value LIKE '%"administrator"%' ORDER BY u.ID LIMIT 100`,
  );
  return r.code === 0 ? rowsOf(r).map(([login = '']) => login).filter((l) => LOGIN.test(l)) : [];
}

/** What the Clean this database card shows before it runs. */
export async function cleanPreview(ctx: Pick<CleanContext, 'config' | 'exec' | 'secrets' | 'store'>, domain: string, path: string | undefined): Promise<CleanPreview> {
  const site = siteFor(ctx.config, domain, path);
  const prefix = site.wp.tablePrefix ?? 'wp_';
  const multisite = site.wp.multisite;
  const empty = { tables: [], prefix, multisite, admins: [], sizeBytes: 0 };
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  if (!target) return { ...empty, blocked: "Needs the MySQL admin account (Aura, Machine checks) and the site's database on this machine." };
  const db = site.wp.dbName;
  if (!db) return { ...empty, blocked: 'wp-config.php has no DB_NAME.' };
  if (!canKeep(db)) return { ...empty, blocked: `The database name ${db} is too long or unusual to keep its tables aside.` };
  const [{ tables, result }, admins] = await Promise.all([sideTables(target, db), adminLogins(target, db, prefix, multisite)]);
  if (result.code !== 0) return { ...empty, blocked: `The MySQL admin account cannot read ${db}.` };
  const leftOutBytes = sumBytes(emptiedTables(tables, prefix));
  const check = await copyBlocker(target, db, freeSpace, leftOutBytes);
  const blocked = check.blocked ? `Cannot clean it this way: ${check.blocked}.` : undefined;
  return { tables: tables.map((t) => t.name), prefix, multisite, admins, sizeBytes: check.sizeBytes, leftOutBytes, ...(blocked ? { blocked } : {}) };
}

const sumBytes = (tables: ReadonlyArray<{ bytes?: number }>) => tables.reduce((n, t) => n + (t.bytes ?? 0), 0);

/**
 * Copies every table of db into its side database, on the server: CREATE
 * TABLE ... LIKE, then INSERT ... SELECT, but the tables the clean-up empties
 * (logs, form entries, orders) without their rows, which it would only
 * remove. Their row counts go to state for the clean-up's report.
 */
async function copyToSide(target: LimitsTarget, db: string, prefix: string, state: CleanState, job: JobRuntime): Promise<ExecResult[]> {
  const { tables, result } = await sideTables(target, db);
  if (result.code !== 0) return [result];
  const leftOut = emptiedTables(tables, prefix);
  const check = await copyBlocker(target, db, freeSpace, sumBytes(leftOut));
  if (check.blocked) return [{ code: 1, stdout: '', stderr: `cannot clean ${db} this way: ${check.blocked}` }];
  const skip = new Set(leftOut.map((t) => t.name));
  const made = await makeSide(target, db);
  if (made.code !== 0) return [made];
  const { user, host, password } = target.mysql;
  const mode = await query(target, 'SELECT @@SESSION.sql_mode');
  // The binary log off for this session (the admin account may), as for an import: a copy would write it all again there.
  const before = ['SET sql_log_bin = 0;', 'SET foreign_key_checks = 0;', 'SET unique_checks = 0;', ...(mode.code === 0 && sqlModeStatement(mode.stdout) ? [sqlModeStatement(mode.stdout)] : [])];
  const side = sideName(db);
  job.activity?.(`copying ${tables.length} tables (${formatBytes(check.sizeBytes)}) into ${side}: the site keeps working meanwhile`);
  if (leftOut.length > 0) job.activity?.(`${leftOut.length} table${leftOut.length === 1 ? '' : 's'} the clean empties, like logs, ${leftOut.length === 1 ? 'is' : 'are'} made without ${leftOut.length === 1 ? 'its' : 'their'} rows (${formatBytes(sumBytes(leftOut))} not copied)`);
  if (check.views) job.activity?.(`${check.views} view${check.views === 1 ? '' : 's'} stay${check.views === 1 ? 's' : ''} in ${db} and read${check.views === 1 ? 's' : ''} the clean tables after the swap`);
  for (const [i, table] of tables.entries()) {
    job.progress(i / tables.length, table.name);
    const r = await target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, side], {
      env: { MYSQL_PWD: password },
      input: `${[
        ...before,
        `CREATE TABLE ${q(side)}.${q(table.name)} LIKE ${q(db)}.${q(table.name)};`,
        ...(skip.has(table.name) ? [] : [`INSERT INTO ${q(side)}.${q(table.name)} SELECT * FROM ${q(db)}.${q(table.name)};`]),
      ].join('\n')}\n`,
      timeoutMs: 3 * 60 * 60_000,
    });
    if (r.code !== 0) {
      await dropSide(target, db);
      return [r];
    }
  }
  for (const t of leftOut) state.leftOutRows.set(t.name, t.rows);
  return [{ code: 0, stdout: `copied ${tables.length} tables into ${side}${leftOut.length > 0 ? `, ${leftOut.length} of them without their rows` : ''}`, stderr: '' }];
}

/** The job: copy, clean, swap, then the plugins, the user and a flush, as after Prepare from production. */
export function planCleanCurrent(ctx: CleanContext, { domain, path, user }: ActionInput<'db.cleanCurrent'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  if (!target) throw new DbRefused("Cleaning the database needs the MySQL admin account (Aura, Machine checks) and the site's database on this machine");
  const db = site.wp.dbName as string;
  if (!canKeep(db)) throw new DbRefused(`The database name ${db} is too long or unusual to keep its tables aside`);
  const prefix = site.wp.tablePrefix ?? 'wp_';
  const multisite = site.wp.multisite;
  const adminEmail = `admin@${site.domain}`;
  const state = newCleanState();
  return [
    {
      id: 'copy',
      label: `Copy ${db} beside the site`,
      weight: 4,
      run: (job) => withRaisedLimits(target, (line) => job.activity?.(line), () => copyToSide(target, db, prefix, state, job)),
    },
    cleanStep(target, sideName(db), prefix, adminEmail, user, state),
    {
      id: 'swap',
      label: 'Swap the clean tables in',
      weight: 0.2,
      run: async (job) => {
        const out = keepName(db);
        return swapIn(target, db, job, {
          out,
          keptFor: `for ${KEEP_DAYS} days`,
          onKept: (before) => {
            ctx.store?.addKeptDatabase({ name: out, site: site.key, db, reason: 'before cleaning it', createdAt: new Date().toISOString(), before });
          },
          afterUndo: () => ctx.store?.removeKeptDatabase(out),
        });
      },
    },
    pluginsOffStep(wp, multisite),
    userStep(wp, wpWithInput(ctx, site), { user, adminEmail, multisite, prefix, state }),
    flushStep(wp),
  ];
}

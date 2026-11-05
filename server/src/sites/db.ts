import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput, AddressInput, AddressPass, SnapshotInfo } from '@devmagic-panel/shared';
import { addressPasses, isLocalName, snapshotName } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { type LimitsMemo, type LimitsTarget, type MysqlAccount, withRaisedLimits } from '../mysql-limits.js';
import type { Secrets } from '../secrets.js';
import { sqlFileFor } from './dump.js';
import { canSwap, chooseMode, dropPrevious, dropSide, makeSide, prevName, sideName, swapIn, type SwapState } from './swap.js';
import { placeSites } from './network.js';
import { checkAddresses, runPasses, type TableFlag } from './replace.js';
import { siteFor, type SiteRef } from './site-actions.js';
import { dumpStream, importWrap, sqlModeStatement } from './sql-stream.js';
import { readUpload } from './uploads.js';
import { parseWpConfig } from './wpconfig.js';

export class DbRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

export interface DbContext {
  config: SystemConfig;
  exec: Executor;
  uploadsDir: string;
  /** The MySQL admin account: imports go straight into MySQL with it, and its limits are raised while they run. */
  secrets?: Secrets | null;
  /** Where raised MySQL limits are noted until they are put back. */
  store?: LimitsMemo;
}

/** wp-cli pinned to one site, without loading its plugins or theme (a broken plugin cannot stop a database job). */
/** Runs WP-CLI on a site; input goes to its stdin, like the SQL for wp db query. */
export type WpRunner = (args: string[], timeoutMs?: number, input?: string) => Promise<ExecResult>;

export function wpFor(exec: Executor, docroot: string, domain: string): WpRunner {
  return (args, timeoutMs = 60 * 60_000, input) =>
    exec('wp', [`--path=${docroot}`, `--url=https://${domain}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs, ...(input !== undefined ? { input } : {}) });
}

/** 1.2 GB style sizes for progress notes. */
export function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "1.2 GB of 3.4 GB, about 2 min left", from how fast it went so far. */
export function progressNote(done: number, total: number, startedAt: number, now = Date.now()): string {
  const elapsed = (now - startedAt) / 1000;
  const left = done > 0 && elapsed > 2 ? ((total - done) * elapsed) / done : undefined;
  const eta = left === undefined ? '' : left < 60 ? ', under a minute left' : `, about ${Math.round(left / 60)} min left`;
  return `${formatBytes(done)} of ${formatBytes(total)}${eta}`;
}

/** How an import reaches MySQL, and the limits it may raise. */
export interface ImportOptions {
  job?: JobRuntime | undefined;
  /** The admin account: used when the site's database is on this machine, so the binary log can be skipped and limits raised. */
  mysql?: MysqlAccount | null | undefined;
  memo?: LimitsMemo | undefined;
  /** Another database than the site's, like the side database of a swap: only with the admin account, never through WP-CLI. */
  database?: string | undefined;
}

/** A database host that is this machine's MySQL on its usual socket or port, where the admin account reaches the same server. */
export const isLocalDbHost = (host: string | undefined) => host === undefined || ['localhost', '127.0.0.1', '::1', 'localhost:3306', '127.0.0.1:3306'].includes(host.trim());

/** The admin account and the panel's note of raised limits, when imports may use them. */
export function limitsTarget(exec: Executor, mysql: MysqlAccount | null | undefined, memo?: LimitsMemo): LimitsTarget | null {
  return mysql && isLocalDbHost(mysql.host) ? { exec, mysql, memo } : null;
}

/**
 * Imports a .sql or .sql.gz dump, streamed with no file unpacked on the way.
 * With the admin account and a database on this machine it goes straight to
 * mysql, without the binary log and with MySQL's limits raised; otherwise
 * through wp db import, as before. Either way the stream carries WP-CLI's
 * own import speedups and drops a managed host's GTID lines, and the bytes
 * read are counted for the progress bar. It stops when nothing is read for
 * 15 minutes, never on a fixed clock.
 */
export async function importSql(exec: Executor, docroot: string, domain: string, file: string, options: ImportOptions = {}): Promise<ExecResult> {
  const { job } = options;
  const configFile = join(docroot, 'wp-config.php');
  const wp = existsSync(configFile) ? parseWpConfig(readFileSync(configFile, 'utf8')) : undefined;
  const note = (line: string) => job?.activity?.(line);
  let target = wp?.dbName && isLocalDbHost(wp.dbHost) ? limitsTarget(exec, options.mysql, options.memo) : null;
  let mode = target
    ? await exec('mysql', ['--batch', '--skip-column-names', '--user', target.mysql.user, '--host', target.mysql.host, '-e', 'SELECT @@SESSION.sql_mode'], { env: { MYSQL_PWD: target.mysql.password } })
    : undefined;
  if (options.database && (!target || mode?.code !== 0)) {
    return { code: 1, stdout: '', stderr: `cannot import into ${options.database}: it needs the MySQL admin account${mode?.stderr ? ` (${mode.stderr.trim().split('\n')[0]})` : ''}` };
  }
  if (mode && mode.code !== 0) {
    // The admin account does not sign in: the import goes through WP-CLI with the site's own account, as before.
    note(`imported with the site's database account: the MySQL admin account cannot sign in (${mode.stderr.trim().split('\n')[0]})`);
    target = null;
  }
  if (!target) mode = await wpFor(exec, docroot, domain)(['db', 'query', 'SELECT @@SESSION.sql_mode', '--skip-column-names'], 60_000);
  const wrap = importWrap(mode?.code === 0 ? sqlModeStatement(mode.stdout) : '', Boolean(target));

  const started = Date.now();
  let shown = 0;
  const run = () => {
    const input = dumpStream(file, wrap, (read, total) => {
      // About a hundred updates for the whole file is plenty.
      if (!job || (read - shown < total / 100 && read < total)) return;
      shown = read;
      job.progress(total ? read / total : 1, progressNote(read, total, started));
    });
    const streamed = { timeoutMs: 24 * 60 * 60_000, inputStream: input, inputStallMs: 15 * 60_000 };
    const database = options.database ?? wp?.dbName;
    if (!target || !database) return exec('wp', [`--path=${docroot}`, `--url=https://${domain}/`, 'db', 'import', '-', '--skip-plugins', '--skip-themes'], streamed);
    const { user, host, password } = target.mysql;
    return exec(
      'mysql',
      ['--user', user, '--host', host, `--default-character-set=${wp?.dbCharset ?? 'utf8mb4'}`, '--max-allowed-packet=1G', '--no-auto-rehash', database],
      { ...streamed, env: { MYSQL_PWD: password } },
    );
  };
  const r = await withRaisedLimits(target, note, run);
  return r.code === 0 ? { ...r, stdout: [r.stdout.trim(), `imported ${basename(file)}${target ? ` straight into MySQL${options.database ? `, into ${options.database}` : ''}` : ''}`].filter(Boolean).join('\n') } : r;
}

// ── snapshots ────────────────────────────────────────────────

/** A site's snapshot folder, by its key: the domain, or domain@path for a site under a path. */
export const snapshotDir = (config: SystemConfig, key: string) => join(config.BACKUP_DIR, 'snapshots', key);

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function listSnapshots(config: SystemConfig, domain: string): SnapshotInfo[] {
  const dir = snapshotDir(config, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => snapshotName.safeParse(name).success)
    .sort()
    .reverse()
    .map((name) => {
      const label = /^\d{8}-\d{6}-(.+)\.sql\.gz$/.exec(name)?.[1];
      const st = statSync(join(dir, name));
      return { name, ...(label ? { label } : {}), sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    });
}

/** Exports the database and gzips it into the site's snapshot folder (0600). */
export async function takeSnapshot(config: SystemConfig, wp: WpRunner, domain: string, label?: string): Promise<ExecResult> {
  const dir = snapshotDir(config, domain);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${stamp()}${label ? `-${label}` : ''}.sql.gz`;
  const sql = join(dir, `.${name}.sql`);
  try {
    const r = await wp(['db', 'export', sql]);
    if (r.code !== 0) return r;
    // The fastest level: several times quicker than the default on a big database, for a slightly bigger file.
    await pipeline(createReadStream(sql), createGzip({ level: 1 }), createWriteStream(join(dir, name), { mode: 0o600 }));
    return ok(`snapshot saved to ${join(dir, name)}`);
  } finally {
    rmSync(sql, { force: true });
  }
}

/** Where a search and replace looks: the tables WP-CLI picks with flag, less the ones the dump scan shows hold none of the addresses. */
interface PassScope {
  tables: TableFlag;
  /** From the dump scan after an import; without it every table is searched. */
  tableHosts?: Readonly<Record<string, readonly string[]>> | undefined;
  job?: JobRuntime | undefined;
}

/**
 * Replaces production domains after an import. Without --precise, WP-CLI runs
 * plain SQL on columns that hold no serialized data and PHP only on the rest:
 * many times faster, and serialized values stay intact either way.
 *
 * By default only URLs change: //host (http, https and protocol-relative) and
 * its JSON-escaped form, so email addresses and plain text keep the production
 * host. With bare, every mention changes in one pass, emails included.
 */
export async function replaceDomains(
  wp: WpRunner,
  pairs: Array<{ from: string; to: string }>,
  options: PassScope & { multisite: boolean; prefix: string; bare?: boolean; domainMapping?: boolean },
): Promise<ExecResult[]> {
  // The most specific host first: "//shop.com" also matches the start of "//shop.com.br", so that one must already be gone.
  const ordered = [...pairs].sort((a, b) => b.from.length - a.from.length);
  const passes: AddressPass[] = ordered.flatMap(({ from, to }) =>
    options.bare ? [[from, to] as const] : [[`//${from}`, `//${to}`] as const, [`\\/\\/${from}`, `\\/\\/${to}`] as const],
  );
  const results = await runPasses(wp, passes, { flag: options.tables, tableHosts: options.tableHosts, job: options.job });
  if (results.some((r) => r.code !== 0) || !options.multisite || options.bare) return results;
  return [...results, ...(await networkHosts(wp, ordered, options))];
}

/** The network's own tables hold bare host names: only a whole value matches, so deals.shop.com never becomes deals.local.shop.com. */
async function networkHosts(wp: WpRunner, hosts: ReadonlyArray<{ from: string; to: string }>, options: { prefix: string; domainMapping?: boolean | undefined }): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  const tables = [`${options.prefix}blogs`, `${options.prefix}site`, ...(options.domainMapping ? [`${options.prefix}domain_mapping`] : [])];
  for (const { from, to } of hosts.filter((h) => h.from !== h.to)) {
    const r = await wp(['search-replace', `^${from.replaceAll('.', '\\.')}$`, to, ...tables, '--regex', '--regex-flags=i']);
    results.push(r);
    if (r.code !== 0) return results;
  }
  return results;
}

/**
 * Every address of an imported dump to where it answers here, in the passes
 * addressPasses lists (one per address, http made https in the same pass),
 * then a network's own tables, which hold bare host names (only a whole value
 * matches, so deals.shop.com never becomes deals.local.shop.com), then each
 * moved site's home, siteurl and blogs row.
 */
export async function rewriteAddresses(
  wp: WpRunner,
  input: AddressInput,
  options: PassScope & { multisite: boolean; prefix: string; domainMapping?: boolean },
): Promise<ExecResult[]> {
  const results = await runPasses(wp, addressPasses(input), { flag: options.tables, tableHosts: options.tableHosts, job: options.job });
  if (results.some((r) => r.code !== 0)) return results;
  if (options.multisite) {
    results.push(...(await networkHosts(wp, input.hosts, options)));
    if (results.some((r) => r.code !== 0)) return results;
  }
  if (input.moves.length > 0) results.push(...(await placeSites(wp, options.prefix, input.moves)));
  return results;
}

/**
 * Local sites run on https: http://local becomes https://local for each local
 * name, whatever was replaced before. replaced: the hosts an earlier step
 * changed, whose tables may now have http://local links.
 */
export async function httpsForLocals(wp: WpRunner, locals: string[], scope: PassScope & { replaced?: ReadonlyArray<{ from: string; to: string }>; bare?: boolean }): Promise<ExecResult[]> {
  const passes: AddressPass[] = locals.flatMap((local) => [[`http://${local}`, `https://${local}`] as const, [`http:\\/\\/${local}`, `https:\\/\\/${local}`] as const]);
  // A bare replace is no address: with it, every table counts as changed.
  const earlier: AddressPass[] = (scope.replaced ?? []).map(({ from, to }) => (scope.bare ? [from, to] : [`//${from}`, `//${to}`]));
  return runPasses(wp, passes, { flag: scope.tables, tableHosts: scope.tableHosts, earlier, job: scope.job });
}

export const flush = (wp: WpRunner) => async () => [await wp(['cache', 'flush']), await wp(['rewrite', 'flush'])];

export const importOptions = (ctx: DbContext, job: JobRuntime): ImportOptions => ({ job, mysql: ctx.secrets?.mysql, memo: ctx.store });

/** A search-replace on a site with MySQL's limits raised, when its database is on this machine and the admin account can. */
export function raisedFor<T>(ctx: DbContext, site: SiteRef, job: JobRuntime, fn: () => Promise<T>): Promise<T> {
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  return withRaisedLimits(target, (line) => job.activity?.(line), fn);
}

export function wordpressSite(ctx: DbContext, domain: string, path?: string): { site: SiteRef; wp: WpRunner } {
  const site = siteFor(ctx.config, domain, path);
  if (!site.wp.dbName) throw new DbRefused(`${site.host} has no DB_NAME in wp-config.php`);
  return { site, wp: wpFor(ctx.exec, site.docroot, site.host) };
}

export function planSnapshot(ctx: DbContext, { domain, path, label }: ActionInput<'db.snapshot'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  return [{ id: 'snapshot', label: `Snapshot the database${label ? ` (${label})` : ''}`, run: () => takeSnapshot(ctx.config, wp, site.key, label) }];
}

export function planRestore(ctx: DbContext, { domain, path, snapshot }: ActionInput<'db.restore'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  const dir = snapshotDir(ctx.config, site.key);
  const file = join(dir, snapshot);
  if (!existsSync(file)) throw new DbRefused(`no snapshot called ${snapshot}`);
  return [
    { id: 'snapshot', label: 'Snapshot the current database first', run: () => takeSnapshot(ctx.config, wp, site.key, 'before-restore') },
    {
      id: 'restore',
      label: `Import ${snapshot}`,
      weight: 8,
      run: (job) => importSql(ctx.exec, site.docroot, site.host, file, importOptions(ctx, job)),
    },
    { id: 'flush', label: 'Flush caches and rewrite rules', run: flush(wp) },
  ];
}

export function planImport(ctx: DbContext, { domain, path, uploadId, replace, replaceBare }: ActionInput<'db.import'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  const upload = readUpload(ctx.uploadsDir, uploadId);
  if (!upload) throw new DbRefused('The uploaded dump is gone; upload it again');
  const prefix = site.wp.tablePrefix ?? 'wp_';
  if (upload.facts.tablePrefix && upload.facts.tablePrefix !== prefix) {
    throw new DbRefused(`The dump uses the table prefix ${upload.facts.tablePrefix} but wp-config.php uses ${prefix}; WordPress would not see the imported tables`);
  }
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  const db = site.wp.dbName;
  // Through a side database when the admin account can make one and the dump makes nothing RENAME TABLE cannot move.
  const swap = target && canSwap(db) && upload.facts.storedObjects === false ? { target, db, state: { db } as SwapState } : null;
  const steps: JobStep[] = swap
    ? [
        {
          id: 'import',
          label: `Import ${upload.name}`,
          weight: 8,
          run: async (job) => {
            const file = await sqlFileFor(ctx.exec, upload.file, upload.dir);
            const choice = await chooseMode(swap.target, swap.db, file);
            swap.state.mode = choice.mode;
            if (choice.mode === 'direct') {
              job.activity?.(`importing straight into ${swap.db}: ${choice.why}`);
              const before: ExecResult[] = [];
              if (choice.hasTables) {
                job.activity?.('taking a snapshot of the current database first');
                const snap = await takeSnapshot(ctx.config, wp, site.key, 'before-import');
                if (snap.code !== 0) return snap;
                before.push(snap);
              }
              return [...before, await importSql(ctx.exec, site.docroot, site.host, file, importOptions(ctx, job))];
            }
            job.activity?.(`importing into ${sideName(swap.db)}: the site keeps its database until the dump is in`);
            const made = await makeSide(swap.target, swap.db);
            if (made.code !== 0) return made;
            const r = await importSql(ctx.exec, site.docroot, site.host, file, { ...importOptions(ctx, job), database: sideName(swap.db) });
            // A dump that did not go in leaves the site as it was, and no side database.
            if (r.code !== 0) await dropSide(swap.target, swap.db);
            return r;
          },
        },
        {
          id: 'swap',
          label: 'Swap the imported tables in',
          weight: 0.2,
          run: async (job) => (swap.state.mode === 'side' ? swapIn(swap.target, swap.db, job) : ok(`imported straight into ${swap.db}: nothing to swap`)),
        },
      ]
    : [
        { id: 'snapshot', label: 'Snapshot the current database first', run: () => takeSnapshot(ctx.config, wp, site.key, 'before-import') },
        {
          id: 'import',
          label: `Import ${upload.name}`,
          weight: 8,
          run: async (job) => importSql(ctx.exec, site.docroot, site.host, await sqlFileFor(ctx.exec, upload.file, upload.dir), importOptions(ctx, job)),
        },
      ];
  if (replace.length > 0) {
    steps.push({
      id: 'replace',
      label: `Replace ${replace.length} production domain${replace.length > 1 ? 's' : ''}`,
      weight: 5,
      run: (job) =>
        raisedFor(ctx, site, job, () =>
          replaceDomains(wp, replace, {
            tables: '--all-tables-with-prefix', tableHosts: upload.facts.tableHosts, multisite: upload.facts.multisite || site.wp.multisite, prefix, bare: replaceBare, domainMapping: Boolean(upload.facts.domainMapping), job,
          }),
        ),
    });
  }
  const locals = site.names.filter(isLocalName);
  // Only when the dump has http links for a host the import keeps or replaces; a scan that did not read it all says nothing, so it runs.
  const http = upload.facts.httpHosts;
  if (http === undefined || [...replace.map((r) => r.from), ...locals].some((h) => http.includes(h))) {
    steps.push({
      id: 'https',
      label: 'Use https for the local domains',
      weight: 2,
      run: (job) => raisedFor(ctx, site, job, () => httpsForLocals(wp, locals, { tables: '--all-tables-with-prefix', tableHosts: upload.facts.tableHosts, replaced: replace, bare: replaceBare, job })),
    });
  }
  const left = replace.filter((r) => r.from !== r.to).map((r) => r.from);
  if (left.length > 0) {
    steps.push({
      id: 'check',
      label: 'Check no site is left on a production address',
      run: () => checkAddresses(wp, { prefix, multisite: upload.facts.multisite || site.wp.multisite, from: left }),
      skippable: CHECK_SKIPPED,
    });
  }
  steps.push({ id: 'flush', label: 'Flush caches and rewrite rules', run: flush(wp) });
  if (swap) {
    steps.push({
      id: 'cleanup',
      label: 'Remove the tables from before the import',
      weight: 0.2,
      run: async (job) => (swap.state.mode === 'side' ? dropPrevious(swap.target, swap.db, job) : ok('nothing to remove: the import went straight in')),
      skippable: `the tables from before the import stay in ${prevName(swap.db)}: drop that database yourself to free the disk`,
    });
  }
  return steps;
}

/** What skipping the address check leaves to you. */
export const CHECK_SKIPPED = 'a site may still use a production address: check Settings, General (and Network Admin, Sites on a network)';

export function planSearchReplace(ctx: DbContext, { domain, path, from, to, dryRun }: ActionInput<'db.searchReplace'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  // URLs are often stored with escaped slashes in JSON, so a value with a slash is replaced in both forms.
  const pairs: Array<[string, string]> = [[from, to]];
  if (from.includes('/')) pairs.push([from.replaceAll('/', '\\/'), to.replaceAll('/', '\\/')]);
  const run = (job?: JobRuntime) => runPasses(wp, pairs, { flag: '--all-tables-with-prefix', extra: dryRun ? ['--dry-run'] : [], job });
  if (dryRun) return [{ id: 'preview', label: `Count what replacing ${from} would change`, run: (job) => run(job) }];
  return [
    { id: 'snapshot', label: 'Snapshot the current database first', run: () => takeSnapshot(ctx.config, wp, site.key, 'before-replace') },
    { id: 'replace', label: `Replace ${from} with ${to}`, run: (job) => raisedFor(ctx, site, job, () => run(job)) },
    { id: 'flush', label: 'Flush caches and rewrite rules', run: flush(wp) },
  ];
}

export function deleteSnapshot(config: SystemConfig, { domain, path, snapshot }: ActionInput<'db.deleteSnapshot'>): ExecResult {
  const site = siteFor(config, domain, path);
  const file = join(snapshotDir(config, site.key), snapshot);
  if (!existsSync(file)) throw new DbRefused(`no snapshot called ${snapshot}`);
  rmSync(file);
  return ok(`deleted ${file}`);
}

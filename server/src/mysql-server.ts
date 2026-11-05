import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { ActionInput, MysqlBackup, MysqlDatabase, MysqlReport, MysqlSiteRef, MysqlUser } from '@devmagic-panel/shared';
import { isSystemDatabase, isSystemMysqlUser, mysqlAccount, mysqlBackupName } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import type { MysqlAccount } from './mysql-limits.js';
import { freshStatsSql } from './mysql-stats.js';
import { formatBytes, isLocalDbHost } from './sites/db.js';
import { mysqlPassword } from './sites/mysql-password.js';
import { siteFor, siteHost } from './sites/site-actions.js';
import { readSiteVhosts } from './sites/vhost.js';
import { setConstant } from './sites/wpconfig-edit.js';
import { parseWpConfig } from './sites/wpconfig.js';

/**
 * The MySQL server as a whole, for the Services page: every database and
 * account, what each is to the panel, and the few changes it makes there.
 * Everything goes through the MySQL admin account, never root. Nothing of
 * MySQL's own and nothing a site uses is ever changed here: a site's database
 * goes with the site. What is deleted is saved first to the panel's MySQL
 * backups, kept MYSQL_BACKUP_DAYS days, so Undo puts it back.
 */

export const MYSQL_BACKUP_DAYS = 14;

/** The MySQL backups folder, next to the panel's uploads in its data folder. */
export const mysqlBackupsDir = (uploadsDir: string) => join(dirname(uploadsDir), 'mysql-backups');

export class MysqlRefused extends Error {}

export interface MysqlContext {
  config: SystemConfig;
  exec: Executor;
  mysql: MysqlAccount | null | undefined;
  /** The databases the panel keeps a site's tables in, with the site's key (domain, or domain@path). */
  kept: () => Array<{ name: string; site: string }>;
  /** Where deleted databases and accounts are saved first. */
  backupsDir: string;
}

/** A site's database and user, as its wp-config.php says, for the sites on a database on this machine. */
export interface SiteDatabase extends MysqlSiteRef {
  db?: string;
  user?: string;
  dbHost?: string;
}

export function siteDatabases(config: SystemConfig): SiteDatabase[] {
  const out: SiteDatabase[] = [];
  for (const vhost of readSiteVhosts(config)) {
    const domain = vhost.names[0] as string;
    const folders: Array<{ path?: string; docroot: string | null }> = [{ docroot: vhost.docroot }, ...vhost.mounts.map((m) => ({ path: m.path, docroot: m.docroot }))];
    for (const { path, docroot } of folders) {
      const file = docroot ? join(docroot, 'wp-config.php') : '';
      if (!file || !existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const wp = parseWpConfig(text);
      if (!isLocalDbHost(wp.dbHost)) continue;
      out.push({ domain, ...(path ? { path } : {}), ...(wp.dbName ? { db: wp.dbName } : {}), ...(wp.dbUser ? { user: wp.dbUser } : {}), ...(wp.dbHost ? { dbHost: wp.dbHost } : {}) });
    }
  }
  return out;
}

const siteRef = (s: MysqlSiteRef): MysqlSiteRef => ({ domain: s.domain, ...(s.path ? { path: s.path } : {}) });
/** A kept database's site key (local.shop.com@learn) as a site. */
const keyToSite = (key: string): MysqlSiteRef => {
  const [domain, ...rest] = key.split('@');
  return { domain: domain as string, ...(rest.length ? { path: `/${rest.join('/')}` } : {}) };
};

const tick = (name: string) => `\`${name.replaceAll('`', '``')}\``;
const quoted = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const account = (a: { user: string; host: string }) => `${quoted(a.user)}@${quoted(a.host)}`;
const firstLine = (r: ExecResult) => r.stderr.trim().split('\n')[0] || 'MySQL refused';
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

function client(ctx: MysqlContext) {
  const mysql = ctx.mysql;
  if (!mysql) throw new MysqlRefused('The panel has no MySQL admin account: add one on the Environment page');
  const env = { MYSQL_PWD: mysql.password };
  const base = ['--user', mysql.user, '--host', mysql.host];
  return {
    exec: ctx.exec,
    mysql,
    /** One query, its rows split on tabs. */
    query: async (sql: string, timeoutMs = 30_000) => {
      const result = await ctx.exec('mysql', ['--batch', '--skip-column-names', ...base, '-e', sql], { env, timeoutMs });
      return { rows: result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')), result };
    },
    /** Statements on stdin, for the ones that change something. */
    run: (statements: string, timeoutMs = 60_000) => ctx.exec('mysql', ['--batch', '--skip-column-names', ...base], { env, input: statements, timeoutMs }),
    base,
    env,
  };
}

/** A grant's database pattern (mysql.db's Db) as a test: `_` and `%` are wildcards there unless escaped. */
function grantMatcher(pattern: string): (name: string) => boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '\\' && i + 1 < pattern.length) re += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const test = new RegExp(`^${re}$`);
  return (name) => test.test(name);
}

/** Every database and account on the server, with what each is to the panel. */
export async function mysqlReport(ctx: MysqlContext, now = Date.now): Promise<MysqlReport> {
  const checkedAt = new Date(now()).toISOString();
  const base = { checkedAt, backups: listMysqlBackups(ctx.backupsDir), backupsDir: ctx.backupsDir };
  if (!ctx.mysql) return { ...base, server: null, databases: [], users: [], error: 'The panel has no MySQL admin account: add one on the Environment page' };
  const { query, mysql } = client(ctx);
  const fresh = await freshStatsSql(ctx.exec, mysql);
  const [info, sizes, users, grants, globals] = await Promise.all([
    query('SELECT VERSION(), @@datadir'),
    query(
      `${fresh}SELECT s.SCHEMA_NAME, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0), COUNT(t.TABLE_NAME) FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME GROUP BY s.SCHEMA_NAME`,
      120_000,
    ),
    // MariaDB's roles are rows with no host.
    query("SELECT User, Host FROM mysql.user WHERE Host <> ''"),
    query('SELECT User, Host, Db FROM mysql.db'),
    query("SELECT DISTINCT GRANTEE FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE <> 'USAGE'"),
  ]);
  if (info.result.code !== 0) return { ...base, server: null, databases: [], users: [], error: `MySQL refused the admin account: ${firstLine(info.result)}` };
  if (sizes.result.code !== 0) return { ...base, server: null, databases: [], users: [], error: `cannot list the databases: ${firstLine(sizes.result)}` };

  const sites = siteDatabases(ctx.config);
  const kept = new Map(ctx.kept().map((k) => [k.name, k.site]));
  const databases: MysqlDatabase[] = sizes.rows
    .filter((r) => r[0])
    .map(([name, size, count]) => {
      const n = name as string;
      const using = sites.filter((s) => s.db === n).map(siteRef);
      const keptFor = kept.get(n);
      const kind: MysqlDatabase['kind'] = isSystemDatabase(n) ? 'system' : using.length ? 'site' : keptFor ? 'kept' : 'unused';
      const refs = kind === 'site' ? using : kind === 'kept' && keptFor ? [keyToSite(keptFor)] : [];
      return { name: n, sizeBytes: Number(size) || 0, tables: Number(count) || 0, kind, ...(refs.length ? { sites: refs } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = databases.map((d) => d.name);

  const [version = '', datadir] = info.rows[0] ?? [];
  const server: NonNullable<MysqlReport['server']> = {
    product: /mariadb/i.test(version) ? 'MariaDB' : 'MySQL',
    version,
    account: `${mysql.user}@${mysql.host}`,
    ...(datadir ? { datadir } : {}),
    totalBytes: databases.reduce((sum, d) => sum + d.sizeBytes, 0),
  };

  if (users.result.code !== 0) return { ...base, server, databases, users: [], usersError: `cannot list the accounts: ${firstLine(users.result)}` };
  const global = new Set(globals.rows.map(([grantee]) => grantee ?? ''));
  const list: MysqlUser[] = users.rows
    .filter((r) => r[0] !== undefined && r[1] !== undefined)
    .map(([user, host]) => {
      const u = user as string;
      const h = host as string;
      const patterns = grants.rows.filter(([gu, gh]) => gu === u && gh === h).map(([, , db]) => db ?? '');
      const databasesOf = names.filter((n) => !isSystemDatabase(n) && patterns.some((p) => grantMatcher(p)(n)));
      const missing = patterns.filter((p) => !names.some((n) => grantMatcher(p)(n))).map((p) => p.replace(/\\(.)/g, '$1'));
      const isGlobal = global.has(`'${u}'@'${h}'`);
      const using = sites.filter((s) => s.user === u).map(siteRef);
      const kind: MysqlUser['kind'] =
        isSystemMysqlUser(u) || u.startsWith('mysql.') ? 'system' : u === mysql.user ? 'panel' : using.length ? 'site' : !isGlobal && databasesOf.length === 0 ? 'leftover' : 'other';
      return { user: u, host: h, kind, databases: databasesOf, missing, global: isGlobal, ...(using.length ? { sites: using } : {}) };
    })
    .sort((a, b) => a.user.localeCompare(b.user) || a.host.localeCompare(b.host));
  return { ...base, server, databases, users: list };
}

/** The databases that exist, by name. */
async function existingDatabases(q: ReturnType<typeof client>): Promise<string[]> {
  const { rows, result } = await q.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA');
  if (result.code !== 0) throw new MysqlRefused(`cannot list the databases: ${firstLine(result)}`);
  return rows.map(([n]) => n ?? '').filter(Boolean);
}

/** A database named for a change: it exists and is not MySQL's own. */
async function changeable(q: ReturnType<typeof client>, database: string): Promise<void> {
  if (isSystemDatabase(database)) throw new MysqlRefused(`${database} is MySQL's own database; the panel leaves it alone`);
  if (!(await existingDatabases(q)).includes(database)) throw new MysqlRefused(`there is no database called ${database}`);
}

async function baseTables(q: ReturnType<typeof client>, database: string): Promise<string[]> {
  const { rows, result } = await q.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${quoted(database)} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
  if (result.code !== 0) throw new MysqlRefused(`cannot list the tables of ${database}: ${firstLine(result)}`);
  // A name batch output had to escape (a tab or a new line in it) is left out.
  return rows.map(([t]) => t ?? '').filter((t) => t && !t.includes('\\'));
}

/** What ANALYZE or OPTIMIZE TABLE answered that went wrong: its Msg_type is error. */
const tableErrors = (r: ExecResult) =>
  r.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols[2]?.toLowerCase() === 'error')
    .map((cols) => `${cols[0]}: ${cols[3] ?? ''}`);

/** ANALYZE TABLE on every table of one database, or of all but MySQL's own: statistics only, no data changes. */
export async function analyzeDatabases(ctx: MysqlContext, { database }: ActionInput<'mysql.analyze'>): Promise<ExecResult[]> {
  const q = client(ctx);
  if (database) await changeable(q, database);
  const list = database ? [database] : (await existingDatabases(q)).filter((n) => !isSystemDatabase(n));
  const results: ExecResult[] = [];
  for (const db of list) {
    const tables = await baseTables(q, db);
    if (tables.length === 0) {
      results.push(ok(`${db}: no tables`));
      continue;
    }
    const errors: string[] = [];
    for (let i = 0; i < tables.length; i += 100) {
      const r = await q.run(`ANALYZE TABLE ${tables.slice(i, i + 100).map((t) => `${tick(db)}.${tick(t)}`).join(', ')};\n`, 10 * 60_000);
      if (r.code !== 0) return [...results, { code: r.code, stdout: '', stderr: `${db}: ${firstLine(r)}` }];
      errors.push(...tableErrors(r));
    }
    results.push(errors.length ? { code: 1, stdout: '', stderr: `${db}: ${errors.join('; ')}` } : ok(`${db}: analyzed ${tables.length} tables`));
  }
  if (list.length === 0) results.push(ok('no databases to analyze'));
  return results;
}

async function databaseSize(q: ReturnType<typeof client>, database: string): Promise<number> {
  const fresh = await freshStatsSql(q.exec, q.mysql);
  const { rows } = await q.query(`${fresh}SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${quoted(database)}`);
  return Number(rows[0]?.[0]) || 0;
}

/**
 * OPTIMIZE TABLE on every table of a database, one at a time: InnoDB rebuilds
 * each, which gives the space of deleted rows back to the disk. Refused for
 * a site's database while a job works on that site.
 */
export async function planOptimize(ctx: MysqlContext, { database }: ActionInput<'mysql.optimize'>, siteBusy: (site: MysqlSiteRef) => boolean): Promise<JobStep[]> {
  const q = client(ctx);
  await changeable(q, database);
  const busy = siteDatabases(ctx.config).find((s) => s.db === database && siteBusy(s));
  if (busy) throw new MysqlRefused(`${siteHost(busy.domain, busy.path)} uses ${database} and is busy; wait until its job finishes`);
  const tables = await baseTables(q, database);
  return [
    {
      id: 'optimize',
      label: `Optimize ${tables.length} tables of ${database}`,
      run: async (job) => {
        const before = await databaseSize(q, database);
        const errors: string[] = [];
        for (const [i, table] of tables.entries()) {
          job.progress(i / Math.max(1, tables.length), `${i} of ${tables.length} tables: ${table}`);
          const r = await q.run(`OPTIMIZE TABLE ${tick(database)}.${tick(table)};\n`, 2 * 60 * 60_000);
          if (r.code !== 0) return { code: r.code, stdout: '', stderr: `${table}: ${firstLine(r)}` };
          errors.push(...tableErrors(r));
        }
        const after = await databaseSize(q, database);
        const summary = `optimized ${tables.length} tables of ${database}: ${formatBytes(before)} before, ${formatBytes(after)} now`;
        return errors.length ? { code: 1, stdout: summary, stderr: errors.join('\n') } : ok(summary);
      },
    },
  ];
}

const stampOf = (date = new Date()) => date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

function backupsDir(ctx: MysqlContext): string {
  mkdirSync(ctx.backupsDir, { recursive: true, mode: 0o700 });
  return ctx.backupsDir;
}

/** Deleted databases and accounts saved more than MYSQL_BACKUP_DAYS ago go; returns what went. */
export function pruneMysqlBackups(dir: string, now = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > MYSQL_BACKUP_DAYS * 86_400_000) {
        rmSync(file, { force: true });
        gone.push(name);
      }
    } catch {
      // Gone already.
    }
  }
  return gone;
}

/** The accounts a saved users file makes again, from its CREATE USER lines (MySQL quotes with backticks, MariaDB too, older ones with quotes). */
function savedAccounts(file: string): string[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return [...text.matchAll(/^CREATE USER (?:IF NOT EXISTS )?[`']([^`']+)[`']@[`']([^`']*)[`']/gm)].map((m) => `${m[1]}@${m[2]}`);
}

/** What deleted databases and users left in the MySQL backups, newest first. */
export function listMysqlBackups(dir: string): MysqlBackup[] {
  if (!existsSync(dir)) return [];
  const out: MysqlBackup[] = [];
  for (const name of readdirSync(dir)) {
    // A .part of an export still being written, and anything else, is not listed.
    if (!mysqlBackupName.safeParse(name).success) continue;
    let size: number;
    let saved: number;
    try {
      const st = statSync(join(dir, name));
      size = st.size;
      saved = st.mtimeMs;
    } catch {
      continue;
    }
    const users = name.startsWith('users-') && name.endsWith('.sql');
    out.push({
      name,
      kind: users ? 'users' : 'database',
      subject: users ? savedAccounts(join(dir, name)).join(', ') || 'accounts' : name.replace(/-\d{8}-\d{6}\.sql\.gz$/, ''),
      sizeBytes: size,
      savedAt: new Date(saved).toISOString(),
      purgeAt: new Date(saved + MYSQL_BACKUP_DAYS * 86_400_000).toISOString(),
    });
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Deletes one file of the MySQL backups now; the name is checked by the registry and again here. */
export function deleteMysqlBackup(dir: string, { name }: ActionInput<'mysql.deleteBackup'>): ExecResult {
  if (!mysqlBackupName.safeParse(name).success) throw new MysqlRefused(`${name} is not a file of the MySQL backups`);
  const file = join(dir, name);
  if (!existsSync(file)) throw new MysqlRefused(`${name} is not in the MySQL backups`);
  rmSync(file);
  return ok(`deleted ${file}`);
}

/**
 * Deletes a database no site uses: exported first (with its routines,
 * events and the CREATE DATABASE line, so it comes back as it was), then
 * dropped. Undo imports the export, unless a database of that name is there
 * again.
 */
export async function planDropDatabase(ctx: MysqlContext, { database }: ActionInput<'mysql.dropDatabase'>): Promise<JobStep[]> {
  const q = client(ctx);
  await changeable(q, database);
  const using = siteDatabases(ctx.config).filter((s) => s.db === database);
  if (using.length) throw new MysqlRefused(`${using.map((s) => siteHost(s.domain, s.path)).join(', ')} uses ${database}: remove the site instead`);
  const kept = ctx.kept().find((k) => k.name === database);
  if (kept) throw new MysqlRefused(`${database} holds tables the panel keeps for ${kept.site.replaceAll('@', '/')}: delete it on that site's Database tab`);
  const file = join(ctx.backupsDir, `${database}-${stampOf()}.sql.gz`);
  return [
    {
      id: 'export',
      label: `Export ${database} to the MySQL backups`,
      weight: 4,
      run: async (job) => {
        backupsDir(ctx);
        const part = `${file}.part`;
        const out = new PassThrough();
        let bytes = 0;
        out.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          job.progress(0, `${formatBytes(bytes)} of SQL`);
        });
        const written = pipeline(out, createGzip({ level: 6 }), createWriteStream(part, { mode: 0o600 }));
        const r = await ctx.exec(
          'mysqldump',
          [...q.base, '--single-transaction', '--quick', '--no-tablespaces', '--routines', '--events', '--max-allowed-packet=1G', '--databases', database],
          { env: q.env, stdoutTo: out, timeoutMs: 6 * 60 * 60_000 },
        );
        if (r.code !== 0) out.destroy();
        const wrote = await written.then(
          () => null,
          (error: Error) => error,
        );
        if (r.code !== 0 || wrote) {
          rmSync(part, { force: true });
          return r.code !== 0 ? r : { code: 1, stdout: '', stderr: `could not write ${file}: ${wrote?.message}` };
        }
        renameSync(part, file);
        return ok(`saved ${file} (${formatBytes(statSync(file).size)} gzipped), kept ${MYSQL_BACKUP_DAYS} days`);
      },
    },
    {
      id: 'drop',
      label: `Delete database ${database}`,
      run: async (job) => {
        const r = await q.run(`DROP DATABASE ${tick(database)};\n`);
        if (r.code !== 0) return r;
        job.onUndo(`Put ${database} back from its export`, async () => {
          if ((await existingDatabases(q)).includes(database)) return { code: 1, stdout: '', stderr: `a database called ${database} is there again; ${file} is kept` };
          if (!existsSync(file)) return { code: 1, stdout: '', stderr: `${file} is gone` };
          const back = await ctx.exec('mysql', q.base, { env: q.env, inputStream: createReadStream(file).pipe(createGunzip()), timeoutMs: 6 * 60 * 60_000 });
          return back.code === 0 ? ok(`put ${database} back from ${file}`) : back;
        });
        return ok(`deleted ${database}`);
      },
    },
  ];
}

/**
 * Deletes accounts no site uses. Each one's CREATE USER (its password hash
 * included, in hex on MySQL) and GRANT statements are saved first to a 0600
 * file in the MySQL backups; Undo runs them again.
 */
export async function planDropUsers(ctx: MysqlContext, { accounts }: ActionInput<'mysql.dropUsers'>): Promise<JobStep[]> {
  const q = client(ctx);
  const list = accounts.filter((a, i) => accounts.findIndex((b) => b.user === a.user && b.host === a.host) === i);
  const { rows, result } = await q.query("SELECT User, Host FROM mysql.user WHERE Host <> ''");
  if (result.code !== 0) throw new MysqlRefused(`cannot list the accounts: ${firstLine(result)}`);
  const sites = siteDatabases(ctx.config);
  for (const a of list) {
    const name = `${a.user}@${a.host}`;
    if (!mysqlAccount.safeParse(a).success) throw new MysqlRefused(`${name} is not a name the panel can use`);
    if (isSystemMysqlUser(a.user) || a.user.startsWith('mysql.')) throw new MysqlRefused(`${name} is MySQL's own account; the panel leaves it alone`);
    if (a.user === q.mysql.user) throw new MysqlRefused(`${name} is the account the panel signs in with`);
    const using = sites.filter((s) => s.user === a.user);
    if (using.length) throw new MysqlRefused(`${using.map((s) => siteHost(s.domain, s.path)).join(', ')} uses ${a.user}`);
    if (!rows.some(([u, h]) => u === a.user && h === a.host)) throw new MysqlRefused(`there is no account ${name}`);
  }
  const names = list.map((a) => `${a.user}@${a.host}`).join(', ');
  const file = join(ctx.backupsDir, `users-${stampOf()}.sql`);
  return [
    {
      id: 'save',
      label: `Save ${list.length === 1 ? names : `${list.length} accounts`} and their rights`,
      run: async () => {
        // MySQL prints a password hash as hex when asked, so it reads back whole; MariaDB's are text already.
        const hex = await q.query("SHOW VARIABLES LIKE 'print_identified_with_as_hex'");
        const prefix = hex.result.code === 0 && hex.rows.length ? 'SET SESSION print_identified_with_as_hex = ON; ' : '';
        const statements: string[] = [];
        for (const a of list) {
          const r = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--raw', ...q.base, '-e', `${prefix}SHOW CREATE USER ${account(a)}; SHOW GRANTS FOR ${account(a)}`], { env: q.env });
          if (r.code !== 0) return { code: r.code, stdout: '', stderr: `${a.user}@${a.host}: ${firstLine(r)}` };
          const [create, ...grants] = r.stdout.split('\n').filter(Boolean);
          if (!create?.startsWith('CREATE USER ')) return { code: 1, stdout: '', stderr: `${a.user}@${a.host}: MySQL did not show how the account is made` };
          statements.push(`${create.replace(/^CREATE USER /, 'CREATE USER IF NOT EXISTS ')};`, ...grants.map((g) => `${g};`));
        }
        backupsDir(ctx);
        writeFileSync(file, `${statements.join('\n')}\n`, { mode: 0o600 });
        return ok(`saved to ${file}, kept ${MYSQL_BACKUP_DAYS} days`);
      },
    },
    {
      id: 'drop',
      label: `Delete ${names}`,
      run: async (job) => {
        const r = await q.run(`DROP USER ${list.map(account).join(', ')};\n`);
        if (r.code !== 0) return r;
        job.onUndo(`Make ${list.length === 1 ? names : `${list.length} accounts`} again`, async () => {
          if (!existsSync(file)) return { code: 1, stdout: '', stderr: `${file} is gone` };
          const back = await q.run(readFileSync(file, 'utf8'));
          return back.code === 0 ? ok(`made ${names} again from ${file}`) : back;
        });
        return ok(`deleted ${names}`);
      },
    },
  ];
}

/**
 * A new password for the database user in a site's wp-config.php, written
 * there first; the user, and its access to the site's database, are made
 * when they are missing. Only a user this site alone uses.
 */
export async function resetSiteUser(ctx: MysqlContext, { domain, path }: ActionInput<'mysql.resetSiteUser'>): Promise<ExecResult[]> {
  const site = siteFor(ctx.config, domain, path);
  const { dbName, dbUser, dbHost } = site.wp;
  if (!isLocalDbHost(dbHost)) throw new MysqlRefused(`${site.host} uses a database on ${dbHost}, not on this machine`);
  if (!dbName || !dbUser) throw new MysqlRefused(`${site.host} has no DB_NAME or DB_USER in wp-config.php`);
  const q = client(ctx);
  if (!mysqlAccount.shape.user.safeParse(dbUser).success) throw new MysqlRefused(`${dbUser} is not a user name the panel can use`);
  if (isSystemMysqlUser(dbUser) || dbUser.startsWith('mysql.')) throw new MysqlRefused(`${site.host} signs in as ${dbUser}, MySQL's own account; the panel leaves it alone`);
  if (dbUser === q.mysql.user) throw new MysqlRefused(`${site.host} signs in with the panel's own account, ${dbUser}`);
  const others = siteDatabases(ctx.config).filter((s) => s.user === dbUser && !(s.domain === domain && s.path === path));
  if (others.length) throw new MysqlRefused(`${dbUser} is shared with ${others.map((s) => siteHost(s.domain, s.path)).join(', ')}; a new password would sign them out`);

  const { rows, result } = await q.query(`SELECT Host FROM mysql.user WHERE User = ${quoted(dbUser)}`);
  if (result.code !== 0) throw new MysqlRefused(`cannot read the accounts: ${firstLine(result)}`);
  const found = rows.map(([h]) => h ?? '').filter(Boolean);
  const hosts = found.length ? found : [dbHost?.trim().startsWith('127.0.0.1') ? '127.0.0.1' : 'localhost'];

  const password = mysqlPassword();
  const configFile = join(site.docroot, 'wp-config.php');
  const before = readFileSync(configFile, 'utf8');
  try {
    writeFileSync(configFile, setConstant(before, 'DB_PASSWORD', password));
  } catch (error) {
    throw new MysqlRefused(`cannot write ${configFile}: ${(error as Error).message}`);
  }
  const statements = hosts.flatMap((host) => {
    const a = account({ user: dbUser, host });
    return [`CREATE USER IF NOT EXISTS ${a} IDENTIFIED BY '${password}';`, `ALTER USER ${a} IDENTIFIED BY '${password}';`, `GRANT ALL PRIVILEGES ON ${tick(dbName)}.* TO ${a};`];
  });
  const r = await q.run(`${statements.join('\n')}\n`);
  if (r.code !== 0) {
    // MySQL kept the old password, so wp-config.php gets it back.
    writeFileSync(configFile, before);
    return [r];
  }
  const names = hosts.map((h) => `${dbUser}@${h}`).join(' and ');
  return [ok(`${names} ${found.length ? 'has a new password' : `made, with access to ${dbName}`}; the password is in ${configFile}`)];
}

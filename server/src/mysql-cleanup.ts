import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput, CleanupInfo } from '@devmagic-panel/shared';
import { cleanupId, isSystemDatabase } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult } from './exec.js';
import type { JobStep } from './jobs.js';
import type { MysqlAccount } from './mysql-limits.js';
import { type BrowseContext, tableMeta } from './mysql-browse.js';
import { type RowsContext, updateRow } from './mysql-rows.js';
import { MysqlRefused, siteDatabases } from './mysql-server.js';
import { ident, textLiteral } from './mysql-sql.js';
import { type WordpressTables, wordpressTables } from './mysql-wordpress.js';
import { formatBytes } from './sites/db.js';
import { dumpStream } from './sites/sql-stream.js';

/**
 * Clean-ups that remove many rows at once (transients, revisions, spam,
 * orphaned meta) and emptying or deleting a table. Each is a job: first it
 * saves exactly what it will remove with mysqldump --where, as INSERT IGNORE
 * (the whole table, CREATE TABLE included, for a delete), gzipped to
 * BACKUP_DIR/cleanups/<id> (0700, files 0600, 14 days), streamed so a big
 * one never sits in memory; then it removes it in one transaction, only the
 * rows that were there when the copy was taken. Undo imports the copy back;
 * a row made again since stays as it is.
 *
 * Every condition here is built from constants and table names the database
 * listed, in backticks: nothing a person typed reaches the SQL.
 */
export const CLEANUP_DAYS = 14;

export interface CleanupPart {
  table: string;
  /** Which rows; none for a whole table. */
  where?: string;
  how: 'delete' | 'empty' | 'drop';
  /** A one-column numeric key: the delete stops at the highest one the copy saw. */
  key?: string;
}

interface SavedPart {
  table: string;
  how: CleanupPart['how'];
  rows: number;
  file: string;
}

interface SavedCleanup {
  title: string;
  kind: CleanupInfo['kind'];
  database: string;
  /** The site key it was for, local.shop.com or local.shop.com/learn. */
  site?: string;
  parts: SavedPart[];
  savedAt: string;
}

export const cleanupsDir = (config: SystemConfig) => join(config.BACKUP_DIR, 'cleanups');

function account(ctx: RowsContext): MysqlAccount {
  if (!ctx.mysql) throw new MysqlRefused('The panel has no MySQL admin account: add one on the Environment page');
  return ctx.mysql;
}

const base = (mysql: MysqlAccount) => ['--user', mysql.user, '--host', mysql.host];
const firstError = (r: ExecResult) => (r.stderr.trim().split('\n').find((l) => l.startsWith('ERROR')) ?? r.stderr.trim().split('\n')[0] ?? `exit ${r.code}`).replace(/ at line \d+/, '');

/** Statements on stdin with the admin account in the database, as SQL only; the lines they printed. */
async function sql(ctx: RowsContext, database: string, statements: string, timeoutMs = 60 * 60_000): Promise<string[]> {
  const mysql = account(ctx);
  const r = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--binary-mode', '--default-character-set=utf8mb4', ...base(mysql), `--database=${database}`], {
    env: { MYSQL_PWD: mysql.password },
    input: `SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';\n${statements}`,
    timeoutMs,
  });
  if (r.code !== 0) throw new MysqlRefused(`MySQL refused it: ${firstError(r)}`);
  return r.stdout.split('\n').filter((l) => l !== '');
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

export function pruneCleanups(dir: string, now = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > CLEANUP_DAYS * 86_400_000) {
        rmSync(path, { recursive: true, force: true });
        gone.push(name);
      }
    } catch {
      // Gone already.
    }
  }
  return gone;
}

function readCleanup(config: SystemConfig, id: string): SavedCleanup {
  if (!cleanupId.safeParse(id).success) throw new MysqlRefused('A clean-up like 20261107-101500-a1b2c3');
  const file = join(cleanupsDir(config), id, 'cleanup.json');
  if (!existsSync(file)) throw new MysqlRefused('That clean-up is not saved any more: copies go after 14 days, and after their Undo');
  return JSON.parse(readFileSync(file, 'utf8')) as SavedCleanup;
}

/** The clean-ups saved for a database (or one site of it), newest first, without their rows. */
export function listCleanups(config: SystemConfig, database: string, site?: string): CleanupInfo[] {
  const dir = cleanupsDir(config);
  if (!existsSync(dir)) return [];
  const out: CleanupInfo[] = [];
  for (const id of readdirSync(dir).sort().reverse()) {
    try {
      const c = JSON.parse(readFileSync(join(dir, id, 'cleanup.json'), 'utf8')) as SavedCleanup;
      if (c.database !== database || (site !== undefined && c.site !== site)) continue;
      const bytes = c.parts.reduce((n, p) => n + (existsSync(join(dir, id, p.file)) ? statSync(join(dir, id, p.file)).size : 0), 0);
      out.push({
        id,
        title: c.title,
        kind: c.kind,
        // A table cleaned in two parts (spam comments, and comments of trashed posts) shows once.
        tables: [...c.parts.reduce((m, p) => m.set(p.table, (m.get(p.table) ?? 0) + p.rows), new Map<string, number>())].map(([table, rows]) => ({ table, rows })),
        bytes,
        savedAt: c.savedAt,
        purgeAt: new Date(Date.parse(c.savedAt) + CLEANUP_DAYS * 86_400_000).toISOString(),
      });
    } catch {
      // Half written or unreadable: left for the prune.
    }
  }
  return out;
}

/** Streams one table's rows (or all of it) into a gzipped file, 0600. */
async function dumpPart(ctx: RowsContext, database: string, part: CleanupPart, where: string | undefined, file: string, note: (bytes: number) => void): Promise<void> {
  const mysql = account(ctx);
  const out = new PassThrough();
  let bytes = 0;
  out.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    note(bytes);
  });
  const tmp = `${file}.part`;
  const written = pipeline(out, createGzip({ level: 1 }), createWriteStream(tmp, { mode: 0o600 }));
  const r = await ctx.exec(
    'mysqldump',
    [
      ...base(mysql),
      '--single-transaction', '--quick', '--skip-lock-tables', '--no-tablespaces', '--skip-triggers', '--hex-blob', '--default-character-set=utf8mb4', '--max-allowed-packet=1G', '--insert-ignore',
      // A deleted table keeps its CREATE TABLE, and never a DROP: Undo must not replace a table made again since.
      ...(part.how === 'drop' ? ['--skip-add-drop-table'] : ['--no-create-info']),
      ...(where ? [`--where=${where}`] : []),
      '--', database, part.table,
    ],
    { env: { MYSQL_PWD: mysql.password }, stdoutTo: out, timeoutMs: 6 * 60 * 60_000 },
  );
  if (r.code !== 0) out.destroy();
  const failed = await written.then(() => null, (error: Error) => error);
  if (r.code !== 0 || failed) {
    rmSync(tmp, { force: true });
    throw new MysqlRefused(r.code !== 0 ? `mysqldump could not save ${part.table}: ${firstError(r)}` : `could not write ${file}: ${failed?.message}`);
  }
  renameSync(tmp, file);
}

/** Puts a saved clean-up back, the last part removed first, then lets the copy go. */
export async function undoCleanup(ctx: RowsContext, { database, cleanup }: ActionInput<'mysql.undoCleanup'>): Promise<ExecResult> {
  const saved = readCleanup(ctx.config, cleanup);
  if (saved.database !== database) throw new MysqlRefused(`That clean-up was of ${saved.database}`);
  const dir = join(cleanupsDir(ctx.config), cleanup);
  const mysql = account(ctx);
  for (const part of [...saved.parts].reverse()) {
    if (part.how === 'drop') {
      const there = await sql(ctx, database, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${textLiteral(part.table)};\n`);
      if (there[0] !== '0') throw new MysqlRefused(`A table called ${part.table} is there again: delete or rename it first. The copy stays`);
    }
    const file = join(dir, part.file);
    if (!existsSync(file)) throw new MysqlRefused(`${part.file} of that clean-up is gone`);
    const wrap = { before: "SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\n", after: '\nCOMMIT;\n' };
    const r = await ctx.exec('mysql', ['--binary-mode', '--default-character-set=utf8mb4', '--max-allowed-packet=1G', ...base(mysql), `--database=${database}`], {
      env: { MYSQL_PWD: mysql.password },
      inputStream: dumpStream(file, wrap),
      timeoutMs: 6 * 60 * 60_000,
      inputStallMs: 15 * 60_000,
    });
    if (r.code !== 0) throw new MysqlRefused(`MySQL refused to put ${part.table} back: ${firstError(r)}`);
  }
  rmSync(dir, { recursive: true, force: true });
  const rows = saved.parts.reduce((n, p) => n + p.rows, 0);
  const what = saved.parts.length === 1 && saved.parts[0]?.how === 'drop' ? `table ${saved.parts[0].table}` : `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;
  return { code: 0, stdout: `undid "${saved.title}": put back ${what}`, stderr: '' };
}

/**
 * The job of a clean-up: save, then remove. Parts are removed in their order
 * (meta before the posts it belongs to) and put back in the other.
 */
export function planCleanup(ctx: RowsContext, database: string, kind: CleanupInfo['kind'], title: string, parts: CleanupPart[], site?: string): JobStep[] {
  let id = '';
  let todo: Array<CleanupPart & { bounded?: string; rows: number; file: string }> = [];
  return [
    {
      id: 'save',
      label: 'Save what it removes, for Undo',
      weight: 3,
      run: async (job) => {
        const now = ctx.now?.() ?? new Date();
        id = `${stamp(now)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
        // Count first, with the highest key seen, so the delete removes exactly what the copy holds.
        const counts = await sql(
          ctx,
          database,
          parts
            .map((p) => {
              const where = p.where ? `WHERE ${p.where}` : '';
              return `SELECT ${p.key ? `COALESCE(MAX(${ident(p.key)}), 0)` : '0'}, COUNT(*) FROM ${ident(p.table)} ${where};\n`;
            })
            .join(''),
        );
        todo = parts
          .map((p, i) => {
            const [max = '0', rows = '0'] = (counts[i] ?? '').split('\t');
            const bounded = p.where && p.key ? `(${p.where}) AND ${ident(p.key)} <= ${Number(max)}` : p.where;
            return { ...p, ...(bounded ? { bounded } : {}), rows: Number(rows), file: `${String(i + 1).padStart(2, '0')}-${p.table}.sql.gz` };
          })
          .filter((p) => p.how !== 'delete' || p.rows > 0);
        if (todo.length === 0) return { code: 0, stdout: 'nothing to remove', stderr: '' };
        const root = cleanupsDir(ctx.config);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        pruneCleanups(root, now.getTime());
        const dir = join(root, id);
        mkdirSync(dir, { mode: 0o700 });
        for (const [i, p] of todo.entries()) {
          await dumpPart(ctx, database, p, p.bounded, join(dir, p.file), (bytes) => job.progress(i / todo.length, `${p.table}: ${formatBytes(bytes)} of SQL`));
        }
        const saved: SavedCleanup = { title, kind, database, ...(site ? { site } : {}), parts: todo.map(({ table, how, rows, file }) => ({ table, how, rows, file })), savedAt: now.toISOString() };
        writeFileSync(join(dir, 'cleanup.json'), JSON.stringify(saved), { mode: 0o600 });
        const size = todo.reduce((n, p) => n + statSync(join(dir, p.file)).size, 0);
        return { code: 0, stdout: `saved ${todo.map((p) => `${p.table} (${p.how === 'delete' ? `${p.rows.toLocaleString('en-US')} rows` : 'all of it'})`).join(', ')}: ${formatBytes(size)} gzipped, kept ${CLEANUP_DAYS} days`, stderr: '' };
      },
    },
    {
      id: 'remove',
      label: title,
      weight: 2,
      run: async (job) => {
        if (todo.length === 0) return { code: 0, stdout: 'nothing to remove', stderr: '' };
        const deletes = todo.filter((p) => p.how === 'delete');
        const lines = deletes.length
          ? await sql(ctx, database, `START TRANSACTION;\n${deletes.map((p) => `DELETE FROM ${ident(p.table)} WHERE ${p.bounded};\nSELECT ROW_COUNT();\n`).join('')}COMMIT;\n`)
          : [];
        const whole = todo.filter((p) => p.how !== 'delete');
        if (whole.length) await sql(ctx, database, whole.map((p) => `${p.how === 'drop' ? 'DROP TABLE' : 'TRUNCATE TABLE'} ${ident(p.table)};\n`).join(''));
        job.onUndo(`Put back what ${title.toLowerCase()} removed`, () => undoCleanup(ctx, { database, cleanup: id }));
        const said = [
          ...deletes.map((p, i) => `${p.table}: ${Number(lines[i] ?? 0).toLocaleString('en-US')} rows`),
          ...whole.map((p) => `${p.table}: ${p.how === 'drop' ? 'deleted' : 'emptied'}`),
        ];
        return { code: 0, stdout: `${said.join(', ')}. Undo puts ${whole.length && !deletes.length ? 'it' : 'them'} back for ${CLEANUP_DAYS} days`, stderr: '' };
      },
    },
  ];
}

// ── WordPress clean-ups ──────────────────────────────────────

const browse = (ctx: RowsContext): BrowseContext => ({ config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept });

/** The tables of the site picked, or a refusal that says which one is missing. */
async function siteTablesFor(ctx: RowsContext, domain: string, path: string | undefined, blog: number): Promise<WordpressTables> {
  try {
    return await wordpressTables(browse(ctx), domain, path, blog);
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
}

/** The key column WordPress gives each of its tables. */
const KEYS = { options: 'option_id', posts: 'ID', postmeta: 'meta_id', comments: 'comment_ID', commentmeta: 'meta_id', termmeta: 'meta_id', usermeta: 'umeta_id', sitemeta: 'meta_id' } as const;

const like = (column: string, pattern: string) => `${column} LIKE '${pattern}'`;

/** Transient rows by their prefix (_transient_ or _site_transient_), in a table of name and value columns. */
function transientWhere(scope: 'expired' | 'all', table: string, name: string, value: string, kind: 'transient' | 'site\\_transient'): string {
  const any = like(name, `\\_${kind}\\_%`);
  if (scope === 'all') return any;
  const timeout = `${like(name, `\\_${kind}\\_timeout\\_%`)} AND CAST(${value} AS UNSIGNED) < UNIX_TIMESTAMP()`;
  // A value row goes with its expired timeout row: _transient_x and _transient_timeout_x. The derived table lets MySQL read the table it deletes from.
  const start = kind === 'transient' ? 12 : 17;
  const prefix = kind === 'transient' ? '_transient_timeout_' : '_site_transient_timeout_';
  return `(${timeout}) OR (${any} AND NOT ${like(name, `\\_${kind}\\_timeout\\_%`)} AND CONCAT('${prefix}', SUBSTRING(${name}, ${start})) IN (SELECT n FROM (SELECT ${name} AS n FROM ${ident(table)} WHERE ${timeout}) AS expired))`;
}

export async function planTransients(ctx: RowsContext, { domain, path, blog = 1, scope }: ActionInput<'db.cleanTransients'>): Promise<JobStep[]> {
  const t = await siteTablesFor(ctx, domain, path, blog);
  const options = `${t.blogPrefix}options`;
  if (!t.names.has(options)) throw new MysqlRefused(`${options} is not in ${t.database}`);
  const parts: CleanupPart[] = [{ table: options, how: 'delete', key: KEYS.options, where: `(${transientWhere(scope, options, 'option_name', 'option_value', 'transient')}) OR (${transientWhere(scope, options, 'option_name', 'option_value', 'site\\_transient')})` }];
  // A network keeps its own transients in sitemeta: they go with the first site's.
  const sitemeta = `${t.prefix}sitemeta`;
  if (t.network && blog === 1 && t.names.has(sitemeta)) parts.push({ table: sitemeta, how: 'delete', key: KEYS.sitemeta, where: transientWhere(scope, sitemeta, 'meta_key', 'meta_value', 'site\\_transient') });
  const title = scope === 'expired' ? 'Delete expired transients' : 'Delete every transient';
  return planCleanup(ctx, t.database, 'transients', title, parts, `${domain}${path ?? ''}`);
}

export async function planContent(ctx: RowsContext, { domain, path, blog = 1, kinds }: ActionInput<'db.cleanContent'>): Promise<JobStep[]> {
  const t = await siteTablesFor(ctx, domain, path, blog);
  const name = (n: string) => `${t.blogPrefix}${n}`;
  const has = (n: string) => t.names.has(name(n));
  const posts = ident(name('posts'));
  const comments = ident(name('comments'));
  const postWhen = [kinds.includes('revisions') && "post_type = 'revision'", kinds.includes('autoDrafts') && "post_status = 'auto-draft'", kinds.includes('trashedPosts') && "post_status = 'trash'"].filter(Boolean).join(' OR ');
  const commentWhen = [kinds.includes('spamComments') && "comment_approved = 'spam'", kinds.includes('trashedComments') && "comment_approved = 'trash'"].filter(Boolean).join(' OR ');
  const parts: CleanupPart[] = [];
  if (postWhen && has('posts')) {
    const inPosts = `(SELECT ID FROM ${posts} WHERE ${postWhen})`;
    // What WordPress deletes with a post: its comments and their meta, its meta, its terms (never a link's).
    if (has('comments') && has('commentmeta')) parts.push({ table: name('commentmeta'), how: 'delete', key: KEYS.commentmeta, where: `comment_id IN (SELECT comment_ID FROM ${comments} WHERE comment_post_ID IN ${inPosts})` });
    if (has('comments')) parts.push({ table: name('comments'), how: 'delete', key: KEYS.comments, where: `comment_post_ID IN ${inPosts}` });
    if (has('postmeta')) parts.push({ table: name('postmeta'), how: 'delete', key: KEYS.postmeta, where: `post_id IN ${inPosts}` });
    if (has('term_relationships') && has('term_taxonomy')) {
      parts.push({ table: name('term_relationships'), how: 'delete', where: `object_id IN ${inPosts} AND term_taxonomy_id NOT IN (SELECT term_taxonomy_id FROM ${ident(name('term_taxonomy'))} WHERE taxonomy = 'link_category')` });
    }
    parts.push({ table: name('posts'), how: 'delete', key: KEYS.posts, where: postWhen });
  }
  if (commentWhen && has('comments')) {
    if (has('commentmeta')) parts.push({ table: name('commentmeta'), how: 'delete', key: KEYS.commentmeta, where: `comment_id IN (SELECT comment_ID FROM ${comments} WHERE ${commentWhen})` });
    parts.push({ table: name('comments'), how: 'delete', key: KEYS.comments, where: commentWhen });
  }
  if (!parts.length) throw new MysqlRefused('This site has none of those tables');
  return planCleanup(ctx, t.database, 'content', 'Delete revisions, drafts, trash and spam', parts, `${domain}${path ?? ''}`);
}

export async function planOrphans(ctx: RowsContext, { domain, path, blog = 1, kinds }: ActionInput<'db.cleanOrphans'>): Promise<JobStep[]> {
  const t = await siteTablesFor(ctx, domain, path, blog);
  const name = (n: string, shared = false) => `${shared ? t.prefix : t.blogPrefix}${n}`;
  const has = (n: string, shared = false) => t.names.has(name(n, shared));
  const orphan = (meta: 'postmeta' | 'commentmeta' | 'termmeta' | 'usermeta', parent: string, column: string, parentKey: string, shared = false): CleanupPart | null =>
    has(meta, shared) && has(parent, shared)
      ? { table: name(meta, shared), how: 'delete', key: KEYS[meta], where: `NOT EXISTS (SELECT 1 FROM ${ident(name(parent, shared))} p WHERE p.${parentKey} = ${ident(name(meta, shared))}.${column})` }
      : null;
  const parts: CleanupPart[] = [];
  const add = (p: CleanupPart | null) => p && parts.push(p);
  if (kinds.includes('postmeta')) add(orphan('postmeta', 'posts', 'post_id', 'ID'));
  if (kinds.includes('commentmeta')) add(orphan('commentmeta', 'comments', 'comment_id', 'comment_ID'));
  if (kinds.includes('termmeta')) add(orphan('termmeta', 'terms', 'term_id', 'term_id'));
  if (kinds.includes('termRelationships') && has('term_relationships') && has('posts') && has('term_taxonomy')) {
    const rel = ident(name('term_relationships'));
    parts.push({
      table: name('term_relationships'),
      how: 'delete',
      where: `NOT EXISTS (SELECT 1 FROM ${ident(name('posts'))} p WHERE p.ID = ${rel}.object_id) AND term_taxonomy_id NOT IN (SELECT term_taxonomy_id FROM ${ident(name('term_taxonomy'))} WHERE taxonomy = 'link_category')`,
    });
  }
  // Users are the network's: their meta is cleaned with the first site.
  if (kinds.includes('usermeta') && blog === 1) add(orphan('usermeta', 'users', 'user_id', 'ID', true));
  if (!parts.length) throw new MysqlRefused('This site has none of those tables');
  return planCleanup(ctx, t.database, 'orphans', 'Delete what was left behind', parts, `${domain}${path ?? ''}`);
}

// ── whole tables ─────────────────────────────────────────────

/** A table the panel may empty or delete: not in MySQL's own or a kept database, not a view, its site not busy. */
async function wholeTable(ctx: RowsContext, database: string, table: string): Promise<void> {
  if (isSystemDatabase(database)) throw new MysqlRefused(`${database} is MySQL's own: the panel only reads it`);
  if (ctx.kept().some((k) => k.name === database)) throw new MysqlRefused(`${database} is kept for a site to put back: the panel only reads it`);
  const site = siteDatabases(ctx.config).find((s) => s.db === database);
  if (site && ctx.siteBusy(`${site.domain}${site.path ?? ''}`)) throw new MysqlRefused(`${site.domain}${site.path ?? ''} is busy with a job: wait until it finishes`);
  let view: boolean;
  try {
    view = (await tableMeta(browse(ctx), database, table)).table.view;
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
  if (view) throw new MysqlRefused(`${table} is a view: change it in phpMyAdmin`);
}

export async function planEmptyTable(ctx: RowsContext, { database, table }: ActionInput<'mysql.emptyTable'>): Promise<JobStep[]> {
  await wholeTable(ctx, database, table);
  return planCleanup(ctx, database, 'empty', `Empty ${table}`, [{ table, how: 'empty' }]);
}

export async function planDropTable(ctx: RowsContext, { database, table }: ActionInput<'mysql.dropTable'>): Promise<JobStep[]> {
  await wholeTable(ctx, database, table);
  return planCleanup(ctx, database, 'drop', `Delete table ${table}`, [{ table, how: 'drop' }]);
}

// ── autoload ─────────────────────────────────────────────────

/**
 * Turns autoload on or off for one option, written the way the site's
 * WordPress writes it: yes and no before 6.6, on and off since. A row change,
 * so its Undo is the row's and puts the old value back, auto included.
 */
export async function setAutoload(ctx: RowsContext, { domain, path, blog = 1, option, autoload }: ActionInput<'db.setAutoload'>) {
  const t = await siteTablesFor(ctx, domain, path, blog);
  const table = `${t.blogPrefix}options`;
  if (!t.names.has(table)) throw new MysqlRefused(`${table} is not in ${t.database}`);
  const lines = await sql(ctx, t.database, `SELECT option_id, autoload FROM ${ident(table)} WHERE option_name = ${textLiteral(option)};\n`);
  const [id, current = ''] = (lines[0] ?? '').split('\t');
  if (!id) throw new MysqlRefused(`${table} has no option called ${option}`);
  const legacy = current === 'yes' || current === 'no';
  const next = autoload === 'on' ? (legacy ? 'yes' : 'on') : legacy ? 'no' : 'off';
  if (current === next) throw new MysqlRefused(`${option} is already ${autoload === 'on' ? 'loaded on every page' : 'loaded only when asked for'}`);
  const r = await updateRow(ctx, { database: t.database, table, rowKey: [id], rowValues: { autoload: next }, rowWas: { autoload: current } });
  return { ...r, stdout: `${option}: autoload ${next} (was ${current}); Undo puts it back` };
}

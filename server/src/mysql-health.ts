import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, WpDbHealth, WpDbHealthIssue, WpTableFix } from '@devmagic-panel/shared';
import type { ExecResult } from './exec.js';
import type { JobStep } from './jobs.js';
import { type BrowseContext, num, parseJson, read } from './mysql-browse.js';
import { adminSql, cleanupsDir, dumpPart, pruneCleanups, type SavedCleanup, undoCleanup } from './mysql-cleanup.js';
import type { RowsContext } from './mysql-rows.js';
import { MysqlRefused } from './mysql-server.js';
import { ident, textLiteral } from './mysql-sql.js';
import { wordpressTables } from './mysql-wordpress.js';
import { formatBytes } from './sites/db.js';
import { existingFolder, freeSpace } from './sites/space.js';

/**
 * How WordPress makes its own tables (wp-admin/includes/schema.php), and the
 * check of a site's tables against it: a lost primary key or AUTO_INCREMENT,
 * a missing index, MyISAM, an old character set. Each fix is a job that saves
 * the table whole first, so Undo puts it back. Every word of the SQL is a
 * constant here or a name MySQL listed, in backticks.
 */
interface CoreIndex {
  name: string;
  /** The columns, in order, as WordPress writes them, prefix lengths included. */
  columns: string[];
  unique?: boolean;
}

interface CoreTable {
  /** The primary key's columns. */
  primary: string[];
  /** The column that counts up, when WordPress makes one. */
  autoIncrement?: string;
  indexes: CoreIndex[];
  /** Users and usermeta: one for the whole network, checked with its first site. */
  shared?: boolean;
}

const key = (name: string, ...columns: string[]): CoreIndex => ({ name, columns });
const meta = (owner: string, id: string): CoreTable => ({ primary: [id], autoIncrement: id, indexes: [key(owner, owner), key('meta_key', 'meta_key(191)')] });

export const CORE_SCHEMA: Record<string, CoreTable> = {
  options: { primary: ['option_id'], autoIncrement: 'option_id', indexes: [{ name: 'option_name', columns: ['option_name'], unique: true }] },
  posts: {
    primary: ['ID'],
    autoIncrement: 'ID',
    indexes: [key('post_name', 'post_name(191)'), key('type_status_date', 'post_type', 'post_status', 'post_date', 'ID'), key('post_parent', 'post_parent'), key('post_author', 'post_author')],
  },
  postmeta: meta('post_id', 'meta_id'),
  comments: {
    primary: ['comment_ID'],
    autoIncrement: 'comment_ID',
    indexes: [
      key('comment_post_ID', 'comment_post_ID'),
      key('comment_approved_date_gmt', 'comment_approved', 'comment_date_gmt'),
      key('comment_date_gmt', 'comment_date_gmt'),
      key('comment_parent', 'comment_parent'),
      key('comment_author_email', 'comment_author_email(10)'),
    ],
  },
  commentmeta: meta('comment_id', 'meta_id'),
  terms: { primary: ['term_id'], autoIncrement: 'term_id', indexes: [key('slug', 'slug(191)'), key('name', 'name(191)')] },
  term_taxonomy: { primary: ['term_taxonomy_id'], autoIncrement: 'term_taxonomy_id', indexes: [{ name: 'term_id_taxonomy', columns: ['term_id', 'taxonomy'], unique: true }, key('taxonomy', 'taxonomy')] },
  term_relationships: { primary: ['object_id', 'term_taxonomy_id'], indexes: [key('term_taxonomy_id', 'term_taxonomy_id')] },
  termmeta: meta('term_id', 'meta_id'),
  links: { primary: ['link_id'], autoIncrement: 'link_id', indexes: [key('link_visible', 'link_visible')] },
  users: { primary: ['ID'], autoIncrement: 'ID', indexes: [key('user_login_key', 'user_login'), key('user_nicename', 'user_nicename'), key('user_email', 'user_email')], shared: true },
  usermeta: { primary: ['umeta_id'], autoIncrement: 'umeta_id', indexes: [key('user_id', 'user_id'), key('meta_key', 'meta_key(191)')], shared: true },
};

/** A column of an index without its prefix length: meta_key(191) is meta_key. */
const bare = (column: string) => column.replace(/\(\d+\)$/, '');
/** An index column as SQL: `meta_key`(191). */
const columnSql = (column: string) => {
  const m = /^(\w+)(?:\((\d+)\))?$/.exec(column);
  return m ? `${ident(m[1] as string)}${m[2] ? `(${m[2]})` : ''}` : ident(column);
};
/** The integer types WordPress gives a key column; a key fix writes the column's own type back only when it is one of these. */
const KEY_TYPE = /^(?:big|small|medium|tiny)?int(?:\(\d{1,3}\))?(?: unsigned)?$/i;
const COLLATION = /^utf8mb4_\w{1,60}$/;

interface Found {
  engine: string;
  collation: string;
  /** Index name to its columns in order, and whether it is unique. */
  indexes: Map<string, { columns: string[]; unique: boolean }>;
  /** Column name to its type and extra (auto_increment). */
  columns: Map<string, { type: string; extra: string }>;
}

/** The site's WordPress tables, the network's shared ones with its first site, by their core name. */
function coreTables(names: Set<string>, prefix: string, blogPrefix: string, blog: number): Array<{ core: string; table: string; schema: CoreTable }> {
  return Object.entries(CORE_SCHEMA)
    .filter(([, schema]) => !schema.shared || blog === 1)
    .map(([core, schema]) => ({ core, table: `${schema.shared ? prefix : blogPrefix}${core}`, schema }))
    .filter((t) => names.has(t.table));
}

async function readFound(ctx: BrowseContext, database: string, tables: string[]): Promise<Map<string, Found>> {
  const list = tables.map((t) => textLiteral(t)).join(', ');
  const where = `TABLE_SCHEMA = ${textLiteral(database)} AND TABLE_NAME IN (${list})`;
  const lines = await read(
    ctx,
    `SELECT JSON_ARRAY('ht', TABLE_NAME, COALESCE(ENGINE, ''), COALESCE(TABLE_COLLATION, '')) FROM information_schema.TABLES WHERE ${where};\n` +
      `SELECT JSON_ARRAY('hi', TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME) FROM information_schema.STATISTICS WHERE ${where} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;\n` +
      `SELECT JSON_ARRAY('hc', TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, EXTRA) FROM information_schema.COLUMNS WHERE ${where};\n`,
  );
  const found = new Map<string, Found>();
  const of = (t: string) => {
    let f = found.get(t);
    if (!f) found.set(t, (f = { engine: '', collation: '', indexes: new Map(), columns: new Map() }));
    return f;
  };
  for (const row of lines.map(parseJson)) {
    const [tag, table] = row as [string, string];
    if (tag === 'ht') Object.assign(of(table), { engine: String(row[2]), collation: String(row[3]) });
    if (tag === 'hi') {
      const f = of(table);
      const name = String(row[2]);
      const index = f.indexes.get(name) ?? { columns: [], unique: num(row[3]) === 0 };
      index.columns.push(String(row[5]));
      f.indexes.set(name, index);
    }
    if (tag === 'hc') of(table).columns.set(String(row[2]), { type: String(row[3]), extra: String(row[4]) });
  }
  return found;
}

/** The issues of one table against how WordPress makes it; blocked ones need counts, read only for a table that has the issue. */
async function tableIssues(ctx: BrowseContext, database: string, table: string, schema: CoreTable, f: Found): Promise<WpDbHealthIssue[]> {
  const issues: WpDbHealthIssue[] = [];
  const t = `${ident(database)}.${ident(table)}`;
  const primary = f.indexes.get('PRIMARY');
  const hasPrimary = primary !== undefined && primary.columns.join(',') === schema.primary.join(',');
  const ai = schema.autoIncrement;
  const aiColumn = ai ? f.columns.get(ai) : undefined;
  const hasAi = !ai || /auto_increment/i.test(aiColumn?.extra ?? '');
  const keyable = !ai || KEY_TYPE.test(aiColumn?.type ?? '');
  if (!hasPrimary || !hasAi) {
    // Duplicate or zero IDs keep a key from coming back: say how many, so they can be sorted out first.
    const cols = schema.primary.map((c) => ident(c)).join(', ');
    const [counts = []] = (await read(ctx, `SELECT JSON_ARRAY(COUNT(*) - COUNT(DISTINCT ${cols}), ${ai ? `COALESCE(SUM(${ident(ai)} = 0), 0)` : '0'}) FROM ${t};\n`, { limitMs: 60_000 })).map(parseJson);
    const [dupes, zeros] = [num(counts[0]), num(counts[1])];
    const blocked = !hasPrimary && dupes > 0 ? `${dupes.toLocaleString('en-US')} rows share an ID with another` : !hasAi && zeros > 0 ? `${zeros.toLocaleString('en-US')} rows have ID 0` : !keyable ? `${ai} is ${aiColumn?.type ?? 'missing'}, not a whole number` : undefined;
    issues.push({
      table,
      problem: hasPrimary ? 'noAutoIncrement' : 'noPrimaryKey',
      text: hasPrimary
        ? `${ai} no longer counts up (AUTO_INCREMENT): new rows get ID 0 and every save after the first fails`
        : `It lost its primary key (${schema.primary.join(', ')})${ai && !hasAi ? ' and AUTO_INCREMENT' : ''}: rows can repeat and new ones get ID 0`,
      fix: 'keys',
      ...(blocked ? { blocked } : {}),
    });
  }
  const missing: CoreIndex[] = [];
  for (const index of schema.indexes) {
    const want = index.columns.map(bare).join(',');
    const match = [...f.indexes.entries()].find(([name, i]) => name !== 'PRIMARY' && i.columns.join(',') === want);
    if (!match) {
      missing.push(index);
      continue;
    }
    if (index.unique && !match[1].unique) {
      const cols = index.columns.map((c) => ident(bare(c))).join(', ');
      const [row = []] = (await read(ctx, `SELECT JSON_ARRAY(COUNT(*) - COUNT(DISTINCT ${cols})) FROM ${t};\n`, { limitMs: 60_000 })).map(parseJson);
      const dupes = num(row[0]);
      issues.push({
        table,
        problem: 'notUnique',
        text: `${index.columns.map(bare).join(', ')} may repeat, which WordPress never expects`,
        ...(dupes > 0 ? { blocked: `${dupes.toLocaleString('en-US')} rows repeat another's ${index.columns.map(bare).join(', ')}` } : {}),
      });
    }
  }
  if (missing.length) {
    const taken = missing.filter((i) => f.indexes.has(i.name));
    issues.push({
      table,
      problem: 'missingIndex',
      text: `Missing ${missing.length === 1 ? 'the index' : 'indexes'} ${missing.map((i) => `${i.name} (${i.columns.map(bare).join(', ')})`).join(', ')}: reads by ${missing.length === 1 ? 'it' : 'them'} scan the whole table`,
      ...(taken.length ? {} : { fix: 'index' as const }),
      ...(taken.length ? { blocked: `another index is called ${taken.map((i) => i.name).join(', ')}` } : {}),
    });
  }
  if (f.engine && f.engine.toLowerCase() !== 'innodb') {
    issues.push({ table, problem: 'engine', text: `It is ${f.engine}: no transactions, and a crash can damage it. WordPress makes InnoDB tables`, fix: 'engine' });
  }
  if (/^utf8(mb3)?_/i.test(f.collation)) {
    issues.push({ table, problem: 'utf8mb3', text: `It is ${f.collation}: emoji and some characters cannot be saved. utf8mb4 holds them all, and this change loses nothing`, fix: 'charset' });
  } else if (f.collation && !/^utf8mb4_/i.test(f.collation)) {
    // latin1 often holds UTF-8 bytes already (a site moved without care): converting would garble it, so a person decides.
    issues.push({ table, problem: 'charset', text: `It is ${f.collation}. Its text may already hold UTF-8 bytes, which a conversion would garble: check it with someone who knows the site's history` });
  }
  return issues;
}

/** The health of a site's WordPress tables, from information_schema; counts are read only for a table that lost its keys. */
export async function wordpressHealth(ctx: BrowseContext, database: string, names: Set<string>, prefix: string, blogPrefix: string, blog: number): Promise<WpDbHealth> {
  const tables = coreTables(names, prefix, blogPrefix, blog);
  const facts = await tableFacts(ctx, database, siteTableNames(names, prefix, blogPrefix, blog));
  const free = freeSpaceOf(facts);
  const myisam = myisamOf(facts);
  const extra = { ...(free.length ? { free } : {}), ...(myisam.length ? { myisam } : {}) };
  if (tables.length === 0) return { tables: 0, issues: [], ...extra };
  const found = await readFound(ctx, database, tables.map((t) => t.table));
  const issues: WpDbHealthIssue[] = [];
  for (const t of tables) {
    const f = found.get(t.table);
    if (f) issues.push(...(await tableIssues(ctx, database, t.table, t.schema, f)));
  }
  return { tables: tables.length, issues, ...extra };
}

/** This site's tables of every kind: its prefix, without another site of the network's (wp_2_) on the first one. */
function siteTableNames(names: Set<string>, prefix: string, blogPrefix: string, blog: number): string[] {
  const other = new RegExp(`^${prefix.replace(/[^A-Za-z0-9_]/g, '')}\\d+_`);
  return [...names].filter((n) => n.startsWith(blogPrefix) && (blog !== 1 || !other.test(n)));
}

/** At least this much free, and a tenth of the table, before a rebuild is worth offering. */
const FREE_WORTH = 16 * 1024 * 1024;

interface TableFact {
  table: string;
  freeBytes: number;
  bytes: number;
  engine: string;
}

/** The site's tables as information_schema lists them: free space, size and engine. */
async function tableFacts(ctx: BrowseContext, database: string, tables: string[]): Promise<TableFact[]> {
  if (tables.length === 0) return [];
  const lines = await read(
    ctx,
    `SELECT JSON_ARRAY(TABLE_NAME, COALESCE(DATA_FREE, 0), COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0), COALESCE(ENGINE, '')) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)} AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME IN (${tables.map((t) => textLiteral(t)).join(', ')});\n`,
  );
  return lines.map(parseJson).map(([t, f, b, e]) => ({ table: String(t), freeBytes: num(f), bytes: num(b), engine: String(e ?? '') }));
}

/** The site's MyISAM tables of every kind (WordPress's, plugins', themes'), the smallest first: the order Turn all into InnoDB takes them in. */
function myisamOf(facts: TableFact[]): Array<{ table: string; bytes: number }> {
  return facts.filter((f) => f.engine.toLowerCase() === 'myisam').map(({ table, bytes }) => ({ table, bytes })).sort((a, b) => a.bytes - b.bytes || a.table.localeCompare(b.table));
}

/**
 * Tables with room a rebuild (OPTIMIZE TABLE) gives back to the disk, like
 * after a clean-up. With every table in one shared InnoDB file they all show
 * the same free space, which a rebuild does not give back: none is offered.
 */
function freeSpaceOf(facts: TableFact[]): NonNullable<WpDbHealth['free']> {
  const rows = facts.map(({ table, freeBytes, bytes }) => ({ table, freeBytes, bytes }));
  const same = new Map<number, number>();
  for (const r of rows) if (r.freeBytes > 0) same.set(r.freeBytes, (same.get(r.freeBytes) ?? 0) + 1);
  if ([...same.values()].some((n) => n > 3)) return [];
  return rows.filter((r) => r.freeBytes >= FREE_WORTH && r.freeBytes >= r.bytes / 10).sort((a, b) => b.freeBytes - a.freeBytes);
}

/** The statement that makes the fix, from the table as MySQL lists it now. */
async function fixStatement(ctx: BrowseContext, database: string, table: string, schema: CoreTable, fix: WpTableFix, collation: string): Promise<string> {
  const f = (await readFound(ctx, database, [table])).get(table);
  if (!f) throw new MysqlRefused(`${table} is not in ${database}`);
  const t = ident(table);
  if (fix === 'engine') return `ALTER TABLE ${t} ENGINE=InnoDB`;
  if (fix === 'charset') return `ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${collation}`;
  if (fix === 'index') {
    const add = schema.indexes
      .filter((i) => ![...f.indexes.entries()].some(([name, x]) => name !== 'PRIMARY' && x.columns.join(',') === i.columns.map(bare).join(',')) && !f.indexes.has(i.name))
      .map((i) => `ADD ${i.unique ? 'UNIQUE ' : ''}KEY ${ident(i.name)} (${i.columns.map(columnSql).join(', ')})`);
    if (add.length === 0) throw new MysqlRefused(`${table} has every index WordPress makes`);
    return `ALTER TABLE ${t} ${add.join(', ')}`;
  }
  const parts: string[] = [];
  const primary = f.indexes.get('PRIMARY');
  if (primary?.columns.join(',') !== schema.primary.join(',')) parts.push(`${primary ? 'DROP PRIMARY KEY, ' : ''}ADD PRIMARY KEY (${schema.primary.map((c) => ident(c)).join(', ')})`);
  const ai = schema.autoIncrement;
  if (ai) {
    const column = f.columns.get(ai);
    if (!column || !KEY_TYPE.test(column.type)) throw new MysqlRefused(`${table}.${ai} is ${column?.type ?? 'missing'}: a person has to look at it`);
    if (!/auto_increment/i.test(column.extra)) parts.push(`MODIFY ${ident(ai)} ${column.type} NOT NULL AUTO_INCREMENT`);
  }
  if (parts.length === 0) throw new MysqlRefused(`${table} has its primary key and AUTO_INCREMENT`);
  return `ALTER TABLE ${t} ${parts.join(', ')}`;
}

const FIX_TITLE: Record<WpTableFix, (table: string) => string> = {
  keys: (t) => `Give ${t} its primary key back`,
  index: (t) => `Add the missing indexes to ${t}`,
  engine: (t) => `Turn ${t} into InnoDB`,
  charset: (t) => `Turn ${t} into utf8mb4`,
};

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** The job of a fix: check again, save the table whole, run the ALTER; Undo puts the table back as it was. */
export async function planFixTable(ctx: RowsContext, { domain, path, blog = 1, table, fix }: ActionInput<'db.fixTable'>): Promise<{ title: string; steps: JobStep[] }> {
  const browse: BrowseContext = { config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept };
  const t = await wordpressTables(browse, domain, path, blog);
  const entry = coreTables(t.names, t.prefix, t.blogPrefix, blog).find((c) => c.table === table);
  if (!entry) throw new MysqlRefused(`${table} is not one of this site's WordPress tables`);
  const health = await wordpressHealth(browse, t.database, new Set([table]), t.prefix, t.blogPrefix, blog);
  const issue = health.issues.find((i) => i.fix === fix && i.table === table);
  if (!issue) throw new MysqlRefused(`${table} needs no such fix any more`);
  if (issue.blocked) throw new MysqlRefused(`Not yet: ${issue.blocked}. Sort those rows out first, then fix it`);
  // The collation the site's other utf8mb4 tables have, so a converted table sorts like them.
  const collations = await read(browse, `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(t.database)} AND TABLE_COLLATION LIKE 'utf8mb4\\_%' GROUP BY TABLE_COLLATION ORDER BY COUNT(*) DESC LIMIT 1;\n`, { raw: false });
  const collation = collations[0] && COLLATION.test(collations[0]) ? collations[0] : 'utf8mb4_unicode_520_ci';
  const statement = await fixStatement(browse, t.database, table, entry.schema, fix, collation);
  const site = `${domain}${path ?? ''}`;
  const title = FIX_TITLE[fix](table);
  const now = ctx.now?.() ?? new Date();
  const id = `${stamp(now)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  const dir = join(cleanupsDir(ctx.config), id);
  const file = `01-${table}.sql.gz`;
  const database = t.database;
  const steps: JobStep[] = [
    {
      id: 'save',
      label: `Save ${table} for Undo`,
      weight: 3,
      run: async (job) => {
        const [size = '0'] = await adminSql(ctx, database, `SELECT COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${textLiteral(table)};\n`);
        // The copy, and MySQL's rebuild of the table next to the old one, both need room.
        const need = Number(size) * 2;
        const free = freeSpace(existingFolder(cleanupsDir(ctx.config))).bytes;
        if (need > free) throw new MysqlRefused(`Saving and rebuilding ${table} needs up to ${formatBytes(need)}, and the disk has ${formatBytes(free)} free: make room, then try again`);
        mkdirSync(cleanupsDir(ctx.config), { recursive: true, mode: 0o700 });
        pruneCleanups(cleanupsDir(ctx.config), now.getTime());
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        await dumpPart(ctx, database, { table, how: 'replace' }, undefined, join(dir, file), (bytes) => job.progress(0.5, `${formatBytes(bytes)} of SQL`));
        const saved: SavedCleanup = { title, kind: 'fix', database, site, parts: [{ table, how: 'replace', rows: 0, file }], savedAt: now.toISOString() };
        writeFileSync(join(dir, 'cleanup.json'), JSON.stringify(saved), { mode: 0o600 });
        return { code: 0, stdout: `saved ${table}, kept 14 days`, stderr: '' };
      },
    },
    {
      id: 'fix',
      label: title,
      weight: 3,
      run: async (job): Promise<ExecResult> => {
        try {
          await adminSql(ctx, database, `SET SESSION lock_wait_timeout = 60;\n${statement};\n`, 2 * 60 * 60_000);
        } catch (error) {
          // MySQL changed nothing: no copy to keep.
          rmSync(dir, { recursive: true, force: true });
          return { code: 1, stdout: '', stderr: (error as Error).message };
        }
        job.onUndo(`Put ${table} back as it was`, () => undoCleanup(ctx, { database, cleanup: id }));
        return { code: 0, stdout: `${statement}. Undo puts ${table} back as it was, for 14 days`, stderr: '' };
      },
    },
  ];
  return { title, steps };
}

/**
 * Every MyISAM table of the site (its prefix; a network's shared tables with
 * its first site) into InnoDB, the smallest first, one step a table: each is
 * saved whole, then ALTER TABLE ... ENGINE=InnoDB. One saved copy holds the
 * tables converted so far, so Stop between two, Retry carries on, and Undo
 * puts back every table the job converted.
 */
export async function planToInnodb(ctx: RowsContext, { domain, path, blog = 1 }: ActionInput<'db.toInnodb'>): Promise<{ title: string; steps: JobStep[] }> {
  const browse: BrowseContext = { config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept };
  const t = await wordpressTables(browse, domain, path, blog);
  const tables = myisamOf(await tableFacts(browse, t.database, siteTableNames(t.names, t.prefix, t.blogPrefix, blog)));
  if (tables.length === 0) throw new MysqlRefused('This site has no MyISAM tables');
  const title = `Turn ${tables.length === 1 ? (tables[0] as { table: string }).table : `${tables.length} tables`} into InnoDB`;
  const site = `${domain}${path ?? ''}`;
  const database = t.database;
  const now = ctx.now?.() ?? new Date();
  const id = `${stamp(now)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  const dir = join(cleanupsDir(ctx.config), id);
  const saved: SavedCleanup = { title, kind: 'fix', database, site, parts: [], savedAt: now.toISOString() };
  let undoing = false;
  const steps: JobStep[] = [
    {
      id: 'room',
      label: 'Check the disk has room',
      run: async () => {
        // The copies of them all, and MySQL's rebuild of the biggest next to the old one.
        const total = tables.reduce((n, x) => n + x.bytes, 0);
        const need = total + Math.max(...tables.map((x) => x.bytes));
        const free = freeSpace(existingFolder(cleanupsDir(ctx.config))).bytes;
        if (need > free) throw new MysqlRefused(`Saving and rebuilding ${tables.length === 1 ? 'the table' : `${tables.length} tables`} needs up to ${formatBytes(need)}, and the disk has ${formatBytes(free)} free: make room, then try again`);
        mkdirSync(cleanupsDir(ctx.config), { recursive: true, mode: 0o700 });
        pruneCleanups(cleanupsDir(ctx.config), now.getTime());
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return { code: 0, stdout: `${formatBytes(need)} needed, ${formatBytes(free)} free`, stderr: '' };
      },
    },
    ...tables.map(({ table, bytes }, i): JobStep => ({
      id: `table-${i + 1}`,
      label: `Turn ${table} into InnoDB`,
      weight: Math.max(1, Math.round(bytes / (64 * 1024 * 1024))),
      run: async (job): Promise<ExecResult> => {
        // A table converted already (an earlier try, or by hand) is left as it is.
        const [engine = ''] = await adminSql(ctx, database, `SELECT COALESCE(ENGINE, '') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${textLiteral(table)};\n`);
        if (engine.toLowerCase() !== 'myisam') return { code: 0, stdout: `${table} is ${engine || 'gone'} already: left as it is`, stderr: '' };
        const file = `${String(i + 1).padStart(2, '0')}-${table}.sql.gz`;
        await dumpPart(ctx, database, { table, how: 'replace' }, undefined, join(dir, file), (b) => job.progress(0.5, `${formatBytes(b)} of SQL`));
        try {
          await adminSql(ctx, database, `SET SESSION lock_wait_timeout = 60;\nALTER TABLE ${ident(table)} ENGINE=InnoDB;\n`, 2 * 60 * 60_000);
        } catch (error) {
          // MySQL changed nothing: this table's copy goes.
          rmSync(join(dir, file), { force: true });
          return { code: 1, stdout: '', stderr: (error as Error).message };
        }
        saved.parts.push({ table, how: 'replace', rows: 0, file });
        writeFileSync(join(dir, 'cleanup.json'), JSON.stringify(saved), { mode: 0o600 });
        if (!undoing) {
          undoing = true;
          job.onUndo('Put the tables back as they were', () => undoCleanup(ctx, { database, cleanup: id }));
        }
        return { code: 0, stdout: `${table} is InnoDB now`, stderr: '' };
      },
    })),
  ];
  return { title, steps };
}

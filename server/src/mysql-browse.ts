import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DbCellValue, DbColumn, DbSchema, DbIndex, DbOverview, DbRowsPage, DbStructure, DbTable, MysqlDatabase } from '@devmagic-panel/shared';
import { dbCellQuery, dbRowsQuery, isSystemDatabase, mysqlDatabaseName, mysqlIdentifier } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import type { MysqlAccount } from './mysql-limits.js';
import { keyToSite, siteDatabases, siteRef } from './mysql-server.js';
import { BrowseError, CELL_BINARY_MAX, CELL_TEXT_MAX, cellSql, type ColumnMeta, columnHead, columnNamed, ident, isBinary, parseRows, rowsSql, textLiteral, toCell } from './mysql-sql.js';
import { freshStatsSql } from './mysql-stats.js';
import { readSiteVhosts } from './sites/vhost.js';

/**
 * The database browser's reads: a database's tables, a table's structure,
 * its rows a page at a time and one value in full. Read only: every run
 * starts a read-only transaction and a time limit, and only SELECT and SHOW
 * statements built in mysql-sql.ts follow.
 */
export interface BrowseContext {
  config: SystemConfig;
  exec: Executor;
  mysql: MysqlAccount | null | undefined;
  /** The SQL runner's account, which can only read (mysql-query.ts). */
  readOnly?: MysqlAccount | null | undefined;
  /** The databases the panel keeps a site's tables in, with the site's key. */
  kept: () => Array<{ name: string; site: string }>;
}

/** How long one read may run on the server before MySQL stops it. */
const READ_LIMIT_MS = 15_000;
/** Counting the rows a filter matches gets less: a page without its count is still a page. */
const COUNT_LIMIT_MS = 5_000;
/** Tables up to this many rows (MySQL's estimate) are counted exactly. */
const EXACT_COUNT_ROWS = 100_000;

const flavors = new WeakMap<Executor, 'mysql' | 'mariadb'>();

const firstLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;

function account(ctx: BrowseContext): MysqlAccount {
  if (!ctx.mysql) throw new BrowseError('The panel has no MySQL admin account: add one on the Environment page', 503);
  return ctx.mysql;
}

// --binary-mode: the text on stdin is SQL only, never a command of the mysql client like \! or source.
const baseArgs = (mysql: MysqlAccount) => ['--batch', '--skip-column-names', '--binary-mode', '--default-character-set=utf8mb4', '--user', mysql.user, '--host', mysql.host];

/** MySQL and MariaDB name the time limit differently; asked once per executor, so once per panel start. */
export async function flavor(ctx: BrowseContext): Promise<'mysql' | 'mariadb'> {
  const known = flavors.get(ctx.exec);
  if (known) return known;
  const mysql = ctx.mysql ?? ctx.readOnly ?? account(ctx);
  const r = await ctx.exec('mysql', [...baseArgs(mysql), '-e', 'SELECT VERSION()'], { env: { MYSQL_PWD: mysql.password }, timeoutMs: 10_000 });
  if (r.code !== 0) throw new BrowseError(`MySQL refused the admin account: ${firstLine(r)}`, 502);
  const found = /mariadb/i.test(r.stdout) ? 'mariadb' : 'mysql';
  flavors.set(ctx.exec, found);
  return found;
}

/**
 * Runs statements on stdin (never in argv, where a filter's value would show
 * in ps) after a read-only transaction and a time limit, and returns the
 * lines they printed. raw: lines as MySQL wrote them, for JSON_ARRAY output,
 * which escapes its own control characters.
 */
export async function read(ctx: BrowseContext, sql: string, { limitMs = READ_LIMIT_MS, maxBytes = 8 * 1024 * 1024, raw = true } = {}): Promise<string[]> {
  const mysql = account(ctx);
  const limit = (await flavor(ctx)) === 'mariadb' ? `SET SESSION max_statement_time = ${limitMs / 1000};` : `SET SESSION max_execution_time = ${limitMs};`;
  const input = `SET SESSION TRANSACTION READ ONLY;\n${limit}\n${sql}`;
  const r = await ctx.exec('mysql', [...baseArgs(mysql), ...(raw ? ['--raw'] : [])], {
    env: { MYSQL_PWD: mysql.password },
    input,
    timeoutMs: limitMs + 10_000,
    maxBufferBytes: maxBytes,
  });
  if (r.code !== 0) {
    if (/maximum statement execution time|max_statement_time|Query execution was interrupted/i.test(r.stderr)) {
      throw new BrowseError(`MySQL stopped the read after ${limitMs / 1000} seconds: narrow it with a filter`, 504);
    }
    throw new BrowseError(`MySQL refused the read: ${firstLine(r)}`, 502);
  }
  return r.stdout.split('\n').filter((line) => line !== '');
}

export function checkDatabase(database: string): string {
  if (!mysqlDatabaseName.safeParse(database).success) throw new BrowseError('A database name like acme_com');
  return database;
}

function checkTable(table: string): string {
  if (!mysqlIdentifier.safeParse(table).success) throw new BrowseError('A table name like wp_options');
  return table;
}

export const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
/** MySQL's DATETIME in JSON, 2026-11-06 10:00:00.000000, as ISO; local time, as the server keeps it. */
function isoTime(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseJson(line: string): unknown[] {
  try {
    const v = JSON.parse(line) as unknown;
    if (Array.isArray(v)) return v;
  } catch {
    // Falls through.
  }
  throw new BrowseError('MySQL answered with a line the panel cannot read', 502);
}

const TABLE_FIELDS = 'TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, UPDATE_TIME';

function toTable(values: unknown[]): DbTable {
  const [name, type, engine, rows, data, index, free, collation, updated] = values;
  const view = type === 'VIEW';
  const updatedAt = isoTime(updated);
  return {
    name: String(name),
    view,
    ...(str(engine) ? { engine: str(engine) as string } : {}),
    rows: num(rows),
    dataBytes: num(data),
    indexBytes: num(index),
    freeBytes: num(free),
    ...(str(collation) ? { collation: str(collation) as string } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** What the database is to the panel, and the sites it belongs to. */
function kindOf(ctx: BrowseContext, database: string): Pick<DbOverview, 'kind' | 'sites'> {
  if (isSystemDatabase(database)) return { kind: 'system', sites: [] };
  const using = siteDatabases(ctx.config).filter((s) => s.db === database);
  if (using.length) return { kind: 'site', sites: using.map((s) => ({ ...siteRef(s), ...(s.prefix ? { prefix: s.prefix } : {}) })) };
  const kept = ctx.kept().find((k) => k.name === database);
  return kept ? { kind: 'kept', sites: [keyToSite(kept.site)] } : { kind: 'unused' as MysqlDatabase['kind'], sites: [] };
}

/**
 * phpMyAdmin's address, when Apache has it: on a site Apache serves over
 * HTTPS (the database's own site first), since the panel's own address sends
 * every path to the panel and nginx does not serve phpMyAdmin.
 */
export function phpMyAdminUrl(config: SystemConfig, domain?: string): string | undefined {
  if (!existsSync(join(dirname(config.APACHE_SITES_ENABLED), 'conf-enabled', 'phpmyadmin.conf'))) return undefined;
  const https = readSiteVhosts(config).filter((v) => v.server === 'apache' && v.byPort.https.length > 0 && v.names[0]);
  const host = https.find((v) => v.names[0] === domain) ?? https[0];
  return host ? `https://${host.names[0] as string}/phpmyadmin/` : 'http://localhost/phpmyadmin/';
}

export async function dbOverview(ctx: BrowseContext, database: string, now = Date.now): Promise<DbOverview> {
  const db = checkDatabase(database);
  const fresh = await freshStatsSql(ctx.exec, account(ctx));
  const lines = await read(
    ctx,
    `${fresh}SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${textLiteral(db)};\n` +
      `SELECT JSON_ARRAY(${TABLE_FIELDS}) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(db)} ORDER BY TABLE_NAME;\n`,
  );
  if (lines[0] !== '1') throw new BrowseError(`No database called ${db} on this MySQL server`, 404);
  const tables = lines.slice(1).map((line) => toTable(parseJson(line)));
  const { kind, sites } = kindOf(ctx, db);
  const pma = phpMyAdminUrl(ctx.config, sites[0]?.domain);
  return {
    database: db,
    kind,
    sites,
    tables,
    totalBytes: tables.reduce((sum, t) => sum + t.dataBytes + t.indexBytes, 0),
    ...(pma ? { phpMyAdmin: pma } : {}),
    checkedAt: new Date(now()).toISOString(),
  };
}

export interface TableMeta {
  table: DbTable;
  columns: ColumnMeta[];
  indexes: DbIndex[];
  primaryKey: ColumnMeta[];
}

/** A table's row in information_schema, its columns and its indexes; refuses a table the database does not have. */
export async function tableMeta(ctx: BrowseContext, database: string, table: string): Promise<TableMeta> {
  const db = textLiteral(checkDatabase(database));
  const t = textLiteral(checkTable(table));
  const lines = await read(
    ctx,
    `SELECT JSON_ARRAY('t', ${TABLE_FIELDS}) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${t};\n` +
      `SELECT JSON_ARRAY('c', COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${t} ORDER BY ORDINAL_POSITION;\n` +
      `SELECT JSON_ARRAY('i', INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE, CARDINALITY) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${t} ORDER BY INDEX_NAME, SEQ_IN_INDEX;\n`,
  );
  const rows = lines.map(parseJson);
  const found = rows.find((r) => r[0] === 't');
  // information_schema compares names without regard to case on some systems: the table must be the one asked for.
  if (!found || found[1] !== table) throw new BrowseError(`No table called ${table} in ${database}`, 404);
  const columns: ColumnMeta[] = rows
    .filter((r) => r[0] === 'c')
    .map(([, name, type, dataType, nullable, dflt, key, extra, charset, collation, comment]) => ({
      name: String(name),
      type: String(type),
      dataType: String(dataType).toLowerCase(),
      nullable: nullable === 'YES',
      default: dflt === null || dflt === undefined ? null : String(dflt),
      key: String(key ?? ''),
      extra: String(extra ?? ''),
      ...(str(charset) ? { charset: str(charset) as string } : {}),
      ...(str(collation) ? { collation: str(collation) as string } : {}),
      ...(str(comment) ? { comment: str(comment) as string } : {}),
    }));
  const byName = new Map<string, DbIndex>();
  for (const [, name, nonUnique, , column, type, cardinality] of rows.filter((r) => r[0] === 'i')) {
    const key = String(name);
    const index = byName.get(key) ?? { name: key, columns: [], unique: num(nonUnique) === 0, type: String(type ?? '') };
    // A functional index (MySQL 8) has an expression where the column would be.
    index.columns.push(column === null || column === undefined ? '(expression)' : String(column));
    if (cardinality !== null && cardinality !== undefined) index.cardinality = num(cardinality);
    byName.set(key, index);
  }
  const indexes = [...byName.values()].sort((a, b) => (a.name === 'PRIMARY' ? -1 : b.name === 'PRIMARY' ? 1 : a.name.localeCompare(b.name)));
  const primaryKey = (byName.get('PRIMARY')?.columns ?? []).map((name) => columns.find((c) => c.name === name)).filter((c): c is ColumnMeta => Boolean(c));
  return { table: toTable(found.slice(1)), columns, indexes, primaryKey };
}

/** mysql --batch escapes newlines, tabs and backslashes in a value. */
export function unescapeBatch(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c));
}

/** What a table's structure deserves a look for, in a sentence each. */
export function structureWarnings(table: DbTable, primaryKey: readonly unknown[]): string[] {
  if (table.view) return [];
  const out: string[] = [];
  if (primaryKey.length === 0) out.push('No primary key: a row cannot be found again for its full values, and replication and many tools need one.');
  if (table.engine && table.engine.toLowerCase() === 'myisam') out.push('MyISAM: no transactions and no crash recovery. InnoDB has been the default since MySQL 5.5.');
  const charset = table.collation?.split('_')[0];
  if (charset && charset !== 'utf8mb4' && charset !== 'binary') out.push(`Character set ${charset}: emoji and some scripts cannot be stored. WordPress uses utf8mb4.`);
  if (table.freeBytes > 10 * 1024 * 1024 && table.freeBytes > table.dataBytes / 10) out.push('Free space inside the table: Optimize on the MySQL page gives it back to the disk.');
  return out;
}

export async function dbStructure(ctx: BrowseContext, database: string, table: string): Promise<DbStructure> {
  const meta = await tableMeta(ctx, database, table);
  // SHOW CREATE TABLE prints several lines: escaped by --batch, one line, then unescaped here.
  const created = await read(ctx, `SHOW CREATE TABLE ${ident(database)}.${ident(table)};\n`, { raw: false });
  const createSql = unescapeBatch(created[0]?.split('\t')[1] ?? '');
  const columns: DbColumn[] = meta.columns.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    default: c.default,
    key: c.key,
    extra: c.extra,
    ...(c.collation ? { collation: c.collation } : {}),
    ...(c.comment ? { comment: c.comment } : {}),
  }));
  return {
    database,
    table: meta.table,
    columns,
    indexes: meta.indexes,
    primaryKey: meta.primaryKey.map((c) => c.name),
    createSql,
    warnings: structureWarnings(meta.table, meta.primaryKey),
  };
}

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BrowseError(parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

/** The rows that match, exactly when that is quick; MySQL's estimate for a big table without filters; null when counting took too long. */
async function countRows(ctx: BrowseContext, meta: TableMeta, filtered: boolean, sql: string): Promise<{ total: number | null; totalExact: boolean }> {
  if (!filtered && !meta.table.view && meta.table.rows > EXACT_COUNT_ROWS) return { total: meta.table.rows, totalExact: false };
  try {
    const lines = await read(ctx, sql, { limitMs: COUNT_LIMIT_MS });
    return { total: num(lines[0]), totalExact: true };
  } catch {
    return filtered || meta.table.view ? { total: null, totalExact: false } : { total: meta.table.rows, totalExact: false };
  }
}

export async function dbRows(ctx: BrowseContext, database: string, table: string, body: unknown): Promise<DbRowsPage> {
  const query = parseBody(dbRowsQuery, body);
  const meta = await tableMeta(ctx, database, table);
  const sql = rowsSql(database, table, meta.columns, meta.primaryKey, query);
  const [lines, counted] = await Promise.all([read(ctx, sql.rows, { maxBytes: 32 * 1024 * 1024 }), countRows(ctx, meta, query.filters.length > 0, sql.count)]);
  const rows = parseRows(lines, meta.columns, meta.primaryKey);
  return {
    database,
    table,
    columns: meta.columns.map(columnHead),
    primaryKey: meta.primaryKey.map((c) => c.name),
    rows: rows.slice(0, query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    ...counted,
    hasMore: rows.length > query.pageSize,
  };
}

export async function dbCell(ctx: BrowseContext, database: string, table: string, body: unknown): Promise<DbCellValue> {
  const query = parseBody(dbCellQuery, body);
  const meta = await tableMeta(ctx, database, table);
  const column = columnNamed(meta.columns, query.column);
  const lines = await read(ctx, cellSql(database, table, column, meta.primaryKey, query.key), { maxBytes: 32 * 1024 * 1024 });
  if (!lines[0]) throw new BrowseError('That row is not there any more: it changed or went since the page was read', 404);
  const [head, length] = parseJson(lines[0]);
  const binary = isBinary(column);
  const value = toCell(head, length, binary);
  return { value, cut: num(length) > (binary ? CELL_BINARY_MAX : CELL_TEXT_MAX) };
}

/** Every table and its columns in order, names only, for the SQL editor's suggestions. */
export async function dbSchema(ctx: BrowseContext, database: string): Promise<DbSchema> {
  const db = checkDatabase(database);
  const lines = await read(ctx, `SELECT JSON_ARRAY(TABLE_NAME, COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${textLiteral(db)} ORDER BY TABLE_NAME, ORDINAL_POSITION;\n`);
  const tables: Record<string, string[]> = {};
  for (const line of lines) {
    const [table, column] = parseJson(line);
    (tables[String(table)] ??= []).push(String(column));
  }
  return { database: db, tables };
}

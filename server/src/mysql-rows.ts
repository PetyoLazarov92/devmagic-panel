import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, RowChangeInfo } from '@devmagic-panel/shared';
import { isSystemDatabase, rowChangeId } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import type { MysqlAccount } from './mysql-limits.js';
import { type BrowseContext, parseJson, type TableMeta, tableMeta } from './mysql-browse.js';
import { MysqlRefused, siteDatabases } from './mysql-server.js';
import { type ColumnMeta, ident, isBinary, isNumeric, literalFor, textLiteral } from './mysql-sql.js';

/**
 * Changing, adding and deleting rows, each with Undo. One run of mysql does
 * all of a change in a transaction: it reads the rows it is about to change
 * (FOR UPDATE, so nothing changes them in between), changes them, and prints
 * the copy, which is saved to BACKUP_DIR/row-changes (0600, 14 days) before
 * the panel answers. A change only applies while the row still holds what
 * you saw; Undo only while it still holds what the change left.
 */
export const ROW_CHANGE_DAYS = 14;

export interface RowsContext {
  config: SystemConfig;
  exec: Executor;
  mysql: MysqlAccount | null | undefined;
  kept: () => Array<{ name: string; site: string }>;
  /** True while a job works on the site that uses the database. */
  siteBusy: (site: string) => boolean;
  now?: () => Date;
}

/** A row as saved: each column's full value, binary ones as hex; null for NULL. */
type SavedRow = Record<string, string | null>;

interface RowChange {
  kind: 'update' | 'insert' | 'delete';
  database: string;
  table: string;
  primaryKey: string[];
  /** The columns saved as hex. */
  binary: string[];
  /** The rows as they were before the change (update, delete), or the row added (insert). */
  rows: SavedRow[];
  /** For an update, the values it set: Undo puts the old ones back only while these are still there. */
  set?: SavedRow;
  savedAt: string;
}

export const rowChangesDir = (config: SystemConfig) => join(config.BACKUP_DIR, 'row-changes');

function account(ctx: RowsContext): MysqlAccount {
  if (!ctx.mysql) throw new MysqlRefused('The panel has no MySQL admin account: add one under Aura, Machine checks');
  return ctx.mysql;
}

/**
 * Statements on stdin with the admin account, in one session: --binary-mode so the
 * text is SQL only, and sql_mode as WordPress sets it, so a row with a zero date
 * can be put back.
 */
async function write(ctx: RowsContext, sql: string): Promise<string[]> {
  const mysql = account(ctx);
  const r = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--raw', '--binary-mode', '--default-character-set=utf8mb4', '--user', mysql.user, '--host', mysql.host], {
    env: { MYSQL_PWD: mysql.password },
    input: `SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';\nSET SESSION innodb_lock_wait_timeout = 10;\n${sql}`,
    timeoutMs: 60_000,
    maxBufferBytes: 64 * 1024 * 1024,
  });
  if (r.code !== 0) throw new MysqlRefused(`MySQL refused the change: ${(r.stderr.trim().split('\n').find((l) => l.startsWith('ERROR')) ?? r.stderr.trim().split('\n')[0] ?? `exit ${r.code}`).replace(/ at line \d+/, '')}`);
  return r.stdout.split('\n').filter((l) => l !== '');
}

const browse = (ctx: RowsContext): BrowseContext => ({ config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept });

/** The table, when the panel may change its rows: not MySQL's own, not one it keeps, not a view, with a primary key, its site not busy. */
async function changeable(ctx: RowsContext, database: string, table: string): Promise<TableMeta> {
  if (isSystemDatabase(database)) throw new MysqlRefused(`${database} is MySQL's own: the panel only reads it`);
  if (ctx.kept().some((k) => k.name === database)) throw new MysqlRefused(`${database} is kept for a site to put back: the panel only reads it`);
  const site = siteDatabases(ctx.config).find((s) => s.db === database);
  if (site && ctx.siteBusy(`${site.domain}${site.path ?? ''}`)) throw new MysqlRefused(`${site.domain}${site.path ?? ''} is busy with a job: wait until it finishes`);
  let meta: TableMeta;
  try {
    meta = await tableMeta(browse(ctx), database, table);
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
  if (meta.table.view) throw new MysqlRefused(`${table} is a view: change the table it reads from`);
  if (meta.primaryKey.length === 0) throw new MysqlRefused(`${table} has no primary key, so a row cannot be found again safely: change it in phpMyAdmin`);
  return meta;
}

const tableRef = (database: string, table: string) => `${ident(database)}.${ident(table)}`;

/** A saved or given value as SQL: NULL, bytes from hex for a binary column, else as the column takes it. */
function valueSql(column: ColumnMeta, value: string | null, hex: boolean): string {
  if (value === null) return 'NULL';
  if (hex) {
    if (!/^(?:[0-9A-Fa-f]{2})*$/.test(value)) throw new MysqlRefused(`${column.name} is binary: its value comes as hex`);
    return `X'${value}'`;
  }
  try {
    return literalFor(column, value);
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
}

/**
 * The column holds this value (NULL included). A key compares as the column
 * does, to use its index; any other number compares as the text MySQL showed,
 * since a FLOAT is never equal to the decimal written for it.
 */
function holds(column: ColumnMeta, value: string | null, hex: boolean, key = false): string {
  if (value === null) return `${ident(column.name)} IS NULL`;
  if (!key && isNumeric(column)) return `CAST(${ident(column.name)} AS CHAR) = ${textLiteral(value)}`;
  return `${ident(column.name)} <=> ${valueSql(column, value, hex)}`;
}

/** A column MySQL computes itself (VIRTUAL or STORED GENERATED): never written. */
const generated = (c: ColumnMeta) => /GENERATED/i.test(c.extra);

function keyWhere(meta: TableMeta, key: readonly string[]): string {
  if (key.length !== meta.primaryKey.length) throw new MysqlRefused(`The primary key has ${meta.primaryKey.length} columns, not ${key.length}`);
  return meta.primaryKey.map((k, i) => holds(k, key[i] as string, isBinary(k), true)).join(' AND ');
}

/** Every column in full: binary as hex, the rest as text. */
const fullRow = (meta: TableMeta) => `JSON_ARRAY(${meta.columns.map((c) => (isBinary(c) ? `HEX(${ident(c.name)})` : `CAST(${ident(c.name)} AS CHAR)`)).join(', ')})`;

function toSaved(meta: TableMeta, line: string): SavedRow {
  const values = parseJson(line);
  return Object.fromEntries(meta.columns.map((c, i) => [c.name, values[i] === null || values[i] === undefined ? null : String(values[i])]));
}

function columnsOf(meta: TableMeta, values: Record<string, unknown>): ColumnMeta[] {
  return Object.keys(values).map((name) => {
    const column = meta.columns.find((c) => c.name === name);
    if (!column) throw new MysqlRefused(`No column called ${name} in this table`);
    return column;
  });
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** Saves the copy Undo needs, 0600 in a 0700 folder, and lets copies older than 14 days go. */
function saveChange(ctx: RowsContext, change: Omit<RowChange, 'savedAt'>): string {
  const now = ctx.now?.() ?? new Date();
  const dir = rowChangesDir(ctx.config);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneRowChanges(dir, now.getTime());
  const id = `${stamp(now)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...change, savedAt: now.toISOString() }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return id;
}

export function pruneRowChanges(dir: string, now = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > ROW_CHANGE_DAYS * 86_400_000) {
        rmSync(file, { force: true });
        gone.push(name);
      }
    } catch {
      // Gone already.
    }
  }
  return gone;
}

function readChange(config: SystemConfig, id: string): RowChange {
  if (!rowChangeId.safeParse(id).success) throw new MysqlRefused('A row change like 20261107-101500-a1b2c3');
  const file = join(rowChangesDir(config), `${id}.json`);
  if (!existsSync(file)) throw new MysqlRefused('That change is not saved any more: copies go after 14 days, and after their Undo');
  return JSON.parse(readFileSync(file, 'utf8')) as RowChange;
}

/** The changes saved for a table, newest first, without their values. */
export function listRowChanges(config: SystemConfig, database: string, table?: string): RowChangeInfo[] {
  const dir = rowChangesDir(config);
  if (!existsSync(dir)) return [];
  const out: RowChangeInfo[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      const c = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RowChange;
      if (c.database !== database || (table !== undefined && c.table !== table)) continue;
      const savedAt = c.savedAt;
      out.push({ id: name.slice(0, -5), kind: c.kind, table: c.table, rows: c.rows.length, savedAt, purgeAt: new Date(Date.parse(savedAt) + ROW_CHANGE_DAYS * 86_400_000).toISOString() });
    } catch {
      // A copy that does not read is left for the prune.
    }
  }
  return out;
}

const ok = (stdout: string, change?: string): ExecResult & { change?: string } => ({ code: 0, stdout, stderr: '', ...(change ? { change } : {}) });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export async function updateRow(ctx: RowsContext, { database, table, rowKey, rowValues, rowWas }: ActionInput<'mysql.updateRow'>) {
  const meta = await changeable(ctx, database, table);
  const columns = columnsOf(meta, rowValues);
  for (const c of columns) {
    if (meta.primaryKey.some((k) => k.name === c.name)) throw new MysqlRefused(`${c.name} is the primary key, which finds the row: it is not changed here`);
    if (isBinary(c)) throw new MysqlRefused(`${c.name} is binary: change it in phpMyAdmin`);
    if (generated(c)) throw new MysqlRefused(`${c.name} is computed by MySQL from other columns`);
    if (!(c.name in rowWas)) throw new MysqlRefused(`The value ${c.name} had is missing, so a change made since could not be seen`);
  }
  const ref = tableRef(database, table);
  const where = `${keyWhere(meta, rowKey)} AND ${columns.map((c) => holds(c, rowWas[c.name] ?? null, false)).join(' AND ')}`;
  const lines = await write(
    ctx,
    'START TRANSACTION;\n' +
      `SELECT ${fullRow(meta)} FROM ${ref} WHERE ${where} FOR UPDATE;\n` +
      `UPDATE ${ref} SET ${columns.map((c) => `${ident(c.name)} = ${valueSql(c, rowValues[c.name] ?? null, false)}`).join(', ')} WHERE ${where};\n` +
      'COMMIT;\n',
  );
  if (lines.length === 0) throw new MysqlRefused('The row changed since you opened it, or is gone: nothing was changed. Open it again to see it as it is now');
  const id = saveChange(ctx, { kind: 'update', database, table, primaryKey: meta.primaryKey.map((k) => k.name), binary: meta.columns.filter(isBinary).map((c) => c.name), rows: [toSaved(meta, lines[0] as string)], set: rowValues });
  return ok(`changed ${plural(columns.length, 'column')} of a row of ${table}; Undo puts it back`, id);
}

export async function insertRow(ctx: RowsContext, { database, table, rowValues }: ActionInput<'mysql.insertRow'>) {
  const meta = await changeable(ctx, database, table);
  const columns = columnsOf(meta, rowValues);
  for (const c of columns) {
    if (isBinary(c)) throw new MysqlRefused(`${c.name} is binary: set it in phpMyAdmin`);
    if (generated(c)) throw new MysqlRefused(`${c.name} is computed by MySQL from other columns`);
  }
  const ref = tableRef(database, table);
  // The new row's key: the values given, or the auto_increment number MySQL picked.
  const auto = meta.primaryKey.find((k) => !(k.name in rowValues));
  if (auto && (meta.primaryKey.length > 1 || !auto.extra.includes('auto_increment'))) throw new MysqlRefused(`Give ${auto.name}: it is part of the primary key and has no automatic number`);
  const keyOf = meta.primaryKey.map((k) => (k.name in rowValues ? holds(k, rowValues[k.name] ?? null, false, true) : `${ident(k.name)} = LAST_INSERT_ID()`)).join(' AND ');
  const lines = await write(
    ctx,
    'START TRANSACTION;\n' +
      `INSERT INTO ${ref} (${columns.map((c) => ident(c.name)).join(', ')}) VALUES (${columns.map((c) => valueSql(c, rowValues[c.name] ?? null, false)).join(', ')});\n` +
      `SELECT ${fullRow(meta)} FROM ${ref} WHERE ${keyOf};\n` +
      'COMMIT;\n',
  );
  if (!lines[0]) throw new MysqlRefused('MySQL added the row but it could not be read back');
  const row = toSaved(meta, lines[0]);
  const id = saveChange(ctx, { kind: 'insert', database, table, primaryKey: meta.primaryKey.map((k) => k.name), binary: meta.columns.filter(isBinary).map((c) => c.name), rows: [row] });
  return ok(`added a row to ${table}; Undo deletes it`, id);
}

export async function deleteRows(ctx: RowsContext, { database, table, rowKeys }: ActionInput<'mysql.deleteRows'>) {
  const meta = await changeable(ctx, database, table);
  const ref = tableRef(database, table);
  const where = rowKeys.map((k) => `(${keyWhere(meta, k)})`).join(' OR ');
  const lines = await write(ctx, `START TRANSACTION;\nSELECT ${fullRow(meta)} FROM ${ref} WHERE ${where} FOR UPDATE;\nDELETE FROM ${ref} WHERE ${where};\nCOMMIT;\n`);
  if (lines.length === 0) throw new MysqlRefused('Those rows are gone already: nothing was deleted');
  const rows = lines.map((l) => toSaved(meta, l));
  const id = saveChange(ctx, { kind: 'delete', database, table, primaryKey: meta.primaryKey.map((k) => k.name), binary: meta.columns.filter(isBinary).map((c) => c.name), rows });
  const missing = rowKeys.length - rows.length;
  return ok(`deleted ${plural(rows.length, 'row')} of ${table}${missing ? ` (${plural(missing, 'row')} had gone already)` : ''}; Undo puts them back`, id);
}

/** Puts back what a saved change changed, while the rows still hold what it left; the copy goes once it is undone. */
export async function undoRowChange(ctx: RowsContext, { database, table, change }: ActionInput<'mysql.undoRowChange'>) {
  const saved = readChange(ctx.config, change);
  if (saved.database !== database || saved.table !== table) throw new MysqlRefused(`That change was to ${saved.database}.${saved.table}`);
  const meta = await changeable(ctx, database, table);
  const ref = tableRef(database, table);
  const hex = new Set(saved.binary);
  const col = (name: string) => {
    const c = meta.columns.find((x) => x.name === name);
    if (!c) throw new MysqlRefused(`${table} has no column ${name} any more: the change cannot be undone`);
    return c;
  };
  const keyOf = (row: SavedRow) => saved.primaryKey.map((k) => holds(col(k), row[k] ?? null, hex.has(k), true)).join(' AND ');
  let sql: string;
  if (saved.kind === 'update') {
    const before = saved.rows[0] as SavedRow;
    const set = saved.set ?? {};
    const names = Object.keys(set);
    const where = `${keyOf(before)} AND ${names.map((n) => holds(col(n), set[n] ?? null, false)).join(' AND ')}`;
    sql = `SELECT COUNT(*) FROM ${ref} WHERE ${where} FOR UPDATE;\nUPDATE ${ref} SET ${names.map((n) => `${ident(n)} = ${valueSql(col(n), before[n] ?? null, false)}`).join(', ')} WHERE ${where};\n`;
  } else if (saved.kind === 'insert') {
    const row = saved.rows[0] as SavedRow;
    sql = `SELECT COUNT(*) FROM ${ref} WHERE ${keyOf(row)} FOR UPDATE;\nDELETE FROM ${ref} WHERE ${keyOf(row)};\n`;
  } else {
    const names = Object.keys(saved.rows[0] ?? {}).filter((n) => !generated(col(n)));
    const values = saved.rows.map((row) => `(${names.map((n) => valueSql(col(n), row[n] ?? null, hex.has(n))).join(', ')})`);
    sql = `SELECT ${saved.rows.length};\nINSERT INTO ${ref} (${names.map(ident).join(', ')}) VALUES ${values.join(', ')};\n`;
  }
  const lines = await write(ctx, `START TRANSACTION;\n${sql}COMMIT;\n`);
  if (saved.kind !== 'delete' && lines[0] === '0') {
    throw new MysqlRefused(saved.kind === 'update' ? 'The row changed again since, or is gone: nothing was undone' : 'The row added is gone already: nothing to undo');
  }
  rmSync(join(rowChangesDir(ctx.config), `${change}.json`), { force: true });
  return ok(saved.kind === 'update' ? `put a row of ${table} back as it was` : saved.kind === 'insert' ? `deleted the row added to ${table}` : `put back ${plural(saved.rows.length, 'row')} of ${table}`);
}

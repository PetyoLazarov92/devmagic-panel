import type { DbCell, DbColumnHead, DbFilter, DbRow, DbRowsRequest } from '@devmagic-panel/shared';
import { DB_CELL_HEAD } from '@devmagic-panel/shared';

/**
 * The SQL the database browser sends, built in one place. Nothing from a
 * request is pasted into it as text:
 *
 * - a table or column name is used only once MySQL listed it for that
 *   database, and then in backticks (ident);
 * - a value goes as a hex literal of its UTF-8 bytes, converted to the
 *   column's character set and collation, so no quote or backslash in it can
 *   end the literal; a number only once it reads as one.
 */
export class BrowseError extends Error {
  constructor(
    message: string,
    /** The HTTP status the route answers with. */
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A column as information_schema.COLUMNS describes it. */
export interface ColumnMeta {
  name: string;
  /** COLUMN_TYPE, like varchar(191) or bigint(20) unsigned. */
  type: string;
  /** DATA_TYPE, lowercase, like varchar or bigint. */
  dataType: string;
  nullable: boolean;
  default: string | null;
  key: string;
  extra: string;
  charset?: string;
  collation?: string;
  comment?: string;
}

const BINARY_TYPES = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection',
]);
const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);

export const isBinary = (c: ColumnMeta) => BINARY_TYPES.has(c.dataType) || c.charset === 'binary';
export const isNumeric = (c: ColumnMeta) => NUMERIC_TYPES.has(c.dataType);
export const columnHead = (c: ColumnMeta): DbColumnHead => ({
  name: c.name,
  type: c.type,
  binary: isBinary(c),
  numeric: isNumeric(c),
  ...(c.nullable ? { nullable: true } : {}),
  ...(/auto_increment/i.test(c.extra) ? { autoIncrement: true } : {}),
  ...(/GENERATED/i.test(c.extra) ? { generated: true } : {}),
});

/** A name in backticks, a backtick in it doubled. Only for names MySQL listed. */
export const ident = (name: string) => `\`${name.replaceAll('`', '``')}\``;

/** Text as a hex literal of its UTF-8 bytes: nothing in it can end the literal. */
export const textLiteral = (value: string) => `_utf8mb4 X'${Buffer.from(value, 'utf8').toString('hex')}'`;

/** Bytes as a hex literal, for binary columns. */
const bytesLiteral = (value: string) => `X'${Buffer.from(value, 'utf8').toString('hex')}'`;

const NUMBER = /^-?\d{1,40}(?:\.\d{1,40})?(?:[eE][-+]?\d{1,3})?$/;
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Text in the column's own character set and collation, so a comparison
 * with a column of another collation (utf8mb4_unicode_520_ci next to the
 * connection's utf8mb4_0900_ai_ci) is not refused as an illegal mix.
 */
function textFor(column: ColumnMeta, value: string): string {
  const { charset, collation } = column;
  if (charset && collation && SAFE_NAME.test(charset) && SAFE_NAME.test(collation)) return `CONVERT(${textLiteral(value)} USING ${charset}) COLLATE ${collation}`;
  return textLiteral(value);
}

/** A value to compare the column with: a number, bytes or text, by the column's type. */
export function literalFor(column: ColumnMeta, value: string): string {
  if (isNumeric(column)) {
    const trimmed = value.trim();
    if (!NUMBER.test(trimmed)) throw new BrowseError(`${column.name} holds numbers: "${value.slice(0, 40)}" is not one`);
    return trimmed;
  }
  if (isBinary(column)) return bytesLiteral(value);
  return textFor(column, value);
}

/** % and _ match anything in LIKE; a value searched for as it is escapes them. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The column as text for LIKE: numbers, dates and JSON are cast first. */
const asText = (column: ColumnMeta) => (isBinary(column) || column.charset ? ident(column.name) : `CAST(${ident(column.name)} AS CHAR)`);

function likeFor(column: ColumnMeta, pattern: string): string {
  if (isBinary(column)) return `${ident(column.name)} LIKE ${bytesLiteral(pattern)}`;
  return `${asText(column)} LIKE ${column.charset ? textFor(column, pattern) : textLiteral(pattern)}`;
}

/** Finds a column the request names among the ones MySQL listed; anything else is refused. */
export function columnNamed(columns: readonly ColumnMeta[], name: string): ColumnMeta {
  const found = columns.find((c) => c.name === name);
  if (!found) throw new BrowseError(`No column called ${name} in this table`);
  return found;
}

function condition(columns: readonly ColumnMeta[], filter: DbFilter): string {
  const column = columnNamed(columns, filter.column);
  const name = ident(column.name);
  if (filter.op === 'isNull') return `${name} IS NULL`;
  if (filter.op === 'notNull') return `${name} IS NOT NULL`;
  const value = filter.value ?? '';
  switch (filter.op) {
    case 'eq':
      return `${name} = ${literalFor(column, value)}`;
    case 'ne':
      return `${name} <> ${literalFor(column, value)}`;
    case 'gt':
      return `${name} > ${literalFor(column, value)}`;
    case 'lt':
      return `${name} < ${literalFor(column, value)}`;
    case 'contains':
      return likeFor(column, `%${escapeLike(value)}%`);
    case 'startsWith':
      return likeFor(column, `${escapeLike(value)}%`);
  }
}

/** Filters as a WHERE clause: every one (AND), or any one (OR), each in its own parentheses. */
export function whereSql(columns: readonly ColumnMeta[], filters: readonly DbFilter[], match: 'all' | 'any' = 'all'): string {
  if (!filters.length) return '';
  const parts = filters.map((f) => condition(columns, f));
  return ` WHERE ${parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(match === 'any' ? ' OR ' : ' AND ')}`;
}

const tableRef = (database: string, table: string) => `${ident(database)}.${ident(table)}`;

/** Per column a short head and its full length; then the primary key's full values. */
function selectList(columns: readonly ColumnMeta[], primaryKey: readonly ColumnMeta[]): string {
  const cells = columns.map((c) =>
    isBinary(c)
      ? `HEX(LEFT(${ident(c.name)}, ${DB_CELL_HEAD / 2})), LENGTH(${ident(c.name)})`
      : `LEFT(CAST(${ident(c.name)} AS CHAR), ${DB_CELL_HEAD}), CHAR_LENGTH(CAST(${ident(c.name)} AS CHAR))`,
  );
  const keys = primaryKey.map((c) => (isBinary(c) ? `HEX(${ident(c.name)})` : `CAST(${ident(c.name)} AS CHAR)`));
  return [...cells, ...keys].join(', ');
}

export type RowsRequest = DbRowsRequest;

/**
 * One page of rows, one JSON array a line, and one more row than the page
 * holds, to tell whether another page follows; and the count of rows that
 * match, as its own statement.
 */
export function rowsSql(database: string, table: string, columns: readonly ColumnMeta[], primaryKey: readonly ColumnMeta[], request: RowsRequest): { rows: string; count: string } {
  const where = whereSql(columns, request.filters, request.match);
  const order: string[] = [];
  if (request.sort) order.push(`${ident(columnNamed(columns, request.sort.column).name)} ${request.sort.dir === 'desc' ? 'DESC' : 'ASC'}`);
  // The primary key keeps pages in a stable order when the sort has ties.
  for (const k of primaryKey) if (k.name !== request.sort?.column) order.push(`${ident(k.name)} ASC`);
  const orderBy = order.length ? ` ORDER BY ${order.join(', ')}` : '';
  const offset = (request.page - 1) * request.pageSize;
  return {
    rows: `SELECT JSON_ARRAY(${selectList(columns, primaryKey)}) FROM ${tableRef(database, table)}${where}${orderBy} LIMIT ${request.pageSize + 1} OFFSET ${offset};\n`,
    count: `SELECT COUNT(*) FROM ${tableRef(database, table)}${where};\n`,
  };
}

/** The most of one value the full view shows. */
export const CELL_TEXT_MAX = 1_000_000;
export const CELL_BINARY_MAX = 65_536;

/** One value in full (up to CELL_TEXT_MAX characters), found by the row's primary key. */
export function cellSql(database: string, table: string, column: ColumnMeta, primaryKey: readonly ColumnMeta[], key: readonly string[]): string {
  if (primaryKey.length === 0) throw new BrowseError('This table has no primary key, so a row cannot be found again: open it in phpMyAdmin');
  if (key.length !== primaryKey.length) throw new BrowseError(`The primary key has ${primaryKey.length} columns, not ${key.length}`);
  const where = primaryKey
    .map((k, i) => {
      const value = key[i] as string;
      if (isBinary(k)) {
        if (!/^(?:[0-9A-Fa-f]{2})*$/.test(value)) throw new BrowseError(`${k.name} is binary: its key comes as hex`);
        return `${ident(k.name)} = X'${value}'`;
      }
      return `${ident(k.name)} = ${literalFor(k, value)}`;
    })
    .join(' AND ');
  const value = isBinary(column)
    ? `HEX(LEFT(${ident(column.name)}, ${CELL_BINARY_MAX})), LENGTH(${ident(column.name)})`
    : `LEFT(CAST(${ident(column.name)} AS CHAR), ${CELL_TEXT_MAX}), CHAR_LENGTH(CAST(${ident(column.name)} AS CHAR))`;
  return `SELECT JSON_ARRAY(${value}) FROM ${tableRef(database, table)} WHERE ${where} LIMIT 1;\n`;
}

/** A head and its full length as one cell: the head alone when it is all of it. */
export function toCell(head: unknown, length: unknown, binary: boolean): DbCell {
  if (head === null || head === undefined) return null;
  const text = String(head);
  const full = typeof length === 'number' ? length : Number(length);
  if (binary) return { head: text.toLowerCase(), length: Number.isFinite(full) ? full : text.length / 2, binary: true };
  // CHAR_LENGTH counts characters, as Array.from does; String.length counts UTF-16 units.
  return Number.isFinite(full) && full > Array.from(text).length ? { head: text, length: full } : text;
}

/** The rows a rowsSql query printed, one JSON array a line. */
export function parseRows(lines: readonly string[], columns: readonly ColumnMeta[], primaryKey: readonly ColumnMeta[]): DbRow[] {
  return lines.map((line) => {
    let values: unknown[];
    try {
      values = JSON.parse(line) as unknown[];
    } catch {
      throw new BrowseError('MySQL answered with a row the panel cannot read', 502);
    }
    if (!Array.isArray(values) || values.length !== columns.length * 2 + primaryKey.length) throw new BrowseError('MySQL answered with a row of another shape', 502);
    const cells = columns.map((c, i) => toCell(values[i * 2], values[i * 2 + 1], isBinary(c)));
    const key = primaryKey.map((_, i) => String(values[columns.length * 2 + i] ?? ''));
    return key.length ? { cells, key } : { cells };
  });
}

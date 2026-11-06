import { z } from 'zod';
import type { MysqlDatabaseKind, MysqlSiteRef } from './mysql.js';

/**
 * A table or column name as the browser receives it. It reaches SQL only once
 * MySQL listed it for that database (an allow-list), and then in backticks.
 */
export const mysqlIdentifier = z.string().regex(/^[^`/\\\x00-\x1f]{1,64}$/, 'A table or column name like wp_options');

export const DB_PAGE_SIZES = [25, 50, 100, 250] as const;
export type DbPageSize = (typeof DB_PAGE_SIZES)[number];

/** How a filter compares a column with its value; isNull and notNull take none. */
export const DB_FILTER_OPS = ['eq', 'ne', 'contains', 'startsWith', 'gt', 'lt', 'isNull', 'notNull'] as const;
export type DbFilterOp = (typeof DB_FILTER_OPS)[number];
export const DB_FILTER_LABELS: Record<DbFilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  startsWith: 'starts with',
  gt: 'is more than',
  lt: 'is less than',
  isNull: 'is NULL',
  notNull: 'is not NULL',
};

export const dbFilter = z.object({
  column: mysqlIdentifier,
  op: z.enum(DB_FILTER_OPS),
  value: z.string().max(1000).optional(),
});
export type DbFilter = z.infer<typeof dbFilter>;

/** One page of a table's rows: sent in a POST body, since a filter's value can be data that must not reach a URL or a log. */
export const dbRowsQuery = z.object({
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(250)]).default(50),
  sort: z.object({ column: mysqlIdentifier, dir: z.enum(['asc', 'desc']) }).optional(),
  filters: z.array(dbFilter).max(10).default([]),
});
export type DbRowsQuery = z.input<typeof dbRowsQuery>;
/** A rows query once the server filled in its defaults. */
export type DbRowsRequest = z.output<typeof dbRowsQuery>;

/** One full value, found by the row's primary key as the rows page gave it. */
export const dbCellQuery = z.object({
  column: mysqlIdentifier,
  key: z.array(z.string().max(4096)).min(1).max(16),
});
export type DbCellQuery = z.infer<typeof dbCellQuery>;

export interface DbTable {
  name: string;
  /** A view has no engine, sizes or rows of its own. */
  view: boolean;
  engine?: string;
  /** MySQL's estimate for InnoDB, exact for MyISAM. */
  rows: number;
  dataBytes: number;
  indexBytes: number;
  /** Space OPTIMIZE TABLE would give back. */
  freeBytes: number;
  collation?: string;
  updatedAt?: string;
}

/** A database as the browser shows it: its tables, what it is to the panel, and where phpMyAdmin opens it. */
export interface DbOverview {
  database: string;
  kind: MysqlDatabaseKind;
  /** The sites whose wp-config.php names it, with their table prefix, or the site a kept database belongs to. */
  sites: Array<MysqlSiteRef & { prefix?: string }>;
  tables: DbTable[];
  totalBytes: number;
  /** phpMyAdmin's address on a site Apache serves, when phpMyAdmin is installed. */
  phpMyAdmin?: string;
  checkedAt: string;
}

export interface DbColumn {
  name: string;
  /** The full type, like varchar(191) or bigint(20) unsigned. */
  type: string;
  nullable: boolean;
  /** Null when the column has no default; a string NULL is a default of NULL. */
  default: string | null;
  /** PRI, UNI or MUL. */
  key: string;
  /** auto_increment, on update CURRENT_TIMESTAMP and the like. */
  extra: string;
  collation?: string;
  comment?: string;
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
  /** BTREE, FULLTEXT, SPATIAL or HASH. */
  type: string;
  cardinality?: number;
}

export interface DbStructure {
  database: string;
  table: DbTable;
  columns: DbColumn[];
  indexes: DbIndex[];
  primaryKey: string[];
  createSql: string;
  /** What deserves a look, in a sentence each: no primary key, MyISAM, an old character set. */
  warnings: string[];
}

/** A column as the rows page shows it. */
export interface DbColumnHead {
  name: string;
  type: string;
  /** Shown as hex, filtered on its bytes. */
  binary: boolean;
  /** Filtered as a number. */
  numeric: boolean;
}

/** A value cut short, with its full length: characters for text, bytes for binary (head is then hex). */
export interface DbLongCell {
  head: string;
  length: number;
  binary?: true;
}

export type DbCell = null | string | DbLongCell;

export interface DbRow {
  cells: DbCell[];
  /** The primary key's values, for opening a full value; absent when the table has none. */
  key?: string[];
}

export interface DbRowsPage {
  database: string;
  table: string;
  columns: DbColumnHead[];
  primaryKey: string[];
  rows: DbRow[];
  page: number;
  pageSize: number;
  /** Rows that match, or null when counting them took too long. */
  total: number | null;
  /** False when total is MySQL's estimate. */
  totalExact: boolean;
  hasMore: boolean;
}

export interface DbCellValue {
  value: DbCell;
  /** True when even the full view was cut (over a megabyte of text, 64 KB of binary). */
  cut: boolean;
}

/** The longest a cell is on a page: the rest opens on its own. */
export const DB_CELL_HEAD = 300;

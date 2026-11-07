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

export const WP_CONTENT_KINDS = [
  'revisions',
  'autoDrafts',
  'trashedPosts',
  'spamComments',
  'trashedComments',
  'oembed',
  'akismet',
  'actionsDone',
  'wcSessions',
  'sessionTokens',
  'duplicateMeta',
] as const;
/** Keep the newest this many revisions of each post: the choices the WordPress view offers. */
export const WP_KEEP_REVISIONS = [1, 3, 5, 10] as const;
export const WP_ORPHAN_KINDS = ['postmeta', 'commentmeta', 'termmeta', 'termRelationships', 'usermeta'] as const;


/** The clean-up kinds whose rows the Tables view can show, with transients (expired, or all). */
export const WP_CLEANUP_VIEWS = [...WP_CONTENT_KINDS, ...WP_ORPHAN_KINDS, 'expiredTransients', 'transients'] as const;
export type WpCleanupView = (typeof WP_CLEANUP_VIEWS)[number];

/**
 * Only the rows a clean-up of the WordPress view counts: named by its kind,
 * never by SQL. The server builds the condition with the code the clean-up
 * runs, for the site named, and refuses a table the kind does not count.
 */
export const dbCleanupView = z.object({
  domain: z.string().min(1).max(253),
  path: z.string().max(200).optional(),
  blog: z.number().int().min(1).max(1_000_000).optional(),
  kind: z.enum(WP_CLEANUP_VIEWS),
  keepRevisions: z.number().int().refine((n) => (WP_KEEP_REVISIONS as readonly number[]).includes(n), 'Keep 1, 3, 5 or 10 revisions').optional(),
});
export type DbCleanupView = z.infer<typeof dbCleanupView>;

/** One page of a table's rows: sent in a POST body, since a filter's value can be data that must not reach a URL or a log. */
export const dbRowsQuery = z.object({
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(250)]).default(50),
  sort: z.object({ column: mysqlIdentifier, dir: z.enum(['asc', 'desc']) }).optional(),
  filters: z.array(dbFilter).max(10).default([]),
  /** all: a row matches every filter (AND); any: at least one (OR). */
  match: z.enum(['all', 'any']).default('all'),
  /** Only the rows a clean-up would take, ANDed with the filters. */
  cleanup: dbCleanupView.optional(),
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
  /** It takes NULL. */
  nullable?: boolean;
  /** MySQL numbers it (auto_increment): left out when a row is added. */
  autoIncrement?: boolean;
  /** MySQL computes it from other columns: never written. */
  generated?: boolean;
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

/** WordPress keeps an option in memory on every page when autoload is one of these (6.6 added on, auto and auto-on). */
export const WP_AUTOLOAD_VALUES = ['yes', 'on', 'auto-on', 'auto'] as const;
/** Site Health warns above this many bytes of autoloaded options. */
export const WP_AUTOLOAD_LIMIT = 800_000;

/** A site of a network, by the table prefix its tables use. */
export interface WpDbBlog {
  id: number;
  domain: string;
  path: string;
  prefix: string;
  /** Archived, spam or deleted in wp_blogs. */
  inactive?: boolean;
}

export interface WpDbUser {
  id: string;
  login: string;
  email: string;
  registered: string;
  /** The roles on the site the report is about. */
  roles: string[];
}

/** The parts of the WordPress view, each read on its own. */
export const WP_DB_SECTIONS = ['health', 'autoload', 'plugins', 'growth', 'transients', 'users', 'content', 'orphans', 'metaKeys', 'postTypes', 'duplicates'] as const;
export type WpDbSection = (typeof WP_DB_SECTIONS)[number];
/** The parts that read whole tables (posts, every meta table): asked for one at a time, after the rest, with more time. */
export const WP_DB_SLOW_SECTIONS: readonly WpDbSection[] = ['content', 'orphans', 'metaKeys', 'postTypes'];
/** Parts that read every row of a big table: only when you ask (Look for duplicates), never with the rest. */
export const WP_DB_ON_DEMAND: readonly WpDbSection[] = ['duplicates'];
/** Above this many rows in postmeta (MySQL's estimate) the keys are counted first, and their sizes only on request. */
export const WP_META_SIZE_ROWS = 300_000;

/**
 * What a clean-up would find: WordPress's own (revisions, drafts, trash, spam)
 * and what plugins leave (oEmbed caches, Akismet's history, Action Scheduler's
 * finished actions, expired WooCommerce sessions, login sessions). A count is
 * there only when the site has its table.
 */
export interface WpDbContent {
  revisions: number;
  /** Revisions beyond the newest N of each post, for N in WP_KEEP_REVISIONS. */
  revisionsOver?: Partial<Record<(typeof WP_KEEP_REVISIONS)[number], number>>;
  autoDrafts: number;
  trashedPosts: number;
  spamComments: number;
  trashedComments: number;
  oembed?: number;
  akismet?: number;
  /** Finished, failed and cancelled actions, and the logs that go with them. */
  actionsDone?: number;
  actionLogs?: number;
  wcSessions?: number;
  /** Users with saved login sessions: deleting them signs everyone out. */
  sessionTokens?: number;
}

/**
 * Whether the plugin a table or an option belongs to is on, off (installed),
 * gone from the plugins folder, or not known: the panel guesses it from the
 * name, so it is a hint, never a reason to delete on its own.
 */
export type WpPluginState = 'active' | 'inactive' | 'missing' | 'unknown';

export interface WpDbPluginTable {
  table: string;
  bytes: number;
  rows: number;
  /** What it likely belongs to (a plugin, a theme, a must-use plugin) and its folder. */
  plugin?: string;
  slug?: string;
  /** A theme or a must-use plugin; a plugin when left out. */
  kind?: 'theme' | 'muPlugin';
  /** How the owner was found: its name in the site's PHP code, or the table's name alone. */
  by?: 'code' | 'name';
  /** For a table nothing is known by name: the site's code was searched, and nothing in it names the table. */
  unused?: boolean;
  state: WpPluginState;
}

/** Autoloaded options that likely belong to a plugin that is off or gone. */
export interface WpDbPluginOptions {
  plugin: string;
  slug: string;
  state: 'inactive' | 'missing';
  count: number;
  bytes: number;
  /** Their names, the biggest first, at most 200. */
  options: string[];
}

/** The tables that are not WordPress's own, and autoload of plugins that are off: both guesses by name. */
export interface WpDbPlugins {
  tables: WpDbPluginTable[];
  autoload: WpDbPluginOptions[];
}

/** What the panel can fix in a WordPress table, each as a job that saves the table first. */
export const WP_TABLE_FIXES = ['keys', 'index', 'engine', 'charset'] as const;
export type WpTableFix = (typeof WP_TABLE_FIXES)[number];

/**
 * A WordPress table that differs from how WordPress makes it: a lost primary
 * key or AUTO_INCREMENT (a bad import's mark: new posts get ID 0), a missing
 * index, MyISAM, or an old character set.
 */
export interface WpDbHealthIssue {
  table: string;
  problem: 'noPrimaryKey' | 'noAutoIncrement' | 'missingIndex' | 'notUnique' | 'engine' | 'utf8mb3' | 'charset';
  /** What is wrong, in a sentence. */
  text: string;
  /** The fix the panel can make; none when a person has to look (latin1 text, an index name in use). */
  fix?: WpTableFix;
  /** Why the fix cannot run yet, like duplicate IDs: the rows to sort out first. */
  blocked?: string;
}

export interface WpDbHealth {
  /** The WordPress tables checked. */
  tables: number;
  issues: WpDbHealthIssue[];
  /** The site's tables with space a rebuild gives back, like after a clean-up: OPTIMIZE TABLE frees it. */
  free?: Array<{ table: string; freeBytes: number; bytes: number }>;
  /** The site's MyISAM tables of every kind, the smallest first, for Turn all into InnoDB. */
  myisam?: Array<{ table: string; bytes: number }>;
}

/** The postmeta keys with the most rows or bytes; bytes only when the sizes were read. */
export interface WpDbMetaKeys {
  /** MySQL's estimate of the rows in postmeta. */
  estimatedRows: number;
  /** True when every value was read for its size; the keys are then in order of size, else of rows. */
  sized: boolean;
  keys: Array<{ key: string; count: number; bytes?: number }>;
}

/**
 * What a WordPress database holds beyond its tables, for one site (on a
 * network, one of its sites). Each section is read on its own; one MySQL
 * stopped for taking too long is null, with why in errors. A section left
 * out of the request (undefined) was not read in this answer.
 */
export interface WpDbReport {
  database: string;
  /** The table prefix from wp-config.php. */
  prefix: string;
  /** The site of the network the report is about, 1 for a single site. */
  blog: number;
  /** The prefix that site's tables use: wp_ for the first, wp_2_ for the second. */
  blogPrefix: string;
  network?: WpDbBlog[];
  /** Core tables this site lacks. */
  missingTables: string[];
  health?: WpDbHealth | null;
  plugins?: WpDbPlugins | null;
  /** Posts of types no plugin or theme registers now (WP-CLI's list against the posts table): WordPress no longer shows them. */
  postTypes?: { unregistered: Array<{ type: string; count: number }> } | null;
  /** The tables that grew most since the oldest size the panel noted (once a day, when this view opens, kept 30 days). */
  growth?: { since: string; days: number; tables: Array<{ table: string; bytes: number; grewBytes: number }> } | null;
  autoload?: { count: number; bytes: number; limitBytes: number; top: Array<{ name: string; bytes: number }> } | null;
  transients?: { count: number; bytes: number; expired: number; site?: { count: number; bytes: number; expired: number } } | null;
  content?: WpDbContent | null;
  /** Post meta that repeats the same key and value on a post, found by Look for duplicates. */
  duplicates?: { rows: number; keys: Array<{ key: string; rows: number }> } | null;
  orphans?: { postmeta: number; commentmeta: number; termmeta: number; termRelationships: number; usermeta?: number } | null;
  metaKeys?: WpDbMetaKeys | null;
  users?: { count: number; list: WpDbUser[] } | null;
  errors: Partial<Record<WpDbSection, string>>;
  checkedAt: string;
  /** When each part was read, for a report the panel kept from an earlier visit. */
  readAt?: Partial<Record<WpDbSection, string>>;
}

/** One statement for the SQL runner; explain asks MySQL how it would run it instead. */
export const dbQuery = z.object({
  sql: z.string().max(100_000, 'A statement under 100,000 characters'),
  explain: z.boolean().optional(),
});
export type DbQuery = z.infer<typeof dbQuery>;

/** What a statement of the SQL runner read: up to 1,000 rows, NULL kept apart from the text NULL. */
export interface DbQueryResult {
  /** The statement's first word, like SELECT. */
  statement: string;
  explain: boolean;
  /** The result's column names, in order; empty when no row came back. */
  columns: string[];
  rows: Array<Array<string | null>>;
  /** More rows than the 1,000 shown. */
  hasMore: boolean;
  /** For a statement that writes: the SELECT that finds its rows, which Explain explained instead. */
  explained?: string;
  /** Why Explain has no plan to show, like an INSERT that lists its rows. */
  note?: string;
  ms: number;
}

/** A row change saved for Undo, as the table's Recent changes list shows it (no values). */
export interface RowChangeInfo {
  id: string;
  kind: 'update' | 'insert' | 'delete';
  table: string;
  rows: number;
  savedAt: string;
  purgeAt: string;
}

/** A database's tables and their columns, names only, for the SQL editor's suggestions. */
export interface DbSchema {
  database: string;
  tables: Record<string, string[]>;
}

/** A saved clean-up for Undo, as its list shows it: what it removed, never the rows. */
export interface CleanupInfo {
  id: string;
  title: string;
  kind: 'transients' | 'content' | 'orphans' | 'empty' | 'drop' | 'sql' | 'fix' | 'autoload';
  tables: Array<{ table: string; rows: number }>;
  /** The copy's size, gzipped. */
  bytes: number;
  savedAt: string;
  purgeAt: string;
}

/** One statement that writes, for the SQL runner's check before it runs. */
export const dbWrite = z.object({ sql: z.string().min(1).max(100_000, 'A statement under 100,000 characters') });

/** What a statement that writes would do, read before it runs. */
export interface WriteCheck {
  /** Its first word, like UPDATE. */
  statement: string;
  /** Rows it changes, tried in a transaction that was rolled back; null when it could not be tried. */
  rows: number | null;
  /** Why it was not tried first. */
  why?: string;
  /** The tables saved first, whole, for Undo. */
  tables: Array<{ name: string; bytes: number; view?: true }>;
  bytes: number;
  freeBytes: number;
}

/** A statement MySQL runs now, for the process list. */
export interface MysqlProcess {
  id: number;
  user: string;
  host: string;
  db?: string;
  /** Query, Sleep, Connect, Daemon and the like. */
  command: string;
  seconds: number;
  state?: string;
  /** The statement, cut at 300 characters. */
  info?: string;
}

/**
 * One kind of query and what it cost, the same query with other values
 * counted together: from MySQL's statement statistics (performance_schema,
 * MySQL 8) or grouped by the panel from the slow log (MariaDB).
 */
export interface SlowQuery {
  /** Stable for the same query shape: MySQL's digest, or a hash of the panel's grouping. */
  id: string;
  database?: string;
  /** The query with its values as ?, cut at 2000 characters. */
  text: string;
  /** One real run of it, with its values, cut at 4000 characters. It can hold data: never stored or sent to an AI. */
  sample?: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  rowsExamined: number;
  rowsSent: number;
  /** Runs that used no index, or no good one; MySQL's statistics only. */
  noIndex?: number;
  lastSeen?: string;
}

export interface SlowQueryReport {
  /** Where the numbers come from: MySQL's statement statistics, the slow log table, or nowhere yet. */
  source: 'statements' | 'slowLog' | 'none';
  /** Since when they count: the oldest first seen, or the oldest slow log entry. */
  since?: string;
  slowLog: { on: boolean; toTable: boolean; aboveSeconds: number };
  /** The heaviest first, by total time; at most 50. */
  queries: SlowQuery[];
  /** Why there is nothing to show, or what the numbers leave out. */
  note?: string;
}

/** Reads far more rows than it returns: worth an EXPLAIN for a missing index. */
export function readsTooMuch(q: Pick<SlowQuery, 'rowsExamined' | 'rowsSent' | 'count'>): boolean {
  return q.rowsExamined / Math.max(q.count, 1) >= 1000 && q.rowsExamined >= 50 * Math.max(q.rowsSent, 1);
}

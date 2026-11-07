import { z } from 'zod';

/** The databases MySQL and MariaDB keep for themselves: listed, never changed. */
export const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'] as const;

/** The accounts MySQL, MariaDB and Debian make for themselves: listed, never changed. */
export const SYSTEM_MYSQL_USERS = ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint', 'PUBLIC'] as const;

export const isSystemDatabase = (name: string) => (SYSTEM_DATABASES as readonly string[]).includes(name.toLowerCase());
export const isSystemMysqlUser = (user: string) => (SYSTEM_MYSQL_USERS as readonly string[]).includes(user);

/** A database the panel may name in SQL, always in backticks. */
export const mysqlDatabaseName = z.string().regex(/^[A-Za-z0-9_$-]{1,64}$/, 'A database name like acme_com');
/** A MySQL account, user and host, the panel may name in SQL, always in quotes. */
export const mysqlAccount = z.object({
  user: z.string().regex(/^[A-Za-z0-9_.$-]{1,32}$/, 'A user name like acme_com'),
  host: z.string().regex(/^[A-Za-z0-9_.%:-]{1,255}$/, 'A host like localhost'),
});
export type MysqlAccountRef = z.infer<typeof mysqlAccount>;

/** A file in the panel's MySQL backups: a deleted database (name-stamp.sql.gz) or deleted users (users-stamp.sql). */
export const mysqlBackupName = z.string().regex(/^(?:[A-Za-z0-9_$-]{1,64}-\d{8}-\d{6}\.sql\.gz|users-\d{8}-\d{6}\.sql)$/, 'A file of the MySQL backups');

/** What a deleted database or user left in the MySQL backups, for Undo, until it is purged. */
export interface MysqlBackup {
  /** The file name. */
  name: string;
  kind: 'database' | 'users';
  /** The database it holds, or the accounts. */
  subject: string;
  sizeBytes: number;
  savedAt: string;
  /** When housekeeping removes it. */
  purgeAt: string;
}

/** A site a database or a user belongs to, as its wp-config.php says. */
export interface MysqlSiteRef {
  domain: string;
  path?: string;
}

/**
 * What a database is to the panel: MySQL's own, a site's (its wp-config.php
 * names it), one the panel keeps a site's tables in for a few days, or one
 * no site on this machine uses (another project's, or left behind).
 */
export type MysqlDatabaseKind = 'system' | 'site' | 'kept' | 'unused';

export interface MysqlDatabase {
  name: string;
  sizeBytes: number;
  tables: number;
  kind: MysqlDatabaseKind;
  /** The sites that use it, or the site a kept database belongs to. */
  sites?: MysqlSiteRef[];
}

/**
 * What an account is to the panel: MySQL's own, the account the panel signs
 * in with, a site's (its wp-config.php names it), left behind (it has access
 * to no database that exists and no rights on the whole server), or another.
 */
export type MysqlUserKind = 'system' | 'panel' | 'site' | 'leftover' | 'other';

export interface MysqlUser {
  user: string;
  host: string;
  kind: MysqlUserKind;
  /** The databases that exist it has access to. */
  databases: string[];
  /** Databases it has access to that no longer exist. */
  missing: string[];
  /** It has rights on every database, like root. */
  global: boolean;
  sites?: MysqlSiteRef[];
}

export interface MysqlReport {
  checkedAt: string;
  /** Null when the panel has no MySQL admin account, or it cannot sign in. */
  server: { product: 'MySQL' | 'MariaDB'; version: string; account: string; datadir?: string; totalBytes: number } | null;
  databases: MysqlDatabase[];
  users: MysqlUser[];
  /** What deleted databases and users left for Undo, newest first; read even when MySQL cannot be. */
  backups: MysqlBackup[];
  /** The folder they are in. */
  backupsDir: string;
  /** Why nothing could be read. */
  error?: string;
  /** Why the accounts could not be read, when the databases could. */
  usersError?: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * The MySQL settings the MySQL page shows and keeps, with the bounds
 * dmp-root's mysql-config-write takes (DMP_MYSQL_SETTINGS in scripts/lib/mysql.sh):
 * change both together. Each changes while MySQL runs, so a change applies
 * at once with SET GLOBAL and is kept in the panel's file for the next start.
 * The redo log is innodb_redo_log_capacity on MySQL 8.0.30+ and
 * innodb_log_file_size on MariaDB 10.9+; a server shows the one it has.
 */
export const MYSQL_SETTINGS = [
  { name: 'innodb_buffer_pool_size', label: 'Buffer pool', unit: 'bytes', min: 128 * MB, max: 64 * GB, about: 'Where InnoDB keeps tables and indexes in memory. Too small for your sites, and pages read from the disk.' },
  { name: 'max_allowed_packet', label: 'Biggest packet', unit: 'bytes', min: MB, max: GB, about: 'The biggest statement or row MySQL takes: a dump with big rows needs more.' },
  { name: 'innodb_redo_log_capacity', label: 'Redo log', unit: 'bytes', min: 8 * MB, max: 16 * GB, about: 'Room for changes before InnoDB writes them to the tables: bigger makes imports faster.' },
  { name: 'innodb_log_file_size', label: 'Redo log', unit: 'bytes', min: 4 * MB, max: 8 * GB, about: 'Room for changes before InnoDB writes them to the tables: bigger makes imports faster.' },
  { name: 'max_connections', label: 'Connections', unit: 'count', min: 10, max: 2000, about: 'How many clients can connect at once.' },
  { name: 'tmp_table_size', label: 'Temp tables in memory', unit: 'bytes', min: MB, max: 4 * GB, about: 'How big a temporary table of a query can grow in memory before it goes to the disk. Sets max_heap_table_size too.' },
  { name: 'innodb_flush_log_at_trx_commit', label: 'Write to disk', unit: 'choice', min: 1, max: 2, about: 'Every commit to disk (1, safest), or once a second (2): much faster imports, and a crash of the computer can lose the last second.' },
  { name: 'slow_query_log', label: 'Slow query log', unit: 'switch', min: 0, max: 1, about: 'Notes the queries slower than the time below in MySQL\'s slow log, a file. Top queries needs no log: it reads MySQL\'s statement statistics.' },
  { name: 'long_query_time', label: 'Slow above', unit: 'seconds', min: 0, max: 60, about: 'How slow a query must be to go in the slow log. For local work, 1 second catches what matters.' },
] as const;

export type MysqlSettingName = (typeof MYSQL_SETTINGS)[number]['name'] | 'max_heap_table_size';
export const MYSQL_SETTING_NAMES = [...MYSQL_SETTINGS.map((s) => s.name), 'max_heap_table_size'] as unknown as [MysqlSettingName, ...MysqlSettingName[]];

export function mysqlSettingError(name: MysqlSettingName, value: number): string | null {
  const s = MYSQL_SETTINGS.find((x) => x.name === (name === 'max_heap_table_size' ? 'tmp_table_size' : name));
  if (!s) return `${name} is not a setting the panel keeps`;
  if (s.unit === 'seconds' ? Math.round(value * 1000) !== value * 1000 : !Number.isInteger(value)) return `${name} takes ${s.unit === 'seconds' ? 'seconds like 2 or 0.5' : 'a whole number'}`;
  if (value < s.min || value > s.max) return `${name} must be between ${s.min} and ${s.max}`;
  return null;
}

/** One setting as the MySQL page shows it. */
export interface MysqlSetting {
  name: MysqlSettingName;
  /** What MySQL runs with now. */
  value: number;
  /** What the panel's file keeps for the next start, if anything. */
  kept?: number;
  /** Set higher for an import that runs now: it goes back to the value from before when the import ends. */
  raisedFrom?: number;
  /** What the panel suggests for this computer, when it has a view. */
  suggested?: number;
  why?: string;
}

export interface MysqlSettings {
  product: 'MySQL' | 'MariaDB';
  settings: MysqlSetting[];
  /** The panel's file, or why none can be kept. */
  file: string | null;
  fileNote?: string;
}

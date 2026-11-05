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

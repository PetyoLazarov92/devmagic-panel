/**
 * Xdebug's profiles: what one request spent its time on, function by
 * function. Xdebug writes them for a version to $STATE_DIR/profiles/<version>
 * (dmp-root xdebug-enable with the profile mode); the panel lists, reads,
 * downloads and deletes them, and deletes them after PROFILE_KEEP_DAYS.
 */

export const PROFILE_KEEP_DAYS = 3;

/**
 * A profile file's name as Xdebug writes it for the panel:
 * cachegrind.out.<time>.<host><request>, maybe gzipped. The time is
 * seconds and microseconds (a dot between them since Xdebug 3.x, once an
 * underscore); the host and the request run together, with / . ? & and the
 * like turned into _ (local_acme_com_shop__p=2), so only the known sites'
 * hosts tell where one ends.
 */
export const PROFILE_NAME = /^cachegrind\.out\.(\d{1,12})[._](\d{1,6})\.([^/\0]{0,700}?)(\.gz)?$/;

/** A host or a request as Xdebug puts it in a file name: these characters become _. */
export const xdebugNamePart = (text: string) => text.replace(/[/\\.?&+: [\]]/g, '_');

export interface ProfileInfo {
  /** The PHP version whose folder it is in. */
  version: string;
  name: string;
  /** When the request ran. */
  at: string;
  /** The site's host it was for, or the start of the name when no known host matches. */
  host: string;
  /** The request as Xdebug names it: the address with / . ? & turned into _, so only roughly the URL. */
  request: string;
  bytes: number;
  /** Known once the profile was opened. */
  totalMs?: number;
  peakBytes?: number;
}

export interface ProfileFunction {
  name: string;
  /** The file it is in, or php:internal for PHP's own functions. */
  file: string;
  /** The plugin, theme, WordPress or PHP it belongs to. */
  group: string;
  calls: number;
  /** Time in it alone. */
  selfMs: number;
  /** Time in it and in everything it called. */
  totalMs: number;
  /** Who calls it most, at most 5. */
  callers: Array<{ name: string; calls: number }>;
}

export interface ProfileSummary extends ProfileInfo {
  /** The script PHP ran, like /var/www/local.acme.com/index.php. */
  script: string;
  totalMs: number;
  /** The most memory the request had, when Xdebug wrote it. */
  peakBytes?: number;
  /** Time by plugin, theme and WordPress itself, from each function's own time; PHP's built-in functions count with the code that calls them most. */
  groups: Array<{ group: string; selfMs: number }>;
  /** The heaviest functions by their own time, at most 60. */
  functions: ProfileFunction[];
  /** How many functions ran in all. */
  functionCount: number;
}

export interface ProfileList {
  profiles: ProfileInfo[];
  /** PHP versions whose profiles go to the panel's folder: the ones it can list. */
  versions: string[];
}

/**
 * The group a file belongs to, from its path: a plugin or theme by its
 * folder, a must-use plugin, WordPress itself, or PHP's own functions.
 */
export function profileGroup(file: string): string {
  if (file === 'php:internal' || file === '') return 'PHP';
  const plugin = /\/wp-content\/plugins\/([^/]+)/.exec(file);
  if (plugin) return `plugin ${(plugin[1] as string).replace(/\.php$/, '')}`;
  const theme = /\/wp-content\/themes\/([^/]+)/.exec(file);
  if (theme) return `theme ${theme[1] as string}`;
  const mu = /\/wp-content\/mu-plugins\/([^/]+)/.exec(file);
  if (mu) return `mu-plugin ${(mu[1] as string).replace(/\.php$/, '')}`;
  if (/\/(wp-includes|wp-admin)\//.test(file) || /\/wp-[a-z-]+\.php$/.test(file) || /\/index\.php$/.test(file)) return 'WordPress';
  if (/\/vendor\//.test(file)) return 'vendor';
  return 'other';
}

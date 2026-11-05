/** The PHP parts of a version Debian can have: Apache's mod_php, PHP-FPM and the command line. */
export const PHP_SAPIS = ['apache2', 'fpm', 'cli'] as const;
export type PhpSapi = (typeof PHP_SAPIS)[number];

/** A PHP version as Debian names its folders and packages: 8.3. */
export const PHP_VERSION_PATTERN = /^\d\.\d$/;

export interface PhpModule {
  name: string;
  /** On for each part of the version that is installed; a part that is not installed is left out. */
  apache2?: boolean;
  fpm?: boolean;
  cli?: boolean;
  required: boolean;
  /** Its ini is there but not the library it loads: the package went (apt remove keeps the ini). */
  missing?: boolean;
}

export interface PhpXdebug {
  /** False when php<version>-xdebug is not installed. */
  installed: boolean;
  /** On for the web (Apache's PHP, or FPM when the version has no mod_php). */
  enabled: boolean;
  /** xdebug.mode as a list, like ['debug', 'develop']. */
  modes?: string[];
  startWithRequest?: string;
  /** Why Xdebug cannot be switched here, when it cannot. */
  reason?: string;
}

/** One installed PHP version, as the PHP tab shows it. */
export interface PhpVersion {
  version: string;
  /** The patch release installed, like 8.3.6, from its packages. */
  patch?: string;
  /** A newer build apt can install, like 8.3.14, when there is one. */
  update?: string;
  /** The parts of this version that have a config folder. */
  sapis: PhpSapi[];
  /** Apache's mod_php is this version. */
  apache: boolean;
  /** `php` on the command line is this version. */
  cli: boolean;
  /** The php<version>-fpm service, when FPM is installed for it. */
  fpm?: 'running' | 'stopped';
  /** Sites whose pool runs this version, as host or host/path. */
  sites: string[];
  modules: PhpModule[];
  xdebug: PhpXdebug;
}

export interface PhpReport {
  checkedAt: string;
  versions: PhpVersion[];
  /** The version sites run when they have no pool of their own: mod_php's, else the command line's. */
  defaultVersion?: string;
  /** Versions apt can install from the sources it has, not installed yet. */
  available: string[];
  /** Whether apt has a source of PHP versions (the ondrej PPA, or packages.sury.org on Debian), and the family of this system. */
  sources: { php: boolean; distro: 'ubuntu' | 'debian' | 'other' };
  /** How sites without a PHP of their own run: Apache's mod_php, or PHP-FPM of the default version once mod_php is off. */
  mode: 'mod_php' | 'fpm' | 'none';
  /** Versions with mod_php installed, which Apache could run again. */
  modPhp: string[];
}

/** The PHP versions the panel offers to install when apt has them. */
export const PHP_OFFERED_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'] as const;

/** One php<version>-<name> package apt has, for a version's module list. */
export interface PhpPackage {
  name: string;
  installed: boolean;
}

/** One setting that differs between a php.ini and the one its package ships. */
export interface PhpIniChange {
  key: string;
  /** Left out when the packaged php.ini does not set it. */
  original?: string;
  /** Left out when this php.ini no longer sets it. */
  current?: string;
}

/** What differs from the packaged php.ini for one part of a version, and the extra ini files it loads. */
export interface PhpIniDiff {
  sapi: PhpSapi;
  file: string;
  /** The packaged copy compared with, or undefined when the package's copy is missing. */
  original?: string;
  changes: PhpIniChange[];
  /** Files in conf.d that are not module links: added by hand, or the panel's own. */
  extraFiles: Array<{ name: string; panel: boolean }>;
}

export interface PhpIniReport {
  version: string;
  sapis: PhpIniDiff[];
}

/** PHP's own view of itself, from the panel's info script run by that PHP. */
export interface PhpInfo {
  version: string;
  sapi: string;
  iniFile?: string;
  scannedFiles: string[];
  /** Every directive with the value in effect and the one from the ini files. */
  ini: Record<string, { local: string; master: string }>;
  /** The directives each loaded extension owns, for sections like phpinfo's. */
  groups: Record<string, string[]>;
  /** Loaded extensions and their versions; Zend ones are listed apart. */
  extensions: Record<string, string>;
  zendExtensions: string[];
  xdebug?: { version: string; modes: string[] };
}

/** One finding before sites move to PHP-FPM, where mod_php and FPM behave differently. */
export interface PhpFpmFinding {
  id: 'apache-php-value' | 'htaccess-php-value' | 'user-ini' | 'phpmyadmin' | 'ini-differs' | 'modules-differ';
  status: 'ok' | 'warn' | 'info';
  text: string;
  files?: string[];
  /** For a difference between Apache and FPM: the version, which php.matchFpm makes match. */
  version?: string;
}

/**
 * The ini settings the panel writes, per version (its 99-devmagic-panel.ini)
 * and later per site. Same names and kinds as DMP_PHP_INI_SETTINGS in
 * scripts/lib/php.sh, which checks every value again before writing it.
 * size: 512M, 64M, 2G (unlimited: -1 too); int: a whole number in range;
 * flag: On or Off; choice: one of the listed; timezone: Area/City or UTC.
 */
export interface PhpIniSetting {
  kind: 'size' | 'int' | 'flag' | 'choice' | 'timezone';
  hint: string;
  group: 'Limits' | 'Errors' | 'OPcache' | 'Other';
  unlimited?: boolean;
  min?: number;
  max?: number;
  choices?: readonly string[];
}

export const ERROR_REPORTING_CHOICES = ['E_ALL', 'E_ALL & ~E_DEPRECATED & ~E_STRICT', 'E_ALL & ~E_NOTICE', 'E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT'] as const;

export const PHP_INI_SETTINGS = {
  memory_limit: { kind: 'size', unlimited: true, group: 'Limits', hint: 'The most memory one request may use; -1 for no limit' },
  upload_max_filesize: { kind: 'size', group: 'Limits', hint: 'The largest file an upload may be' },
  post_max_size: { kind: 'size', group: 'Limits', hint: 'The largest form post, uploads included: at least upload_max_filesize' },
  max_execution_time: { kind: 'int', min: 0, max: 86400, group: 'Limits', hint: 'Seconds a request may run; 0 for no limit' },
  max_input_time: { kind: 'int', min: -1, max: 86400, group: 'Limits', hint: 'Seconds to read a request\'s data; -1 for max_execution_time' },
  max_input_vars: { kind: 'int', min: 100, max: 1000000, group: 'Limits', hint: 'Form fields per request: big menus and option pages need more' },
  max_file_uploads: { kind: 'int', min: 1, max: 1000, group: 'Limits', hint: 'Files per upload request' },
  default_socket_timeout: { kind: 'int', min: 1, max: 86400, group: 'Limits', hint: 'Seconds to wait on a remote server' },
  display_errors: { kind: 'flag', group: 'Errors', hint: 'Errors in the page' },
  display_startup_errors: { kind: 'flag', group: 'Errors', hint: 'Errors while PHP starts, in the page' },
  log_errors: { kind: 'flag', group: 'Errors', hint: 'Errors to the error log' },
  html_errors: { kind: 'flag', group: 'Errors', hint: 'Errors as HTML' },
  error_reporting: { kind: 'choice', choices: ERROR_REPORTING_CHOICES, group: 'Errors', hint: 'Which errors count' },
  'opcache.enable': { kind: 'flag', group: 'OPcache', hint: 'Cache compiled PHP: much faster pages' },
  'opcache.validate_timestamps': { kind: 'flag', group: 'OPcache', hint: 'Notice changed files: keep On while you edit code' },
  'opcache.revalidate_freq': { kind: 'int', min: 0, max: 86400, group: 'OPcache', hint: 'Seconds between checks for changed files; 0 checks every request' },
  'opcache.memory_consumption': { kind: 'int', min: 8, max: 4096, group: 'OPcache', hint: 'Megabytes for the cache' },
  'opcache.max_accelerated_files': { kind: 'int', min: 200, max: 1000000, group: 'OPcache', hint: 'Files the cache can hold' },
  'date.timezone': { kind: 'timezone', group: 'Other', hint: 'Like Europe/Sofia or UTC' },
  'session.gc_maxlifetime': { kind: 'int', min: 60, max: 2592000, group: 'Other', hint: 'Seconds a PHP session lives' },
  'realpath_cache_size': { kind: 'size', group: 'Other', hint: 'Cache of resolved file paths' },
  short_open_tag: { kind: 'flag', group: 'Other', hint: 'Allow <? as well as <?php' },
  allow_url_fopen: { kind: 'flag', group: 'Other', hint: 'Open URLs like files' },
  file_uploads: { kind: 'flag', group: 'Other', hint: 'Accept file uploads' },
} as const satisfies Record<string, PhpIniSetting>;

export type PhpIniKey = keyof typeof PHP_INI_SETTINGS;
export const PHP_INI_KEYS = Object.keys(PHP_INI_SETTINGS) as PhpIniKey[];
export const isPhpIniKey = (key: string): key is PhpIniKey => Object.hasOwn(PHP_INI_SETTINGS, key);

/** Why a value does not fit a setting, or undefined when it does. */
export function phpIniValueError(key: string, value: string): string | undefined {
  if (!isPhpIniKey(key)) return `${key} is not a setting the panel manages`;
  const s: PhpIniSetting = PHP_INI_SETTINGS[key];
  switch (s.kind) {
    case 'size':
      return (s.unlimited && value === '-1') || /^[1-9][0-9]{0,5}[KMG]?$/.test(value) ? undefined : `${key} takes a size like 512M${s.unlimited ? ' or -1' : ''}`;
    case 'int': {
      if (!/^-?[0-9]{1,7}$/.test(value)) return `${key} takes a whole number`;
      const n = Number(value);
      return n < (s.min ?? 0) || n > (s.max ?? Number.MAX_SAFE_INTEGER) ? `${key} takes ${s.min} to ${s.max}` : undefined;
    }
    case 'flag':
      return value === 'On' || value === 'Off' ? undefined : `${key} takes On or Off`;
    case 'choice':
      return s.choices?.includes(value) ? undefined : `${key} takes one of: ${s.choices?.join(', ')}`;
    case 'timezone':
      return value === 'UTC' || /^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z0-9_+-]+){1,2}$/.test(value) ? undefined : `${key} takes a timezone like Europe/Sofia or UTC`;
  }
}

/** What the panel sets for a version, and what its files set otherwise, per part. */
export interface PhpSettings {
  version: string;
  /** web: Apache's PHP and FPM of this version together; cli: the command line. */
  scopes: Array<{ scope: 'web' | 'cli'; panel: Partial<Record<PhpIniKey, string>>; files: Partial<Record<PhpIniKey, string>> }>;
}

/** A site's PHP, for its PHP tab. */
export interface SitePhp {
  /** The version its own pool runs; left out when it runs the version every site runs. */
  version?: string;
  /** The version every site without a pool runs. */
  defaultVersion?: string;
  /** Settings its pool sets on top of the version's. */
  values: Partial<Record<PhpIniKey, string>>;
  /** Versions with PHP-FPM installed, which a site can run on. */
  choices: string[];
  /** The lowest PHP its code asks for, and where it says so. */
  requires?: { version: string; sources: string[] };
  /** Why the site cannot have a pool, when it cannot (a folder outside the web root, say). */
  refused?: string;
}

/** One finding of the compatibility scanner: something removed (error) or deprecated (warning) in the version checked. */
export interface CompatIssue {
  /** Relative to the component's folder. */
  file: string;
  line: number;
  type: 'error' | 'warning';
  message: string;
  /** The scanner's rule, like PHPCompatibility.FunctionUse.RemovedFunctions.each_removed. */
  source: string;
}

/** A theme, plugin or other folder of a site, with what the scanner found in it. */
export interface CompatComponent {
  kind: 'theme' | 'plugin' | 'mu-plugin' | 'dropin' | 'vendor';
  name: string;
  title: string;
  version?: string;
  /** active, inactive, parent (a child theme's parent), network, must-use or dropin. */
  status: string;
  /** A newer version WordPress already found; updating may fix what was found. */
  update?: string;
  /** Its Requires PHP header. */
  requiresPhp?: string;
  files: number;
  errors: number;
  warnings: number;
  /** At most COMPAT_ISSUE_LIMIT, errors first; the counts are the full ones. */
  issues: CompatIssue[];
  /** The scanner could not read it, with why. */
  failed?: string;
}

export const COMPAT_ISSUE_LIMIT = 100;
/** A scan older than this, or of another commit, may be out of date. */
export const COMPAT_STALE_MS = 7 * 86_400_000;

/** The last scan of a site's code against one PHP version. */
export interface CompatScan {
  version: string;
  scope: 'active' | 'all';
  checkedAt: string;
  /** The commit the site's repo was on, when it is a repo. */
  commit?: string;
  /** The scanner's versions, like PHPCompatibilityWP 3.0.0-alpha2. */
  tool: string;
  files: number;
  errors: number;
  warnings: number;
  components: CompatComponent[];
}

/** A site's compatibility scans, for its PHP tab. */
export interface SiteCompat {
  /** The last scan per version, newest version first. */
  scans: CompatScan[];
  /** The commit the site's repo is on now, to tell a scan of older code. */
  commit?: string;
  /** Versions with a command line, which the scanner runs on. */
  versions: string[];
  /** The scanner is installed in the panel's data folder (else the first check fetches it with Composer). */
  installed: boolean;
  /** Composer is on the PATH; without it and without the scanner, a check cannot run. */
  composer: boolean;
}

/** A version's page: every WordPress site with its last scan of that version. */
export interface VersionCompat {
  version: string;
  sites: Array<{
    domain: string;
    path?: string;
    host: string;
    /** The version the site runs now. */
    runs?: string;
    scan?: {
      checkedAt: string;
      scope: CompatScan['scope'];
      files: number;
      errors: number;
      warnings: number;
      /** The themes and plugins with errors. */
      withErrors: string[];
      /** Folders the scanner could not read. */
      failed: number;
      stale: boolean;
    };
  }>;
  /** The version has a command line, which the scanner runs on. */
  cli: boolean;
  installed: boolean;
  composer: boolean;
}

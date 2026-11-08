import type { PhpFpmFinding, PhpInfo, PhpIniReport, PhpModule, PhpReport, PhpSettings, PhpVersion, CompatScan, SiteCompat, SitePhp, VersionCompat } from '@devmagic-panel/shared';

/**
 * The mockup's PHP: 8.3 runs Apache, 8.1 has FPM for one site, and 8.5 has
 * only the command line (apt brought it in for php-imagick), which php points at.
 */

const MODULES = ['bcmath', 'curl', 'dom', 'exif', 'gd', 'imagick', 'intl', 'mbstring', 'mysqli', 'mysqlnd', 'opcache', 'pdo', 'pdo_mysql', 'soap', 'sockets', 'xml', 'zip'];
const REQUIRED = ['mysqli', 'mysqlnd', 'pdo', 'xml'];

const modules = (web: 'apache2' | 'fpm', off: string[]): PhpModule[] =>
  MODULES.map((name) => ({ name, [web]: !off.includes(name), cli: !off.includes(name) || name === 'sockets', required: REQUIRED.includes(name) }));

export const mockPhpVersions: PhpVersion[] = [
  {
    version: '8.5',
    patch: '8.5.1',
    sapis: ['cli'],
    apache: false,
    cli: true,
    sites: [],
    modules: ['calendar', 'ctype', 'imagick', 'phar', 'readline', 'tokenizer'].map((name) => ({ name, cli: true, required: false })),
    xdebug: { installed: true, enabled: false, reason: 'PHP 8.5 has no web part (mod_php or FPM) to debug.' },
  },
  {
    version: '8.3',
    patch: '8.3.6',
    update: '8.3.14',
    sapis: ['apache2', 'cli'],
    apache: true,
    cli: false,
    sites: [],
    modules: modules('apache2', ['soap', 'sockets', 'bcmath']),
    xdebug: { installed: true, enabled: false, modes: ['debug', 'develop'], startWithRequest: 'trigger' },
  },
  {
    version: '8.1',
    patch: '8.1.31',
    sapis: ['fpm', 'cli'],
    apache: false,
    cli: false,
    fpm: 'running',
    sites: ['local.biketours.example'],
    // soap's package went with an apt remove and left its ini on.
    modules: modules('fpm', ['imagick']).map((m) => (m.name === 'soap' ? { ...m, missing: true } : m)),
    xdebug: { installed: false, enabled: false, reason: 'Xdebug is not installed for PHP 8.1: apt install php8.1-xdebug' },
  },
];

export const mockPhpReport = (): PhpReport => ({
  checkedAt: new Date().toISOString(),
  versions: mockPhpVersions.map((v) => ({ ...v, modules: v.modules.map((m) => ({ ...m })), xdebug: { ...v.xdebug } })),
  defaultVersion: '8.3',
  available: mockPhpAvailable.filter((v) => !mockPhpVersions.some((x) => x.version === v)),
  sources: { php: mockPhpSources.ppa, distro: 'ubuntu' },
  mode: mockPhpMode.fpm ? 'fpm' : 'mod_php',
  modPhp: ['8.3'],
  ...(mockPhpMode.fpm ? { defaultVersion: mockPhpMode.fpm } : {}),
});

/** The mockup's mod_php until a switch runs every site on PHP-FPM of a version. */
export const mockPhpMode: { fpm?: string } = {};

/** What apt offers in the mockup, once the PPA is there. */
export const mockPhpSources = { ppa: true };
export const mockPhpAvailable = ['7.4', '8.0', '8.2', '8.4'];

/** The panel's settings per version and scope, and what the files set otherwise. */
export const mockPhpSettings: Record<string, PhpSettings> = {
  '8.5': { version: '8.5', scopes: [{ scope: 'cli', panel: {}, files: { memory_limit: '-1' } }] },
  '8.3': {
    version: '8.3',
    scopes: [
      { scope: 'web', panel: {}, files: { memory_limit: '512M', max_execution_time: '300', max_input_time: '120', post_max_size: '64M', upload_max_filesize: '64M', display_errors: 'Off', error_reporting: 'E_ALL & ~E_DEPRECATED & ~E_STRICT' } },
      { scope: 'cli', panel: {}, files: { memory_limit: '-1', display_errors: 'Off' } },
    ],
  },
  '8.1': {
    version: '8.1',
    scopes: [
      { scope: 'web', panel: { max_input_vars: '5000' }, files: { memory_limit: '128M', upload_max_filesize: '2M', display_errors: 'Off' } },
      { scope: 'cli', panel: {}, files: { memory_limit: '-1' } },
    ],
  },
};

/** The mockup's 8.3 php.ini changes until they are moved into the panel's settings. */
export const mockIniChanges = { moved: false };

export const mockPhpIni = (version: string): PhpIniReport => ({
  version,
  sapis:
    version === '8.3' && !mockIniChanges.moved
      ? [
          {
            sapi: 'apache2',
            file: '/etc/php/8.3/apache2/php.ini',
            original: '/usr/lib/php/8.3/php.ini-production',
            changes: [
              { key: 'max_execution_time', original: '30', current: '300' },
              { key: 'memory_limit', original: '128M', current: '512M' },
              { key: 'post_max_size', original: '8M', current: '64M' },
              { key: 'upload_max_filesize', original: '2M', current: '64M' },
            ],
            extraFiles: [{ name: '99-devmagic-panel-xdebug.ini', panel: true }],
          },
          { sapi: 'cli', file: '/etc/php/8.3/cli/php.ini', original: '/usr/lib/php/8.3/php.ini-production.cli', changes: [], extraFiles: [] },
        ]
      : version === '8.3'
        ? [
            { sapi: 'apache2', file: '/etc/php/8.3/apache2/php.ini', original: '/usr/lib/php/8.3/php.ini-production', changes: [], extraFiles: [{ name: '99-devmagic-panel-xdebug.ini', panel: true }, { name: '99-devmagic-panel.ini', panel: true }] },
            { sapi: 'cli', file: '/etc/php/8.3/cli/php.ini', original: '/usr/lib/php/8.3/php.ini-production.cli', changes: [], extraFiles: [] },
          ]
        : [
          { sapi: 'fpm', file: `/etc/php/${version}/fpm/php.ini`, original: `/usr/lib/php/${version}/php.ini-production`, changes: [], extraFiles: [{ name: '50-wandworks-tuning.ini', panel: false }] },
          { sapi: 'cli', file: `/etc/php/${version}/cli/php.ini`, original: `/usr/lib/php/${version}/php.ini-production.cli`, changes: [], extraFiles: [] },
        ],
});

export function mockPhpInfo(version: string, sapi: 'web' | 'cli'): PhpInfo {
  const v = mockPhpVersions.find((x) => x.version === version) ?? (mockPhpVersions[0] as PhpVersion);
  const web = sapi === 'web';
  const pair = (local: string, master = local) => ({ local, master });
  const ini: PhpInfo['ini'] = {
    display_errors: pair(web ? 'Off' : 'STDOUT'),
    error_reporting: pair('22527'),
    max_execution_time: pair(web ? (version === '8.3' ? '300' : '30') : '0'),
    max_input_time: pair(web ? '120' : '-1'),
    max_input_vars: pair('1000'),
    memory_limit: pair(web ? (version === '8.3' ? '512M' : '128M') : '-1'),
    post_max_size: pair(web && version === '8.3' ? '64M' : '8M'),
    upload_max_filesize: pair(web && version === '8.3' ? '64M' : '2M'),
    'date.timezone': pair(''),
    'mysqli.default_pw': pair('(hidden)'),
    'opcache.enable': pair('1'),
    'opcache.memory_consumption': pair('128'),
    'opcache.validate_timestamps': pair('1'),
    'session.gc_maxlifetime': pair('1440'),
    'session.save_path': pair('/var/lib/php/sessions'),
  };
  if (v.xdebug.installed) Object.assign(ini, { 'xdebug.mode': pair(v.xdebug.enabled ? (v.xdebug.modes ?? []).join(',') : 'develop'), 'xdebug.client_host': pair('127.0.0.1'), 'xdebug.client_port': pair('9003'), 'xdebug.start_with_request': pair('default') });
  const on = v.modules.filter((m) => (web ? (m.apache2 ?? m.fpm) : m.cli)).map((m) => m.name);
  return {
    version: v.patch ?? `${version}.0`,
    sapi: web ? (v.apache ? 'apache2handler' : 'fpm-fcgi') : 'cli',
    iniFile: `/etc/php/${version}/${web ? (v.apache ? 'apache2' : 'fpm') : 'cli'}/php.ini`,
    scannedFiles: on.map((m) => `/etc/php/${version}/${web ? 'apache2' : 'cli'}/conf.d/20-${m}.ini`),
    ini,
    groups: {
      Core: ['display_errors', 'error_reporting', 'max_execution_time', 'max_input_time', 'max_input_vars', 'memory_limit', 'post_max_size', 'upload_max_filesize'],
      date: ['date.timezone'],
      mysqli: ['mysqli.default_pw'],
      'Zend OPcache': ['opcache.enable', 'opcache.memory_consumption', 'opcache.validate_timestamps'],
      session: ['session.gc_maxlifetime', 'session.save_path'],
      ...(v.xdebug.installed ? { xdebug: ['xdebug.client_host', 'xdebug.client_port', 'xdebug.mode', 'xdebug.start_with_request'] } : {}),
    },
    extensions: Object.fromEntries(['Core', 'date', 'session', ...on].map((m) => [m, v.patch ?? version])),
    zendExtensions: ['Zend OPcache', ...(v.xdebug.installed && web ? ['Xdebug'] : [])],
    ...(v.xdebug.installed && web ? { xdebug: { version: '3.3.1', modes: v.xdebug.enabled ? (v.xdebug.modes ?? []) : ['develop'] } } : {}),
  };
}

export const mockFpmFindings = (): PhpFpmFinding[] => [
  { id: 'ini-differs', status: 'warn', version: '8.1', text: "PHP 8.1: FPM's settings differ from Apache's in memory_limit. A site moved to FPM 8.1 would get FPM's values: make PHP-FPM 8.1 match Apache first." },
  { id: 'apache-php-value', status: 'ok', text: 'No Apache config sets PHP settings with php_value.' },
  { id: 'htaccess-php-value', status: 'warn', text: ".htaccess files set PHP settings with php_value: on PHP-FPM those sites answer with error 500. Move the values to the site's PHP settings, or wrap them in <IfModule mod_php.c>.", files: ['local.shop.com/.htaccess'] },
  { id: 'user-ini', status: 'ok', text: 'No .user.ini files in your sites.' },
  { id: 'phpmyadmin', status: 'info', text: 'phpMyAdmin keeps its upload folder and folder limit in mod_php blocks. It runs on mod_php until mod_php goes off, then gets a pool of its own with the same settings.' },
];

/** Each mockup site's own PHP, by host; a site not listed runs the default. */
export const mockSitePools: Record<string, { version: string; values: SitePhp['values'] }> = { 'local.biketours.example': { version: '8.1', values: { memory_limit: '1G' } } };

export const mockSitePhp = (host: string): SitePhp => {
  const own = mockSitePools[host];
  return {
    ...(own ? { version: own.version } : {}),
    defaultVersion: '8.3',
    values: { ...(own?.values ?? {}) },
    choices: mockPhpVersions.filter((v) => v.sapis.includes('fpm')).map((v) => v.version),
    requires: { version: '8.1', sources: ['composer.json', 'plugin wandworks-shop'] },
  };
};

/** Moves a mockup site's PHP once its job had time to run, as the panel would. */
export function mockSetSitePhp(host: string, version: string | null, values: SitePhp['values']) {
  window.setTimeout(() => {
    if (version === null && Object.keys(values).length === 0) delete mockSitePools[host];
    else mockSitePools[host] = { version: version ?? '8.3', values };
    for (const v of mockPhpVersions) v.sites = Object.entries(mockSitePools).filter(([, p]) => p.version === v.version).map(([h]) => h);
  }, 2000);
}

export function mockSitePhpInfo(host: string): PhpInfo {
  const own = mockSitePools[host];
  const info = mockPhpInfo(own?.version ?? '8.3', 'web');
  for (const [k, v] of Object.entries(own?.values ?? {})) info.ini[k] = { local: v as string, master: v as string };
  return own ? { ...info, sapi: 'fpm-fcgi' } : info;
}

export const mockPhpPackages = (version: string) =>
  ['amqp', 'apcu', 'bcmath', 'curl', 'gd', 'imagick', 'intl', 'mbstring', 'memcached', 'mongodb', 'mysql', 'redis', 'soap', 'sqlite3', 'xdebug', 'xml', 'yaml', 'zip'].map((name) => ({
    name,
    installed: ['bcmath', 'curl', 'gd', 'intl', 'mbstring', 'mysql', 'xml', 'zip', ...(version === '8.3' ? ['imagick', 'xdebug'] : [])].includes(name),
  }));

/** What a PHP job does to the mockup once it had time to run. */
export function mockPhpJob(id: string, input: Record<string, unknown>) {
  const version = String(input.version);
  window.setTimeout(() => {
    if (id === 'php.install' && !mockPhpVersions.some((v) => v.version === version)) {
      mockPhpVersions.push({ version, patch: `${version}.0`, sapis: ['fpm', 'cli'], apache: false, cli: false, fpm: 'stopped', sites: [], modules: modules('fpm', []), xdebug: { installed: false, enabled: false, reason: `Xdebug is not installed for PHP ${version}: apt install php${version}-xdebug` } });
      mockPhpVersions.sort((a, b) => Number(b.version) - Number(a.version));
      mockPhpSettings[version] = { version, scopes: [{ scope: 'web', panel: {}, files: {} }, { scope: 'cli', panel: {}, files: {} }] };
    }
    if (id === 'php.package' && input.how === 'install') {
      const m = mockPhpVersions.find((x) => x.version === version)?.modules.find((x) => x.name === input.name);
      if (m) delete m.missing;
    }
    if (id === 'php.package' && input.name === 'fpm' && input.how === 'install') {
      const v = mockPhpVersions.find((x) => x.version === version);
      if (v && !v.sapis.includes('fpm')) Object.assign(v, { sapis: ['fpm', 'cli'], fpm: 'running', modules: v.modules.map((m) => ({ ...m, fpm: m.cli })) });
    }
    if (id === 'php.remove') {
      const at = mockPhpVersions.findIndex((v) => v.version === version);
      if (at >= 0) mockPhpVersions.splice(at, 1);
    }
    if (id === 'php.switchToFpm') {
      mockPhpMode.fpm = version;
      for (const v of mockPhpVersions) {
        v.apache = false;
        if (v.version === version && !v.sapis.includes('fpm')) v.sapis = [...v.sapis, 'fpm'];
      }
    }
    if (id === 'php.switchToModPhp') {
      delete mockPhpMode.fpm;
      for (const v of mockPhpVersions) v.apache = v.version === version;
    }
    if (id === 'php.upgrade') {
      const v = mockPhpVersions.find((x) => x.version === version);
      if (v?.update) Object.assign(v, { patch: v.update, update: undefined });
    }
  }, 0);
}

/** The mockup's compatibility scans per site, one already there for PHP 8.4. */
const mockCompatScans: Record<string, Record<string, CompatScan>> = {
  'local.spellbook.example': {
    '8.4': mockCompatScan('8.4', 'active', new Date(Date.now() - 3 * 86_400_000).toISOString()),
  },
};

function mockCompatScan(version: string, scope: CompatScan['scope'], checkedAt = new Date().toISOString()): CompatScan {
  // Findings for every version but 8.3, the one the mockup's sites run, so the hint shows errors for 8.1 too.
  const newer = version !== '8.3';
  return {
    version,
    scope,
    checkedAt,
    commit: 'a1b2c3d4e5f6',
    tool: 'PHPCompatibilityWP 3.0.0-alpha2, PHPCompatibility 10.0.0-alpha2, PHP_CodeSniffer 4.0.4',
    files: 1843,
    errors: newer ? 3 : 0,
    warnings: newer ? 5 : 1,
    components: [
      { kind: 'theme', name: 'wandworks', title: 'Wandworks', version: '2.4.0', status: 'active', requiresPhp: '8.1', files: 212, errors: 0, warnings: newer ? 4 : 0, issues: newer ? [
        { file: 'inc/helpers.php', line: 88, type: 'warning', message: 'Implicitly marking a parameter as nullable is deprecated since PHP 8.4. Update the type to be explicitly nullable instead. Found implicitly nullable parameter: $args.', source: 'PHPCompatibility.FunctionDeclarations.RemovedImplicitlyNullableParam.Deprecated' },
        { file: 'inc/template-tags.php', line: 41, type: 'warning', message: 'Implicitly marking a parameter as nullable is deprecated since PHP 8.4. Update the type to be explicitly nullable instead. Found implicitly nullable parameter: $post.', source: 'PHPCompatibility.FunctionDeclarations.RemovedImplicitlyNullableParam.Deprecated' },
        { file: 'inc/template-tags.php', line: 77, type: 'warning', message: 'Implicitly marking a parameter as nullable is deprecated since PHP 8.4. Update the type to be explicitly nullable instead. Found implicitly nullable parameter: $term.', source: 'PHPCompatibility.FunctionDeclarations.RemovedImplicitlyNullableParam.Deprecated' },
        { file: 'functions.php', line: 12, type: 'warning', message: 'The constant "E_STRICT" is deprecated since PHP 8.4', source: 'PHPCompatibility.Constants.RemovedConstants.e_strictDeprecated' },
      ] : [] },
      { kind: 'plugin', name: 'wandworks-forms', title: 'Wandworks Forms', version: '1.2.0', status: 'active', update: '1.4.1', files: 318, errors: newer ? 3 : 0, warnings: 1, issues: newer ? [
        { file: 'lib/legacy/parser.php', line: 203, type: 'error', message: 'Function each() is deprecated since PHP 7.2 and removed since PHP 8.0; Use a foreach loop instead', source: 'PHPCompatibility.FunctionUse.RemovedFunctions.eachDeprecatedRemoved' },
        { file: 'lib/legacy/parser.php', line: 251, type: 'error', message: 'Function create_function() is deprecated since PHP 7.2 and removed since PHP 8.0; Use an anonymous function instead', source: 'PHPCompatibility.FunctionUse.RemovedFunctions.create_functionDeprecatedRemoved' },
        { file: 'includes/class-entries.php', line: 64, type: 'error', message: 'Using the curly brace syntax to access array offsets is deprecated since PHP 7.4 and removed since PHP 8.0. Found: $row{0}', source: 'PHPCompatibility.Syntax.RemovedCurlyBraceArrayAccess.Found' },
        { file: 'includes/class-mailer.php', line: 19, type: 'warning', message: 'The constant "E_STRICT" is deprecated since PHP 8.4', source: 'PHPCompatibility.Constants.RemovedConstants.e_strictDeprecated' },
      ] : [
        { file: 'includes/class-entries.php', line: 12, type: 'warning', message: 'Since PHP 7.0, functions inspecting arguments, like func_get_args(), no longer report the original value as passed to a parameter, but will instead provide the current value.', source: 'PHPCompatibility.FunctionUse.ArgumentFunctionsReportCurrentValue.NeedsInspection' },
      ] },
      { kind: 'plugin', name: 'wandworks-shop', title: 'Wandworks Shop', version: '9.1.0', status: 'active', requiresPhp: '7.4', files: 1201, errors: 0, warnings: 0, issues: [] },
      { kind: 'mu-plugin', name: 'mu-plugins', title: 'Must-use plugins', status: 'must-use', files: 3, errors: 0, warnings: 0, issues: [] },
      { kind: 'vendor', name: 'vendor', title: 'Composer packages (vendor)', status: 'active', files: 109, errors: 0, warnings: 0, issues: [] },
    ],
  };
}

export const mockSiteCompat = (host: string): SiteCompat => ({
  scans: Object.values(mockCompatScans[host] ?? {}).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })),
  commit: 'a1b2c3d4e5f6',
  versions: mockPhpVersions.filter((v) => v.sapis.includes('cli')).map((v) => v.version),
  installed: true,
  composer: true,
});

/** Keeps a scan once its job had time to run, as the panel would. */
export function mockCheckCompat(host: string, version: string, scope: CompatScan['scope']) {
  window.setTimeout(() => {
    mockCompatScans[host] = { ...(mockCompatScans[host] ?? {}), [version]: mockCompatScan(version, scope) };
  }, 500);
}

/** A version's page in the mockup: the mockup's sites with what they have for that version. */
export function mockVersionCompat(version: string): VersionCompat {
  const hosts = [{ domain: 'local.spellbook.example' }, { domain: 'local.spellbook.example', path: '/learn' }, { domain: 'local.dailypost.example' }, { domain: 'local.biketours.example' }];
  return {
    version,
    sites: hosts.map((h) => {
      const host = `${h.domain}${h.path ?? ''}`;
      const scan = mockCompatScans[host]?.[version];
      return {
        ...h,
        host,
        runs: mockSitePools[host]?.version ?? '8.3',
        ...(scan ? { scan: { checkedAt: scan.checkedAt, scope: scan.scope, files: scan.files, errors: scan.errors, warnings: scan.warnings, withErrors: scan.components.filter((c) => c.errors > 0).map((c) => c.title), failed: 0, stale: Date.now() - Date.parse(scan.checkedAt) > 7 * 86_400_000 } } : {}),
      };
    }),
    cli: mockPhpVersions.some((v) => v.version === version && v.sapis.includes('cli')),
    installed: true,
    composer: true,
  };
}

/** Every mockup site gets a scan once the job had time to run. */
export function mockCheckCompatAll(version: string, scope: CompatScan['scope']) {
  for (const host of ['local.spellbook.example', 'local.spellbook.example/learn', 'local.dailypost.example', 'local.biketours.example']) mockCheckCompat(host, version, scope);
}

/** Deletes the mockup's kept scans: one site's (one version or all), or one version's on every site. */
export function mockDeleteCompat(host: string | undefined, version: string | undefined): number {
  let n = 0;
  for (const [h, scans] of Object.entries(mockCompatScans)) {
    if (host && h !== host) continue;
    for (const v of Object.keys(scans)) {
      if (version && v !== version) continue;
      delete scans[v];
      n++;
    }
  }
  return n;
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CheckFix, CheckResult, EnvironmentReport, SystemInstall } from '@devmagic-panel/shared';
import { APACHE_MODULES, isLocalName, MAILPIT_SMTP, MAILPIT_WEB, TOOLS, WP_CLI_RELEASE } from '@devmagic-panel/shared';
import { encryptedHome, missingPaths, readAutostart } from './autostart.js';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import { claudeStatus } from './org/claude-code.js';
import { rcloneRemote } from './org/dumps.js';
import { ghStatus } from './repo-hosts/github.js';
import { githubHttpsOn, githubSshKey, gitlabHttpsHosts } from './sites/git.js';
import { glabOverview } from './repo-hosts/index.js';
import { glabTooOld, MIN_GLAB } from './repo-hosts/gitlab.js';
import { runRoot } from './exec.js';
import { installedCores, readWpcoreConfig } from './wpcore.js';
import type { Secrets } from './secrets.js';
import { selfChecks } from './self-check.js';
import { nginxConfigs, nginxInstalled, nginxSetUp } from './nginx.js';
import { bufferPoolTarget } from './mysql-limits.js';
import { formatBytes } from './sites/db.js';
import { hostsKept, interopDisabled, interopOn, listensOffAddress, wslVersion, type WslPaths } from './wsl.js';
import { readRelease } from './update.js';
import { helperInstalled, windowsBlockPairs, windowsHostsPairs, windowsPortproxyHeld, windowsPartCurrent, windowsPortproxyRules, windowsStatus, type WindowsPaths } from './windows.js';

/** Paths outside config.env, overridable so tests run against a temp tree. */
export interface HostPaths {
  home: string;
  systemCaBundle: string;
  wpcoreConf: string;
  phpMyAdminDirs: string[];
  modsEnabled?: string;
  /** Where to look for commands the service's PATH may lack, like claude; PATH by default. */
  searchPath?: string;
  /** The mounted filesystems, to see an encrypted home; /proc/mounts by default. */
  mounts?: string;
  /** The kernel's name, wsl.conf and binfmt_misc, to see WSL; the system's by default. */
  wsl?: WslPaths;
  /** Windows' folder and the helper as WSL sees them; /mnt/c by default. */
  windows?: WindowsPaths;
}

export const defaultHostPaths = (home: string): HostPaths => ({
  home,
  searchPath: process.env.PATH ?? '',
  systemCaBundle: '/etc/ssl/certs/ca-certificates.crt',
  wpcoreConf: '/etc/wpcore.conf',
  phpMyAdminDirs: ['/usr/share/phpmyadmin', '/etc/apache2/conf-enabled/phpmyadmin.conf'],
});

export interface CheckContext {
  config: SystemConfig;
  exec: Executor;
  secrets: Secrets | null;
  paths: HostPaths;
  dmpRoot: string;
  /** The panel's own installation, checked when given: its checkout and running version. */
  self?: { repo: string; version: string };
  /** The GitLab hosts in use (settings, selected groups, the sites' remotes); none shows nothing about GitLab. */
  gitlabHosts?: () => Promise<string[]>;
  /** The machine's memory in bytes; the system's own when not given. */
  totalMemory?: () => number;
}

export const NSS_NICKNAME = 'devmagic-panel Local CA';
const REQUIRED_PHP_MODULES = ['mysqli', 'curl', 'gd', 'intl', 'mbstring', 'xml', 'zip'];
const MIN_PHP = [8, 1] as const;

type Check = Omit<CheckResult, 'group'>;
const ok = (id: string, label: string, detail: string, extra: Partial<Check> = {}): Check => ({ id, label, status: 'ok', detail, ...extra });
const warn = (id: string, label: string, detail: string, extra: Partial<Check> = {}): Check => ({ id, label, status: 'warn', detail, ...extra });
const fail = (id: string, label: string, detail: string, extra: Partial<Check> = {}): Check => ({ id, label, status: 'fail', detail, ...extra });

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

// ── Apache ───────────────────────────────────────────────────

async function apacheChecks(ctx: CheckContext): Promise<Check[]> {
  const { exec, config } = ctx;
  const results: Check[] = [];

  const active = await exec('systemctl', ['is-active', 'apache2']);
  results.push(
    active.stdout.trim() === 'active'
      ? ok('apache.running', 'Apache is running', 'apache2 service is active')
      : fail('apache.running', 'Apache is running', `apache2 is ${active.stdout.trim() || 'not running'}`),
  );

  const modsDir = ctx.paths.modsEnabled ?? join(dirname(config.APACHE_SITES_AVAILABLE), 'mods-enabled');
  const missing = APACHE_MODULES.filter((m) => !existsSync(join(modsDir, `${m}.load`)));
  results.push(
    missing.length === 0
      ? ok('apache.modules', 'Apache modules', APACHE_MODULES.join(', '))
      : fail('apache.modules', 'Apache modules', `missing: ${missing.join(', ')}`, {
          fixes: missing.map((module): CheckFix => ({ action: 'apache.enableModule', input: { module }, label: `Enable ${module}` })),
        }),
  );

  const test = await runRoot(exec, ctx.dmpRoot, ['apache-configtest'], 30_000);
  if (test.code === 0) {
    results.push(ok('apache.configtest', 'Apache config is valid', 'apache2ctl configtest passed'));
  } else if (/password is required/i.test(test.stderr)) {
    results.push(warn('apache.configtest', 'Apache config is valid', 'cannot check yet: needs the sudoers rule from install.sh'));
  } else {
    results.push(fail('apache.configtest', 'Apache config is valid', firstLine(test.stderr) || 'configtest failed'));
  }

  const listening = await exec('ss', ['-ltnH']);
  const ports = [80, 443].filter((p) => new RegExp(`:${p}\\s`).test(`${listening.stdout} `));
  results.push(
    ports.length === 2
      ? ok('apache.ports', 'Ports 80 and 443', 'both are listening')
      : fail('apache.ports', 'Ports 80 and 443', `not listening: ${[80, 443].filter((p) => !ports.includes(p)).join(', ')}`),
  );
  return results;
}

// ── nginx ────────────────────────────────────────────────────

/**
 * nginx next to Apache, only once nginx is installed: whether the panel set
 * it up, runs, passes nginx -t, and each server answers on its own address
 * only. When nginx is not installed, an optional check that installs it: the panel needs only Apache.
 */
async function nginxChecks(ctx: CheckContext): Promise<Check[]> {
  const { exec, config } = ctx;
  if (!nginxInstalled(config)) {
    return [
      warn('nginx.installed', 'nginx', 'not installed: it can serve sites next to Apache, set up on Services, nginx once it is here', {
        optional: true,
        fixes: installWithPassword('nginx', 'Installs nginx with apt; it stays off until you set it up next to Apache on Services, nginx.'),
      }),
    ];
  }
  const conflicts = nginxConfigs(config).filter((c) => c.conflict);
  const conflictCheck = conflicts.length
    ? fail('nginx.conflicts', 'nginx leaves Apache its ports', `${conflicts.map((c) => `${c.file} ${c.conflict}`).join('; ')}: make ${conflicts.length === 1 ? 'it' : 'them'} listen on ${config.NGINX_ADDRESS}, or turn ${conflicts.length === 1 ? 'it' : 'them'} off`)
    : ok('nginx.conflicts', 'nginx leaves Apache its ports', `no config made by hand listens on port 80 or 443 off ${config.NGINX_ADDRESS}`);
  if (!nginxSetUp(config)) {
    return [
      warn('nginx.setUp', 'nginx next to Apache', `installed, not set up: open Services, nginx to run it on ${config.NGINX_ADDRESS} next to Apache`, { optional: true }),
      ...(conflicts.length ? [conflictCheck] : []),
    ];
  }

  const results: Check[] = [ok('nginx.setUp', 'nginx next to Apache', `nginx answers on ${config.NGINX_ADDRESS}, Apache on ${config.APACHE_ADDRESS}`)];
  const active = await exec('systemctl', ['is-active', 'nginx']);
  results.push(
    active.stdout.trim() === 'active'
      ? ok('nginx.running', 'nginx is running', 'nginx service is active')
      : fail('nginx.running', 'nginx is running', `nginx is ${active.stdout.trim() || 'not running'}`, { fixes: [{ action: 'service.restart', input: { service: 'nginx' }, label: 'Start nginx' }] }),
  );
  const test = await runRoot(exec, ctx.dmpRoot, ['nginx-configtest'], 30_000);
  if (test.code === 0) results.push(ok('nginx.configtest', 'nginx config is valid', 'nginx -t passed'));
  else if (/password is required/i.test(test.stderr)) results.push(warn('nginx.configtest', 'nginx config is valid', 'cannot check yet: needs the sudoers rule from install.sh'));
  else results.push(fail('nginx.configtest', 'nginx config is valid', firstLine(test.stderr) || 'nginx -t failed'));

  const listening = `${(await exec('ss', ['-ltnH'])).stdout} `;
  const on = (address: string, port: number) => new RegExp(`\\s${address.replace(/\./g, '\\.')}:${port}\\s`).test(listening);
  const everywhere = [80, 443].filter((p) => new RegExp(`\\s(\\*|0\\.0\\.0\\.0|\\[::\\]):${p}\\s`).test(listening));
  const missing = [
    ...[80, 443].filter((p) => !on(config.NGINX_ADDRESS, p)).map((p) => `nginx on ${config.NGINX_ADDRESS}:${p}`),
    ...[80, 443].filter((p) => !on(config.APACHE_ADDRESS, p)).map((p) => `Apache on ${config.APACHE_ADDRESS}:${p}`),
  ];
  results.push(
    missing.length === 0 && everywhere.length === 0
      ? ok('nginx.addresses', 'Each server on its own address', `nginx on ${config.NGINX_ADDRESS}, Apache on ${config.APACHE_ADDRESS}, ports 80 and 443`)
      : fail(
          'nginx.addresses',
          'Each server on its own address',
          [missing.length ? `not listening: ${missing.join(', ')}` : '', everywhere.length ? `something listens on port ${everywhere.join(' and ')} on every address` : '']
            .filter(Boolean)
            .join('; ') + ': set nginx up again on Services, nginx',
        ),
  );
  results.push(conflictCheck);
  return results;
}

// ── Database ─────────────────────────────────────────────────

/**
 * Connects with the mysql client the panel uses for everything else, not
 * mysqladmin: mysqladmin refuses client options it does not know, like a
 * max_allowed_packet under [client] in my.cnf.
 */
export function pingMysql(exec: Executor, account: { user: string; host: string; password: string }): Promise<ExecResult> {
  return exec('mysql', ['--user', account.user, '--host', account.host, '--batch', '--skip-column-names', '-e', 'SELECT 1'], {
    env: { MYSQL_PWD: account.password },
    timeoutMs: 10_000,
  });
}

async function databaseChecks(ctx: CheckContext): Promise<Check[]> {
  const mysql = ctx.secrets?.mysql;
  if (!mysql) {
    return [fail('mysql.reachable', 'MySQL admin account', 'not configured, run: node ~/.local/share/devmagic-panel/current/server/dist/cli.js setup')];
  }
  const ping = await pingMysql(ctx.exec, mysql);
  return [
    ping.code === 0
      ? ok('mysql.reachable', 'MySQL admin account', `connected as ${mysql.user}@${mysql.host}`)
      : fail('mysql.reachable', 'MySQL admin account', firstLine(ping.stderr) || 'cannot connect'),
    ...(ping.code === 0 ? [await readOnlyCheck(ctx)] : []),
    ...(ping.code === 0 ? await bufferPoolCheck(ctx, mysql) : []),
  ];
}

/** The query the buffer pool check runs: MySQL's version, its buffer pool, and the InnoDB data of every database but MySQL's own. */
export const BUFFER_POOL_SQL =
  "SELECT VERSION(), @@innodb_buffer_pool_size, (SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE ENGINE = 'InnoDB' AND TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema'))";

/**
 * InnoDB's buffer pool against the sites' data: much smaller, and every page
 * of a big site reads from the disk, the most common reason a big local site
 * is slow. The fix sets it like the MySQL page does: at once, and kept in
 * the panel's own settings file through dmp-root.
 */
async function bufferPoolCheck(ctx: CheckContext, account: { user: string; host: string; password: string }): Promise<Check[]> {
  const label = 'MySQL memory for site data';
  const r = await ctx.exec('mysql', ['--user', account.user, '--host', account.host, '--batch', '--skip-column-names', '-e', BUFFER_POOL_SQL], { env: { MYSQL_PWD: account.password }, timeoutMs: 15_000 });
  const [version = '', pool = '', data = ''] = r.stdout.trim().split('\t');
  const poolBytes = Number(pool);
  const dataBytes = Number(data);
  if (r.code !== 0 || !Number.isFinite(poolBytes) || !Number.isFinite(dataBytes) || poolBytes <= 0) return [];
  const ram = ctx.totalMemory?.() ?? totalmem();
  const mb = 1024 * 1024;
  const target = bufferPoolTarget(dataBytes, ram);
  const setting = target >= 1024 * mb && target % (1024 * mb) === 0 ? `${target / (1024 * mb)}G` : `${target / mb}M`;
  const fact = `${formatBytes(poolBytes)} for ${formatBytes(dataBytes)} of InnoDB data`;
  if (poolBytes >= target / 2) return [ok('mysql.bufferPool', label, fact, { optional: true })];
  const product = /mariadb/i.test(version) ? 'MariaDB' : 'MySQL';
  return [
    warn('mysql.bufferPool', label, `${fact}: big sites read from the disk on every page. Set the buffer pool to ${setting}, on the MySQL page or here`, {
      optional: true,
      fixes: [{ action: 'mysql.setSettings', input: { values: { innodb_buffer_pool_size: target } }, label: `Set it to ${setting}`, confirm: `${product} takes the new size at once, and keeps it for its next start in the panel's own settings file. Undo on the job puts the old size back.` }],
    }),
  ];
}

/** The SQL runner's account: it reads with SELECT and SHOW VIEW only, so a query can change nothing. */
async function readOnlyCheck(ctx: CheckContext): Promise<Check> {
  const label = 'Read-only MySQL account';
  const fixes: CheckFix[] = [{ action: 'mysql.makeReadOnlyAccount', input: {}, label: ctx.secrets?.mysqlReadOnly ? 'Make it again' : 'Make it' }];
  const account = ctx.secrets?.mysqlReadOnly;
  if (!account) return warn('mysql.readonly', label, 'not made yet: the SQL runner on the Database tab needs it', { optional: true, fixes });
  const ping = await pingMysql(ctx.exec, account);
  return ping.code === 0
    ? ok('mysql.readonly', label, `${account.user}@${account.host} signs in, for the SQL runner`, { optional: true })
    : warn('mysql.readonly', label, `${account.user}@${account.host} does not sign in: ${firstLine(ping.stderr) || 'cannot connect'}`, { optional: true, fixes });
}

// ── PHP and tools ────────────────────────────────────────────

/** A fix that installs one item of SYSTEM_INSTALLS with your sudo password, which the page asks for. */
function installWithPassword(item: SystemInstall, what: string): CheckFix[] {
  return [
    {
      action: 'system.install',
      input: { items: [item] },
      label: 'Install with your password',
      needsPassword: true,
      confirm: `${what} Your sudo password goes to sudo once, for this install; the panel never saves it.`,
    },
  ];
}

async function phpChecks(ctx: CheckContext): Promise<Check[]> {
  const version = await ctx.exec('php', ['-r', 'echo PHP_VERSION;']);
  if (version.code !== 0) return [fail('php.version', 'PHP', 'php is not installed')];

  const [major = 0, minor = 0] = version.stdout.trim().split('.').map(Number);
  const results: Check[] = [
    major > MIN_PHP[0] || (major === MIN_PHP[0] && minor >= MIN_PHP[1])
      ? ok('php.version', 'PHP', version.stdout.trim())
      : fail('php.version', 'PHP', `${version.stdout.trim()} is older than ${MIN_PHP.join('.')}`),
  ];

  const modules = new Set(
    (await ctx.exec('php', ['-m'])).stdout.split('\n').map((m) => m.trim().toLowerCase()).filter(Boolean),
  );
  const missing = REQUIRED_PHP_MODULES.filter((m) => !modules.has(m));
  results.push(
    missing.length === 0
      ? ok('php.modules', 'PHP modules for WordPress', REQUIRED_PHP_MODULES.join(', '))
      : fail('php.modules', 'PHP modules for WordPress', `missing: ${missing.join(', ')} (apt install php-${missing[0]})`),
  );
  // A module the command line's PHP lacks installs for that version (php<version>-<name>), so
  // this check is ok afterwards; never the unversioned php-<name>, which can pull in a newer PHP.
  const cli = `${major}.${minor}`;
  const install = (name: string, what: string, after = ''): CheckFix[] => [
    {
      action: 'php.package',
      input: { version: cli, name, how: 'install' },
      label: `Install for PHP ${cli}`,
      confirm: `Installs php${cli}-${name} (${what}) from the sources apt has; Apache restarts when it runs PHP ${cli}, and PHP ${cli}'s FPM reloads.${after} Undo on the job removes it again. Other PHP versions get it on Services, PHP.`,
    },
  ];
  results.push(
    modules.has('imagick')
      ? ok('php.imagick', 'Imagick', 'installed', { recommended: true })
      : warn('php.imagick', 'Imagick', 'not installed, WordPress falls back to GD', { recommended: true, fixes: install('imagick', 'ImageMagick for PHP') }),
  );
  results.push(
    modules.has('xdebug')
      ? ok('php.xdebug', 'Xdebug', 'installed', { optional: true })
      : warn('php.xdebug', 'Xdebug', 'not installed: step debugging and profiling need it', {
          optional: true,
          fixes: install('xdebug', 'step debugging and profiling', ' Xdebug then runs in its default mode (develop) on every request, which makes PHP a little slower: pick its modes or turn it off on Services, PHP, Xdebug.'),
        }),
  );
  return results;
}

function wpcoreCheck(ctx: CheckContext): Check {
  const conf = readWpcoreConfig(ctx.paths.wpcoreConf);
  if (!conf) return fail('tools.wpcore', 'wpcore', `${ctx.paths.wpcoreConf} is missing, run install.sh`);
  const cores = installedCores(conf.coresDir);
  if (!existsSync(conf.coresDir)) return fail('tools.wpcore', 'wpcore', `cores folder ${conf.coresDir} from ${ctx.paths.wpcoreConf} does not exist`);
  return ok(
    'tools.wpcore',
    'wpcore',
    `shared with the wpcore CLI: ${ctx.paths.wpcoreConf}, ${cores.length} core${cores.length === 1 ? '' : 's'} in ${conf.coresDir}${cores.length ? ` (${cores.join(', ')})` : ''}`,
  );
}

/** True when something listens on this TCP port, read from `ss`. */
export async function isListening(exec: Executor, port: number): Promise<boolean> {
  const out = await exec('ss', ['-ltnH']);
  return out.code === 0 && new RegExp(`:${port}\\s`).test(`${out.stdout} `);
}

async function toolChecks(ctx: CheckContext): Promise<Check[]> {
  const [wp, git, unzip, composer] = await Promise.all([
    ctx.exec('wp', ['--version']),
    ctx.exec('git', ['--version']),
    ctx.exec('unzip', ['-v']),
    ctx.exec('composer', ['--version', '--no-ansi'], { timeoutMs: 15_000 }),
  ]);
  const results: Check[] = [
    wp.code === 0
      ? ok('tools.wpcli', 'WP-CLI', wp.stdout.trim())
      : fail('tools.wpcli', 'WP-CLI', 'wp is not installed', { fixes: installWithPassword('wp-cli', `Downloads WP-CLI ${WP_CLI_RELEASE.version} from its release on GitHub, checks its SHA-256 and puts it at /usr/local/bin/wp.`) }),
    wpcoreCheck(ctx),
    git.code === 0
      ? ok('tools.git', 'git', firstLine(git.stdout))
      : fail('tools.git', 'git', 'not installed: installs from a repo and updates over git need it', { fixes: installWithPassword('git', 'Installs git with apt.') }),
    unzip.code === 0
      ? ok('tools.unzip', 'unzip', firstLine(unzip.stdout).split(' of ')[0] ?? 'installed')
      : fail('tools.unzip', 'unzip', 'not installed: zipped database dumps need it', { fixes: installWithPassword('unzip', 'Installs unzip with apt.') }),
    composer.code === 0
      ? ok('tools.composer', 'Composer', firstLine(composer.stdout).replace(/ \d{4}-\d\d-\d\d.*$/, ''), { recommended: true })
      : warn('tools.composer', 'Composer', 'not installed: repos with a composer.json need it to install their dependencies', { recommended: true, fixes: installWithPassword('composer', 'Installs Composer with apt (the one your release has).') }),
  ];
  results.push(
    (await isListening(ctx.exec, MAILPIT_SMTP.port))
      ? ok('tools.mailpit', 'Mailpit', `catching mail on port ${MAILPIT_SMTP.port}, read it at ${MAILPIT_WEB}`, { recommended: true })
      : warn('tools.mailpit', 'Mailpit', `not running on port ${MAILPIT_SMTP.port}: mail from sites in Local mode is dropped until it runs. Install or start it in one click on the Services page`, { recommended: true }),
  );
  const pma = ctx.paths.phpMyAdminDirs.find((p) => existsSync(p));
  results.push(
    pma
      ? ok('tools.phpmyadmin', 'phpMyAdmin', `found at ${pma}`, { optional: true })
      : warn('tools.phpmyadmin', 'phpMyAdmin', 'not installed: once it is, a site\'s Database tab opens its database and tables in it too', {
          optional: true,
          fixes: installWithPassword('phpmyadmin', "Installs phpMyAdmin with apt, set up for Apache at /phpmyadmin, without a control database of its own (dpkg-reconfigure phpmyadmin adds one later); under PHP-FPM the panel gives it its pool."),
        }),
  );
  return results;
}

// ── Certificates ─────────────────────────────────────────────

function browserStores(home: string): string[] {
  const stores = [join(home, '.pki', 'nssdb')];
  for (const base of [join(home, '.mozilla', 'firefox'), join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, 'cert9.db'))) stores.push(join(base, entry.name));
    }
  }
  return stores.filter((s) => existsSync(join(s, 'cert9.db')));
}

async function certificateChecks(ctx: CheckContext): Promise<Check[]> {
  const { config, exec, paths } = ctx;
  const caCert = join(config.CA_DIR, 'ca.pem');
  if (!existsSync(caCert)) {
    return [fail('ca.exists', 'Local CA', `no CA at ${caCert}, run install.sh`)];
  }
  const results: Check[] = [ok('ca.exists', 'Local CA', caCert)];

  const verify = await exec('openssl', ['verify', '-CAfile', paths.systemCaBundle, caCert]);
  results.push(
    verify.code === 0
      ? ok('ca.system', 'Trusted by the system', 'in the system certificate store')
      : fail('ca.system', 'Trusted by the system', 'not in the system certificate store', {
          fixes: [{ action: 'ca.trustSystem', input: {}, label: 'Trust system-wide' }],
        }),
  );

  const stores = browserStores(paths.home);
  const untrusted: string[] = [];
  for (const store of stores) {
    const listed = await exec('certutil', ['-L', '-d', `sql:${store}`, '-n', NSS_NICKNAME]);
    if (listed.code !== 0) untrusted.push(store.replace(paths.home, '~'));
  }
  if (stores.length === 0 && wslVersion(ctx.paths.wsl ?? {}) === 2) {
    // Under WSL the browsers run in Windows and trust what Windows trusts; Local CA in Windows (WSL) checks that.
    results.push(ok('ca.browsers', 'Trusted by browsers', "your browsers run in Windows and use its trusted roots: see Local CA in Windows, under WSL"));
  } else if (stores.length === 0) {
    results.push(warn('ca.browsers', 'Trusted by browsers', 'no Chrome, Edge or Firefox certificate store found'));
  } else {
    results.push(
      untrusted.length === 0
        ? ok('ca.browsers', 'Trusted by browsers', `${stores.length} browser store(s)`)
        : fail('ca.browsers', 'Trusted by browsers', `missing in ${untrusted.join(', ')}`, {
            fixes: [{ action: 'ca.trustBrowsers', input: {}, label: 'Trust in browsers' }],
          }),
    );
  }

  if (existsSync(join(config.SYSTEM_CA_DIR, 'LocalhostCA.crt'))) {
    results.push(
      warn('ca.legacy', 'Old LocalhostCA', 'still trusted by the system', {
        fixes: [{
          action: 'ca.untrustLegacy',
          input: {},
          label: 'Remove old CA',
          confirm: 'Open every site first and check it loads without a certificate warning. Sites still on an old cert stop working.',
        }],
      }),
    );
  }
  return results;
}

// ── Hosts ────────────────────────────────────────────────────

/** Every ServerName and ServerAlias in the enabled vhosts, grouped by file. */
export function enabledSiteNames(sitesEnabled: string): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  if (!existsSync(sitesEnabled)) return sites;
  for (const file of readdirSync(sitesEnabled).filter((f) => f.endsWith('.conf')).sort()) {
    let text: string;
    try {
      text = readFileSync(join(sitesEnabled, file), 'utf8');
    } catch {
      continue;
    }
    const names: string[] = [];
    for (const line of text.split('\n')) {
      // Apache's ServerName and ServerAlias, or nginx's server_name.
      const m = /^\s*Server(?:Name|Alias)\s+(.+)$/i.exec(line) ?? /^\s*server_name\s+([^;]+);/.exec(line);
      if (!m?.[1]) continue;
      for (const name of m[1].trim().toLowerCase().split(/\s+/)) if (!names.includes(name)) names.push(name);
    }
    const local = names.filter(isLocalName);
    const primary = local[0];
    if (primary) sites.set(primary, local);
  }
  return sites;
}

export function hostsNames(hostsText: string): Set<string> {
  const names = new Set<string>();
  for (const raw of hostsText.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [ip, ...hosts] = line.split(/\s+/);
    if (ip === '127.0.0.1' || ip === '::1' || ip?.startsWith('127.')) hosts.forEach((h) => names.add(h.toLowerCase()));
  }
  return names;
}

function hostsChecks(ctx: CheckContext): Check[] {
  const { config } = ctx;
  const sites = new Map([...enabledSiteNames(config.APACHE_SITES_ENABLED), ...enabledSiteNames(config.NGINX_SITES_ENABLED)]);
  const known = hostsNames(existsSync(config.HOSTS_FILE) ? readFileSync(config.HOSTS_FILE, 'utf8') : '');
  if (sites.size === 0) return [ok('hosts.none', 'Site hosts entries', 'no enabled sites yet')];

  return [...sites].map(([domain, names]) => {
    const missing = names.filter((n) => !known.has(n));
    return missing.length === 0
      ? ok(`hosts.${domain}`, domain, `${names.length} name(s) point to this machine`)
      : fail(`hosts.${domain}`, domain, `not in hosts: ${missing.join(', ')}`, {
          fixes: [{ action: 'hosts.add', input: { domain, aliases: names.filter((n) => n !== domain) }, label: 'Add to hosts' }],
        });
  });
}

// ── Access ───────────────────────────────────────────────────

const INSTALL_GH: CheckFix = {
  action: 'tools.install',
  input: { tool: 'gh' },
  label: 'Install the GitHub CLI',
  confirm: `Downloads gh ${TOOLS.gh.version} from GitHub, checks it against its SHA-256 and keeps it in the panel's folder, linked into ~/.local/bin: no root, no apt source. Undo on the job removes it.`,
};
const SIGN_IN_GITHUB: CheckFix = { action: 'github.signIn', input: {}, label: 'Sign in to GitHub' };
/** Claude Code signs in in a terminal: one opens where you sit, running claude auth login. */
const CLAUDE_LOGIN: CheckFix = { action: 'machine.openTerminal', input: { run: 'claude-login' }, label: 'Sign in in a terminal' };
const CLONE_HTTPS: CheckFix = {
  action: 'github.cloneWith',
  input: { way: 'https' },
  label: 'Clone through the GitHub CLI (HTTPS)',
  confirm: "GitHub repos then clone over HTTPS, with gh giving git the sign-in: no SSH key needed. A site's repo keeps that in its own .git/config; your ~/.gitconfig stays as it is.",
};
const CLONE_SSH: CheckFix = { action: 'github.cloneWith', input: { way: 'ssh' }, label: 'Clone over SSH again' };

/** What installing a site from an organization needs; all optional, since the rest of the panel works without. */
async function organizationChecks(ctx: CheckContext): Promise<Check[]> {
  const gitlabHosts = (await ctx.gitlabHosts?.().catch(() => [])) ?? [];
  const [claude, gh, glab, rclone] = await Promise.all([
    claudeStatus(ctx.exec, ctx.paths.home, ctx.paths.searchPath ?? process.env.PATH ?? ''),
    ghStatus(ctx.exec),
    // Always: glab installs from here before any GitLab host is in use; once it is installed, gitlab.com when no host is.
    glabOverview(ctx.exec, gitlabHosts.length ? gitlabHosts : ['gitlab.com']),
    rcloneRemote(ctx.exec),
  ]);
  const where = `Claude Code ${claude.version ?? ''} at ${claude.path ?? ''}`;
  return [
    !claude.found
      ? warn('access.claudeCode', 'Claude Code', 'not found: installs from an organization read their repos with it (sign it in with claude auth login after)', {
          optional: true,
          fixes: [{ action: 'claude.install', input: {}, label: 'Install Claude Code', confirm: "Installs the newest Claude Code as you, as Anthropic's installer does: the binary for this machine from downloads.claude.ai (about 370 MB), checked against the SHA-256 its manifest gives, then its own claude install (~/.local/bin/claude; it updates itself). Sign it in with claude auth login in a terminal after." }],
        })
      : !claude.signedIn
        ? warn('access.claudeCode', 'Claude Code', `${where}, not signed in: sign it in with claude auth login`, { optional: true, fixes: [CLAUDE_LOGIN] })
        : !claude.claudeAi
          ? warn('access.claudeCode', 'Claude Code', `${where}, signed in without claude.ai: it reads repos, but Asana and Google links need claude auth login with your claude.ai account`, { optional: true, fixes: [CLAUDE_LOGIN] })
          : ok('access.claudeCode', 'Claude Code', `${where}, signed in with claude.ai; it reads repos and their Asana and Google links`, { optional: true }),
    gh.signedIn
      ? ok('access.githubCli', 'GitHub CLI', `signed in as ${gh.user}; it lists your organizations and their repos`, { optional: true })
      : !gh.installed
        ? warn('access.githubCli', 'GitHub CLI', 'not installed: it lists the repos of your organizations, and GitHub repos clone through it without an SSH key', { optional: true, fixes: [INSTALL_GH] })
        : /not signed in/.test(gh.problem ?? '')
          ? warn('access.githubCli', 'GitHub CLI', 'not signed in: it lists the repos of your organizations', { optional: true, fixes: [SIGN_IN_GITHUB] })
          : warn('access.githubCli', 'GitHub CLI', `${gh.problem ?? 'not set up'}: it lists the repos of your organizations`, { optional: true }),
    ...gitlabCliChecks(glab),
    rclone.remote
      ? ok('tools.rclone', 'rclone', `downloads database dumps from Google Drive through the ${rclone.remote} remote`, { optional: true })
      : rclone.installed
        ? warn('tools.rclone', 'rclone', 'no Google Drive remote yet: dumps are downloaded in the browser until you connect one', {
            optional: true,
            fixes: [{ action: 'machine.openTerminal', input: { run: 'rclone-drive' }, label: 'Connect Google Drive in a terminal', confirm: 'Opens a terminal running rclone config create gdrive drive scope=drive.readonly: rclone shows a Google sign-in link, you approve in your browser, and the remote can then only read your Drive, for dumps.' }],
          })
        : warn('tools.rclone', 'rclone', 'not installed: dumps from Google Drive are downloaded in the browser instead', {
            optional: true,
            fixes: [{ action: 'tools.install', input: { tool: 'rclone' }, label: 'Install rclone', confirm: `Downloads rclone ${TOOLS.rclone.version} from GitHub, checks it against its SHA-256 and keeps it in the panel's folder, linked into ~/.local/bin: no root, no apt source. Undo on the job removes it.` }],
          }),
  ];
}

/** The GitLab CLI, one line per GitLab host in use; optional, as cloning only needs SSH. */
function gitlabCliChecks(glab: NonNullable<Awaited<ReturnType<typeof glabOverview>>>): Check[] {
  const min = MIN_GLAB.join('.');
  if (!glab.installed) {
    return [
      warn('access.gitlabCli', 'GitLab CLI', 'not installed: it lists the projects of your GitLab groups', {
        optional: true,
        fixes: [{ action: 'tools.install', input: { tool: 'glab' }, label: 'Install the GitLab CLI', confirm: `Downloads glab ${TOOLS.glab.version} from GitLab, checks it against its SHA-256 and keeps it in the panel's folder, linked into ~/.local/bin: no root, no apt source. Undo on the job removes it.` }],
      }),
    ];
  }
  const version = glab.version ? `glab ${glab.version}` : 'glab';
  if (glab.version && glabTooOld(glab.version)) {
    return [warn('access.gitlabCli', 'GitLab CLI', `${version} is older than ${min}, the oldest the panel works with: update it`, { optional: true })];
  }
  return glab.hosts.map((h) =>
    h.signedIn
      ? ok(`access.gitlabCli.${h.host}`, `GitLab CLI on ${h.host}`, `${version}, signed in as ${h.user}; it lists your groups and their projects`, { optional: true })
      : warn(`access.gitlabCli.${h.host}`, `GitLab CLI on ${h.host}`, `${version}, ${h.problem ?? 'not signed in'}: it lists the projects of your groups`, {
          optional: true,
          fixes: [
            { action: 'machine.openTerminal', input: { run: 'glab-login', host: h.host }, label: 'Sign in in a terminal' },
            {
              action: 'gitlab.signIn',
              input: { host: h.host },
              label: 'Sign in with a token',
              secret: {
                field: 'token',
                label: `A personal access token for ${h.host}`,
                hint: 'Make one on GitLab with the read_api scope (enough to list your groups and projects). It goes to glab once, which keeps it; the panel never saves it.',
                link: { href: `https://${h.host}/-/user_settings/personal_access_tokens?name=devmagic-panel&scopes=read_api`, text: `Make a token on ${h.host}` },
              },
            },
          ],
        }),
  );
}

/** How the panel clones GitHub repos: over HTTPS through the GitHub CLI when that is on, else over SSH with your key. */
async function githubAccessCheck(ctx: CheckContext, sshText: string): Promise<Check> {
  const label = 'GitHub access';
  const overSsh = /successfully authenticated/i.test(sshText);
  if (githubHttpsOn()) {
    const gh = await ghStatus(ctx.exec);
    return gh.signedIn
      ? ok('access.github', label, `clones over HTTPS through the GitHub CLI, signed in as ${gh.user}`)
      : warn('access.github', label, `clones over HTTPS through the GitHub CLI, which ${gh.installed ? 'is not signed in' : 'is not installed'}: cloning private repos will fail`, {
          fixes: [gh.installed ? SIGN_IN_GITHUB : INSTALL_GH, ...(overSsh ? [CLONE_SSH] : [])],
        });
  }
  const key = githubSshKey();
  if (overSsh) return ok('access.github', label, `over SSH${key ? ` with ${basename(key)}` : ''}: ${firstLine(sshText.replace(/^\s+/, ''))}`);
  const gh = await ghStatus(ctx.exec);
  return warn(
    'access.github',
    label,
    `git over SSH cannot sign in to GitHub, so cloning private repos will fail: ${gh.signedIn ? 'clone through the GitHub CLI instead' : 'sign in to GitHub with the GitHub CLI (no SSH key needed), or add your SSH key to GitHub'}`,
    { fixes: [gh.signedIn ? CLONE_HTTPS : gh.installed ? SIGN_IN_GITHUB : INSTALL_GH] },
  );
}

/** `ssh -T git@<host>`: no shell, never a prompt, a new host key taken once. */
function sshHello(ctx: CheckContext, host: string, key: string | null = null) {
  return ctx.exec('ssh', ['-T', ...(key ? ['-i', key] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', `git@${host}`], { timeoutMs: 10_000 });
}

async function accessChecks(ctx: CheckContext): Promise<Check[]> {
  const gitlabHosts = (await ctx.gitlabHosts?.().catch(() => [])) ?? [];
  const [sudo, ssh, ...gitlab] = await Promise.all([ctx.exec('sudo', ['-n', '-l', ctx.dmpRoot]), sshHello(ctx, 'github.com', githubSshKey()), ...gitlabHosts.map((h) => sshHello(ctx, h))]);
  const sshText = `${ssh.stdout}\n${ssh.stderr}`;
  const github = await githubAccessCheck(ctx, sshText);
  return [
    sudo.code === 0
      ? ok('access.sudo', 'Passwordless dmp-root', 'the sudoers rule is in place')
      : fail('access.sudo', 'Passwordless dmp-root', 'sudo asks for a password, run install.sh'),
    github,
    // GitLab answers "Welcome to GitLab, @alex!"; a warn at most, since only the sites from that host need it.
    ...gitlabHosts.map((host, i) => {
      const r = gitlab[i];
      const text = r ? `${r.stdout}\n${r.stderr}` : '';
      if (gitlabHttpsHosts().includes(host)) return ok(`access.gitlab.${host}`, `${host} access`, 'clones over HTTPS through the GitLab CLI (SSH was refused there)', { optional: true });
      return /welcome to gitlab/i.test(text)
        ? ok(`access.gitlab.${host}`, `${host} access`, `over SSH: ${firstLine(text.replace(/^\s+/, ''))}`, { optional: true })
        : warn(`access.gitlab.${host}`, `${host} access`, `SSH is refused: sign the GitLab CLI in to ${host} and the panel reads its repos over HTTPS through it the first time SSH is refused, or add your SSH key there`, { optional: true });
    }),
  ];
}

// ── starting after a restart ─────────────────────────────────

/**
 * On an encrypted home (eCryptfs), systemd looks for the user services before
 * login unlocks the folder, so the panel and Mailpit start only through the
 * desktop's autostart entry. Shown on such a home, or when there is an entry.
 */
function autostartChecks(ctx: CheckContext): Check[] {
  const { home } = ctx.paths;
  const entry = readAutostart(home);
  if (!entry && !encryptedHome(home, ctx.paths.mounts)) return [];
  const label = 'Starts again after a restart';
  const file = '~/.config/autostart/devmagic-panel.desktop';
  const fixes = (text: string): CheckFix[] => [{ action: 'panel.autostart', input: {}, label: text }];
  if (!entry) {
    return [
      warn('panel.autostart', label, `your home folder is encrypted (eCryptfs), so systemd cannot start the panel or Mailpit at boot or login: after a restart https://${ctx.config.PANEL_DOMAIN} shows Service Unavailable until you start them`, {
        fixes: fixes('Start them after login'),
      }),
    ];
  }
  const gone = missingPaths(entry);
  if (gone.length) return [warn('panel.autostart', label, `${file} runs ${gone[0]}, which is gone`, { fixes: fixes('Write it again') })];
  if (entry.off) return [warn('panel.autostart', label, `${file} is turned off in your startup applications`, { fixes: fixes('Turn it on again') })];
  return [ok('panel.autostart', label, `${file} starts the panel and Mailpit when you log in`)];
}

// ── WSL on Windows ───────────────────────────────────────────

/**
 * Under WSL 2 only: what install.sh sets so the panel works from Windows.
 * Each is put right by updating the panel (install.sh runs again) or running
 * the installer; the panel itself never writes wsl.conf or ports.conf.
 */
async function wslChecks(ctx: CheckContext): Promise<Check[]> {
  const paths = ctx.paths.wsl ?? {};
  if (wslVersion(paths) !== 2) return [];
  const again = 'update the panel, or run its installer again';
  const checks: Check[] = [];

  checks.push(
    hostsKept(paths)
      ? ok('wsl.hosts', 'WSL keeps /etc/hosts', 'generateHosts = false in /etc/wsl.conf')
      : fail('wsl.hosts', 'WSL keeps /etc/hosts', `WSL writes /etc/hosts anew at every start (no generateHosts = false in /etc/wsl.conf), so ${ctx.config.PANEL_DOMAIN} and every site drop out of it: ${again}`),
  );

  const address = ctx.config.APACHE_ADDRESS;
  const off = listensOffAddress(join(dirname(ctx.config.APACHE_SITES_AVAILABLE), 'ports.conf'), address);
  checks.push(
    off.length === 0
      ? ok('wsl.apacheAddress', `Apache on ${address}`, `Windows reaches Apache on ${address}, where the hosts lines point`)
      : warn('wsl.apacheAddress', `Apache on ${address}`, `ports.conf has ${off[0]}: WSL forwards Apache on every address to Windows on ::1 only, so names on ${address} in Windows' hosts file do not reach it: ${again}`),
  );

  const linger = await ctx.exec('loginctl', ['show-user', ctx.config.PANEL_USER, '-p', 'Linger', '--value']);
  checks.push(
    linger.stdout.trim() === 'yes'
      ? ok('wsl.linger', 'Keeps running when WSL windows close', `lingering is on for ${ctx.config.PANEL_USER}`)
      : warn('wsl.linger', 'Keeps running when WSL windows close', `lingering is off for ${ctx.config.PANEL_USER}, so closing the last WSL window stops the panel and its jobs: ${again}`),
  );

  if (ctx.config.WEB_DIR.startsWith('/mnt/')) {
    checks.push(fail('wsl.webDir', 'Sites on WSL\'s own disk', `WEB_DIR is ${ctx.config.WEB_DIR}, on a Windows drive, which is 20 to 350 times slower from WSL: keep sites on WSL's own disk, like /var/www`));
  } else {
    checks.push(ok('wsl.webDir', 'Sites on WSL\'s own disk', ctx.config.WEB_DIR));
  }

  const interop = interopOn(paths);
  if (interop) {
    checks.push(ok('wsl.interop', 'Windows programs', 'the panel can start Windows programs, like Windows Terminal', { optional: true }));
  } else if (interopDisabled(paths)) {
    checks.push(warn('wsl.interop', 'Windows programs', 'turned off in /etc/wsl.conf ([interop] enabled = false): the panel cannot do the Windows steps; take that line out and restart the distro', { optional: true }));
  } else {
    // Another distro starting can take WSL's registration away from this one (finding N); dmp-root puts it back.
    checks.push(
      warn('wsl.interop', 'Windows programs', 'cannot be started from this distro: another WSL distro starting took the registration away, which WSL leaves that way until this distro restarts', {
        optional: true,
        fixes: [{ action: 'wsl.repairInterop', input: {}, label: 'Register it again' }],
      }),
    );
  }
  if (interop) checks.push(...(await windowsSideChecks(ctx)));
  return checks;
}

/** The Windows side, from the helper's read-only status: what get.ps1 sets up, each with its fix. */
async function windowsSideChecks(ctx: CheckContext): Promise<Check[]> {
  const paths = ctx.paths.windows ?? {};
  if (!helperInstalled(paths)) {
    return [warn('windows.helper', 'Windows helper', 'not installed in C:\\Program Files\\devmagic-panel: run get.ps1 in Windows (docs/installation.md, Windows), which sets up the hosts lines, the CA and the logon task')];
  }
  const status = await windowsStatus(ctx.exec, paths);
  if (!status) return [warn('windows.helper', 'Windows helper', 'did not answer: run get.ps1 in Windows again to repair it')];
  const fix = (action: 'windows.hostsSync' | 'windows.trustCa' | 'windows.autostart' | 'windows.portproxy' | 'windows.update', label: string): CheckFix[] => [{ action, input: {}, label }];
  const checks: Check[] = [];

  const want = windowsHostsPairs(ctx.config);
  const have = new Set(windowsBlockPairs(status));
  const missing = want.filter((p) => !have.has(p));
  const extra = [...have].filter((p) => !want.includes(p));
  checks.push(
    missing.length === 0 && extra.length === 0
      ? ok('windows.hosts', "Windows' hosts file", `${want.length} name(s), the same as this distro's`)
      : warn('windows.hosts', "Windows' hosts file", `${missing.length ? `missing ${missing.map((p) => p.split('=')[0]).join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `left over ${extra.map((p) => p.split('=')[0]).join(', ')}` : ''}: Windows' browsers do not reach those sites as they should`, {
          fixes: [{ ...fix('windows.hostsSync', 'Copy them to Windows')[0]!, confirm: 'Windows asks to run the helper as admin (UAC) and keeps a copy of its hosts file first.' }],
        }),
  );

  checks.push(
    status.ca.trusted
      ? ok('windows.ca', 'Local CA in Windows', `trusted for your Windows user (${status.ca.thumbprint})`)
      : warn('windows.ca', 'Local CA in Windows', status.ca.readable ? "not trusted for your Windows user: Windows' browsers warn about every site" : `Windows cannot read it (${status.ca.error ?? 'no CA'})`, {
          ...(status.ca.readable ? { fixes: fix('windows.trustCa', 'Trust it in Windows') } : {}),
        }),
  );

  checks.push(
    status.logonTask.installed
      ? ok('windows.logonTask', 'Runs after Windows logon', 'a logon task keeps this distro running without a window')
      : warn('windows.logonTask', 'Runs after Windows logon', 'no logon task: WSL stops this distro a few minutes after its last window closes, the panel and every site with it', {
          fixes: fix('windows.autostart', 'Add the logon task'),
        }),
  );

  // The Windows helper this release goes with (release.json), against the one Windows has.
  const release = ctx.self ? readRelease(ctx.self.repo) : null;
  const current = windowsPartCurrent(status, release);
  if (release && current !== null) {
    const recorded = release.windowsPart ? status.app?.part : status.helper?.sha256;
    checks.push(
      current
        ? ok('windows.part', 'Windows part', `the helper, setup and shortcuts of ${release.name}`)
        : warn('windows.part', 'Windows part', recorded ? `the Windows part (helper, setup, shortcuts) is from another release than this panel (${release.name}): update it, so the Windows side works as this release expects` : `the Windows part (helper, setup, shortcuts) is older than this panel (${release.name}): update it, so the Windows side works as this release expects`, {
            fixes: [{ action: 'windows.update', input: {}, label: 'Update the Windows part', confirm: `The helper downloads the Windows setup of ${release.name} from GitHub, checks it and runs it without a window; it installs ${release.name} again in the distro, which restarts the panel for a minute.` }],
          }),
    );
  }

  // nginx's sites reach Windows through two relays of 127.0.0.2; none are needed without nginx.
  if (status.portproxy) {
    const wanted = nginxSetUp(ctx.config);
    const want = windowsPortproxyRules(ctx.config);
    const held = windowsPortproxyHeld(status);
    const relays = `127.0.0.2:80 and :443 to nginx on 127.0.0.1:${ctx.config.NGINX_WSL_HTTP_PORT} and :${ctx.config.NGINX_WSL_HTTPS_PORT}`;
    const confirm = 'Windows asks to run the helper as admin (UAC).';
    if (wanted && want.every((r) => held.includes(r)) && held.length === want.length) {
      checks.push(
        status.portproxy.ipHelper === 'Running'
          ? ok('windows.portproxy', 'nginx reaches Windows', `Windows relays ${relays}`)
          : warn('windows.portproxy', 'nginx reaches Windows', `the relays are there, but Windows' IP Helper service is ${status.portproxy.ipHelper}: start it in Windows (services.msc, IP Helper), else sites on nginx do not open in Windows`),
      );
    } else if (wanted) {
      checks.push(warn('windows.portproxy', 'nginx reaches Windows', `Windows does not relay ${relays}: sites on nginx do not open in Windows' browsers`, {
        fixes: [{ ...fix('windows.portproxy', 'Relay them in Windows')[0]!, confirm }],
      }));
    } else if (held.length > 0) {
      checks.push(warn('windows.portproxy', 'nginx reaches Windows', `nginx is not set up, but Windows still relays ${held.map((r) => r.split('=')[0]).join(' and ')}`, {
        fixes: [{ ...fix('windows.portproxy', 'Remove the relays')[0]!, confirm }],
      }));
    }
  }

  // A setting you chose, not a fault: shown for what it means, never as a warning.
  if (status.uac.enabled && !status.uac.promptsAdmins) {
    checks.push(ok('windows.uac', 'UAC', "set to never notify: Windows gives admin rights without asking, to any program you run, this distro included. The panel works the same either way", { optional: true }));
  }
  return checks;
}

// ── report ───────────────────────────────────────────────────

export async function checkEnvironment(ctx: CheckContext, now: () => number = Date.now): Promise<EnvironmentReport> {
  const started = now();
  const groups = await Promise.all([
    apacheChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'apache' as const }))),
    nginxChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'nginx' as const }))),
    databaseChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'database' as const }))),
    phpChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'php' as const }))),
    toolChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'tools' as const }))),
    certificateChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'certificates' as const }))),
    Promise.resolve(hostsChecks(ctx).map((r) => ({ ...r, group: 'hosts' as const }))),
    accessChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'access' as const }))),
    organizationChecks(ctx).then((c) => c.map((r) => ({ ...r, group: r.id.startsWith('tools.') ? ('tools' as const) : ('access' as const) }))),
    Promise.resolve(
      ctx.self ? selfChecks({ ...ctx.self, stateDir: ctx.config.STATE_DIR, dmpRoot: ctx.dmpRoot }).map((r) => ({ ...r, group: 'panel' as const })) : [],
    ),
    Promise.resolve(autostartChecks(ctx).map((r) => ({ ...r, group: 'panel' as const }))),
    wslChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'wsl' as const }))),
  ]);
  return {
    checkedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    checks: groups.flat(),
  };
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CheckFix, CheckResult, EnvironmentReport } from '@devmagic-panel/shared';
import { APACHE_MODULES, isLocalName, MAILPIT_SMTP, MAILPIT_WEB } from '@devmagic-panel/shared';
import { encryptedHome, missingPaths, readAutostart } from './autostart.js';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import { claudeStatus } from './org/claude-code.js';
import { rcloneRemote } from './org/dumps.js';
import { ghStatus } from './repo-hosts/github.js';
import { glabOverview } from './repo-hosts/index.js';
import { glabTooOld, MIN_GLAB } from './repo-hosts/gitlab.js';
import { runRoot } from './exec.js';
import { installedCores, readWpcoreConfig } from './wpcore.js';
import type { Secrets } from './secrets.js';
import { selfChecks } from './self-check.js';

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

// ── Database ─────────────────────────────────────────────────

/**
 * Connects with the mysql client the panel uses for everything else, not
 * mysqladmin: mysqladmin refuses client options it does not know, like a
 * max_allowed_packet under [client] in my.cnf.
 */
export function pingMysql(exec: Executor, account: NonNullable<Secrets['mysql']>): Promise<ExecResult> {
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
  ];
}

// ── PHP and tools ────────────────────────────────────────────

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
  results.push(
    modules.has('imagick')
      ? ok('php.imagick', 'Imagick', 'installed', { recommended: true })
      : warn('php.imagick', 'Imagick', 'not installed, WordPress falls back to GD (apt install php-imagick)', { recommended: true }),
  );
  results.push(
    modules.has('xdebug')
      ? ok('php.xdebug', 'Xdebug', 'installed', { optional: true })
      : warn('php.xdebug', 'Xdebug', 'not installed', { optional: true }),
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
    wp.code === 0 ? ok('tools.wpcli', 'WP-CLI', wp.stdout.trim()) : fail('tools.wpcli', 'WP-CLI', 'wp is not installed'),
    wpcoreCheck(ctx),
    git.code === 0
      ? ok('tools.git', 'git', firstLine(git.stdout))
      : fail('tools.git', 'git', 'not installed: installs from a repo and updates over git need it (apt install git)'),
    unzip.code === 0
      ? ok('tools.unzip', 'unzip', firstLine(unzip.stdout).split(' of ')[0] ?? 'installed')
      : fail('tools.unzip', 'unzip', 'not installed: zipped database dumps need it (apt install unzip)'),
    composer.code === 0
      ? ok('tools.composer', 'Composer', firstLine(composer.stdout).replace(/ \d{4}-\d\d-\d\d.*$/, ''), { recommended: true })
      : warn('tools.composer', 'Composer', 'not installed: repos with a composer.json need it to install their dependencies (apt install composer)', { recommended: true }),
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
      : warn('tools.phpmyadmin', 'phpMyAdmin', 'not installed', { optional: true }),
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
  if (stores.length === 0) {
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
      const m = /^\s*Server(?:Name|Alias)\s+(.+)$/i.exec(line);
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
  const sites = enabledSiteNames(config.APACHE_SITES_ENABLED);
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

/** What installing a site from an organization needs; all optional, since the rest of the panel works without. */
async function organizationChecks(ctx: CheckContext): Promise<Check[]> {
  const gitlabHosts = (await ctx.gitlabHosts?.().catch(() => [])) ?? [];
  const [claude, gh, glab, rclone] = await Promise.all([
    claudeStatus(ctx.exec, ctx.paths.home, ctx.paths.searchPath ?? process.env.PATH ?? ''),
    ghStatus(ctx.exec),
    gitlabHosts.length ? glabOverview(ctx.exec, gitlabHosts) : null,
    rcloneRemote(ctx.exec),
  ]);
  const where = `Claude Code ${claude.version ?? ''} at ${claude.path ?? ''}`;
  return [
    !claude.found
      ? warn('access.claudeCode', 'Claude Code', 'not found: install it and sign in with claude auth login to install sites from an organization', { optional: true })
      : !claude.signedIn
        ? warn('access.claudeCode', 'Claude Code', `${where}, not signed in: run claude auth login in a terminal`, { optional: true })
        : !claude.claudeAi
          ? warn('access.claudeCode', 'Claude Code', `${where}, signed in without claude.ai: it reads repos, but Asana and Google links need claude auth login with your claude.ai account`, { optional: true })
          : ok('access.claudeCode', 'Claude Code', `${where}, signed in with claude.ai; it reads repos and their Asana and Google links`, { optional: true }),
    gh.signedIn
      ? ok('access.githubCli', 'GitHub CLI', `signed in as ${gh.user}; it lists your organizations and their repos`, { optional: true })
      : warn('access.githubCli', 'GitHub CLI', `${gh.problem ?? 'not set up'}: it lists the repos of your organizations`, { optional: true }),
    ...(glab ? gitlabCliChecks(glab) : []),
    rclone.remote
      ? ok('tools.rclone', 'rclone', `downloads database dumps from Google Drive through the ${rclone.remote} remote`, { optional: true })
      : warn('tools.rclone', 'rclone', rclone.installed ? 'no Google Drive remote: run rclone config once, or download dumps in the browser' : 'not installed: dumps from Google Drive are downloaded in the browser instead', { optional: true }),
  ];
}

/** The GitLab CLI, one line per GitLab host in use; optional, as cloning only needs SSH. */
function gitlabCliChecks(glab: NonNullable<Awaited<ReturnType<typeof glabOverview>>>): Check[] {
  const min = MIN_GLAB.join('.');
  if (!glab.installed) {
    return [warn('access.gitlabCli', 'GitLab CLI', `not installed: it lists the projects of your GitLab groups. Install glab ${min} or newer (sudo apt install glab where your release has it), then sign in with glab auth login`, { optional: true })];
  }
  const version = glab.version ? `glab ${glab.version}` : 'glab';
  if (glab.version && glabTooOld(glab.version)) {
    return [warn('access.gitlabCli', 'GitLab CLI', `${version} is older than ${min}, the oldest the panel works with: update it`, { optional: true })];
  }
  return glab.hosts.map((h) =>
    h.signedIn
      ? ok(`access.gitlabCli.${h.host}`, `GitLab CLI on ${h.host}`, `${version}, signed in as ${h.user}; it lists your groups and their projects`, { optional: true })
      : warn(`access.gitlabCli.${h.host}`, `GitLab CLI on ${h.host}`, `${version}, ${h.problem ?? 'not signed in'}: it lists the projects of your groups`, { optional: true }),
  );
}

/** `ssh -T git@<host>`: no shell, never a prompt, a new host key taken once. */
function sshHello(ctx: CheckContext, host: string) {
  return ctx.exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', `git@${host}`], { timeoutMs: 10_000 });
}

async function accessChecks(ctx: CheckContext): Promise<Check[]> {
  const gitlabHosts = (await ctx.gitlabHosts?.().catch(() => [])) ?? [];
  const [sudo, ssh, ...gitlab] = await Promise.all([ctx.exec('sudo', ['-n', '-l', ctx.dmpRoot]), sshHello(ctx, 'github.com'), ...gitlabHosts.map((h) => sshHello(ctx, h))]);
  const sshText = `${ssh.stdout}\n${ssh.stderr}`;
  return [
    sudo.code === 0
      ? ok('access.sudo', 'Passwordless dmp-root', 'the sudoers rule is in place')
      : fail('access.sudo', 'Passwordless dmp-root', 'sudo asks for a password, run install.sh'),
    /successfully authenticated/i.test(sshText)
      ? ok('access.github', 'GitHub over SSH', firstLine(sshText.replace(/^\s+/, '')))
      : warn('access.github', 'GitHub over SSH', 'cannot authenticate, cloning private repos will fail'),
    // GitLab answers "Welcome to GitLab, @alex!"; a warn at most, since only the sites from that host need it.
    ...gitlabHosts.map((host, i) => {
      const r = gitlab[i];
      const text = r ? `${r.stdout}\n${r.stderr}` : '';
      return /welcome to gitlab/i.test(text)
        ? ok(`access.gitlab.${host}`, `${host} over SSH`, firstLine(text.replace(/^\s+/, '')), { optional: true })
        : warn(`access.gitlab.${host}`, `${host} over SSH`, `cannot authenticate: add your SSH key to ${host}, or cloning its private repos will fail`, { optional: true });
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

// ── report ───────────────────────────────────────────────────

export async function checkEnvironment(ctx: CheckContext, now: () => number = Date.now): Promise<EnvironmentReport> {
  const started = now();
  const groups = await Promise.all([
    apacheChecks(ctx).then((c) => c.map((r) => ({ ...r, group: 'apache' as const }))),
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
  ]);
  return {
    checkedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    checks: groups.flat(),
  };
}

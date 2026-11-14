import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeveloperReport, FolderEntry, FolderListing, InstalledPath, ServiceState } from '@devmagic-panel/shared';
import { FOLDER_ENTRIES } from '@devmagic-panel/shared';
import { autostartFile } from './autostart.js';
import type { SystemConfig } from './config.js';
import type { Executor } from './exec.js';
import { readRelease } from './update.js';
import { CRON_BEGIN, CRON_END } from './cron.js';
import { installedVersions } from './php/versions.js';
import { VHOST_MARKER } from './sites/vhost.js';

/**
 * What the hidden Developer options show: versions, the services, config.env,
 * every file install.sh put on the machine (its root-owned list), the
 * panel's own files, and the install and update logs.
 */
export interface DeveloperContext {
  config: SystemConfig;
  exec: Executor;
  version: string;
  home: string;
  /** The panel's data folder: run history, uploads, Mailpit. */
  dataDir: string;
  configDir: string;
  logsDir: string;
  /** How many jobs are queued or running now. */
  runningJobs?: () => number;
  /** The MySQL accounts the panel signs in with, by user and host only: never a password. */
  mysqlAccounts?: () => Array<{ user: string; host: string; role: 'admin' | 'read-only' }>;
}

type Unit = { units: string[]; label: string; scope: 'user' | 'system' };

/**
 * The units the panel needs or uses: its own and Mailpit (user services),
 * Apache, MySQL or MariaDB, nginx (next to Apache, once set up), cron (the
 * panel's crontab tasks) and PHP-FPM of each version installed with it.
 */
const UNITS: Unit[] = [
  { units: ['devmagic-panel.service'], label: 'Panel', scope: 'user' },
  { units: ['devmagic-panel-mailpit.service'], label: 'Mailpit', scope: 'user' },
  { units: ['apache2.service'], label: 'Apache', scope: 'system' },
  { units: ['mysql.service', 'mariadb.service'], label: 'MySQL', scope: 'system' },
  { units: ['nginx.service'], label: 'nginx', scope: 'system' },
  { units: ['cron.service'], label: 'cron', scope: 'system' },
];

/** PHP-FPM of each version that has it: the pools and the default PHP run through them. */
function fpmUnits(config: SystemConfig): Unit[] {
  try {
    return installedVersions(config).filter((v) => v.sapis.includes('fpm')).map((v) => ({ units: [`php${v.version}-fpm.service`], label: `PHP ${v.version} FPM`, scope: 'system' as const }));
  } catch {
    return [];
  }
}

/** systemctl show's KEY=value lines, one block per unit. */
export function parseUnitStates(text: string): Array<Record<string, string>> {
  return text
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split('\n').flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : []))))
    .filter((b) => Object.keys(b).length > 0);
}

async function serviceStates(exec: Executor, config: SystemConfig): Promise<ServiceState[]> {
  return Promise.all(
    [...UNITS, ...fpmUnits(config)].map(async ({ units, label, scope }): Promise<ServiceState> => {
      const r = await exec('systemctl', [...(scope === 'user' ? ['--user'] : []), 'show', '--timestamp=unix', '-p', 'Id,LoadState,ActiveState,UnitFileState,ActiveEnterTimestamp', ...units], { timeoutMs: 10_000 });
      const found = parseUnitStates(r.stdout).find((u) => u.LoadState === 'loaded');
      if (r.code !== 0 || !found) return { unit: units[0] as string, label, scope, active: 'not installed', enabled: '' };
      const since = /^@(\d+)$/.exec(found.ActiveEnterTimestamp ?? '')?.[1];
      return {
        unit: found.Id ?? (units[0] as string),
        label,
        scope,
        active: found.ActiveState ?? 'unknown',
        enabled: found.UnitFileState ?? 'unknown',
        ...(since && since !== '0' && found.ActiveState === 'active' ? { since: new Date(Number(since) * 1000).toISOString() } : {}),
      };
    }),
  );
}

/** The folder the panel runs from: a release (install.sh puts it in ~/.local/share/devmagic-panel/releases), or a checkout in development. */
export const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Install and update logs: install-20261025-104500.log, update-... */
export const LOG_NAME = /^(install|update)-\d{8}-\d{6}\.log$/;
const MAX_LOG = 400 * 1024;

export function defaultLogsDir(home: string): string {
  return join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'devmagic-panel', 'logs');
}

/** One line per thing install.sh put on the machine: kind, path, what uninstall does, what it is. */
export function parseInstalledFiles(text: string): Array<Omit<InstalledPath, 'exists' | 'sizeBytes'>> {
  return text
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .flatMap((line) => {
      const [kind, path, onUninstall, note] = line.split('\t');
      if (!kind || !path || (onUninstall !== 'remove' && onUninstall !== 'ask' && onUninstall !== 'keep')) return [];
      return [{ kind, path, onUninstall, note: note ?? '' }];
    });
}

/** Whether a path is there, and a file's size; folders are not summed, some hold whole repos. */
function look(path: string): { exists: boolean; sizeBytes?: number } {
  if (!path.startsWith('/')) return { exists: true };
  try {
    const st = statSync(path);
    return { exists: true, ...(st.isFile() ? { sizeBytes: st.size } : {}) };
  } catch {
    return { exists: false };
  }
}

const kindOf = (path: string, folders: readonly string[]) => {
  if (folders.includes(path)) return 'dir';
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
};

const trimmed = async (exec: Executor, file: string, args: string[]) => {
  const r = await exec(file, args, { timeoutMs: 10_000 });
  return r.code === 127 ? null : r.stdout.trim() || r.stderr.trim();
};

/** What install.sh says it put on the machine, from its root-owned list; null without one. */
function installedList(ctx: DeveloperContext): Array<Omit<InstalledPath, 'exists' | 'sizeBytes'>> | null {
  const listFile = join(ctx.config.STATE_DIR, 'installed-files');
  return existsSync(listFile) ? parseInstalledFiles(readFileSync(listFile, 'utf8')) : null;
}

/** The panel's own files, made as it runs; secrets.json is listed, never read. */
function ownFiles(ctx: DeveloperContext): Array<[string, string]> {
  const d = (name: string) => join(ctx.dataDir, name);
  const backup = (name: string) => join(ctx.config.BACKUP_DIR, name);
  return [
    [join(ctx.configDir, 'secrets.json'), 'panel password hash, MySQL accounts, the Anthropic key and saved SSH passwords (mode 0600)'],
    [join(ctx.configDir, 'settings.json'), 'assistant settings'],
    [d('panel.db'), 'run history, background task runs, queued proposals and the wizard\'s answers per repo'],
    [d('uploads'), 'database dumps waiting for an install or import'],
    [d('file-uploads'), 'files staged for the Files tab, a day at most'],
    [d('file-trash'), 'what the Files tab deleted, for Undo: 14 days, 1 GB at most'],
    [d('mysql-backups'), 'MySQL\'s settings before the panel changed them, 14 days'],
    [d('profiles'), 'Xdebug profile summaries per site'],
    [d('tools'), 'tools the panel downloaded, like the PHP compatibility check and its cache'],
    [d('cron'), 'what the panel\'s crontab tasks ran, by task'],
    [d('cron.log'), 'the crontab runner\'s log'],
    [d('updates.git'), 'the release cache, when updates come through git'],
    [d('update-status.json'), 'the last check for a new release'],
    [d('update-run.json'), 'an install from the Updates page that is running or just ended'],
    [d('wp-core-status.json'), 'WordPress.org\'s status of each WordPress release, an hour'],
    [d('mailpit'), 'Mailpit, when installed from the panel'],
    [join(ctx.home, '.config', 'systemd', 'user', 'devmagic-panel-mailpit.service'), 'Mailpit\'s systemd user service'],
    [autostartFile(ctx.home), 'starts the panel and Mailpit after login, on an encrypted home folder'],
    [backup('snapshots'), 'database snapshots, yours and the ones the panel takes before a change'],
    [backup('clean'), 'clean copies of databases, without personal data'],
    [backup('row-changes'), 'rows as they were before a change in a table, for Undo: 14 days'],
    [backup('cleanups'), 'what a database clean-up or SQL removed, for Undo: 14 days'],
    [ctx.logsDir, 'install and update logs'],
  ];
}

/** Each file in dir whose name passes test, as full paths; none when the folder cannot be read. */
function filesIn(dir: string, test: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir).filter(test).sort().map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Whether a file's first line is the panel's marker: a config it wrote and keeps. */
function managed(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').split('\n', 1)[0] === VHOST_MARKER;
  } catch {
    return false;
  }
}

/**
 * The files dmp-root wrote outside the panel's folders, as the system has
 * them now: PHP's pools and settings, Apache's and nginx's confs, MySQL's
 * settings and the state dmp-root keeps. Only the ones that are there.
 */
function systemFiles(ctx: DeveloperContext): Array<[string, string]> {
  const c = ctx.config;
  const out: Array<[string, string]> = [];
  for (const version of filesIn(c.PHP_CONF_DIR, (n) => /^\d+\.\d+$/.test(n))) {
    const v = version.slice(c.PHP_CONF_DIR.length + 1);
    for (const sapi of ['fpm', 'apache2', 'cli']) {
      for (const ini of filesIn(join(version, sapi, 'conf.d'), (n) => n === '99-devmagic-panel.ini')) out.push([ini, `PHP ${v} (${sapi}) settings the panel keeps`]);
      for (const ini of filesIn(join(version, sapi, 'conf.d'), (n) => n === '99-devmagic-panel-xdebug.ini')) out.push([ini, `PHP ${v} (${sapi}) Xdebug, when switched on in the panel`]);
    }
    for (const pool of filesIn(join(version, 'fpm', 'pool.d'), (n) => /^dmp-.+\.conf$/.test(n))) out.push([pool, `PHP ${v} FPM pool of ${pool.endsWith('dmp-phpmyadmin.conf') ? 'phpMyAdmin' : 'a site with a PHP of its own'}`]);
  }
  const apache = dirname(c.APACHE_SITES_AVAILABLE);
  for (const [name, note] of [['devmagic-panel-php.conf', 'Apache: which site runs on which PHP-FPM'], ['devmagic-panel-remoteip.conf', 'Apache: trusts the visitor address nginx passes on']] as const) {
    for (const f of filesIn(join(apache, 'conf-available'), (n) => n === name)) out.push([f, note]);
  }
  const nginx = dirname(c.NGINX_SITES_AVAILABLE);
  for (const [name, note] of [['devmagic-panel.conf', 'nginx: the panel\'s setup next to Apache'], ['devmagic-panel-php.conf', 'nginx: the PHP upstream of each site on nginx']] as const) {
    for (const f of filesIn(join(nginx, 'conf.d'), (n) => n === name)) out.push([f, note]);
  }
  for (const f of filesIn(c.NGINX_SITES_AVAILABLE, (n) => n.endsWith('.conf'))) if (managed(f)) out.push([f, 'nginx: a site the panel runs on nginx']);
  for (const sub of ['mysql.conf.d', 'mariadb.conf.d']) for (const f of filesIn(join(c.MYSQL_CONF_DIR, sub), (n) => n === 'zz-devmagic-panel.cnf')) out.push([f, 'MySQL settings changed in the panel']);
  const state: Array<[string, string]> = [
    ['sites', 'the registry of panel-made sites'],
    ['taken-over', 'sites taken over, with their original files and checksums'],
    ['trash', 'deleted and archived sites, 14 days'],
    ['nginx', 'what nginx\'s setup changed, to put back'],
    ['php-default', 'the default PHP version once mod_php is off'],
    ['profiles', 'Xdebug profiles, written by PHP'],
  ];
  for (const [name, note] of state) if (existsSync(join(c.STATE_DIR, name))) out.push([join(c.STATE_DIR, name), note]);
  return out;
}

/** What the panel made that is not a file of its own: its crontab block, its MySQL accounts and the two files it adds to sites. */
async function otherThings(ctx: DeveloperContext): Promise<Array<{ path: string; note: string; exists: boolean; kind: string }>> {
  const cron = await ctx.exec('crontab', ['-l'], { timeoutMs: 10_000 });
  const lines = cron.code === 0 ? cron.stdout.split('\n') : [];
  const begin = lines.indexOf(CRON_BEGIN);
  const tasks = begin < 0 ? 0 : lines.slice(begin + 1).findIndex((l) => l === CRON_END);
  const out: Array<{ path: string; note: string; exists: boolean; kind: string }> = [
    { kind: 'crontab', path: `crontab of ${ctx.config.PANEL_USER}: the devmagic-panel block`, note: begin < 0 ? 'none yet: it appears with the first task' : `the panel's tasks, ${Math.max(0, tasks)} line${tasks === 1 ? '' : 's'}; every other line stays yours`, exists: begin >= 0 },
  ];
  for (const a of ctx.mysqlAccounts?.() ?? []) {
    out.push({ kind: 'account', path: `MySQL account ${a.user}@${a.host}`, note: a.role === 'read-only' ? 'the SQL runner\'s, SELECT and SHOW VIEW only' : a.user === 'devmagic_panel' ? 'the panel\'s admin account, made by setup' : 'the admin account the panel signs in with (yours)', exists: true });
  }
  let login = 0;
  let local = 0;
  for (const site of filesIn(ctx.config.WEB_DIR, () => true)) {
    const mu = join(site, 'wp-content', 'mu-plugins');
    if (existsSync(join(mu, 'devmagic-panel-login.php'))) login += 1;
    if (existsSync(join(mu, 'devmagic-panel-local.php'))) local += 1;
  }
  out.push({ kind: 'mu-plugin', path: 'mu-plugins/devmagic-panel-login.php', note: `the one-time wp-admin login, in ${login} site folder${login === 1 ? '' : 's'}`, exists: login > 0 });
  out.push({ kind: 'mu-plugin', path: 'mu-plugins/devmagic-panel-local.php', note: `Local mode, in ${local} site folder${local === 1 ? '' : 's'}`, exists: local > 0 });
  return out;
}

export async function developerReport(ctx: DeveloperContext): Promise<DeveloperReport> {
  const listed = installedList(ctx);
  // A release says what it is; a checkout asks git.
  const release = readRelease(REPO_DIR);
  const [commit, services, linger] = await Promise.all([
    release ? `${release.name} (${release.commit.slice(0, 9)})` : trimmed(ctx.exec, 'git', ['-C', REPO_DIR, 'describe', '--always', '--dirty']),
    serviceStates(ctx.exec, ctx.config),
    trimmed(ctx.exec, 'loginctl', ['show-user', ctx.config.PANEL_USER, '-p', 'Linger', '--value']),
  ]);
  const own = ownFiles(ctx);
  // The panel's folders that are there open in the tree.
  const folders = folderRoots(ctx);
  let logs: DeveloperReport['logs'] = [];
  if (existsSync(ctx.logsDir)) {
    logs = readdirSync(ctx.logsDir)
      .filter((name) => LOG_NAME.test(name))
      .map((name) => {
        const st = statSync(join(ctx.logsDir, name));
        return { name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  return {
    version: ctx.version,
    ...(commit ? { commit } : {}),
    node: process.version,
    repo: REPO_DIR,
    server: {
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      memoryBytes: process.memoryUsage().rss,
      nodePath: process.execPath,
      port: ctx.config.PANEL_PORT,
      runningJobs: ctx.runningJobs?.() ?? 0,
    },
    services,
    linger: linger === 'yes' ? true : linger === 'no' ? false : null,
    config: Object.entries(ctx.config).map(([key, value]) => ({ key, value: String(value) })),
    installedFiles: listed ? listed.map((p) => ({ ...p, ...look(p.path) })) : null,
    panelFiles: [
      ...own.map(([path, note]) => ({ path, note, ...look(path), kind: kindOf(path, folders), group: 'data' as const })),
      ...systemFiles(ctx).map(([path, note]) => ({ path, note, ...look(path), kind: kindOf(path, folders), group: 'system' as const })),
      ...(await otherThings(ctx)).map((t) => ({ ...t, group: 'other' as const })),
    ],
    logs,
  };
}

/**
 * The folders the Developer options may open: the folders and links
 * install.sh listed, and the panel's own folders. Browser certificate stores
 * are listed but never opened.
 */
export function folderRoots(ctx: DeveloperContext): string[] {
  const listed = (installedList(ctx) ?? []).filter((p) => (p.kind === 'dir' || p.kind === 'link') && p.path.startsWith('/')).map((p) => p.path);
  const own = ownFiles(ctx).map(([path]) => path).filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  return [...new Set([...listed, ...own])];
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const realOf = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const whyNot = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? 'only root can list this' : code === 'ENOENT' ? 'not there any more' : code === 'ENOTDIR' ? 'not a folder' : (error as Error).message;
};

function entryOf(dir: string, name: string): FolderEntry {
  const full = join(dir, name);
  try {
    const st = lstatSync(full);
    const kind: FolderEntry['kind'] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other';
    const entry: FolderEntry = { name, kind, modifiedAt: st.mtime.toISOString(), ...(kind === 'file' ? { sizeBytes: st.size } : {}) };
    if (kind !== 'link') return entry;
    let targetKind: FolderEntry['targetKind'] = 'missing';
    try {
      targetKind = statSync(full).isDirectory() ? 'dir' : 'file';
    } catch {
      // a link to nothing
    }
    return { ...entry, target: readlinkSync(full), targetKind };
  } catch {
    return { name, kind: 'other' };
  }
}

/**
 * One folder's entries for the Developer options, read when you open it:
 * names, kinds, sizes and dates, folders first, never a file's contents.
 * Only a folder within folderRoots opens, after following links, so a link
 * cannot lead out of them; null for any other path.
 */
export function listFolder(ctx: DeveloperContext, path: string, max = FOLDER_ENTRIES): FolderListing | null {
  if (!path.startsWith('/') || path.includes('\0') || path.length > 4096) return null;
  const asked = posix.normalize(path).replace(/\/$/, '') || '/';
  const roots = folderRoots(ctx);
  const real = realOf(asked);
  if (real === null) {
    // Gone, or behind a folder the panel cannot enter: said so only for a path within the roots as written.
    if (!roots.some((root) => within(asked, root))) return null;
    try {
      realpathSync(asked);
    } catch (error) {
      return { path: asked, entries: [], more: 0, error: whyNot(error) };
    }
  }
  if (real === null || !roots.flatMap((root) => realOf(root) ?? []).some((root) => within(real, root))) return null;
  try {
    const names = readdirSync(real, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => d.name);
    return { path: asked, entries: names.slice(0, max).map((name) => entryOf(real, name)), more: Math.max(0, names.length - max) };
  } catch (error) {
    return { path: asked, entries: [], more: 0, error: whyNot(error) };
  }
}

/** The end of one log, by its name only. */
export function readLog(logsDir: string, name: string): string | null {
  if (!LOG_NAME.test(name)) return null;
  const file = join(logsDir, name);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return text.length > MAX_LOG ? `...\n${text.slice(-MAX_LOG)}` : text;
}

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

/**
 * The journal without the request lines every poll writes: systemd's own
 * start and stop lines stay, and the panel's JSON log lines become
 * "time level message".
 */
export function formatJournal(text: string, keep = 300): string {
  const lines = text.split('\n').flatMap((line) => {
    const m = /^(\S+) \S+ [^:]+: (\{.*\})$/.exec(line);
    if (!m) return line.trim() ? [line] : [];
    try {
      const entry = JSON.parse(m[2] as string) as { level?: number; msg?: string; reqId?: string; err?: { message?: string } };
      if (entry.reqId && (entry.level ?? 30) <= 30) return [];
      return [`${m[1]} ${LEVELS[entry.level ?? 30] ?? entry.level} ${entry.msg ?? ''}${entry.err?.message ? `: ${entry.err.message}` : ''}`];
    } catch {
      return [line];
    }
  });
  return lines.slice(-keep).join('\n');
}

/** The panel service's own journal: starts, stops, warnings and errors. */
export async function startupLog(exec: Executor): Promise<string> {
  const r = await exec('journalctl', ['--user', '-u', 'devmagic-panel.service', '-n', '5000', '--no-pager', '-o', 'short-iso'], { timeoutMs: 15_000 });
  return r.code === 0 ? formatJournal(r.stdout) || 'Nothing logged yet.' : r.stderr.trim() || 'journalctl could not read the journal';
}

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeveloperReport, FolderEntry, FolderListing, InstalledPath, ServiceState } from '@devmagic-panel/shared';
import { FOLDER_ENTRIES } from '@devmagic-panel/shared';
import { autostartFile } from './autostart.js';
import type { SystemConfig } from './config.js';
import type { Executor } from './exec.js';
import { readRelease } from './update.js';

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
}

/** The units the panel needs: its own and Mailpit (user services), Apache and MySQL or MariaDB (system ones). */
const UNITS: Array<{ units: string[]; label: string; scope: 'user' | 'system' }> = [
  { units: ['devmagic-panel.service'], label: 'Panel', scope: 'user' },
  { units: ['devmagic-panel-mailpit.service'], label: 'Mailpit', scope: 'user' },
  { units: ['apache2.service'], label: 'Apache', scope: 'system' },
  { units: ['mysql.service', 'mariadb.service'], label: 'MySQL', scope: 'system' },
];

/** systemctl show's KEY=value lines, one block per unit. */
export function parseUnitStates(text: string): Array<Record<string, string>> {
  return text
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split('\n').flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : []))))
    .filter((b) => Object.keys(b).length > 0);
}

async function serviceStates(exec: Executor): Promise<ServiceState[]> {
  return Promise.all(
    UNITS.map(async ({ units, label, scope }): Promise<ServiceState> => {
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
  return [
    [join(ctx.configDir, 'secrets.json'), 'panel password hash, MySQL admin account, the Anthropic key and saved SSH passwords (mode 0600)'],
    [join(ctx.configDir, 'settings.json'), 'assistant settings'],
    [join(ctx.dataDir, 'panel.db'), 'run history, queued proposals and the wizard\'s answers per repo'],
    [join(ctx.dataDir, 'uploads'), 'database dumps waiting for an install or import'],
    [join(ctx.dataDir, 'mailpit'), 'Mailpit, when installed from the panel'],
    [join(ctx.home, '.config', 'systemd', 'user', 'devmagic-panel-mailpit.service'), 'Mailpit\'s systemd user service'],
    [autostartFile(ctx.home), 'starts the panel and Mailpit after login, on an encrypted home folder'],
    [ctx.logsDir, 'install and update logs'],
  ];
}

export async function developerReport(ctx: DeveloperContext): Promise<DeveloperReport> {
  const listed = installedList(ctx);
  // A release says what it is; a checkout asks git.
  const release = readRelease(REPO_DIR);
  const [commit, services, linger] = await Promise.all([
    release ? `${release.name} (${release.commit.slice(0, 9)})` : trimmed(ctx.exec, 'git', ['-C', REPO_DIR, 'describe', '--always', '--dirty']),
    serviceStates(ctx.exec),
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
    panelFiles: own.map(([path, note]) => ({ path, note, ...look(path), kind: folders.includes(path) ? 'dir' : 'file' })),
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

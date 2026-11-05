import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecResult, Executor } from './exec.js';
import { MAILPIT_UNIT } from './mailpit.js';

/**
 * An encrypted home folder (eCryptfs) is unlocked only when you log in, after
 * systemd has looked for your user services, so the panel and Mailpit never
 * start on their own. A desktop autostart entry runs once the desktop session
 * starts, with the home folder unlocked, and starts them.
 */

export const PANEL_UNIT = 'devmagic-panel.service';
/** The services the entry starts, each only when it is enabled, as boot would. */
export const AUTOSTART_UNITS = [PANEL_UNIT, MAILPIT_UNIT];

export const autostartFile = (home: string) => join(home, '.config', 'autostart', 'devmagic-panel.desktop');

/** Whether the home folder is on eCryptfs, from a mounts file like /proc/mounts. */
export function encryptedHome(home: string, mounts = '/proc/mounts'): boolean {
  let text: string;
  try {
    text = readFileSync(mounts, 'utf8');
  } catch {
    return false;
  }
  return text.split('\n').some((line) => {
    const [, point, type] = line.split(' ');
    // /proc/mounts writes a space in a path as \040.
    const at = point?.replace(/\\040/g, ' ');
    return type === 'ecryptfs' && at !== undefined && (home === at || home.startsWith(`${at}/`));
  });
}

const quote = (arg: string) => (/[\s"\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg);

/** The entry: the panel's CLI, with the node that runs the panel. */
export function autostartEntry(node: string, cli: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=devmagic-panel',
    'Comment=Starts the panel and Mailpit after login, once the encrypted home folder is unlocked',
    `Exec=${[node, '--disable-warning=ExperimentalWarning', cli, 'autostart'].map(quote).join(' ')}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export interface AutostartState {
  /** The program and arguments of its Exec line. */
  command: string[];
  /** Turned off in the desktop's startup applications. */
  off: boolean;
}

/** The entry as it is on disk; null when there is none. */
export function readAutostart(home: string): AutostartState | null {
  let text: string;
  try {
    text = readFileSync(autostartFile(home), 'utf8');
  } catch {
    return null;
  }
  const value = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  const command = [...(value('Exec') ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '')));
  return { command, off: value('Hidden') === 'true' || value('X-GNOME-Autostart-enabled') === 'false' };
}

/** The paths of the entry's command that are gone, like a node that was removed. */
export function missingPaths(state: AutostartState): string[] {
  return state.command.filter((arg) => arg.startsWith('/') && !existsSync(arg));
}

/** Writes the entry, replacing one that is there. */
export function writeAutostart(home: string, node: string, cli: string): string {
  const file = autostartFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, autostartEntry(node, cli), { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * `devmagic-panel autostart`: reloads the user services, now that systemd can
 * read them, and starts each of the panel's that is enabled.
 */
export async function startEnabled(exec: Executor): Promise<ExecResult[]> {
  const results = [await exec('systemctl', ['--user', 'daemon-reload'])];
  for (const unit of AUTOSTART_UNITS) {
    const enabled = await exec('systemctl', ['--user', 'is-enabled', unit]);
    if (enabled.stdout.trim() !== 'enabled') continue;
    results.push(await exec('systemctl', ['--user', 'start', unit]));
  }
  return results;
}

import { existsSync, readFileSync } from 'node:fs';
import { isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import { runRoot, type ExecResult, type Executor } from './exec.js';
import { hostsBlockNames, readHosts } from './sites/hosts-block.js';
import { interopDisabled, interopOn, wslVersion, type WslPaths } from './wsl.js';

/**
 * The Windows side under WSL: the panel runs Windows' own PowerShell through
 * interop, with the helper get.ps1 put in Program Files (windows/dmp-win.ps1),
 * by full path (a user unit's PATH has no Windows folders) and from a Windows
 * folder (a Linux one makes Windows programs complain about UNC paths). The
 * helper checks every argument again and asks UAC itself where it needs admin.
 */

export interface WindowsPaths {
  /** Windows' own folder as WSL sees it; found on the drives WSL mounts by default. */
  systemRoot?: string;
  /** The helper as WSL sees it; Program Files on Windows' drive by default. */
  helper?: string;
  /** The helper as Windows sees it; from `helper` by default. Tests set it, their temp tree being on no Windows drive. */
  helperWindows?: string;
  /** The mounted filesystems, to find Windows' drives; /proc/mounts by default. */
  mounts?: string;
}

/** A Windows drive as WSL mounts it: C on /mnt/c, or wherever wsl.conf's automount root puts it. */
export interface WindowsDrive {
  letter: string;
  mount: string;
}

/** Windows' drives from /proc/mounts: WSL's drvfs lines, like "C:\134 /mnt/c 9p rw,aname=drvfs;path=C:\;...". */
export function windowsDrives(mountsText: string): WindowsDrive[] {
  const drives: WindowsDrive[] = [];
  for (const line of mountsText.split('\n')) {
    const [, mount, type, options = ''] = line.split(' ');
    if (!mount || !(type === 'drvfs' || (type === '9p' && options.includes('aname=drvfs')))) continue;
    const letter = /path=([A-Za-z]):/.exec(options)?.[1] ?? /^([A-Za-z]):/.exec(line)?.[1];
    if (!letter) continue;
    // /proc/mounts writes a space in a path as \040.
    drives.push({ letter: letter.toUpperCase(), mount: mount.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))) });
  }
  return drives;
}

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const drivesOf = (paths: WindowsPaths) => windowsDrives(readText(paths.mounts ?? '/proc/mounts'));
const POWERSHELL = 'System32/WindowsPowerShell/v1.0/powershell.exe';

/** The drive Windows runs from: the first mounted one with Windows PowerShell in its Windows folder. */
export function windowsDrive(paths: WindowsPaths): WindowsDrive | null {
  return drivesOf(paths).find((d) => existsSync(`${d.mount}/Windows/${POWERSHELL}`)) ?? null;
}

export const WINDOWS_HELPER_COMMANDS = ['status', 'hosts-sync', 'ca-trust', 'autostart-install'] as const;
export type WindowsHelperCommand = (typeof WINDOWS_HELPER_COMMANDS)[number];

/** What the helper accepts as an argument, and nothing else: same as Assert-DmpArgument. */
const HELPER_ARGUMENT = /^[a-z0-9./=:-]{1,300}$/;
/** The addresses a hosts line may point at; the helper refuses any other. */
const PANEL_ADDRESSES = new Set(['127.0.0.1', '127.0.0.2']);

// No guess when no drive has Windows: then there is no helper to call, and the checks say to run get.ps1.
const systemRoot = (paths: WindowsPaths): string | null => paths.systemRoot ?? (windowsDrive(paths) ? `${windowsDrive(paths)!.mount}/Windows` : null);
export function helperPath(paths: WindowsPaths): string | null {
  if (paths.helper) return paths.helper;
  const drive = windowsDrive(paths);
  return drive ? `${drive.mount}/Program Files/devmagic-panel/dmp-win.ps1` : null;
}
export const helperInstalled = (paths: WindowsPaths) => {
  const path = helperPath(paths);
  return path !== null && existsSync(path);
};

/** /mnt/c/Program Files/x to C:\Program Files\x, for the program Windows starts, by the drives WSL mounts. */
export function windowsPath(linux: string, drives: WindowsDrive[] = [{ letter: 'C', mount: '/mnt/c' }]): string {
  const drive = drives.find((d) => linux === d.mount || linux.startsWith(`${d.mount}/`));
  if (!drive) throw new Error(`${linux} is not on a Windows drive`);
  return `${drive.letter}:${(linux.slice(drive.mount.length) || '/').replace(/\//g, '\\')}`;
}

/** Runs one helper command; refuses anything off its list before Windows sees it. */
export async function runHelper(exec: Executor, paths: WindowsPaths, command: WindowsHelperCommand, args: readonly string[] = [], timeoutMs = 120_000): Promise<ExecResult> {
  if (!(WINDOWS_HELPER_COMMANDS as readonly string[]).includes(command)) throw new Error(`not a helper command: ${command}`);
  for (const arg of args) if (!HELPER_ARGUMENT.test(arg)) throw new Error(`not an argument the helper takes: ${arg}`);
  const root = systemRoot(paths);
  const linuxHelper = helperPath(paths);
  if (!root || !linuxHelper) throw new Error('no Windows drive with Windows on it is mounted in this distro');
  // Bypass until the helper is signed (phase 3): it is admin-owned in Program Files, so only an admin can change it.
  const helper = paths.helperWindows ?? windowsPath(linuxHelper, drivesOf(paths));
  return exec(`${root}/${POWERSHELL}`, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, command, ...args], { cwd: root, timeoutMs });
}

/** The helper's read-only report. */
export interface WindowsStatus {
  distro: string;
  wsl: { answering: boolean; distroState: string | null };
  hosts: { path: string; block: string[] };
  ca: { readable: boolean; thumbprint: string | null; trusted: boolean; error?: string };
  logonTask: { installed: boolean };
  ports: string[];
  uac: { enabled: boolean; promptsAdmins: boolean };
}

export async function windowsStatus(exec: Executor, paths: WindowsPaths): Promise<WindowsStatus | null> {
  const r = await runHelper(exec, paths, 'status', [], 30_000);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as WindowsStatus;
  } catch {
    return null;
  }
}

/** The name=ip pairs Windows' block should hold: the Linux block's names, local ones on the panel's addresses only. */
export function windowsHostsPairs(config: SystemConfig): string[] {
  return hostsBlockNames(readHosts(config))
    .filter((e) => isLocalName(e.name) && PANEL_ADDRESSES.has(e.address))
    .map((e) => `${e.name}=${e.address}`);
}

/** The pairs Windows' block holds now, from the helper's status ("127.0.0.1 local.shop.com" lines). */
export function windowsBlockPairs(status: WindowsStatus): string[] {
  return status.hosts.block.flatMap((line) => {
    const [address, ...names] = line.trim().split(/\s+/);
    return names.map((name) => `${name.toLowerCase()}=${address}`);
  });
}

/**
 * Whether Windows' block holds other names than this distro's: true or false
 * from the helper's status, null when the helper did not answer (then nothing
 * is synced, so a broken helper never makes Windows ask UAC again and again).
 */
export async function windowsHostsDiffer(exec: Executor, config: SystemConfig, paths: WindowsPaths): Promise<boolean | null> {
  const status = await windowsStatus(exec, paths);
  if (!status) return null;
  const want = windowsHostsPairs(config);
  const have = windowsBlockPairs(status);
  return want.length !== have.length || want.some((p) => !have.includes(p));
}

/**
 * Under WSL 2: interop with Windows programs registered again when another
 * distro starting took it away (finding N), through dmp-root. A note of what it
 * did, empty when there was nothing to do; throws when dmp-root failed.
 */
export async function keepInterop(exec: Executor, dmpRoot: string, wsl: WslPaths = {}): Promise<string> {
  if (wslVersion(wsl) !== 2 || interopOn(wsl) || interopDisabled(wsl)) return '';
  const r = await runRoot(exec, dmpRoot, ['wsl-interop']);
  if (r.code !== 0) throw new Error(`could not register interop again: ${(r.stderr || r.stdout).trim()}`);
  return 'registered interop with Windows programs again';
}

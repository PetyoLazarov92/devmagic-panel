import { existsSync } from 'node:fs';
import { isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import { hostsBlockNames, readHosts } from './sites/hosts-block.js';

/**
 * The Windows side under WSL: the panel runs Windows' own PowerShell through
 * interop, with the helper get.ps1 put in Program Files (windows/dmp-win.ps1),
 * by full path (a user unit's PATH has no Windows folders) and from a Windows
 * folder (a Linux one makes Windows programs complain about UNC paths). The
 * helper checks every argument again and asks UAC itself where it needs admin.
 */

export interface WindowsPaths {
  /** Windows' own folder as WSL sees it; /mnt/c/Windows by default. */
  systemRoot?: string;
  /** The helper as WSL sees it; Program Files on C: by default. */
  helper?: string;
  /** The helper as Windows sees it; from `helper` by default. Tests set it, their temp tree being on no Windows drive. */
  helperWindows?: string;
}

export const WINDOWS_HELPER_COMMANDS = ['status', 'hosts-sync', 'ca-trust', 'autostart-install'] as const;
export type WindowsHelperCommand = (typeof WINDOWS_HELPER_COMMANDS)[number];

/** What the helper accepts as an argument, and nothing else: same as Assert-DmpArgument. */
const HELPER_ARGUMENT = /^[a-z0-9./=:-]{1,300}$/;
/** The addresses a hosts line may point at; the helper refuses any other. */
const PANEL_ADDRESSES = new Set(['127.0.0.1', '127.0.0.2']);

const systemRoot = (paths: WindowsPaths) => paths.systemRoot ?? '/mnt/c/Windows';
export const helperPath = (paths: WindowsPaths) => paths.helper ?? '/mnt/c/Program Files/devmagic-panel/dmp-win.ps1';
export const helperInstalled = (paths: WindowsPaths) => existsSync(helperPath(paths));

/** /mnt/c/Program Files/x to C:\Program Files\x, for the program Windows starts. */
export function windowsPath(linux: string): string {
  const match = /^\/mnt\/([a-z])(\/.*)?$/.exec(linux);
  if (!match) throw new Error(`${linux} is not on a Windows drive`);
  return `${match[1]!.toUpperCase()}:${(match[2] ?? '/').replace(/\//g, '\\')}`;
}

/** Runs one helper command; refuses anything off its list before Windows sees it. */
export async function runHelper(exec: Executor, paths: WindowsPaths, command: WindowsHelperCommand, args: readonly string[] = [], timeoutMs = 120_000): Promise<ExecResult> {
  if (!(WINDOWS_HELPER_COMMANDS as readonly string[]).includes(command)) throw new Error(`not a helper command: ${command}`);
  for (const arg of args) if (!HELPER_ARGUMENT.test(arg)) throw new Error(`not an argument the helper takes: ${arg}`);
  const powershell = `${systemRoot(paths)}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  // Bypass until the helper is signed (phase 3): it is admin-owned in Program Files, so only an admin can change it.
  const helper = paths.helperWindows ?? windowsPath(helperPath(paths));
  return exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, command, ...args], {
    cwd: systemRoot(paths),
    timeoutMs,
  });
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

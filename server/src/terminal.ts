import { existsSync, realpathSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { ExecResult, Executor } from './exec.js';

/**
 * Opens a terminal window at a site's folder, on this computer's desktop. The
 * panel runs in the desktop session (a user service), so the window opens
 * where you sit; with no display there is nothing to open it on, and it says
 * so. The terminal is the desktop's default (x-terminal-emulator) when the
 * panel knows how to give it a folder, else the first known one installed.
 */

/** How each terminal is told the folder to open in. */
const FOLDER_ARGS: Readonly<Record<string, (dir: string) => string[]>> = {
  'gnome-terminal': (dir) => [`--working-directory=${dir}`],
  ptyxis: (dir) => ['--new-window', `--working-directory=${dir}`],
  kgx: (dir) => [`--working-directory=${dir}`],
  konsole: (dir) => ['--workdir', dir],
  'xfce4-terminal': (dir) => [`--working-directory=${dir}`],
  'mate-terminal': (dir) => [`--working-directory=${dir}`],
  tilix: (dir) => [`--working-directory=${dir}`],
  terminator: (dir) => [`--working-directory=${dir}`],
  kitty: (dir) => ['--directory', dir],
  alacritty: (dir) => ['--working-directory', dir],
  wezterm: (dir) => ['start', '--cwd', dir],
};

/**
 * How each terminal is told to run a program (with its arguments, never
 * through a shell), and to keep its window open after where it can, so what
 * the program said stays readable. Terminals not here only open the folder.
 */
const RUN_ARGS: Readonly<Record<string, (command: readonly string[]) => string[]>> = {
  'gnome-terminal': (c) => ['--', ...c],
  konsole: (c) => ['--hold', '-e', ...c],
  'xfce4-terminal': (c) => ['--hold', '-x', ...c],
  'mate-terminal': (c) => ['-x', ...c],
  terminator: (c) => ['-x', ...c],
  kitty: (c) => ['--hold', ...c],
  alacritty: (c) => ['--hold', '-e', ...c],
  wezterm: (c) => ['--', ...c],
  // Debian's x-terminal-emulator promises -e with a program and its arguments.
  'x-terminal-emulator': (c) => ['-e', ...c],
};

export interface TerminalEnv {
  path?: string;
  display?: string;
  wayland?: string;
  /** For tests: where x-terminal-emulator really points. */
  resolve?: (file: string) => string;
}

/**
 * The terminal to run and its arguments for `dir`, starting `command` when
 * given and the terminal can (runs tells), or null when none is installed.
 */
export function terminalFor(dir: string, env: TerminalEnv = {}, command?: readonly string[]): { file: string; args: string[]; runs: boolean } | null {
  const found = terminalAt(dir, env);
  if (!found) return null;
  const run = command ? RUN_ARGS[found.name] : undefined;
  return { file: found.file, args: run && command ? [...found.args, ...run(command)] : found.args, runs: Boolean(run && command) };
}

function terminalAt(dir: string, env: TerminalEnv): { file: string; args: string[]; name: string } | null {
  const dirs = (env.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const find = (name: string) => dirs.map((d) => join(d, name)).find((f) => existsSync(f));
  const resolve = env.resolve ?? ((file: string) => realpathSync(file));
  const fallback = find('x-terminal-emulator');
  if (fallback) {
    // Debian's alternative points at the default, like /usr/bin/gnome-terminal.wrapper.
    let name = '';
    try {
      name = basename(resolve(fallback)).replace(/\.wrapper$/, '');
    } catch {
      name = '';
    }
    const known = FOLDER_ARGS[name];
    const real = known ? find(name) : undefined;
    if (known && real) return { file: real, args: known(dir), name };
  }
  for (const [name, args] of Object.entries(FOLDER_ARGS)) {
    const file = find(name);
    if (file) return { file, args: args(dir), name };
  }
  // A terminal the panel does not know still opens in the folder it is started in.
  return fallback ? { file: fallback, args: [], name: 'x-terminal-emulator' } : null;
}

/** A program a terminal starts, with how to say it ("claude auth login"). */
export interface TerminalCommand {
  argv: readonly string[];
  said: string;
}

export async function openTerminal(exec: Executor, dir: string, env: TerminalEnv = {}, command?: TerminalCommand): Promise<ExecResult> {
  const display = env.display ?? process.env.DISPLAY;
  const wayland = env.wayland ?? process.env.WAYLAND_DISPLAY;
  if (!display && !wayland) return { code: 1, stdout: '', stderr: 'The panel runs without a desktop session here, so it cannot open a terminal window: open one yourself and cd to the folder.' };
  const terminal = terminalFor(dir, env, command?.argv);
  if (!terminal) return { code: 1, stdout: '', stderr: 'No terminal found: install one, like gnome-terminal or konsole, or open one yourself and cd to the folder.' };
  // The service's NODE_ENV=production would make npm in that window leave out devDependencies.
  const r = await exec(terminal.file, terminal.args, { cwd: dir, detach: true, env: { NODE_ENV: undefined } });
  if (r.code !== 0) return { code: 1, stdout: '', stderr: `${basename(terminal.file)} did not start: ${r.stderr.trim()}` };
  const doing = !command ? '' : terminal.runs ? `, running ${command.said}: go on there` : `: it cannot be told to run a program, so run ${command.said} in it yourself`;
  return { code: 0, stdout: `Opened ${basename(terminal.file)} in ${dir}${doing}`, stderr: '' };
}

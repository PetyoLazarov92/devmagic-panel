import { chmodSync, closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '../exec.js';

/**
 * A dump over SSH from a server that asks for a password. The password is
 * for the connections of one run and nothing more: it is not kept, and
 * nothing is written on the server (no key is added there). It reaches ssh
 * through its askpass helper and a FIFO only you can open (a FIFO holds no
 * data), never argv, the environment, a file or a log. Everything else stays
 * as it is for a dump over SSH: your own ssh config, your key tried first,
 * and a host that is not in known_hosts refused, never trusted on the fly.
 */

export interface SshPasswordContext {
  exec: Executor;
  /** Where the FIFO's folder goes: $XDG_RUNTIME_DIR (tmpfs, only yours), else the temp folder. */
  runtimeDir?: string;
  /** Writes the password into the FIFO each time ssh's helper opens it, until told to stop; tests swap in a fake. */
  feed?: (fifo: string, text: string, stopped: () => boolean) => Promise<void>;
}

/**
 * Put before ssh's own options, since ssh keeps the first value it gets:
 * prompts are allowed again (through the helper only), and one try, so a
 * wrong password never locks the account. sftp -b turns batch mode on by
 * itself, after these.
 */
export const PASSWORD_OPTIONS = ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1'];

/**
 * ssh's askpass helper: it prints what the FIFO hands it. No secret is in
 * it, and it runs with the panel's own node, so no shell is involved.
 */
const helperSource = () => `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(process.env.DMP_ASKPASS_FIFO, 'utf8'));\n`;

/** Writes the text into the FIFO whenever a reader opened it, until stopped: a run connects more than once. */
export async function feedFifo(fifo: string, text: string, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    let fd: number;
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      // No reader yet (ENXIO); anything else means the FIFO is gone.
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    // The reader takes it and closes; a moment before the next ask can open.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Runs work with an executor whose ssh and sftp calls, and the ssh rsync
 * starts, sign in with the password when the server asks for one. Every other program runs as it is.
 * The FIFO and the helper are gone when the work ends, however it ends.
 */
export async function withSshPassword<T>(ctx: SshPasswordContext, password: string, work: (exec: Executor) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(ctx.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'devmagic-panel-ssh-'));
  const fifo = join(dir, 'answer');
  const helper = join(dir, 'askpass');
  let done = false;
  let feeding: Promise<void> | undefined;
  try {
    const made = await ctx.exec('mkfifo', ['-m', '600', fifo]);
    if (made.code !== 0) throw new Error(made.stderr.trim() || 'could not make a FIFO for the password');
    writeFileSync(helper, helperSource(), { mode: 0o700 });
    chmodSync(helper, 0o700);
    feeding = (ctx.feed ?? feedFifo)(fifo, `${password}\n`, () => done);
    // SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4 and later): ssh asks the helper, never a terminal.
    const env = (options: Parameters<Executor>[2]) => ({ ...options, env: { ...options?.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DMP_ASKPASS_FIFO: fifo } });
    const exec: Executor = (file, args, options) => {
      if (file === 'ssh' || file === 'sftp') return ctx.exec(file, [...PASSWORD_OPTIONS, ...args], env(options));
      // rsync starts ssh itself, from the words after -e: the same options go first there, and the helper reaches it through rsync's environment.
      if (file === 'rsync') return ctx.exec(file, args.map((a, i) => (args[i - 1] === '-e' && a.startsWith('ssh ') ? `ssh ${PASSWORD_OPTIONS.join(' ')} ${a.slice(4)}` : a)), env(options));
      return ctx.exec(file, args, options);
    };
    return await work(exec);
  } finally {
    done = true;
    await feeding?.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A password given for one run, handed out once: a Retry of the step gets
 * none, and says so, as the password was dropped when the step ended.
 */
export function oncePassword(password: string | undefined) {
  let held = password;
  return {
    given: password !== undefined && password !== '',
    take(): string | undefined {
      const value = held;
      held = undefined;
      return value;
    },
  };
}

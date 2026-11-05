import { execFile, spawn } from 'node:child_process';
import { pipeline, type Readable, type Writable } from 'node:stream';

/**
 * Runs a program with an argument list. There is no shell anywhere in the
 * panel, so no input can be interpreted as shell syntax. Tests swap in a fake
 * executor; nothing in the server calls child_process directly.
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Added to the panel's environment; a name set to undefined is left out. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Written to the program's stdin, which is then closed. Stdin is always closed, so nothing can wait for input. */
  input?: string;
  /**
   * Streamed into stdin instead of input, for big data like a database dump.
   * An error in it stops the program, so a dump read halfway never looks finished.
   */
  inputStream?: Readable;
  /** Stops the program when inputStream sends nothing for this long. */
  inputStallMs?: number;
  /**
   * Where stdout goes instead of the result, for big output like a database
   * dump: nothing of it is kept in memory. A write that fails (a full disk)
   * stops the program. The result's stdout is then empty.
   */
  stdoutTo?: Writable;
  /** Called with stderr as it arrives, for progress lines like git's. */
  onStderr?: (chunk: string) => void;
  /** Called with stdout as it arrives, for programs that report as they go, like Claude Code's stream. */
  onStdout?: (chunk: string) => void;
  /** The most stdout or stderr kept, 8 MB unless set; a program that prints more is stopped. */
  maxBufferBytes?: number;
  /**
   * Started on its own and left running, like a terminal window: the result
   * comes once it has started (0) or could not (127), with no output, and the
   * program outlives the panel's wait and the panel itself. It gets the
   * panel's environment without LC_ALL=C, as a window for a person.
   */
  detach?: boolean;
}

export type Executor = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** The last of stderr a program that streams its stdout keeps. */
const STDERR_KEPT = 64 * 1024;

/** A program whose stdout streams into options.stdoutTo; stdin gets options.input, then closes. */
const runToStream = (file: string, args: readonly string[], options: ExecOptions & { stdoutTo: Writable }): Promise<ExecResult> =>
  new Promise((resolve) => {
    let stopped: string | undefined;
    let stderr = '';
    let exit: { code: number | null } | undefined;
    let written = false;
    const child = spawn(file, [...args], { env: { ...process.env, ...options.env, LC_ALL: 'C' }, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const done = () => {
      if (!exit || !written) return;
      clearTimeout(timer);
      if (stopped) resolve({ code: 1, stdout: '', stderr: [stopped, stderr.trim()].filter(Boolean).join('\n') });
      else resolve({ code: exit.code ?? 127, stdout: '', stderr });
    };
    const stop = (why: string) => {
      stopped ??= why;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => stop('stopped: it took too long'), options.timeoutMs ?? 30_000);
    child.on('error', (error) => {
      // Not started: 127, as for a program the buffered way cannot start.
      stderr = error.message;
      exit = { code: 127 };
      written = true;
      done();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      options.onStderr?.(text);
      stderr = (stderr + text).slice(-STDERR_KEPT);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    pipeline(child.stdout, options.stdoutTo, (error) => {
      if (error) stop(`could not write the output: ${error.message}`);
      written = true;
      done();
    });
    child.on('close', (code) => {
      exit = { code };
      done();
    });
  });

/** A program left running on its own; see ExecOptions.detach. */
const runDetached = (file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { env: { ...process.env, ...options.env }, ...(options.cwd ? { cwd: options.cwd } : {}), detached: true, stdio: 'ignore' });
    child.once('error', (error) => resolve({ code: 127, stdout: '', stderr: error.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ code: 0, stdout: '', stderr: '' });
    });
  });

export const runCommand: Executor = (file, args, options = {}) =>
  options.detach
    ? runDetached(file, args, options)
    : options.stdoutTo
      ? runToStream(file, args, { ...options, stdoutTo: options.stdoutTo })
      : runBuffered(file, args, options);

/** Why a program ended on a signal: the timeout (the panel killed it), or something else, like the kernel out of memory. */
function stoppedBy(signal: string, killedByUs: boolean, timeoutMs: number): string {
  const limit = timeoutMs >= 3_600_000 ? `${Number((timeoutMs / 3_600_000).toFixed(1))} h` : timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.max(1, Math.round(timeoutMs / 1000))} s`;
  if (killedByUs) return `stopped: it took longer than ${limit}`;
  return `stopped by ${signal}${signal === 'SIGKILL' ? ', often the system running out of memory' : ''}`;
}

const runBuffered: Executor = (file, args, options = {}) =>
  new Promise((resolve) => {
    // Why the panel stopped the program itself, which wins over the signal it died of.
    let stopped: string | undefined;
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
        env: { ...process.env, ...options.env, LC_ALL: 'C' },
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (stopped) {
          resolve({ code: 1, stdout: String(stdout), stderr: [stopped, String(stderr).trim()].filter(Boolean).join('\n') });
          return;
        }
        if (error && typeof error.code !== 'number') {
          // Not started, killed by the timeout, or a signal.
          const why = error.signal ? stoppedBy(error.signal, Boolean(error.killed), options.timeoutMs ?? 30_000) : undefined;
          resolve({ code: 127, stdout: String(stdout), stderr: why ? [String(stderr).trim(), why].filter(Boolean).join('\n') : String(stderr) || error.message });
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.on('error', () => undefined);
    if (options.onStderr) child.stderr?.on('data', (chunk: Buffer | string) => options.onStderr?.(String(chunk)));
    if (options.onStdout) child.stdout?.on('data', (chunk: Buffer | string) => options.onStdout?.(String(chunk)));
    const input = options.inputStream;
    if (input && child.stdin) {
      const stdin = child.stdin;
      let stall: NodeJS.Timeout | undefined;
      const stop = (why: string) => {
        stopped ??= why;
        clearTimeout(stall);
        input.unpipe(stdin);
        input.destroy();
        child.kill('SIGTERM');
      };
      const wait = () => {
        if (!options.inputStallMs) return;
        clearTimeout(stall);
        const ms = options.inputStallMs;
        stall = setTimeout(() => stop(`stopped: nothing was read for ${Math.round(ms / 60_000)} min`), ms);
      };
      input.on('data', wait);
      input.on('end', () => clearTimeout(stall));
      input.on('error', (error) => stop(`could not read the input: ${error.message}`));
      child.on('close', () => {
        clearTimeout(stall);
        input.destroy();
      });
      wait();
      input.pipe(stdin);
    } else {
      child.stdin?.end(options.input ?? '');
    }
  });

/** Runs a dmp-root command through sudo without ever prompting. */
export function runRoot(exec: Executor, dmpRoot: string, args: readonly string[], timeoutMs = 120_000): Promise<ExecResult> {
  return exec('sudo', ['-n', dmpRoot, ...args], { timeoutMs });
}

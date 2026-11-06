import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CronRunStatus, CronRunView, CronTask } from '@devmagic-panel/shared';
import { isSiteWpCommand } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import { decodeTaskArgs } from './cron.js';
import type { ExecResult, Executor } from './exec.js';
import { wpCommand } from './php/pools.js';
import { type SiteRef, siteFor } from './sites/site-actions.js';
import type { RunStore } from './store.js';

/**
 * The runner: cron runs `cli.js cron-run <args>` for each task of the
 * panel. It reads the arguments with the registry's schema again, runs the
 * task with an argument list (never a shell), one run per task at a time,
 * and keeps how it went in the panel's database. It prints nothing, so cron
 * mails nothing.
 */

/** The most of a run's output kept: its end, where errors are. */
export const CRON_OUTPUT_KEPT = 64 * 1024;

export interface RunnerDeps {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  /** One lock file per task while it runs. */
  lockDir: string;
  home: string;
  now?: () => number;
  /** Whether a process still runs; tests fake it. */
  alive?: (pid: number) => boolean;
}

export interface RunOutcome {
  runId: number;
  status: CronRunStatus;
  exitCode: number | null;
  output: string;
}

const tail = (text: string) => (text.length > CRON_OUTPUT_KEPT ? `(only the last ${CRON_OUTPUT_KEPT / 1024} KB are kept)\n${text.slice(-CRON_OUTPUT_KEPT)}` : text);
const textOf = (results: ExecResult[]) =>
  results
    .map((r) => [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n');

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Takes the task's lock, or answers false while another run of it is alive. A lock left by a run that died is taken over. */
function takeLock(deps: RunnerDeps, id: string): boolean {
  mkdirSync(deps.lockDir, { recursive: true, mode: 0o700 });
  const file = join(deps.lockDir, `${id}.lock`);
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && (deps.alive ?? processAlive)(pid)) return false;
    writeFileSync(file, String(process.pid), { mode: 0o600 });
    return true;
  }
}

function dropLock(deps: RunnerDeps, id: string): void {
  try {
    unlinkSync(join(deps.lockDir, `${id}.lock`));
  } catch {
    // already gone
  }
}

function wp(deps: RunnerDeps, site: SiteRef, args: string[], timeoutMs: number, url = `https://${site.host}/`): Promise<ExecResult> {
  const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=${url}`, ...args]);
  return deps.exec(cmd.file, cmd.args, { timeoutMs, ...(cmd.env ? { env: cmd.env } : {}) });
}

const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** Runs what a task says; every path is checked here again, at run time. */
export async function runTask(deps: RunnerDeps, task: CronTask, timeoutMs: number): Promise<ExecResult[]> {
  switch (task.kind) {
    case 'wp-cron': {
      const site = siteFor(deps.config, task.domain, task.path);
      if (!site.wp.multisite) return [await wp(deps, site, ['cron', 'event', 'run', '--due-now'], timeoutMs)];
      // A network: each site of it has its own events.
      const list = await wp(deps, site, ['site', 'list', '--field=url', '--archived=0', '--deleted=0', '--spam=0'], 60_000);
      if (list.code !== 0) return [list];
      const results: ExecResult[] = [];
      for (const url of list.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const r = await wp(deps, site, ['cron', 'event', 'run', '--due-now'], timeoutMs, url);
        results.push({ ...r, stdout: r.stdout ? `${url}\n${r.stdout}` : r.stdout });
      }
      return results;
    }
    case 'wp-cli': {
      const site = siteFor(deps.config, task.domain, task.path);
      if (isSiteWpCommand(task.command)) {
        const has = await wp(deps, site, ['cli', 'has-command', task.command[0] as string], 60_000);
        if (has.code !== 0) return [failed(`${site.host} has no WP-CLI command ${task.command[0]}: is its plugin active?`)];
      }
      return [await wp(deps, site, task.command, timeoutMs)];
    }
    case 'php-script': {
      const site = siteFor(deps.config, task.domain, task.path);
      let file: string;
      try {
        file = realpathSync(join(site.docroot, task.file));
      } catch {
        return [failed(`${task.file} is not in ${site.host}`)];
      }
      // A link may not lead out of the site's folder.
      if (!file.startsWith(`${realpathSync(site.docroot)}/`) || !statSync(file).isFile()) return [failed(`${task.file} is not a file inside ${site.host}`)];
      return [await deps.exec(site.php ? `php${site.php}` : 'php', [file], { timeoutMs, cwd: dirname(file) })];
    }
    case 'url':
      // curl trusts the system's certificates, the local CA among them.
      return [await deps.exec('curl', ['--silent', '--show-error', '--fail', '--location', '--max-time', String(Math.ceil(timeoutMs / 1000)), task.url], { timeoutMs: timeoutMs + 5000, maxBufferBytes: 4 * 1024 * 1024 })];
    case 'program':
      try {
        accessSync(task.program, constants.X_OK);
      } catch {
        return [failed(`${task.program} is missing or not executable`)];
      }
      return [await deps.exec(task.program, task.args, { timeoutMs, cwd: existsSync(deps.home) ? deps.home : '/' })];
  }
}

/** One run of a task from the runner's arguments, recorded from start to end. */
export async function runCronTask(deps: RunnerDeps, args: readonly string[], trigger: CronRunView['trigger']): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  const decoded = decodeTaskArgs(args);
  if (typeof decoded === 'string') {
    const id = /^--id=([a-z0-9]{6})$/.exec(args.find((a) => a.startsWith('--id=')) ?? '')?.[1] ?? 'unknown';
    const output = `The task's line cannot run: ${decoded}`;
    return { runId: deps.store.addCronRun(id, trigger, 'failed', output, new Date(now()).toISOString()), status: 'failed', exitCode: null, output };
  }
  if (!takeLock(deps, decoded.id)) {
    const output = 'Skipped: the last run of this task is still running';
    return { runId: deps.store.addCronRun(decoded.id, trigger, 'skipped', output, new Date(now()).toISOString()), status: 'skipped', exitCode: null, output };
  }
  const started = now();
  const runId = deps.store.startCronRun(decoded.id, trigger, new Date(started).toISOString());
  let results: ExecResult[];
  try {
    results = await runTask(deps, decoded.task, decoded.timeoutMinutes * 60_000);
  } catch (error) {
    results = [failed((error as Error).message)];
  } finally {
    dropLock(deps, decoded.id);
  }
  const bad = results.find((r) => r.code !== 0);
  const exitCode = bad?.code ?? 0;
  const status: CronRunStatus = bad ? 'failed' : 'ok';
  const output = tail(textOf(results));
  deps.store.finishCronRun(runId, status, exitCode, now() - started, output);
  deps.store.pruneCronRuns(now());
  return { runId, status, exitCode, output };
}

/** cron's PATH is only /usr/bin:/bin; WP-CLI and Composer usually live elsewhere. */
export function runnerPath(home: string, current = process.env.PATH ?? ''): string {
  const dirs = [join(home, '.local', 'bin'), join(home, '.config', 'composer', 'vendor', 'bin'), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', ...current.split(':')];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

/**
 * Why a task cannot go into the crontab as asked, checked before it is
 * saved: the site and the file are there, the site has its own WP-CLI
 * command, the program can run. The runner checks the same each time.
 */
export async function taskRefusal(exec: Executor, config: SystemConfig, task: CronTask): Promise<string | null> {
  if ('domain' in task) {
    const site = siteFor(config, task.domain, task.path);
    if (task.kind === 'wp-cli' && isSiteWpCommand(task.command)) {
      const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=https://${site.host}/`, 'cli', 'has-command', task.command[0] as string]);
      const has = await exec(cmd.file, cmd.args, { timeoutMs: 60_000, ...(cmd.env ? { env: cmd.env } : {}) });
      if (has.code !== 0) return `${site.host} has no WP-CLI command ${task.command[0]}: is its plugin active?`;
    }
    if (task.kind === 'php-script') {
      try {
        const file = realpathSync(join(site.docroot, task.file));
        if (!file.startsWith(`${realpathSync(site.docroot)}/`) || !statSync(file).isFile()) return `${task.file} is not a file inside ${site.host}`;
      } catch {
        return `${task.file} is not in ${site.host}`;
      }
    }
  }
  if (task.kind === 'program') {
    try {
      accessSync(task.program, constants.X_OK);
      if (!statSync(task.program).isFile()) return `${task.program} is not a file`;
    } catch {
      return `${task.program} is missing or not executable`;
    }
  }
  return null;
}

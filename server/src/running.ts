import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import type { FinishedProgram, ProgramPage, RunningProgram } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';

/**
 * The programs the panel has running right now and the last ones that ended,
 * for Sanctum and the status in the top bar: the program's name, when it
 * started, the job, background task or page's request it runs for, and
 * once ended how long it took, how it ended and why it failed in a few
 * words from a fixed list. Never its arguments past a fixed command word (a
 * path, a host, SQL or a password can be in them), its environment or its
 * output. Kept in memory only; a restart starts empty. Slow ones, and failed
 * ones a job or task ran, also go to the panel's log, by name only.
 */

type Scope = { kind: 'job' | 'task'; id: string; title: string } | { kind: 'page'; page: ProgramPage };
const scope = new AsyncLocalStorage<Scope>();

/** Runs a job's step with the job named, so what it starts is listed under it. */
export const inJob = <T>(job: { id: string; title: string }, work: () => T): T => scope.run({ kind: 'job', ...job }, work);
/** Runs a background task with its name, the same way. */
export const inTask = <T>(task: { id: string; title: string }, work: () => T): T => scope.run({ kind: 'task', ...task }, work);
/** Runs a page's request with its route named, so the reads it starts say where they came from. A job or task started inside names itself instead. */
export const inPage = <T>(page: ProgramPage, work: () => T): T => scope.run({ kind: 'page', page }, work);

/** A command word: lowercase letters, digits and dashes, short. A value (a path, a branch, a slug with dots, SQL) is never one. */
const COMMAND_WORD = /^[a-z][a-z0-9-]{0,30}$/;
/** Programs whose first word is a command, and how many command words they take: wp has noun and verb ("plugin list"). */
const COMMAND_WORDS: Record<string, number> = { git: 1, wp: 2, gh: 1, glab: 1, systemctl: 1, composer: 1, rclone: 1, 'apt-cache': 1, crontab: 0, nginx: 0 };
/** Options of git that take the next argument as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree']);

/**
 * The words that name a program: its file name, with its command where it
 * has one ("git status", "wp plugin list"), and for dmp-root through sudo,
 * the root command. Only words that look like a command count, and the
 * first that does not ends it, so no value is ever shown.
 */
export function programName(file: string, args: readonly string[]): string {
  const name = basename(file);
  if (name === 'sudo') {
    const words = args.filter((a) => !a.startsWith('-'));
    const root = words[0] ? basename(words[0]) : '';
    if (root === 'dmp-root' && words[1] && COMMAND_WORD.test(words[1])) return `dmp-root ${words[1]}`;
    return root ? `sudo ${root}` : 'sudo';
  }
  const take = COMMAND_WORDS[name] ?? 0;
  if (take === 0) return name;
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < take; i++) {
    const a = args[i] as string;
    if (name === 'git' && GIT_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      // An option before the command, like --path=/var/www/x or --hostname host for glab after its command.
      if (words.length > 0) break;
      continue;
    }
    if (!COMMAND_WORD.test(a)) break;
    words.push(a);
  }
  return [name, ...words].join(' ');
}

/** MySQL's error numbers in words, the common ones. Others show as their number only. */
const MYSQL_ERRORS: Record<string, string> = {
  '1044': 'no access to the database',
  '1045': 'access denied',
  '1049': 'database not there',
  '1054': 'column not there',
  '1064': 'SQL the server does not take',
  '1142': 'no access to the table',
  '1146': 'table not there',
  '2002': 'MySQL does not answer',
  '2003': 'MySQL does not answer',
  '2005': 'MySQL host not found',
  '2013': 'MySQL dropped the connection',
};

/** Errors other programs print, matched by a fixed pattern only. */
const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/not a git repository/i, 'not a git repository'],
  [/no upstream (configured|branch)/i, 'no upstream branch'],
  [/no such remote/i, 'no such remote'],
  [/does not seem to be a WordPress installation/i, 'not a WordPress folder'],
  [/Error establishing a database connection/i, 'no database connection'],
  [/Host key verification failed/i, 'host key not trusted'],
  [/Could not resolve hostname/i, 'host not found'],
  [/Connection (refused|timed out)/i, 'no connection'],
  [/authentication|not logged in|gh auth login|glab auth login/i, 'not signed in'],
  [/Permission denied/i, 'permission denied'],
  [/No such file or directory/i, 'file not there'],
];

/**
 * Why a program failed, in a few words: from its exit code and a fixed list
 * of errors it prints. Nothing of its output is kept, only the words here,
 * or MySQL's error number.
 */
export function failureReason(program: string, result: ExecResult): string | undefined {
  if (result.code === 0) return undefined;
  if (result.code === 127) return 'could not start: not installed?';
  const err = result.stderr;
  if (program.startsWith('mysql')) {
    const n = /ERROR (\d{4})/.exec(err)?.[1];
    if (n) return MYSQL_ERRORS[n] ?? `MySQL error ${n}`;
  }
  for (const [pattern, words] of KNOWN_ERRORS) if (pattern.test(err)) return words;
  if (err.trim() === '' && result.stdout.trim() === '') return 'printed nothing';
  return undefined;
}

/** How many ended programs Sanctum's Recently finished keeps. */
export const FINISHED_KEPT = 50;
/** A program that ran this long is logged, whatever started it. */
export const SLOW_MS = 30_000;
/** A page's read this slow is listed with the rest; quicker ones that went well are only counted. */
export const SLOW_READ_MS = 5_000;

/** How a program ended, from its result: the executor says "stopped: it took longer than" when its timeout stopped it. */
export function endedOf(result: ExecResult): FinishedProgram['ended'] {
  if (result.code === 0) return 'ok';
  return /stopped: it took longer than/.test(result.stderr) ? 'timeout' : 'failed';
}

/** The line the panel's log gets for a slow or failed program: its name, what it ran for, how long and how it ended. Never its arguments. */
export function notableLine(p: FinishedProgram): string {
  const by = p.job ? ` for "${p.job.title}"` : p.task ? ` for the background task "${p.task.title}"` : p.page ? ` for ${p.page.route}` : '';
  const how = p.ended === 'ok' ? 'ended well' : p.ended === 'timeout' ? 'was stopped by its timeout' : `ended with exit ${p.code ?? '?'}${p.reason ? ` (${p.reason})` : ''}`;
  return `${p.program} ran ${Math.round(p.durationMs / 1000)} s${by} and ${how}`;
}

export class RunningPrograms {
  private readonly running = new Map<number, RunningProgram>();
  private readonly ended: FinishedProgram[] = [];
  private readonly reads = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private next = 1;

  /**
   * notable: called for a program that ran SLOW_MS or longer, or that failed for a job or a background task
   * (a page's read that fails, like a sign-in check, is often meant to), for the panel's log.
   */
  constructor(private readonly notable: (program: FinishedProgram) => void = () => undefined, private readonly now: () => number = Date.now) {}

  /** The executor, with every program it runs listed while it runs and kept a while once it ended. One started on its own (detach) is not waited on, so not listed. */
  track(exec: Executor): Executor {
    return async (file, args, options) => {
      if (options?.detach) return exec(file, args, options);
      const id = this.next++;
      const by = scope.getStore();
      const from = !by ? {} : by.kind === 'page' ? { page: by.page } : { [by.kind]: { id: by.id, title: by.title } };
      const started = this.now();
      const program: RunningProgram = { program: programName(file, args), startedAt: new Date(started).toISOString(), ...from };
      this.running.set(id, program);
      let result: ExecResult | undefined;
      try {
        result = await exec(file, args, options);
        return result;
      } finally {
        this.running.delete(id);
        const ended: FinishedProgram['ended'] = result ? endedOf(result) : 'failed';
        const reason = result && ended === 'failed' ? failureReason(program.program, result) : undefined;
        const done: FinishedProgram = { ...program, durationMs: this.now() - started, ended, ...(result && result.code !== 0 && ended === 'failed' ? { code: result.code } : {}), ...(reason ? { reason } : {}) };
        // A site's page starts several reads at once: the ones that went well and quick are counted, not listed, so they never push a job's out.
        if (!done.job && !done.task && done.ended === 'ok' && done.durationMs < SLOW_READ_MS) {
          const count = this.reads.get(done.program) ?? { count: 0, totalMs: 0, maxMs: 0 };
          this.reads.set(done.program, { count: count.count + 1, totalMs: count.totalMs + done.durationMs, maxMs: Math.max(count.maxMs, done.durationMs) });
        } else {
          this.ended.unshift(done);
          this.ended.length = Math.min(this.ended.length, FINISHED_KEPT);
        }
        if (done.durationMs >= SLOW_MS || (done.ended !== 'ok' && (done.job || done.task))) {
          try {
            this.notable(done);
          } catch {
            // A log that cannot take it never stops the program's caller.
          }
        }
      }
    };
  }

  /** The longest running first. */
  list(): RunningProgram[] {
    return [...this.running.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** The programs worth a look that ended lately, newest first. */
  finished(): FinishedProgram[] {
    return [...this.ended];
  }

  /** The page reads that went well since the panel started, per program, the most first. */
  pageReads(): Array<{ program: string; count: number; totalMs: number; maxMs: number }> {
    return [...this.reads].map(([program, c]) => ({ program, ...c })).sort((a, b) => b.count - a.count);
  }
}

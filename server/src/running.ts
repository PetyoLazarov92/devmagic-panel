import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import type { FinishedProgram, RunningProgram } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';

/**
 * The programs the panel has running right now and the last ones that ended,
 * for Sanctum and the status in the top bar: the program's name, when it
 * started, the job or background task it runs for (neither: a page's read),
 * and once ended how long it took and how it ended. Never its arguments (a
 * path, a host or a site's name can be in them), its environment or its
 * output. Kept in memory only; a restart starts empty. Slow ones, and failed
 * ones a job or task ran, also go to the panel's log, by name only.
 */

const scope = new AsyncLocalStorage<{ kind: 'job' | 'task'; id: string; title: string }>();

/** Runs a job's step with the job named, so what it starts is listed under it. */
export const inJob = <T>(job: { id: string; title: string }, work: () => T): T => scope.run({ kind: 'job', ...job }, work);
/** Runs a background task with its name, the same way. */
export const inTask = <T>(task: { id: string; title: string }, work: () => T): T => scope.run({ kind: 'task', ...task }, work);

/** The words that name a program: its file name, and for dmp-root through sudo, the root command (a fixed word). */
export function programName(file: string, args: readonly string[]): string {
  const name = basename(file);
  if (name === 'sudo') {
    const words = args.filter((a) => !a.startsWith('-'));
    const root = words[0] ? basename(words[0]) : '';
    if (root === 'dmp-root' && words[1] && /^[a-z][a-z0-9-]{0,40}$/.test(words[1])) return `dmp-root ${words[1]}`;
    return root ? `sudo ${root}` : 'sudo';
  }
  return name;
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
  const by = p.job ? ` for "${p.job.title}"` : p.task ? ` for the background task "${p.task.title}"` : '';
  const how = p.ended === 'ok' ? 'ended well' : p.ended === 'timeout' ? 'was stopped by its timeout' : `ended with exit ${p.code ?? '?'}`;
  return `${p.program} ran ${Math.round(p.durationMs / 1000)} s${by} and ${how}`;
}

export class RunningPrograms {
  private readonly running = new Map<number, RunningProgram>();
  private readonly ended: FinishedProgram[] = [];
  private readonly reads = new Map<string, { count: number; totalMs: number }>();
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
      const from = by ? { [by.kind]: { id: by.id, title: by.title } } : {};
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
        const done: FinishedProgram = { ...program, durationMs: this.now() - started, ended, ...(result && result.code !== 0 && ended === 'failed' ? { code: result.code } : {}) };
        // A site's page starts several reads at once: the ones that went well and quick are counted, not listed, so they never push a job's out.
        if (!done.job && !done.task && done.ended === 'ok' && done.durationMs < SLOW_READ_MS) {
          const count = this.reads.get(done.program) ?? { count: 0, totalMs: 0 };
          this.reads.set(done.program, { count: count.count + 1, totalMs: count.totalMs + done.durationMs });
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
  pageReads(): Array<{ program: string; count: number; totalMs: number }> {
    return [...this.reads].map(([program, c]) => ({ program, ...c })).sort((a, b) => b.count - a.count);
  }
}

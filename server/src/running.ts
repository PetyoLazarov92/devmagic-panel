import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import type { RunningProgram } from '@devmagic-panel/shared';
import type { Executor } from './exec.js';

/**
 * The programs the panel has running right now, for the status in the top
 * bar: the program's name, when it started, and the job or background task
 * it runs for (neither: a page's read). Never its arguments (a path, a host or a site's name can be in them), its
 * environment or its output. Kept in memory only; a restart starts empty.
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

export class RunningPrograms {
  private readonly running = new Map<number, RunningProgram>();
  private next = 1;

  /** The executor, with every program it runs listed while it runs. One started on its own (detach) is not waited on, so not listed. */
  track(exec: Executor): Executor {
    return (file, args, options) => {
      if (options?.detach) return exec(file, args, options);
      const id = this.next++;
      const by = scope.getStore();
      const from = by ? { [by.kind]: { id: by.id, title: by.title } } : {};
      this.running.set(id, { program: programName(file, args), startedAt: new Date().toISOString(), ...from });
      return exec(file, args, options).finally(() => this.running.delete(id));
    };
  }

  /** The longest running first. */
  list(): RunningProgram[] {
    return [...this.running.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}

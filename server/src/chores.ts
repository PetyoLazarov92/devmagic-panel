import type { BackgroundTask, TaskRun } from '@devmagic-panel/shared';
import { inTask } from './running.js';

/**
 * The work the panel does on its own (housekeeping, the update check), each
 * on a timer of the running panel, with what its last run did: for the
 * Sanctum page, so you can see what runs when without reading the log.
 */

/** A chore's work: what it did, said short ("removed 3 dumps"), or nothing worth saying. It throws when it failed. asked: Run now, not its timer. */
export type ChoreWork = (how: { asked: boolean }) => Promise<string | void> | string | void;

interface Chore extends Omit<BackgroundTask, 'running'> {
  work: ChoreWork;
  running: Promise<void> | null;
}

export class Chores {
  private readonly chores = new Map<string, Chore>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly onError: (id: string, message: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    /** Where each run is kept for the task's history: the panel's database. */
    private readonly history?: { addChoreRun: (task: string, run: TaskRun) => void },
  ) {}

  /** Runs work after firstMs (now by default), then every everyMs. */
  every(id: string, label: string, what: string, everyMs: number, work: ChoreWork, firstMs = 0): void {
    const chore: Chore = { id, label, what, everyMs, work, running: null, nextRunAt: new Date(this.now() + firstMs).toISOString() };
    this.chores.set(id, chore);
    const first = setTimeout(() => {
      void this.run(id);
      const timer = setInterval(() => void this.run(id), everyMs);
      timer.unref?.();
      this.timers.push(timer);
    }, firstMs);
    first.unref?.();
    this.timers.push(first);
  }

  /** Runs one now, or waits for the run in progress. asked: Run now on the Sanctum page, which some work treats as "now, whatever the timer says". */
  async run(id: string, asked = false): Promise<void> {
    const chore = this.chores.get(id);
    if (!chore) return;
    if (chore.running) return chore.running;
    chore.running = (async () => {
      const started = this.now();
      try {
        const note = await inTask({ id: chore.id, title: chore.label }, () => chore.work({ asked }));
        chore.lastOk = true;
        if (note) chore.lastNote = note;
        else delete chore.lastNote;
      } catch (error) {
        chore.lastOk = false;
        chore.lastNote = (error as Error).message;
        this.onError(id, chore.lastNote);
      } finally {
        try {
          this.history?.addChoreRun(chore.id, { startedAt: new Date(started).toISOString(), durationMs: this.now() - started, ok: chore.lastOk === true, ...(chore.lastNote ? { note: chore.lastNote } : {}) });
        } catch {
          // The history is a nicety: a database that cannot take it never stops the work.
        }
        chore.lastRunAt = new Date(started).toISOString();
        chore.nextRunAt = new Date(started + chore.everyMs).toISOString();
        chore.running = null;
      }
    })();
    return chore.running;
  }

  list(): BackgroundTask[] {
    return [...this.chores.values()].map(({ work: _, running, ...rest }) => ({ ...rest, running: running !== null }));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

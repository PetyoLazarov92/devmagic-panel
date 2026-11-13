import { randomUUID } from 'node:crypto';
import type { JobView, RunStep } from '@devmagic-panel/shared';
import type { ExecResult } from './exec.js';
import type { RunStore } from './store.js';
import { inJob } from './running.js';

/**
 * Long-running work (creating a site) as a list of steps. Each step runs in
 * order and records its output; the first failure stops the job. Steps that
 * create something register how to remove it, so a failed or unwanted job
 * can be undone in reverse order, and a failed one retried from its step.
 * Jobs live in memory; the run history keeps the outcome.
 */
export interface JobRuntime {
  /** Registers how to take back what the current step made. */
  onUndo(label: string, undo: () => Promise<ExecResult | ExecResult[]>): void;
  /** Takes back an Undo a step registered, once there is nothing left for it to take back. */
  dropUndo?(label: string): void;
  /** Reports how far the current step is, 0 to 1, with an optional note like "1.2 GB of 3.4 GB". */
  progress(fraction: number, note?: string): void;
  /** Adds a line of what the current step is doing, like "Reading README.md"; the last KEPT_ACTIVITY show, and stay when it ends. */
  activity?(line: string): void;
  /** True once Stop was asked for: a step that works in batches ends after the one it is on. */
  stopped?(): boolean;
}

export interface JobStep {
  id: string;
  label: string;
  /** How long the step usually takes next to the others, for the overall bar; 1 when left out. */
  weight?: number;
  run: (job: JobRuntime) => Promise<ExecResult | ExecResult[]>;
  /** The job may go on without this step when it fails: what that leaves undone, and how to do it yourself. */
  skippable?: string;
}

export interface JobOptions {
  runId: number;
  title: string;
  target?: string;
  kind?: string;
  /** At most this many jobs of the same kind run at once; the rest wait as queued. */
  limit?: number;
  /** Runs once every step is done or skipped, with the job as it ended. */
  onDone?: (view: JobView) => Promise<void> | void;
  /** Runs each time a step fails; Retry may still finish the job. */
  onFailed?: () => void;
  /** Runs once Undo took everything back. */
  onUndone?: () => void;
  /** The uploaded dump the job reads; kept while the job may still need it (running, or failed for a retry). */
  upload?: string;
  /** Stop may end it between batches or steps, failed, so Retry carries on and Undo puts back what it did. */
  stoppable?: boolean;
}

export type { JobView };

interface Job {
  view: JobView;
  steps: JobStep[];
  undos: Array<{ label: string; run: () => Promise<ExecResult | ExecResult[]> }>;
  runId: number;
  limit?: number;
  onDone?: (view: JobView) => Promise<void> | void;
  onFailed?: () => void;
  onUndone?: () => void;
  upload?: string;
}

/** Something that holds a lock: a job, or an action that runs without one, like deleting a trash entry. */
export interface Busy {
  title: string;
  jobId?: string;
  kind?: string;
  target?: string;
}

/** Two lock keys meet when they are the same or one is a path under the other: local.shop.com and local.shop.com/learn. */
export const locksMeet = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

const MAX_OUTPUT = 20_000;
/** The lines of what a step did that it keeps. */
export const KEPT_ACTIVITY = 20;
const KEEP_JOBS = 20;

const asList = (r: ExecResult | ExecResult[]) => (Array.isArray(r) ? r : [r]);
const outputOf = (results: ExecResult[]) => {
  const text = results.map((r) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  return text.length > MAX_OUTPUT ? `...\n${text.slice(-MAX_OUTPUT)}` : text;
};

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly holds = new Map<number, { key: string; title: string }>();
  private nextHold = 0;
  /** When a job last ended, so cached site lists know to look again. */
  finishedAt = 0;
  private readonly ended: Array<(view: JobView) => void> = [];

  constructor(private readonly store: RunStore) {}

  start(steps: JobStep[], options: JobOptions): JobView {
    const { runId, title, target, kind, limit, onDone, onFailed, onUndone, upload, stoppable } = options;
    const id = randomUUID();
    const busy = kind && limit ? [...this.jobs.values()].filter((j) => j.view.kind === kind && j.view.status === 'running').length : 0;
    const job: Job = {
      view: {
        id,
        title,
        ...(target ? { target } : {}),
        ...(kind ? { kind } : {}),
        status: limit && busy >= limit ? 'queued' : 'running',
        steps: steps.map((s) => ({ id: s.id, label: s.label, status: 'pending', ...(s.skippable ? { skippable: s.skippable } : {}) })),
        undo: [],
        undoable: [],
        progress: 0,
        startedAt: new Date().toISOString(),
        runId,
        ...(stoppable ? { stoppable } : {}),
      },
      steps,
      undos: [],
      runId,
      ...(limit ? { limit } : {}),
      ...(onDone ? { onDone } : {}),
      ...(onFailed ? { onFailed } : {}),
      ...(onUndone ? { onUndone } : {}),
      ...(upload ? { upload } : {}),
    };
    this.jobs.set(id, job);
    this.prune();
    if (job.view.status === 'running') void this.runFrom(job, 0);
    return structuredClone(job.view);
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job.view) : undefined;
  }

  /** The job a Run history row belongs to, while it is still in memory. */
  forRun(runId: number): JobView | undefined {
    const job = [...this.jobs.values()].find((j) => j.runId === runId);
    return job ? structuredClone(job.view) : undefined;
  }

  /** Every job still in memory, queued and running ones first, then newest first. */
  list(): JobView[] {
    const active = (v: JobView) => v.status === 'queued' || v.status === 'running' || v.status === 'undoing';
    return [...this.jobs.values()]
      .map((j) => structuredClone(j.view))
      .sort((a, b) => Number(active(b)) - Number(active(a)) || b.startedAt.localeCompare(a.startedAt));
  }

  /** The queued or running job of a kind for a target, like a site that is still being installed. */
  activeFor(kind: string, target: string): JobView | undefined {
    const job = [...this.jobs.values()].find((j) => j.view.kind === kind && j.view.target === target && (j.view.status === 'queued' || j.view.status === 'running'));
    return job ? structuredClone(job.view) : undefined;
  }

  /**
   * What is working on a lock key now: a queued, running or undoing job
   * whose target meets it, or an action holding it. Failed and finished jobs
   * hold nothing, so their site can be fixed by hand and the job retried.
   */
  busyFor(key: string): Busy | undefined {
    const job = [...this.jobs.values()].find(
      (j) => j.view.target !== undefined && locksMeet(j.view.target, key) && (j.view.status === 'queued' || j.view.status === 'running' || j.view.status === 'undoing'),
    );
    if (job) return { title: job.view.title, jobId: job.view.id, ...(job.view.kind ? { kind: job.view.kind } : {}), ...(job.view.target ? { target: job.view.target } : {}) };
    const held = [...this.holds.values()].find((h) => locksMeet(h.key, key));
    return held ? { title: held.title } : undefined;
  }

  /** The uploads a job may still read: running, queued or failed ones (Retry reads the dump again). */
  uploadsInUse(): Set<string> {
    return new Set([...this.jobs.values()].filter((j) => j.upload && j.view.status !== 'done' && j.view.status !== 'undone').map((j) => j.upload as string));
  }

  /** Holds a lock key while an action without a job runs; call the returned function when it ends. */
  hold(key: string, title: string): () => void {
    const id = this.nextHold++;
    this.holds.set(id, { key, title });
    return () => this.holds.delete(id);
  }

  /** Asks a stoppable job to end at its next safe point: between batches of a step, or before the next step. */
  stop(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.view.status !== 'running' || !job.view.stoppable) return undefined;
    job.view.stopping = true;
    return structuredClone(job.view);
  }

  /** Runs a failed job again from its failed step. */
  retry(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.view.status !== 'failed') return undefined;
    const from = job.view.steps.findIndex((s) => s.status === 'failed');
    delete job.view.stopping;
    job.view.status = 'running';
    void this.runFrom(job, Math.max(0, from));
    return structuredClone(job.view);
  }

  /** Goes on past a failed step that may be skipped, keeping its output; the job then finishes without it. */
  skip(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.view.status !== 'failed') return undefined;
    const at = job.view.steps.findIndex((s) => s.status === 'failed');
    const step = job.view.steps[at];
    if (!step?.skippable) return undefined;
    step.status = 'skipped';
    job.view.status = 'running';
    void this.runFrom(job, at + 1);
    return structuredClone(job.view);
  }

  /** Takes back everything the job made, newest first. */
  undo(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.view.status === 'running' || job.view.status === 'undoing' || job.view.status === 'undone') return undefined;
    // A job that made nothing it can take back (a removal, a restore) has nothing to undo.
    if (job.undos.length === 0) return undefined;
    job.view.status = 'undoing';
    job.view.undo = [...job.undos].reverse().map((u, i) => ({ id: `undo-${i}`, label: u.label, status: 'pending' }));
    void this.runUndo(job);
    return structuredClone(job.view);
  }

  private async runFrom(job: Job, from: number): Promise<void> {
    let current = from;
    const runtime: JobRuntime = {
      onUndo: (label, run) => {
        job.undos.push({ label, run });
        job.view.undoable = job.undos.map((u) => u.label).reverse();
      },
      dropUndo: (label) => {
        job.undos = job.undos.filter((u) => u.label !== label);
        job.view.undoable = job.undos.map((u) => u.label).reverse();
      },
      progress: (fraction, note) => {
        const view = job.view.steps[current] as RunStep;
        view.progress = Math.min(1, Math.max(0, fraction));
        if (note) view.note = note;
        this.updateProgress(job);
      },
      activity: (line) => {
        const view = job.view.steps[current] as RunStep;
        view.activity = [...(view.activity ?? []), line].slice(-KEPT_ACTIVITY);
      },
      stopped: () => job.view.stopping === true,
    };
    for (let i = from; i < job.steps.length; i++) {
      current = i;
      const step = job.steps[i] as JobStep;
      const view = job.view.steps[i] as RunStep;
      if (job.view.stopping) {
        view.status = 'failed';
        view.output = 'Stopped before this step: Retry carries on from here, Undo puts back what the job did.';
        job.view.status = 'failed';
        this.finish(job, 1, 'stopped');
        this.startQueued(job.view.kind);
        return;
      }
      view.status = 'running';
      delete view.output;
      delete view.progress;
      delete view.note;
      delete view.activity;
      const started = Date.now();
      let results: ExecResult[];
      try {
        results = asList(await inJob({ id: job.view.id, title: job.view.title }, () => step.run(runtime)));
      } catch (error) {
        results = [{ code: 1, stdout: '', stderr: (error as Error).message }];
      }
      view.durationMs = Date.now() - started;
      // What the step did comes first, so Run history keeps it and the last line still says how it ended.
      const output = [...(view.activity ?? []), outputOf(results)].filter(Boolean).join('\n');
      if (output) view.output = output;
      delete view.progress;
      delete view.note;
      if (results.some((r) => r.code !== 0)) {
        view.status = 'failed';
        job.view.status = 'failed';
        this.finish(job, 1);
        this.startQueued(job.view.kind);
        job.onFailed?.();
        return;
      }
      view.status = 'done';
      this.updateProgress(job);
    }
    job.view.status = 'done';
    const skipped = job.view.steps.filter((s) => s.status === 'skipped').length;
    this.finish(job, 0, skipped ? `done, ${skipped === 1 ? '1 step' : `${skipped} steps`} skipped` : undefined, skipped);
    this.startQueued(job.view.kind);
    await job.onDone?.(structuredClone(job.view));
  }

  private updateProgress(job: Job): void {
    const weights = job.steps.map((s) => s.weight ?? 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const done = job.view.steps.reduce((sum, s, i) => sum + (weights[i] as number) * (s.status === 'done' || s.status === 'skipped' ? 1 : s.status === 'running' ? (s.progress ?? 0) : 0), 0);
    job.view.progress = Math.min(1, done / total);
  }

  /** Starts the oldest queued job of a kind when a slot is free. */
  private startQueued(kind: string | undefined): void {
    if (!kind) return;
    const all = [...this.jobs.values()].filter((j) => j.view.kind === kind);
    const next = all.filter((j) => j.view.status === 'queued').sort((a, b) => a.view.startedAt.localeCompare(b.view.startedAt))[0];
    if (!next) return;
    const running = all.filter((j) => j.view.status === 'running').length;
    if (running >= (next.limit ?? Infinity)) return;
    next.view.status = 'running';
    void this.runFrom(next, 0);
  }

  private async runUndo(job: Job): Promise<void> {
    const undos = [...job.undos].reverse();
    let failed = false;
    for (const [i, undo] of undos.entries()) {
      const view = job.view.undo[i] as RunStep;
      view.status = 'running';
      let results: ExecResult[];
      try {
        results = asList(await undo.run());
      } catch (error) {
        results = [{ code: 1, stdout: '', stderr: (error as Error).message }];
      }
      const output = outputOf(results);
      if (output) view.output = output;
      // Keep going: take back as much as possible even when one part fails.
      view.status = results.some((r) => r.code !== 0) ? 'failed' : 'done';
      if (view.status === 'failed') failed = true;
    }
    job.undos = [];
    job.view.undoable = [];
    job.view.status = failed ? 'failed' : 'undone';
    this.finish(job, failed ? 1 : 0, failed ? 'undo did not finish' : 'undone');
    if (!failed) job.onUndone?.();
  }

  /** Called each time a job ends, undone or failed too, like to forget what was read about its site. */
  onEnd(listener: (view: JobView) => void): void {
    this.ended.push(listener);
  }

  private finish(job: Job, exitCode: number, note?: string, skipped?: number): void {
    this.finishedAt = Date.now();
    for (const listener of this.ended) listener(structuredClone(job.view));
    const lines = job.view.steps.map((s) => `${s.status.padEnd(7)} ${s.label}${s.output ? `\n${s.output}` : ''}`);
    if (note) lines.push(note);
    this.store.finish(job.runId, exitCode, lines.join('\n'), skipped);
  }

  private prune(): void {
    const finished = [...this.jobs.entries()].filter(([, j]) => j.view.status !== 'running' && j.view.status !== 'undoing' && j.view.status !== 'queued');
    for (const [id] of finished.slice(0, Math.max(0, this.jobs.size - KEEP_JOBS))) this.jobs.delete(id);
  }
}

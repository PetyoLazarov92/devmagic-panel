import type { StorageCleanKind } from './actions.js';

/**
 * What the panel itself is doing, for the status in the top bar and the
 * Sanctum page: since when it runs, the programs it has running, and the
 * work it does on its own. No path, argument or output of a program.
 */

/** A program the panel runs right now: its name (dmp-root with its command), since when, and what started it: a job, a background task, or else a page's read. */
export interface RunningProgram {
  program: string;
  startedAt: string;
  job?: { id: string; title: string };
  task?: { id: string; title: string };
}

/** A program that ended lately, kept in memory for Sanctum's Recently finished: how long it took and how it ended. */
export interface FinishedProgram extends RunningProgram {
  durationMs: number;
  /** ok, failed (with its exit code), or stopped by the panel's timeout for it. */
  ended: 'ok' | 'failed' | 'timeout';
  code?: number;
}

/** One run of a background task, kept in the panel's database (the newest 20 per task). */
export interface TaskRun {
  startedAt: string;
  durationMs: number;
  ok: boolean;
  note?: string;
}

/** Work the panel does on its own, on a timer. */
export interface BackgroundTask {
  id: string;
  label: string;
  /** What it does, in a sentence. */
  what: string;
  everyMs: number;
  running: boolean;
  lastRunAt?: string;
  lastOk?: boolean;
  /** What the last run did ("removed 3 dumps") or why it failed. */
  lastNote?: string;
  nextRunAt?: string;
}

export interface PanelStatus {
  version: string;
  startedAt: string;
  /** How the run before this one ended: stopped (a restart, an update, logging out) or unexpectedly (a crash, the computer turned off). */
  before?: { startedAt: string; stoppedAt?: string; ended: 'stopped' | 'unexpectedly' };
  memoryBytes: number;
  /** Jobs running or waiting their turn. */
  jobs: number;
  programs: RunningProgram[];
  /** The last programs worth a look that ended, newest first: a job's or a task's, and page reads that failed or were slow. Empty after a restart. */
  finished: FinishedProgram[];
  /** Page reads that went well since the panel started, counted per program instead of listed: a site's page starts several at once. */
  pageReads: Array<{ program: string; count: number; totalMs: number }>;
  tasks: BackgroundTask[];
}

/** One kind of thing the panel keeps on disk, for the Sanctum page: how much, and how long it stays. */
export interface StorageRow {
  id: string;
  label: string;
  /** What it is, in a sentence. */
  what: string;
  /** Bytes on disk; null when it cannot be read (root's folders, or in MySQL). */
  bytes: number | null;
  /** How many there are, when that says more than the size (kept databases). */
  count?: number;
  /** How long it stays, said plainly. */
  kept: string;
  /** Clean up now: the kind storage.clean removes all of, and what goes, said for the confirmation. */
  clean?: { kind: StorageCleanKind; goes: string };
  /** For a kind no task clears: why, and where you manage it. */
  manage?: { note: string; label?: string; href?: string };
  /** Kept databases one by one, for Drop all now: the database, its site and when it would go by itself. */
  items?: Array<{ name: string; domain: string; path?: string; goesAt: string }>;
  /** Where it is, for Developer mode only. */
  where: string[];
}

export interface PanelStorage {
  measuredAt: string;
  rows: StorageRow[];
  /** The sum of the sizes that could be read. */
  totalBytes: number;
}

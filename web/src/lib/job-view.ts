import type { JobView } from '@devmagic-panel/shared';

/** The jobs a place shows again when you come back while one still runs: its actions, and the site it is about when it has one. */
export interface ResumeJobs {
  kinds: readonly string[];
  /** The job's target, as the server names it (a site's domain, or domain and path); left out, any target. */
  targets?: readonly string[];
}

/** The newest job of these kinds that still runs, for a place that opened after it started; a finished one never comes back. */
export function runningJobOf(list: readonly JobView[], resume: ResumeJobs): JobView | undefined {
  return list
    .filter((j) => j.kind !== undefined && resume.kinds.includes(j.kind) && (!resume.targets || (j.target !== undefined && resume.targets.includes(j.target))))
    .filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'undoing')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/**
 * Whether a job box folds to its one line now: the job ended well (done or
 * undone, never failed), it is not folded yet, you did not open it again, and
 * nothing in it is being read (the pointer or focus in it, a step open).
 */
export function foldDue(box: { status: JobView['status']; folded: boolean; kept: boolean; inside: boolean; open: string | null }): boolean {
  return (box.status === 'done' || box.status === 'undone') && !box.folded && !box.kept && !box.inside && box.open === null;
}

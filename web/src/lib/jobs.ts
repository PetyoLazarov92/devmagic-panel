import type { JobView } from '@devmagic-panel/shared';
import { useEffect } from 'react';
import { JOB_STARTED } from '@/lib/api';

export const jobActive = (j: JobView) => j.status === 'queued' || j.status === 'running' || j.status === 'undoing';

/** "1 step skipped", "2 steps skipped". */
export const stepsSkipped = (n: number) => (n === 1 ? '1 step skipped' : `${n} steps skipped`);

/** What a job is doing now, in a few words. */
export function jobState(j: JobView): string {
  if (j.status === 'queued') return 'Waiting for a free slot';
  if (j.status === 'running' || j.status === 'undoing') return j.steps.find((s) => s.status === 'running')?.label ?? (j.status === 'undoing' ? 'Undoing' : 'Starting');
  if (j.status === 'failed') return `Stopped at: ${j.steps.find((s) => s.status === 'failed')?.label ?? 'undo'}`;
  if (j.status === 'undone') return 'Undone';
  const skipped = j.steps.filter((s) => s.status === 'skipped');
  return skipped.length ? `Done, ${stepsSkipped(skipped.length)}: ${skipped.map((s) => s.label).join(', ')}` : 'Done';
}

/** Reloads a page's data every few seconds while one of its jobs runs, and as soon as a job starts. */
export function useReloadWhileBusy(busy: boolean, reload: () => void): void {
  useEffect(() => {
    window.addEventListener(JOB_STARTED, reload);
    const timer = busy ? window.setInterval(reload, 3000) : undefined;
    return () => {
      window.removeEventListener(JOB_STARTED, reload);
      window.clearInterval(timer);
    };
  }, [busy, reload]);
}

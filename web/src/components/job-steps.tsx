import type { JobView, RunStep } from '@devmagic-panel/shared';
import { Check, ChevronRight, CircleX, LoaderCircle, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AnsiText } from '@/components/ansi-text';
import { api } from '@/lib/api';
import { duration } from '@/lib/format';
import { cn } from '@/lib/utils';

/** True once a job stopped moving: done, failed, or undone. A queued job has not started yet. */
export const settled = (job: JobView | null) => job !== null && job.status !== 'running' && job.status !== 'undoing' && job.status !== 'queued';

/**
 * Follows a server job: start it with a promise of its id, then the view
 * refreshes until it settles. The server keeps working if the page closes.
 */
export function useJob() {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || settled(job)) return;
    const timer = window.setTimeout(() => api.job(job.id).then(setJob, (err: Error) => setError(err.message)), 600);
    return () => window.clearTimeout(timer);
  }, [job]);

  async function follow(started: Promise<string>) {
    setError(null);
    setJob(null);
    try {
      setJob(await api.job(await started));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function retry() {
    if (!job) return;
    try {
      setJob(await api.retryJob(job.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return { job, error, follow, retry, clear: () => { setJob(null); setError(null); } };
}

export function StepList({ steps, open, setOpen }: { steps: RunStep[]; open: string | null; setOpen: (id: string | null) => void }) {
  return (
    <ol className="divide-y rounded-xl border bg-card">
      {steps.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm disabled:cursor-default"
            onClick={() => setOpen(open === s.id ? null : s.id)}
            disabled={!s.output}
            aria-expanded={s.output ? open === s.id : undefined}
          >
            <StepIcon status={s.status} />
            <span className="grid flex-1 gap-1">
              <span className={cn(s.status === 'pending' && 'text-muted-foreground', s.status === 'failed' && 'font-medium text-danger', s.status === 'skipped' && 'text-muted-foreground')}>{s.label}</span>
              {s.status === 'skipped' && s.skippable && <span className="text-xs text-warning">Skipped: {s.skippable}</span>}
              {s.status === 'running' && (s.note || s.progress !== undefined) && (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {s.progress !== undefined && (
                    <span className="h-1 w-32 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                    </span>
                  )}
                  {s.note}
                </span>
              )}
              {/* A Claude Code step: the last thing it did. */}
              {s.status === 'running' && !s.note && s.activity?.length ? <span className="truncate text-xs text-muted-foreground">{s.activity.at(-1)}</span> : null}
            </span>
            {s.durationMs !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{duration(s.durationMs)}</span>}
            {s.output && <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', open === s.id && 'rotate-90')} />}
          </button>
          {s.output && open === s.id && (
            <pre className={cn('mx-4 mb-3 max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]', s.status === 'failed' && 'text-danger')}><AnsiText text={s.output} /></pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export function StepIcon({ status }: { status: RunStep['status'] }) {
  if (status === 'running') return <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-label="Running" />;
  if (status === 'done') return <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-white" aria-label="Done"><Check className="size-2.5" strokeWidth={3} /></span>;
  if (status === 'failed') return <CircleX className="size-4 shrink-0 text-danger" aria-label="Failed" />;
  if (status === 'skipped') return <SkipForward className="size-4 shrink-0 text-warning" aria-label="Skipped" />;
  return <span className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/30" aria-label="Pending" />;
}

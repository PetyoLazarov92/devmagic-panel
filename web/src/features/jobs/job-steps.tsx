import type { JobView, RunStep } from '@devmagic-panel/shared';
import { Check, ChevronRight, CircleX, SkipForward } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AnsiText } from '@/components/layout/ansi-text';
import { api } from '@/lib/api';
import { duration } from '@/lib/format';
import { loadThroughRestart } from '@/lib/startup';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

/** The jobs a page shows right now: the header tells about any other one when it ends. */
const followed = new Set<string>();
export const isFollowed = (id: string) => followed.has(id);

/** Marks a job as shown on this page while the component lives (a job's own page, an install screen). */
export function useFollowed(id: string | undefined) {
  useEffect(() => {
    if (!id) return;
    followed.add(id);
    return () => {
      followed.delete(id);
    };
  }, [id]);
}

/**
 * Shows again a job of this site that runs since before the page opened, like
 * a clean-up you started and left: in the card whose button started it.
 * kinds maps the job's action to that card; found is told which one.
 */
export function useResumeJob<T>(runner: { job: JobView | null; attach: (view: JobView) => void }, target: string, kinds: Partial<Record<string, T>>, found: (slot: T) => void) {
  const keep = useRef({ runner, kinds, found });
  keep.current = { runner, kinds, found };
  useEffect(() => {
    let live = true;
    api.jobs().then(
      (list) => {
        const { runner: r, kinds: k, found: f } = keep.current;
        if (!live || r.job) return;
        const job = list
          .filter((j) => j.target === target && j.kind !== undefined && k[j.kind] !== undefined && (j.status === 'running' || j.status === 'queued' || j.status === 'undoing'))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!job?.kind) return;
        f(k[job.kind] as T);
        r.attach(job);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [target]);
}

/** True once a job stopped moving: done, failed, or undone. A queued job has not started yet. */
export const settled = (job: JobView | null) => job !== null && job.status !== 'running' && job.status !== 'undoing' && job.status !== 'queued';

/**
 * Follows a server job: start it with a promise of its id, then the view
 * refreshes until it settles. The server keeps working if the page closes.
 */
export function useJob() {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFollowed(job?.id);

  useEffect(() => {
    if (!job || settled(job)) return;
    let live = true;
    const timer = window.setTimeout(() => {
      loadThroughRestart(() => api.job(job.id), { stopped: () => !live }).then(
        (view) => live && setJob(view),
        (err: Error) => live && setError(err.message),
      );
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
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

  /** Shows a job that started before this page opened, like one still running after you came back. */
  function attach(view: JobView) {
    setError(null);
    setJob(view);
  }

  /** Asks the job to stop at its next safe point; it ends failed, so Retry carries on and Undo puts back what it did. */
  async function stop() {
    if (!job) return;
    try {
      setJob(await api.stopJob(job.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return { job, error, follow, retry, attach, stop, clear: () => { setJob(null); setError(null); } };
}

export function StepList({ steps, open, setOpen }: { steps: RunStep[]; open: string | null; setOpen: (id: string | null) => void }) {
  return (
    <Card>
      <ol className="divide-y">
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
    </Card>
  );
}

export function StepIcon({ status }: { status: RunStep['status'] }) {
  if (status === 'running') return <Spinner className="size-4 shrink-0 text-primary" label="Running" />;
  if (status === 'done') return <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-white" aria-label="Done"><Check className="size-2.5" strokeWidth={3} /></span>;
  if (status === 'failed') return <CircleX className="size-4 shrink-0 text-danger" aria-label="Failed" />;
  if (status === 'skipped') return <SkipForward className="size-4 shrink-0 text-warning" aria-label="Skipped" />;
  return <span className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/30" aria-label="Pending" />;
}

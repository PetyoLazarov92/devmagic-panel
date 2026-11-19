import type { JobView } from '@devmagic-panel/shared';
import { RotateCcw, Square, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { settled, StepIcon, StepList } from '@/features/jobs/job-steps';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Link } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';
import { duration } from '@/lib/format';
import { foldDue } from '@/lib/job-view';
import { Spinner } from '@/components/ui/spinner';

/** A job that ended well folds to one line after this long, unless you are reading it. */
export const JOB_FOLD_MS = 4_000;

/** How long a job took, from its steps. */
const tookMs = (job: JobView) => job.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

/**
 * A job where it was started: under the card whose button started it (or at
 * the top of a list for a row's menu), scrolled into view, with its steps,
 * Retry when it failed and the way to Undo once it settled. The header's jobs
 * indicator is the view of every job.
 *
 * While it runs it shows every step. Once it ends well it folds to one line
 * after JOB_FOLD_MS (not while the pointer or the focus is in it, a step is
 * open, or you opened it again), with Steps, its Undo and ×. A failed job
 * stays open, its failed step's output showing, until you dismiss it. ×
 * (onDismiss) only takes it off this place: the job stays in Activity and
 * Run history.
 */
export function JobBox({ job, onRetry, onStop, stopNote, onDismiss, scroll = true }: {
  job: JobView;
  onRetry: () => void;
  onStop?: () => void;
  /** What a stop leaves, when it is not a clean-up's batches. */
  stopNote?: string;
  /** Takes the job off this place once it settled; without it, no ×. */
  onDismiss?: () => void;
  /** False where the box is a sample (the Parts page): it does not scroll itself into view. */
  scroll?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  // Opened again by you: it stays open.
  const [kept, setKept] = useState(false);
  const [inside, setInside] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ended = settled(job);
  const failed = job.status === 'failed';
  const failedStep = job.steps.find((s) => s.status === 'failed');

  // A new job comes into view where it was started, clear of a sticky strip at the top (the PHP tab's), and starts open.
  useEffect(() => {
    setFolded(false);
    setKept(false);
    setOpen(null);
    // A block, not an expression: newer browsers return a promise from scrollIntoView, which an effect must not return.
    if (scroll) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [job.id, scroll]);
  // A failed step shows what went wrong without a click.
  useEffect(() => {
    if (failed && failedStep?.output) setOpen(failedStep.id);
  }, [failed, failedStep?.id, failedStep?.output]);
  useEffect(() => {
    if (!foldDue({ status: job.status, folded, kept, inside, open })) return;
    const timer = window.setTimeout(() => setFolded(true), JOB_FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [job.status, folded, kept, inside, open]);

  const dismiss = ended && onDismiss && (
    <IconButton icon={X} label="Dismiss: the job stays in Activity" size="icon-sm" className="ml-auto shrink-0 text-muted-foreground" onClick={onDismiss} />
  );
  const undo = ended && job.undoable.length > 0;

  return (
    <div
      ref={ref}
      className="grid scroll-mt-24 gap-2"
      data-job-state={folded ? 'folded' : job.status}
      onPointerEnter={() => setInside(true)}
      onPointerLeave={() => setInside(false)}
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
      }}
    >
      {folded ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <StepIcon status={job.status === 'undone' ? 'skipped' : 'done'} />
          <span className="min-w-0">
            {job.title}: {job.status === 'undone' ? 'undone' : `done${tookMs(job) ? ` in ${duration(tookMs(job))}` : ''}`}
          </span>
          <Button
            variant="soft"
            size="xs"
            onClick={() => {
              setFolded(false);
              setKept(true);
            }}
          >
            Steps
          </Button>
          {undo && job.status !== 'undone' && (
            <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              Undo on its page
            </Link>
          )}
          {dismiss}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm font-medium">
            {!ended && <Spinner className="size-4 text-primary" />}
            {job.title}
            {dismiss}
          </p>
          <StepList steps={job.steps} open={open} setOpen={setOpen} />
          {job.stoppable && job.status === 'running' && onStop && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={job.stopping} onClick={onStop}>
                <Square />
                {job.stopping ? 'Stopping...' : 'Stop'}
              </Button>
              <span className="text-xs text-muted-foreground">
                {stopNote ?? (job.stopping ? 'It ends after the batch it is on.' : 'Ends after the batch it is on; Retry carries on, Undo puts back what it removed.')}
              </span>
            </div>
          )}
          {failed && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1 text-sm text-danger">{lastLine(failedStep?.output ?? '')}</p>
              <Button variant="outline" size="sm" onClick={onRetry}><RotateCcw />Retry</Button>
            </div>
          )}
          {undo && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Undo2 className="size-3.5" />
              To take it back, use Undo on <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-foreground hover:underline">the job&apos;s page</Link>.
            </p>
          )}
        </>
      )}
    </div>
  );
}


/**
 * A job as the footer of the card whose button started it, under a line, the
 * way every page shows one: never a box of its own between cards, so the cards
 * around it stay where they are. With the error when the job did not start.
 * Gone once you dismiss it (onDismiss, usually the runner's clear).
 */
export function JobFooter({ job, error, onRetry, onStop, stopNote, onDismiss }: { job: JobView | null; error?: string | null; onRetry: () => void; onStop?: () => void; stopNote?: string; onDismiss?: () => void }) {
  if (!job && !error) return null;
  return (
    <div className="grid gap-3 border-t px-5 py-4 text-sm">
      {job && <JobBox job={job} onRetry={onRetry} {...(onStop ? { onStop } : {})} {...(stopNote ? { stopNote } : {})} {...(onDismiss ? { onDismiss } : {})} />}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  );
}

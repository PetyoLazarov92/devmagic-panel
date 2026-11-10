import type { JobView } from '@devmagic-panel/shared';
import { LoaderCircle, RotateCcw, Square, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { settled, StepList } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';

/**
 * A job where it was started: under the card whose button started it (or at
 * the top of a list for a row's menu), scrolled into view, with its steps,
 * Retry when it failed and the way to Undo once it settled. The header's jobs
 * indicator is the view of every job.
 */
export function JobBox({ job, onRetry, onStop, stopNote }: { job: JobView; onRetry: () => void; onStop?: () => void; /** What a stop leaves, when it is not a clean-up's batches. */ stopNote?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A new job comes into view where it was started, clear of a sticky strip at the top (the PHP tab's).
  useEffect(() => {
    // A block, not an expression: newer browsers return a promise from scrollIntoView, which an effect must not return.
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [job.id]);
  return (
    <div ref={ref} className="grid scroll-mt-24 gap-2">
      <p className="flex items-center gap-2 text-sm font-medium">{!settled(job) && <LoaderCircle className="size-4 animate-spin text-primary" />}{job.title}</p>
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
      {job.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm text-danger">{lastLine(job.steps.find((s) => s.status === 'failed')?.output ?? '')}</p>
          <Button variant="outline" size="sm" onClick={onRetry}><RotateCcw />Retry</Button>
        </div>
      )}
      {settled(job) && job.undoable.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Undo2 className="size-3.5" />
          To take it back, use Undo on <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-foreground hover:underline">the job&apos;s page</Link>.
        </p>
      )}
    </div>
  );
}


/**
 * A job as the footer of the card whose button started it, under a line, the
 * way every page shows one: never a box of its own between cards, so the cards
 * around it stay where they are. With the error when the job did not start.
 */
export function JobFooter({ job, error, onRetry, onStop, stopNote }: { job: JobView | null; error?: string | null; onRetry: () => void; onStop?: () => void; stopNote?: string }) {
  if (!job && !error) return null;
  return (
    <div className="grid gap-3 border-t px-5 py-4 text-sm">
      {job && <JobBox job={job} onRetry={onRetry} {...(onStop ? { onStop } : {})} {...(stopNote ? { stopNote } : {})} />}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  );
}

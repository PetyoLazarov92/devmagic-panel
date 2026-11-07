import type { JobView } from '@devmagic-panel/shared';
import { CircleAlert, ListChecks, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isFollowed } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { api, JOB_STARTED } from '@/lib/api';
import { jobActive, jobState } from '@/lib/jobs';
import { Link, navigate, usePath } from '@/lib/router';
import { onJobSeen, seenJobs } from '@/lib/seen-jobs';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const SHOWN = 6;

/**
 * Jobs in the header, each a link back to its page. It spins while jobs run,
 * stays red while a failed job is unopened, and sits grey once all are done,
 * so the jobs page is always one click away. Hidden only when no job ran
 * since the panel started. Polls often while something runs, rarely otherwise.
 */
export function JobsIndicator() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [seen, setSeen] = useState(seenJobs);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const last = useRef(new Map<string, JobView['status']>());
  const path = usePath();

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = () =>
      api.jobs().then(
        (list) => {
          if (stop) return;
          // A job that ended while no page shows it, like after you left its page: say so, with the way there.
          for (const j of list) {
            const before = last.current.get(j.id);
            if (before && jobActive({ status: before } as JobView) && !jobActive(j) && !isFollowed(j.id)) {
              toast({
                tone: j.status === 'done' ? 'success' : j.status === 'failed' ? 'danger' : 'info',
                title: `${j.title}: ${j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : j.status}`,
                action: { label: 'Open', run: () => navigate(`/jobs/${encodeURIComponent(j.id)}`) },
              });
            }
          }
          last.current = new Map(list.map((j) => [j.id, j.status]));
          setJobs(list);
          // One timer only, even when a started job asked for an extra look while a poll was out.
          window.clearTimeout(timer);
          timer = window.setTimeout(tick, list.some(jobActive) ? 2000 : 10_000);
        },
        () => {
          if (stop) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(tick, 15_000);
        },
      );
    void tick();
    const now = () => {
      window.clearTimeout(timer);
      void tick();
    };
    window.addEventListener(JOB_STARTED, now);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      window.removeEventListener(JOB_STARTED, now);
    };
    // A new path may mean a job just started; look again right away.
  }, [path]);

  useEffect(() => onJobSeen(() => setSeen(seenJobs())), []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (jobs.length === 0) return null;
  const running = jobs.filter(jobActive);
  const queued = running.filter((j) => j.status === 'queued').length;
  const failed = jobs.filter((j) => j.status === 'failed');
  const unseen = failed.filter((j) => !seen.has(j.id)).length;
  const listed = [...running, ...failed].slice(0, SHOWN);

  return (
    <div ref={box} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Jobs"
        className={cn(unseen > 0 && 'border-danger/40 text-danger hover:text-danger', running.length === 0 && unseen === 0 && 'text-muted-foreground')}
      >
        {running.length > 0 ? <LoaderCircle className="animate-spin text-primary" /> : unseen > 0 ? <CircleAlert /> : <ListChecks />}
        <span>
          {running.length > 0 && `${running.length - queued} running${queued ? `, ${queued} queued` : ''}`}
          {running.length > 0 && unseen > 0 && ', '}
          {unseen > 0 && <span className="text-danger">{unseen} failed</span>}
          {running.length === 0 && unseen === 0 && `${jobs.length} job${jobs.length > 1 ? 's' : ''}`}
        </span>
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-lg border bg-card p-1.5 text-sm shadow-lg">
          {listed.length === 0 && <p className="px-2.5 py-2 text-muted-foreground">Nothing running or failed.</p>}
          {/* One column no wider than the card: a long file name is cut short instead of pushing the card open. */}
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
            {listed.map((j) => (
              <li key={j.id} className="min-w-0">
                <Link href={`/jobs/${encodeURIComponent(j.id)}`} title={j.title} className="grid grid-cols-[minmax(0,1fr)] gap-1 rounded-md px-2.5 py-2 hover:bg-muted" onClick={() => setOpen(false)}>
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{j.title}</span>
                    <span className={cn('shrink-0 text-xs tabular-nums', j.status === 'failed' ? 'text-danger' : 'text-muted-foreground')}>
                      {j.status === 'failed' ? 'failed' : j.status === 'queued' ? 'queued' : `${Math.round(j.progress * 100)}%`}
                    </span>
                  </span>
                  {j.status !== 'failed' && (
                    <span className="h-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                    </span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">{jobState(j)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/activity" className="mt-1 block rounded-md border-t px-2.5 pt-2 pb-1.5 text-xs font-medium text-primary hover:underline" onClick={() => setOpen(false)}>
            All jobs
          </Link>
        </div>
      )}
    </div>
  );
}

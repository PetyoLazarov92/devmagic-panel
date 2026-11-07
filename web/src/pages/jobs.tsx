import { CircleAlert, CircleCheck, CircleX, Layers, LoaderCircle, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { jobActive, jobState } from '@/lib/jobs';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { ListSkeleton } from '@/components/skeletons';
import { EmptyState, Notice, PageHeader } from '@/components/page';

/** Every job since the panel started: running and queued first, then the newest. */
export function JobsPage() {
  const { data: jobs, error, loading } = useAsync(() => api.jobs(), []);
  return (
    <div className="mx-auto w-full max-w-3xl pt-4">
      <PageHeader
        title="Jobs"
        intro={<>Installs, imports, restores and other long actions since the panel last started. Older ones are in <Link href="/runs" className="text-primary hover:underline">Run history</Link>.</>}
      />
      {error && <Notice className="mt-6">{error}</Notice>}
      {jobs && jobs.length === 0 && (
        <EmptyState className="mt-6" icon={Layers} title="No jobs since the panel started">
          Installs, imports, restores and other long actions show here while they run, with their steps.
        </EmptyState>
      )}
      {!jobs && loading && <ListSkeleton className="mt-6" rows={5} />}
      {jobs && jobs.length > 0 && (
        <ul className="mt-6 divide-y overflow-hidden rounded-xl border bg-card">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${encodeURIComponent(j.id)}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/40">
                {jobActive(j) ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-label="Running" />
                ) : j.status === 'failed' ? (
                  <CircleX className="size-4 shrink-0 text-danger" aria-label="Failed" />
                ) : j.status === 'undone' ? (
                  <Undo2 className="size-4 shrink-0 text-muted-foreground" aria-label="Undone" />
                ) : j.steps.some((s) => s.status === 'skipped') ? (
                  <CircleAlert className="size-4 shrink-0 text-warning" aria-label="Done, with steps skipped" />
                ) : (
                  <CircleCheck className="size-4 shrink-0 text-success" aria-label="Done" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{j.title}</span>
                  <span className={cn('block truncate text-xs', j.status === 'failed' ? 'text-danger' : j.status === 'done' && j.steps.some((s) => s.status === 'skipped') ? 'text-warning' : 'text-muted-foreground')}>{jobState(j)}</span>
                </span>
                {jobActive(j) && j.status !== 'queued' && <span className="text-xs text-muted-foreground tabular-nums">{Math.round(j.progress * 100)}%</span>}
                <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">{timeAgo(j.startedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

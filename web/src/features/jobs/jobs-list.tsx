import { CircleAlert, CircleCheck, CircleX, Layers, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { jobActive, jobState } from '@/lib/jobs';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { TableSkeleton } from '@/components/layout/skeletons';
import { EmptyState, Notice, PageHeader } from '@/components/layout/page';
import { Spinner } from '@/components/ui/spinner';
import { Card } from '@/components/ui/card';
import { TextLink } from '@/components/ui/text-link';

/** Every job since the panel started: running and queued first, then the newest. Bare: inside Activity, without its own header. */
export function JobsPage({ bare = false }: { bare?: boolean }) {
  const { data: jobs, error, loading } = useAsync(() => api.jobs(), []);
  return (
    <div className={bare ? '' : 'pt-4'}>
      {bare ? (
        <p className="mt-5 text-sm text-muted-foreground">Installs, imports, restores and other long actions since the panel last started. Older ones are in <TextLink href="/activity/runs">Run history</TextLink>.</p>
      ) : (
        <PageHeader
          title="Jobs"
          intro={<>Installs, imports, restores and other long actions since the panel last started. Older ones are in <TextLink href="/activity/runs">Run history</TextLink>.</>}
        />
      )}
      {error && <Notice className="mt-6">{error}</Notice>}
      {jobs && jobs.length === 0 && (
        <EmptyState className="mt-6" icon={Layers} title="No jobs since the panel started">
          Installs, imports, restores and other long actions show here while they run, with their steps.
        </EmptyState>
      )}
      {!jobs && loading && <TableSkeleton className="mt-6" columns={4} rows={5} />}
      {jobs && jobs.length > 0 && (
        // The same table as Run history, so the two tabs of Activity read alike.
        <Card className="mt-6 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2.5"><span className="sr-only">State</span></th>
                <th className="px-2 py-2.5 font-medium">Job</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Site</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Steps</th>
                <th className="px-4 py-2.5 text-right font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((j) => {
                const skipped = j.steps.some((s) => s.status === 'skipped');
                const finished = j.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
                return (
                  <tr key={j.id} className="relative hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      {jobActive(j) ? (
                        <Spinner className="size-4 text-primary" label="Running" />
                      ) : j.status === 'failed' ? (
                        <CircleX className="size-4 text-danger" aria-label="Failed" />
                      ) : j.status === 'undone' ? (
                        <Undo2 className="size-4 text-muted-foreground" aria-label="Undone" />
                      ) : skipped ? (
                        <CircleAlert className="size-4 text-warning" aria-label="Done, with steps skipped" />
                      ) : (
                        <CircleCheck className="size-4 text-success" aria-label="Done" />
                      )}
                    </td>
                    <td className="min-w-0 px-2 py-2.5">
                      {/* The whole row opens the job; the site link sits above that. */}
                      <Link href={`/jobs/${encodeURIComponent(j.id)}`} className="font-medium after:absolute after:inset-0 focus-visible:outline-none">{j.title}</Link>
                      <span className={cn('block text-xs', j.status === 'failed' ? 'text-danger' : j.status === 'done' && skipped ? 'text-warning' : 'text-muted-foreground')}>{jobState(j)}</span>
                    </td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      {j.target && <Link href={`/sites/${encodeURIComponent(j.target)}`} className="relative z-10 font-mono text-dense hover:underline">{j.target}</Link>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">
                      {jobActive(j) && j.status !== 'queued' ? `${Math.round(j.progress * 100)}%` : j.steps.length ? `${finished} of ${j.steps.length}` : ''}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground">{timeAgo(j.startedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

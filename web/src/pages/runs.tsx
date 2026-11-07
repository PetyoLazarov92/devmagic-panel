import { RUN_KEEP_DAYS, RUN_KEEP_MAX, type RunSummary } from '@devmagic-panel/shared';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleSlash, CircleX, History, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { duration, timeAgo } from '@/lib/format';
import { stepsSkipped } from '@/lib/jobs';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { EmptyState, Notice, PageHeader } from '@/components/page';
import { Reading, TableSkeleton } from '@/components/skeletons';

/** The page in the address, so a page can be reloaded or linked: /runs?page=3. */
function pageFromUrl(): number {
  const n = Number(new URLSearchParams(window.location.search).get('page'));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** Page numbers to show: the first, the last, and two either side of the current one, with gaps as null. */
export function pageList(current: number, last: number): Array<number | null> {
  const wanted = [...new Set([1, last, ...[-2, -1, 0, 1, 2].map((d) => current + d)])].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
  return wanted.flatMap((n, i) => (i > 0 && n - (wanted[i - 1] as number) > 1 ? [null, n] : [n]));
}

export function RunStatus({ run }: { run: RunSummary }) {
  if (run.ok === null) return <LoaderCircle className="size-4 animate-spin text-primary" aria-label="Running" />;
  if (run.interrupted) return <CircleSlash className="size-4 text-warning" aria-label="Interrupted" />;
  if (run.ok && run.skipped) return <CircleAlert className="size-4 text-warning" aria-label={`Succeeded, ${stepsSkipped(run.skipped)}`} />;
  return run.ok ? <CircleCheck className="size-4 text-success" aria-label="Succeeded" /> : <CircleX className="size-4 text-danger" aria-label="Failed" />;
}

/** Bare: inside Activity, without its own header. */
export function RunsPage({ bare = false }: { bare?: boolean }) {
  const [page, setPage] = useState(pageFromUrl);
  const { data, error, loading } = useAsync(() => api.runs(page), [page]);
  const runs = data?.runs ?? [];
  const last = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  function go(to: number) {
    setPage(to);
    try {
      window.history.replaceState(null, '', to > 1 ? `/activity/runs?page=${to}` : '/activity/runs');
    } catch {
      // A sandboxed mockup cannot change its URL; the page still moves.
    }
    window.scrollTo({ top: 0 });
  }

  return (
    <div className={bare ? '' : 'pt-4'}>
      {bare ? (
        <p className="mt-5 text-sm text-muted-foreground">
          Every action the panel ran, with its result and output. Open a run to read what it printed. Runs are kept {RUN_KEEP_DAYS} days, at most {RUN_KEEP_MAX.toLocaleString()};
          clear them sooner from the Developer options.
        </p>
      ) : (
        <PageHeader
          title="Run history"
          intro={
            <>
              Every action the panel ran, with its result and output. Open a run to read what it printed. Runs are kept {RUN_KEEP_DAYS} days, at most {RUN_KEEP_MAX.toLocaleString()};
              clear them sooner from the Developer options.
            </>
          }
        />
      )}
      {error && <Notice className="mt-6">{error}</Notice>}
      {!data && loading && (
        <div className="mt-6 grid gap-3" aria-busy="true">
          <Reading>Reading the run history...</Reading>
          <TableSkeleton columns={4} rows={10} />
        </div>
      )}
      {data?.total === 0 && (
        <EmptyState className="mt-6" icon={History} title="No runs yet" action={<Link href="/sites" className="text-sm font-medium text-primary hover:underline">Go to your sites</Link>}>
          Every action you run here, like an install, a cache clear or a snapshot, shows up with its result and what it printed.
        </EmptyState>
      )}
      {data && data.total > 0 && runs.length === 0 && (
        <p className="mt-6 rounded-lg border bg-card px-4 py-3 text-sm">
          Page {page} is past the last one.{' '}
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => go(1)}>Go to the newest runs</button>
        </p>
      )}
      {runs.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2.5"><span className="sr-only">Result</span></th>
                <th className="px-2 py-2.5 font-medium">Action</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Site</th>
                <th className="px-3 py-2.5 text-right font-medium">When</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Took</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((r) => (
                <tr key={r.id} className="relative hover:bg-muted/40">
                  <td className="px-4 py-2.5"><RunStatus run={r} /></td>
                  <td className="px-2 py-2.5">
                    {/* The whole row opens the run; the site link sits above that. */}
                    <Link href={`/runs/${r.id}`} className="font-medium after:absolute after:inset-0 focus-visible:outline-none">{r.title}</Link>
                    <span className="block font-mono text-xs text-muted-foreground">{r.action}{r.interrupted ? ' · interrupted' : ''}{r.skipped ? <span className="text-warning">{` · ${stepsSkipped(r.skipped)}`}</span> : null}</span>
                  </td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    {r.target && <Link href={`/sites/${encodeURIComponent(r.target)}`} className="relative z-10 font-mono text-[13px] hover:underline">{r.target}</Link>}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-muted-foreground">{timeAgo(r.startedAt)}</td>
                  <td className="hidden px-4 py-2.5 text-right text-muted-foreground tabular-nums sm:table-cell">{r.durationMs !== undefined ? duration(r.durationMs) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && last === 1 && (
        <p className="mt-3 text-sm text-muted-foreground">{data.total === 1 ? '1 run' : `${data.total.toLocaleString()} runs`}</p>
      )}
      {data && last > 1 && (
        <nav aria-label="Run history pages" className="mt-4 flex flex-wrap items-center gap-1.5 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => go(page - 1)} aria-label="Newer runs"><ChevronLeft /></Button>
          {pageList(page, last).map((n, i) =>
            n === null ? (
              <span key={`gap-${i}`} className="px-1 text-muted-foreground">...</span>
            ) : (
              <Button key={n} size="sm" variant={n === page ? 'default' : 'ghost'} aria-current={n === page ? 'page' : undefined} disabled={loading && n !== page} onClick={() => go(n)} className="min-w-8 tabular-nums">
                {n}
              </Button>
            ),
          )}
          <Button size="sm" variant="outline" disabled={page >= last || loading} onClick={() => go(page + 1)} aria-label="Older runs"><ChevronRight /></Button>
          <span className="ml-2 text-muted-foreground">
            {`${(page - 1) * data.pageSize + 1} to ${Math.min(page * data.pageSize, data.total)} of ${data.total.toLocaleString()}`}
            {loading && <LoaderCircle className="ml-2 inline size-4 animate-spin" />}
          </span>
        </nav>
      )}
    </div>
  );
}

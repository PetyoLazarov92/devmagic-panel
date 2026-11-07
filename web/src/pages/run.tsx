import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { duration } from '@/lib/format';
import { stepsSkipped } from '@/lib/jobs';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { RunStatus } from '@/pages/runs';
import { Notice } from '@/components/page';
import { Bar, LogSkeleton, Reading } from '@/components/skeletons';

/** One run: what it was given (passwords already hidden when stored) and everything it printed. */
export function RunPage({ id }: { id: number }) {
  const { data: run, error, loading } = useAsync(() => api.run(id), [id]);
  return (
    <div className="grid gap-4 pt-4">
      <Link href="/activity/runs" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Run history
      </Link>
      {error && <Notice>{error}</Notice>}
      {!run && loading && (
        <div className="grid gap-4" aria-busy="true">
          <div className="grid gap-2">
            <Bar className="h-7 w-80 max-w-full" />
            <Bar className="h-3.5 w-64 max-w-full" />
          </div>
          <Reading>Reading the run...</Reading>
          <LogSkeleton lines={12} />
        </div>
      )}
      {run && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><RunStatus run={run} />{run.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-mono text-xs">{run.action}</span>
                {run.target && <> on <Link href={`/sites/${encodeURIComponent(run.target)}`} className="font-mono text-[13px] text-foreground hover:underline">{run.target}</Link></>}
                {' · '}
                {new Date(run.startedAt).toLocaleString()}
                {run.durationMs !== undefined && ` · took ${duration(run.durationMs)}`}
                {run.ok === null && ' · still running'}
                {run.interrupted && ' · interrupted: the panel stopped before it finished'}
                {run.skipped ? <span className="text-warning">{` · done, ${stepsSkipped(run.skipped)}: Skip and continue went on without ${run.skipped === 1 ? 'it' : 'them'}`}</span> : null}
              </p>
            </div>
            {run.jobId && (
              <Link href={`/jobs/${encodeURIComponent(run.jobId)}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                Open the job{run.ok === false ? ' to retry or undo' : ''}
                <ArrowRight className="size-4" />
              </Link>
            )}
          </div>
          <Card className="grid gap-2 p-5">
            <h2 className="text-sm font-semibold">Output</h2>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{run.output || (run.ok === null ? 'Nothing yet.' : 'No output.')}</pre>
          </Card>
          <Card className="grid gap-2 p-5">
            <h2 className="text-sm font-semibold">Input</h2>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(run.input, null, 2)}</pre>
          </Card>
        </>
      )}
    </div>
  );
}

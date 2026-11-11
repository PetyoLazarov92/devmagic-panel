import type { SlowQuery, SlowQueryReport } from '@devmagic-panel/shared';
import { readsTooMuch } from '@devmagic-panel/shared';
import { ChevronDown, Gauge, RotateCcw, ScanSearch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState, Notice, ViewBar } from '@/components/layout/page';
import { ListSkeleton, Reading } from '@/components/layout/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { loadSqlEditor } from '@/lib/sql-editor-load';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

const SOURCE: Record<SlowQueryReport['source'], string> = {
  statements: "From MySQL's statement statistics, which are always on: nothing to switch on, and the slow log is separate.",
  slowLog: "From MySQL's slow log: only the queries slower than its limit.",
  none: '',
};

/** Milliseconds as people read them: 0.3 ms, 150 ms, 2.3 s, 1 min 2 s. */
export function ms(n: number): string {
  if (n < 1) return `${n.toFixed(1)} ms`;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`;
}

const count = (n: number) => n.toLocaleString('en');

/**
 * Top queries: every query, of one database (a site's Performance tab) or
 * of every site's (Services, MySQL), the most time in all first. Start
 * counting again empties the numbers, so a page loaded after it shows only
 * its own queries.
 */
export function SlowQueries({ database, onExplain, inCard = false }: { database?: string; onExplain?: (sql: string, database: string | undefined) => void; inCard?: boolean }) {
  const report = useAsync(() => api.slowQueries(database), [database]);
  const [resetting, setResetting] = useState(false);
  const [readAt, setReadAt] = useState<string | undefined>(undefined);
  const data = report.data;
  const { shown, footer: more } = useShowMore(data?.queries ?? [], { reset: database, step: 10 });
  // The SQL view's editor loads while you read, so Explain opens on it, not on a plain box.
  useEffect(() => {
    if (onExplain) void loadSqlEditor().catch(() => undefined);
  }, [onExplain]);
  useEffect(() => {
    if (report.data && !report.loading) setReadAt(new Date().toISOString());
  }, [report.data, report.loading]);

  async function reset() {
    setResetting(true);
    try {
      const r = await api.runAction('mysql.resetQueryStats', {});
      toast(r.ok ? { tone: 'success', title: 'Counting again from now', detail: 'Load the page you want to measure, then Check again.' } : { tone: 'danger', title: 'Could not start counting again', detail: lastLine(r.output) });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not start counting again', detail: (error as Error).message });
    } finally {
      setResetting(false);
      report.reload();
    }
  }

  const note = data && data.source !== 'none' ? `${SOURCE[data.source]}${data.since ? ` Counting since ${timeAgo(data.since)}.` : ''}` : undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ViewBar
        onCheck={report.reload}
        loading={report.loading}
        checkedAt={report.loading ? undefined : readAt}
        note={note}
        actions={
          data && data.source !== 'none' ? (
            <Button size="sm" variant="outline" disabled={resetting} onClick={() => void reset()}>
              {resetting ? <Spinner /> : <RotateCcw />}
              Start counting again
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">{database ? 'Every query this database ran, the most time in all first: a quick one that runs a thousand times can cost more than one slow one.' : "Every query of every site's database, the most time in all first: a quick one that runs a thousand times can cost more than one slow one."}</p>
      </ViewBar>
      {report.error && <Notice>{report.error}</Notice>}
      {data?.note && data.source !== 'none' && <Notice tone="info">{data.note}</Notice>}
      {!data && !report.error ? (
        <div className="grid gap-3">
          <Reading>Reading MySQL&apos;s query statistics</Reading>
          <ListSkeleton rows={4} />
        </div>
      ) : data?.source === 'none' ? (
        <EmptyState icon={Gauge} title="Nothing counts the queries yet" action={<ButtonLink size="sm" variant="outline" href="/services/mysql">Open MySQL settings</ButtonLink>}>
          {data.note}
        </EmptyState>
      ) : data && data.queries.length === 0 ? (
        <EmptyState icon={Gauge} title="No queries yet">
          Nothing ran since counting started. Load a page of the site, then Check again.
        </EmptyState>
      ) : data ? (
        <Card className={cn('divide-y', inCard && 'rounded-md shadow-none')}>
          {shown.map((q) => (
            <QueryRow key={`${q.database ?? ''}:${q.id}`} query={q} showDatabase={!database} total={data.queries[0]?.totalMs ?? 0} onExplain={onExplain} />
          ))}
          <ShowMore {...more} noun="queries" />
        </Card>
      ) : null}
    </div>
  );
}

function QueryRow({ query: q, showDatabase, total, onExplain }: { query: SlowQuery; showDatabase: boolean; total: number; onExplain: ((sql: string, database: string | undefined) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(false);
  const heavy = readsTooMuch(q) || (q.noIndex ?? 0) > 0;
  const tone = q.avgMs >= 1000 ? 'danger' : q.avgMs >= 100 ? 'warning' : 'neutral';
  return (
    <div className="grid gap-2 px-5 py-3 text-sm">
      <button type="button" className="grid cursor-pointer gap-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <code className={cn('font-mono text-dense break-all', !open && 'line-clamp-2')}>{q.text}</code>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {showDatabase && q.database && <span className="font-medium text-foreground">{q.database}</span>}
          <span>{count(q.count)} runs</span>
          <span className="font-medium text-foreground">{ms(q.totalMs)} in all</span>
          <Badge tone={tone}>{ms(q.avgMs)} each</Badge>
          <span>slowest {ms(q.maxMs)}</span>
          <span>
            {count(q.rowsExamined)} rows read for {count(q.rowsSent)} sent
          </span>
          {heavy && <Badge tone="warning">missing index?</Badge>}
          {q.lastSeen && <span>last {timeAgo(q.lastSeen)}</span>}
          <ChevronDown className={cn('ml-auto size-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="block h-full rounded-full bg-primary/60" style={{ width: `${total ? Math.max(2, (q.totalMs / total) * 100) : 0}%` }} />
        </span>
      </button>
      {open && (
        <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-xs">
          {heavy && (
            <p className="text-muted-foreground">
              {(q.noIndex ?? 0) > 0 ? `${count(q.noIndex ?? 0)} of its runs used no index, or no good one. ` : ''}
              It reads {count(Math.round(q.rowsExamined / Math.max(q.count, 1)))} rows a run to send {count(Math.round(q.rowsSent / Math.max(q.count, 1)))}: EXPLAIN shows which table it reads whole.
            </p>
          )}
          {q.sample ? (
            sample ? (
              <code className="font-mono break-all whitespace-pre-wrap">{q.sample}</code>
            ) : (
              <p className="text-muted-foreground">One real run of it is kept, with its values. It can hold data from the site.</p>
            )
          ) : (
            <p className="text-muted-foreground">MySQL kept no real run of this one, only its shape.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {q.sample && (
              <Button size="sm" variant="outline" onClick={() => setSample((s) => !s)}>
                {sample ? 'Hide the real run' : 'Show the real run'}
              </Button>
            )}
            {q.sample && onExplain && (
              <Button size="sm" variant="outline" onClick={() => onExplain(q.sample as string, q.database)}>
                <ScanSearch />
                Explain in SQL
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

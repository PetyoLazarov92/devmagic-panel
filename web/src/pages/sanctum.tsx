import type { BackgroundTask, FinishedProgram, PanelStatus, PanelStorage, RunningProgram, StorageRow } from '@devmagic-panel/shared';
import { pageLabel } from '@devmagic-panel/shared';
import { ChevronRight, Clock, Cpu, HardDrive, History, Play, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CheckAgain, Notice, PageHeader } from '@/components/layout/page';
import { ProgramFrom } from '@/components/layout/panel-status-indicator';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { StatTile } from '@/components/ui/stat-tile';
import { api } from '@/lib/api';
import { useDeveloper } from '@/lib/developer';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/output';
import { navigate, useQueryParam } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

type View = 'storage' | 'tasks' | 'programs';
const VIEWS: ReadonlyArray<readonly [View, string, typeof HardDrive]> = [
  ['storage', 'Storage', HardDrive],
  ['tasks', 'Background tasks', Clock],
  ['programs', 'Running now', Cpu],
];

/** How often a task runs, said short: "hourly". */
const every = (ms: number) => (ms >= 86_400_000 ? (ms === 86_400_000 ? 'daily' : `every ${Math.round(ms / 86_400_000)} days`) : ms >= 3_600_000 ? (ms === 3_600_000 ? 'hourly' : `every ${Math.round(ms / 3_600_000)} hours`) : `every ${Math.round(ms / 60_000)} min`);

/**
 * Sanctum, the panel's inner workings, the short answer first: four tiles (the panel, what
 * runs now, its background tasks, its storage), then one list at a time
 * under them. Paths only in Developer mode.
 */
export function SanctumPage() {
  const [tick, setTick] = useState(0);
  const status = useAsync(() => api.panelStatus(), [tick]);
  const [fresh, setFresh] = useState(0);
  const storage = useAsync(() => api.panelStorage(fresh > 0), [fresh]);
  const asked = useQueryParam('view');
  const [view, setView] = useState<View>(asked === 'tasks' || asked === 'programs' ? asked : 'storage');
  const [runningTask, setRunningTask] = useState<string | null>(null);

  const show = (v: View) => {
    setView(v);
    navigate(v === 'storage' ? '/sanctum' : `/sanctum?view=${v}`, { replace: true });
  };
  const runTask = async (id: string, label: string) => {
    setRunningTask(id);
    try {
      const done = await api.runPanelTask(id);
      toast({ tone: done.lastOk === false ? 'danger' : 'success', title: `${label}: ${done.lastOk === false ? 'failed' : 'done'}`, ...(done.lastNote ? { detail: done.lastNote } : {}) });
      setTick((n) => n + 1);
      setFresh((n) => n + 1);
    } catch (error) {
      toast({ tone: 'danger', title: `${label} could not run`, detail: (error as Error).message });
    } finally {
      setRunningTask(null);
    }
  };

  const s = status.data;
  return (
    <div className="pt-4">
      <PageHeader
        title="Sanctum"
        intro="What the panel runs and keeps: the work it does on its own and the space its backups, downloads and versions take."
        actions={<CheckAgain onClick={() => { setTick((n) => n + 1); setFresh((n) => n + 1); }} loading={status.loading || storage.loading} />}
      />
      {status.error && <Notice className="mt-6">{status.error}</Notice>}
      {!s && status.loading && <CardsSkeleton className="mt-6" reading="Reading the panel's status..." cards={[2, 2]} />}
      {s && <Tiles status={s} storage={storage.data} onShow={show} />}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Show" value={view} onChange={show} options={VIEWS} />
        {view === 'storage' && storage.data && <span className="text-xs text-muted-foreground">Measured {timeAgo(storage.data.measuredAt)}</span>}
      </div>
      {view !== 'programs' && (
        <Card className="mt-3">
          {view === 'storage' && <StorageList storage={storage.data} loading={storage.loading} error={storage.error} onCleaned={() => setFresh((n) => n + 1)} />}
          {view === 'tasks' && s && (
            s.tasks.length === 0
              ? <p className="px-5 py-4 text-sm text-muted-foreground">This panel runs no background tasks (a development server).</p>
              : <ul className="divide-y">{s.tasks.map((t) => <TaskRow key={t.id} task={t} busy={runningTask === t.id} onRun={() => void runTask(t.id, t.label)} />)}</ul>
          )}
        </Card>
      )}
      {view === 'programs' && s && <Programs status={s} />}
    </div>
  );
}

/** The short answer: one tile each, the three lists' tiles opening their list. */
function Tiles({ status: s, storage, onShow }: { status: PanelStatus; storage: PanelStorage | undefined; onShow: (v: View) => void }) {
  const failed = s.tasks.filter((t) => t.lastOk === false);
  const biggest = storage?.rows.reduce<StorageRow | null>((top, r) => ((r.bytes ?? 0) > (top?.bytes ?? 0) ? r : top), null);
  const crashed = s.before?.ended === 'unexpectedly';
  return (
    <div className="mt-6 grid grid-cols-2 gap-2 @3xl:grid-cols-4">
      <StatTile
        label="Panel"
        value={`v${s.version}, ${bytes(s.memoryBytes)}`}
        sub={crashed ? 'The run before did not stop cleanly' : `Started ${timeAgo(s.startedAt)}`}
        tone={crashed ? 'warning' : 'neutral'}
      />
      <StatTile
        label="Running now"
        value={s.programs.length === 0 ? 'Nothing' : `${s.programs.length} program${s.programs.length > 1 ? 's' : ''}`}
        sub={s.programs.length ? [...new Set(s.programs.map((p) => p.program))].join(', ') : s.jobs ? `${s.jobs} job${s.jobs > 1 ? 's' : ''} between steps` : 'No job running'}
        onClick={() => onShow('programs')}
      />
      <StatTile
        label="Background tasks"
        value={`${s.tasks.length} task${s.tasks.length === 1 ? '' : 's'}`}
        sub={failed.length ? `Failed: ${failed.map((t) => t.label).join(', ')}` : s.tasks.length ? 'All ran fine' : 'None on a development server'}
        tone={failed.length ? 'warning' : 'neutral'}
        onClick={() => onShow('tasks')}
      />
      <StatTile
        label="Storage"
        value={storage ? bytes(storage.totalBytes) : '...'}
        sub={biggest ? `Most: ${biggest.label}, ${bytes(biggest.bytes ?? 0)}` : 'Measuring...'}
        onClick={() => onShow('storage')}
      />
    </div>
  );
}

/** How long something took, short: "640 ms", "2.1 s", "3 min". */
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);

/** A program's line: its name, what started it (and why it failed), then its time on the right. */
function ProgramLine({ program: p, meta, tone, count = 1, reads = false, reason }: { program: RunningProgram; meta: ReactNode; tone?: 'warning' | undefined; count?: number; reads?: boolean; reason?: string | undefined }) {
  return (
    <li className="flex min-w-0 items-baseline gap-3 px-5 py-2.5 text-dense">
      <code className={cn('shrink-0 font-mono', tone === 'warning' && 'text-warning')}>{p.program}{count > 1 && <span className="text-muted-foreground"> ×{count}</span>}</code>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {reads && !p.page ? 'Page reads' : <ProgramFrom program={p} />}
        {reason && <span className="text-warning"> · {reason}</span>}
      </span>
      <span className={cn('shrink-0 text-xs tabular-nums', tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{meta}</span>
    </li>
  );
}

/** Programs running now, a page's reads of one program folded into one line: a site's page starts several at once. */
function runningLines(programs: readonly RunningProgram[]): Array<{ program: RunningProgram; count: number }> {
  const reads = new Map<string, { program: RunningProgram; count: number }>();
  const lines: Array<{ program: RunningProgram; count: number }> = [];
  for (const p of programs) {
    if (p.job || p.task) {
      lines.push({ program: p, count: 1 });
      continue;
    }
    const key = `${p.program}|${p.page ? pageLabel(p.page) : ''}`;
    const line = reads.get(key);
    if (line) line.count += 1;
    else {
      const first = { program: p, count: 1 };
      reads.set(key, first);
      lines.push(first);
    }
  }
  return lines;
}

/** Ended programs alike (the same program, from the same place, ending the same way for the same reason) in one line, at the place of the newest. */
export function finishedLines(finished: readonly FinishedProgram[]): Array<{ program: FinishedProgram; count: number; minMs: number; maxMs: number }> {
  const by = new Map<string, { program: FinishedProgram; count: number; minMs: number; maxMs: number }>();
  const lines: Array<{ program: FinishedProgram; count: number; minMs: number; maxMs: number }> = [];
  for (const p of finished) {
    const from = p.job ? `job:${p.job.id}` : p.task ? `task:${p.task.id}` : p.page ? `page:${pageLabel(p.page)}` : '';
    const key = [p.program, from, p.ended, p.code ?? '', p.reason ?? ''].join('|');
    const line = by.get(key);
    if (line) {
      line.count += 1;
      line.minMs = Math.min(line.minMs, p.durationMs);
      line.maxMs = Math.max(line.maxMs, p.durationMs);
    } else {
      const first = { program: p, count: 1, minMs: p.durationMs, maxMs: p.durationMs };
      by.set(key, first);
      lines.push(first);
    }
  }
  return lines;
}

/** How long, or the range for a folded line: "15 to 284 ms". */
const tookRange = (min: number, max: number) => (min === max ? took(min) : max < 1000 ? `${min} to ${max} ms` : `${took(min)} to ${took(max)}`);

function Programs({ status: s }: { status: PanelStatus }) {
  const lines = runningLines(s.programs);
  const ended = finishedLines(s.finished);
  return (
    <>
      <Card className="mt-3">
        <CardHeader title="Running now" meta={<Cpu className="size-4 text-muted-foreground" />} />
        {lines.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No program is running{s.jobs ? `: ${s.jobs} job${s.jobs > 1 ? 's are' : ' is'} between steps` : ''}.</p>
        ) : (
          <ul className="divide-y">
            {lines.map(({ program: p, count }, i) => (
              <ProgramLine key={`${p.program}-${p.startedAt}-${i}`} program={p} count={count} reads={count > 1} meta={`running ${timeAgo(p.startedAt).replace(/ ago$/, '')}`} />
            ))}
          </ul>
        )}
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">The programs behind jobs, background tasks and pages: their name and command, never their arguments or output.</p>
      </Card>
      <Card className="mt-4">
        <CardHeader title="Recently finished" meta={<History className="size-4 text-muted-foreground" />} />
        {ended.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Nothing yet since the panel started.</p>
        ) : (
          <ul className="divide-y">
            {ended.map(({ program: p, count, minMs, maxMs }, i) => (
              <ProgramLine
                key={`${p.program}-${p.startedAt}-${i}`}
                program={p}
                count={count}
                reason={p.reason}
                tone={p.ended === 'ok' ? undefined : 'warning'}
                meta={`${p.ended === 'timeout' ? 'stopped by its timeout after' : p.ended === 'failed' ? `failed (exit ${p.code ?? '?'}) after` : 'took'} ${tookRange(minMs, maxMs)}, ${count > 1 ? 'last ' : ''}${timeAgo(p.startedAt)}`}
              />
            ))}
          </ul>
        )}
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          The last 50 of jobs and background tasks, and page reads that failed or took 5 seconds or more, until the panel restarts. Alike ones share a line. A page read can be meant to fail, like a check whether a table is there.
        </p>
      </Card>
      {s.pageReads.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Page reads that went well" meta={<span className="text-xs text-muted-foreground">counted, not listed, since the panel started</span>} />
          <div className="overflow-x-auto">
            <table className="w-full text-dense">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-5 py-2 font-medium">Program</th>
                  <th className="px-3 py-2 text-right font-medium">Times</th>
                  <th className="px-3 py-2 text-right font-medium">Average</th>
                  <th className="px-5 py-2 text-right font-medium">Slowest</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.pageReads.map((r) => (
                  <tr key={r.program}>
                    <td className="px-5 py-2"><code className="font-mono">{r.program}</code></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.count.toLocaleString('en')}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{took(Math.round(r.totalMs / r.count))}</td>
                    <td className="px-5 py-2 text-right text-muted-foreground tabular-nums">{took(r.maxMs ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function TaskRow({ task, busy, onRun }: { task: BackgroundTask; busy: boolean; onRun: () => void }) {
  const [open, setOpen] = useState(false);
  const runs = useAsync(() => (open ? api.panelTaskRuns(task.id) : Promise.resolve(null)), [open, task.lastRunAt]);
  const last = task.running ? 'Running now' : task.lastRunAt ? `${task.lastOk === false ? 'Failed' : 'Ran'} ${timeAgo(task.lastRunAt)}${task.lastNote ? `: ${task.lastNote}` : ''}` : 'Not run yet';
  return (
    <li className="text-sm">
      <div className="flex items-center gap-3 px-5 py-2.5">
        <Button variant="ghost" className="grid h-auto min-w-0 flex-1 justify-stretch gap-0.5 px-0 py-0 text-left font-normal whitespace-normal hover:bg-transparent" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={task.what}>
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            <span className="truncate">
              <span className="font-medium">{task.label}</span>
              <span className="text-muted-foreground"> · {every(task.everyMs)}</span>
            </span>
          </span>
          <span className={cn('truncate pl-5.5 text-xs', task.lastOk === false ? 'text-warning' : 'text-muted-foreground')}>
            {last}{task.nextRunAt && !task.running ? `, next ${timeAgo(task.nextRunAt)}` : ''}
          </span>
        </Button>
        <Button size="sm" variant="soft" disabled={busy || task.running} onClick={onRun}>
          {busy || task.running ? <Spinner /> : <Play />}
          Run now
        </Button>
      </div>
      {open && (
        <div className="border-t bg-muted/30 px-5 py-2.5 pl-11">
          {!runs.data ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">{runs.error ?? <><Spinner />Reading its runs...</>}</p>
          ) : runs.data.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs kept yet.</p>
          ) : (
            <>
              <ul className="grid gap-1">
                {runs.data.map((r) => (
                  <li key={r.startedAt} className="flex min-w-0 items-baseline gap-3 text-xs">
                    <span className="w-28 shrink-0 text-muted-foreground" title={dateTime(r.startedAt)}>{timeAgo(r.startedAt)}</span>
                    <span className={cn('min-w-0 flex-1 truncate', r.ok ? 'text-foreground' : 'text-warning')} title={r.note}>{r.ok ? r.note ?? 'done' : `failed${r.note ? `: ${r.note}` : ''}`}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{took(r.durationMs)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs text-muted-foreground">Its last {runs.data.length} runs; the newest 20 are kept.</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function StorageList({ storage, loading, error, onCleaned }: {
  storage: PanelStorage | undefined;
  loading: boolean;
  error: string | null;
  onCleaned: () => void;
}) {
  const developer = useDeveloper();
  const [asking, setAsking] = useState<StorageRow | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);
  if (error) return <Notice className="m-5">{error}</Notice>;
  if (!storage) return <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">{loading && <Spinner />}Measuring what the panel keeps...</p>;
  const top = Math.max(1, ...storage.rows.map((r) => r.bytes ?? 0));

  const clean = async (row: StorageRow) => {
    if (!row.clean) return;
    setAsking(null);
    setCleaning(row.id);
    const result = await api.runAction('storage.clean', { kind: row.clean.kind, confirm: 'clean' }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: `${row.label}: cleaned up`, detail: lastLine(result.output) } : { tone: 'danger', title: `${row.label} could not be cleaned up`, detail: lastLine(result.output) });
    setCleaning(null);
    onCleaned();
  };
  const empty = (r: StorageRow) => (r.bytes !== null ? r.bytes === 0 : r.count === 0);

  return (
    <>
      <ul className="divide-y">
        {storage.rows.map((r) => (
          <li key={r.id} className="grid items-center gap-x-4 gap-y-2 px-5 py-2.5 text-sm @2xl:grid-cols-[minmax(0,1fr)_9rem_8.5rem]">
            <div className="grid min-w-0 gap-0.5">
              <span className="font-medium" title={r.what}>{r.label}</span>
              <span className="text-xs text-muted-foreground">
                Kept: {r.kept}.{r.manage ? ` ${r.manage.note}.` : ''}
              </span>
              {developer && <span className="font-mono text-2xs break-all text-muted-foreground">{r.where.join(', ')}</span>}
            </div>
            <div className="grid gap-1">
              <span className="font-medium tabular-nums @2xl:text-right">{r.bytes !== null ? bytes(r.bytes) : r.count !== undefined ? `${r.count} kept` : 'unknown'}</span>
              {r.bytes !== null && <span className="h-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, Math.round((r.bytes / top) * 100))}%` }} /></span>}
            </div>
            <div className="flex @2xl:justify-end">
              {r.clean ? (
                <Button size="sm" variant="outline" disabled={cleaning !== null || empty(r)} onClick={() => setAsking(r)} title={empty(r) ? 'Nothing to clean up' : r.clean.goes}>
                  {cleaning === r.id ? <Spinner /> : null}
                  Clean up now
                </Button>
              ) : r.manage?.href && r.manage.label ? (
                <Button size="sm" variant="soft" onClick={() => navigate(r.manage?.href as string)}>Open {r.manage.label}</Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">Clean up now removes all of that kind now, after you confirm; the background tasks remove only what is past its time. Point at a name for what it is.</p>
      <Dialog open={asking !== null} onClose={() => setAsking(null)} title={asking ? `Clean up ${asking.label.toLowerCase()} now?` : ''} description={asking?.clean?.goes}>
        {asking?.items && asking.items.length > 0 && (
          <ul className="mt-4 grid gap-1 rounded-lg border px-3 py-2 text-sm">
            {asking.items.map((k) => (
              <li key={k.name} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="truncate font-mono text-dense" title={k.name}>{k.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{k.domain}{k.path ?? ''}, would go {timeAgo(k.goesAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm text-muted-foreground">{asking?.bytes ? `${bytes(asking.bytes)} is freed. ` : ''}This cannot be undone.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setAsking(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => asking && void clean(asking)}><Trash2 />Clean up now</Button>
        </div>
      </Dialog>
    </>
  );
}

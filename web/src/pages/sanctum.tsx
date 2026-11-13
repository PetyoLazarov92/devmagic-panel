import type { BackgroundTask, PanelStatus, PanelStorage, StorageRow } from '@devmagic-panel/shared';
import { Clock, Cpu, HardDrive, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CheckAgain, Notice, PageHeader } from '@/components/layout/page';
import { ProgramFrom } from '@/components/layout/panel-status-indicator';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { StatTile } from '@/components/ui/stat-tile';
import { api } from '@/lib/api';
import { useDeveloper } from '@/lib/developer';
import { bytes, timeAgo } from '@/lib/format';
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
      <Card className="mt-3">
        {view === 'storage' && <StorageList storage={storage.data} loading={storage.loading} error={storage.error} onCleaned={() => setFresh((n) => n + 1)} />}
        {view === 'tasks' && s && (
          s.tasks.length === 0
            ? <p className="px-5 py-4 text-sm text-muted-foreground">This panel runs no background tasks (a development server).</p>
            : <ul className="divide-y">{s.tasks.map((t) => <TaskRow key={t.id} task={t} busy={runningTask === t.id} onRun={() => void runTask(t.id, t.label)} />)}</ul>
        )}
        {view === 'programs' && s && <Programs status={s} />}
      </Card>
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

function Programs({ status: s }: { status: PanelStatus }) {
  if (s.programs.length === 0) return <p className="px-5 py-4 text-sm text-muted-foreground">No program is running{s.jobs ? `: ${s.jobs} job${s.jobs > 1 ? 's are' : ' is'} between steps` : ''}.</p>;
  return (
    <>
      <ul className="divide-y">
        {s.programs.map((p, i) => (
          <li key={`${p.program}-${p.startedAt}-${i}`} className="flex min-w-0 items-baseline gap-3 px-5 py-2.5 text-dense">
            <code className="shrink-0 font-mono">{p.program}</code>
            <span className="min-w-0 flex-1 truncate text-muted-foreground"><ProgramFrom program={p} /></span>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(p.startedAt)}</span>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">The programs behind the jobs, background tasks and page reads: only their names, never their arguments or output.</p>
    </>
  );
}

function TaskRow({ task, busy, onRun }: { task: BackgroundTask; busy: boolean; onRun: () => void }) {
  const last = task.running ? 'Running now' : task.lastRunAt ? `${task.lastOk === false ? 'Failed' : 'Ran'} ${timeAgo(task.lastRunAt)}${task.lastNote ? `: ${task.lastNote}` : ''}` : 'Not run yet';
  return (
    <li className="flex items-center gap-3 px-5 py-2.5 text-sm">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate" title={task.what}>
          <span className="font-medium">{task.label}</span>
          <span className="text-muted-foreground"> · {every(task.everyMs)}</span>
        </span>
        <span className={cn('truncate text-xs', task.lastOk === false ? 'text-warning' : 'text-muted-foreground')} title={last}>
          {last}{task.nextRunAt && !task.running ? `, next ${timeAgo(task.nextRunAt)}` : ''}
        </span>
      </div>
      <Button size="sm" variant="soft" disabled={busy || task.running} onClick={onRun}>
        {busy || task.running ? <Spinner /> : <Play />}
        Run now
      </Button>
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

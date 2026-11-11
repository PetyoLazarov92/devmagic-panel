import type { DbCell, DbCleanupView, DbColumnHead, DbFilter, DbFilterOp, DbOverview, DbRow, DbRowsPage, DbStructure, DbTable, Preferences } from '@devmagic-panel/shared';
import { DB_FILTER_LABELS, DB_FILTER_OPS, DB_PAGE_SIZES } from '@devmagic-panel/shared';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Eraser, ExternalLink, Filter, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Rows3, Search, Table2, Trash2, TriangleAlert, X } from 'lucide-react';
import { type ClipboardEvent, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CleanupsCard, ConfirmCleanup } from '@/components/cleanups';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { DeleteRowsDialog, deleteRowsNow, type EditorMode, RowChangesCard, RowEditor, toastRowChange } from '@/components/row-editor';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, useFullScreen } from '@/components/ui/dialog';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Segmented } from '@/components/ui/segmented';
import { api, dbExportUrl, isMockup } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { controlRuns, parseJsonValue, parsePhpSerialized, propertyName, type PhpValue } from '@/lib/php-serialized';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { CardSkeleton, Reading, TableSkeleton } from '@/components/skeletons';
import { Notice } from '@/components/page';

export type DbShow = 'rows' | 'structure';

/** Where the browser is: a database's tables, or one table's rows or structure. The page keeps it in its address. */
export interface DbLocation {
  table: string | null;
  show: DbShow;
}

interface Props {
  database: string;
  location: DbLocation;
  /** Goes to another table or view: the page puts it in its address, so Back and a reload keep it. */
  onNavigate: (next: DbLocation) => void;
  /** Shown above the tables, like a link back to every database. */
  header?: ReactNode;
}

const number = (n: number) => n.toLocaleString('en-US');

/** phpMyAdmin opened on a database, or one of its tables. */
function pmaHref(base: string, database: string, table?: string): string {
  const q = new URLSearchParams({ db: database, ...(table ? { table } : {}) });
  return `${base}index.php?${q.toString()}`;
}

/**
 * Browses one database, read only: its tables with sizes and engines, a
 * table's rows a page at a time with filters and sorting, and its structure.
 * Long values open in full on their own; phpMyAdmin is a link away for
 * anything else.
 */
export function DatabaseBrowser({ database, location, onNavigate, header }: Props) {
  const overview = useAsync(() => api.dbOverview(database), [database]);
  if (location.table) {
    return <TableView database={database} table={location.table} show={location.show} overview={overview.data} onNavigate={onNavigate} />;
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <TablesList database={database} overview={overview.data} loading={overview.loading} error={overview.error} reload={overview.reload} onNavigate={onNavigate} header={header} />
      {overview.data && overview.data.kind !== 'system' && overview.data.kind !== 'kept' && <CleanupsCard database={database} refresh={refreshOf(overview.data)} onUndone={overview.reload} />}
    </div>
  );
}

type TableFilter = 'all' | 'site' | 'other';
type TableSort = Preferences['tablesSort'];

function TablesList({ database, overview, loading, error, reload, onNavigate, header }: {
  database: string;
  overview: DbOverview | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
  onNavigate: Props['onNavigate'];
  header?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TableFilter>('all');
  // Remembered with the panel's other view choices, so the list keeps it after a table and back.
  const { tablesSort: sort } = usePreferences();
  const setSort = (tablesSort: TableSort) => savePreferences({ tablesSort });
  const [asking, setAsking] = useState<{ table: string; how: 'empty' | 'drop' } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const runner = useJob();
  const done = useRef<string | null>(null);
  const { job } = runner;
  // An emptied or deleted table changes the list, and the clean-ups to undo.
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    reload();
    setRefresh((n) => n + 1);
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title}: done` });
  }, [job, reload]);
  const busy = job !== null && !settled(job);
  const prefix = overview?.sites[0]?.prefix;

  const tables = useMemo(() => {
    const list = (overview?.tables ?? []).filter((t) => {
      if (query && !t.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (prefix && filter === 'site') return t.name.startsWith(prefix);
      if (prefix && filter === 'other') return !t.name.startsWith(prefix);
      return true;
    });
    return sort === 'size' ? [...list].sort((a, b) => b.dataBytes + b.indexBytes - (a.dataBytes + a.indexBytes)) : list;
  }, [overview, query, filter, prefix, sort]);
  // A big database (a network has a dozen tables a site) shows its first tables, and the rest on Show more; Find searches them all.
  const { shown, footer: more } = useShowMore(tables, { reset: `${query}\n${filter}\n${sort}` });

  if (loading && !overview) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Reading>Reading the tables...</Reading>
        <TableSkeleton columns={4} rows={10} />
      </div>
    );
  }
  if (error && !overview) return <Notice>{error}</Notice>;
  if (!overview) return null;
  const others = prefix ? overview.tables.filter((t) => !t.name.startsWith(prefix)).length : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Table2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Tables of <span className="font-mono text-[13px]">{database}</span></span>
        </CardTitle>
        <div className="flex items-center gap-1">
          {exportable(overview) && (
            <Button size="sm" variant="outline" onClick={() => setExporting(true)}>
              <Download />Export
            </Button>
          )}
          {overview.phpMyAdmin && (
            <ButtonLink size="sm" variant="outline" href={pmaHref(overview.phpMyAdmin, database)} target="_blank" rel="noreferrer">
              <ExternalLink />phpMyAdmin
            </ButtonLink>
          )}
          <Button size="icon" variant="ghost" onClick={reload} disabled={loading} aria-label="Read the tables again">
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      {header}
      {/* A job started from a row's menu shows at the top of the list. */}
      {job && <div className="px-5 pt-4"><JobBox job={job} onRetry={() => void runner.retry()} /></div>}
      {runner.error && <p role="alert" className="px-5 pt-4 text-sm text-danger">{runner.error}</p>}
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Find a table</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a table" className="pl-8" />
        </label>
        <Segmented
          label="Sort tables"
          value={sort}
          onChange={setSort}
          options={[['name', 'Name'], ['size', 'Size']]}
        />
      </div>
      {prefix && others > 0 && (
        <div className="flex flex-wrap gap-1.5 px-5 pt-3" role="group" aria-label="Show">
          {([['all', 'All', overview.tables.length], ['site', `Prefix ${prefix}`, overview.tables.length - others], ['other', 'Other prefixes', others]] as const).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
            >
              {label} <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      )}
      <p className="px-5 pt-3 text-xs text-muted-foreground">
        {number(overview.tables.length)} {overview.tables.length === 1 ? 'table' : 'tables'}, {bytes(overview.totalBytes)}, read {timeAgo(overview.checkedAt)}. Row counts of InnoDB tables are MySQL&apos;s estimate.
      </p>
      <ul className="mt-2 divide-y">
        {shown.map((t) => (
          <li key={t.name} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <button type="button" onClick={() => onNavigate({ table: t.name, show: 'rows' })} className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] break-all hover:underline">{t.name}</span>
                {t.view && <Badge>View</Badge>}
                {prefix && !t.name.startsWith(prefix) && <Badge>Other prefix</Badge>}
                {t.engine && t.engine.toLowerCase() !== 'innodb' && <Badge tone="warning">{t.engine}</Badge>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t.view ? 'A saved query' : <>{tableMeta(t)}</>}
              </span>
            </button>
            <Menu
              label={`Actions for ${t.name}`}
              items={[
                { label: 'Browse rows', icon: <Rows3 />, onSelect: () => onNavigate({ table: t.name, show: 'rows' }) },
                { label: 'Structure', icon: <KeyRound />, onSelect: () => onNavigate({ table: t.name, show: 'structure' }) },
                ...(exportable(overview) ? [{ label: 'Export', icon: <Download />, onSelect: () => download(database, [t.name]) }] : []),
                ...(overview.phpMyAdmin ? [{ label: 'Open in phpMyAdmin', icon: <ExternalLink />, onSelect: () => void window.open(pmaHref(overview.phpMyAdmin as string, database, t.name), '_blank', 'noreferrer') }] : []),
                ...(editableIn(overview, t.name)
                  ? [
                      { label: 'Empty...', icon: <Eraser />, danger: true, disabled: busy, onSelect: () => setAsking({ table: t.name, how: 'empty' as const }) },
                      { label: 'Delete...', icon: <Trash2 />, danger: true, disabled: busy, onSelect: () => setAsking({ table: t.name, how: 'drop' as const }) },
                    ]
                  : []),
              ]}
            />
          </li>
        ))}
        {tables.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">{overview.tables.length ? 'No table matches.' : 'This database has no tables.'}</li>}
      </ul>
      <ShowMore {...more} noun={query || filter !== 'all' ? (tables.length === 1 ? 'match' : 'matches') : 'tables'} />
      {exporting && <ExportDialog database={database} tables={overview.tables} onClose={() => setExporting(false)} />}
      {asking && (
        <ConfirmCleanup
          title={asking.how === 'drop' ? `Delete table ${asking.table}?` : `Empty ${asking.table}?`}
          description={
            asking.how === 'drop'
              ? 'The table goes, its rows and its structure. It is saved whole first (14 days), so Undo makes it again while no table of that name is there.'
              : 'Every row goes; the table stays. They are saved first (14 days), so Undo puts them back.'
          }
          action={asking.how === 'drop' ? 'Delete the table' : 'Empty the table'}
          typed={asking.table}
          onClose={() => setAsking(null)}
          onConfirm={(confirm) => {
            const { table, how } = asking;
            setAsking(null);
            void runner.follow(api.startJob(how === 'drop' ? 'mysql.dropTable' : 'mysql.emptyTable', { database, table, confirm }));
          }}
        />
      )}
    </Card>
  );
}

function tableMeta(t: DbTable): string {
  const parts = [`about ${number(t.rows)} ${t.rows === 1 ? 'row' : 'rows'}`, bytes(t.dataBytes + t.indexBytes)];
  if (t.freeBytes > 10 * 1024 ** 2) parts.push(`${bytes(t.freeBytes)} free`);
  return parts.join(' · ');
}

/** information_schema and performance_schema are MySQL's views of the server: there is nothing to dump. */
const exportable = (o: DbOverview) => !['information_schema', 'performance_schema'].includes(o.database.toLowerCase());

/** Starts a download of a dump: the server streams it, so the page stays where it is. */
function download(database: string, tables: readonly string[] = []) {
  if (isMockup) {
    toast({ tone: 'info', title: 'The mockup has no database to download', detail: 'The panel streams a .sql.gz from mysqldump here.' });
    return;
  }
  const a = document.createElement('a');
  a.href = dbExportUrl(database, tables);
  a.click();
}

/** A whole database, or the tables ticked, as a .sql.gz to download. */
function ExportDialog({ database, tables, onClose }: { database: string; tables: DbTable[]; onClose: () => void }) {
  const [what, setWhat] = useState<'all' | 'some'>('all');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const list = tables.filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()));
  const size = (names: Iterable<string>) => [...names].reduce((n, name) => n + ((tables.find((t) => t.name === name)?.dataBytes ?? 0)), 0);
  const chosen = what === 'all' ? tables.map((t) => t.name) : [...ticked];
  return (
    <Dialog open onClose={onClose} title={`Export ${database}`} description="A .sql.gz the browser downloads: the tables with their rows, and for a whole database its views, routines and events. It has no CREATE DATABASE or USE, so it imports into any database." size="lg">
      <div className="mt-4 grid gap-3">
        <Segmented label="What" value={what} onChange={setWhat} options={[['all', 'The whole database'], ['some', 'Tables I pick']]} className="justify-self-start" />
        {what === 'some' && (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Find a table" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a table" className="h-8 min-w-40 flex-1 text-sm" />
              <Button size="sm" variant="outline" onClick={() => setTicked(new Set([...ticked, ...list.map((t) => t.name)]))}>Tick these</Button>
              <Button size="sm" variant="outline" onClick={() => setTicked(new Set())} disabled={!ticked.size}>None</Button>
            </div>
            <ul className="grid max-h-64 gap-0.5 overflow-y-auto rounded-md border p-2 text-sm">
              {list.map((t) => (
                <li key={t.name}>
                  <label className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                    <input type="checkbox" checked={ticked.has(t.name)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(t.name); else n.delete(t.name); return n; })} />
                    <span className="truncate font-mono text-[13px]">{t.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{t.view ? 'view' : bytes(t.dataBytes)}</span>
                  </label>
                </li>
              ))}
              {list.length === 0 && <li className="px-1 text-muted-foreground">No table matches.</li>}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {chosen.length} {chosen.length === 1 ? 'table' : 'tables'}, about {bytes(size(chosen))} of data before it is compressed.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={what === 'some' && ticked.size === 0} onClick={() => (download(database, what === 'all' ? [] : [...ticked]), onClose())}>
            <Download />Download .sql.gz
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The list of clean-ups reads again whenever the tables were read again. */
const refreshOf = (o: DbOverview) => Date.parse(o.checkedAt);

/** Rows of a table change here unless its database is MySQL's own or kept for a site, or the table is a view. */
function editableIn(overview: DbOverview | undefined, table: string): boolean {
  if (!overview || overview.kind === 'system' || overview.kind === 'kept') return false;
  const info = overview.tables.find((t) => t.name === table);
  return Boolean(info && !info.view);
}

function TableView({ database, table, show, overview, onNavigate }: { database: string; table: string; show: DbShow; overview: DbOverview | undefined; onNavigate: Props['onNavigate'] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* The name keeps a line of its own on a phone rather than breaking mid-word. */}
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onNavigate({ table: null, show: 'rows' })}>
            <ArrowLeft />All tables
          </Button>
          <h3 className="min-w-0 truncate font-mono text-sm font-semibold" title={table}>{table}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Segmented label="Show" value={show} onChange={(next) => onNavigate({ table, show: next })} options={[['rows', 'Rows'], ['structure', 'Structure']]} />
          {overview?.phpMyAdmin && (
            <ButtonLink size="sm" variant="outline" href={pmaHref(overview.phpMyAdmin, database, table)} target="_blank" rel="noreferrer">
              <ExternalLink />phpMyAdmin
            </ButtonLink>
          )}
        </div>
      </div>
      {show === 'structure' ? <StructureView database={database} table={table} /> : <RowsView key={`${database}.${table}`} database={database} table={table} editable={editableIn(overview, table)} />}
    </div>
  );
}

// ── rows ─────────────────────────────────────────────────────

type Sort = { column: string; dir: 'asc' | 'desc' } | undefined;

const needsValue = (op: DbFilterOp) => op !== 'isNull' && op !== 'notNull';

const keyOf = (row: DbRow) => row.key?.join('\u0000') ?? '';

/**
 * What another view hands the rows of a table: filters to start with, or only
 * the rows a clean-up would take, named by its kind with a label and a word
 * about what deleting here leaves. It goes with the history entry, never the
 * address, since a filter's value can be data.
 */
export interface RowsSeed {
  table: string;
  filters?: DbFilter[];
  cleanup?: DbCleanupView;
  label?: string;
  note?: string;
}

export const rowsSeedState = (seed: RowsSeed) => ({ rowsSeed: seed });

/** The seed the history entry holds for this table, if any. */
function seedFor(table: string): RowsSeed | undefined {
  try {
    const seed = (window.history.state as { rowsSeed?: RowsSeed } | null)?.rowsSeed;
    return seed?.table === table ? seed : undefined;
  } catch {
    return undefined;
  }
}

/** The history entry forgets its seed once its filter is cleared, so Back and a reload show the table as it is. */
function dropSeed(): void {
  try {
    window.history.replaceState(null, '');
  } catch {
    // Sandboxed frames may refuse it; the view has cleared it anyway.
  }
}

function RowsView({ database, table, editable }: { database: string; table: string; editable: boolean }) {
  const [seed] = useState(() => seedFor(table));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof DB_PAGE_SIZES)[number]>(50);
  const [sort, setSort] = useState<Sort>(undefined);
  const [filters, setFilters] = useState<DbFilter[]>(seed?.filters ?? []);
  const [drafts, setDrafts] = useState<DbFilter[]>(seed?.filters ?? []);
  const [cleanup, setCleanup] = useState<RowsSeed | null>(seed?.cleanup ? seed : null);
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [draftMatch, setDraftMatch] = useState<'all' | 'any'>('all');
  const [open, setOpen] = useState<DbRow | null>(null);
  const [editor, setEditor] = useState<{ mode: EditorMode; row: DbRow | null } | null>(null);
  const [deleting, setDeleting] = useState<DbRow[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState(0);
  const query = useMemo(() => ({ page, pageSize, ...(sort ? { sort } : {}), filters, match, ...(cleanup?.cleanup ? { cleanup: cleanup.cleanup } : {}) }), [page, pageSize, sort, filters, match, cleanup]);
  const rows = useAsync(() => api.dbRows(database, table, query), [database, table, query]);
  const data = rows.data;
  // The columns stay known while the next page loads, for the filter bar.
  const [columns, setColumns] = useState<DbColumnHead[]>([]);
  useEffect(() => {
    if (data) setColumns(data.columns);
  }, [data]);
  // A selection belongs to the page it was made on.
  useEffect(() => setSelected(new Set()), [query]);
  const canChange = editable && Boolean(data?.primaryKey.length);

  /** After a change: the page and the list of changes read again, the selection cleared, a toast with Undo. */
  function changed(title: string, change?: string) {
    setEditor(null);
    setOpen(null);
    setDeleting(null);
    setSelected(new Set());
    rows.reload();
    setChanges((n) => n + 1);
    toastRowChange(title, database, table, change, () => {
      rows.reload();
      setChanges((n) => n + 1);
    });
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    const r = await deleteRowsNow(database, table, deleting.map((row) => row.key ?? []));
    setDeleteBusy(false);
    if (!r.ok) {
      setDeleting(null);
      toast({ tone: 'danger', title: 'Not deleted', detail: r.error });
      return;
    }
    changed(deleting.length === 1 ? 'Row deleted' : `${deleting.length} rows deleted`, r.change);
  }

  function toggleSort(column: string) {
    setPage(1);
    setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : undefined));
  }

  function apply(e?: FormEvent) {
    e?.preventDefault();
    setPage(1);
    setFilters(drafts.filter((f) => !needsValue(f.op) || (f.value ?? '') !== ''));
    setMatch(draftMatch);
  }

  function clear() {
    setDrafts([]);
    setFilters([]);
    setDraftMatch('all');
    setMatch('all');
    setPage(1);
    if (!cleanup) dropSeed();
  }

  function clearCleanup() {
    setCleanup(null);
    setPage(1);
    dropSeed();
  }

  // A new filter starts on the first text column: most searches are for a name or a value.
  const first = (columns.find((c) => !c.numeric && !c.binary) ?? columns[0])?.name;
  const draftsChanged = JSON.stringify(drafts) !== JSON.stringify(filters) || draftMatch !== match;
  const picked = data?.rows.filter((r) => selected.has(keyOf(r))) ?? [];

  return (
    <>
    <Card>
      <form onSubmit={apply} className="grid gap-2 border-b px-4 py-3">
        {cleanup && (
          <div className="grid gap-1">
            <span className="flex w-fit max-w-full items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pr-1 pl-3 text-xs font-medium text-primary">
              <span className="truncate">Only: {cleanup.label ?? 'what the clean-up would take'}</span>
              <button type="button" className="rounded-full p-0.5 hover:bg-primary/15" aria-label="Show every row" title="Show every row" onClick={clearCleanup}>
                <X className="size-3.5" />
              </button>
            </span>
            {cleanup.note && <p className="text-xs text-muted-foreground">{cleanup.note}</p>}
          </div>
        )}
        {drafts.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select aria-label="Column" value={f.column} onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))} wrapClassName="min-w-36 flex-1 sm:flex-none">
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </Select>
            <Select aria-label="Compare" value={f.op} onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, op: e.target.value as DbFilterOp } : x)))} wrapClassName="min-w-32">
              {DB_FILTER_OPS.map((op) => <option key={op} value={op}>{DB_FILTER_LABELS[op]}</option>)}
            </Select>
            {needsValue(f.op) && (
              <Input aria-label="Value" value={f.value ?? ''} onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="min-w-40 flex-1" />
            )}
            <Button size="icon" variant="ghost" aria-label="Remove this filter" onClick={() => setDrafts((d) => d.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        ))}
        {/* Two groups: what filters the rows on the left, what changes them on the right. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!first || drafts.length >= 10} onClick={() => first && setDrafts((d) => [...d, { column: first, op: 'contains', value: '' }])}>
              <Filter />
              {drafts.length ? 'Add a filter' : 'Filter'}
            </Button>
            {drafts.length > 1 && (
              <Segmented label="Rows that match" value={draftMatch} onChange={setDraftMatch} options={[['all', 'Match every filter'], ['any', 'Match any filter']]} className="text-xs" />
            )}
            {drafts.length > 0 && <Button size="sm" type="submit" disabled={!draftsChanged}>Apply</Button>}
            {(drafts.length > 0 || filters.length > 0) && <Button size="sm" variant="outline" onClick={clear}>Clear</Button>}
          </div>
          <div role="group" aria-label="Rows" className="ml-auto flex flex-wrap items-center gap-2">
            {rows.loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Reading rows" />}
            {canChange && picked.length > 0 && (
              <Button size="sm" variant="outline" className="text-danger" onClick={() => setDeleting(picked)}><Trash2 />Delete {picked.length === 1 ? 'the ticked row' : `the ${picked.length} ticked rows`}</Button>
            )}
            {canChange && (
              <Button size="sm" variant="outline" className="max-w-full" title={`Add a row to ${table}`} onClick={() => setEditor({ mode: 'add', row: null })}>
                <Plus />
                <span className="truncate">Add a row to <span className="font-mono">{table}</span></span>
              </Button>
            )}
            {canChange && <span aria-hidden className="mx-1 h-5 w-px bg-border" />}
            <label htmlFor={`${table}-page-size`} className="text-xs text-muted-foreground">Rows a page</label>
            <Select id={`${table}-page-size`} value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value) as (typeof DB_PAGE_SIZES)[number]), setPage(1))} className="h-8 w-24 py-0 text-xs">
              {DB_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </div>
        </div>
      </form>
      {rows.error && <Notice className="mx-4 mt-3">{rows.error}</Notice>}
      {data && <RowsGrid page={data} sort={sort} onSort={toggleSort} onOpen={setOpen} {...(canChange ? { selected, onSelect: setSelected } : {})} />}
      {!data && rows.loading && <TableSkeleton className="rounded-none border-0 shadow-none" columns={5} rows={8} />}
      {data && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <span className="flex-1">{pageLine(data)}</span>
          <Button size="sm" variant="outline" disabled={page <= 1 || rows.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft />Previous
          </Button>
          <Button size="sm" variant="outline" disabled={!data.hasMore || rows.loading} onClick={() => setPage((p) => p + 1)}>
            Next<ChevronRight />
          </Button>
        </div>
      )}
      <RowDialog
        row={open}
        page={data}
        database={database}
        table={table}
        onClose={() => setOpen(null)}
        {...(canChange
          ? {
              onEdit: (row: DbRow) => (setOpen(null), setEditor({ mode: 'edit', row })),
              onDuplicate: (row: DbRow) => (setOpen(null), setEditor({ mode: 'duplicate', row })),
              onDelete: (row: DbRow) => (setOpen(null), setDeleting([row])),
            }
          : {})}
      />
      {editor && data && (
        <RowEditor mode={editor.mode} database={database} table={table} columns={data.columns} primaryKey={data.primaryKey} row={editor.row} onClose={() => setEditor(null)} onDone={changed} />
      )}
      {deleting && <DeleteRowsDialog count={deleting.length} table={table} busy={deleteBusy} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />}
    </Card>
    {canChange && <RowChangesCard database={database} table={table} refresh={changes} onUndone={() => rows.reload()} />}
    </>
  );
}

function pageLine(p: DbRowsPage): string {
  if (p.rows.length === 0) return p.page > 1 ? 'No rows on this page.' : 'No rows match.';
  const from = (p.page - 1) * p.pageSize + 1;
  const to = from + p.rows.length - 1;
  const of = p.total === null ? '' : ` of ${p.totalExact ? '' : 'about '}${number(p.total)}`;
  return `Rows ${number(from)} to ${number(to)}${of}`;
}

function RowsGrid({ page, sort, onSort, onOpen, selected, onSelect }: {
  page: DbRowsPage;
  sort: Sort;
  onSort: (column: string) => void;
  onOpen: (row: DbRow) => void;
  /** Rows ticked to delete together, by key; no tick column without it. */
  selected?: Set<string>;
  /** Takes an update of the ticked rows, so quick ticks build on each other. */
  onSelect?: (update: (current: Set<string>) => Set<string>) => void;
}) {
  const all = page.rows.length > 0 && page.rows.every((r) => selected?.has(keyOf(r)));
  const toggle = (row: DbRow) =>
    onSelect?.((current) => {
      const next = new Set(current);
      if (next.has(keyOf(row))) next.delete(keyOf(row));
      else next.add(keyOf(row));
      return next;
    });
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b bg-muted/50">
            {onSelect && (
              <th scope="col" className="w-8 px-3 py-2">
                <input type="checkbox" aria-label="Tick every row on this page" checked={all} onChange={() => onSelect(() => (all ? new Set() : new Set(page.rows.map(keyOf))))} />
              </th>
            )}
            {page.columns.map((c) => {
              const sorted = sort?.column === c.name ? sort.dir : undefined;
              return (
                <th key={c.name} scope="col" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'} className="p-0 font-medium whitespace-nowrap">
                  <button type="button" onClick={() => onSort(c.name)} title={c.type} aria-label={`${c.name}, ${c.type}: sort`} className="flex w-full items-center gap-1 px-3 py-2 text-left hover:bg-muted">
                    {page.primaryKey.includes(c.name) && <KeyRound className="size-3 text-muted-foreground" aria-label="Primary key" />}
                    <span className="font-mono">{c.name}</span>
                    {sorted === 'asc' && <ArrowUp className="size-3" />}
                    {sorted === 'desc' && <ArrowDown className="size-3" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row, i) => (
            <tr key={row.key?.join('\u0000') ?? i} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(e) => e.key === 'Enter' && onOpen(row)} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none">
              {onSelect && (
                <td className="px-3 py-1.5 align-top" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="Tick this row" checked={selected?.has(keyOf(row)) ?? false} onChange={() => toggle(row)} />
                </td>
              )}
              {row.cells.map((cell, j) => (
                <td key={j} className="max-w-[22rem] px-3 py-1.5 align-top">
                  <CellPreview cell={cell} numeric={Boolean(page.columns[j]?.numeric)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellPreview({ cell, numeric }: { cell: DbCell; numeric: boolean }) {
  if (cell === null) return <span className="text-muted-foreground italic">NULL</span>;
  if (typeof cell === 'string') {
    if (cell === '') return <span className="text-muted-foreground" aria-label="empty">&nbsp;</span>;
    return <span className={cn('block truncate font-mono', numeric && 'text-right tabular-nums')}>{cell}</span>;
  }
  if (cell.binary) return <span className="text-muted-foreground">binary, {bytes(cell.length)}</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="truncate font-mono">{cell.head}</span>
      <Badge className="shrink-0">{number(cell.length)} chars</Badge>
    </span>
  );
}

// ── one row ──────────────────────────────────────────────────

function RowDialog({ row, page, database, table, onClose, onEdit, onDuplicate, onDelete }: {
  row: DbRow | null;
  page: DbRowsPage | undefined;
  database: string;
  table: string;
  onClose: () => void;
  /** Present when the table's rows can change here. */
  onEdit?: (row: DbRow) => void;
  onDuplicate?: (row: DbRow) => void;
  onDelete?: (row: DbRow) => void;
}) {
  const fullScreen = useFullScreen();
  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      title={`A row of ${table}`}
      size="xl"
      fullScreen={fullScreen}
      footer={
        <>
          {row?.key && onDelete && <Button variant="outline" className="mr-auto text-danger" onClick={() => onDelete(row)}><Trash2 />Delete</Button>}
          <Button variant="outline" onClick={onClose}>Close</Button>
          {row?.key && onDuplicate && <Button variant="outline" onClick={() => onDuplicate(row)}><Copy />Duplicate</Button>}
          {row?.key && onEdit && <Button onClick={() => onEdit(row)}><Pencil />Edit</Button>}
        </>
      }
    >
      {row && page && (
        <div className="grid gap-3">
          {page.columns.map((c, i) => (
            <div key={c.name} className="grid gap-1">
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono font-medium text-foreground">{c.name}</span>
                <span className="font-mono">{c.type}</span>
              </p>
              <FullValue cell={row.cells[i] ?? null} column={c.name} rowKey={row.key} database={database} table={table} />
            </div>
          ))}
          {!row.key && <p className="text-xs text-muted-foreground">This table has no primary key, so long values show only their start here.</p>}
        </div>
      )}
    </Dialog>
  );
}

function FullValue({ cell, column, rowKey, database, table }: { cell: DbCell; column: string; rowKey: string[] | undefined; database: string; table: string }) {
  const [full, setFull] = useState<{ value: DbCell; cut: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = full?.value ?? cell;
  const long = cell !== null && typeof cell !== 'string';

  async function load() {
    if (!rowKey) return;
    setLoading(true);
    setError(null);
    try {
      setFull(await api.dbCell(database, table, { column, key: rowKey }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <ValueView cell={shown} />
      {long && !full && rowKey && (
        <div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading && <LoaderCircle className="animate-spin" />}
            Show all {number((cell as { length: number }).length)} {(cell as { binary?: true }).binary ? 'bytes' : 'characters'}
          </Button>
        </div>
      )}
      {full?.cut && <p className="text-xs text-muted-foreground">Cut at a megabyte of text (64 KB of binary). phpMyAdmin shows the rest.</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => toast({ tone: 'success', title: 'Copied' }))}
    >
      <Copy />{label}
    </Button>
  );
}

/** A value as text, or as a tree when it is PHP serialized or JSON. */
export function ValueView({ cell }: { cell: DbCell }) {
  const text = cell === null ? null : typeof cell === 'string' ? cell : cell.head;
  const binary = cell !== null && typeof cell !== 'string' && cell.binary;
  const php = useMemo(() => (text && !binary && typeof cell === 'string' ? parsePhpSerialized(text) : null), [text, binary, cell]);
  const json = useMemo(() => (text && !binary && !php && typeof cell === 'string' ? parseJsonValue(text) : undefined), [text, binary, php, cell]);
  const [asTree, setAsTree] = useState(true);
  if (text === null) return <p className="rounded-md bg-muted/60 px-3 py-2 font-mono text-[13px] text-muted-foreground italic">NULL</p>;
  const hasTree = php !== null || json !== undefined;
  const cut = typeof cell !== 'string';
  return (
    <div className="grid gap-1">
      {/* Short values are easy to select; a copy button helps with long and structured ones. */}
      {(hasTree || (!cut && (text.length > 80 || text.includes('\n')))) && (
        <div className="flex items-center gap-2">
          {hasTree && <Segmented label="View" value={asTree ? 'tree' : 'text'} onChange={(v) => setAsTree(v === 'tree')} options={[['tree', php ? 'PHP serialized' : 'JSON'], ['text', 'Text']]} />}
          {!cut && <CopyButton text={text} />}
        </div>
      )}
      {hasTree && asTree ? (
        <div className="max-h-96 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[13px]">
          {php ? <PhpTree value={php} /> : <JsonTree value={json} />}
        </div>
      ) : (
        <pre onCopy={copyRealBytes} className="max-h-96 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[13px] break-all whitespace-pre-wrap">
          {binary ? `0x${text}` : text === '' ? <span className="font-sans text-muted-foreground italic">empty</span> : <Visible text={text} />}
          {cut && <span className="text-muted-foreground">…</span>}
        </pre>
      )}
    </div>
  );
}

/**
 * Text with its control characters drawn as PHP writes them, `\0` and the
 * like, instead of a box or nothing. The label is CSS and the real character
 * stays in the page under it, for copyRealBytes to find.
 */
function Visible({ text }: { text: string }) {
  const runs = controlRuns(text);
  if (runs.every((r) => r.label === undefined)) return <>{text}</>;
  return (
    <>
      {runs.map((r, i) =>
        r.label !== undefined ? (
          <span
            key={i}
            data-label={r.label}
            title={r.label === '\\0' ? 'A NUL byte' : 'A control character'}
            className="mx-px rounded-sm bg-foreground/10 px-0.5 text-muted-foreground before:content-[attr(data-label)]"
          >
            <span className="inline-block w-0 overflow-hidden">{r.text}</span>
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/**
 * Text selected by hand copies its real bytes, as the Copy button does. A
 * browser drops NUL bytes from a selection, which breaks the lengths of a PHP
 * serialized value, so a selection with control characters is copied from
 * the page's own text instead; any other selection is left to the browser.
 */
function copyRealBytes(e: ClipboardEvent<HTMLElement>) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
  const text = range.cloneContents().textContent ?? '';
  if (controlRuns(text).every((r) => r.label === undefined)) return;
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
}

function scalar(v: PhpValue): ReactNode {
  switch (v.type) {
    case 'null':
      return <span className="text-muted-foreground italic">null</span>;
    case 'bool':
      return <span className="text-primary">{v.value ? 'true' : 'false'}</span>;
    case 'int':
    case 'float':
      return <span className="text-primary">{v.value}</span>;
    case 'string':
      return <span className="break-all">&quot;<Visible text={v.value} />&quot;</span>;
    default:
      return null;
  }
}

function PhpTree({ value }: { value: PhpValue }) {
  if (value.type !== 'array' && value.type !== 'object') return <>{scalar(value)}</>;
  return (
    <>
      <span className="text-muted-foreground">{value.type === 'object' ? `${value.className} object` : 'array'} ({value.entries.length})</span>
      <ul className="ml-4 border-l pl-3">
        {value.entries.map(([k, v], i) => (
          <li key={i}>
            <span className="text-muted-foreground">{value.type === 'object' && k.type === 'string' ? <Property name={k.value} className={value.className} /> : k.type === 'string' ? <Visible text={k.value} /> : k.type === 'int' ? k.value : '?'}: </span>
            <PhpTree value={v} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** A property by its name, with protected or private marked (PHP keeps those with NUL bytes around them). */
function Property({ name, className }: { name: string; className: string }) {
  const p = propertyName(name);
  const tag = p.visibility === 'protected' ? 'protected' : p.visibility === 'private' ? (p.owner === className ? 'private' : `private to ${p.owner}`) : null;
  return (
    <>
      {tag && <span className="mr-1.5 rounded-sm border px-1 font-sans text-[11px]">{tag}</span>}
      <Visible text={p.name} />
    </>
  );
}

function JsonTree({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === 'string') return <span className="break-all">&quot;{value}&quot;</span>;
  if (typeof value !== 'object') return <span className="text-primary">{String(value)}</span>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <>
      <span className="text-muted-foreground">{Array.isArray(value) ? 'array' : 'object'} ({entries.length})</span>
      <ul className="ml-4 border-l pl-3">
        {entries.map(([k, v]) => (
          <li key={k}>
            <span className="text-muted-foreground">{k}: </span>
            <JsonTree value={v} />
          </li>
        ))}
      </ul>
    </>
  );
}

// ── structure ────────────────────────────────────────────────

function StructureView({ database, table }: { database: string; table: string }) {
  const structure = useAsync(() => api.dbStructure(database, table), [database, table]);
  const s: DbStructure | undefined = structure.data;
  if (structure.loading && !s) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Reading>Reading the table's structure...</Reading>
        <CardSkeleton>
          <TableSkeleton className="rounded-none border-0 shadow-none" columns={5} rows={6} />
        </CardSkeleton>
        <CardSkeleton lines={3} />
      </div>
    );
  }
  if (structure.error) return <Notice>{structure.error}</Notice>;
  if (!s) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {s.warnings.length > 0 && (
        <ul className="grid gap-1.5 rounded-lg border border-warning/30 bg-warning/8 px-4 py-3 text-sm">
          {s.warnings.map((w) => (
            <li key={w} className="flex gap-2"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />{w}</li>
          ))}
        </ul>
      )}
      <Card>
        <CardHeader><CardTitle>Columns</CardTitle></CardHeader>
        <p className="px-5 pt-3 text-xs text-muted-foreground">
          {s.table.view ? 'A view: a saved query, with no rows of its own.' : <>{s.table.engine}, {s.table.collation}, {tableMeta(s.table)}</>}
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-y bg-muted/50 text-xs text-muted-foreground">
                {['Name', 'Type', 'NULL', 'Default', 'Key', 'Extra'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap first:pl-5">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {s.columns.map((c) => (
                <tr key={c.name} className="border-b last:border-b-0">
                  <td className="py-1.5 pr-3 pl-5 font-mono whitespace-nowrap">{c.name}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">{c.type}</td>
                  <td className="px-3 py-1.5">{c.nullable ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-1.5 font-mono">{c.default === null ? <span className="text-muted-foreground">none</span> : c.default === '' ? <span className="text-muted-foreground">empty</span> : c.default}</td>
                  <td className="px-3 py-1.5">{c.key && <Badge tone={c.key === 'PRI' ? 'primary' : 'neutral'}>{c.key === 'PRI' ? 'Primary' : c.key === 'UNI' ? 'Unique' : 'Index'}</Badge>}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{c.extra}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {!s.table.view && (
        <Card>
          <CardHeader><CardTitle>Indexes</CardTitle></CardHeader>
          <ul className="divide-y">
            {s.indexes.map((x) => (
              <li key={x.name} className="flex flex-wrap items-center gap-2 px-5 py-2 text-[13px]">
                <span className="font-mono">{x.name}</span>
                {x.name === 'PRIMARY' ? <Badge tone="primary">Primary</Badge> : x.unique ? <Badge>Unique</Badge> : null}
                {x.type && x.type !== 'BTREE' && <Badge>{x.type}</Badge>}
                <span className="flex-1 font-mono text-muted-foreground">({x.columns.join(', ')})</span>
                {x.cardinality !== undefined && <span className="text-xs text-muted-foreground">{number(x.cardinality)} distinct</span>}
              </li>
            ))}
            {s.indexes.length === 0 && <li className="px-5 py-3 text-sm text-muted-foreground">No indexes.</li>}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{s.table.view ? 'CREATE VIEW' : 'CREATE TABLE'}</CardTitle>
          <CopyButton text={s.createSql} />
        </CardHeader>
        <pre className="max-h-96 overflow-auto px-5 py-4 font-mono text-[12px] leading-relaxed whitespace-pre">{s.createSql}</pre>
      </Card>
    </div>
  );
}

import type { DbCell, DbColumnHead, DbFilter, DbFilterOp, DbOverview, DbRow, DbRowsPage, DbStructure, DbTable } from '@devmagic-panel/shared';
import { DB_FILTER_LABELS, DB_FILTER_OPS, DB_PAGE_SIZES } from '@devmagic-panel/shared';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Copy, ExternalLink, Filter, KeyRound, LoaderCircle, Plus, RefreshCw, Rows3, Search, Table2, TriangleAlert, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { parseJsonValue, parsePhpSerialized, type PhpValue } from '@/lib/php-serialized';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

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
  return <TablesList database={database} overview={overview.data} loading={overview.loading} error={overview.error} reload={overview.reload} onNavigate={onNavigate} header={header} />;
}

type TableFilter = 'all' | 'site' | 'other';
type TableSort = 'name' | 'size';

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
  const [sort, setSort] = useState<TableSort>('name');
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

  if (loading && !overview) return <div className="h-64 animate-pulse rounded-xl border bg-card" />;
  if (error && !overview) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{error}</p>;
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
          {overview.phpMyAdmin && (
            <ButtonLink size="sm" variant="ghost" href={pmaHref(overview.phpMyAdmin, database)} target="_blank" rel="noreferrer">
              <ExternalLink />phpMyAdmin
            </ButtonLink>
          )}
          <Button size="icon" variant="ghost" onClick={reload} disabled={loading} aria-label="Read the tables again">
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      {header}
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
        {tables.map((t) => (
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
                ...(overview.phpMyAdmin ? [{ label: 'Open in phpMyAdmin', icon: <ExternalLink />, onSelect: () => void window.open(pmaHref(overview.phpMyAdmin as string, database, t.name), '_blank', 'noreferrer') }] : []),
              ]}
            />
          </li>
        ))}
        {tables.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">{overview.tables.length ? 'No table matches.' : 'This database has no tables.'}</li>}
      </ul>
    </Card>
  );
}

function tableMeta(t: DbTable): string {
  const parts = [`about ${number(t.rows)} ${t.rows === 1 ? 'row' : 'rows'}`, bytes(t.dataBytes + t.indexBytes)];
  if (t.freeBytes > 10 * 1024 ** 2) parts.push(`${bytes(t.freeBytes)} free`);
  return parts.join(' · ');
}

function TableView({ database, table, show, overview, onNavigate }: { database: string; table: string; show: DbShow; overview: DbOverview | undefined; onNavigate: Props['onNavigate'] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* The name keeps a line of its own on a phone rather than breaking mid-word. */}
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => onNavigate({ table: null, show: 'rows' })}>
            <ArrowLeft />All tables
          </Button>
          <h3 className="min-w-0 truncate font-mono text-sm font-semibold" title={table}>{table}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Segmented label="Show" value={show} onChange={(next) => onNavigate({ table, show: next })} options={[['rows', 'Rows'], ['structure', 'Structure']]} />
          {overview?.phpMyAdmin && (
            <ButtonLink size="sm" variant="ghost" href={pmaHref(overview.phpMyAdmin, database, table)} target="_blank" rel="noreferrer">
              <ExternalLink />phpMyAdmin
            </ButtonLink>
          )}
        </div>
      </div>
      {show === 'structure' ? <StructureView database={database} table={table} /> : <RowsView key={`${database}.${table}`} database={database} table={table} />}
    </div>
  );
}

// ── rows ─────────────────────────────────────────────────────

type Sort = { column: string; dir: 'asc' | 'desc' } | undefined;

const needsValue = (op: DbFilterOp) => op !== 'isNull' && op !== 'notNull';

function RowsView({ database, table }: { database: string; table: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof DB_PAGE_SIZES)[number]>(50);
  const [sort, setSort] = useState<Sort>(undefined);
  const [filters, setFilters] = useState<DbFilter[]>([]);
  const [drafts, setDrafts] = useState<DbFilter[]>([]);
  const [open, setOpen] = useState<DbRow | null>(null);
  const query = useMemo(() => ({ page, pageSize, ...(sort ? { sort } : {}), filters }), [page, pageSize, sort, filters]);
  const rows = useAsync(() => api.dbRows(database, table, query), [database, table, query]);
  const data = rows.data;
  // The columns stay known while the next page loads, for the filter bar.
  const [columns, setColumns] = useState<DbColumnHead[]>([]);
  useEffect(() => {
    if (data) setColumns(data.columns);
  }, [data]);

  function toggleSort(column: string) {
    setPage(1);
    setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : undefined));
  }

  function apply(e?: FormEvent) {
    e?.preventDefault();
    setPage(1);
    setFilters(drafts.filter((f) => !needsValue(f.op) || (f.value ?? '') !== ''));
  }

  function clear() {
    setDrafts([]);
    setFilters([]);
    setPage(1);
  }

  // A new filter starts on the first text column: most searches are for a name or a value.
  const first = (columns.find((c) => !c.numeric && !c.binary) ?? columns[0])?.name;
  const changed = JSON.stringify(drafts) !== JSON.stringify(filters);

  return (
    <Card>
      <form onSubmit={apply} className="grid gap-2 border-b px-4 py-3">
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
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!first || drafts.length >= 10} onClick={() => first && setDrafts((d) => [...d, { column: first, op: 'contains', value: '' }])}>
            {drafts.length ? <Plus /> : <Filter />}
            {drafts.length ? 'Add a filter' : 'Filter'}
          </Button>
          {drafts.length > 0 && <Button size="sm" type="submit" disabled={!changed}>Apply</Button>}
          {(drafts.length > 0 || filters.length > 0) && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {rows.loading && <LoaderCircle className="size-4 animate-spin" aria-label="Reading rows" />}
            <label htmlFor={`${table}-page-size`}>Rows a page</label>
            <Select id={`${table}-page-size`} value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value) as (typeof DB_PAGE_SIZES)[number]), setPage(1))} className="h-8 py-0 text-xs">
              {DB_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </span>
        </div>
      </form>
      {rows.error && <p role="alert" className="mx-4 mt-3 rounded-lg border border-danger/30 bg-danger/8 px-4 py-2.5 text-sm text-danger">{rows.error}</p>}
      {data && <RowsGrid page={data} sort={sort} onSort={toggleSort} onOpen={setOpen} />}
      {!data && rows.loading && <div className="m-4 h-48 animate-pulse rounded-lg bg-muted" />}
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
      <RowDialog row={open} page={data} database={database} table={table} onClose={() => setOpen(null)} />
    </Card>
  );
}

function pageLine(p: DbRowsPage): string {
  if (p.rows.length === 0) return p.page > 1 ? 'No rows on this page.' : 'No rows match.';
  const from = (p.page - 1) * p.pageSize + 1;
  const to = from + p.rows.length - 1;
  const of = p.total === null ? '' : ` of ${p.totalExact ? '' : 'about '}${number(p.total)}`;
  return `Rows ${number(from)} to ${number(to)}${of}`;
}

function RowsGrid({ page, sort, onSort, onOpen }: { page: DbRowsPage; sort: Sort; onSort: (column: string) => void; onOpen: (row: DbRow) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b bg-muted/50">
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

function RowDialog({ row, page, database, table, onClose }: { row: DbRow | null; page: DbRowsPage | undefined; database: string; table: string; onClose: () => void }) {
  return (
    <Dialog open={row !== null} onClose={onClose} title={`A row of ${table}`} className="w-[min(48rem,calc(100vw-2rem))]">
      {row && page && (
        <div className="mt-3 grid max-h-[70vh] gap-3 overflow-y-auto pr-1">
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
      <div className="mt-4 flex justify-end">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>
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
      variant="ghost"
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
        <pre className="max-h-96 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[13px] break-all whitespace-pre-wrap">
          {binary ? `0x${text}` : text === '' ? <span className="font-sans text-muted-foreground italic">empty</span> : text}
          {cut && <span className="text-muted-foreground">…</span>}
        </pre>
      )}
    </div>
  );
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
      return <span className="break-all">&quot;{v.value}&quot;</span>;
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
            <span className="text-muted-foreground">{k.type === 'string' ? k.value : k.type === 'int' ? k.value : '?'}: </span>
            <PhpTree value={v} />
          </li>
        ))}
      </ul>
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
  if (structure.loading && !s) return <div className="h-64 animate-pulse rounded-xl border bg-card" />;
  if (structure.error) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{structure.error}</p>;
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

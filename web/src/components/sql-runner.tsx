import type { DbQueryResult, WriteCheck } from '@devmagic-panel/shared';
import { Download, History, KeyRound, LoaderCircle, Play, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react';
import { type KeyboardEvent, lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react';
import { CleanupsCard, ConfirmCleanup } from '@/components/cleanups';
import { ValueView } from '@/components/db-browser';
import { EditorBoundary } from '@/components/editor-boundary';
import { JobFooter } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { Segmented } from '@/components/ui/segmented';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { runWithToast } from '@/lib/site-actions';
import { loadSqlEditor } from '@/lib/sql-editor-load';
import { useRowDialogFull } from '@/lib/preferences';
import { addHistory, clearHistory, readHistory, toCsv } from '@/lib/sql-history';
import { bytes } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const SqlEditor = lazy(loadSqlEditor);

const HEIGHT_KEY = 'dmp:sql-editor-height';
const DEFAULT_HEIGHT = 176;

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= 96 ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

/** A box resized by dragging its bottom corner; its height stays for the next visit, in this browser only. */
function ResizableBox({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [height] = useState(savedHeight);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(el.getBoundingClientRect().height)));
        } catch {
          // A private window: the height is only for this visit.
        }
      }, 300);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div
      ref={box}
      className="resize-y overflow-hidden rounded-md border border-input bg-card shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
      style={{ height, minHeight: '6rem', maxHeight: '80vh' }}
    >
      {children}
    </div>
  );
}

const number = (n: number) => n.toLocaleString('en-US');
/** The longest a cell shows in the grid; the row opens with all of it. */
const CELL_SHOWN = 200;

/**
 * Runs one statement against a database. Read only by default, as the
 * read-only MySQL account: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or
 * VALUES, up to 1,000 rows as a grid and as CSV. Where the database may
 * change, Can write runs one statement that writes as a job, after a check
 * of what it changes and with the tables it names saved first for Undo. The
 * last 30 statements stay in this browser.
 */
/**
 * Opens the SQL view with this statement in the editor, like a slow query;
 * with explain, the view explains it at once. Kept in the browser's history
 * only.
 */
export const sqlSeedState = (sql: string, explain = false) => ({ sqlSeed: sql, ...(explain ? { sqlExplain: true } : {}) });

/** The statement the page was opened with, if any, and whether to explain it. */
export function sqlSeed(): { sql: string; explain: boolean } | undefined {
  try {
    const state = window.history.state as { sqlSeed?: unknown; sqlExplain?: unknown } | null;
    return typeof state?.sqlSeed === 'string' ? { sql: state.sqlSeed, explain: state.sqlExplain === true } : undefined;
  } catch {
    return undefined;
  }
}

export function SqlRunner({ database, placeholder, canWrite = false, seed }: { database: string; placeholder?: string; canWrite?: boolean; seed?: { sql: string; explain: boolean } | undefined }) {
  const [mode, setMode] = useState<'read' | 'write'>('read');
  const writing = canWrite && mode === 'write';
  const [checked, setChecked] = useState<WriteCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const runner = useJob();
  const done = useRef<string | null>(null);
  const { job } = runner;
  const [sql, setSql] = useState(seed?.sql ?? '');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [running, setRunning] = useState<'run' | 'explain' | null>(null);
  const [history, setHistory] = useState(() => readHistory(database));
  const fullScreen = useRowDialogFull();
  const [open, setOpen] = useState<number | null>(null);
  // Table and column names for the suggestions; without them the editor still suggests keywords.
  const schema = useAsync(() => api.dbSchema(database), [database]);
  // A statement that wrote may have changed the tables: the suggestions and the list of what to undo read again.
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    schema.reload();
    setRefresh((n) => n + 1);
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title}: done` });
  }, [job, schema]);
  // Opened to explain a statement, like a slow query: the plan shows without a second click.
  const explainSeed = useRef(seed?.explain === true);
  useEffect(() => {
    if (!explainSeed.current) return;
    explainSeed.current = false;
    void run(true);
    // Once, with the statement it opened with: run is the newest on the first render.
  }, []);
  const hint = placeholder ?? "SELECT * FROM wp_options WHERE autoload = 'on' LIMIT 50";
  const plain = (
    <Textarea
      id={`sql-${database}`}
      value={sql}
      onChange={(e) => setSql(e.target.value)}
      onKeyDown={onKey}
      spellCheck={false}
      placeholder={hint}
      className="h-full min-h-0 resize-none rounded-none border-0 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0"
    />
  );

  async function run(explain = false) {
    if (!sql.trim() || running) return;
    setRunning(explain ? 'explain' : 'run');
    setError(null);
    try {
      const r = await api.dbQuery(database, { sql, ...(explain ? { explain: true } : {}) });
      setResult(r);
      setNeedsAccount(false);
      setHistory(addHistory(database, sql));
    } catch (err) {
      setResult(null);
      setNeedsAccount(err instanceof ApiError && err.status === 409);
      setError((err as Error).message);
    } finally {
      setRunning(null);
    }
  }

  async function makeAccount() {
    const r = await runWithToast('mysql.makeReadOnlyAccount', {}, 'Read-only MySQL account made');
    if (r?.ok) {
      setNeedsAccount(false);
      setError(null);
      void run();
    }
  }

  /** What a statement that writes would change, asked before it runs; the answer opens the confirm. */
  async function check() {
    if (!sql.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      setChecked(await api.checkWrite(database, sql));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  function startWrite(confirm: string) {
    setChecked(null);
    setResult(null);
    setHistory(addHistory(database, sql));
    void runner.follow(api.startJob('mysql.runSql', { database, sql, confirm }));
  }

  const go = () => void (writing ? check() : run());

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go();
    }
  }

  function download() {
    if (!result) return;
    const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${database}-${result.explain ? 'explain' : 'query'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate">SQL on <span className="font-mono text-[13px]">{database}</span></span>
          </CardTitle>
          {canWrite ? (
            <Segmented label="Mode" value={mode} onChange={(m) => (setMode(m), setError(null))} options={[['read', 'Read only'], ['write', 'Can write']]} />
          ) : (
            <Badge tone="success" className="shrink-0"><ShieldCheck className="size-3" />Read only</Badge>
          )}
        </CardHeader>
        <div className="grid gap-3 p-5">
          <label htmlFor={`sql-${database}`} className="sr-only">Statement</label>
          {/* The editor loads with this view; the plain text area stands in until it has, and if it cannot load. */}
          {/* One box for both, so nothing moves when the editor takes over; drag its corner to resize it. */}
          <ResizableBox>
            <EditorBoundary fallback={plain}>
              <Suspense fallback={plain}>
                <SqlEditor value={sql} onChange={setSql} onRun={go} {...(schema.data ? { schema: schema.data.tables } : {})} label={`SQL on ${database}`} placeholder={writing ? "UPDATE wp_options SET autoload = 'off' WHERE option_name = 'wandworks_cache'" : hint} />
              </Suspense>
            </EditorBoundary>
          </ResizableBox>
          {writing && (
            <p className="rounded-lg border border-warning/30 bg-warning/8 px-4 py-2.5 text-sm">
              One statement that changes rows (INSERT, UPDATE, DELETE, REPLACE) or a table, an index or a view (ALTER, CREATE, DROP, RENAME, TRUNCATE). The panel shows what it would change first, saves the tables it names, and Undo puts them back for 14 days.
            </p>
          )}
          {/* relative: the history list opens across this row, as wide as the editor. */}
          <div className="relative flex flex-wrap items-center gap-2">
            {writing ? (
              <Button onClick={() => void check()} disabled={!sql.trim() || checking || (job !== null && !settled(job))}>
                {checking ? <LoaderCircle className="animate-spin" /> : <Play />}Check and run...
              </Button>
            ) : (
              <>
                <Button onClick={() => void run()} disabled={!sql.trim() || running !== null}>
                  {running === 'run' ? <LoaderCircle className="animate-spin" /> : <Play />}Run
                </Button>
                <Button variant="outline" onClick={() => void run(true)} disabled={!sql.trim() || running !== null} title="How MySQL would run it: the indexes it uses and the rows it reads">
                  {running === 'explain' ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}Explain
                </Button>
              </>
            )}
            {history.length > 0 && <HistoryMenu history={history} onPick={setSql} onClear={() => (clearHistory(database), setHistory([]))} />}
            <span className="ml-auto text-xs text-muted-foreground">
              {writing ? 'Ctrl+Enter checks it first, Tab takes a suggestion.' : 'Ctrl+Enter runs, Tab takes a suggestion. One statement that reads, up to 1,000 rows and 30 seconds.'}
            </span>
          </div>
          {error && (
            <div role="alert" className="grid gap-2 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">
              <p className="font-mono text-[13px] break-words">{error}</p>
              {needsAccount && (
                <div className="flex flex-wrap items-center gap-2 text-foreground">
                  <p className="flex-1 text-muted-foreground">It can read every database and change none: MySQL refuses anything else it would try.</p>
                  <Button size="sm" onClick={() => void makeAccount()}><KeyRound />Make the read-only account</Button>
                </div>
              )}
            </div>
          )}
        </div>
        <JobFooter job={job} error={runner.error} onRetry={() => void runner.retry()} />
      </Card>
      {result && <ResultCard result={result} onOpen={setOpen} onCsv={download} />}
      {canWrite && <CleanupsCard database={database} refresh={refresh} onUndone={() => schema.reload()} />}
      {checked && (
        <ConfirmCleanup
          title={`Run this ${checked.statement} on ${database}?`}
          description={<WriteSummary check={checked} />}
          action="Save the tables and run it"
          typed={database}
          onClose={() => setChecked(null)}
          onConfirm={startWrite}
        />
      )}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title="A row of the result" size="xl" fullScreen={fullScreen} footer={<Button variant="outline" onClick={() => setOpen(null)}>Close</Button>}>
        {open !== null && result && (
          <div className="grid gap-3">
            {result.columns.map((c, i) => (
              <div key={i} className="grid gap-1">
                <p className="font-mono text-xs font-medium">{c}</p>
                <ValueView cell={result.rows[open]?.[i] ?? null} />
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** What a check found, for the confirm: the rows it changes, the tables saved first, and what Undo does. */
function WriteSummary({ check }: { check: WriteCheck }) {
  return (
    <div className="grid gap-2">
      <p>
        {check.rows !== null ? (
          <>It changes <strong className="text-foreground">{number(check.rows)} {check.rows === 1 ? 'row' : 'rows'}</strong>: tried in a transaction that was rolled back.</>
        ) : (
          check.why
        )}
      </p>
      {check.tables.length > 0 ? (
        <p>
          Saved first, whole: {check.tables.map((t) => `${t.name} (${bytes(t.bytes)})`).join(', ')}. The disk has {bytes(check.freeBytes)} free. Undo puts {check.tables.length === 1 ? 'it' : 'them'} back as before, losing what changed in {check.tables.length === 1 ? 'it' : 'them'} since.
        </p>
      ) : (
        <p>It names no table that is there yet: Undo deletes what it makes.</p>
      )}
    </div>
  );
}

function ResultCard({ result, onOpen, onCsv }: { result: DbQueryResult; onOpen: (row: number) => void; onCsv: () => void }) {
  const n = result.rows.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{result.explain ? 'How MySQL would run it' : 'Result'}</CardTitle>
        {n > 0 && (
          <Button size="sm" variant="outline" onClick={onCsv}><Download />CSV</Button>
        )}
      </CardHeader>
      {result.explained && (
        <div className="grid gap-1 px-5 pt-3 text-xs text-muted-foreground">
          <p>MySQL explains a {result.statement} only to an account that may run it, so this is the plan of the SELECT that finds the same rows: what makes the {result.statement} slow.</p>
          <code className="font-mono text-[12px] break-all whitespace-pre-wrap text-foreground">{result.explained}</code>
        </div>
      )}
      {result.note ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">{result.note}</p>
      ) : (
        /* Without a grid below it, the line keeps the card's padding at the bottom too. */
        <p className={cn('px-5 pt-3 text-xs text-muted-foreground', n === 0 && 'pb-4')}>
          {n === 0 ? 'No rows' : `${number(n)} ${n === 1 ? 'row' : 'rows'}`}
          {result.hasMore ? ', the first 1,000: more match, so narrow it with WHERE or LIMIT' : ''} in {number(result.ms)} ms.
        </p>
      )}
      {n > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-y bg-muted/50">
                {result.columns.map((c, i) => <th key={i} scope="col" className="px-3 py-2 font-mono font-medium whitespace-nowrap">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} tabIndex={0} onClick={() => onOpen(i)} onKeyDown={(e) => e.key === 'Enter' && onOpen(i)} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none">
                  {row.map((v, j) => (
                    <td key={j} className="max-w-[22rem] px-3 py-1.5 align-top">
                      {v === null ? (
                        <span className="text-muted-foreground italic">NULL</span>
                      ) : (
                        <span className={cn('flex items-center gap-1.5')}>
                          <span className="truncate font-mono">{v.length > CELL_SHOWN ? v.slice(0, CELL_SHOWN) : v || ' '}</span>
                          {v.length > CELL_SHOWN && <Badge className="shrink-0">{number(v.length)} chars</Badge>}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * The earlier statements, wide enough to tell them apart: each on up to two
 * lines in the editor's font, the whole statement on hover.
 */
function HistoryMenu({ history, onPick, onClear }: { history: string[]; onPick: (sql: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={root}>
      <Button variant="ghost" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="text-muted-foreground hover:text-foreground">
        <History />History<span className="text-xs tabular-nums">{history.length}</span>
      </Button>
      {open && (
        <div id={id} role="menu" aria-label="Earlier statements" className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border bg-card p-1 shadow-lg">
          <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
            {history.map((h) => (
              <button
                key={h}
                type="button"
                role="menuitem"
                title={h}
                onClick={pick(() => onPick(h))}
                className="block w-full rounded-md px-2.5 py-1.5 text-left font-mono text-xs leading-5 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <span className="line-clamp-2 break-all">{h.replace(/\s+/g, ' ')}</span>
              </button>
            ))}
          </div>
          <div className="mt-1 border-t pt-1">
            <button type="button" role="menuitem" onClick={pick(onClear)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-danger hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
              <Trash2 className="size-4" />Clear this list
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

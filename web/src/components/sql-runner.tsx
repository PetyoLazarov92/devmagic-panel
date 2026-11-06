import type { DbQueryResult } from '@devmagic-panel/shared';
import { Download, History, KeyRound, LoaderCircle, Play, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react';
import { Component, type KeyboardEvent, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { ValueView } from '@/components/db-browser';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { api, ApiError } from '@/lib/api';
import { runWithToast } from '@/lib/site-actions';
import { addHistory, clearHistory, readHistory, toCsv } from '@/lib/sql-history';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const SqlEditor = lazy(() => import('@/components/sql-editor'));

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

/** The plain text area when the editor's code cannot load (after an update, or offline): the runner still works. */
class EditorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const number = (n: number) => n.toLocaleString('en-US');
/** The longest a cell shows in the grid; the row opens with all of it. */
const CELL_SHOWN = 200;

/**
 * Runs one statement that reads against a database, as the read-only MySQL
 * account: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE or VALUES. Up to
 * 1,000 rows come back, as a grid and as CSV; the last 30 statements stay in
 * this browser.
 */
export function SqlRunner({ database, placeholder }: { database: string; placeholder?: string }) {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [running, setRunning] = useState<'run' | 'explain' | null>(null);
  const [history, setHistory] = useState(() => readHistory(database));
  const [open, setOpen] = useState<number | null>(null);
  // Table and column names for the suggestions; without them the editor still suggests keywords.
  const schema = useAsync(() => api.dbSchema(database), [database]);
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

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
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
          <Badge tone="success" className="shrink-0"><ShieldCheck className="size-3" />Read only</Badge>
        </CardHeader>
        <div className="grid gap-3 p-5">
          <label htmlFor={`sql-${database}`} className="sr-only">Statement</label>
          {/* The editor loads with this view; the plain text area stands in until it has, and if it cannot load. */}
          {/* One box for both, so nothing moves when the editor takes over; drag its corner to resize it. */}
          <ResizableBox>
            <EditorBoundary fallback={plain}>
              <Suspense fallback={plain}>
                <SqlEditor value={sql} onChange={setSql} onRun={() => void run()} {...(schema.data ? { schema: schema.data.tables } : {})} label={`SQL on ${database}`} placeholder={hint} />
              </Suspense>
            </EditorBoundary>
          </ResizableBox>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void run()} disabled={!sql.trim() || running !== null}>
              {running === 'run' ? <LoaderCircle className="animate-spin" /> : <Play />}Run
            </Button>
            <Button variant="outline" onClick={() => void run(true)} disabled={!sql.trim() || running !== null} title="How MySQL would run it: the indexes it uses and the rows it reads">
              {running === 'explain' ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}Explain
            </Button>
            {history.length > 0 && (
              <Menu
                label="Earlier statements"
                align="start"
                items={[
                  ...history.map((h) => ({ label: h.length > 70 ? `${h.slice(0, 70)}…` : h, icon: <History />, onSelect: () => setSql(h) })),
                  { label: 'Clear this list', icon: <Trash2 />, danger: true, onSelect: () => (clearHistory(database), setHistory([])) },
                ]}
              />
            )}
            <span className="ml-auto text-xs text-muted-foreground">Ctrl+Enter runs, Tab takes a suggestion. One statement that reads, up to 1,000 rows and 30 seconds.</span>
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
      </Card>
      {result && <ResultCard result={result} onOpen={setOpen} onCsv={download} />}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title="A row of the result" className="w-[min(48rem,calc(100vw-2rem))]">
        {open !== null && result && (
          <div className="mt-3 grid max-h-[70vh] gap-3 overflow-y-auto pr-1">
            {result.columns.map((c, i) => (
              <div key={i} className="grid gap-1">
                <p className="font-mono text-xs font-medium">{c}</p>
                <ValueView cell={result.rows[open]?.[i] ?? null} />
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={() => setOpen(null)}>Close</Button>
        </div>
      </Dialog>
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
      {/* Without a grid below it, the line keeps the card's padding at the bottom too. */}
      <p className={cn('px-5 pt-3 text-xs text-muted-foreground', n === 0 && 'pb-4')}>
        {n === 0 ? 'No rows' : `${number(n)} ${n === 1 ? 'row' : 'rows'}`}
        {result.hasMore ? ', the first 1,000: more match, so narrow it with WHERE or LIMIT' : ''} in {number(result.ms)} ms.
      </p>
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

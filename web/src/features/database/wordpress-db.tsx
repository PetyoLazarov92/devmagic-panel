import type { DbCleanupView, Site, WpDbHealthIssue, WpDbPluginTable, WpDbBlog, WpDbList, WpDbReport, WpDbSection, WpPluginState, WpTableFix } from '@devmagic-panel/shared';
import { WP_DB_LIST_ROWS, WP_DB_ON_DEMAND, WP_DB_SECTIONS, WP_DB_SLOW_SECTIONS, WP_KEEP_REVISIONS, WP_ORPHAN_KINDS } from '@devmagic-panel/shared';
import { ChevronDown, ChevronUp, CircleAlert, Gauge, Info, TriangleAlert, Hourglass, KeyRound, type LucideIcon, Puzzle, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, TrendingUp, Users, Wrench } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CleanupsCard, ConfirmCleanup } from '@/features/database/cleanups';
import type { RowsSeed } from '@/features/database/db-browser';
import { JobFooter } from '@/features/jobs/job-box';
import { settled, useJob, useResumeJob } from '@/features/jobs/job-steps';
import { toastRowChange } from '@/features/database/row-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { KeyValue } from '@/components/ui/key-value';
import { Bar, CardLinesSkeleton, CardSkeleton, Reading } from '@/components/layout/skeletons';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { type HealthRow, healthRows, wordpressFindings } from '@/lib/wp-findings';
import { NeedsALook } from '@/components/layout/needs-a-look';
import { Notice, ViewBar } from '@/components/layout/page';

const number = (n: number) => n.toLocaleString('en-US');

/** A site of a network in a few words: its path on the network's domain (its domain on another), its prefix, and whether it is archived or deleted. */
function networkLabel(b: WpDbBlog, domain: string): string {
  const where = b.domain === domain ? (b.id === 1 ? `${b.path} (main site)` : b.path) : `${b.domain}${b.path}`;
  return `${where} · ${b.prefix}${b.inactive ? ' · archived or deleted' : ''}`;
}

interface Props {
  site: Pick<Site, 'domain' | 'path'>;
  /** The site of a network the view is about; 1 for a single site. */
  blog: number;
  onBlog: (blog: number) => void;
  /** Opens a table in the Tables view, with filters or a clean-up's rows to start with. */
  onTable: OnTable;
}

type OnTable = (table: string, seed?: Omit<RowsSeed, 'table'>) => void;

/** The site a clean-up's rows belong to, as the rows request names it. */
type Target = Pick<DbCleanupView, 'domain' | 'path' | 'blog'>;

type Slot = 'health' | 'plugins' | 'transients' | 'content' | 'orphans';
type Errors = WpDbReport['errors'];
/** The card each clean-up's job shows in. */
const SLOT_OF: Partial<Record<string, Slot>> = { 'db.fixTable': 'health', 'db.fixTables': 'health', 'db.toInnodb': 'health', 'db.autoloadOff': 'plugins', 'db.cleanTransients': 'transients', 'db.cleanContent': 'content', 'db.cleanOrphans': 'content' };

const QUICK = WP_DB_SECTIONS.filter((s) => !WP_DB_SLOW_SECTIONS.includes(s) && !WP_DB_ON_DEMAND.includes(s));

interface ReportState {
  report: WpDbReport | null;
  /** The parts asked for and not answered yet. */
  reading: WpDbSection[];
  /** Parts whose request failed, with why. */
  failed: Errors;
}
const FRESH: ReportState = { report: null, reading: WP_DB_SECTIONS.filter((s) => !WP_DB_ON_DEMAND.includes(s)), failed: {} };

/**
 * The report read in parts, so the page shows in a moment on a big database:
 * the quick parts in one request, and each part that reads whole tables
 * (posts, every meta table) in its own, filling its card in when it answers.
 * Check again keeps what is shown until the new answer replaces it.
 */
function useWordpressReport(domain: string, path: string | undefined, blog: number) {
  const [state, setState] = useState<ReportState>(FRESH);
  const run = useRef(0);
  // Aborts the reads of a run nobody waits for any more: they stop in MySQL too.
  const reads = useRef<AbortController | null>(null);

  const ask = useCallback(
    (sections: readonly WpDbSection[], sizes = false) => {
      const id = run.current;
      const signal = reads.current?.signal;
      const done = (s: ReportState) => s.reading.filter((x) => !sections.includes(x));
      setState((s) => ({ ...s, reading: [...new Set([...s.reading, ...sections])], failed: Object.fromEntries(Object.entries(s.failed).filter(([k]) => !sections.includes(k as WpDbSection))) }));
      api.wordpressDb(domain, path, blog, { sections, sizes, ...(signal ? { signal } : {}) }).then(
        (r) => {
          if (id !== run.current) return;
          setState((s) => {
            const kept = Object.fromEntries(Object.entries(s.report?.errors ?? {}).filter(([k]) => !sections.includes(k as WpDbSection)));
            const readAt = { ...s.report?.readAt, ...Object.fromEntries(sections.map((x) => [x, r.checkedAt])) };
            return { ...s, report: { ...(s.report ?? {}), ...r, errors: { ...kept, ...r.errors }, readAt }, reading: done(s) };
          });
        },
        (error: unknown) => {
          if (id !== run.current) return;
          const why = (error as Error).message;
          setState((s) => ({ ...s, reading: done(s), failed: { ...s.failed, ...Object.fromEntries(sections.map((x) => [x, why])) } }));
        },
      );
    },
    [domain, path, blog],
  );

  /** A new run: the reads of the last one stop. */
  const begin = useCallback(() => {
    run.current += 1;
    reads.current?.abort();
    reads.current = new AbortController();
    return run.current;
  }, []);

  /** Check again: every part read anew; repeats are looked for again only when asked, so an old count goes. */
  const load = useCallback(() => {
    begin();
    setState((s) => {
      if (!s.report?.duplicates && !s.report?.readAt?.duplicates) return s;
      // The count and its time both go, or "Read X ago" stays at when repeats were last looked for.
      const { duplicates: _gone, ...rest } = s.report;
      const { duplicates: _at, ...readAt } = rest.readAt ?? {};
      return { ...s, report: { ...rest, readAt } };
    });
    ask(QUICK);
    for (const section of WP_DB_SLOW_SECTIONS) ask([section]);
  }, [ask, begin]);

  // Another site or site of the network shows what the panel kept from the last visit at once, reads the quick parts
  // anew, and the parts that scan whole tables only when it has none of them yet.
  useEffect(() => {
    setState(FRESH);
    const id = begin();
    api.wordpressDbKept(domain, path, blog).then(
      (kept) => {
        if (id !== run.current) return;
        if (kept) setState({ report: kept, reading: [], failed: {} });
        ask(QUICK);
        for (const section of WP_DB_SLOW_SECTIONS) if (kept?.[section] === undefined) ask([section]);
      },
      () => {
        if (id === run.current) load();
      },
    );
    return () => {
      run.current += 1;
      reads.current?.abort();
    };
  }, [domain, path, blog, ask, begin, load]);

  const errors: Errors = { ...state.report?.errors, ...state.failed };
  const reading = (section: WpDbSection) => state.reading.includes(section);
  return { ...state, errors, reading, loading: state.reading.length > 0, reload: load, readSizes: () => ask(['metaKeys'], true), readDuplicates: () => ask(['duplicates']) };
}
type Ask = { slot: Slot; action: 'db.fixTable' | 'db.fixTables' | 'db.toInnodb' | 'mysql.optimize' | 'mysql.dropTable' | 'db.autoloadOff' | 'db.cleanTransients' | 'db.cleanContent' | 'db.cleanOrphans'; input: Record<string, unknown>; title: string; description: string; button: string; typed?: string };

/**
 * A WordPress database as WordPress sees it: autoloaded options against Site
 * Health's limit, with autoload switched off for a big one; transients; what
 * a clean-up would find, deleted in a job that saves it first; the postmeta
 * keys that take the most room and the users with their roles.
 */
export function WordpressDbView({ site, blog, onBlog, onTable }: Props) {
  const report = useWordpressReport(site.domain, site.path, blog);
  const runner = useJob();
  const [slot, setSlot] = useState<Slot | null>(null);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [refresh, setRefresh] = useState(0);
  const siteKey = `${site.domain}${site.path ?? ''}`;
  // A clean-up still running since before you came back shows in its card again.
  useResumeJob(runner, siteKey, SLOT_OF, setSlot);
  const { job } = runner;
  const done = useRef<string | null>(null);
  // A clean-up that settled changes the counts and the list of clean-ups to undo.
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    report.reload();
    setRefresh((n) => n + 1);
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title}: done` });
  }, [job, report]);
  const busy = job !== null && !settled(job);
  const target = { domain: site.domain, ...(site.path ? { path: site.path } : {}), ...(blog !== 1 ? { blog } : {}) };

  function start(ask: Ask) {
    setAsking(null);
    setSlot(ask.slot);
    void runner.follow(api.startJob(ask.action, { ...target, ...ask.input }));
  }

  async function autoloadOff(option: string) {
    try {
      const r = await api.runAction('db.setAutoload', { ...target, option, autoload: 'off' });
      if (!r.ok) return toast({ tone: 'danger', title: 'Autoload not changed', detail: lastLine(r.output) });
      toastRowChange(`${option} no longer loads on every page`, report.report?.database ?? '', `${report.report?.blogPrefix ?? 'wp_'}options`, r.data?.backup, () => report.reload());
      report.reload();
    } catch (error) {
      toast({ tone: 'danger', title: 'Autoload not changed', detail: (error as Error).message });
    }
  }

  // A job is the footer of the card that started it; the clean-up card has two kinds.
  const footerFor = (...slots: Slot[]) => (slot && slots.includes(slot) ? <JobFooter job={job} error={runner.error} onRetry={() => void runner.retry()} onStop={() => void runner.stop()} /> : null);
  const r = report.report;
  if (!r && report.loading) return <WordpressDbSkeleton />;
  if (!r) return <Notice>{Object.values(report.errors)[0] ?? 'The panel could not read this database'}</Notice>;
  const view: View = { report: r, errors: report.errors, reading: report.reading };

  return (
    <ShowAllScope.Provider value={`${siteKey}#${blog}`}>
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ViewBar
        onCheck={report.reload}
        loading={report.loading}
        checkedAt={Object.values(r.readAt ?? {}).sort()[0] ?? r.checkedAt}
        note={<>Tables starting <span className="font-mono">{r.blogPrefix}</span> in <span className="font-mono">{r.database}</span>. Each clean-up saves what it removes first, so Undo puts it back for 14 days.</>}
      >
        {r.network && (
          <label className="grid w-full gap-1 text-sm sm:flex sm:w-auto sm:items-center sm:gap-2">
            <span className="shrink-0 text-muted-foreground">Site of the network</span>
            <Select value={blog} onChange={(e) => onBlog(Number(e.target.value))} wrapClassName="w-full sm:w-auto sm:min-w-64 sm:max-w-md" className="h-9">
              {r.network.map((b) => (
                <option key={b.id} value={b.id} title={`${b.domain}${b.path}, tables ${b.prefix}`}>
                  {networkLabel(b, site.domain)}
                </option>
              ))}
            </Select>
          </label>
        )}
      </ViewBar>
      {r.missingTables.length > 0 && (
        <Notice tone="info">
          Tables WordPress makes that this database lacks: <span className="font-mono">{r.missingTables.join(', ')}</span>. Older WordPress versions had no termmeta table.
        </Notice>
      )}
      <NeedsALook items={wordpressFindings(r).map((f) => ({ ...f, key: `${f.card}:${f.text}` }))} />
      {/* In pairs of a kind and a size, each pair as tall as each other: what loads on every page and
          the tables' health, the caches and what grows, what a clean-up finds and the biggest meta,
          then what plugins and themes keep and the users across the row. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-2">
        <div id="wp-autoload" className="grid scroll-mt-4"><AutoloadCard view={view} onTable={onTable} onAutoloadOff={(o) => void autoloadOff(o)} /></div>
        <div id="wp-health" className="grid scroll-mt-4"><HealthCard view={view} busy={busy} onFix={setAsking} footer={footerFor('health')} /></div>
        <div id="wp-transients" className="grid scroll-mt-4"><TransientsCard view={view} target={target} busy={busy} onTable={onTable} onDelete={(scope) => setAsking(transientsAsk(r, scope))} footer={footerFor('transients')} /></div>
        <GrowthCard view={view} onTable={onTable} />
        <div id="wp-cleanup" className="grid scroll-mt-4"><CleanupCard view={view} target={target} busy={busy} onClean={setAsking} onScan={report.readDuplicates} onTable={onTable} footer={footerFor('content', 'orphans')} /></div>
        <MetaKeysCard view={view} onTable={onTable} onSizes={report.readSizes} />
        <div id="wp-plugins" className="grid scroll-mt-4 @3xl:col-span-2"><PluginsCard view={view} busy={busy} onTable={onTable} onAsk={setAsking} footer={footerFor('plugins')} /></div>
        <div className="grid @3xl:col-span-2"><UsersCard view={view} /></div>
      </div>
      <CleanupsCard database={r.database} site={siteKey} refresh={refresh} onUndone={() => report.reload()} />
      {asking && (
        <ConfirmCleanup title={asking.title} description={asking.description} action={asking.button} {...(asking.typed ? { typed: asking.typed } : {})} onClose={() => setAsking(null)} onConfirm={(confirm) => start(asking.typed ? { ...asking, input: { ...asking.input, confirm } } : asking)} />
      )}
    </div>
    </ShowAllScope.Provider>
  );
}

/** What every card is given: the report so far, the errors by part, and which parts are still being read. */
interface View {
  report: WpDbReport;
  errors: Errors;
  reading: (section: WpDbSection) => boolean;
}

/** A card's header: its title, and its icon, turning while the card reads again. */
function Header({ title, icon: Icon, reading, badge }: { title: string; icon: LucideIcon; reading: boolean; badge?: ReactNode }) {
  return (
    <CardHeader
      title={title}
      meta={
        <span className="flex items-center gap-2">
          {badge}
          {reading ? <RefreshCw className="size-4 animate-spin text-muted-foreground" aria-label="Reading" /> : <Icon className="size-4 text-muted-foreground" />}
        </span>
      }
    />
  );
}

/** The WordPress view's shape while its first part is read: the bar above the cards, then the cards in their two columns. */
function WordpressDbSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <div className="flex items-center gap-3">
        <Reading>Reading what WordPress keeps in this database...</Reading>
        <Bar className="ml-auto h-8 w-28 rounded-md" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-2">
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <CardSkeleton>
            <div className="grid gap-2.5 px-5 py-4">
              <Bar className="h-7 w-48" />
              <Bar className="h-2 w-full rounded-full" />
              <Bar className="h-3 w-40" />
            </div>
            <CardLinesSkeleton lines={5} className="pt-0" />
          </CardSkeleton>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={6} />
          <CardSkeleton lines={4} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <CardSkeleton lines={2} values={false} />
          <CardSkeleton lines={5} />
          <CardSkeleton lines={4} values={false} />
        </div>
      </div>
    </div>
  );
}

const SAVED = 'What it removes is saved first (14 days), so Undo on the job, or under Changes you can undo, puts it back.';

function transientsAsk(r: WpDbReport, scope: 'expired' | 'all'): Ask {
  const t = r.transients;
  const count = scope === 'expired' ? (t?.expired ?? 0) + (t?.site?.expired ?? 0) : (t?.count ?? 0) + (t?.site?.count ?? 0);
  return {
    slot: 'transients',
    action: 'db.cleanTransients',
    input: { scope },
    title: scope === 'expired' ? `Delete ${number(count)} expired transients?` : `Delete all ${number(count)} transients?`,
    description: `${scope === 'expired' ? 'The ones past their expiry, with their timeout rows.' : 'Plugins make them again when they need them; the first pages may be slower meanwhile.'} ${SAVED}`,
    button: scope === 'expired' ? 'Delete expired transients' : 'Delete every transient',
  };
}

function SectionError({ text }: { text: string | undefined }) {
  return text ? <p role="alert" className="mx-5 my-4 text-sm text-danger">{text}</p> : null;
}

/** True while a part has nothing to show yet: asked for, and no answer from this or an earlier read. */
const waiting = (view: View, section: WpDbSection) => view.report[section] === undefined && !view.errors[section];

/** The site (and site of a network) the lists belong to, so Show all is remembered per site. */
const ShowAllScope = createContext('');
/** This browser's memory of the lists shown in full, per site: a convenience, never sent to the panel. */
const SHOW_ALL_KEY = 'dmp-wpdb-show-all';

function shownInFull(scope: string): string[] {
  try {
    const kept = JSON.parse(localStorage.getItem(SHOW_ALL_KEY) ?? '{}') as Record<string, unknown>;
    const lists = kept[scope];
    return Array.isArray(lists) ? lists.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

function keepShownInFull(scope: string, lists: string[]): void {
  try {
    const kept = JSON.parse(localStorage.getItem(SHOW_ALL_KEY) ?? '{}') as Record<string, unknown>;
    if (lists.length) kept[scope] = lists;
    else delete kept[scope];
    localStorage.setItem(SHOW_ALL_KEY, JSON.stringify(kept));
  } catch {
    // Private windows may refuse storage: the list still opens, only for now.
  }
}

/**
 * The first few rows of a list, every row once Show all is picked: kept per
 * site in this browser, so a long card stays short, and a site you have not
 * opened in full starts short too.
 */
function useShowAll<T>(list: WpDbList, items: readonly T[], hiddenNote?: (hidden: readonly T[]) => string): { shown: readonly T[]; more: ReactNode } {
  const scope = useContext(ShowAllScope);
  const [state, setState] = useState(() => ({ scope, all: shownInFull(scope).includes(list) }));
  // Another site: what it remembers, not what the last one had.
  const all = state.scope === scope ? state.all : shownInFull(scope).includes(list);
  if (items.length <= WP_DB_LIST_ROWS) return { shown: items, more: null };
  const toggle = () => {
    const others = shownInFull(scope).filter((l) => l !== list);
    keepShownInFull(scope, all ? others : [...others, list]);
    setState({ scope, all: !all });
  };
  return {
    shown: all ? items : items.slice(0, WP_DB_LIST_ROWS),
    more: (
      <button type="button" aria-expanded={all} onClick={toggle} className="flex w-full items-center gap-1 border-t px-5 py-2 text-left text-xs font-medium text-primary hover:bg-muted/50">
        {all ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {all ? 'Show fewer' : `Show all ${number(items.length)}${hiddenNote?.(items.slice(WP_DB_LIST_ROWS)) ?? ''}`}
      </button>
    ),
  };
}

/** A name in a list that opens the table filtered on it, like a meta key in postmeta. */
function NameLink({ name, title, onOpen, className }: { name: ReactNode; title: string; onOpen: () => void; className?: string }) {
  return (
    <button type="button" className={cn('min-w-0 truncate text-left font-mono hover:text-primary hover:underline', className)} title={title} onClick={onOpen}>
      {name}
    </button>
  );
}

/** A count that opens the rows it counts in the Tables view, shown as a link on hover; a plain number at 0. */
function CountLink({ n, title, onOpen }: { n: number; title: string; onOpen: () => void }) {
  if (n === 0) return <span className="text-right tabular-nums">0</span>;
  return (
    <button type="button" className="text-right tabular-nums underline-offset-2 hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline" title={title} aria-label={`${number(n)}: ${title}`} onClick={onOpen}>
      {number(n)}
    </button>
  );
}

const eq = (column: string, value: string) => ({ filters: [{ column, op: 'eq' as const, value }] });

/** Counts as label and number, the numbers lined up on the right. */
function Facts({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return <KeyValue rows={rows.map(([label, value], i) => ({ key: String(i), label, value }))} className="grid-cols-[minmax(0,1fr)_auto] px-5 py-4 [&_dd]:text-right [&_dd]:tabular-nums" />;
}

function AutoloadCard({ view, onTable, onAutoloadOff }: { view: View; onTable: OnTable; onAutoloadOff: (option: string) => void }) {
  const { report, errors } = view;
  const a = report.autoload;
  const options = `${report.blogPrefix}options`;
  const { shown, more } = useShowAll('autoload', a?.top ?? []);
  const over = a ? a.bytes > a.limitBytes : false;
  const biggest = a?.top[0]?.bytes ?? 1;
  return (
    <Card>
      <Header title="Autoloaded options" icon={Gauge} reading={view.reading('autoload')} />
      <SectionError text={errors.autoload} />
      {waiting(view, 'autoload') && <CardLinesSkeleton lines={5} />}
      {a && (
        <>
          <div className="grid gap-2 px-5 pt-4">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums">{bytes(a.bytes)}</span>
              <span className="text-sm text-muted-foreground">in {number(a.count)} options, loaded on every page</span>
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={a.limitBytes} aria-valuenow={a.bytes} aria-label="Autoloaded size against Site Health's limit">
              <div className={cn('h-full rounded-full', over ? 'bg-warning' : 'bg-success')} style={{ width: `${Math.min(100, (a.bytes / a.limitBytes) * 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {over ? <Badge tone="warning" className="mr-1.5">Over the limit</Badge> : null}
              Site Health warns above {bytes(a.limitBytes)}.
            </p>
          </div>
          {a.top.length > 0 && (
            <>
              <p className="px-5 pt-4 text-xs font-medium text-muted-foreground">The biggest</p>
              <ul className="mt-1 grid gap-1 px-5 pb-2">
                {shown.map((o) => (
                  <li key={o.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 text-dense">
                    <NameLink name={o.name} title={`See ${o.name} in ${options}`} onOpen={() => onTable(options, eq('option_name', o.name))} />
                    <span className="text-right text-xs text-muted-foreground tabular-nums">{bytes(o.bytes)}</span>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => onAutoloadOff(o.name)} aria-label={`Stop loading ${o.name} on every page`} title="Load it only when a plugin asks for it">
                      Turn off
                    </Button>
                    <span className="col-span-3 h-1 rounded-full bg-muted" aria-hidden>
                      <span className="block h-full rounded-full bg-primary/50" style={{ width: `${Math.max(1, (o.bytes / biggest) * 100)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
              {more}
            </>
          )}
          <div className={cn('px-5 pb-4', more && 'border-t pt-3')}>
            <Button size="sm" variant="outline" onClick={() => onTable(options)}>Browse {options}</Button>
          </div>
        </>
      )}
      {a === null && !errors.autoload && <p className="px-5 py-4 text-sm text-muted-foreground">This site has no options table.</p>}
    </Card>
  );
}

function TransientsCard({ view, target, busy, onTable, onDelete, footer }: { view: View; target: Target; busy: boolean; onTable: OnTable; onDelete: (scope: 'expired' | 'all') => void; footer: ReactNode }) {
  const { report } = view;
  const t = report.transients;
  const options = `${report.blogPrefix}options`;
  const open = (kind: 'transients' | 'expiredTransients', label: string) => onTable(options, { cleanup: { ...target, kind }, label, note: 'Each transient has two rows: its value, and _transient_timeout_ with its expiry.' });
  return (
    <Card>
      <Header title="Transients" icon={Hourglass} reading={view.reading('transients')} />
      <SectionError text={view.errors.transients} />
      {waiting(view, 'transients') && <CardLinesSkeleton lines={3} />}
      {t && (
        <Facts
          rows={[
            ['Transients', <span key="all" className="inline-flex items-center gap-1.5"><CountLink n={t.count} title={`See the transients in ${options}`} onOpen={() => open('transients', 'transients')} /><span className="text-muted-foreground">({bytes(t.bytes)})</span></span>],
            ['Expired, still stored', <CountLink key="expired" n={t.expired} title={`See the expired transients in ${options}`} onOpen={() => open('expiredTransients', 'expired transients, with their timeout rows')} />],
            ...(t.site ? ([[report.network ? 'Network transients' : 'Site transients', `${number(t.site.count)} (${bytes(t.site.bytes)}), ${number(t.site.expired)} expired`]] as Array<[string, string]>) : []),
          ]}
        />
      )}
      {t && <p className="px-5 text-xs text-muted-foreground">Cached values plugins keep with an expiry. WordPress deletes an expired one when it is read, or once a day.</p>}
      {t && (
        <div className="flex flex-wrap gap-2 px-5 py-4">
          <Button size="sm" variant="outline" disabled={busy || t.expired + (t.site?.expired ?? 0) === 0} onClick={() => onDelete('expired')}><Trash2 />Delete expired</Button>
          <Button size="sm" variant="outline" disabled={busy || t.count + (t.site?.count ?? 0) === 0} onClick={() => onDelete('all')}>Delete all...</Button>
        </div>
      )}
      {footer}
    </Card>
  );
}

const FIX_WORDS: Record<WpTableFix, { button: string; title: (t: string) => string; what: string }> = {
  keys: { button: 'Give it its key back', title: (t) => `Give ${t} its primary key back?`, what: 'MySQL rebuilds the table with its primary key and AUTO_INCREMENT, so new rows get their own ID again.' },
  index: { button: 'Add the indexes', title: (t) => `Add the missing indexes to ${t}?`, what: 'MySQL builds the indexes WordPress makes; the site keeps working meanwhile, and on a big table it takes a while.' },
  engine: { button: 'Turn into InnoDB', title: (t) => `Turn ${t} into InnoDB?`, what: 'MySQL rebuilds the table as InnoDB, as WordPress makes it; on a big table it takes a while.' },
  charset: { button: 'Turn into utf8mb4', title: (t) => `Turn ${t} into utf8mb4?`, what: 'Its text is converted to utf8mb4, which holds every character utf8 does and emoji too: nothing is lost.' },
};

/** A problem in a few words, for the table's row; the whole sentence shows when the row opens. */
const PROBLEM_LABEL: Record<WpDbHealthIssue['problem'], string> = {
  noPrimaryKey: 'lost key',
  noAutoIncrement: 'lost AUTO_INCREMENT',
  missingIndex: 'missing index',
  notUnique: 'repeated values',
  engine: 'MyISAM',
  utf8mb3: 'utf8',
  charset: 'old character set',
};

/**
 * The site's tables against how WordPress makes them, one row a table with
 * everything wrong with it: a lost primary key or AUTO_INCREMENT (a bad
 * import's mark), a missing index, an old character set in WordPress's
 * tables, MyISAM in any table of the site. Fix on a row fixes that table,
 * its opened row fixes one problem, Fix all every table; each fix is a job
 * that saves the table whole first. Space to give back is a line of its
 * own: upkeep, not a problem.
 */
function HealthCard({ view, busy, onFix, footer }: { view: View; busy: boolean; onFix: (ask: Ask) => void; footer: ReactNode }) {
  const h = view.report.health;
  const rows = h ? healthRows(h) : [];
  const { shown, more } = useShowAll('health', rows);
  const fixable = rows.filter((r) => r.fixes > 0);
  const waitsForYou = rows.length - fixable.length + rows.filter((r) => r.fixes > 0 && r.fixes < r.issues.length).length;

  /** One table: a single fix of WordPress's goes as itself (its own Undo), the rest as Fix all on that table. */
  function fixTable(r: HealthRow) {
    const issue = r.issues.find((i) => i.fix && !i.blocked);
    if (r.fixes === 1 && r.wordpress && issue) return fixOne(r, issue);
    onFix({
      slot: 'health',
      action: 'db.fixTables',
      input: { tables: [r.table] },
      title: `Fix ${r.table}?`,
      description: `${r.issues.filter((i) => i.fix && !i.blocked).map((i) => FIX_WORDS[i.fix as WpTableFix].what).join(' ')} ${r.table} is saved whole first (14 days), so Undo puts it back.`,
      button: r.fixes === 1 ? 'Fix it' : `Fix ${r.fixes}`,
    });
  }
  function fixOne(r: HealthRow, issue: WpDbHealthIssue) {
    const words = FIX_WORDS[issue.fix as WpTableFix];
    const description = `${words.what} ${r.table} is saved whole first (14 days), so Undo puts it back.`;
    // MyISAM in a plugin's or theme's table: only Fix all knows tables beyond WordPress's.
    if (!r.wordpress) return onFix({ slot: 'health', action: 'db.fixTables', input: { tables: [r.table] }, title: words.title(r.table), description, button: words.button });
    onFix({ slot: 'health', action: 'db.fixTable', input: { table: r.table, fix: issue.fix }, title: words.title(r.table), description, button: words.button });
  }

  return (
    <Card>
      <Header
        title="Table health"
        icon={ShieldCheck}
        reading={view.reading('health')}
        badge={rows.length > 0 ? <Badge tone={rows.some((r) => r.danger) ? 'danger' : 'warning'}>{rows.length === 1 ? '1 table to fix' : `${number(rows.length)} tables to fix`}</Badge> : undefined}
      />
      <SectionError text={view.errors.health} />
      {waiting(view, 'health') && <CardLinesSkeleton lines={3} />}
      {h && rows.length === 0 && (
        <p className="flex items-start gap-2 px-5 py-4 text-sm text-muted-foreground">
          <Badge tone="success" className="shrink-0">Healthy</Badge>
          {h.tables === 0 ? 'This site has no WordPress tables to check.' : `All ${h.tables} WordPress tables are as WordPress makes them: their keys, indexes, InnoDB and utf8mb4, and no table of the site is MyISAM.`}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y">
          {shown.map((r) => <HealthTableRow key={r.table} row={r} busy={busy} onFixTable={() => fixTable(r)} onFixOne={(issue) => fixOne(r, issue)} />)}
        </ul>
      )}
      {more}
      {fixable.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/40 px-5 py-3 text-sm">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {number(fixable.length)} tables in one job, the smallest first, each saved for Undo.{waitsForYou > 0 ? ` ${waitsForYou === 1 ? 'One problem needs' : `${number(waitsForYou)} problems need`} you first and ${waitsForYou === 1 ? 'is' : 'are'} left as ${waitsForYou === 1 ? 'it is' : 'they are'}.` : ''}
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onFix({
                slot: 'health',
                action: 'db.fixTables',
                input: {},
                title: `Fix ${number(fixable.length)} tables?`,
                description: `${fixable.slice(0, 12).map((r) => r.table).join(', ')}${fixable.length > 12 ? ` and ${number(fixable.length - 12)} more` : ''}: MySQL rebuilds them one at a time, the smallest first, and a table is busy while it is rebuilt. Only how they are made changes, not what they hold. Each is saved whole first (14 days), so Undo puts them back.${waitsForYou > 0 ? ' What needs you first is left as it is.' : ''}`,
                button: `Fix all ${number(fixable.length)}`,
              })
            }
          >
            <Wrench />Fix all {number(fixable.length)}
          </Button>
        </div>
      )}
      {h?.free && h.free.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-5 py-2.5 text-xs text-muted-foreground">
          <Gauge className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {bytes(h.free.reduce((n, f) => n + f.freeBytes, 0))} to give back to the disk, like after a clean-up: {h.free.map((f) => f.table).join(', ')}.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const total = h.free?.reduce((n, f) => n + f.freeBytes, 0) ?? 0;
              const tables = h.free?.map((f) => f.table) ?? [];
              onFix({
                slot: 'health',
                action: 'mysql.optimize',
                input: { database: view.report.database, tables },
                title: `Optimize ${tables.length === 1 ? tables[0] : `${tables.length} tables`}?`,
                description: `MySQL rebuilds ${tables.length === 1 ? 'it' : 'them'} one at a time, which gives about ${bytes(total)} back to the disk. Nothing in ${tables.length === 1 ? 'it' : 'them'} changes; a table is busy while it is rebuilt.`,
                button: 'Optimize',
              });
            }}
          >
            Optimize
          </Button>
        </div>
      )}
      {footer}
    </Card>
  );
}

/** A table's row: its problems in a few words and Fix; opened, each problem in full with its own fix. */
function HealthTableRow({ row: r, busy, onFixTable, onFixOne }: { row: HealthRow; busy: boolean; onFixTable: () => void; onFixOne: (issue: WpDbHealthIssue) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = r.danger ? CircleAlert : r.fixes ? TriangleAlert : Info;
  return (
    <li className="text-sm">
      <div className="flex items-center gap-3 px-5 py-2.5">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <Icon className={cn('size-4 shrink-0', r.danger ? 'text-danger' : r.fixes ? 'text-warning' : 'text-muted-foreground')} aria-hidden />
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="font-mono text-dense font-medium break-all">{r.table}</span>
            <span className="flex flex-wrap gap-1">
              {r.issues.map((i) => (
                <Badge key={i.problem} tone={i.fix && !i.blocked ? (KEYS.has(i.problem) ? 'danger' : 'warning') : 'neutral'}>
                  {PROBLEM_LABEL[i.problem]}{i.blocked ? ': yours first' : !i.fix ? ': check by hand' : ''}
                </Badge>
              ))}
              {!r.wordpress && <Badge>not WordPress&apos;s</Badge>}
            </span>
          </span>
        </button>
        {r.fixes > 0 ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onFixTable} className="shrink-0">
            <Wrench />{r.fixes === 1 ? 'Fix' : `Fix ${r.fixes}`}
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">For a person</span>
        )}
        {/* Last, in a column of its own, so every row's chevron lines up at the edge. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={open ? `Hide the problems of ${r.table}` : `Show the problems of ${r.table}`}
          onClick={() => setOpen((o) => !o)}
          className="-mr-1.5 size-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      </div>
      {open && (
        <div className="mx-5 mb-3 grid gap-3 rounded-md bg-muted/50 p-3">
          {r.issues.map((issue) => (
            <div key={issue.problem} className="grid gap-1.5">
              <p className="text-muted-foreground">{issue.text}.</p>
              {issue.blocked ? (
                <p className="text-xs text-warning">Not yet: {issue.blocked}. Sort those rows out first (Tables, or SQL), then check again.</p>
              ) : issue.fix ? (
                <div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onFixOne(issue)}>
                    <Wrench />{FIX_WORDS[issue.fix].button}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">The panel leaves this to a person.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

const KEYS = new Set<WpDbHealthIssue['problem']>(['noPrimaryKey', 'noAutoIncrement']);

/** The tables that grew most since the oldest size the panel noted: what keeps filling the disk. */
function GrowthCard({ view, onTable }: { view: View; onTable: OnTable }) {
  const g = view.report.growth;
  if (g === null) return null;
  return (
    <Card>
      <Header title="What grows" icon={TrendingUp} reading={view.reading('growth')} />
      <SectionError text={view.errors.growth} />
      {waiting(view, 'growth') && <CardLinesSkeleton lines={2} />}
      {g && g.days === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">The panel notes the tables' sizes each day this view opens: what grows shows from the next day on.</p>}
      {g && g.days > 0 && g.tables.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No table grew by more than 1 MB in the last {g.days === 1 ? 'day' : `${g.days} days`}.</p>}
      {g && g.tables.length > 0 && (
        <>
          <p className="px-5 pt-3 text-xs text-muted-foreground">Since {g.since}, {g.days === 1 ? 'a day' : `${g.days} days`} ago.</p>
          <ul className="mt-1 divide-y">
            {g.tables.map((t) => (
              <li key={t.table} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-5 py-2 text-dense">
                <button type="button" className="truncate text-left font-mono hover:underline" title={t.table} onClick={() => onTable(t.table)}>{t.table}</button>
                <span className="text-xs text-warning tabular-nums">+{bytes(t.grewBytes)}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{bytes(t.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

const PLUGIN_STATE: Record<WpPluginState, { label: string; tone: 'neutral' | 'warning' | 'primary' }> = {
  active: { label: 'plugin on', tone: 'neutral' },
  inactive: { label: 'plugin off', tone: 'primary' },
  missing: { label: 'plugin gone', tone: 'warning' },
  unknown: { label: 'not known', tone: 'neutral' },
};

/** Who a table likely belongs to, in a few words: the plugin, the theme or the must-use plugin, and how the panel knows. */
function ownerOf(t: WpDbPluginTable): string {
  if (!t.plugin) return t.unused ? "Nothing in this site's code names it" : 'No plugin known by this name';
  const what = t.kind === 'theme' ? `Theme ${t.plugin}` : t.kind === 'muPlugin' ? (t.plugin === 'must-use plugins' ? 'A must-use plugin' : `Must-use plugin ${t.plugin}`) : t.plugin;
  return t.by === 'code' ? `${what}, named in its code` : what;
}

/** Its badge: on, off or gone, said for a theme or a must-use plugin as it is for one. */
function stateOf(t: WpDbPluginTable): { label: string; tone: 'neutral' | 'warning' | 'primary' } {
  if (t.kind === 'muPlugin') return { label: 'always on', tone: 'neutral' };
  if (t.kind === 'theme') return t.state === 'active' ? { label: 'theme in use', tone: 'neutral' } : { label: 'theme not in use', tone: 'primary' };
  return PLUGIN_STATE[t.state];
}

/** What the Delete dialog says about why the table may go, or why to look first. */
function deleteWhy(t: WpDbPluginTable): string {
  if (t.kind === 'theme') return `Theme ${t.plugin} names it in its code and is not the theme in use: switching to it again may need this table.`;
  if (t.state === 'missing') return `${t.plugin} is not in the plugins folder any more, so this table is likely left over.`;
  if (t.state === 'inactive') return `${t.plugin} is off: turning it on again may need this table.`;
  return t.unused ? "Nothing in this site's themes, plugins or must-use plugins names it, so it is likely left over: look at it first." : 'No plugin the panel knows makes it: look at it first.';
}

/**
 * The tables and autoloaded options of plugins: each table with the plugin it
 * likely belongs to and whether that plugin is on, off or gone, and the
 * options a plugin that is off still loads on every page. Guesses by name,
 * said as guesses; a table of a plugin that is on is never offered to delete.
 */
function PluginsCard({ view, busy, onTable, onAsk, footer }: { view: View; busy: boolean; onTable: OnTable; onAsk: (ask: Ask) => void; footer: ReactNode }) {
  const p = view.report.plugins;
  const pt = view.report.postTypes;
  const groups = useShowAll('pluginOptions', p?.autoload ?? []);
  const tables = useShowAll('pluginTables', p?.tables ?? []);
  const types = useShowAll('postTypes', pt?.unregistered ?? []);
  const options = `${view.report.blogPrefix}options`;
  const posts = `${view.report.blogPrefix}posts`;
  const [open, setOpen] = useState<string | null>(null);
  const database = view.report.database;
  return (
    <Card>
      <Header title="What plugins and themes keep" icon={Puzzle} reading={view.reading('plugins') || view.reading('postTypes')} />
      <SectionError text={view.errors.plugins} />
      {waiting(view, 'plugins') && <CardLinesSkeleton lines={4} />}
      {p && p.autoload.length > 0 && (
        <div className="grid gap-2 border-b px-5 py-4">
          <p className="text-xs font-medium text-muted-foreground">Loaded on every page for plugins that are off or gone</p>
          <ul className="grid gap-2 text-sm">
            {groups.shown.map((g) => (
              <li key={g.plugin} className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.plugin}</span>
                  <Badge tone={PLUGIN_STATE[g.state].tone}>{PLUGIN_STATE[g.state].label}</Badge>
                  <span className="text-xs text-muted-foreground">{number(g.count)} {g.count === 1 ? 'option' : 'options'}, {bytes(g.bytes)}</span>
                  <Button size="xs" variant="soft" className="ml-auto" aria-expanded={open === g.plugin} onClick={() => setOpen(open === g.plugin ? null : g.plugin)}>
                    {open === g.plugin ? 'Hide' : 'Which'}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      onAsk({
                        slot: 'plugins',
                        action: 'db.autoloadOff',
                        input: { options: g.options },
                        title: `Stop loading ${g.count === 1 ? 'this option' : `${number(g.options.length)} options`} of ${g.plugin} on every page?`,
                        description: `They stay in ${view.report.blogPrefix}options, loaded only when something asks for them${g.state === 'inactive' ? '; turning the plugin on again works as before' : ''}. They are saved first (14 days), so Undo on the job, or under Changes you can undo, puts them back as they were.`,
                        button: 'Turn off autoload',
                      })
                    }
                  >
                    Turn off autoload
                  </Button>
                </div>
                {open === g.plugin && (
                  <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {g.options.map((o) => <NameLink key={o} name={o} title={`See ${o} in ${options}`} onOpen={() => onTable(options, eq('option_name', o))} />)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {groups.more && <div className="-mt-px border-b">{groups.more}</div>}
      {p && p.tables.length > 0 && (
        <>
          <p className="px-5 pt-3 text-xs text-muted-foreground">Tables that are not WordPress's own, with the plugin or theme each likely belongs to: by its name, or found in the site's code.</p>
          <ul className="mt-1 divide-y">
            {tables.shown.map((t) => (
              <li key={t.table} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-2 text-dense">
                <span className="min-w-0">
                  <span className="block truncate font-mono" title={t.table}>{t.table}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {ownerOf(t)}
                    {t.plugin && <Badge tone={stateOf(t).tone}>{stateOf(t).label}</Badge>}
                    <span className="tabular-nums">{bytes(t.bytes)}, about {number(t.rows)} rows</span>
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button size="xs" variant="soft" onClick={() => onTable(t.table)}>Browse</Button>
                  {t.state !== 'active' && (
                    <Button
                      size="xs"
                      variant="soft"
                      className="text-danger hover:text-danger"
                      disabled={busy}
                      onClick={() =>
                        onAsk({
                          slot: 'plugins',
                          action: 'mysql.dropTable',
                          input: { database, table: t.table },
                          title: `Delete ${t.table}?`,
                          description: `${deleteWhy(t)} It is saved whole first (14 days), so Undo makes it again.`,
                          button: 'Delete the table',
                          typed: t.table,
                        })
                      }
                    >
                      Delete...
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {tables.more}
        </>
      )}
      {p && p.tables.length === 0 && p.autoload.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No tables of plugins, and no plugin that is off still loads options on every page.</p>}
      <SectionError text={view.errors.postTypes} />
      {waiting(view, 'postTypes') && (
        <div className="border-t">
          <p className="px-5 pt-3 text-xs text-muted-foreground">Asking WP-CLI which post types the plugins and theme register...</p>
          <CardLinesSkeleton lines={2} />
        </div>
      )}
      {pt && pt.unregistered.length > 0 && (
        <div className="grid gap-1.5 border-t px-5 py-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Posts of types nothing registers now</p>
          <ul className="grid gap-1">
            {types.shown.map((t) => (
              <li key={t.type} className="flex items-center justify-between gap-3 text-dense">
                <NameLink name={t.type} title={`See the ${t.type} posts in ${posts}`} onOpen={() => onTable(posts, eq('post_type', t.type))} />
                <span className="tabular-nums text-muted-foreground">{number(t.count)}</span>
              </li>
            ))}
          </ul>
          {types.more && <div className="-mx-5">{types.more}</div>}
          <p className="text-xs text-muted-foreground">A plugin or theme that made them is off or gone, so WordPress no longer shows them. They are in {view.report.blogPrefix}posts with their meta.</p>
        </div>
      )}
      {footer}
    </Card>
  );
}

/** One kind a clean-up can take: its id, its name, how many there are, a word about it, and the table its rows show in. */
interface CleanRow {
  kind: string;
  label: string;
  count: number;
  hint?: string;
  /** The table and the label of its rows in the Tables view; none for a count the view cannot show. */
  rows?: { table: string; label: string; note?: string };
  /** Under the row while it is ticked: a choice for that kind, like how many revisions to keep. */
  extra?: ReactNode;
}

const WITH_POST = 'Deleting here takes only these rows: the clean-up also deletes their meta, terms and comments, as WordPress does.';
const WITH_COMMENT = 'Deleting here takes only these comments: the clean-up also deletes their meta.';
const ORPHANS = new Set<string>(WP_ORPHAN_KINDS);
/** Ticked from the start when there are any; login sessions are not, since deleting them signs everyone out. */
const NOT_TICKED = new Set(['sessionTokens']);

/**
 * What a clean-up would find, in four short groups (posts, comments, caches
 * and logs, what was left behind), the kinds with nothing to clean folded
 * into one line, each count opening its rows in the Tables view, and one
 * button that deletes every ticked kind as one job with one Undo.
 */
function CleanupCard({ view, target, busy, onClean, onScan, onTable, footer }: { view: View; target: Target; busy: boolean; onClean: (ask: Ask) => void; onScan: () => void; onTable: OnTable; footer: ReactNode }) {
  const { report, errors } = view;
  const c = report.content;
  const o = report.orphans;
  const d = report.duplicates;
  const scanning = view.reading('duplicates');
  // Revisions: all of them, or all but the newest few of each post.
  const [keep, setKeep] = useState<0 | (typeof WP_KEEP_REVISIONS)[number]>(0);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const seen = useRef(new Set<string>());
  const name = (n: string) => `${report.blogPrefix}${n}`;
  const revisions = keep ? `revisions past the newest ${keep} of each post` : 'revisions';

  const groups: Array<{ title: string; rows: CleanRow[]; loading?: boolean; error?: string | undefined }> = [
    {
      title: 'Posts',
      rows: c
        ? [
            {
              kind: 'revisions',
              label: keep ? `Revisions past the newest ${keep} of each post` : 'Revisions',
              count: keep ? (c.revisionsOver?.[keep] ?? 0) : c.revisions,
              rows: { table: name('posts'), label: revisions, note: WITH_POST },
              ...(c.revisionsOver && c.revisions > 0
                ? {
                    extra: (
                      <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        Keep
                        <Select value={keep} onChange={(e) => setKeep(Number(e.target.value) as typeof keep)} wrapClassName="w-full max-w-60 sm:w-60" className="h-7 py-0 text-xs">
                          <option value={0}>none, delete all</option>
                          {WP_KEEP_REVISIONS.map((n) => <option key={n} value={n}>the newest {n} of each post</option>)}
                        </Select>
                      </label>
                    ),
                  }
                : {}),
            },
            { kind: 'autoDrafts', label: 'Auto-drafts', count: c.autoDrafts, rows: { table: name('posts'), label: 'auto-drafts', note: WITH_POST } },
            { kind: 'trashedPosts', label: 'Posts in the trash', count: c.trashedPosts, rows: { table: name('posts'), label: 'posts in the trash', note: WITH_POST } },
          ]
        : [],
      loading: waiting(view, 'content'),
      error: errors.content,
    },
    {
      title: 'Comments',
      rows: c
        ? [
            { kind: 'spamComments', label: 'Spam comments', count: c.spamComments, rows: { table: name('comments'), label: 'spam comments', note: WITH_COMMENT } },
            { kind: 'trashedComments', label: 'Comments in the trash', count: c.trashedComments, rows: { table: name('comments'), label: 'comments in the trash', note: WITH_COMMENT } },
            ...(c.akismet !== undefined ? [{ kind: 'akismet', label: "Akismet's history on comments", count: c.akismet, rows: { table: name('commentmeta'), label: "Akismet's history" } }] : []),
          ]
        : [],
    },
    {
      title: 'Caches and logs',
      rows: c
        ? [
            ...(c.oembed !== undefined ? [{ kind: 'oembed', label: 'oEmbed caches', count: c.oembed, hint: 'WordPress makes them again when a page shows the embed', rows: { table: name('postmeta'), label: 'oEmbed caches' } }] : []),
            ...(c.actionsDone !== undefined
              ? [{ kind: 'actionsDone', label: 'Finished Action Scheduler actions', count: c.actionsDone, hint: c.actionLogs ? `Complete, failed and cancelled, with ${number(c.actionLogs)} log lines` : 'Complete, failed and cancelled', rows: { table: name('actionscheduler_actions'), label: 'finished actions', note: 'Deleting here takes only the actions: the clean-up also deletes their logs.' } }]
              : []),
            ...(c.wcSessions !== undefined ? [{ kind: 'wcSessions', label: 'Expired WooCommerce sessions', count: c.wcSessions, rows: { table: name('woocommerce_sessions'), label: 'expired sessions' } }] : []),
            ...(c.sessionTokens !== undefined ? [{ kind: 'sessionTokens', label: 'Saved login sessions', count: c.sessionTokens, hint: 'Everyone signs in again', rows: { table: `${report.prefix}usermeta`, label: 'saved login sessions' } }] : []),
            ...(d ? [{ kind: 'duplicateMeta', label: 'Repeated post meta', count: d.rows, hint: d.keys.length ? `Most under ${d.keys.slice(0, 3).map((k) => k.key || 'an empty key').join(', ')}; the first of each stays` : 'The first of each stays', rows: { table: name('postmeta'), label: 'repeats of the same key and value on a post', note: 'The first of each is not shown: it stays.' } }] : []),
          ]
        : [],
      error: errors.duplicates,
    },
    {
      title: 'Left behind by something deleted',
      rows: o
        ? [
            { kind: 'postmeta', label: 'Post meta without its post', count: o.postmeta, rows: { table: name('postmeta'), label: 'post meta without its post' } },
            { kind: 'commentmeta', label: 'Comment meta without its comment', count: o.commentmeta, rows: { table: name('commentmeta'), label: 'comment meta without its comment' } },
            { kind: 'termmeta', label: 'Term meta without its term', count: o.termmeta, rows: { table: name('termmeta'), label: 'term meta without its term' } },
            { kind: 'termRelationships', label: 'Terms on posts that are gone', count: o.termRelationships, rows: { table: name('term_relationships'), label: 'terms on posts that are gone' } },
            ...(o.usermeta !== undefined ? [{ kind: 'usermeta', label: 'User meta without its user', count: o.usermeta, rows: { table: `${report.prefix}usermeta`, label: 'user meta without its user' } }] : []),
          ]
        : [],
      loading: waiting(view, 'orphans'),
      error: errors.orphans,
    },
  ];
  const all = groups.flatMap((g) => g.rows);
  // The first few kinds with something to clean show, across the groups in order; the link says how many more are ticked, since Delete takes them too.
  const { shown: visible, more } = useShowAll(
    'cleanup',
    all.filter((r) => r.count > 0),
    (hidden) => {
      const n = hidden.filter((r) => ticked.has(r.kind)).length;
      return n ? `, ${n} more ticked` : '';
    },
  );
  const showing = new Set(visible.map((r) => r.kind));
  const cut = visible.length < all.filter((r) => r.count > 0).length;
  // Every kind with something to clean is ticked the first time it shows (but login sessions); the leftovers answer later than the rest.
  const found = all.filter((r) => r.count > 0).map((r) => r.kind).join(',');
  useEffect(() => {
    const fresh = found.split(',').filter((k) => k && !seen.current.has(k));
    if (!fresh.length) return;
    for (const k of fresh) seen.current.add(k);
    setTicked((t) => new Set([...t, ...fresh.filter((k) => !NOT_TICKED.has(k))]));
  }, [found]);
  const picked = all.filter((r) => ticked.has(r.kind) && r.count > 0);
  const total = picked.reduce((sum, r) => sum + r.count, 0);
  const nothing = all.filter((r) => r.count === 0);
  const toggle = (kind: string, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(kind);
    else next.delete(kind);
    return next;
  });

  function remove() {
    const kinds = picked.filter((r) => !ORPHANS.has(r.kind)).map((r) => r.kind);
    const orphans = picked.filter((r) => ORPHANS.has(r.kind)).map((r) => r.kind);
    const words = { ...CONTENT_WORDS, revisions };
    const left = orphans.length ? `${describe(orphans, ORPHAN_WORDS)} left behind by something deleted` : '';
    const what = kinds.length ? `${describe(kinds, words)}, with what WordPress deletes with them${left ? `; and ${left.charAt(0).toLowerCase()}${left.slice(1)}` : ''}` : left;
    onClean({
      slot: 'content',
      action: 'db.cleanContent',
      input: { kinds, orphans, ...(keep && kinds.includes('revisions') ? { keepRevisions: keep } : {}) },
      title: `Delete ${number(total)} ${total === 1 ? 'row' : 'rows'}?`,
      description: `${what}. ${SAVED}`,
      button: 'Delete them',
    });
  }

  const open = (r: CleanRow) => r.rows && onTable(r.rows.table, { cleanup: { ...target, kind: r.kind as DbCleanupView['kind'], ...(r.kind === 'revisions' && keep ? { keepRevisions: keep } : {}) }, label: r.rows.label, ...(r.rows.note ? { note: r.rows.note } : {}) });
  const unscanned = c && !d && c.oembed !== undefined;

  return (
    <Card>
      <Header title="What a clean-up would find" icon={Sparkles} reading={view.reading('content') || view.reading('orphans')} />
      {groups.map((g) => {
        const rows = g.rows.filter((r) => r.count > 0 && showing.has(r.kind));
        const scan = g.title === 'Caches and logs' && (unscanned || (c && !d)) && !cut;
        if (!rows.length && !g.loading && !g.error && !scan) return null;
        return (
          <section key={g.title} aria-label={g.title} className="grid gap-1.5 border-b px-5 py-3 last-of-type:border-b-0">
            <h3 className="text-xs font-medium text-muted-foreground">{g.title}</h3>
            {g.error && <p role="alert" className="text-sm text-danger">{g.error}</p>}
            {g.loading && <CardLinesSkeleton lines={g.title === 'Posts' ? 3 : 4} className="px-0 py-1" />}
            {rows.length > 0 && (
              <ul className="grid gap-1.5 text-sm">
                {rows.map((r) => (
                  <li key={r.kind} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1">
                    <input id={`clean-${r.kind}`} type="checkbox" className="mt-1" checked={ticked.has(r.kind)} onChange={(e) => toggle(r.kind, e.target.checked)} />
                    <label htmlFor={`clean-${r.kind}`} className="text-muted-foreground">
                      {r.label}
                      {r.hint && <span className="block text-xs text-muted-foreground/80">{r.hint}</span>}
                    </label>
                    {r.rows ? <CountLink n={r.count} title={`See the ${r.rows.label} in ${r.rows.table}`} onOpen={() => open(r)} /> : <span className="text-right tabular-nums">{number(r.count)}</span>}
                    {r.extra && ticked.has(r.kind) && <div className="col-start-2 col-end-4">{r.extra}</div>}
                  </li>
                ))}
              </ul>
            )}
            {scan && (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 text-sm">
                <input type="checkbox" className="invisible" aria-hidden tabIndex={-1} />
                <span className="text-muted-foreground">
                  Repeated post meta
                  <span className="block text-xs text-muted-foreground/80">Reads every value of postmeta, with up to two minutes</span>
                </span>
                <Button size="xs" variant="outline" disabled={scanning} onClick={onScan}>
                  {scanning ? <RefreshCw className="animate-spin" /> : <Search />}
                  {scanning ? 'Looking...' : 'Look for them'}
                </Button>
              </div>
            )}
          </section>
        );
      })}
      {more}
      {nothing.length > 0 && !cut && (
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          Nothing to clean: {nothing.map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1)).join(', ')}.
        </p>
      )}
      {(c || o) && (
        <div className="grid gap-2 border-t px-5 py-3">
          <p className="text-xs text-muted-foreground">A post goes with its meta, terms and comments, as WordPress deletes it. A count opens its rows in Tables.</p>
          <div>
            <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={remove}>
              <Trash2 />Delete the ticked{total > 0 ? ` (${number(total)})` : ''}
            </Button>
          </div>
        </div>
      )}
      {footer}
    </Card>
  );
}

const CONTENT_WORDS: Record<string, string> = {
  revisions: 'revisions',
  autoDrafts: 'auto-drafts',
  trashedPosts: 'posts in the trash',
  spamComments: 'spam comments',
  trashedComments: 'comments in the trash',
  oembed: 'oEmbed caches',
  akismet: "Akismet's history",
  actionsDone: 'finished Action Scheduler actions and their logs',
  wcSessions: 'expired WooCommerce sessions',
  sessionTokens: 'saved login sessions (everyone signs in again)',
  duplicateMeta: 'repeated post meta',
};
const ORPHAN_WORDS: Record<string, string> = { postmeta: 'post meta', commentmeta: 'comment meta', termmeta: 'term meta', termRelationships: 'terms on posts', usermeta: 'user meta' };

/** "Revisions, auto-drafts and spam comments". */
function describe(kinds: string[], words: Record<string, string>): string {
  const list = kinds.map((k) => words[k] ?? k);
  const text = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The custom fields (meta_key) that fill postmeta, to see what makes it big:
 * a page builder's data, an old plugin's leftovers. By size on a table up to
 * WP_META_SIZE_ROWS rows; on a bigger one by rows first, as a size needs every
 * value read, with Count sizes to read them anyway.
 */
function MetaKeysCard({ view, onTable, onSizes }: { view: View; onTable: OnTable; onSizes: () => void }) {
  const { report } = view;
  const m = report.metaKeys;
  const postmeta = `${report.blogPrefix}postmeta`;
  const { shown, more } = useShowAll('metaKeys', m?.keys ?? []);
  const reading = view.reading('metaKeys');
  return (
    <Card>
      <Header title="Post meta by key" icon={KeyRound} reading={reading} />
      <SectionError text={view.errors.metaKeys} />
      {waiting(view, 'metaKeys') && <CardLinesSkeleton lines={6} />}
      {m && (
        <p className="px-5 pt-3 text-xs text-muted-foreground">
          The custom fields with the most {m.sized ? 'bytes' : 'rows'} in {report.blogPrefix}postmeta{m.estimatedRows ? `, about ${number(m.estimatedRows)} rows in all` : ''}.
          {!m.sized && ' A size needs every value read, which takes a while on a table this big.'}
        </p>
      )}
      {m && m.keys.length > 0 && (
        <ul className="mt-2 divide-y">
          {shown.map((k) => (
            <li key={k.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-5 py-2 text-dense">
              <NameLink name={k.key || <span className="text-muted-foreground italic">empty key</span>} title={`See the rows of ${k.key || 'the empty key'} in ${postmeta}`} onOpen={() => onTable(postmeta, eq('meta_key', k.key))} />
              <span className="text-right text-xs text-muted-foreground tabular-nums">{k.bytes === undefined ? `${number(k.count)} rows` : `${bytes(k.bytes)} in ${number(k.count)} rows`}</span>
            </li>
          ))}
        </ul>
      )}
      {more}
      {m && m.keys.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No post meta.</p>}
      {(m || view.errors.metaKeys) && (
        <div className={cn('flex flex-wrap gap-2 px-5 py-3', more && 'border-t')}>
          {(!m?.sized || view.errors.metaKeys) && (
            <Button size="sm" variant="outline" disabled={reading} onClick={onSizes} title="Reads every value for its size, with up to a minute">
              {reading ? <RefreshCw className="animate-spin" /> : null}Count sizes
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onTable(postmeta)}>Browse {postmeta}</Button>
        </div>
      )}
    </Card>
  );
}

function UsersCard({ view }: { view: View }) {
  const { report } = view;
  const u = report.users;
  const { shown, more } = useShowAll('users', u?.list ?? []);
  return (
    <Card>
      <Header title="Users" icon={Users} reading={view.reading('users')} />
      <SectionError text={view.errors.users} />
      {waiting(view, 'users') && <CardLinesSkeleton lines={4} />}
      {u && (
        <>
          <p className={cn('px-5 pt-3 text-xs text-muted-foreground', u.list.length === 0 && 'pb-4')}>
            {number(u.count)} {u.count === 1 ? 'user' : 'users'}{report.network ? ' on the network, with their roles on this site' : ''}{u.count > u.list.length ? `, the first ${u.list.length} shown` : ''}.
          </p>
          <ul className="mt-2 divide-y">
            {shown.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-sm">
                <span className="font-medium">{user.login}</span>
                <span className="min-w-40 flex-1 truncate text-xs text-muted-foreground" title={user.email}>{user.email}</span>
                <span className="flex flex-wrap gap-1">
                  {user.roles.length ? user.roles.map((role) => <Badge key={role} tone={role === 'administrator' ? 'primary' : 'neutral'}>{role}</Badge>) : <span className="text-xs text-muted-foreground">no role here</span>}
                </span>
              </li>
            ))}
          </ul>
          {more}
        </>
      )}
    </Card>
  );
}


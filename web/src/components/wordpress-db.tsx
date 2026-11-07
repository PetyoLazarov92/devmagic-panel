import type { Site, WpDbBlog, WpDbReport, WpDbSection, WpPluginState, WpTableFix } from '@devmagic-panel/shared';
import { WP_DB_ON_DEMAND, WP_DB_SECTIONS, WP_DB_SLOW_SECTIONS, WP_KEEP_REVISIONS } from '@devmagic-panel/shared';
import { Gauge, Hourglass, KeyRound, type LucideIcon, Puzzle, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, TrendingUp, Users, Wrench } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CleanupsCard, ConfirmCleanup } from '@/components/cleanups';
import { JobFooter } from '@/components/job-box';
import { settled, useJob, useResumeJob } from '@/components/job-steps';
import { toastRowChange } from '@/components/row-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Bar, CardLinesSkeleton, CardSkeleton, Reading } from '@/components/skeletons';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Notice, ViewBar } from '@/components/page';

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
  /** Opens a table in the Tables view. */
  onTable: (table: string) => void;
}

type Slot = 'health' | 'plugins' | 'transients' | 'content' | 'orphans';
type Errors = WpDbReport['errors'];
/** The card each clean-up's job shows in. */
const SLOT_OF: Partial<Record<string, Slot>> = { 'db.fixTable': 'health', 'db.autoloadOff': 'plugins', 'db.cleanTransients': 'transients', 'db.cleanContent': 'content', 'db.cleanOrphans': 'orphans' };

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
      if (!s.report?.duplicates) return s;
      const { duplicates: _gone, ...rest } = s.report;
      return { ...s, report: rest };
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
type Ask = { slot: Slot; action: 'db.fixTable' | 'mysql.optimize' | 'mysql.dropTable' | 'db.autoloadOff' | 'db.cleanTransients' | 'db.cleanContent' | 'db.cleanOrphans'; input: Record<string, unknown>; title: string; description: string; button: string; typed?: string };

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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <AutoloadCard view={view} onTable={onTable} onAutoloadOff={(o) => void autoloadOff(o)} />
          <TransientsCard view={view} busy={busy} onDelete={(scope) => setAsking(transientsAsk(r, scope))} footer={footerFor('transients')} />
          <MetaKeysCard view={view} onTable={onTable} onSizes={report.readSizes} />
          <PluginsCard view={view} busy={busy} onTable={onTable} onAsk={setAsking} footer={footerFor('plugins')} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <HealthCard view={view} busy={busy} onFix={setAsking} footer={footerFor('health')} />
          <CleanupCard view={view} busy={busy} onClean={setAsking} onScan={report.readDuplicates} footer={footerFor('content', 'orphans')} />
          <UsersCard view={view} />
          <GrowthCard view={view} onTable={onTable} />
        </div>
      </div>
      <CleanupsCard database={r.database} site={siteKey} refresh={refresh} onUndone={() => report.reload()} />
      {asking && (
        <ConfirmCleanup title={asking.title} description={asking.description} action={asking.button} {...(asking.typed ? { typed: asking.typed } : {})} onClose={() => setAsking(null)} onConfirm={(confirm) => start(asking.typed ? { ...asking, input: { ...asking.input, confirm } } : asking)} />
      )}
    </div>
  );
}

/** What every card is given: the report so far, the errors by part, and which parts are still being read. */
interface View {
  report: WpDbReport;
  errors: Errors;
  reading: (section: WpDbSection) => boolean;
}

/** A card's header: its title, and its icon, turning while the card reads again. */
function Header({ title, icon: Icon, reading }: { title: string; icon: LucideIcon; reading: boolean }) {
  return (
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {reading ? <RefreshCw className="size-4 animate-spin text-muted-foreground" aria-label="Reading" /> : <Icon className="size-4 text-muted-foreground" />}
    </CardHeader>
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
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

function Facts({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
      {rows.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AutoloadCard({ view, onTable, onAutoloadOff }: { view: View; onTable: (t: string) => void; onAutoloadOff: (option: string) => void }) {
  const { report, errors } = view;
  const a = report.autoload;
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
                {a.top.map((o) => (
                  <li key={o.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 text-[13px]">
                    <span className="truncate font-mono" title={o.name}>{o.name}</span>
                    <span className="text-right text-xs text-muted-foreground tabular-nums">{bytes(o.bytes)}</span>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onAutoloadOff(o.name)} aria-label={`Stop loading ${o.name} on every page`} title="Load it only when a plugin asks for it">
                      Turn off
                    </Button>
                    <span className="col-span-3 h-1 rounded-full bg-muted" aria-hidden>
                      <span className="block h-full rounded-full bg-primary/50" style={{ width: `${Math.max(1, (o.bytes / biggest) * 100)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="px-5 pb-4">
            <Button size="sm" variant="outline" onClick={() => onTable(`${report.blogPrefix}options`)}>Browse {report.blogPrefix}options</Button>
          </div>
        </>
      )}
      {a === null && !errors.autoload && <p className="px-5 py-4 text-sm text-muted-foreground">This site has no options table.</p>}
    </Card>
  );
}

function TransientsCard({ view, busy, onDelete, footer }: { view: View; busy: boolean; onDelete: (scope: 'expired' | 'all') => void; footer: ReactNode }) {
  const { report } = view;
  const t = report.transients;
  return (
    <Card>
      <Header title="Transients" icon={Hourglass} reading={view.reading('transients')} />
      <SectionError text={view.errors.transients} />
      {waiting(view, 'transients') && <CardLinesSkeleton lines={3} />}
      {t && (
        <Facts
          rows={[
            ['Transients', `${number(t.count)} (${bytes(t.bytes)})`],
            ['Expired, still stored', number(t.expired)],
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

/**
 * The site's WordPress tables against how WordPress makes them: a lost primary
 * key or AUTO_INCREMENT (a bad import's mark), a missing index, MyISAM, an old
 * character set. Each fix is a job that saves the table whole first.
 */
function HealthCard({ view, busy, onFix, footer }: { view: View; busy: boolean; onFix: (ask: Ask) => void; footer: ReactNode }) {
  const h = view.report.health;
  const byTable = new Map<string, NonNullable<typeof h>['issues']>();
  for (const issue of h?.issues ?? []) byTable.set(issue.table, [...(byTable.get(issue.table) ?? []), issue]);
  return (
    <Card>
      <Header title="Table health" icon={ShieldCheck} reading={view.reading('health')} />
      <SectionError text={view.errors.health} />
      {waiting(view, 'health') && <CardLinesSkeleton lines={3} />}
      {h && h.issues.length === 0 && (
        <p className="flex items-start gap-2 px-5 py-4 text-sm text-muted-foreground">
          <Badge tone="success" className="shrink-0">Healthy</Badge>
          {h.tables === 0 ? 'This site has no WordPress tables to check.' : `All ${h.tables} WordPress tables are as WordPress makes them: their keys, indexes, InnoDB and utf8mb4.`}
        </p>
      )}
      {h && h.issues.length > 0 && (
        <ul className="divide-y">
          {[...byTable.entries()].map(([table, issues]) => (
            <li key={table} className="grid gap-2 px-5 py-3 text-sm">
              <span className="font-mono text-[13px] font-medium">{table}</span>
              {issues.map((issue) => (
                <div key={issue.problem} className="grid gap-1.5">
                  <p className="text-muted-foreground">{issue.text}.</p>
                  {issue.blocked ? (
                    <p className="text-xs text-warning">Not yet: {issue.blocked}. Sort those rows out first (Tables, or SQL), then check again.</p>
                  ) : issue.fix ? (
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const words = FIX_WORDS[issue.fix as WpTableFix];
                          onFix({ slot: 'health', action: 'db.fixTable', input: { table, fix: issue.fix }, title: words.title(table), description: `${words.what} ${table} is saved whole first (14 days), so Undo puts it back.`, button: words.button });
                        }}
                      >
                        <Wrench />{FIX_WORDS[issue.fix].button}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">The panel leaves this to a person.</p>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {h?.free && h.free.length > 0 && (
        <div className="grid gap-2 border-t px-5 py-3 text-sm">
          <p className="text-muted-foreground">
            Space a rebuild gives back to the disk, like after a clean-up: {h.free.map((f) => `${f.table} ${bytes(f.freeBytes)}`).join(', ')}.
          </p>
          <div>
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
              <Gauge />Optimize {h.free.length === 1 ? h.free[0]?.table : `${h.free.length} tables`}
            </Button>
          </div>
        </div>
      )}
      {footer}
    </Card>
  );
}

/** The tables that grew most since the oldest size the panel noted: what keeps filling the disk. */
function GrowthCard({ view, onTable }: { view: View; onTable: (t: string) => void }) {
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
              <li key={t.table} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-5 py-2 text-[13px]">
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

/**
 * The tables and autoloaded options of plugins: each table with the plugin it
 * likely belongs to and whether that plugin is on, off or gone, and the
 * options a plugin that is off still loads on every page. Guesses by name,
 * said as guesses; a table of a plugin that is on is never offered to delete.
 */
function PluginsCard({ view, busy, onTable, onAsk, footer }: { view: View; busy: boolean; onTable: (t: string) => void; onAsk: (ask: Ask) => void; footer: ReactNode }) {
  const p = view.report.plugins;
  const pt = view.report.postTypes;
  const [open, setOpen] = useState<string | null>(null);
  const database = view.report.database;
  return (
    <Card>
      <Header title="What plugins keep" icon={Puzzle} reading={view.reading('plugins') || view.reading('postTypes')} />
      <SectionError text={view.errors.plugins} />
      {waiting(view, 'plugins') && <CardLinesSkeleton lines={4} />}
      {p && p.autoload.length > 0 && (
        <div className="grid gap-2 border-b px-5 py-4">
          <p className="text-xs font-medium text-muted-foreground">Loaded on every page for plugins that are off or gone</p>
          <ul className="grid gap-2 text-sm">
            {p.autoload.map((g) => (
              <li key={g.plugin} className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.plugin}</span>
                  <Badge tone={PLUGIN_STATE[g.state].tone}>{PLUGIN_STATE[g.state].label}</Badge>
                  <span className="text-xs text-muted-foreground">{number(g.count)} {g.count === 1 ? 'option' : 'options'}, {bytes(g.bytes)}</span>
                  <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" aria-expanded={open === g.plugin} onClick={() => setOpen(open === g.plugin ? null : g.plugin)}>
                    {open === g.plugin ? 'Hide' : 'Which'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
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
                {open === g.plugin && <p className="font-mono text-xs break-words text-muted-foreground">{g.options.join(', ')}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p && p.tables.length > 0 && (
        <>
          <p className="px-5 pt-3 text-xs text-muted-foreground">Tables that are not WordPress's own, with the plugin each likely belongs to, by its name.</p>
          <ul className="mt-1 divide-y">
            {p.tables.map((t) => (
              <li key={t.table} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-2 text-[13px]">
                <span className="min-w-0">
                  <span className="block truncate font-mono" title={t.table}>{t.table}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {t.plugin ?? 'No plugin known by this name'}
                    <Badge tone={PLUGIN_STATE[t.state].tone}>{PLUGIN_STATE[t.state].label}</Badge>
                    <span className="tabular-nums">{bytes(t.bytes)}, about {number(t.rows)} rows</span>
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onTable(t.table)}>Browse</Button>
                  {t.state !== 'active' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-danger hover:text-danger"
                      disabled={busy}
                      onClick={() =>
                        onAsk({
                          slot: 'plugins',
                          action: 'mysql.dropTable',
                          input: { database, table: t.table },
                          title: `Delete ${t.table}?`,
                          description: `${t.state === 'missing' ? `${t.plugin} is not in the plugins folder any more, so this table is likely left over.` : t.state === 'inactive' ? `${t.plugin} is off: turning it on again may need this table.` : 'No plugin the panel knows makes it: look at it first.'} It is saved whole first (14 days), so Undo makes it again.`,
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
            {pt.unregistered.map((t) => (
              <li key={t.type} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="truncate font-mono" title={t.type}>{t.type}</span>
                <span className="tabular-nums text-muted-foreground">{number(t.count)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">A plugin or theme that made them is off or gone, so WordPress no longer shows them. They are in {view.report.blogPrefix}posts with their meta.</p>
        </div>
      )}
      {footer}
    </Card>
  );
}

function CleanupCard({ view, busy, onClean, onScan, footer }: { view: View; busy: boolean; onClean: (ask: Ask) => void; onScan: () => void; footer: ReactNode }) {
  const { report, errors } = view;
  const c = report.content;
  const o = report.orphans;
  const d = report.duplicates;
  // Revisions: all of them, or all but the newest few of each post.
  const [keep, setKeep] = useState<0 | (typeof WP_KEEP_REVISIONS)[number]>(0);
  const scanning = view.reading('duplicates');
  const rows: TickRow[] = c
    ? [
        ['revisions', keep ? `Revisions past the newest ${keep} of each post` : 'Revisions', keep ? (c.revisionsOver?.[keep] ?? 0) : c.revisions],
        ['autoDrafts', 'Auto-drafts', c.autoDrafts],
        ['trashedPosts', 'Posts in the trash', c.trashedPosts],
        ['spamComments', 'Spam comments', c.spamComments],
        ['trashedComments', 'Comments in the trash', c.trashedComments],
        ...(c.oembed !== undefined ? [['oembed', 'oEmbed caches', c.oembed, 'WordPress makes them again when a page shows the embed'] as TickRow] : []),
        ...(c.akismet !== undefined ? [['akismet', "Akismet's history on comments", c.akismet] as TickRow] : []),
        ...(c.actionsDone !== undefined ? [['actionsDone', 'Finished Action Scheduler actions', c.actionsDone, c.actionLogs ? `Complete, failed and cancelled, with ${number(c.actionLogs)} log lines` : 'Complete, failed and cancelled'] as TickRow] : []),
        ...(c.wcSessions !== undefined ? [['wcSessions', 'Expired WooCommerce sessions', c.wcSessions] as TickRow] : []),
        ...(c.sessionTokens !== undefined ? [['sessionTokens', 'Saved login sessions', c.sessionTokens, 'Everyone signs in again'] as TickRow] : []),
        ...(d ? [['duplicateMeta', 'Repeated post meta', d.rows, d.keys.length ? `Most under ${d.keys.slice(0, 3).map((k) => k.key || 'an empty key').join(', ')}; the first of each stays` : 'The first of each stays'] as TickRow] : []),
      ]
    : [];
  return (
    <Card>
      <Header title="What a clean-up would find" icon={Sparkles} reading={view.reading('content') || view.reading('orphans')} />
      <SectionError text={errors.content} />
      {waiting(view, 'content') && <CardLinesSkeleton lines={5} />}
      {c && (
        <TickList
          id="content"
          rows={rows}
          off={['sessionTokens']}
          busy={busy}
          note="A post goes with its meta, terms and comments, as WordPress deletes it."
          onDelete={(kinds, total) => {
            const keeping = keep && kinds.includes('revisions') ? { keepRevisions: keep } : {};
            const words = { ...CONTENT_WORDS, ...(keep ? { revisions: `revisions past the newest ${keep} of each post` } : {}) };
            onClean({ slot: 'content', action: 'db.cleanContent', input: { kinds, ...keeping }, title: `Delete ${number(total)} ${total === 1 ? 'item' : 'items'}?`, description: `${describe(kinds, words)}, with what WordPress deletes with them. ${SAVED}`, button: 'Delete them' });
          }}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {c.revisionsOver && c.revisions > 0 && (
              <label className="flex flex-wrap items-center gap-2">
                <span>Revisions:</span>
                <Select value={keep} onChange={(e) => setKeep(Number(e.target.value) as typeof keep)} wrapClassName="w-auto" className="h-8 w-auto text-xs">
                  <option value={0}>delete all</option>
                  {WP_KEEP_REVISIONS.map((n) => <option key={n} value={n}>keep the newest {n} of each post</option>)}
                </Select>
              </label>
            )}
            {!d && (
              <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={scanning} onClick={onScan} title="Reads every value of postmeta, with up to two minutes">
                {scanning ? <RefreshCw className="animate-spin" /> : <Search />}
                {scanning ? 'Looking for repeated post meta...' : 'Look for repeated post meta'}
              </Button>
            )}
          </div>
          <SectionError text={errors.duplicates} />
        </TickList>
      )}
      <SectionError text={errors.orphans} />
      {waiting(view, 'orphans') && (
        <div className="border-t">
          <p className="px-5 pt-3 text-xs text-muted-foreground">Looking for meta and terms left behind by something deleted...</p>
          <CardLinesSkeleton lines={4} />
        </div>
      )}
      {o && (
        <>
          <p className="border-t px-5 pt-3 text-xs font-medium text-muted-foreground">Left behind by something deleted</p>
          <TickList
            id="orphans"
            rows={[
              ['postmeta', 'Post meta without its post', o.postmeta],
              ['commentmeta', 'Comment meta without its comment', o.commentmeta],
              ['termmeta', 'Term meta without its term', o.termmeta],
              ['termRelationships', 'Terms on posts that are gone', o.termRelationships],
              ...(o.usermeta !== undefined ? ([['usermeta', 'User meta without its user', o.usermeta]] as Array<[string, string, number]>) : []),
            ]}
            busy={busy}
            onDelete={(kinds, total) =>
              onClean({ slot: 'orphans', action: 'db.cleanOrphans', input: { kinds }, title: `Delete ${number(total)} ${total === 1 ? 'row' : 'rows'} left behind?`, description: `${describe(kinds, ORPHAN_WORDS)}. ${SAVED}`, button: 'Delete them' })
            }
          />
        </>
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

/** One kind a clean-up can take: its id, its name, how many there are, and a word about it. */
type TickRow = [kind: string, label: string, count: number, hint?: string];

/**
 * Counts with a tick each, the ones above 0 ticked (but those in off, like
 * login sessions, which sign everyone out), something to pick for a kind
 * (children), and a button that deletes the ticked.
 */
function TickList({ id, rows, busy, note, off = [], children, onDelete }: { id: string; rows: TickRow[]; busy: boolean; note?: string; off?: string[]; children?: ReactNode; onDelete: (kinds: string[], total: number) => void }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.filter(([k, , n]) => n > 0 && !off.includes(k)).map(([k]) => k)));
  const picked = rows.filter(([k, , n]) => ticked.has(k) && n > 0);
  const total = picked.reduce((sum, [, , n]) => sum + n, 0);
  return (
    <div className="grid gap-3 px-5 py-4">
      <ul className="grid gap-1.5 text-sm">
        {rows.map(([kind, label, n, hint]) => (
          <li key={kind}>
            <label htmlFor={`${id}-${kind}`} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2', n === 0 && 'text-muted-foreground')}>
              <input
                id={`${id}-${kind}`}
                type="checkbox"
                className="mt-1"
                disabled={n === 0}
                checked={ticked.has(kind) && n > 0}
                onChange={(e) => setTicked((t) => {
                  const next = new Set(t);
                  if (e.target.checked) next.add(kind);
                  else next.delete(kind);
                  return next;
                })}
              />
              <span className={n > 0 ? 'text-muted-foreground' : ''}>
                {label}
                {hint && <span className="block text-xs text-muted-foreground/80">{hint}</span>}
              </span>
              <span className="text-right tabular-nums">{number(n)}</span>
            </label>
          </li>
        ))}
      </ul>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div>
        <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={() => onDelete(picked.map(([k]) => k), total)}>
          <Trash2 />Delete the ticked{total > 0 ? ` (${number(total)})` : ''}
        </Button>
      </div>
    </div>
  );
}

/**
 * The custom fields (meta_key) that fill postmeta, to see what makes it big:
 * a page builder's data, an old plugin's leftovers. By size on a table up to
 * WP_META_SIZE_ROWS rows; on a bigger one by rows first, as a size needs every
 * value read, with Count sizes to read them anyway.
 */
function MetaKeysCard({ view, onTable, onSizes }: { view: View; onTable: (t: string) => void; onSizes: () => void }) {
  const { report } = view;
  const m = report.metaKeys;
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
          {m.keys.map((k) => (
            <li key={k.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-5 py-2 text-[13px]">
              <span className="truncate font-mono" title={k.key}>{k.key || <span className="text-muted-foreground italic">empty key</span>}</span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">{k.bytes === undefined ? `${number(k.count)} rows` : `${bytes(k.bytes)} in ${number(k.count)} rows`}</span>
            </li>
          ))}
        </ul>
      )}
      {m && m.keys.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No post meta.</p>}
      {(m || view.errors.metaKeys) && (
        <div className="flex flex-wrap gap-2 px-5 py-3">
          {(!m?.sized || view.errors.metaKeys) && (
            <Button size="sm" variant="outline" disabled={reading} onClick={onSizes} title="Reads every value for its size, with up to a minute">
              {reading ? <RefreshCw className="animate-spin" /> : null}Count sizes
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onTable(`${report.blogPrefix}postmeta`)}>Browse {report.blogPrefix}postmeta</Button>
        </div>
      )}
    </Card>
  );
}

function UsersCard({ view }: { view: View }) {
  const { report } = view;
  const u = report.users;
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
            {u.list.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-sm">
                <span className="font-medium">{user.login}</span>
                <span className="min-w-40 flex-1 truncate text-xs text-muted-foreground" title={user.email}>{user.email}</span>
                <span className="flex flex-wrap gap-1">
                  {user.roles.length ? user.roles.map((role) => <Badge key={role} tone={role === 'administrator' ? 'primary' : 'neutral'}>{role}</Badge>) : <span className="text-xs text-muted-foreground">no role here</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

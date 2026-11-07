import type { Site, WpDbReport } from '@devmagic-panel/shared';
import { Gauge, Hourglass, KeyRound, RefreshCw, Sparkles, Trash2, Users } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CleanupsCard, ConfirmCleanup } from '@/components/cleanups';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { toastRowChange } from '@/components/row-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { api } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const number = (n: number) => n.toLocaleString('en-US');

interface Props {
  site: Pick<Site, 'domain' | 'path'>;
  /** The site of a network the view is about; 1 for a single site. */
  blog: number;
  onBlog: (blog: number) => void;
  /** Opens a table in the Tables view. */
  onTable: (table: string) => void;
}

type Slot = 'transients' | 'content' | 'orphans';
type Ask = { slot: Slot; action: 'db.cleanTransients' | 'db.cleanContent' | 'db.cleanOrphans'; input: Record<string, unknown>; title: string; description: string; button: string };

/**
 * A WordPress database as WordPress sees it: autoloaded options against Site
 * Health's limit, with autoload switched off for a big one; transients; what
 * a clean-up would find, deleted in a job that saves it first; the postmeta
 * keys that take the most room and the users with their roles.
 */
export function WordpressDbView({ site, blog, onBlog, onTable }: Props) {
  const report = useAsync(() => api.wordpressDb(site.domain, site.path, blog), [site.domain, site.path, blog]);
  const runner = useJob();
  const [slot, setSlot] = useState<Slot | null>(null);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [refresh, setRefresh] = useState(0);
  const siteKey = `${site.domain}${site.path ?? ''}`;
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
      toastRowChange(`${option} no longer loads on every page`, report.data?.database ?? '', `${report.data?.blogPrefix ?? 'wp_'}options`, r.data?.backup, () => report.reload());
      report.reload();
    } catch (error) {
      toast({ tone: 'danger', title: 'Autoload not changed', detail: (error as Error).message });
    }
  }

  const jobFor = (s: Slot) => (slot === s && job ? <JobBox job={job} onRetry={() => void runner.retry()} /> : null);
  const r = report.data;
  if (report.loading && !r) return <div className="h-64 animate-pulse rounded-xl border bg-card" />;
  if (report.error && !r) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{report.error}</p>;
  if (!r) return null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {r.network && (
          <label className="grid w-full gap-1 text-sm sm:flex sm:w-auto sm:items-center sm:gap-2">
            <span className="shrink-0 text-muted-foreground">Site of the network</span>
            <Select value={blog} onChange={(e) => onBlog(Number(e.target.value))} wrapClassName="w-full sm:w-80" className="h-9">
              {r.network.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.domain}{b.path} ({b.prefix}){b.inactive ? ', archived or deleted' : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={report.reload} disabled={report.loading}>
          <RefreshCw className={cn(report.loading && 'animate-spin')} />Read again
        </Button>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Tables starting <span className="font-mono">{r.blogPrefix}</span> in <span className="font-mono">{r.database}</span>, read {timeAgo(r.checkedAt)}. Each clean-up saves what it removes first, so Undo puts it back for 14 days.
      </p>
      {r.missingTables.length > 0 && (
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          Tables WordPress makes that this database lacks: <span className="font-mono">{r.missingTables.join(', ')}</span>. Older WordPress versions had no termmeta table.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <AutoloadCard report={r} onTable={onTable} onAutoloadOff={(o) => void autoloadOff(o)} />
          <TransientsCard report={r} busy={busy} onDelete={(scope) => setAsking(transientsAsk(r, scope))} />
          {jobFor('transients')}
          <MetaKeysCard report={r} onTable={onTable} />
        </div>
        <div className="grid content-start gap-4">
          <CleanupCard report={r} busy={busy} onClean={setAsking} />
          {jobFor('content')}
          {jobFor('orphans')}
          {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
          <CleanupsCard database={r.database} site={siteKey} refresh={refresh} onUndone={() => report.reload()} />
          <UsersCard report={r} />
        </div>
      </div>
      {asking && (
        <ConfirmCleanup title={asking.title} description={asking.description} action={asking.button} onClose={() => setAsking(null)} onConfirm={() => start(asking)} />
      )}
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

function AutoloadCard({ report, onTable, onAutoloadOff }: { report: WpDbReport; onTable: (t: string) => void; onAutoloadOff: (option: string) => void }) {
  const a = report.autoload;
  const over = a ? a.bytes > a.limitBytes : false;
  const biggest = a?.top[0]?.bytes ?? 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Autoloaded options</CardTitle>
        <Gauge className="size-4 text-muted-foreground" />
      </CardHeader>
      <SectionError text={report.errors.autoload} />
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
      {!a && !report.errors.autoload && <p className="px-5 py-4 text-sm text-muted-foreground">This site has no options table.</p>}
    </Card>
  );
}

function TransientsCard({ report, busy, onDelete }: { report: WpDbReport; busy: boolean; onDelete: (scope: 'expired' | 'all') => void }) {
  const t = report.transients;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transients</CardTitle>
        <Hourglass className="size-4 text-muted-foreground" />
      </CardHeader>
      <SectionError text={report.errors.transients} />
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
    </Card>
  );
}

function CleanupCard({ report, busy, onClean }: { report: WpDbReport; busy: boolean; onClean: (ask: Ask) => void }) {
  const c = report.content;
  const o = report.orphans;
  return (
    <Card>
      <CardHeader>
        <CardTitle>What a clean-up would find</CardTitle>
        <Sparkles className="size-4 text-muted-foreground" />
      </CardHeader>
      <SectionError text={report.errors.content} />
      {c && (
        <TickList
          id="content"
          rows={[
            ['revisions', 'Revisions', c.revisions],
            ['autoDrafts', 'Auto-drafts', c.autoDrafts],
            ['trashedPosts', 'Posts in the trash', c.trashedPosts],
            ['spamComments', 'Spam comments', c.spamComments],
            ['trashedComments', 'Comments in the trash', c.trashedComments],
          ]}
          busy={busy}
          note="A post goes with its meta, terms and comments, as WordPress deletes it."
          onDelete={(kinds, total) =>
            onClean({ slot: 'content', action: 'db.cleanContent', input: { kinds }, title: `Delete ${number(total)} ${total === 1 ? 'item' : 'items'}?`, description: `${describe(kinds, CONTENT_WORDS)}, with what WordPress deletes with them. ${SAVED}`, button: 'Delete them' })
          }
        />
      )}
      <SectionError text={report.errors.orphans} />
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
    </Card>
  );
}

const CONTENT_WORDS: Record<string, string> = { revisions: 'revisions', autoDrafts: 'auto-drafts', trashedPosts: 'posts in the trash', spamComments: 'spam comments', trashedComments: 'comments in the trash' };
const ORPHAN_WORDS: Record<string, string> = { postmeta: 'post meta', commentmeta: 'comment meta', termmeta: 'term meta', termRelationships: 'terms on posts', usermeta: 'user meta' };

/** "Revisions, auto-drafts and spam comments". */
function describe(kinds: string[], words: Record<string, string>): string {
  const list = kinds.map((k) => words[k] ?? k);
  const text = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Counts with a tick each, the ones above 0 ticked, and a button that deletes the ticked. */
function TickList({ id, rows, busy, note, onDelete }: { id: string; rows: Array<[string, string, number]>; busy: boolean; note?: string; onDelete: (kinds: string[], total: number) => void }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.filter(([, , n]) => n > 0).map(([k]) => k)));
  const picked = rows.filter(([k, , n]) => ticked.has(k) && n > 0);
  const total = picked.reduce((sum, [, , n]) => sum + n, 0);
  return (
    <div className="grid gap-3 px-5 py-4">
      <ul className="grid gap-1.5 text-sm">
        {rows.map(([kind, label, n]) => (
          <li key={kind}>
            <label htmlFor={`${id}-${kind}`} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2', n === 0 && 'text-muted-foreground')}>
              <input
                id={`${id}-${kind}`}
                type="checkbox"
                disabled={n === 0}
                checked={ticked.has(kind) && n > 0}
                onChange={(e) => setTicked((t) => {
                  const next = new Set(t);
                  if (e.target.checked) next.add(kind);
                  else next.delete(kind);
                  return next;
                })}
              />
              <span className={n > 0 ? 'text-muted-foreground' : ''}>{label}</span>
              <span className="text-right tabular-nums">{number(n)}</span>
            </label>
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div>
        <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={() => onDelete(picked.map(([k]) => k), total)}>
          <Trash2 />Delete the ticked{total > 0 ? ` (${number(total)})` : ''}
        </Button>
      </div>
    </div>
  );
}

function MetaKeysCard({ report, onTable }: { report: WpDbReport; onTable: (t: string) => void }) {
  const keys = report.metaKeys;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Post meta by key</CardTitle>
        <KeyRound className="size-4 text-muted-foreground" />
      </CardHeader>
      <SectionError text={report.errors.metaKeys} />
      {keys && keys.length > 0 && (
        <ul className="divide-y">
          {keys.map((k) => (
            <li key={k.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-5 py-2 text-[13px]">
              <span className="truncate font-mono" title={k.key}>{k.key || <span className="text-muted-foreground italic">empty key</span>}</span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">{bytes(k.bytes)} in {number(k.count)} rows</span>
            </li>
          ))}
        </ul>
      )}
      {keys && keys.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No post meta.</p>}
      {keys && (
        <div className="px-5 py-3">
          <Button size="sm" variant="outline" onClick={() => onTable(`${report.blogPrefix}postmeta`)}>Browse {report.blogPrefix}postmeta</Button>
        </div>
      )}
    </Card>
  );
}

function UsersCard({ report }: { report: WpDbReport }) {
  const u = report.users;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <Users className="size-4 text-muted-foreground" />
      </CardHeader>
      <SectionError text={report.errors.users} />
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

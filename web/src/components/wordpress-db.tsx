import type { Site, WpDbReport } from '@devmagic-panel/shared';
import { Gauge, Hourglass, KeyRound, RefreshCw, Sparkles, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { api } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
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

/**
 * A WordPress database as WordPress sees it, read only: autoloaded options
 * against Site Health's limit, transients, what a clean-up would find, the
 * postmeta keys that take the most room and the users with their roles.
 */
export function WordpressDbView({ site, blog, onBlog, onTable }: Props) {
  const report = useAsync(() => api.wordpressDb(site.domain, site.path, blog), [site.domain, site.path, blog]);
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
        <Button size="sm" variant="ghost" className="ml-auto" onClick={report.reload} disabled={report.loading}>
          <RefreshCw className={cn(report.loading && 'animate-spin')} />Read again
        </Button>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Tables starting <span className="font-mono">{r.blogPrefix}</span> in <span className="font-mono">{r.database}</span>, read {timeAgo(r.checkedAt)}. Nothing here changes the database.
      </p>
      {r.missingTables.length > 0 && (
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          Tables WordPress makes that this database lacks: <span className="font-mono">{r.missingTables.join(', ')}</span>. Older WordPress versions had no termmeta table.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <AutoloadCard report={r} onTable={onTable} />
          <TransientsCard report={r} />
          <MetaKeysCard report={r} onTable={onTable} />
        </div>
        <div className="grid content-start gap-4">
          <CleanupCard report={r} />
          <UsersCard report={r} />
        </div>
      </div>
    </div>
  );
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

function AutoloadCard({ report, onTable }: { report: WpDbReport; onTable: (t: string) => void }) {
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
                  <li key={o.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-[13px]">
                    <span className="truncate font-mono" title={o.name}>{o.name}</span>
                    <span className="text-right text-xs text-muted-foreground tabular-nums">{bytes(o.bytes)}</span>
                    <span className="col-span-2 h-1 rounded-full bg-muted" aria-hidden>
                      <span className="block h-full rounded-full bg-primary/50" style={{ width: `${Math.max(1, (o.bytes / biggest) * 100)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="px-5 pb-4">
            <Button size="sm" variant="ghost" onClick={() => onTable(`${report.blogPrefix}options`)}>Browse {report.blogPrefix}options</Button>
          </div>
        </>
      )}
      {!a && !report.errors.autoload && <p className="px-5 py-4 text-sm text-muted-foreground">This site has no options table.</p>}
    </Card>
  );
}

function TransientsCard({ report }: { report: WpDbReport }) {
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
      {t && <p className="px-5 pb-4 text-xs text-muted-foreground">Cached values plugins keep with an expiry. WordPress deletes an expired one when it is read, or once a day.</p>}
    </Card>
  );
}

function CleanupCard({ report }: { report: WpDbReport }) {
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
        <Facts
          rows={[
            ['Revisions', number(c.revisions)],
            ['Auto-drafts', number(c.autoDrafts)],
            ['Posts in the trash', number(c.trashedPosts)],
            ['Spam comments', number(c.spamComments)],
            ['Comments in the trash', number(c.trashedComments)],
          ]}
        />
      )}
      <SectionError text={report.errors.orphans} />
      {o && (
        <>
          <p className="border-t px-5 pt-3 text-xs font-medium text-muted-foreground">Left behind by something deleted</p>
          <Facts
            rows={[
              ['Post meta without its post', number(o.postmeta)],
              ['Comment meta without its comment', number(o.commentmeta)],
              ['Term meta without its term', number(o.termmeta)],
              ['Terms on posts that are gone', number(o.termRelationships)],
              ...(o.usermeta !== undefined ? ([['User meta without its user', number(o.usermeta)]] as Array<[string, string]>) : []),
            ]}
          />
        </>
      )}
    </Card>
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
          <Button size="sm" variant="ghost" onClick={() => onTable(`${report.blogPrefix}postmeta`)}>Browse {report.blogPrefix}postmeta</Button>
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
          <p className="px-5 pt-3 text-xs text-muted-foreground">
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

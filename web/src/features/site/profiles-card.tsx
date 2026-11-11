import type { PhpXdebug, ProfileInfo, Site } from '@devmagic-panel/shared';
import { PROFILE_KEEP_DAYS } from '@devmagic-panel/shared';
import { ChevronDown, Download, ExternalLink, Flame, Gauge, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, Notice, ViewBar } from '@/components/layout/page';
import { ScopeLabel } from '@/components/layout/scope-label';
import { siteUrl } from '@/components/layout/site-bits';
import { ReadingBlock } from '@/components/layout/skeletons';
import { ms } from '@/features/site/slow-queries';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TextLink } from '@/components/ui/text-link';
import { api, profileUrl } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { runRestarting } from '@/lib/restarting';
import { lastLine } from '@/lib/site-actions';
import { siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

/**
 * Xdebug's profiles of one site: turn profiling on for the PHP version the
 * site runs (trigger only, so one request at a time), profile a page, and
 * read where its time went, by plugin and by function.
 */
export function ProfilesCard({ site, version, xdebug, onXdebug }: { site: Site; version: string | undefined; xdebug: PhpXdebug | undefined; onXdebug: () => void }) {
  const target = siteTarget(site);
  const list = useAsync(() => api.profiles(target.domain, target.path), [site.domain, site.path]);
  const [page, setPage] = useState('/');
  const [asking, setAsking] = useState(false);
  const [turning, setTurning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const profiles = list.data?.profiles ?? [];
  // After Open and profile: read again every few seconds until the new profile is there, for up to a minute.
  const [waitingSince, setWaitingSince] = useState<{ at: number; count: number } | null>(null);
  const waiting = waitingSince !== null;
  // The newest reload, without making the effects below again on every render.
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;
  useEffect(() => {
    if (!waitingSince) return;
    if (profiles.length > waitingSince.count || Date.now() - waitingSince.at > 60_000) return void setWaitingSince(null);
    const timer = window.setTimeout(() => reloadRef.current(), 3000);
    return () => window.clearTimeout(timer);
  }, [waitingSince, profiles.length, list.data]);
  // Back from the page you profiled in another tab: what it wrote shows without a click.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && reloadRef.current();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  const toPanel = version !== undefined && (list.data?.versions ?? []).includes(version);
  const on = Boolean(xdebug?.enabled && xdebug.modes?.includes('profile') && toPanel);

  async function turnOn() {
    if (!version || !xdebug) return;
    setTurning(true);
    const modes = [...new Set([...(xdebug.enabled ? (xdebug.modes ?? []) : []), 'profile'])];
    await runRestarting('php.setXdebug', { version, enabled: true, modes, startWithRequest: 'trigger' }, `Profiling on for PHP ${version}`, () => {
      setTurning(false);
      setAsking(false);
      onXdebug();
      list.reload();
    });
  }

  function profilePage() {
    const base = siteUrl(site.domain, site.path).replace(/\/$/, '');
    const path = page.startsWith('/') ? page : `/${page}`;
    const url = `${base}${path}${path.includes('?') ? '&' : '?'}XDEBUG_PROFILE=1`;
    window.open(url, '_blank', 'noopener');
    setWaitingSince({ at: Date.now(), count: profiles.length });
    toast({ tone: 'info', title: 'Profiling the page', detail: 'It shows here on its own once the page has loaded.' });
  }

  async function remove(items: ProfileInfo[]) {
    setDeleting(true);
    try {
      const r = await api.runAction('profile.delete', { profiles: items.map((p) => ({ version: p.version, name: p.name })) });
      if (!r.ok) toast({ tone: 'danger', title: 'Could not delete', detail: lastLine(r.output) });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not delete', detail: (error as Error).message });
    } finally {
      setDeleting(false);
      list.reload();
    }
  }

  return (
    <Card>
      <CardHeader
        title="Profiles"
        meta={
          <span className="flex items-center gap-2">
            <ScopeLabel>{on || !version ? 'this site' : `PHP ${version}`}</ScopeLabel>
            <Flame className="size-4 text-muted-foreground" />
          </span>
        }
      />
      <CardBody>
        {/* Check again in the bar at the top, as Top queries has it: there before the first profile too. */}
        <ViewBar onCheck={list.reload} loading={list.loading || waiting}>
          <p className="min-w-0 flex-1 text-muted-foreground">
            Xdebug&apos;s profiler times every function PHP runs for one request, so you see which plugin, theme or query loop the time went to. Profiles are deleted after {PROFILE_KEEP_DAYS} days.
          </p>
        </ViewBar>
        {list.error && <Notice>{list.error}</Notice>}
        {!version ? null : !xdebug?.installed ? (
          <Notice tone="warning" action={<TextLink href={`/services/php/${version}`}>PHP {version}</TextLink>}>
            Xdebug is not installed for PHP {version}. {xdebug?.reason ?? ''}
          </Notice>
        ) : !on ? (
          <div className="grid gap-3 rounded-md border bg-muted/40 p-3">
            <p>
              {xdebug.enabled && xdebug.modes?.includes('profile')
                ? `Xdebug profiles on PHP ${version}, but to a folder the panel cannot read. Turning it on again here sends them to the panel's folder.`
                : `Profiling is off for PHP ${version}. Turning it on adds Xdebug's profile mode for every site on PHP ${version}${xdebug.enabled ? `, next to ${(xdebug.modes ?? []).join(' and ')}` : ''}, and only for a request that asks for it, so pages stay as fast as they are.`}
            </p>
            {asking ? (
              <div className="grid gap-2">
                <p className="font-medium">Turn on profiling for PHP {version}?</p>
                <p className="text-muted-foreground">Apache or PHP-FPM restarts, so sites stop answering for a moment. Turn it off again on PHP {version}&apos;s page.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="soft" onClick={() => setAsking(false)}>Cancel</Button>
                  <Button size="sm" disabled={turning} onClick={() => void turnOn()}>
                    {turning && <Spinner />}
                    Turn on profiling
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setAsking(true)}>
                <Gauge />
                Turn on profiling
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-2">
            <label htmlFor={`profile-page-${site.domain}`} className="font-medium">Profile a page</label>
            <div className="flex flex-wrap gap-2">
              <Input id={`profile-page-${site.domain}`} value={page} onChange={(e) => setPage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && profilePage()} className="min-w-48 flex-1 font-mono text-dense" placeholder="/shop/" />
              <Button variant="outline" className="h-10" onClick={profilePage}>
                <ExternalLink />
                Open and profile
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Opens the page with XDEBUG_PROFILE=1, so only that request is profiled. For AJAX and REST calls, the Xdebug Helper browser extension sets the same trigger.
            </p>
          </div>
        )}

        {list.loading && !list.data ? (
          <ReadingBlock lines={3}>Reading the profiles</ReadingBlock>
        ) : profiles.length === 0 ? (
          on ? <EmptyState icon={Gauge} title="No profiles yet">Profile a page and it shows here.</EmptyState> : null
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{profiles.length} profile{profiles.length === 1 ? '' : 's'}</p>
              <Button size="sm" variant="soft" className="ml-auto" disabled={deleting} onClick={() => void remove(profiles)}>
                {deleting ? <Spinner /> : <Trash2 />}
                Delete all
              </Button>
            </div>
            <div className="divide-y rounded-md border">
              {profiles.map((p) => (
                <ProfileRow key={`${p.version}/${p.name}`} profile={p} open={open === p.name} onToggle={() => setOpen((o) => (o === p.name ? null : p.name))} onDelete={() => void remove([p])} busy={deleting} />
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** The request as people read it: without the trigger Open and profile adds, and / for the home page. */
export function shownRequest(request: string): string {
  const bare = request.replace(/_*XDEBUG_PROFILE(=[^_]*)?$/, '').replace(/_+$/, '');
  return bare === '' || bare === '/' ? '/' : bare;
}

function ProfileRow({ profile: p, open, onToggle, onDelete, busy }: { profile: ProfileInfo; open: boolean; onToggle: () => void; onDelete: () => void; busy: boolean }) {
  return (
    <div className="grid">
      <button type="button" className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left" aria-expanded={open} onClick={onToggle}>
        <code className="min-w-0 flex-1 truncate font-mono text-dense" title={p.request || '/'}>{shownRequest(p.request)}</code>
        {p.totalMs !== undefined && <Badge tone={p.totalMs >= 1000 ? 'warning' : 'neutral'}>{ms(p.totalMs)}</Badge>}
        <span className="text-xs text-muted-foreground">{timeAgo(p.at)}, {bytes(p.bytes)}</span>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="border-t bg-muted/30 px-3 py-3">
          <ProfileView profile={p} />
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink size="sm" variant="outline" href={profileUrl(p.version, p.name)} download>
              <Download />
              Download for KCachegrind or your IDE
            </ButtonLink>
            <Button size="sm" variant="soft" disabled={busy} onClick={onDelete}>
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where one request's time went: by plugin and theme, then the heaviest functions. */
function ProfileView({ profile }: { profile: ProfileInfo }) {
  const summary = useAsync(() => api.profile(profile.version, profile.name), [profile.version, profile.name]);
  const [shown, setShown] = useState<string | null>(null);
  if (summary.error) return <Notice>{summary.error}</Notice>;
  const s = summary.data;
  if (!s) return <ReadingBlock lines={4}>Reading the profile, {bytes(profile.bytes)}</ReadingBlock>;
  const top = s.groups[0]?.selfMs ?? 0;
  return (
    <div className="grid gap-4 text-sm">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{ms(s.totalMs)}</span> in all{s.peakBytes ? `, ${bytes(s.peakBytes)} of memory at most` : ''}, {s.functionCount.toLocaleString('en')} functions. Profiling makes PHP several times slower: compare the parts, not the total with a page load.
      </p>
      <div className="grid gap-1.5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Time by plugin and theme</p>
        {s.groups.slice(0, 8).map((g) => (
          <div key={g.group} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
            <span className="truncate">{g.group}</span>
            <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-primary/70" style={{ width: `${top ? Math.max(1, (g.selfMs / top) * 100) : 0}%` }} />
            </span>
            <span className="text-right tabular-nums">{ms(g.selfMs)}</span>
          </div>
        ))}
        <p className="text-2xs text-muted-foreground">PHP&apos;s built-in functions count with the code that calls them most.</p>
      </div>
      <div className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Slowest functions, by their own time</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="w-1/2 py-1 pr-2 font-medium">Function</th>
                <th className="py-1 pr-2 font-medium">Part of</th>
                <th className="py-1 pr-2 text-right font-medium">Calls</th>
                <th className="py-1 pr-2 text-right font-medium">Own time</th>
                <th className="py-1 text-right font-medium">With calls</th>
              </tr>
            </thead>
            <tbody>
              {s.functions.slice(0, 25).map((f) => (
                <FunctionRow key={`${f.file}:${f.name}`} fn={f} open={shown === `${f.file}:${f.name}`} onToggle={() => setShown((x) => (x === `${f.file}:${f.name}` ? null : `${f.file}:${f.name}`))} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FunctionRow({ fn: f, open, onToggle }: { fn: { name: string; file: string; group: string; calls: number; selfMs: number; totalMs: number; callers: Array<{ name: string; calls: number }> }; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-t hover:bg-muted/50" onClick={onToggle} aria-expanded={open}>
        <td className="max-w-0 py-1.5 pr-2"><code className="block truncate font-mono">{f.name}</code></td>
        <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">{f.group}</td>
        <td className="py-1.5 pr-2 text-right tabular-nums">{f.calls.toLocaleString('en')}</td>
        <td className="py-1.5 pr-2 text-right font-medium tabular-nums">{ms(f.selfMs)}</td>
        <td className="py-1.5 text-right tabular-nums">{ms(f.totalMs)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="pb-2">
            <div className="grid gap-1 rounded-md bg-muted/60 p-2 text-2xs">
              <code className="font-mono break-all text-muted-foreground">{f.file}</code>
              {f.callers.length > 0 && (
                <p>
                  Called by{' '}
                  {f.callers.map((c, i) => (
                    <span key={c.name}>
                      {i > 0 && ', '}
                      <code className="font-mono">{c.name}</code> ({c.calls.toLocaleString('en')}x)
                    </span>
                  ))}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

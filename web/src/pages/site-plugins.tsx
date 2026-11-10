import type { Site, SitePlugin, SitePlugins, SiteThemes } from '@devmagic-panel/shared';
import { MissingPluginsCard } from '@/components/missing-plugins-card';
import { Lock, Palette, Plug, RefreshCw, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { pluginFolderHref, themeFolderHref } from '@/lib/file-links';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { pluginMatches } from '@/lib/plugin-search';
import { lastLine } from '@/lib/site-actions';
import { siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'on' | 'off' | 'updates' | 'always';

const isOn = (p: SitePlugin) => p.status === 'active' || p.status === 'active-network';
const always = (p: SitePlugin) => p.status === 'must-use' || p.status === 'dropin';

const FILTERS: Array<{ value: Filter; label: string; test: (p: SitePlugin) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'on', label: 'On', test: isOn },
  { value: 'off', label: 'Off', test: (p) => p.status === 'inactive' },
  { value: 'updates', label: 'Updates', test: (p) => Boolean(p.update) },
  { value: 'always', label: 'Always on', test: always },
];

/** The list each site showed last, so opening the tab again shows it at once while WP-CLI reads it anew. */
const lastLists = new Map<string, SitePlugins>();

/** The tab's shape while WP-CLI reads the plugins for the first time: the count, the search and a few rows. */
function PluginsSkeleton() {
  const bar = 'animate-pulse rounded bg-muted';
  return (
    <div className="grid gap-3" aria-busy="true">
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <RefreshCw className="size-3.5 animate-spin" />
        Reading the plugins with WP-CLI...
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn(bar, 'h-9 min-w-52 flex-1 rounded-md')} />
        {[14, 12, 12].map((w, i) => <div key={i} className={cn(bar, 'h-7 rounded-full')} style={{ width: `${w * 4}px` }} />)}
      </div>
      <div className={cn(bar, 'h-11 rounded-xl')} />
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {[56, 40, 64, 48, 36, 52].map((w, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <div className={cn(bar, 'h-5 w-9 rounded-full')} />
            <div className="grid flex-1 gap-1.5">
              <div className={bar} style={{ width: `${w}%`, height: '0.875rem' }} />
              <div className={bar} style={{ width: `${w / 2}%`, height: '0.75rem' }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type View = 'plugins' | 'themes';

/**
 * A site's plugins and themes, in two views kept in the address (view=themes),
 * as the Database tab keeps its own. Each view has its list and, under its
 * head, the row for what the database names and the files lack.
 */
export function PluginsTab({ site }: { site: Site }) {
  const view: View = useQueryParam('view') === 'themes' ? 'themes' : 'plugins';
  const go = (next: View) => navigate(`${siteHref(site)}?tab=plugins${next === 'themes' ? '&view=themes' : ''}`, { scroll: false });
  return (
    <div className="grid gap-3">
      <Segmented label="Plugins and themes" value={view} onChange={go} options={[['plugins', 'Plugins'], ['themes', 'Themes']]} className="justify-self-start" />
      {view === 'themes' ? <ThemesView site={site} /> : <PluginsView site={site} />}
    </div>
  );
}

const lastThemes = new Map<string, SiteThemes>();

/** A site's themes, read only: which one is on, the parent a child theme needs, and where each folder is. */
function ThemesView({ site }: { site: Site }) {
  const key = `${site.domain}${site.path ?? ''}`;
  const { data: fresh, error, loading, reload } = useAsync(() => api.themes(site.domain, site.path).then((list) => (lastThemes.set(key, list), list)), [site.domain, site.path]);
  const data = fresh ?? lastThemes.get(key);
  if (error && !data) {
    return (
      <div className="rounded-xl border bg-card px-5 py-4 text-sm">
        <p role="alert" className="text-danger">{error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={reload}><RefreshCw />Try again</Button>
      </div>
    );
  }
  const bar = 'animate-pulse rounded bg-muted';
  if (!data) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><RefreshCw className="size-3.5 animate-spin" />Reading the themes with WP-CLI...</p>
        <div className={cn(bar, 'h-11 rounded-xl')} />
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {[40, 56, 48].map((w, i) => <li key={i} className="grid gap-2 px-4 py-3"><div className={cn(bar, 'h-4')} style={{ width: `${w * 4}px` }} /><div className={cn(bar, 'h-3 w-64 max-w-full')} /></li>)}
        </ul>
      </div>
    );
  }
  const active = data.themes.find((t) => t.status === 'active');
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.themes.length}</span> theme{data.themes.length === 1 ? '' : 's'}
          {active ? <>, <span className="font-medium text-foreground">{active.title}</span> is on</> : ', none of them is on'}
          {data.network && ' on the main site; each site of a network has its own'}
        </p>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}><RefreshCw className={cn(loading && 'animate-spin')} />Reload</Button>
      </div>
      <MissingPluginsCard site={site} show="themes" onChanged={reload} />
      {data.themes.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-10 text-center text-sm">
          <Palette className="size-6 text-muted-foreground" />
          <p className="text-muted-foreground">This site has no themes.</p>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {data.themes.map((t) => (
            <li key={t.folder} className="px-4 py-2.5">
              <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium', t.status === 'inactive' && 'text-muted-foreground')}>
                <span className="break-words">{t.title}</span>
                {t.status === 'active' && <Badge tone="success">On</Badge>}
                {t.status === 'parent' && <Badge tone="primary">Parent of the theme that is on</Badge>}
                {t.inRepo && <Badge>In its repo</Badge>}
              </p>
              <p className="mt-0.5 text-xs break-words text-muted-foreground">
                <span className="font-mono">{t.folder}</span>
                {t.version && <> · {t.version}</>}
                {t.update && <span className="text-warning"> · {t.update} available</span>}
                {t.inRepo && ' · found through Local mode'}
                {' · '}<Link href={themeFolderHref(site, t)} className="font-medium text-primary hover:underline" aria-label={`Open the folder of ${t.title}`}>Open folder</Link>
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">The theme is switched in wp-admin, under Appearance: the panel only lists them.</p>
    </div>
  );
}

/**
 * A site's plugins, each with a switch that turns it on or off at once, as its
 * link in wp-admin does. Undo in the toast turns it back. Turning off one that
 * other active plugins need asks first.
 */
function PluginsView({ site }: { site: Site }) {
  const key = `${site.domain}${site.path ?? ''}`;
  const { data: fresh, error, loading, reload } = useAsync(
    () => api.plugins(site.domain, site.path).then((list) => (lastLists.set(key, list), list)),
    [site.domain, site.path],
  );
  const data = fresh ?? lastLists.get(key);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<SitePlugin | null>(null);

  async function set(plugin: SitePlugin, active: boolean, undo = false) {
    setBusy(plugin.name);
    try {
      const r = await api.runAction('site.pluginSet', { ...siteTarget(site), plugin: plugin.name, active });
      const label = `${plugin.title} turned ${active ? 'on' : 'off'}`;
      toast(
        r.ok
          ? { tone: 'success', title: label, ...(undo ? {} : { action: { label: 'Undo', run: () => void set(plugin, !active, true) } }) }
          : { tone: 'danger', title: `${plugin.title} could not be turned ${active ? 'on' : 'off'}`, detail: lastLine(r.output) },
      );
    } catch (e) {
      toast({ tone: 'danger', title: `${plugin.title} could not be turned ${active ? 'on' : 'off'}`, detail: (e as Error).message });
    } finally {
      setBusy(null);
      reload();
    }
  }

  function toggle(plugin: SitePlugin, active: boolean) {
    if (!active && plugin.requiredBy?.length) setAsking(plugin);
    else void set(plugin, active);
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border bg-card px-5 py-4 text-sm">
        <p role="alert" className="text-danger">{error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={reload}><RefreshCw />Try again</Button>
      </div>
    );
  }
  if (!data) return <PluginsSkeleton />;

  const plugins = data.plugins;
  const count = (f: (typeof FILTERS)[number]) => plugins.filter(f.test).length;
  const test = FILTERS.find((f) => f.value === filter)?.test ?? (() => true);
  // Must-use plugins and drop-ins last, as wp-admin keeps them on tabs of their own.
  const shown = plugins.filter((p) => test(p) && (pluginMatches(p.name, query) || pluginMatches(p.title, query))).sort((a, b) => Number(always(a)) - Number(always(b)));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{plugins.filter(isOn).length} of {plugins.filter((p) => !always(p)).length}</span> plugins on
          {data.network && ', turned on network-wide'}
        </p>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}><RefreshCw className={cn(loading && 'animate-spin')} />Reload</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Find a plugin"
            aria-label="Find a plugin"
            spellCheck={false}
            autoComplete="off"
            className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear the search" onClick={() => setQuery('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {FILTERS.filter((f) => f.value === 'all' || count(f) > 0).map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
            >
              {f.label} <span className="tabular-nums">{count(f)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Under the search and filters, one row that keeps its height while it checks: the list below never moves. */}
      <MissingPluginsCard site={site} show="plugins" onChanged={reload} />

      {shown.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-10 text-center text-sm">
          <Plug className="size-6 text-muted-foreground" />
          <p className="text-muted-foreground">{plugins.length === 0 ? 'This site has no plugins.' : 'No plugin matches.'}</p>
          {(query || filter !== 'all') && plugins.length > 0 && (
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setQuery(''); setFilter('all'); }}>Show every plugin</button>
          )}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {shown.map((p) => (
            <li key={`${p.status}-${p.name}`} className="flex items-center gap-3 px-4 py-2.5">
              {always(p) ? (
                <span className="flex w-9 shrink-0 justify-center" title={p.status === 'dropin' ? 'Drop-in: WordPress always loads it' : 'Must-use: WordPress always loads it'}>
                  <Lock className="size-4 text-muted-foreground" aria-label="Always on" />
                </span>
              ) : (
                <Switch checked={isOn(p)} onChange={(v) => toggle(p, v)} label={`Turn ${p.title} ${isOn(p) ? 'off' : 'on'}`} disabled={busy !== null} />
              )}
              <div className="min-w-0 flex-1">
                <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium', !isOn(p) && !always(p) && 'text-muted-foreground')}>
                  <span className="break-words">{p.title}</span>
                  {p.productionOnly && <Badge tone="warning">Turned off at install</Badge>}
                  {p.localHelper && <Badge tone="success">Local helper</Badge>}
                  {p.status === 'active-network' && <Badge tone="primary">Network</Badge>}
                  {busy === p.name && <RefreshCw className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
                </p>
                <p className="mt-0.5 text-xs break-words text-muted-foreground">
                  <span className="font-mono">{p.name}</span>
                  {p.version && <> · {p.version}</>}
                  {p.update && <span className="text-warning"> · {p.update} available</span>}
                  {p.status === 'must-use' && ' · must-use, always on'}
                  {p.status === 'dropin' && ' · drop-in, always on'}
                  {p.requires && <> · needs {p.requires.join(', ')}</>}
                  {p.requiredBy && <> · needed by {p.requiredBy.join(', ')}</>}
                  {p.path && <> · <Link href={pluginFolderHref(site, p)} className="font-medium text-primary hover:underline" aria-label={p.oneFile ? `Open the file of ${p.title}` : `Open the folder of ${p.title}`}>{p.oneFile ? 'Open file' : 'Open folder'}</Link></>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={`Turn off ${asking?.title ?? ''}?`}
        description={asking ? `${asking.requiredBy?.join(', ')} ${asking.requiredBy?.length === 1 ? 'needs' : 'need'} it, and may stop working or show errors while it is off.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAsking(null)}>Keep it on</Button>
          <Button
            variant="danger"
            onClick={() => {
              const plugin = asking;
              setAsking(null);
              if (plugin) void set(plugin, false);
            }}
          >
            Turn it off
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

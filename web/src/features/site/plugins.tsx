import { Tabs } from '@/components/ui/tabs';
import { CheckAgain } from '@/components/layout/page';
import type { Site, SitePlugin, SitePlugins, SiteThemes, VulnerabilityState } from '@devmagic-panel/shared';
import { MissingPluginsCard } from '@/features/site/missing-plugins-card';
import { JobFooter } from '@/features/jobs/job-box';
import { type DetailsTarget, PluginDetailsDialog } from '@/features/site/plugin-details';
import { settled, useJob } from '@/features/jobs/job-steps';
import { Checkbox } from '@/components/ui/field';
import { ArrowUpCircle, Info, Lock, Palette, Plug, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { FilterChips } from '@/components/ui/filter-chips';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { EmptyState, Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { pluginFolderHref, themeFolderHref } from '@/lib/file-links';
import { navigate, useQueryParam } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { Switch } from '@/components/ui/switch';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { pluginMatches } from '@/lib/plugin-search';
import { lastLine } from '@/lib/site-actions';
import { siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { compareVersions } from '@/lib/version-compare';

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
      <Card className="overflow-hidden">
        <ul className="divide-y">
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
      </Card>
    </div>
  );
}

type View = 'plugins' | 'themes';

/** A plugin the panel updates: a folder in wp-content/plugins with an update WordPress found; never must-use, a drop-in or one file. */
const canUpdate = (p: SitePlugin) => Boolean(p.update) && !always(p) && !p.oneFile;

/**
 * Updates of a site's plugins or themes, as a job: one Update to on each row, Update all above
 * the list, and a snapshot of the database first unless you untick it. The job's steps show
 * under the bar, Undo puts the versions from before back, and the list reads again once it ends.
 */
function useUpdates(site: Site, kind: 'plugins' | 'themes', onDone: () => void) {
  const job = useJob();
  const [snapshot, setSnapshot] = useState(true);
  const running = job.job !== null && !settled(job.job);
  const status = job.job?.status;
  useEffect(() => {
    if (status && status !== 'running' && status !== 'queued' && status !== 'undoing') onDone();
  }, [status]);
  const start = (names: string[]) => void job.follow(api.startJob('site.updatePlugins', { ...siteTarget(site), plugins: kind === 'plugins' ? names : [], themes: kind === 'themes' ? names : [], snapshot }));
  return { job, snapshot, setSnapshot, running, start };
}

function UpdatesBar({ kind, names, updates }: { kind: 'plugins' | 'themes'; names: string[]; updates: ReturnType<typeof useUpdates> }) {
  if (names.length === 0 && !updates.job.job && !updates.job.error) return null;
  const noun = kind === 'plugins' ? 'plugin' : 'theme';
  // Drawn like the missing row above it: its icon in amber while there is something to do, the count in bold, then what it means.
  return (
    <Card role="region" className="overflow-hidden text-sm" aria-label={`Updates of ${kind}`}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <span className="flex min-w-0 flex-[1_1_18rem] items-center gap-2.5">
          <ArrowUpCircle className={cn('size-4 shrink-0', names.length > 0 ? 'text-warning' : 'text-muted-foreground')} />
          <span className="min-w-0">
            <span className="font-medium">{names.length === 0 ? `Every ${noun} is up to date` : `${names.length} ${noun}${names.length === 1 ? ' has' : 's have'} an update`}</span>
            {names.length > 0 && <span className="text-muted-foreground">: found by WordPress; each folder is kept first, so Undo puts the version from before back</span>}
          </span>
        </span>
        {names.length > 0 && (
          <>
            <Checkbox id={`${kind}-update-snapshot`} checked={updates.snapshot} onChange={updates.setSnapshot} disabled={updates.running} label="Snapshot the database first" />
            <Button size="sm" disabled={updates.running} onClick={() => updates.start(names)}>
              <ArrowUpCircle />
              {names.length === 1 ? 'Update it' : `Update all ${names.length}`}
            </Button>
          </>
        )}
      </div>
      <JobFooter job={updates.job.job} error={updates.job.error} onRetry={() => void updates.job.retry()} />
    </Card>
  );
}

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
      <Tabs className="lg:hidden" size="sm" label="Plugins and themes" value={view} onChange={go} items={[{ value: 'plugins', label: 'Plugins' }, { value: 'themes', label: 'Themes' }]} />
      {view === 'themes' ? <ThemesView site={site} /> : <PluginsView site={site} />}
    </div>
  );
}

const lastThemes = new Map<string, SiteThemes>();

/** A site's themes, read only: which one is on, the parent a child theme needs, and where each folder is. */
function ThemesView({ site }: { site: Site }) {
  const key = `${site.domain}${site.path ?? ''}`;
  // Check again also asks WordPress.org for updates; other reads take what WordPress last found.
  const asking = useRef(false);
  const { data: fresh, error, loading, reload } = useAsync(() => {
    const check = asking.current;
    asking.current = false;
    return api.themes(site.domain, site.path, check).then((list) => (lastThemes.set(key, list), list));
  }, [site.domain, site.path]);
  const checkAgain = () => {
    asking.current = true;
    reload();
  };
  const data = fresh ?? lastThemes.get(key);
  const vulnerable = useVulnerabilities(site);
  // As on Plugins: Details adds what each theme says it is and who made it; it starts compact every time.
  const [details, setDetails] = useState(false);
  const updates = useUpdates(site, 'themes', reload);
  const [viewing, setViewing] = useState<DetailsTarget | null>(null);
  if (error && !data) {
    return (
      <Notice action={<Button size="sm" variant="outline" onClick={reload}><RefreshCw />Try again</Button>}>{error}</Notice>
    );
  }
  const bar = 'animate-pulse rounded bg-muted';
  if (!data) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><RefreshCw className="size-3.5 animate-spin" />Reading the themes with WP-CLI...</p>
        <div className={cn(bar, 'h-11 rounded-xl')} />
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {[40, 56, 48].map((w, i) => <li key={i} className="grid gap-2 px-4 py-3"><div className={cn(bar, 'h-4')} style={{ width: `${w * 4}px` }} /><div className={cn(bar, 'h-3 w-64 max-w-full')} /></li>)}
          </ul>
        </Card>
      </div>
    );
  }
  const active = data.themes.find((t) => t.status === 'active');
  // Only a theme in wp-content/themes: one in a repo's folder is updated in its repo.
  const canUpdateTheme = (t: SiteThemes['themes'][number]) => Boolean(t.update) && !t.inRepo && t.folder === `wp-content/themes/${t.name}`;
  const themeUpdates = data.themes.filter(canUpdateTheme).map((t) => t.name);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.themes.length}</span> theme{data.themes.length === 1 ? '' : 's'}
          {active ? <>, <span className="font-medium text-foreground">{active.title}</span> is on</> : ', none of them is on'}
          {data.network && ' on the main site; each site of a network has its own'}
        </p>
        <div className="flex items-center gap-2">
          <Segmented label="How much each theme shows" className="text-xs" value={details ? 'details' : 'compact'} onChange={(v) => setDetails(v === 'details')} options={[['compact', 'Compact'], ['details', 'Details']]} />
          <CheckAgain size="sm" onClick={checkAgain} loading={loading} />
        </div>
      </div>
      {error && <Notice tone="warning">Not read again: {error}. This is the list from before.</Notice>}
      <MissingPluginsCard site={site} show="themes" onChanged={reload} />
      <UpdatesBar kind="themes" names={themeUpdates} updates={updates} />
      {data.themes.length === 0 ? (
        <EmptyState icon={Palette} title="This site has no themes." className="py-10" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {data.themes.map((t) => (
              <li key={t.folder} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium', t.status === 'inactive' && 'text-muted-foreground')}>
                    <span className="break-words">{t.title}</span>
                    {t.status === 'active' && <Badge tone="success">On</Badge>}
                    {t.status === 'parent' && <Badge tone="primary">Parent of the theme that is on</Badge>}
                    {t.inRepo && <Badge>In its repo</Badge>}
                    <VulnerableBadge hit={t.wporg ? vulnerable.get(`theme:${t.wporg}`) : undefined} />
                  </p>
                  <p className="mt-0.5 text-xs break-words text-muted-foreground">
                    <span className="font-mono">{t.folder}</span>
                    {t.version && <> · {t.version}</>}
                    {t.update && <span className="text-warning"> · {t.update} available</span>}
                    {t.inRepo && ' · found through Local mode'}
                    {' · '}<TextLink href={themeFolderHref(site, t)} aria-label={`Open the folder of ${t.title}`}>Open folder</TextLink>
                  </p>
                  {details && (t.description || t.author || t.themeUri || t.wporg) && (
                    <p className="mt-1 max-w-3xl text-xs text-pretty text-muted-foreground">
                      {t.description}
                      {t.author && <span className="text-muted-foreground/80">{t.description ? ' ' : ''}By <OutLink href={t.authorUri}>{t.author}</OutLink>.</span>}
                      <OutLinks site={t.themeUri} siteLabel="Theme site" wporg={t.wporg && `https://wordpress.org/themes/${t.wporg}/`} />
                    </p>
                  )}
                </div>
                {t.update && t.wporg && (
                  <Button size="xs" variant="soft" className="shrink-0" onClick={() => setViewing({ kind: 'theme', slug: t.wporg as string, title: t.title, installed: t.version ?? '', update: t.update })} aria-label={`View the details of ${t.title} ${t.update}`}>
                    <Info />
                    View details
                  </Button>
                )}
                {canUpdateTheme(t) && (
                  <Button size="xs" variant="outline" className="shrink-0" disabled={updates.running} onClick={() => updates.start([t.name])} aria-label={`Update ${t.title} to ${t.update}`}>
                    <ArrowUpCircle />
                    Update to {t.update}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">The theme is switched in wp-admin, under Appearance: the panel only lists them.</p>
      <PluginDetailsDialog
        site={site}
        target={viewing}
        onClose={() => setViewing(null)}
        updating={updates.running}
        {...(viewing && data.themes.some((t) => t.wporg === viewing.slug && canUpdateTheme(t)) ? { onUpdate: () => { const t = data.themes.find((x) => x.wporg === viewing.slug); setViewing(null); if (t) updates.start([t.name]); } } : {})}
      />
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
  // Check again also asks WordPress.org for updates; other reads take what WordPress last found.
  const checking = useRef(false);
  const { data: fresh, error, loading, reload } = useAsync(() => {
    const check = checking.current;
    checking.current = false;
    return api.plugins(site.domain, site.path, check).then((list) => (lastLists.set(key, list), list));
  }, [site.domain, site.path]);
  const checkAgain = () => {
    checking.current = true;
    reload();
  };
  const data = fresh ?? lastLists.get(key);
  const vulnerable = useVulnerabilities(site);
  const [query, setQuery] = useState('');
  // The Overview's "3 updates" opens the list on them (show=updates).
  const [filter, setFilter] = useState<Filter>(useQueryParam('show') === 'updates' ? 'updates' : 'all');
  const updates = useUpdates(site, 'plugins', reload);
  const [viewing, setViewing] = useState<DetailsTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<SitePlugin | null>(null);
  // Details adds what each plugin says it does and who made it; it starts compact every time.
  const [details, setDetails] = useState(false);
  const plugins = data?.plugins ?? [];
  const test = FILTERS.find((f) => f.value === filter)?.test ?? (() => true);
  // A filter that nothing passes any more (the last update done) goes back to All, as its chip is gone.
  useEffect(() => {
    if (data && filter !== 'all' && !data.plugins.some(test)) setFilter('all');
  }, [data, filter]);
  // Must-use plugins and drop-ins last, as wp-admin keeps them on tabs of their own.
  const shown = plugins.filter((p) => test(p) && (pluginMatches(p.name, query) || pluginMatches(p.title, query))).sort((a, b) => Number(always(a)) - Number(always(b)));
  // A long list shows its first rows, then Show more or Show all; a search or filter starts it short again.
  const more = useShowMore(shown, { reset: `${query}|${filter}` });

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
      <Notice action={<Button size="sm" variant="outline" onClick={reload}><RefreshCw />Try again</Button>}>{error}</Notice>
    );
  }
  if (!data) return <PluginsSkeleton />;

  const count = (f: (typeof FILTERS)[number]) => plugins.filter(f.test).length;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{plugins.filter(isOn).length} of {plugins.filter((p) => !always(p)).length}</span> plugins on
          {data.network && ', turned on network-wide'}
        </p>
        <div className="flex items-center gap-2">
          <Segmented label="How much each plugin shows" className="text-xs" value={details ? 'details' : 'compact'} onChange={(v) => setDetails(v === 'details')} options={[['compact', 'Compact'], ['details', 'Details']]} />
          <CheckAgain size="sm" onClick={checkAgain} loading={loading} />
        </div>
      </div>
      {error && <Notice tone="warning">Not read again: {error}. This is the list from before.</Notice>}

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
            <IconButton icon={X} label="Clear the search" onClick={() => setQuery('')} className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-3.5" />
          )}
        </div>
        <FilterChips
          label="Show"
          value={filter}
          onChange={setFilter}
          options={FILTERS.filter((f) => f.value === 'all' || count(f) > 0).map((f) => ({ value: f.value, label: f.label, count: count(f) }))}
        />
      </div>

      {/* Under the search and filters, one row that keeps its height while it checks: the list below never moves. */}
      <MissingPluginsCard site={site} show="plugins" onChanged={reload} />
      <UpdatesBar kind="plugins" names={plugins.filter(canUpdate).map((p) => p.name)} updates={updates} />

      {shown.length === 0 ? (
        <EmptyState
          icon={Plug}
          title={plugins.length === 0 ? 'This site has no plugins.' : 'No plugin matches.'}
          className="py-10"
          action={(query || filter !== 'all') && plugins.length > 0 ? <Button size="sm" variant="outline" onClick={() => { setQuery(''); setFilter('all'); }}>Show every plugin</Button> : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {more.shown.map((p) => (
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
                    <VulnerableBadge hit={p.wporg ? vulnerable.get(`plugin:${p.wporg}`) : undefined} />
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
                    {p.path && <> · <TextLink href={pluginFolderHref(site, p)} aria-label={p.oneFile ? `Open the file of ${p.title}` : `Open the folder of ${p.title}`}>{p.oneFile ? 'Open file' : 'Open folder'}</TextLink></>}
                  </p>
                  {details && (p.description || p.author || p.pluginUri || p.wporg) && (
                    <p className="mt-1 max-w-3xl text-xs text-pretty text-muted-foreground">
                      {p.description}
                      {p.author && <span className="text-muted-foreground/80">{p.description ? ' ' : ''}By <OutLink href={p.authorUri}>{p.author}</OutLink>.</span>}
                      <OutLinks site={p.pluginUri} siteLabel="Plugin site" wporg={p.wporg && `https://wordpress.org/plugins/${p.wporg}/`} />
                    </p>
                  )}
                </div>
                {p.update && p.wporg && (
                  <Button size="xs" variant="soft" className="shrink-0" onClick={() => setViewing({ kind: 'plugin', slug: p.wporg as string, title: p.title, installed: p.version, update: p.update })} aria-label={`View the details of ${p.title} ${p.update}`}>
                    <Info />
                    View details
                  </Button>
                )}
                {canUpdate(p) && (
                  <Button size="xs" variant="outline" className="shrink-0" disabled={updates.running} onClick={() => updates.start([p.name])} aria-label={`Update ${p.title} to ${p.update}`}>
                    <ArrowUpCircle />
                    Update to {p.update}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <ShowMore {...more.footer} noun="plugins" />
        </Card>
      )}

      <PluginDetailsDialog
        site={site}
        target={viewing}
        onClose={() => setViewing(null)}
        updating={updates.running}
        {...(viewing && plugins.some((p) => p.wporg === viewing.slug && canUpdate(p)) ? { onUpdate: () => { const p = plugins.find((x) => x.wporg === viewing.slug); setViewing(null); if (p) updates.start([p.name]); } } : {})}
      />

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={`Turn off ${asking?.title ?? ''}?`}
        description={asking ? `${asking.requiredBy?.join(', ')} ${asking.requiredBy?.length === 1 ? 'needs' : 'need'} it, and may stop working or show errors while it is off.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="soft" onClick={() => setAsking(null)}>Keep it on</Button>
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

/** A link out of the panel, in a new tab without the panel as referrer; plain text when there is no address. */
function OutLink({ href, children, className }: { href?: string | undefined; children: ReactNode; className?: string }) {
  if (!href) return <>{children}</>;
  return <TextLink href={href} {...(className ? { className } : {})}>{children}</TextLink>;
}

/** A plugin's or theme's own site and its page on WordPress.org, after its description. */
function OutLinks({ site, siteLabel, wporg }: { site?: string | undefined; siteLabel: string; wporg?: string | undefined }) {
  // A Plugin URI that is its WordPress.org page already shows once.
  const own = site && !(wporg && site.replace(/\/$/, '') === wporg.replace(/\/$/, '')) ? site : undefined;
  if (!own && !wporg) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-x-2.5 align-baseline">
      {own && <OutLink href={own}>{siteLabel}</OutLink>}
      {wporg && <OutLink href={wporg}>WordPress.org</OutLink>}
    </span>
  );
}

type Hit = NonNullable<VulnerabilityState['found']>['hits'][number];

/** What the last vulnerability check found for the site, by kind and WordPress.org slug; empty while it is off. */
function useVulnerabilities(site: Site): Map<string, Hit> {
  const [hits, setHits] = useState<Map<string, Hit>>(new Map());
  useEffect(() => {
    let live = true;
    void api.siteVulnerabilities(site.domain, site.path).then(
      (v) => live && setHits(new Map((v.found?.hits ?? []).map((h) => [`${h.kind}:${h.slug}`, h]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [site.domain, site.path]);
  return hits;
}

/** A plugin's or theme's known vulnerabilities as one badge, linking to the worst one's advisory. */
function VulnerableBadge({ hit }: { hit: Hit | undefined }) {
  if (!hit) return null;
  const top = hit.vulnerabilities[0];
  const fixed = hit.vulnerabilities.map((v) => v.fixedIn).filter((v): v is string => Boolean(v)).sort(compareVersions).at(-1);
  const serious = top?.severity === 'high' || top?.severity === 'critical';
  const label = `Vulnerable${fixed ? `, fixed in ${fixed}` : hit.vulnerabilities.some((v) => v.unfixed) ? ', no fix yet' : ''}`;
  const title = hit.vulnerabilities.map((v) => `${v.title}${v.severity ? ` (${v.severity})` : ''}`).join('\n');
  const badge = <Badge tone={serious ? 'danger' : 'warning'} title={title}><ShieldAlert className="size-3" />{label}</Badge>;
  return top?.link ? <a href={top.link} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">{badge}</a> : badge;
}

/** Version order, part by part, as the server compares them. */

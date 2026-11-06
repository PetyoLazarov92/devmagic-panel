import type { InstallHow, Preferences, Site, SiteGit } from '@devmagic-panel/shared';
import { branchWebUrl, INSTALL_HOW_LABELS, INSTALL_HOWS, repoWeb, siteRepoLabel, SITES_SORT_LABELS, SITES_SORTS } from '@devmagic-panel/shared';
import { ArrowUpRight, Code2, Database, Eraser, ExternalLink, FolderGit2, FolderOpen, GitBranch, Layers, LayoutGrid, List, LoaderCircle, LogIn, PackageOpen, Plus, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { SitesSkeleton } from '@/components/skeletons';
import { BriefingCard } from '@/components/briefing-card';
import { coreLabel, installLabel, IssueLine, NetworkBadge, openInVSCode, siteSubtitle, siteUrl, StatusDot, vscodeUrl } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { UnfinishedInstalls } from '@/components/unfinished-installs';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { Link, navigate } from '@/lib/router';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { openWpAdmin, runWithToast } from '@/lib/site-actions';
import { useReloadWhileBusy } from '@/lib/jobs';
import { useAsync } from '@/lib/use-async';
import { siteHref, siteName, siteTarget } from '@/lib/site-ref';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'attention';

/** The sites in the order picked: by when they came here (unknown last), else by name. */
function sortSites(list: Site[], sort: Preferences['sitesSort']): Site[] {
  const byName = (a: Site, b: Site) => siteName(a).localeCompare(siteName(b));
  if (sort === 'name') return [...list].sort(byName);
  if (sort === 'name-desc') return [...list].sort((a, b) => byName(b, a));
  const time = (s: Site) => (s.addedAt ? Date.parse(s.addedAt) : Number.NaN);
  return [...list].sort((a, b) => {
    const [x, y] = [time(a), time(b)];
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? byName(a, b) : Number.isNaN(x) ? 1 : -1;
    return (sort === 'newest' ? y - x : x - y) || byName(a, b);
  });
}

export function SitesPage() {
  const { data: sites, error, loading, reload } = useAsync(() => api.sites(), []);
  // Installs started in the wizard and left, so they are found without opening New site.
  const drafts = useAsync(() => api.drafts().catch(() => []), []);
  const unfinished = drafts.data?.length ?? 0;
  useReloadWhileBusy(Boolean(sites?.some((s) => s.installing || s.busy)), reload);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [how, setHow] = useState<InstallHow | 'any'>('any');
  const [php, setPhp] = useState<string>('any');
  const { sitesView: view, sitesSort: sort } = usePreferences();

  const attention = sites?.filter((s) => s.health !== 'ok').length ?? 0;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = (sites ?? [])
      .filter((s) => filter === 'all' || s.health !== 'ok')
      .filter((s) => how === 'any' || (s.install?.how ?? 'hand') === how)
      .filter((s) => php === 'any' || s.php?.version === php)
      .filter((s) => !q || [siteName(s), s.title ?? '', ...s.aliases, s.git?.branch ?? ''].some((v) => v.toLowerCase().includes(q)));
    return sortSites(matching, sort);
  }, [sites, query, filter, how, php, sort]);
  // Only the ways sites here were installed are offered.
  const hows = INSTALL_HOWS.filter((h) => sites?.some((s) => (s.install?.how ?? 'hand') === h));
  // Only the PHP versions sites here run are offered.
  const phps = [...new Set((sites ?? []).map((s) => s.php?.version).filter((v): v is string => Boolean(v)))].sort().reverse();

  return (
    <div className="pt-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {sites ? `${sites.length} local sites` : 'Loading sites'}
            {attention > 0 && (
              <>
                {' · '}
                <button type="button" className="font-medium text-warning hover:underline" onClick={() => setFilter('attention')}>
                  {attention} need attention
                </button>
              </>
            )}
            {unfinished > 0 && (
              <>
                {' · '}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => document.getElementById('unfinished-installs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {unfinished} unfinished {unfinished === 1 ? 'install' : 'installs'}
                </button>
              </>
            )}
          </p>
        </div>
        <Button onClick={() => navigate('/sites/new')}>
          <Plus />
          New site
        </Button>
      </div>

      <UnfinishedInstalls drafts={drafts.data ?? []} onChanged={drafts.reload} className="mt-6" />

      <BriefingCard />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by domain, alias or branch"
            aria-label="Filter sites"
            className="pl-9"
          />
        </div>
        <div role="radiogroup" aria-label="Show" className="inline-flex self-start rounded-lg border bg-muted p-0.5 text-sm">
          {(['all', 'attention'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground',
                filter === f && 'bg-card text-foreground shadow-xs ring-1 ring-border',
              )}
            >
              {f === 'all' ? 'All' : 'Needs attention'}
            </button>
          ))}
        </div>
        {hows.length > 1 && (
          <Select value={how} onChange={(e) => setHow(e.target.value as InstallHow | 'any')} aria-label="How installed" className="h-9" wrapClassName="self-start sm:self-auto">
            <option value="any">Installed any way</option>
            {hows.map((h) => <option key={h} value={h}>{INSTALL_HOW_LABELS[h]}</option>)}
          </Select>
        )}
        {phps.length > 1 && (
          <Select value={php} onChange={(e) => setPhp(e.target.value)} aria-label="PHP version" className="h-9" wrapClassName="self-start sm:self-auto">
            <option value="any">Any PHP</option>
            {phps.map((v) => <option key={v} value={v}>PHP {v}</option>)}
          </Select>
        )}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={sort} onChange={(e) => savePreferences({ sitesSort: e.target.value as Preferences['sitesSort'] })} aria-label="Sort sites" className="h-9">
            {SITES_SORTS.map((s) => <option key={s} value={s}>{SITES_SORT_LABELS[s]}</option>)}
          </Select>
          <div role="radiogroup" aria-label="View" className="inline-flex rounded-lg border bg-muted p-0.5">
            {([['grid', 'Grid', LayoutGrid], ['list', 'List', List]] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view === value}
                title={label}
                onClick={() => savePreferences({ sitesView: value })}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground',
                  view === value && 'bg-card text-foreground shadow-xs ring-1 ring-border',
                )}
              >
                <Icon className="size-4" />
                <span className="sr-only">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p role="alert" className="mt-6 text-sm text-danger">{error}</p>}

      {loading && !sites && <SitesSkeleton view={view} className="mt-5" />}
      {sites && shown.length === 0 && (
        <div className="mt-5 rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
          No sites match. <button type="button" className="font-medium text-foreground hover:underline" onClick={() => { setQuery(''); setFilter('all'); setHow('any'); setPhp('any'); }}>Clear the filter</button>
        </div>
      )}
      {shown.length > 0 && view === 'grid' && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {shown.map((site) => <SiteCard key={siteName(site)} site={site} />)}
        </div>
      )}
      {shown.length > 0 && view === 'list' && (
        <ul className="mt-5 divide-y rounded-xl border bg-card shadow-xs">
          {shown.map((site) => <SiteRow key={siteName(site)} site={site} />)}
        </ul>
      )}
    </div>
  );
}

function SiteCard({ site }: { site: Site }) {
  // While its install job runs, the card links to the progress and holds every action back;
  // so it does while another job (a removal, an import) works on the site.
  const href = site.installing ? `/jobs/${encodeURIComponent(site.installing)}` : siteHref(site);
  const held = Boolean(site.installing || site.busy);
  return (
    <article className="group relative flex flex-col rounded-xl border bg-card shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3 px-5 pt-4">
        <StatusDot status={site.health} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-sm font-semibold" title={siteName(site)}>
            <Link href={href} className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">
              {site.domain}
              {site.path && <span className="text-primary">{site.path}</span>}
            </Link>
          </h2>
          {siteSubtitle(site) && <p className="truncate text-sm text-muted-foreground">{siteSubtitle(site)}</p>}
          {site.network && <NetworkBadge site={site} className="mt-1.5" />}
          {site.installing && <Badge tone="warning" className="mt-1.5"><LoaderCircle className="size-3 animate-spin" />Installing: see progress</Badge>}
          {site.busy && (
            <Link href={site.busy.jobId ? `/jobs/${encodeURIComponent(site.busy.jobId)}` : href} className="relative z-10 mt-1.5 block w-fit">
              <Badge tone="warning"><LoaderCircle className="size-3 animate-spin" />Busy: {site.busy.title}</Badge>
            </Link>
          )}
        </div>
        <div className={cn('relative z-10 has-[[aria-expanded=true]]:z-30', held && 'hidden')}>
          <Menu items={siteMenuItems(site)} />
        </div>
      </div>

      <dl className="mt-4 grid gap-2 px-5 text-sm">
        <Meta icon={<Layers />} label="Core">{coreLabel(site)}</Meta>
        {site.php && <Meta icon={<Code2 />} label="PHP"><PhpLabel php={site.php} /></Meta>}
        <Meta icon={<PackageOpen />} label="Installed"><span className="truncate">{installLabel(site.install)}</span></Meta>
        {(() => {
          const main = mainRepo(site);
          return main ? (
            <Meta icon={<GitBranch />} label={main.label === 'Site' ? 'Branch' : `Branch of ${main.label}`}>
              {main.label !== 'Site' && <span className="shrink-0 truncate text-xs text-muted-foreground">{main.label}</span>}
              <BranchLink git={main.git} />
              <GitState git={main.git} />
              {main.more > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{main.more} {main.more === 1 ? 'repo' : 'repos'}</span>}
            </Meta>
          ) : null;
        })()}
        {site.mounts?.map((m) =>
          m.git ? (
            <Meta key={m.path} icon={<GitBranch />} label={`Branch of ${m.path}`}>
              <span className="shrink-0 font-mono text-[13px] text-muted-foreground">{m.path}</span>
              <BranchLink git={m.git} />
              <GitState git={m.git} />
            </Meta>
          ) : null,
        )}
        {site.db && (
          <Meta icon={<Database />} label="Database">
            <span className="font-mono text-[13px]">{site.db.name}</span>
            {site.db.tables > 0 && <span className="text-xs text-muted-foreground">{bytes(site.db.sizeBytes)}</span>}
          </Meta>
        )}
      </dl>

      {site.issues.length > 0 && (
        <div className="mt-3 grid gap-1 px-5">
          {site.issues.map((issue) => (
            <IssueLine key={issue.text} issue={issue} />
          ))}
        </div>
      )}

      <div className={cn('relative z-10 mt-auto flex flex-wrap gap-2 px-5 pt-4 pb-4', held && 'pointer-events-none opacity-50')} aria-disabled={held ? true : undefined}>
        <Button size="sm" variant="outline" onClick={() => window.open(siteUrl(site.domain, site.path), '_blank', 'noopener')}>
          <ExternalLink />
          Open
        </Button>
        <Button size="sm" variant="outline" onClick={() => void openWpAdmin(site)}>
          <LogIn />
          wp-admin
        </Button>
        <ButtonLink size="sm" variant="outline" href={vscodeUrl(site.docroot)} title={`Open ${site.docroot} in VS Code`}>
          <Code2 />
          VS Code
        </ButtonLink>
      </div>
    </article>
  );
}

/**
 * One site as a row of the list view: what tells sites apart at a glance
 * (status, domain, title, branch, WordPress version, issues), with Open and
 * wp-admin; the rest is in the menu or on the site's page.
 */
function SiteRow({ site }: { site: Site }) {
  const href = site.installing ? `/jobs/${encodeURIComponent(site.installing)}` : siteHref(site);
  const held = Boolean(site.installing || site.busy);
  const issues = site.issues.length;
  return (
    <li className="group relative flex items-center gap-3 px-4 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/40">
      <StatusDot status={site.health} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm font-semibold" title={siteName(site)}>
          <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
            {site.domain}
            {site.path && <span className="text-primary">{site.path}</span>}
          </Link>
        </p>
        {site.title && <p className="truncate text-xs text-muted-foreground">{site.title}</p>}
      </div>
      {site.installing && <Badge tone="warning" className="shrink-0"><LoaderCircle className="size-3 animate-spin" />Installing</Badge>}
      {site.busy && <Badge tone="warning" className="shrink-0"><LoaderCircle className="size-3 animate-spin" />Busy</Badge>}
      {issues > 0 && <Badge tone={site.health === 'fail' ? 'danger' : 'warning'} className="hidden shrink-0 sm:inline-flex">{issues === 1 ? '1 issue' : `${issues} issues`}</Badge>}
      <div className="hidden w-52 min-w-0 shrink-0 items-center gap-2 text-sm md:flex">
        <RowBranch site={site} />
      </div>
      <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground lg:block" title={coreLabel(site)}>
        {site.core.kind === 'none' ? 'Not WordPress' : `WP ${site.core.version ?? ''}${site.core.kind === 'wpcore' ? ' · shared' : ''}`}
      </span>
      <span className="hidden w-24 shrink-0 text-xs text-muted-foreground xl:block">{site.php && <PhpLabel php={site.php} />}</span>
      <div className={cn('relative z-10 hidden shrink-0 gap-1.5 sm:flex', held && 'pointer-events-none opacity-50')} aria-disabled={held ? true : undefined}>
        <Button size="sm" variant="ghost" onClick={() => window.open(siteUrl(site.domain, site.path), '_blank', 'noopener')}>
          <ExternalLink />
          Open
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void openWpAdmin(site)}>
          <LogIn />
          wp-admin
        </Button>
      </div>
      <div className={cn('relative z-10 shrink-0 has-[[aria-expanded=true]]:z-30', held && 'invisible')}>
        <Menu items={siteMenuItems(site)} />
      </div>
    </li>
  );
}

/** What a site's menu offers, on its card and its row. */
function siteMenuItems(site: Site) {
  return [
    { label: 'Open site', icon: <ExternalLink />, onSelect: () => window.open(siteUrl(site.domain, site.path), '_blank', 'noopener') },
    { label: 'Log in to wp-admin', icon: <LogIn />, onSelect: () => void openWpAdmin(site) },
    { label: 'Clear cache', icon: <Eraser />, onSelect: () => void runWithToast('site.clearCache', siteTarget(site), `Caches cleared on ${siteName(site)}`) },
    { label: 'Open in VS Code', icon: <Code2 />, onSelect: () => openInVSCode(site.docroot) },
    ...gitMenuItems(site),
    { label: 'Copy folder path', icon: <FolderOpen />, onSelect: () => void navigator.clipboard?.writeText(site.docroot) },
  ];
}

/**
 * The repo a site shows first in the list: its own, else the first one
 * inside it (wp-content, a theme, a plugin), with how many more it has
 * inside. Mounted folders show on their own lines.
 */
function mainRepo(site: Site): { label: string; git: SiteGit; more: number } | null {
  const inner = (site.repos ?? []).map((r) => ({ label: siteRepoLabel(r), git: r.git }));
  const all = [...(site.git ? [{ label: 'Site', git: site.git }] : []), ...inner];
  const first = all[0];
  return first ? { ...first, more: all.length - 1 } : null;
}

/** The list row's git column: the main repo's branch, its changes and how many more repos. */
function RowBranch({ site }: { site: Site }) {
  const main = mainRepo(site);
  if (!main) return <span className="text-xs text-muted-foreground">no git</span>;
  return (
    <>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <BranchLink git={main.git} />
      {main.git.dirty > 0 && <span className="shrink-0 text-xs text-warning">{main.git.dirty} changed</span>}
      {main.more > 0 && <span className="shrink-0 text-xs text-muted-foreground" title={`${main.more} more ${main.more === 1 ? 'repo' : 'repos'} in this site`}>+{main.more}</span>}
    </>
  );
}

/** The branch name, linking to the branch on its host (GitHub, GitLab, Bitbucket, Gitea) when the remote is known. */
function BranchLink({ git }: { git: SiteGit }) {
  const url = git.remote ? branchWebUrl(git.remote, git.branch) : null;
  if (!url) return <span className="truncate font-mono text-[13px]">{git.branch}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${git.branch} on ${repoWeb(git.remote ?? '')?.name ?? 'the git host'}`}
      className="relative z-10 inline-flex min-w-0 items-center gap-1 rounded font-mono text-[13px] underline-offset-2 hover:underline"
    >
      <span className="truncate">{git.branch}</span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

function GitState({ git }: { git: SiteGit }) {
  return (
    <>
      {git.dirty > 0 && <span className="shrink-0 text-xs text-warning">{git.dirty} changed</span>}
      {git.upstream === null && <span className="shrink-0 text-xs text-warning" title="This branch has no remote branch yet">not pushed</span>}
      {git.behind > 0 && <span className="shrink-0 text-xs text-muted-foreground">{git.behind} behind</span>}
    </>
  );
}

function gitMenuItems(site: Site) {
  const remote = site.git?.remote;
  const web = remote ? repoWeb(remote) : null;
  const branch = remote && site.git ? branchWebUrl(remote, site.git.branch) : null;
  if (!web || !branch) return [];
  const open = (url: string) => () => void window.open(url, '_blank', 'noopener');
  return [
    { label: `Open branch on ${web.name}`, icon: <GitBranch />, onSelect: open(branch) },
    { label: `Open repository on ${web.name}`, icon: <FolderGit2 />, onSelect: open(web.repoUrl) },
  ];
}

function Meta({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <dt className="shrink-0 text-muted-foreground [&_svg]:size-4" title={label}>
        {icon}
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="flex min-w-0 items-center gap-2">{children}</dd>
    </div>
  );
}

/** The PHP a site runs: the default in muted text, its own as a badge. */
function PhpLabel({ php }: { php: NonNullable<Site['php']> }) {
  return php.own ? <Badge tone="primary" title="Its own PHP, through PHP-FPM">PHP {php.version}, own</Badge> : <span className="text-muted-foreground" title="The default PHP">PHP {php.version}</span>;
}

import type { ActionId, JobView, Site, SiteGit, SiteLocalMode, WpCronReport, WpDebugConstant } from '@devmagic-panel/shared';
import { branchWebUrl, commitWebUrl, hostname, LOCAL_MODE_DEFAULT_BLOCKED_HOSTS, MAILPIT_WEB, repoWeb, sameRepo, siteRepos, subjectLinks, WP_DEBUG_CONSTANTS } from '@devmagic-panel/shared';
import {
  ArrowDownToLine, ArrowLeft, Check, Code2, Eraser, ExternalLink, FolderGit2, FolderOpen, GitBranch, Image as ImageIcon, KeyRound, Layers, LoaderCircle, LogIn, Network, RefreshCw,
  ShieldCheck, SkipForward, SquareTerminal, Trash2, Wrench, X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Bar, ListSkeleton, LogSkeleton, SitePageSkeleton } from '@/components/skeletons';
import { AnsiText } from '@/components/ansi-text';
import { BranchPicker, PullBadge } from '@/components/branch-picker';
import { JobScreen } from '@/components/job-screen';
import { settled, StepList, useJob } from '@/components/job-steps';
import { LogView } from '@/components/log-view';
import { coreLabel, installLabel, IssueRow, NETWORK_TYPE_LABEL, NetworkBadge, siteSubtitle, siteUrl, StatusDot, vscodeUrl } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { lastLine, openWpAdmin, runWithToast } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { useReloadWhileBusy } from '@/lib/jobs';
import { loadThroughRestart } from '@/lib/startup';
import { type AsyncState, useAsync } from '@/lib/use-async';
import { ConfigTab, SaltsConfirm, saltsSummary } from '@/pages/site-config';
import { CronTab } from '@/pages/site-cron';
import { DatabaseTab } from '@/pages/site-database';
import { PhpTab } from '@/pages/site-php';
import { PluginsTab } from '@/pages/site-plugins';
import { ServerCard } from '@/pages/site-server';
import { siteHref, siteName, siteTarget } from '@/lib/site-ref';
import { debugLabel, debugValues, siteTabItems, type Tab, type TabCounts, uncoveredNames } from '@/lib/site-tabs';
import { cn } from '@/lib/utils';

/** A tab's address: the site's page with ?tab=, nothing for Overview. Not a path segment, which a site under that path would own. */
const tabHref = (site: { domain: string; path?: string }, tab: Tab, extra = '') => `${siteHref(site)}${tab === 'overview' ? '' : `?tab=${tab}${extra}`}`;

/** A site's page; with a path, the WordPress install under that path of the domain. */
export function SiteDetailPage({ domain, path }: { domain: string; path?: string }) {
  const { data: site, error, loading, reload } = useAsync(() => api.site(domain, path), [domain, path]);
  const logs = useAsync(() => api.logs(domain, 'debug', path), [domain, path]);
  // The WordPress installs under paths of this domain, linked from the parent's page.
  const all = useAsync(() => (path ? Promise.resolve([]) : api.sites()), [domain, path]);
  const under = (all.data ?? []).filter((s) => s.domain === domain && s.path);
  const requested = useQueryParam('tab');
  const [removing, setRemoving] = useState(false);
  // The WordPress site's WP-Cron, for the Cron tab and its count; url picks a network site.
  const [cronUrl, setCronUrl] = useState<string | undefined>(undefined);
  const wordpress = Boolean(site && site.core.kind !== 'none' && !site.installing);
  const wpCron = useAsync(() => (wordpress ? api.wpCron(domain, path, cronUrl) : Promise.resolve(null)), [domain, path, cronUrl, wordpress]);
  const reloadCron = (url?: string) => (url === cronUrl ? wpCron.reload() : setCronUrl(url));
  useReloadWhileBusy(Boolean(site?.installing || site?.busy), reload);
  // The tab is in the address, so a reload or a link opens it; one this site lacks shows Overview.
  const tab: Tab = site && siteTabItems(site).some((t) => t.value === requested) ? (requested as Tab) : 'overview';
  // The constants every local site should have, from Settings, for the Config tab's count.
  const locals = useAsync(() => api.localConstants(), []);
  const setTab = (next: Tab) => navigate(tabHref({ domain, ...(path ? { path } : {}) }, next), { scroll: false });
  useEffect(() => {
    if (site && requested !== null && requested !== tab) navigate(tabHref({ domain, ...(path ? { path } : {}) }, tab), { replace: true });
  }, [site, requested, tab, domain, path]);

  if (loading && !site) {
    return <SitePageSkeleton />;
  }
  if (error || !site) {
    return (
      <div className="pt-10 text-sm">
        <p className="text-danger" role="alert">{error ?? `No site called ${domain}${path ?? ''}.`}</p>
        <Link href="/sites" className="mt-3 inline-block font-medium hover:underline">Back to sites</Link>
      </div>
    );
  }

  // Nothing is offered on a site that is still being installed: its page is the install's progress.
  if (site.installing) {
    return (
      <div className="grid gap-4 pt-2">
        <Link href="/sites" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Sites
        </Link>
        <p className="rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
          {siteName(site)} is still being installed. Its actions open once the install finishes. <button type="button" className="font-medium hover:underline" onClick={reload}>Check again</button>
        </p>
        <JobScreen jobId={site.installing} />
      </div>
    );
  }

  const problems = (logs.data?.lines ?? []).filter((l) => l.level === 'fatal' || l.level === 'error').length;
  // Late events, and the panel's cron tasks for the site whose last run failed.
  const cronProblems = wpCron.data ? wpCron.data.overdue + [wpCron.data.task, ...wpCron.data.tasks].filter((t) => t?.last?.status === 'failed').length : 0;
  // Local constants wp-config.php does not have yet, and keys and salts to fix as one.
  const configProblems = site.constants
    ? (locals.data ?? []).filter((c) => site.constants?.find((s) => s.name === c.name)?.value !== c.value).length + (site.salts && saltsSummary(site.salts).bad.length > 0 ? 1 : 0)
    : 0;
  const counts: TabCounts = { logs: problems, cron: cronProblems, config: configProblems, domains: site.path ? 0 : uncoveredNames(site).length };

  return (
    <div className="pt-2">
      <Link href="/sites" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sites
      </Link>

      {site.busy && (
        <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-warning" />
          <span>
            Busy: {site.busy.title}. Its actions wait until that finishes.{' '}
            {site.busy.jobId && <Link href={`/jobs/${encodeURIComponent(site.busy.jobId)}`} className="font-medium hover:underline">See progress</Link>}
          </span>
        </p>
      )}

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusDot status={site.health} />
            <h1 className="truncate text-2xl font-semibold tracking-tight" title={siteName(site)}>{siteName(site)}</h1>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5.5 text-sm text-muted-foreground">
            {siteSubtitle(site) && <span>{siteSubtitle(site)}</span>}
            <NetworkBadge site={site} />
          </p>
          {under.length > 0 && (
            <p className="mt-1 pl-5.5 text-sm text-muted-foreground">
              Also on this domain:{' '}
              {under.map((s, i) => (
                <span key={s.path}>
                  {i > 0 && ', '}
                  <Link href={siteHref(s)} className="font-mono text-[13px] text-foreground hover:underline">{s.path}</Link>
                  {s.title && <> ({s.title})</>}
                </span>
              ))}
            </p>
          )}
          {site.path && (
            <p className="mt-1 pl-5.5 text-sm text-muted-foreground">
              Under <Link href={`/sites/${encodeURIComponent(site.domain)}`} className="font-mono text-[13px] text-foreground hover:underline">{site.domain}</Link>: its own folder, database and git; the vhost, certificate and hosts line are there.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => window.open(siteUrl(site.domain, site.path), '_blank', 'noopener')}>
            <ExternalLink />
            Open site
          </Button>
          <ButtonLink variant="outline" href={vscodeUrl(site.docroot)} title={`Open ${site.docroot} in VS Code`}>
            <Code2 />
            VS Code
          </ButtonLink>
          <Button onClick={() => void openWpAdmin(site)}>
            <LogIn />
            wp-admin
          </Button>
          <Menu
            items={[
              ...(site.network ? [{ label: 'Network Admin', icon: <Network />, onSelect: () => void openWpAdmin(site, { to: 'network' }) }] : []),
              { label: 'Copy folder path', icon: <FolderOpen />, onSelect: () => void navigator.clipboard?.writeText(site.docroot) },
              site.removable
                ? { label: 'Remove site', icon: <Trash2 />, danger: true, onSelect: () => setRemoving(true) }
                : { label: site.path ? 'Remove site (goes with its parent)' : 'Remove site (not in the usual layout)', icon: <Trash2 />, disabled: true, onSelect: () => undefined },
            ]}
          />
        </div>
      </header>

      {site.issues.length > 0 && (
        <div className={cn('mt-5 rounded-xl border px-4 py-3', site.health === 'fail' ? 'border-danger/30 bg-danger/6' : 'border-warning/30 bg-warning/6')}>
          <div className="grid gap-1.5">
            {site.issues.map((issue) => <IssueRow key={issue.text} issue={issue} onFixed={reload} />)}
          </div>
        </div>
      )}

      <Tabs
        className="mt-6"
        value={tab}
        onChange={setTab}
        items={siteTabItems(site, counts)}
      />

      <div className="mt-5">
        {tab === 'overview' && <Overview site={site} onChanged={reload} onOpen={setTab} cron={wpCron} logErrors={logs.loading && !logs.data ? undefined : problems} />}
        {tab === 'logs' && <LogsTab site={site} onChanged={reload} />}
        {tab === 'network' && <NetworkCard site={site} />}
        {tab === 'plugins' && <PluginsTab site={site} />}
        {tab === 'php' && <PhpTab site={site} />}
        {tab === 'cron' && <CronTab site={site} report={wpCron} onReload={reloadCron} />}
        {tab === 'database' && <DatabaseTab site={site} />}
        {tab === 'config' && <ConfigTab site={site} onChanged={reload} />}
        {tab === 'domains' && <DomainsTab site={site} onChanged={reload} />}
      </div>

      {!site.path && <RemoveDialog site={site} open={removing} onClose={() => setRemoving(false)} />}
    </div>
  );
}

const DEBUG_HINT: Record<WpDebugConstant, string> = {
  WP_DEBUG: 'Debug mode; the settings below need it',
  WP_DEBUG_LOG: 'Write errors to wp-content/debug.log',
  WP_DEBUG_DISPLAY: 'Show errors on the page',
  SCRIPT_DEBUG: 'Load the unminified core JS and CSS',
  SAVEQUERIES: 'Record database queries, for Query Monitor',
};

const DEBUG_PRESETS: Array<{ label: string; constants: Partial<Record<WpDebugConstant, boolean>> }> = [
  { label: 'Log only', constants: { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false } },
  { label: 'Off', constants: { WP_DEBUG: false } },
];

/**
 * Debug mode for the Logs tab, next to the log it fills: where errors go now, the two presets, and each
 * constant on its own, as wp-config.php has it. Apply sends only what changed.
 */
function DebugSettings({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  const current = debugValues(site);
  const key = JSON.stringify(current);
  const [wanted, setWanted] = useState(current);
  useEffect(() => setWanted(JSON.parse(key) as Record<WpDebugConstant, boolean>), [key]);
  const changed = Object.fromEntries(WP_DEBUG_CONSTANTS.filter((n) => wanted[n] !== current[n]).map((n) => [n, wanted[n]]));

  async function apply(constants: Partial<Record<WpDebugConstant, boolean>>) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.runAction('site.setDebug', { ...siteTarget(site), constants });
      setResult({ name: 'Debug mode', ok: r.ok, output: r.output });
      if (r.ok) onChanged();
    } catch (error) {
      setResult({ name: 'Debug mode', ok: false, output: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Debug: <span className={cn(!site.debug.enabled && 'text-warning')}>{debugLabel(site)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {site.debug.enabled ? 'Constants in wp-config.php. Ones it leaves out use WordPress\'s default.' : 'WordPress writes nothing new to debug.log while debug mode is off.'}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          {DEBUG_PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant="outline" disabled={busy || p.label === debugLabel(site)} onClick={() => void apply(p.constants)}>{p.label}</Button>
          ))}
        </span>
      </div>
      <details className="border-t px-5 py-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Each constant</summary>
        <fieldset className="mt-3 grid gap-2.5 sm:grid-cols-2" disabled={busy}>
          <legend className="sr-only">Debug constants</legend>
          {WP_DEBUG_CONSTANTS.map((n) => (
            <Checkbox
              key={n}
              id={`debug-${n}`}
              checked={wanted[n]}
              onChange={(v) => setWanted((w) => ({ ...w, [n]: v }))}
              label={<code className="font-mono text-[13px]">{n}</code>}
              hint={`${DEBUG_HINT[n]}${site.debug.constants[n] === null ? ' (default)' : ''}`}
            />
          ))}
        </fieldset>
        {Object.keys(changed).length > 0 && (
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void apply(changed)}>Apply</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWanted(current)}>Reset</Button>
          </div>
        )}
      </details>
      {result && <div className="border-t px-5 py-3"><RunOutput result={result} /></div>}
    </Card>
  );
}

/**
 * One fact from another tab, and the way there. A fact read after the page
 * (WP-Cron, the errors in debug.log) keeps its place while it loads, with a
 * bar where its value or detail goes, so the tiles never move.
 */
function Tile({ label, value, detail, tone, loading, onOpen }: { label: string; value?: string; detail?: string; tone?: 'warning' | 'danger'; loading?: 'value' | 'detail'; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={loading ? true : undefined}
      className={cn(
        'grid min-w-0 gap-0.5 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60',
        tone === 'danger' && 'border-danger/30',
        tone === 'warning' && 'border-warning/40',
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {loading === 'value' ? <Bar className="my-0.5 h-4 w-20" /> : <span className="truncate text-sm font-medium">{value}</span>}
      {loading ? (
        <span className="flex h-4 items-center"><Bar className="h-2.5 w-24" /><span className="sr-only">Reading...</span></span>
      ) : (
        detail && <span className={cn('truncate text-xs', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{detail}</span>
      )}
    </button>
  );
}

/** The facts from the other tabs a site has, each opening its tab. */
function SiteTiles({ site, cron, logErrors, onOpen }: { site: Site; cron: AsyncState<WpCronReport | null>; logErrors: number | undefined; onOpen: (tab: Tab) => void }) {
  const tabs = new Set(siteTabItems(site).map((t) => t.value));
  const uncovered = uncoveredNames(site);
  const names = site.aliases.length + 1;
  const tiles: Array<Parameters<typeof Tile>[0] & { key: string }> = [];
  tiles.push({
    key: 'logs',
    label: 'Debug',
    value: debugLabel(site),
    ...(logErrors === undefined ? { loading: 'detail' as const } : {}),
    detail: logErrors ? `${logErrors} error${logErrors === 1 ? '' : 's'} in debug.log` : site.debug.logBytes ? `debug.log ${bytes(site.debug.logBytes)}` : 'debug.log empty',
    ...(logErrors ? { tone: 'danger' as const } : {}),
    onOpen: () => onOpen('logs'),
  });
  if (tabs.has('network') && site.network) {
    tiles.push({ key: 'network', label: 'Network', value: site.network.sites.length > 0 ? `${site.network.sites.length} sites` : NETWORK_TYPE_LABEL[site.network.type], detail: site.network.sites.length > 0 ? NETWORK_TYPE_LABEL[site.network.type] : 'Sites need the MySQL admin', onOpen: () => onOpen('network') });
  }
  if (tabs.has('database') && site.db) {
    tiles.push({ key: 'database', label: 'Database', value: site.db.name, ...(site.db.tables > 0 ? { detail: `${bytes(site.db.sizeBytes)} · ${site.db.tables} tables` } : { detail: 'No tables yet' }), onOpen: () => onOpen('database') });
  }
  // WP-Cron is read with WP-CLI after the page: its tile holds its place until then.
  const c = cron.data;
  if (tabs.has('cron') && c) {
    const running = c.disabled ? (c.task ? 'Runs from cron' : 'Not running: DISABLE_WP_CRON') : 'Runs on page loads';
    tiles.push({
      key: 'cron',
      label: 'WP-Cron',
      value: `${c.events.length} event${c.events.length === 1 ? '' : 's'}`,
      detail: c.overdue > 0 ? `${c.overdue} late` : running,
      ...(c.overdue > 0 || (c.disabled && !c.task) ? { tone: 'warning' as const } : {}),
      onOpen: () => onOpen('cron'),
    });
  } else if (tabs.has('cron')) {
    // The Cron tab is only there for WordPress, so no answer yet means it is still being read.
    tiles.push({ key: 'cron', label: 'WP-Cron', onOpen: () => onOpen('cron'), ...(cron.error && !cron.loading ? { value: 'Not read', detail: 'WP-CLI could not list it', tone: 'warning' as const } : { loading: 'value' as const }) });
  }
  if (tabs.has('php') && site.php) {
    tiles.push({ key: 'php', label: 'PHP', value: site.php.version, detail: site.php.own ? 'Its own version' : 'The default version', onOpen: () => onOpen('php') });
  }
  if (tabs.has('domains')) {
    tiles.push({
      key: 'domains',
      label: 'Domains and SSL',
      value: `${names} name${names === 1 ? '' : 's'}`,
      detail: !site.cert ? 'No certificate' : uncovered.length > 0 ? `${uncovered.length} not covered` : `Certificate until ${shortDate(site.cert.expiresAt)}`,
      ...(!site.cert || uncovered.length > 0 ? { tone: 'warning' as const } : {}),
      onOpen: () => onOpen('domains'),
    });
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map(({ key, ...tile }) => <Tile key={key} {...tile} />)}
    </div>
  );
}

/**
 * A site at a glance: the facts from its other tabs, then what you do most (git, quick actions, the core),
 * Local mode and uploads, and where its files are. Settings live in their tabs.
 */
function Overview({ site, onChanged, onOpen, cron, logErrors }: { site: Site; onChanged: () => void; onOpen: (tab: Tab) => void; cron: AsyncState<WpCronReport | null>; logErrors: number | undefined }) {
  const coreVersions = useAsync(() => (site.core.kind === 'wpcore' ? api.cores() : Promise.resolve([])), [site.core.kind]).data ?? [];
  const [core, setCore] = useState(site.core.version ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  // Writing keys logs people out, so both ways ask first: the ones WordPress does not use while there are any, else all of them.
  const [salting, setSalting] = useState<'missing' | 'all' | null>(null);
  const salts = site.salts ? saltsSummary(site.salts) : null;
  const saltsName = salts && salts.bad.length > 0 ? salts.fixLabel : 'Make keys and salts new';
  const repos = siteRepos(site);
  // The repo the site was installed from, marked in its section.
  const installedFrom = site.install?.repo;

  async function markDone(label: string) {
    setMarking(label);
    const r = await runWithToast('site.skippedDone', { ...siteTarget(site), label }, `${label}: marked done`);
    setMarking(null);
    if (r?.ok) onChanged();
  }

  async function run(name: string, id: ActionId, input: Record<string, unknown>): Promise<boolean> {
    setBusy(name);
    setResult(null);
    try {
      const r = await api.runAction(id, input);
      setResult({ name, ok: r.ok, output: r.output });
      if (r.ok) onChanged();
      return r.ok;
    } catch (error) {
      setResult({ name, ok: false, output: (error as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const terminalName = 'Open in terminal';
  const coreResult = result?.name === 'Switch core' ? result : null;
  const quickResult = result && !coreResult ? result : null;

  return (
    <div className="grid gap-4">
      {site.install?.skipped && site.install.skipped.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/6 px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><SkipForward className="size-4 text-warning" />Skipped when it was installed</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Did one yourself? Mark it done to take it off this list. The job and Run history keep it as skipped.</p>
          <ul className="mt-2 grid gap-2">
            {site.install.skipped.map((s) => (
              <li key={s.label} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
                <span className="min-w-0 flex-1 basis-64">
                  <span className="font-medium">{s.label}.</span> <span className="break-words text-muted-foreground">{s.todo}</span>
                </span>
                <Button size="sm" variant="outline" disabled={marking !== null} onClick={() => void markDone(s.label)} aria-label={`Mark ${s.label} done`}>
                  {marking === s.label ? <LoaderCircle className="animate-spin" /> : <Check />}
                  Done
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SiteTiles site={site} cron={cron} logErrors={logErrors} onOpen={onOpen} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {repos.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Git</CardTitle>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {repos.length > 1 && `${repos.length} repos`}
                <GitBranch className="size-4" />
              </span>
            </CardHeader>
            <div className="divide-y">
              {repos.map((r) => (
                <RepoSection
                  key={`${r.mount ?? ''}:${r.repo ?? ''}`}
                  domain={site.domain}
                  {...(r.mount ? { mount: r.mount } : {})}
                  {...(r.repo ? { repo: r.repo } : {})}
                  label={r.label}
                  folder={r.mount && r.mount !== site.path ? (site.mounts?.find((m) => m.path === r.mount)?.docroot ?? site.docroot) : r.repo ? `${site.docroot}/${r.repo}` : site.docroot}
                  git={r.git}
                  installedFrom={Boolean(installedFrom && r.git.remote && sameRepo(r.git.remote, installedFrom))}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </Card>
        )}

        <div className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>Quick actions</CardTitle><Wrench className="size-4 text-muted-foreground" /></CardHeader>
            <div className="grid gap-2 p-5 sm:grid-cols-2">
              {([
                { name: 'Clear all caches', icon: <Eraser />, id: 'site.clearCache' },
                { name: 'Flush rewrite rules', icon: <RefreshCw />, id: 'site.flushRewrites' },
              ] as const).map(({ name, icon, id }) => (
                <Button key={name} variant="outline" className="justify-start" disabled={busy !== null} onClick={() => void run(name, id, siteTarget(site))}>
                  {busy === name ? <LoaderCircle className="animate-spin" /> : quickResult?.name === name && quickResult.ok ? <Check className="text-success" /> : icon}
                  {name}
                </Button>
              ))}
              {salts && (
                <Button variant="outline" className="justify-start" disabled={busy !== null} onClick={() => setSalting(salts.bad.length > 0 ? 'missing' : 'all')}>
                  {busy === saltsName ? <LoaderCircle className="animate-spin" /> : quickResult?.name === saltsName && quickResult.ok ? <Check className="text-success" /> : <KeyRound />}
                  {saltsName}
                </Button>
              )}
              <Button variant="outline" className="justify-start" disabled={busy !== null} onClick={() => void run(terminalName, 'site.openTerminal', siteTarget(site))}>
                {busy === terminalName ? <LoaderCircle className="animate-spin" /> : <SquareTerminal />}
                {terminalName}
              </Button>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Clearing caches runs <code className="font-mono">wp cache flush</code>, deletes transients and reloads Apache to reset OPcache.
              </p>
              {quickResult && <div className="sm:col-span-2"><RunOutput result={quickResult} /></div>}
            </div>
          </Card>

          {site.core.kind !== 'none' && (
            <Card>
              <CardHeader><CardTitle>WordPress</CardTitle><Layers className="size-4 text-muted-foreground" /></CardHeader>
              <div className="grid gap-4 p-5">
                <p className="text-sm">{coreLabel(site)}</p>
                {site.core.kind === 'wpcore' ? (
                  <Field label="Core version" htmlFor="core" hint="Switches the symlinks to another shared core, then updates the database. Files in wp-content stay as they are.">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <Select id="core" value={core} onChange={(e) => setCore(e.target.value)} disabled={busy !== null}>
                          {coreVersions.map((v) => {
                            const notes = [v === coreVersions[0] ? 'latest' : null, v === site.core.version ? 'current' : null].filter(Boolean);
                            return <option key={v} value={v}>{v}{notes.length ? ` (${notes.join(', ')})` : ''}</option>;
                          })}
                        </Select>
                      </div>
                      {core && core !== site.core.version && (
                        <Button variant="outline" className="h-10" disabled={busy !== null} onClick={() => void run('Switch core', 'core.switch', { ...siteTarget(site), version: core })}>
                          {busy === 'Switch core' ? <LoaderCircle className="animate-spin" /> : <Layers />}
                          Switch to {core}
                        </Button>
                      )}
                    </div>
                  </Field>
                ) : (
                  <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                    This site has its own copy of WordPress. Update it with wp core update; shared cores are on the WordPress page.
                  </p>
                )}
                {coreResult && <RunOutput result={coreResult} />}
              </div>
            </Card>
          )}
        </div>

        <SaltsConfirm mode={salting} onClose={() => setSalting(null)} onConfirm={(only) => void run(saltsName, 'site.shuffleSalts', { ...siteTarget(site), only })} />

        {site.localMode && <LocalModeCard site={site} localMode={site.localMode} onChanged={onChanged} />}

        {site.localMode && <UploadsCard site={site} onChanged={onChanged} />}

        <Card>
          <CardHeader><CardTitle>Files</CardTitle><FolderOpen className="size-4 text-muted-foreground" /></CardHeader>
          <dl className="grid gap-3 p-5 text-sm">
            <Row label="Installed">{installLabel(site.install)}</Row>
            <Row label="Folder"><FolderLine path={site.docroot} /></Row>
            {site.mounts?.map((m) => (
              <Row key={m.path} label={m.path}><FolderLine path={m.docroot} /></Row>
            ))}
            {site.prodUrl && <Row label="Production"><a href={site.prodUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{site.prodUrl}</a></Row>}
          </dl>
        </Card>
      </div>
    </div>
  );
}

function RepoSection({ domain, mount, repo, label, folder, git, installedFrom = false, onChanged }: {
  domain: string;
  mount?: string;
  /** A repo inside the site's folder: wp-content, or a theme or plugin folder. */
  repo?: string;
  installedFrom?: boolean;
  label: string;
  folder: string;
  git: SiteGit;
  onChanged: () => void;
}) {
  const details = useAsync(() => api.gitDetails(domain, mount, repo), [domain, mount, repo, git.branch, git.lastCommit.hash, git.dirty]);
  // Its own request: gh or glab can take seconds, and the card does not wait for it. No pull or merge requests on any failure.
  const pulls = useAsync(() => api.gitPulls(domain, mount, repo), [domain, mount, repo]);
  const [branch, setBranch] = useState(git.branch);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  const target = { domain, ...(mount ? { mount } : {}), ...(repo ? { repo } : {}) };
  const branches = details.data?.branches ?? [{ name: git.branch, current: true, remoteOnly: false }];
  const commits = details.data?.commits ?? [git.lastCommit];
  const changes = details.data?.changes ?? [];
  const pullFor = new Map((pulls.data ?? []).map((p) => [p.branch, p]));
  const currentPull = pullFor.get(git.branch);

  useEffect(() => setBranch(git.branch), [git.branch]);

  async function run(name: string, id: ActionId, input: Record<string, unknown>) {
    setBusy(name);
    setResult(null);
    try {
      const r = await api.runAction(id, input);
      setResult({ name, ok: r.ok, output: r.output });
      if (r.ok) {
        onChanged();
        details.reload();
        pulls.reload();
      }
    } catch (error) {
      setResult({ name, ok: false, output: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const id = `branch-${label.replace(/\W/g, '')}`;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3 p-5 text-sm" aria-label={`${label} repository`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" title={folder}>{label}</span>
        <span className="font-mono">{git.branch}</span>
        {installedFrom && <Badge title="The site was installed from this repo">installed from</Badge>}
        {currentPull && <PullBadge pull={currentPull} withTitle />}
        {git.dirty > 0 && <Badge tone="warning">{git.dirty} changed</Badge>}
        {git.upstream === null ? (
          <Badge tone="warning">not pushed</Badge>
        ) : (
          <>
            {git.ahead > 0 && <Badge>{git.ahead} ahead</Badge>}
            {git.behind > 0 && <Badge>{git.behind} behind</Badge>}
          </>
        )}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        {git.upstream ? `Tracks ${git.upstream}` : 'No remote branch yet: push it to share it and to see what is ahead or behind.'}
        {details.data?.fetchedAt && ` · fetched ${timeAgo(details.data.fetchedAt)}`}
      </p>

      <div className="flex flex-wrap gap-2">
        <label htmlFor={id} className="sr-only">Branch</label>
        <div className="min-w-48 flex-1">
          <BranchPicker id={id} branches={branches} pulls={pullFor} value={branch} onChange={setBranch} disabled={busy !== null} />
        </div>
        {branch !== git.branch && (
          <Button
            variant="outline"
            className="h-10"
            disabled={busy !== null || git.dirty > 0}
            title={git.dirty > 0 ? 'Commit or stash the uncommitted changes first' : undefined}
            onClick={() => void run('Switch', 'git.switch', { ...target, branch })}
          >
            {busy === 'Switch' ? <LoaderCircle className="animate-spin" /> : <GitBranch />}
            Switch
          </Button>
        )}
        <Button
          variant="outline"
          className="h-10"
          disabled={busy !== null || git.upstream === null}
          title={git.upstream === null ? 'This branch has no remote branch to pull from' : 'Pull, fast-forward only'}
          onClick={() => void run('Pull', 'git.pull', target)}
        >
          {busy === 'Pull' ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}
          {git.behind > 0 ? `Pull ${git.behind}` : 'Pull'}
        </Button>
        <Button variant="outline" className="h-10" disabled={busy !== null} title="Fetch branches and commits from origin" onClick={() => void run('Fetch', 'git.fetch', target)}>
          <RefreshCw className={cn(busy === 'Fetch' && 'animate-spin')} />
          Fetch
        </Button>
      </div>
      {branch !== git.branch && git.dirty > 0 && (
        <p className="-mt-1 text-xs text-warning">Commit or stash the {git.dirty} uncommitted change{git.dirty === 1 ? '' : 's'} before switching.</p>
      )}
      {result && <RunOutput result={result} />}

      <ol className="grid gap-2 rounded-lg bg-muted px-3 py-2.5">
        {commits.slice(0, 5).map((c) => (
          <li key={c.hash}>
            <p className="font-medium break-words">
              {subjectLinks(git.remote, c.subject).map((part, i) =>
                part.href ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{part.text}</a> : part.text,
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <CommitHash remote={git.remote} hash={c.hash} /> · {c.author} · {timeAgo(c.date)}
            </p>
          </li>
        ))}
      </ol>

      {changes.length > 0 && (
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium">
            {changes.length} uncommitted change{changes.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 grid gap-1 font-mono text-xs">
            {changes.map((c) => (
              <li key={c.path} className="flex gap-2 break-all">
                <span className="w-5 shrink-0 text-muted-foreground" title={changeLabel(c.code)}>{c.code.trim()}</span>
                {c.path}
              </li>
            ))}
          </ul>
        </details>
      )}
      <GitLinks remote={git.remote} branch={git.branch} />
    </section>
  );
}

/** What a `git status --porcelain` code means, for its tooltip. */
function changeLabel(code: string): string {
  if (code === '??') return 'new file, not tracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

function GitLinks({ remote, branch }: { remote: string | undefined; branch: string }) {
  const web = remote ? repoWeb(remote) : null;
  const branchUrl = remote ? branchWebUrl(remote, branch) : null;
  if (!web || !branchUrl) return <p className="text-xs text-muted-foreground">No remote named origin, so there is nothing to open online.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      <ButtonLink size="sm" variant="outline" href={branchUrl} target="_blank" rel="noopener noreferrer">
        <GitBranch />
        Open branch on {web.name}
      </ButtonLink>
      <ButtonLink size="sm" variant="ghost" href={web.repoUrl} target="_blank" rel="noopener noreferrer">
        <FolderGit2 />
        Repository
      </ButtonLink>
    </div>
  );
}

function CommitHash({ remote, hash }: { remote: string | undefined; hash: string }) {
  const url = remote ? commitWebUrl(remote, hash) : null;
  if (!url) return <span className="font-mono">{hash}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-2 hover:text-foreground hover:underline">
      {hash}
    </a>
  );
}

type NetworkFilter = 'all' | 'active' | 'archived' | 'deleted';
type NetworkSite = NonNullable<Site['network']>['sites'][number];

const isActive = (s: NetworkSite) => !s.archived && !s.spam;

function NetworkCard({ site }: { site: Site }) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const [admins, setAdmins] = useState(false);
  const network = site.network;
  if (!network) return null;
  const type = network.type;
  const deleted = network.deleted ?? [];
  const archived = network.sites.filter((s) => !isActive(s)).length;
  const shown = network.sites.filter((s) => (filter === 'all' ? true : filter === 'active' ? isActive(s) : filter === 'archived' ? !isActive(s) : false));
  const filters = [
    { value: 'all' as const, label: 'All', count: network.sites.length },
    { value: 'active' as const, label: 'Active', count: network.sites.length - archived },
    { value: 'archived' as const, label: 'Archived or spam', count: archived },
    { value: 'deleted' as const, label: 'Deleted', count: deleted.length },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Network</CardTitle>
        <span className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {network.sites.length > 0 && `${network.sites.length} sites · `}
            {NETWORK_TYPE_LABEL[type]}
          </span>
          <Network className="size-4 text-muted-foreground" />
        </span>
      </CardHeader>
      {network.sites.length === 0 && (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          wp-config.php marks this as a network. Listing its sites needs the MySQL admin account: set it up under Aura, Machine checks.
        </p>
      )}
      {network.sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          {(archived > 0 || deleted.length > 0) &&
            filters
              .filter((f) => f.value === 'all' || f.count > 0)
              .map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
                >
                  {f.label} <span className="tabular-nums opacity-70">{f.count}</span>
                </button>
              ))}
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdmins(true)}>
            <ShieldCheck />
            Super admins
          </Button>
        </div>
      )}
      {filter === 'deleted' ? (
        <ul className="divide-y">
          {deleted.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5 text-sm">
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">#{s.id}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{s.url}</span>
              <Badge tone="danger" title="Deleted in Network Admin and still in its sites table; its tables may be gone">deleted</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y">
          {shown.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5 text-sm">
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">#{s.id}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.title}
                  {s.archived && <Badge tone="warning" title="Archived in Network Admin: visitors see that it is archived; a super admin can still open its wp-admin">archived</Badge>}
                  {s.spam && <Badge tone="danger" title="Marked as spam in Network Admin">spam</Badge>}
                  {s.hidden && <Badge title="Public is off: search engines are asked not to index it">hidden from search</Badge>}
                  {s.served === false && <Badge tone="warning" title="Its host is not in this site's vhost or /etc/hosts, so it does not open here">not served here</Badge>}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{s.url}</span>
              </span>
              <span className="flex gap-2">
                <ButtonLink size="sm" variant="ghost" href={s.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open
                </ButtonLink>
                <Button size="sm" variant="ghost" onClick={() => void openWpAdmin(site, { siteUrl: s.url })}>
                  <LogIn />
                  wp-admin
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">
        {type === 'subdirectory'
          ? 'Subdirectory network: every site is under a path of one domain, so one name in the certificate and the hosts block covers them all.'
          : `${NETWORK_TYPE_LABEL[type]} network: every site on a host of its own needs that host in this site's vhost, certificate and hosts block.`}
        {' '}New sites go {network.mode === 'subdomain' ? 'on subdomains' : 'under paths'} (SUBDOMAIN_INSTALL is {network.mode === 'subdomain' ? 'on' : 'off'} in wp-config.php).
        {' '}Search and replace runs with --network.
      </p>
      <SuperAdminsDialog site={site} open={admins} onClose={() => setAdmins(false)} />
    </Card>
  );
}

/** A network's super admins, each with how many sites they have a role on, and a button that gives one the administrator role on the rest. */
function SuperAdminsDialog({ site, open, onClose }: { site: Site; open: boolean; onClose: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const list = useAsync(() => (open ? api.networkAdmins(site.domain, site.path) : Promise.resolve(null)), [open, refresh, site.domain, site.path]);
  const runner = useJob();
  const [open_, setOpen] = useState<string | null>(null);
  const lastDone = useRef<string | null>(null);
  const { job } = runner;
  const busy = job !== null && !settled(job);
  useEffect(() => {
    if (!job || !settled(job) || lastDone.current === job.id) return;
    lastDone.current = job.id;
    setRefresh((n) => n + 1);
  }, [job]);
  const data = list.data;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Super admins"
      description="A super admin manages every site of the network, but My Sites and plugins that look for the administrator role only see the sites where they have one. Make administrator adds that role where they have no role yet; roles they have stay, and Undo on the job takes them off the sites it added them to."
    >
      <div className="mt-4 grid gap-3">
        {list.loading && !data && <ListSkeleton rows={2} />}
        {list.error && <p role="alert" className="text-sm text-danger">{list.error}</p>}
        {data && data.admins.length === 0 && <p className="text-sm text-muted-foreground">This network has no super admins WP-CLI can find.</p>}
        {data && data.admins.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {data.admins.map((a) => (
              <li key={a.login} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.login}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.member >= data.sites ? `A role on all ${data.sites} sites` : `A role on ${a.member} of ${data.sites} sites`}
                  </span>
                </span>
                {a.member < data.sites ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void runner.follow(api.startJob('network.addAdmin', { ...siteTarget(site), user: a.login }))}>
                    {busy && job?.title.includes(` ${a.login} `) ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
                    Make administrator on {data.sites - a.member} more
                  </Button>
                ) : (
                  <Check className="size-4 text-success" />
                )}
              </li>
            ))}
          </ul>
        )}
        {job && <StepList steps={job.steps} open={open_} setOpen={setOpen} />}
        {job && settled(job) && job.undoable.length > 0 && (
          <p className="text-xs text-muted-foreground">
            To take it back, use Undo on <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-foreground hover:underline">the job&apos;s page</Link>.
          </p>
        )}
        {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Hosts typed one per line (or separated by spaces or commas), lowercase, without repeats. */
const hostList = (text: string) => [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))];

function LocalModeCard({ site, localMode, onChanged }: { site: Site; localMode: SiteLocalMode; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(localMode.enabled);
  const [hosts, setHosts] = useState((localMode.enabled ? localMode.blockedHosts : LOCAL_MODE_DEFAULT_BLOCKED_HOSTS).join('\n'));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  const list = hostList(hosts);
  const changed = enabled && localMode.enabled && list.join(' ') !== localMode.blockedHosts.join(' ');

  async function apply(on: boolean) {
    setBusy(true);
    setResult(null);
    setEnabled(on);
    try {
      const r = await api.runAction('site.setLocalMode', { ...siteTarget(site), enabled: on, ...(on ? { blockedHosts: list } : {}) });
      setResult({ name: 'Local mode', ok: r.ok, output: r.output });
      if (r.ok) onChanged();
      else setEnabled(localMode.enabled);
    } catch (error) {
      setResult({ name: 'Local mode', ok: false, output: (error as Error).message });
      setEnabled(localMode.enabled);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Local mode</CardTitle><ShieldCheck className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Keep this copy away from real people</p>
            <p className="text-xs text-muted-foreground">
              Mail goes to <a href={MAILPIT_WEB} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">Mailpit</a>
              (<Link href={`/mail?site=${encodeURIComponent(site.domain)}`} className="underline-offset-2 hover:underline">see this site&apos;s mail</Link>),
              search engines are told not to index, a Local label shows in the admin bar, logins work from this computer only and the hosts below are blocked.
            </p>
          </div>
          <span className="flex items-center gap-2">
            {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
            <Switch checked={enabled} onChange={(v) => void apply(v)} label="Local mode" disabled={busy} />
          </span>
        </div>
        <Field
          label="Blocked hosts"
          htmlFor="blocked-hosts"
          hint="One per line; a host also blocks its subdomains. WordPress requests to them fail instead of reaching the live service. Payment sandboxes stay reachable unless you add them."
        >
          <Textarea id="blocked-hosts" className="font-mono text-[13px]" rows={5} value={hosts} onChange={(e) => setHosts(e.target.value)} disabled={busy} spellCheck={false} />
        </Field>
        {changed && (
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void apply(true)}>Save blocked hosts</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setHosts(localMode.blockedHosts.join('\n'))}>Undo changes</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The plugin is <code className="font-mono">wp-content/mu-plugins/devmagic-panel-local.php</code>, kept out of git, and does nothing on a non-local address.
        </p>
        {result && <RunOutput result={result} />}
      </div>
    </Card>
  );
}

/**
 * Where missing uploads load from: a redirect (the panel's vhost for sites it
 * made, Local mode for vhosts made by hand), or BE Media from Production when
 * the site has it, which needs neither.
 */
function UploadsCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const current = site.uploadsFrom?.host ?? '';
  const currentVia: 'redirect' | 'plugin' = site.uploadsFrom?.via === 'plugin' ? 'plugin' : 'redirect';
  const [host, setHost] = useState(current || site.mediaPlugin?.host || '');
  const [via, setVia] = useState<'redirect' | 'plugin'>(site.mediaPlugin ? (site.uploadsFrom ? currentVia : 'plugin') : 'redirect');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  useEffect(() => setHost(current || site.mediaPlugin?.host || ''), [current, site.mediaPlugin?.host]);
  const value = host.trim().toLowerCase();
  const valid = value === '' || hostname.safeParse(value).success;
  const needsLocalMode = via === 'redirect' && (!site.vhostManaged || Boolean(site.path)) && !site.localMode?.enabled;
  const changed = value !== '' && (value !== current || via !== currentVia);

  async function apply(next: string | null, how: 'redirect' | 'plugin') {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.runAction('site.setUploadsFrom', { ...siteTarget(site), host: next, via: how });
      setResult({ name: 'Uploads', ok: r.ok, output: r.output });
      if (r.ok) onChanged();
    } catch (error) {
      setResult({ name: 'Uploads', ok: false, output: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const redirectHint = site.vhostManaged && !site.path ? 'The vhost sends a missing file under wp-content/uploads to the same path there.' : 'Local mode sends a missing file under wp-content/uploads to the same path there (this vhost was made by hand, so the panel does not edit it).';

  return (
    <Card>
      <CardHeader><CardTitle>Uploads</CardTitle><ImageIcon className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-4 p-5">
        <p className="text-sm text-muted-foreground">
          {site.uploadsFrom ? (
            <>
              Missing uploads load from <span className="font-mono text-[13px] text-foreground">{site.uploadsFrom.host}</span>, through{' '}
              {site.uploadsFrom.via === 'apache' ? 'the vhost' : site.uploadsFrom.via === 'plugin' ? <>BE Media from Production (<code className="font-mono text-[13px]">BE_MEDIA_FROM_PRODUCTION_URL</code> in wp-config.php)</> : 'Local mode'}.
            </>
          ) : (
            'Missing uploads show as broken images. Name the production host to load them from there instead of copying them.'
          )}
          {site.mediaPlugin && site.mediaPlugin.active === false && site.uploadsFrom?.via !== 'plugin' && ' BE Media from Production is in the site but turned off.'}
        </p>
        {site.mediaPlugin && (
          <div role="radiogroup" aria-label="How missing uploads load" className="grid gap-2">
            {([
              ['plugin', 'BE Media from Production', 'The plugin in the site loads them; no vhost change and no Local mode needed.'],
              ['redirect', site.vhostManaged && !site.path ? 'Redirect in the vhost' : 'Redirect in Local mode', redirectHint],
            ] as const).map(([option, label, hint]) => (
              <label key={option} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', via === option && 'border-primary bg-primary/5')}>
                <input type="radio" name="uploads-via" checked={via === option} onChange={() => setVia(option)} className="mt-0.5 accent-[var(--primary)]" />
                <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
              </label>
            ))}
          </div>
        )}
        <Field
          label="Production host"
          htmlFor="uploads-host"
          hint={needsLocalMode ? 'This redirect needs Local mode: turn it on first, or use BE Media from Production.' : site.mediaPlugin ? undefined : redirectHint}
        >
          <Input id="uploads-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.example.com" className="font-mono text-[13px]" spellCheck={false} disabled={busy || needsLocalMode} aria-invalid={!valid || undefined} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {changed && (
            <Button variant="outline" disabled={busy || !valid || needsLocalMode} onClick={() => void apply(value, via)}>
              {busy && <LoaderCircle className="animate-spin" />}
              {current ? (via !== currentVia ? (via === 'plugin' ? 'Use BE Media from Production' : 'Use the redirect') : 'Change host') : 'Load from this host'}
            </Button>
          )}
          {current && (
            <Button variant="ghost" disabled={busy} onClick={() => void apply(null, currentVia)}>Stop loading from production</Button>
          )}
        </div>
        {result && <RunOutput result={result} />}
      </div>
    </Card>
  );
}

function RunOutput({ result }: { result: { name: string; ok: boolean; output: string } }) {
  return (
    <details className={cn('min-w-0 rounded-md border px-3 py-2 text-sm', result.ok ? 'border-success/30 bg-success/6' : 'border-danger/30 bg-danger/6')} open={!result.ok}>
      <summary className="cursor-pointer">
        {result.ok ? `${result.name}: done` : `${result.name} failed: ${lastLine(result.output)}`}
      </summary>
      {/* Long lines wrap anywhere, so output like a diff's +---- bars never widens the card. */}
      <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{result.output ? <AnsiText text={result.output} /> : 'No output.'}</pre>
    </details>
  );
}

function FolderLine({ path }: { path: string }) {
  return (
    <span className="flex items-start justify-between gap-2">
      <span className="font-mono text-[13px] break-all">{path}</span>
      <a
        href={vscodeUrl(path)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={`Open ${path} in VS Code`}
      >
        <Code2 className="size-3.5" />
        VS Code
      </a>
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function LogsTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const source = useQueryParam('log') === 'apache' ? 'apache' : 'debug';
  const setSource = (next: 'debug' | 'apache') => navigate(tabHref(site, 'logs', next === 'apache' ? '&log=apache' : ''), { scroll: false });
  const log = useAsync(() => api.logs(site.domain, source, site.path), [site.domain, site.path, source]);
  return (
    <div className="grid gap-3">
      {site.core.kind !== 'none' && <DebugSettings site={site} onChanged={onChanged} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Log" className="inline-flex rounded-lg border bg-muted p-0.5 text-sm">
          {([['debug', 'debug.log'], ['apache', site.server === 'nginx' ? 'nginx errors' : 'Apache errors']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              onClick={() => setSource(value)}
              className={cn('rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground', source === value && 'bg-card text-foreground shadow-xs ring-1 ring-border')}
            >
              {label}
            </button>
          ))}
        </div>
        {log.data && <p className="font-mono text-xs break-all text-muted-foreground">{log.data.file}</p>}
      </div>
      {log.data?.shared && (
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          This site writes to Apache&apos;s shared error log, so only lines that mention its folder or domains are shown.
        </p>
      )}
      {log.data && !log.data.exists && <p className="text-sm text-muted-foreground">The log file does not exist yet.</p>}
      {log.error && <p role="alert" className="text-sm text-danger">{log.error}</p>}
      {log.loading && !log.data ? (
        <LogSkeleton />
      ) : (
        <LogView
          lines={log.data?.lines ?? []}
          {...(source === 'debug' && log.data?.exists
            ? { onClear: () => void runWithToast('site.clearDebugLog', siteTarget(site), 'debug.log cleared').then(() => log.reload()) }
            : {})}
        />
      )}
    </div>
  );
}

function DomainsTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const names = [site.domain, ...site.aliases];
  const inCert = new Set(site.cert?.names ?? []);
  const missingHosts = new Set(site.notInHosts ?? []);
  const allCovered = names.every((n) => inCert.has(n));
  const [reissuing, setReissuing] = useState(false);

  async function reissue() {
    setReissuing(true);
    await runWithToast('cert.reissue', { domain: site.domain }, `Certificate reissued for ${site.domain}`);
    setReissuing(false);
    onChanged();
  }

  return (
    <div className="grid gap-4">
      {!site.path && <ServerCard site={site} onChanged={onChanged} />}
      <Card>
        <CardHeader>
          <CardTitle>Certificate</CardTitle>
          <ShieldCheck className="size-4 text-muted-foreground" />
        </CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-4 p-5 text-sm">
          <div className="grid gap-1">
            <p>
              {site.cert?.issuer === 'legacy' ? (
                <Badge tone="warning">Old LocalhostCA</Badge>
              ) : (
                <Badge tone="success">devmagic-panel CA</Badge>
              )}
              <span className="ml-2 text-muted-foreground">valid until {site.cert ? shortDate(site.cert.expiresAt) : 'unknown'}</span>
            </p>
            <p className="text-muted-foreground">
              Covers {inCert.size} of {names.length} names{allCovered ? '' : ', reissue to cover all of them'}.
            </p>
          </div>
          <Button variant={allCovered && site.cert?.issuer !== 'legacy' ? 'outline' : 'default'} disabled={reissuing} onClick={() => void reissue()}>
            {reissuing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Reissue certificate
          </Button>
        </div>
      </Card>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 font-medium">Domain</th>
              <th className="px-3 py-2.5 text-center font-medium">In cert</th>
              <th className="px-3 py-2.5 text-center font-medium">In hosts</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {names.map((name, i) => (
              <tr key={name}>
                <td className="px-5 py-2.5 font-mono text-[13px]">
                  {name}
                  {i === 0 && <Badge className="ml-2 font-sans">primary</Badge>}
                </td>
                <td className="px-3 py-2.5 text-center"><Yes ok={inCert.has(name)} /></td>
                <td className="px-3 py-2.5 text-center"><Yes ok={!missingHosts.has(name)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {site.vhostManaged ? (
        <p className="text-xs text-muted-foreground">
          One certificate, one {site.server === 'nginx' ? 'nginx site' : 'vhost'} and one hosts line cover all of these names. Add or remove domains and the panel updates all three together.
        </p>
      ) : (
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          This vhost was set up outside the panel, so the panel leaves <code className="font-mono text-[13px]">{site.domain}-ssl.conf</code> as it is.
          It still reissues the certificate and keeps the hosts line in its block. To change the domains, edit the vhost by hand.
        </p>
      )}
    </div>
  );
}

function Yes({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="mx-auto size-4 text-success" aria-label="Yes" />
  ) : (
    <X className="mx-auto size-4 text-danger" aria-label="No" />
  );
}

function RemoveDialog({ site, open, onClose }: { site: Site; open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = useAsync(() => (open ? api.removal(site.domain) : Promise.resolve(null)), [open, site.domain]);
  const items = [
    `The folder ${site.docroot}`,
    'Its vhost and certificate',
    site.db ? `Database ${site.db.name}${site.panelMade ? ' and its user' : ''}` : null,
    site.panelMade ? 'Its /etc/hosts line' : null,
  ].filter(Boolean) as string[];
  // Work that exists only in this copy: it is in the archive, but worth a look before removing.
  const unsaved = siteRepos(site).flatMap(({ git: g, label }) => {
    const where = label === 'Site' ? 'the site' : label;
    return [
      g.dirty > 0 ? `${g.dirty} uncommitted change${g.dirty === 1 ? '' : 's'} in ${where}` : null,
      g.upstream === null ? `branch ${g.branch} in ${where} is not pushed` : g.ahead > 0 ? `${g.ahead} commit${g.ahead === 1 ? '' : 's'} in ${where} not pushed` : null,
    ].filter(Boolean) as string[];
  });
  const days = info.data?.trashDays ?? 14;
  const tight = info.data?.sizeBytes !== undefined && info.data.freeBytes !== undefined && info.data.freeBytes < info.data.sizeBytes * 1.2;

  // Follow the removal until it settles; then go back to the list.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') {
      if (job?.status === 'done') {
        toast({ tone: 'success', title: `${site.domain} removed`, detail: `It is kept in Removed sites for ${days} days, to restore.`, action: { label: 'Show', run: () => navigate('/sites?show=removed') } });
        navigate('/sites');
      }
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      loadThroughRestart(() => api.job(job.id), { stopped: () => !live }).then(
        (view) => live && setJob(view),
        (err: Error) => live && setError(err.message),
      );
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [job, site.domain, days]);

  async function remove() {
    setError(null);
    try {
      setJob(await api.job(await api.removeSite(site.domain)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function retry() {
    if (!job) return;
    try {
      setJob(await api.retryJob(job.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const running = job?.status === 'running';
  const failed = job?.steps.find((s) => s.status === 'failed');

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (running) return;
        setTyped('');
        onClose();
      }}
      title={`Remove ${site.domain}?`}
      description={`Everything below is archived first and kept in Removed sites, on the Sites page, for ${days} days, where you can restore it. Then it is removed:`}
    >
      {!job ? (
        <>
          <ul className="grid gap-1 text-sm">
            {items.map((item) => (
              <li key={item} className="flex items-start gap-2"><Trash2 className="mt-0.5 size-3.5 shrink-0 text-danger" />{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {info.data?.sizeBytes !== undefined ? `The archive takes about ${bytes(info.data.sizeBytes)} before compression` : 'Measuring the folder...'}
            {info.data?.freeBytes !== undefined ? `; ${bytes(info.data.freeBytes)} free.` : '.'}
            {!site.panelMade && ' Made outside the panel: hosts lines outside the panel\'s block stay as they are.'}
          </p>
          {tight && <p role="alert" className="mt-2 text-sm text-danger">There may not be enough free disk space for the archive.</p>}
          {unsaved.length > 0 && (
            <div className="mt-3 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
              <p className="font-medium">Work that is only in this copy</p>
              <ul className="mt-1 list-disc pl-5 text-xs">{unsaved.map((u) => <li key={u}>{u}</li>)}</ul>
              <p className="mt-1 text-xs text-muted-foreground">It stays in the archive, but push it first if you can.</p>
            </div>
          )}
          <ConfirmField className="mt-4" id="confirm-domain" expected={site.domain} value={typed} onChange={setTyped} />
        </>
      ) : (
        <ol className="grid gap-1.5 text-sm">
          {job.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              {s.status === 'running' ? <LoaderCircle className="size-4 animate-spin text-primary" /> : s.status === 'done' ? <Check className="size-4 text-success" /> : s.status === 'failed' ? <X className="size-4 text-danger" /> : <span className="size-4 rounded-full border-2 border-muted-foreground/30" />}
              <span className={cn(s.status === 'pending' && 'text-muted-foreground', s.status === 'failed' && 'text-danger')}>{s.label}</span>
            </li>
          ))}
        </ol>
      )}
      {failed?.output && <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-danger">{lastLine(failed.output)}</pre>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        {!running && (
          <Button variant="ghost" onClick={() => { setTyped(''); setJob(null); onClose(); }}>
            {job ? 'Close' : 'Cancel'}
          </Button>
        )}
        {!job && (
          <Button variant="danger" disabled={typed !== site.domain} onClick={() => void remove()}>
            <Trash2 />
            Archive and remove
          </Button>
        )}
        {job?.status === 'failed' && (
          <Button onClick={() => void retry()}>
            <RefreshCw />
            Retry from the failed step
          </Button>
        )}
      </div>
    </Dialog>
  );
}

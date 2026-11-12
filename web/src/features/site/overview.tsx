import { Tabs } from '@/components/ui/tabs';
import type { ActionId, Site, SiteGit, SiteLocalMode, WpCronReport, WpDebugConstant } from '@devmagic-panel/shared';
import { TakeoverCard } from '@/features/site/takeover-card';
import { WordPressSummary } from '@/features/site/wordpress-summary';
import { GitTidyDialog } from '@/features/site/git-tidy';
import { branchWebUrl, commitWebUrl, hostname, LOCAL_MODE_DEFAULT_BLOCKED_HOSTS, MAILPIT_WEB, repoWeb, sameRepo, siteRepos, subjectLinks, WP_DEBUG_CONSTANTS } from '@devmagic-panel/shared';
import { ArrowDownToLine, Check, Code2, Eraser, FolderGit2, FolderOpen, GitBranch, Image as ImageIcon, KeyRound, Layers, RefreshCw, ShieldCheck, SkipForward, Sparkles, SquareTerminal, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Bar } from '@/components/layout/skeletons';
import { AnsiText } from '@/components/layout/ansi-text';
import { BranchPicker, PullBadge } from '@/features/site/branch-picker';
import { coreLabel, installLabel, NETWORK_TYPE_LABEL, vscodeUrl } from '@/components/layout/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { Notice } from '@/components/ui/notice';
import { StatTile } from '@/components/ui/stat-tile';
import { Switch } from '@/components/ui/switch';
import { TextLink } from '@/components/ui/text-link';
import { lastLine, runWithToast } from '@/lib/site-actions';
import { api } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { type AsyncState, useAsync } from '@/lib/use-async';
import { SaltsConfirm, saltsSummary } from '@/features/site/config';
import { siteTarget } from '@/lib/site-ref';
import { debugLabel, debugValues, siteTabItems, type Tab, uncoveredNames } from '@/lib/site-tabs';
import { filesHref } from '@/lib/file-links';
import { tileSpan } from '@/lib/tile-span';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { SERVER_NAME } from './site-shared';

export const DEBUG_HINT: Record<WpDebugConstant, string> = {
  WP_DEBUG: 'Debug mode; the settings below need it',
  WP_DEBUG_LOG: 'Write errors to wp-content/debug.log',
  WP_DEBUG_DISPLAY: 'Show errors on the page',
  SCRIPT_DEBUG: 'Load the unminified core JS and CSS',
  SAVEQUERIES: 'Record database queries, for Query Monitor',
};

export const DEBUG_PRESETS: Array<{ label: string; constants: Partial<Record<WpDebugConstant, boolean>> }> = [
  { label: 'Log only', constants: { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false } },
  { label: 'Off', constants: { WP_DEBUG: false } },
];

/**
 * Debug mode for the Logs tab, next to the log it fills: where errors go now, the two presets, and each
 * constant on its own, as wp-config.php has it. Apply sends only what changed.
 */
export function DebugSettings({ site, onChanged }: { site: Site; onChanged: () => void }) {
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
          {busy && <Spinner className="size-4 text-muted-foreground" />}
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
              label={<code className="font-mono text-dense">{n}</code>}
              hint={`${DEBUG_HINT[n]}${site.debug.constants[n] === null ? ' (default)' : ''}`}
            />
          ))}
        </fieldset>
        {Object.keys(changed).length > 0 && (
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void apply(changed)}>Apply</Button>
            <Button size="sm" variant="soft" disabled={busy} onClick={() => setWanted(current)}>Reset</Button>
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
export function Tile({ label, value, detail, tone, loading, onOpen, className }: { label: string; value?: string; detail?: string; tone?: 'warning' | 'danger'; loading?: 'value' | 'detail'; onOpen: () => void; className?: string }) {
  return (
    <StatTile
      label={label}
      value={loading === 'value' ? <Bar className="my-0.5 h-4 w-20" /> : value}
      sub={loading ? <span className="flex h-4 items-center"><Bar className="h-2.5 w-24" /><span className="sr-only">Reading...</span></span> : detail}
      tone={tone ?? 'neutral'}
      onClick={onOpen}
      className={cn('px-4 py-3', className)}
    />
  );
}

/** The facts from the other tabs a site has, each opening its tab. */
export function SiteTiles({ site, cron, logErrors, onOpen }: { site: Site; cron: AsyncState<WpCronReport | null>; logErrors: number | undefined; onOpen: (tab: Tab) => void }) {
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
  if (tabs.has('php')) {
    // The web server and PHP together, as their tab has them: the first thing to check when a site behaves differently.
    const server = SERVER_NAME[site.server];
    tiles.push({
      key: 'php',
      label: site.php ? 'Server and PHP' : 'Server',
      value: site.php ? `${server} · PHP ${site.php.version}` : server,
      detail: site.php ? (site.php.own ? 'Its own PHP version' : 'The default PHP version') : 'The web server it runs on',
      onOpen: () => onOpen('php'),
    });
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
  // The tiles fill their rows: all in one row once the column has room, else rows of three (two
  // on a phone) with the last row's tiles sharing it, so no row stops short of the cards below.
  const wide = tiles.length > 5 ? ONE_ROW.xl4 : ONE_ROW.xl3;
  return (
    <div className={cn('grid grid-cols-6 gap-3', wide.grid)}>
      {tiles.map(({ key, ...tile }, i) => <Tile key={key} {...tile} className={cn(tileSpan(i, tiles.length), wide.tile)} />)}
    </div>
  );
}

const ONE_ROW = {
  xl3: { grid: '@3xl:grid-flow-col @3xl:grid-cols-none @3xl:auto-cols-fr', tile: '@3xl:col-span-1' },
  xl4: { grid: '@4xl:grid-flow-col @4xl:grid-cols-none @4xl:auto-cols-fr', tile: '@4xl:col-span-1' },
};


/**
 * A site at a glance: the facts from its other tabs, then what you do most (git, quick actions, the core),
 * Local mode and uploads, and where its files are. Settings live in their tabs.
 */
export function Overview({ site, onChanged, onOpen, cron, logErrors }: { site: Site; onChanged: () => void; onOpen: (tab: Tab) => void; cron: AsyncState<WpCronReport | null>; logErrors: number | undefined }) {
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
  // A site with several repos shows one at a time in the Git card, so the card fits the window.
  const repoKey = (r: (typeof repos)[number]) => `${r.mount ?? ''}:${r.repo ?? ''}`;
  const [repoAt, setRepoAt] = useState<string | null>(null);
  const openRepo = repos.find((r) => repoKey(r) === repoAt) ?? repos[0];
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
        <Notice tone="warning" icon={false}>
          <p className="flex items-center gap-2 font-medium"><SkipForward className="size-4 text-warning" />Skipped when it was installed</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Did one yourself? Mark it done to take it off this list. The job and Run history keep it as skipped.</p>
          <ul className="mt-2 grid gap-2">
            {site.install.skipped.map((s) => (
              <li key={s.label} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
                <span className="min-w-0 flex-1 basis-64">
                  <span className="font-medium">{s.label}.</span> <span className="break-words text-muted-foreground">{s.todo}</span>
                </span>
                <Button size="sm" variant="outline" disabled={marking !== null} onClick={() => void markDone(s.label)} aria-label={`Mark ${s.label} done`}>
                  {marking === s.label ? <Spinner /> : <Check />}
                  Done
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <SiteTiles site={site} cron={cron} logErrors={logErrors} onOpen={onOpen} />

      {/* Git first, across the row: what you use most, with room for its commits beside the branch. */}
      {repos.length > 0 && (
        <Card>
          <CardHeader
            title="Git"
            meta={
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {repos.length > 1 && `${repos.length} repos`}
                <GitBranch className="size-4" />
              </span>
            }
          />
          {repos.length > 1 && openRepo && (
            <Tabs size="sm" label="Repos" className="px-3" value={repoKey(openRepo)} onChange={setRepoAt} items={repos.map((r) => ({ value: repoKey(r), label: r.label }))} />
          )}
          <div className="divide-y">
            {repos.filter((r) => r === openRepo).map((r) => (
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

      {/* Two columns once there is room, each pair of cards as tall as each other: the cards come in
          pairs of a kind and a size (the quick actions and WordPress, Local mode and uploads,
          taking over and the files), and a card left alone takes the whole row. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-2 @3xl:[&>:last-child:nth-child(odd)]:col-span-2">

          <Card>
            <CardHeader title="Quick actions" meta={<Wrench className="size-4 text-muted-foreground" />} />
            <CardBody className="grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {([
                { name: 'Clear all caches', icon: <Eraser />, id: 'site.clearCache' },
                { name: 'Flush rewrite rules', icon: <RefreshCw />, id: 'site.flushRewrites' },
              ] as const).map(({ name, icon, id }) => (
                <Button key={name} variant="outline" className="justify-start" disabled={busy !== null} onClick={() => void run(name, id, siteTarget(site))}>
                  {busy === name ? <Spinner /> : quickResult?.name === name && quickResult.ok ? <Check className="text-success" /> : icon}
                  {name}
                </Button>
              ))}
              {salts && (
                <Button variant="outline" className="justify-start" disabled={busy !== null} onClick={() => setSalting(salts.bad.length > 0 ? 'missing' : 'all')}>
                  {busy === saltsName ? <Spinner /> : quickResult?.name === saltsName && quickResult.ok ? <Check className="text-success" /> : <KeyRound />}
                  {saltsName}
                </Button>
              )}
              <Button variant="outline" className="justify-start" disabled={busy !== null} onClick={() => void run(terminalName, 'site.openTerminal', siteTarget(site))}>
                {busy === terminalName ? <Spinner /> : <SquareTerminal />}
                {terminalName}
              </Button>
              <p className="col-span-full text-xs text-muted-foreground">
                Clearing caches runs <code className="font-mono">wp cache flush</code>, deletes transients and reloads Apache to reset OPcache.
              </p>
              {quickResult && <div className="col-span-full"><RunOutput result={quickResult} /></div>}
            </CardBody>
          </Card>

          {site.core.kind !== 'none' && (
            <Card>
              <CardHeader title="WordPress" meta={<Layers className="size-4 text-muted-foreground" />} />
              <CardBody>
                <p className="text-sm">{coreLabel(site)}</p>
                <WordPressSummary site={site} />
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
                          {busy === 'Switch core' ? <Spinner /> : <Layers />}
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
              </CardBody>
            </Card>
          )}

        {site.localMode && <LocalModeCard site={site} localMode={site.localMode} onChanged={onChanged} />}

        {site.localMode && <UploadsCard site={site} onChanged={onChanged} />}

        <TakeoverCard site={site} onChanged={onChanged} />

        <Card>
          <CardHeader
            title="Files"
            actions={
              <TextLink href={filesHref(site)} className="gap-1.5 text-xs">
                <FolderOpen className="size-4" />Open in Files
              </TextLink>
            }
          />
          <CardBody>
            <KeyValue
              labelWidth="sm"
              className="gap-y-3"
              rows={[
                { label: 'Installed', value: installLabel(site.install) },
                { label: 'Folder', value: <FolderLine path={site.docroot} files={filesHref(site)} /> },
                ...(site.mounts ?? []).map((m) => ({ key: `mount:${m.path}`, label: m.path, value: <FolderLine path={m.docroot} files={filesHref({ domain: site.domain, path: m.path })} /> })),
                ...(site.prodUrl ? [{ label: 'Production', value: <a href={site.prodUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{site.prodUrl}</a> }] : []),
              ]}
            />
          </CardBody>
        </Card>
      </div>

      <SaltsConfirm mode={salting} onClose={() => setSalting(null)} onConfirm={(only) => void run(saltsName, 'site.shuffleSalts', { ...siteTarget(site), only })} />
    </div>
  );
}

export function RepoSection({ domain, mount, repo, label, folder, git, installedFrom = false, onChanged }: {
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
  const [tidying, setTidying] = useState(false);
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
    // Across the whole row from @3xl: the branch and what you do with it on the left, its recent commits on the right.
    <section className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 p-5 text-sm @3xl:grid-cols-2" aria-label={`${label} repository`}>
      <div className="grid content-start gap-3">
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
              {busy === 'Switch' ? <Spinner /> : <GitBranch />}
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
            {busy === 'Pull' ? <Spinner /> : <ArrowDownToLine />}
            {git.behind > 0 ? `Pull ${git.behind}` : 'Pull'}
          </Button>
          <Button variant="outline" className="h-10" disabled={busy !== null} title="Fetch branches and commits from origin" onClick={() => void run('Fetch', 'git.fetch', target)}>
            <RefreshCw className={cn(busy === 'Fetch' && 'animate-spin')} />
            Fetch
          </Button>
          <Button variant="outline" className="h-10" disabled={busy !== null} title="Delete branches gone from origin and pack the repo smaller" onClick={() => setTidying(true)}>
            <Sparkles />
            Tidy up
          </Button>
        </div>
        {tidying && (
          <GitTidyDialog
            target={target}
            label={label}
            onClose={() => setTidying(false)}
            onDone={(r) => {
              setResult(r);
              onChanged();
              details.reload();
            }}
          />
        )}
        {branch !== git.branch && git.dirty > 0 && (
          <p className="-mt-1 text-xs text-warning">Commit or stash the {git.dirty} uncommitted change{git.dirty === 1 ? '' : 's'} before switching.</p>
        )}
        {result && <RunOutput result={result} />}

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
      </div>

      <ol aria-label="Recent commits" className="grid content-start gap-2 rounded-lg bg-muted px-3 py-2.5">
        {commits.slice(0, 5).map((c) => (
          <li key={c.hash}>
            <p className="font-medium break-words">
              {subjectLinks(git.remote, c.subject).map((part, i) =>
                part.href ? <TextLink key={i} href={part.href}>{part.text}</TextLink> : part.text,
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <CommitHash remote={git.remote} hash={c.hash} /> · {c.author} · {timeAgo(c.date)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What a `git status --porcelain` code means, for its tooltip. */
export function changeLabel(code: string): string {
  if (code === '??') return 'new file, not tracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

export function GitLinks({ remote, branch }: { remote: string | undefined; branch: string }) {
  const web = remote ? repoWeb(remote) : null;
  const branchUrl = remote ? branchWebUrl(remote, branch) : null;
  if (!web || !branchUrl) return <p className="text-xs text-muted-foreground">No remote named origin, so there is nothing to open online.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      <ButtonLink size="sm" variant="outline" href={branchUrl} target="_blank" rel="noopener noreferrer">
        <GitBranch />
        Open branch on {web.name}
      </ButtonLink>
      <ButtonLink size="sm" variant="soft" href={web.repoUrl} target="_blank" rel="noopener noreferrer">
        <FolderGit2 />
        Repository
      </ButtonLink>
    </div>
  );
}

export function CommitHash({ remote, hash }: { remote: string | undefined; hash: string }) {
  const url = remote ? commitWebUrl(remote, hash) : null;
  if (!url) return <span className="font-mono">{hash}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-2 hover:text-foreground hover:underline">
      {hash}
    </a>
  );
}

/** Hosts typed one per line (or separated by spaces or commas), lowercase, without repeats. */
export const hostList = (text: string) => [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))];

export function LocalModeCard({ site, localMode, onChanged }: { site: Site; localMode: SiteLocalMode; onChanged: () => void }) {
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
      <CardHeader title="Local mode" meta={<ShieldCheck className="size-4 text-muted-foreground" />} />
      <CardBody>
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
            {busy && <Spinner className="size-4 text-muted-foreground" />}
            <Switch checked={enabled} onChange={(v) => void apply(v)} label="Local mode" disabled={busy} />
          </span>
        </div>
        <Field
          label="Blocked hosts"
          htmlFor="blocked-hosts"
          hint="One per line; a host also blocks its subdomains. WordPress requests to them fail instead of reaching the live service. Payment sandboxes stay reachable unless you add them."
        >
          <Textarea id="blocked-hosts" className="font-mono text-dense" rows={5} value={hosts} onChange={(e) => setHosts(e.target.value)} disabled={busy} spellCheck={false} />
        </Field>
        {changed && (
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void apply(true)}>Save blocked hosts</Button>
            <Button variant="soft" disabled={busy} onClick={() => setHosts(localMode.blockedHosts.join('\n'))}>Undo changes</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The plugin is <code className="font-mono">wp-content/mu-plugins/devmagic-panel-local.php</code>, kept out of git, and does nothing on a non-local address.
        </p>
        {result && <RunOutput result={result} />}
      </CardBody>
    </Card>
  );
}

/**
 * Where missing uploads load from: a redirect (the panel's vhost for sites it
 * made, Local mode for vhosts made by hand), or BE Media from Production when
 * the site has it, which needs neither.
 */
export function UploadsCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
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
      <CardHeader title="Uploads" meta={<ImageIcon className="size-4 text-muted-foreground" />} />
      <CardBody>
        <p className="text-sm text-muted-foreground">
          {site.uploadsFrom ? (
            <>
              Missing uploads load from <span className="font-mono text-dense text-foreground">{site.uploadsFrom.host}</span>, through{' '}
              {site.uploadsFrom.via === 'apache' ? 'the vhost' : site.uploadsFrom.via === 'plugin' ? <>BE Media from Production (<code className="font-mono text-dense">BE_MEDIA_FROM_PRODUCTION_URL</code> in wp-config.php)</> : 'Local mode'}.
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
          <Input id="uploads-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.example.com" className="font-mono text-dense" spellCheck={false} disabled={busy || needsLocalMode} aria-invalid={!valid || undefined} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {changed && (
            <Button variant="outline" disabled={busy || !valid || needsLocalMode} onClick={() => void apply(value, via)}>
              {busy && <Spinner />}
              {current ? (via !== currentVia ? (via === 'plugin' ? 'Use BE Media from Production' : 'Use the redirect') : 'Change host') : 'Load from this host'}
            </Button>
          )}
          {current && (
            <Button variant="soft" disabled={busy} onClick={() => void apply(null, currentVia)}>Stop loading from production</Button>
          )}
        </div>
        {result && <RunOutput result={result} />}
      </CardBody>
    </Card>
  );
}

export function RunOutput({ result }: { result: { name: string; ok: boolean; output: string } }) {
  return (
    <Notice tone={result.ok ? 'success' : 'danger'} size="inline" icon={false} className="min-w-0 text-sm">
      <details open={!result.ok}>
        <summary className="cursor-pointer">
          {result.ok ? `${result.name}: done` : `${result.name} failed: ${lastLine(result.output)}`}
        </summary>
        {/* Long lines wrap anywhere, so output like a diff's +---- bars never widens the card. */}
        <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{result.output ? <AnsiText text={result.output} /> : 'No output.'}</pre>
      </details>
    </Notice>
  );
}

/** A folder, with links to it in the Files tab (when it is a site's) and in VS Code. */
export function FolderLine({ path, files }: { path: string; files?: string }) {
  const link = 'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
  return (
    <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
      <span className="min-w-0 flex-[1_1_14rem] font-mono text-dense break-all">{path}</span>
      <span className="flex shrink-0 items-center">
        {files && <Link href={files} className={link} title={`Open ${path} in the Files tab`}><FolderOpen className="size-3.5" />Files</Link>}
        <a href={vscodeUrl(path)} className={link} title={`Open ${path} in VS Code`}>
          <Code2 className="size-3.5" />
          VS Code
        </a>
      </span>
    </span>
  );
}

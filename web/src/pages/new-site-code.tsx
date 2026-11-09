import type { ClaudeRun, OrgRepo, OrgRepoList, OrgScanMode, OrgStatus, RepoTrustAnswer, Site, UseClaude } from '@devmagic-panel/shared';
import { branchName, gitUrl, isShared, namespaceLabel, namespaceShortLabel, parseNamespaceRef, placementWarnings, REPO_KIND_LABELS, repoWeb, sameRepo } from '@devmagic-panel/shared';
import { Check, CircleAlert, FolderGit2, FolderTree, LoaderCircle, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Star, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BranchPicker } from '@/components/branch-picker';
import { CLAUDE_EFFORT_LABELS, CLAUDE_MODEL_LABELS, ClaudeRunFields } from '@/components/claude-run-fields';
import { PlacementFields, placementError } from '@/components/repo-placement';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { pastedRepo } from '@/lib/org-repos';
import { allRows, isPicked, makeMain, shownOrder, pickRepo, placementOf, planLines, type RepoRow, rowPlacement, rowsProblem, unpickRepo, updateRow } from '@/lib/project-repos';
import { cn } from '@/lib/utils';
import type { WizardState } from './new-site';
import { cliSignedIn, CliHints, OrgPicker, RepoLink } from './new-site-org';

type SetState = (update: (s: WizardState) => WizardState) => void;

/** Every picked repo with where it goes, the main one first. */
export function placedRows(s: WizardState) {
  return allRows(s).map((r, i) => ({ ...r, placement: i === 0 ? placementOf(s) : rowPlacement(r) }));
}

/** Why the Code step cannot continue, or null: a repo with no branch, a folder that does not work, two at one path, a repo not trusted. */
export function codeProblem(s: WizardState): string | null {
  const rows = placedRows(s);
  if (rows.length === 0) return 'Pick the repo of the site';
  for (const r of rows) {
    if (!gitUrl.safeParse(r.url).success) return `${r.url} is not a git URL`;
    if (!branchName.safeParse(r.branch).success) return `Pick a branch of ${r.fullName ?? r.url}`;
    const bad = placementError(r.placement);
    if (bad) return `${r.fullName ?? r.url}: ${bad}`;
  }
  const clash = rowsProblem(rows);
  if (clash) return clash;
  const untrusted = rows.find((r) => s.trust[r.url]?.trusted === false);
  if (untrusted) return `Trust ${s.trust[untrusted.url]?.owner?.owner ?? 'the owner'} first, or leave ${untrusted.fullName ?? untrusted.url} out`;
  if (rows.some((r) => !s.trust[r.url])) return 'Checking the repos...';
  return null;
}

/**
 * Reads what each added repo needs in the background, wherever the wizard
 * is: its branches, then what its branch holds (helpers, builds, kind), and
 * whether every picked repo may run here. The main repo's own lookups stay
 * with the page.
 */
export function useRepoLookups(state: WizardState, setState: SetState) {
  const busy = useRef(new Set<string>());
  useEffect(() => {
    if (state.source !== 'repo') return;
    for (const row of state.extra) {
      const branchesKey = `branches|${row.url}`;
      if (row.branches === null && !busy.current.has(branchesKey) && gitUrl.safeParse(row.url).success) {
        busy.current.add(branchesKey);
        api.inspectRepo(row.url).then(
          (found) => setState((s) => updateRow(s, row.url, (r) => ({ ...r, branches: found.branches ?? [], ...(found.defaultBranch ? { defaultBranch: found.defaultBranch } : {}), branch: r.branch || found.branch }))),
          () => setState((s) => updateRow(s, row.url, (r) => ({ ...r, branches: [] }))),
        );
      }
      const key = `${row.url}|${row.branch}`;
      if (row.branch && row.helpers?.key !== key && !busy.current.has(key) && branchName.safeParse(row.branch).success) {
        busy.current.add(key);
        setState((s) => updateRow(s, row.url, (r) => ({ ...r, helpers: { key } })));
        api.repoHelpers(row.url, row.branch).then(
          ({ helpers: list, mediaPlugin, builds, kind, core, uploads, plugins }) =>
            setState((s) => updateRow(s, row.url, (r) => (r.helpers?.key !== key ? r : { ...r, helpers: { key, list, media: mediaPlugin, builds, ...(kind ? { kind } : {}), ...(core ? { core } : {}), ...(uploads ? { uploads } : {}), ...(plugins ? { plugins } : {}) } }))),
          (err: Error) => setState((s) => updateRow(s, row.url, (r) => (r.helpers?.key !== key ? r : { ...r, helpers: { key, error: err.message } }))),
        );
      }
    }
    for (const r of allRows(state)) {
      const trustKey = `trust|${r.url}`;
      if (state.trust[r.url] || busy.current.has(trustKey) || !gitUrl.safeParse(r.url).success) continue;
      busy.current.add(trustKey);
      api.repoTrust(r.url).then(
        (answer) => {
          busy.current.delete(trustKey);
          setState((s) => ({ ...s, trust: { ...s.trust, [r.url]: answer } }));
        },
        () => busy.current.delete(trustKey),
      );
    }
  }, [state.source, state.extra, state.repoUrl, state.trust]);
}

/**
 * The Code step: the repos of the site, picked from the lists gh and glab
 * read or pasted as any git URL, each with its branch and its folder in the
 * site. The lists come first and what is picked shows below them; the site
 * plan shows where it all goes.
 */
export function CodeStep({ state, setState, status, onRecheck, sites, mainExtras, side }: {
  state: WizardState;
  setState: SetState;
  status: OrgStatus | null;
  onRecheck: () => void;
  sites: Site[];
  /** Under the main repo: what was filled from its last install, and Describe the site to Claude. */
  mainExtras: ReactNode;
  /** The right column under the site plan: the Claude switch. */
  side: ReactNode;
}) {
  const rows = placedRows(state);
  const signedIn = status ? status.gh.signedIn || status.glab.hosts.some((h) => h.signedIn) : false;
  const listable = signedIn || (status?.settings.selected.length ?? 0) > 0;
  const [tab, setTab] = useState<'list' | 'paste'>(listable ? 'list' : 'paste');
  useEffect(() => {
    if (status && !listable) setTab('paste');
  }, [status, listable]);
  const pick = (repo: OrgRepo) => setState((s) => pickRepo(s, repo));
  const unpick = (url: string) => setState((s) => unpickRepo(s, url));
  const clash = rowsProblem(rows);
  const site = state.domains[0]?.local.trim() || 'local.your-site.test';

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] xl:gap-10">
      <div className="grid min-w-0 gap-6">
        <section aria-label="Add a repo" className="grid gap-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{rows.length === 0 ? 'Pick the repo' : 'Add a theme, plugin or other repo'}</h2>
            <Segmented label="Where from" value={tab} onChange={setTab} options={[['list', 'Your repos'], ['paste', 'Paste a URL']]} />
          </div>
          {tab === 'list' ? (
            <RepoList state={state} status={status} onRecheck={onRecheck} onPick={pick} onUnpick={unpick} />
          ) : (
            <PasteRepo onPick={(r) => pick(state.repoUrl.trim() ? { ...r, kind: 'other' } : r)} picked={(url) => isPicked(state, url)} />
          )}
        </section>

        <section aria-labelledby="picked-repos" className="grid gap-3">
          <h2 id="picked-repos" className="flex items-center gap-2 text-sm font-semibold">
            Repos of this site
            {rows.length > 0 && <Badge>{rows.length}</Badge>}
          </h2>
          {rows.length > 1 && (
            <p className="-mt-1 text-xs text-muted-foreground">
              The main repo is the project itself: it names the install, Claude reads its docs, and your answers are remembered under it for next time. The others are added to it. <span className="font-medium text-foreground">Make main</span> moves that role to another repo: every repo stays where it is in this list and in its own folder.
            </p>
          )}
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
              Pick the site's repo from your lists above, or paste any git URL. Add its themes and plugins the same way: each gets a folder of the site.
            </p>
          )}
          {shownOrder(rows, state.mainAt).map((row) => (
            <RepoCard
              key={row.url}
              row={row}
              main={row === rows[0]}
              state={state}
              setState={setState}
              site={site}
              sites={sites}
              onRemove={() => unpick(row.url)}
              {...(row === rows[0] ? { extras: mainExtras } : {})}
            />
          ))}
          {clash && <p role="alert" className="flex items-center gap-2 text-sm text-danger"><CircleAlert className="size-4" />{clash}</p>}
        </section>
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-4">
        <SitePlan state={state} />
        {side}
      </aside>
    </div>
  );
}

/** One picked repo: its branch, where it goes, what the lookup found, and whether it may run here. */
function RepoCard({ row, main, state, setState, site, sites, onRemove, extras }: {
  row: RepoRow & { placement: ReturnType<typeof placementOf> };
  main: boolean;
  state: WizardState;
  setState: SetState;
  site: string;
  sites: Site[];
  onRemove: () => void;
  extras?: ReactNode;
}) {
  const web = repoWeb(row.url);
  const kind = row.helpers?.kind ?? row.kind;
  const usedBy = sitesUsing(sites, row.url);
  const trust = state.trust[row.url];
  const setBranch = (branch: string) => setState((s) => (main ? { ...s, branch } : updateRow(s, row.url, (r) => ({ ...r, branch }))));
  const setPlacement = (placement: RepoRow['placement']) => setState((s) => (main ? { ...s, placement } : updateRow(s, row.url, (r) => ({ ...r, placement }))));
  const id = `branch-${row.url.replace(/[^\w-]/g, '-')}`;
  return (
    <div className={cn('grid gap-4 rounded-xl border bg-card p-4', main && 'border-primary/40')}>
      <div className="flex flex-wrap items-start gap-2">
        <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium break-all">{row.fullName ?? row.url}</span>
            {main && <Badge tone="primary">Main</Badge>}
            {kind && kind !== 'other' && <Badge>{REPO_KIND_LABELS[kind]}</Badge>}
          </span>
          {row.fullName && <span className="font-mono text-[12px] break-all text-muted-foreground">{row.url}</span>}
        </div>
        <div className="flex items-center gap-1">
          {web && <a href={web.repoUrl} target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline">Open on {web.name}</a>}
          {!main && (
            <Button size="sm" variant="ghost" title="Make this the project's repo: it names the install, Claude reads its docs and your answers are remembered under it. The main one now becomes an added repo; nothing moves in the list or in the folders." onClick={() => setState((s) => makeMain(s, row.url))}>
              <Star />
              Make main
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={`Leave ${row.fullName ?? row.url} out`} onClick={onRemove}>
            <X />
          </Button>
        </div>
      </div>

      {trust && !trust.trusted && <TrustCard url={row.url} trust={trust} onTrusted={() => setState((s) => ({ ...s, trust: {} }))} />}

      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <Field
          label="Branch"
          htmlFor={id}
          hint={row.branches === null ? 'Reading the branches...' : row.branches.length === 0 ? 'The branches could not be read: type one.' : row.branch === row.defaultBranch ? 'The default branch' : row.defaultBranch ? `The default branch is ${row.defaultBranch}` : undefined}
        >
          {row.branches && row.branches.length > 0 ? (
            <BranchPicker id={id} branches={row.branches.map((name) => ({ name, current: name === row.defaultBranch, remoteOnly: false }))} value={row.branch} onChange={setBranch} currentLabel="default" />
          ) : (
            <Input id={id} value={row.branch} onChange={(e) => setBranch(e.target.value.trim())} disabled={row.branches === null} placeholder={row.branches === null ? 'Reading...' : 'main'} className="font-mono text-[13px]" spellCheck={false} />
          )}
        </Field>
        <PlacementFields url={row.url} value={row.placement} onChange={setPlacement} site={site} sharedCore={state.coreMode === 'wpcore'} />
      </div>

      <LookupLine row={row} />
      {extras}

      {usedBy.length > 0 && (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          <p className="flex items-center gap-2 font-medium">
            <CircleAlert className="size-3.5 shrink-0 text-warning" />
            {usedBy.length === 1 ? 'A site on this machine already uses this repo:' : `${usedBy.length} sites on this machine already use this repo:`}
            {usedBy.map((u) => (
              <Link key={`${u.domain}${u.path ?? ''}`} href={siteHref(u)} className="font-mono hover:underline">{u.domain}{u.path ?? ''}</Link>
            ))}
          </p>
          <p className="mt-1 text-muted-foreground">Open it instead, or go on to set up a second copy, for example to test another branch next to it.</p>
        </div>
      )}
    </div>
  );
}

/** Existing sites (and their themes, plugins and folders under paths) whose git remote is this repo. */
export function sitesUsing(sites: Site[], url: string): Array<{ domain: string; path?: string; branch: string }> {
  if (!gitUrl.safeParse(url).success) return [];
  return sites.flatMap((site) => [
    ...(site.git?.remote && sameRepo(site.git.remote, url) ? [{ domain: site.domain, ...(site.path ? { path: site.path } : {}), branch: site.git.branch }] : []),
    ...(site.repos ?? []).flatMap((r) => (r.git.remote && sameRepo(r.git.remote, url) ? [{ domain: site.domain, ...(site.path ? { path: site.path } : {}), branch: r.git.branch }] : [])),
    ...(site.mounts ?? []).flatMap((m) => (m.git?.remote && sameRepo(m.git.remote, url) ? [{ domain: site.domain, path: m.path, branch: m.git.branch }] : [])),
  ]);
}

/** What the lookup of a repo's branch found, in one line. */
function LookupLine({ row }: { row: RepoRow }) {
  const h = row.helpers;
  if (!h) return null;
  if (!h.list && !h.error) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Looking into the branch for its builds and local helpers...</p>;
  if (h.error) return <p className="text-xs text-warning">Could not look into the branch: {h.error}</p>;
  const parts = [
    h.core ? `WordPress core${h.core.version ? ` ${h.core.version}` : ''}` : null,
    h.builds?.length ? `${h.builds.length} build${h.builds.length === 1 ? '' : 's'}` : null,
    h.list?.length ? `local helpers: ${h.list.join(', ')}` : null,
    h.uploads ? 'media in wp-content/uploads' : null,
  ].filter(Boolean);
  return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-3.5 text-success" />{parts.length ? `Holds ${parts.join(', ')}.` : 'Nothing to build, no local helpers.'}</p>;
}

/**
 * A repo outside your organizations and groups: its code runs here (PHP when
 * the site loads, builds as you), so its owner is trusted once, here or in
 * Settings, before the install takes it.
 */
function TrustCard({ url, trust, onTrusted }: { url: string; trust: RepoTrustAnswer; onTrusted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = trust.owner;
  async function go() {
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      await api.trustOwner(owner.host, owner.owner);
      onTrusted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div role="alert" className="grid gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        {owner ? `${owner.owner} on ${owner.host} is not one of your organizations or groups` : `${url} names no owner`}
      </p>
      <p className="text-xs text-muted-foreground">Code from this repo runs on this computer: its PHP when the site loads, and its composer and npm builds as you. Only go on with a repo you trust. Trusted owners are listed in Settings, to take back.</p>
      {owner && (
        <Button size="sm" variant="outline" className="w-fit" disabled={busy} onClick={() => void go()}>
          {busy && <LoaderCircle className="animate-spin" />}
          Trust repos from {owner.owner} on {owner.host}
        </Button>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Kinds the list shows: WordPress sites while there is no main repo, themes and plugins after. */
type ListKind = 'sites' | 'parts' | 'all';

/**
 * Your repos, as gh and glab list them: pick a namespace, filter, and tick
 * repos. Picked ones stay at the top of the list while you scroll, and a
 * filter never hides them.
 */
function RepoList({ state, status, onRecheck, onPick, onUnpick }: { state: WizardState; status: OrgStatus | null; onRecheck: () => void; onPick: (r: OrgRepo) => void; onUnpick: (url: string) => void }) {
  const selected = status?.settings.selected ?? [];
  const [current, setCurrent] = useState(state.org?.name || selected[0] || '');
  useEffect(() => {
    if (!current && selected[0]) setCurrent(selected[0]);
  }, [selected.join('|')]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ListKind>(state.repoUrl ? 'parts' : 'sites');
  // Once the site has its main repo, the list offers its themes and plugins.
  const hasMain = Boolean(state.repoUrl.trim());
  useEffect(() => {
    if (hasMain) setKind((k) => (k === 'sites' ? 'parts' : k));
  }, [hasMain]);
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState<OrgRepoList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<OrgScanMode | null>(null);
  const shown = useRef('');
  const signedIn = status ? cliSignedIn(status, current) : false;
  const anySignedIn = status ? status.gh.signedIn || status.glab.hosts.some((h) => h.signedIn) : false;

  async function scan(name: string, mode: OrgScanMode) {
    if (mode !== 'none') setScanning(mode);
    try {
      const r = await api.orgRepos(name, mode);
      if (shown.current === name) {
        setList(r);
        setListError(null);
      }
    } catch (e) {
      if (shown.current === name) setListError((e as Error).message);
    } finally {
      if (mode !== 'none' && shown.current === name) setScanning(null);
    }
  }
  useEffect(() => {
    shown.current = current;
    setList(null);
    setListError(null);
    if (!current) return;
    void scan(current, 'none').then(() => (signedIn ? scan(current, 'auto') : undefined));
  }, [current, signedIn]);

  const rows = allRows(state);
  const repos = list?.repos ?? [];
  const picked = repos.filter((r) => isPicked(state, r.sshUrl));
  const rest = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fits = (r: OrgRepo) => (kind === 'all' ? true : kind === 'sites' ? r.kind === 'site' || r.kind === 'wp-content' : r.kind === 'theme' || r.kind === 'plugin' || r.kind === 'other');
    return repos.filter((r) => !isPicked(state, r.sshUrl) && fits(r) && (!q || `${r.fullName} ${r.description ?? ''}`.toLowerCase().includes(q)));
  }, [list, query, kind, rows.length]);

  if (!status) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Checking the GitHub CLI and the GitLab CLI...</p>;
  if (!anySignedIn && selected.length === 0) {
    return (
      <div className="grid gap-2 text-sm">
        <p className="text-muted-foreground">Your repos list here once the GitHub CLI or the GitLab CLI is signed in. Until then, paste a repo URL: cloning needs only your SSH key.</p>
        <CliHints status={status} onRecheck={onRecheck} />
      </div>
    );
  }
  const ns = parseNamespaceRef(current);
  const row = (r: OrgRepo, on: boolean) => (
    <li key={r.fullName} className="relative">
      <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border bg-card py-2.5 pr-11 pl-3 text-sm transition-colors hover:border-primary/50', on && 'border-primary bg-primary/5')}>
        <input type="checkbox" checked={on} onChange={(e) => (e.target.checked ? onPick(r) : onUnpick(r.sshUrl))} className="mt-0.5 accent-[var(--primary)]" />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium break-all">{ns && !isShared(ns) && r.fullName.toLowerCase().startsWith(`${ns.path.toLowerCase()}/`) ? r.fullName.slice(ns.path.length + 1) : r.fullName}</span>
            <Badge>{REPO_KIND_LABELS[r.kind]}</Badge>
            {r.local?.installed?.map((i) => <Badge key={`${i.domain}${i.path ?? ''}`} tone="warning">installed as {i.domain}{i.path ?? ''}</Badge>)}
            {r.pushedAt && <span className="text-xs text-muted-foreground">pushed {timeAgo(r.pushedAt)}</span>}
          </span>
          {r.description && <span className="text-xs text-muted-foreground">{r.description}</span>}
        </span>
      </label>
      <RepoLink url={r.url || repoWeb(r.sshUrl)?.repoUrl} name={r.fullName} />
    </li>
  );
  return (
    <div className="grid gap-3">
      {!signedIn && current && <p className="text-xs text-warning">The CLI for {namespaceShortLabel(current)} is not signed in: the list is from the last check and still installs, as cloning uses git.</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Field htmlFor="code-ns" label="Organization or group">
          <Select id="code-ns" value={current} onChange={(e) => setCurrent(e.target.value)} wrapClassName="min-w-52">
            {selected.length === 0 && <option value="">Pick organizations or groups first</option>}
            {selected.map((o) => <option key={o} value={o}>{namespaceLabel(o)}</option>)}
          </Select>
        </Field>
        {anySignedIn && <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Which to scan'}</Button>}
        <span className="flex-1" />
        {signedIn && current && (
          <Button variant="outline" size="sm" disabled={scanning !== null} onClick={() => void scan(current, 'check')}>
            <RefreshCw className={cn(scanning && 'animate-spin')} />
            Check now
          </Button>
        )}
      </div>
      {editing && <OrgPicker status={status} onRecheck={onRecheck} />}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or description" aria-label="Filter repos" className="pl-9" />
        </div>
        <Select aria-label="Which repos" value={kind} onChange={(e) => setKind(e.target.value as ListKind)} wrapClassName="sm:w-48">
          <option value="sites">WordPress sites</option>
          <option value="parts">Themes, plugins and others</option>
          <option value="all">Every repo</option>
        </Select>
      </div>
      {listError && <p role="alert" className="text-sm text-danger">{listError}</p>}
      {list?.problem && <p role="alert" className="text-sm text-warning">Could not read the host: {list.problem}</p>}
      {scanning && !list?.listedAt && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Reading the repos of {namespaceShortLabel(current)}...</p>}
      <ul aria-label="Repos" className="grid max-h-[30rem] gap-2 overflow-y-auto overscroll-contain pr-1">
        {picked.length > 0 && (
          <li className="sticky top-0 z-10 grid gap-2 rounded-lg border bg-muted/90 p-2 backdrop-blur">
            <span className="px-1 text-xs font-medium text-muted-foreground">Picked ({picked.length})</span>
            <ul className="grid gap-1.5">{picked.map((r) => row(r, true))}</ul>
          </li>
        )}
        {rest.map((r) => row(r, false))}
        {list && !scanning && rest.length === 0 && <li className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">No other repo matches.</li>}
      </ul>
      {list?.checkedAt && <p className="text-xs text-muted-foreground">{repos.length === 1 ? '1 repo' : `${repos.length} repos`}, checked for new ones {timeAgo(list.checkedAt)}.</p>}
    </div>
  );
}

/** Any git URL, from any host, once you trust it. */
function PasteRepo({ onPick, picked }: { onPick: (r: OrgRepo) => void; picked: (url: string) => boolean }) {
  const [url, setUrl] = useState('');
  const repo = pastedRepo(url.trim());
  const already = repo ? picked(repo.sshUrl) : false;
  const add = () => {
    if (!repo || already) return;
    onPick(repo);
    setUrl('');
  };
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="git@github.com:wandworks/site.git"
          aria-label="Repo URL"
          className="font-mono text-[13px]"
          spellCheck={false}
          aria-invalid={url.trim() !== '' && !repo ? true : undefined}
        />
        <Button variant="outline" disabled={!repo || already} onClick={add}>
          <Plus />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {url.trim() !== '' && !repo
          ? <span className="text-danger">Use an SSH or HTTPS URL, like git@github.com:wandworks/site.git or https://gitlab.com/wandworks/web/site.git</span>
          : already
            ? 'Picked already.'
            : 'SSH or HTTPS, from GitHub, GitLab or any git host, cloned as you with your SSH key. A repo outside your organizations and groups asks you to trust its owner once.'}
      </p>
    </div>
  );
}

/**
 * Where everything goes, as a folder tree of the site: each repo at its
 * path with its branch, and advice beside a path. Also the dump and the
 * domains once they are chosen, so every step shows what is picked.
 */
export function SitePlan({ state, compact = false }: { state: WizardState; compact?: boolean }) {
  const lines = planLines(placedRows(state));
  const site = state.domains[0]?.local.trim() || 'the site';
  const db = state.noDump ? 'none: a fresh install on the repo code' : state.upload ? state.upload.name : 'not picked yet';
  if (compact) {
    if (lines.length === 0) return null;
    return (
      <details className="group rounded-lg border bg-card px-3 py-2 text-xs">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <FolderTree className="size-3.5" />
          {lines.map((l) => (
            <span key={l.url} className="font-mono text-foreground">{l.label} <span className="text-muted-foreground">at {l.path || 'the site root'}</span></span>
          ))}
          <span>· dump: <span className="text-foreground">{db}</span></span>
        </summary>
        <div className="mt-2 border-t pt-2"><PlanTree site={site} lines={lines} /></div>
      </details>
    );
  }
  return (
    <section aria-label="Site plan" className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
      <h2 className="flex items-center gap-2 font-semibold"><FolderTree className="size-4 text-muted-foreground" />Where everything goes</h2>
      {lines.length === 0 ? <p className="text-xs text-muted-foreground">Pick a repo: its folder in the site shows here.</p> : <PlanTree site={site} lines={lines} />}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t pt-3 text-xs">
        <dt className="text-muted-foreground">Database</dt>
        <dd className="truncate">{db}</dd>
        <dt className="text-muted-foreground">Address</dt>
        <dd className="truncate font-mono">{state.domains[0]?.local.trim() || 'from the dump, next'}</dd>
      </dl>
    </section>
  );
}

function PlanTree({ site, lines }: { site: string; lines: ReturnType<typeof planLines> }) {
  return (
    <ul className="grid gap-1 font-mono text-[12px]">
      <li className="text-muted-foreground">{site}/</li>
      {lines.map((l) => {
        const warn = placementWarnings(l.path);
        return (
          <li key={l.url} style={{ paddingLeft: `${Math.min(l.depth, 6) * 0.75 + 0.75}rem` }} className="grid gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground">{l.path ? `${l.path}/` : './'}</span>
              {l.main && <Badge tone="primary" className="px-1 py-0 text-[10px]">main</Badge>}
              {warn.length > 0 && <span title={warn.join('; ')}><TriangleAlert className="size-3.5 text-warning" /></span>}
            </span>
            <span className="text-muted-foreground">{l.label} @ {l.branch || '...'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Whether Claude Code reads the repo and its links for this install: a
 * switch when it is installed and signed in (on by default, as Settings says),
 * nothing but a line on how to set it up otherwise. Switched on, it shows what
 * the step runs with, to change for this install.
 */
export function ClaudeSwitch({ status, on, onChange, preference, onPreference, run, own, onRun }: {
  status: OrgStatus | null;
  on: boolean;
  onChange: (on: boolean) => void;
  preference: UseClaude;
  onPreference: (p: UseClaude) => void;
  /** What the step runs with: this install's own values, or your defaults. */
  run?: ClaudeRun | undefined;
  /** This install changed them from your defaults. */
  own?: boolean;
  /** A change for this install; undefined goes back to your defaults. */
  onRun?: (run: ClaudeRun | undefined) => void;
}) {
  const ready = Boolean(status?.claude.found && status.claude.signedIn);
  if (preference === 'never') {
    return <p className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">Claude Code is turned off for new installs in <Link href="/settings" className="text-primary hover:underline">Settings</Link>.</p>;
  }
  if (!status) return null;
  if (!ready) {
    return (
      <div className="grid gap-1.5 rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground"><Sparkles className="size-3.5 text-primary" />Claude can read the repo for you</p>
        <p>
          {status.claude.found ? 'Claude Code is not signed in:' : 'Claude Code is not installed:'} run <code className="font-mono text-foreground">claude auth login</code>
          {status.claude.found ? '' : ' once it is installed'}. Aura's <Link href="/aura/machine" className="text-primary hover:underline">Machine checks</Link> have the steps. You can go on without it.
        </p>
      </div>
    );
  }
  const wanted: UseClaude = on ? 'always' : 'ask';
  return (
    <div className={cn('grid gap-2 rounded-lg px-4 py-3 text-sm', status.claude.claudeAi ? 'ai-border' : 'border bg-card')}>
      <label className="flex cursor-pointer items-center gap-2.5 font-medium">
        <Switch checked={on} onChange={onChange} label="Let Claude read the repo and its links" />
        <span className="flex items-center gap-1.5"><Sparkles className="size-3.5 text-primary" />Let Claude read the repo and its links</span>
      </label>
      <p className="text-xs text-muted-foreground">
        {status.claude.claudeAi
          ? 'Claude Code reads the docs (never wp-config.php or .env), checks the Asana and Google links with your claude.ai account and finds the dumps in Drive. Read-only, with a spending cap.'
          : 'Claude Code reads the docs (never wp-config.php or .env). Asana and Google links need a claude.ai sign-in.'}
      </p>
      {preference !== wanted && (
        <button type="button" className="w-fit text-xs font-medium text-primary hover:underline" onClick={() => onPreference(wanted)}>
          Make this the default
        </button>
      )}
      {on && run && onRun && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Runs with <span className="font-medium text-foreground">{CLAUDE_MODEL_LABELS[run.model]}, {CLAUDE_EFFORT_LABELS[run.effort].toLowerCase()} effort, at most ${run.budgetUsd.toFixed(2)}</span>
            {own ? ', for this install' : ''}
          </summary>
          <div className="mt-2 grid gap-2">
            <ClaudeRunFields value={run} onChange={onRun} />
            <p className="text-muted-foreground">
              One step reads the repo and checks its links; the cap is for both.{' '}
              {own ? (
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => onRun(undefined)}>Back to my defaults</button>
              ) : (
                <>Your defaults, from <Link href="/settings" className="font-medium text-primary hover:underline">Settings</Link>: a change here is for this install only.</>
              )}
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

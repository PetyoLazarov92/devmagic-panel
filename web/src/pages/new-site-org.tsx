import type { AccessReport, AccessResult, ClaudeEffort, ClaudeUsage, ClaudeModel, ClaudeRun, ClaudeStep, OrgRepo, OrgRepoList, OrgScanMode, OrgStatus, Prefill, ReadResult, RepoFacts, Site, UploadResult } from '@devmagic-panel/shared';
import { accessKey, CLAUDE_EFFORTS, CLAUDE_MODELS, DEFAULT_CLAUDE_STEPS, gitlabHost, isShared, namespaceLabel, namespaceShortLabel, parseNamespaceRef, prefillFromFacts, registerGitlabHosts, readKey, REPO_KIND_LABELS, gitUrl, repoWeb } from '@devmagic-panel/shared';
import { Check, CircleAlert, CircleCheck, CircleHelp, CircleX, ExternalLink, FileArchive, LoaderCircle, RefreshCw, Search, Sparkles, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BranchPicker } from '@/components/branch-picker';
import { settled, StepList, useJob } from '@/components/job-steps';
import { DumpFactsCard } from '@/components/dump-facts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { api } from '@/lib/api';
import { failureOf, resumeStep, runSource, unskipAccess, usageHover, usageText } from '@/lib/claude-steps';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { asideUploads, type RepoProgress, switchOrg, switchRepo } from '@/lib/org-repos';
import { cn } from '@/lib/utils';
import type { WizardState } from './new-site';
import { Notice } from '@/components/page';

/** Installing from an organization: the repo picked, what Claude Code read, the links it checked and the dump. */
export interface OrgState {
  name: string;
  repo: OrgRepo | null;
  read: { status: 'idle' | 'reading' | 'done' | 'error'; facts?: RepoFacts; files?: string[]; error?: string } & Partial<ClaudeUsage>;
  access: { status: 'idle' | 'checking' | 'done' | 'skipped' | 'error'; report?: AccessReport; error?: string } & Partial<ClaudeUsage>;
  /** This install's own Claude Code settings per step; unset steps use the panel's defaults. */
  claude?: Partial<Record<ClaudeStep, ClaudeRun>>;
  /** The wizard's answers from the docs and the dump, once the dump is in. */
  prefill?: Prefill;
  /** The other repos you picked in this install, by full name, as you left them (lib/org-repos). */
  earlier?: Record<string, RepoProgress>;
}

export const newOrgState = (name = ''): OrgState => ({ name, repo: null, read: { status: 'idle' }, access: { status: 'idle' } });

type SetState = (update: (s: WizardState) => WizardState) => void;
const setOrg = (setState: SetState, update: (o: OrgState) => OrgState) => setState((s) => (s.org ? { ...s, org: update(s.org) } : s));

/** A Drive file's page, where it opens and downloads in the browser. */
const driveUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

/** The links Claude Code checks: the Asana tasks and Google files the docs name. */
export const linksOf = (facts?: RepoFacts) => [...(facts?.asanaLinks ?? []), ...(facts?.googleLinks ?? [])];

/**
 * The wizard's answers once the dump is in: every address the dump uses mapped
 * to a local name, the build and notes from the docs, and your local setup for
 * how it runs here. The core stays the newest you have, or your pick.
 */
export function applyOrgAnswers(state: WizardState, upload: UploadResult, cores: string[]): WizardState {
  const org = state.org;
  if (!org?.repo) return { ...state, upload };
  const prefill = prefillFromFacts(org.repo, org.read.facts ?? null, cores);
  // Every address the dump uses, as in an install from a git repo and a dump: the docs give no domains.
  const domains = upload.suggestions.replace.map((r) => ({ prod: r.from, local: r.to }));
  return {
    ...state,
    upload,
    repoUrl: prefill.repoUrl,
    layout: prefill.layout,
    domains: domains.length ? domains : [{ prod: '', local: '' }],
    // The newest core you have, or the one you picked; a version the docs name is a note.
    coreVersion: state.coreVersion || prefill.coreVersion,
    // Missing images come from the production domain in the dump; the docs' address is only offered beside the field.
    uploadsFrom: null,
    composer: prefill.composer,
    npm: prefill.npm,
    org: { ...org, prefill },
  };
}

// ── 1. The organization and the repo ─────────────────────────

/** How long ago, as a phrase that fits after "checked". */
const ago = (iso: string) => {
  const text = timeAgo(iso);
  return text === 'now' ? 'just now' : text;
};

export function OrgStep({ state, setState, status, blank, onRecheck }: { state: WizardState; setState: SetState; status: OrgStatus | null; blank: WizardState; onRecheck?: () => void }) {
  const org = state.org as OrgState;
  const [query, setQuery] = useState('');
  const [sitesOnly, setSitesOnly] = useState(true);
  const [editing, setEditing] = useState(false);
  const [pasted, setPasted] = useState('');
  const selected = status?.settings.selected ?? [];
  const current = org.name || selected[0] || '';
  // Signed in to the CLI of the namespace shown (gh or glab on its host), and to any of them for picking.
  const signedIn = status ? cliSignedIn(status, current) : false;
  const anySignedIn = status ? status.gh.signedIn || status.glab.hosts.some((h) => h.signedIn) : false;
  // The stored list shows at once, without the CLI; then, signed in, what is due is read behind it.
  const [list, setList] = useState<OrgRepoList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<OrgScanMode | null>(null);
  const shownOrg = useRef('');
  async function scan(name: string, mode: OrgScanMode) {
    if (mode !== 'none') setScanning(mode);
    try {
      const r = await api.orgRepos(name, mode);
      if (shownOrg.current === name) {
        setList(r);
        setListError(null);
      }
    } catch (e) {
      if (shownOrg.current === name) setListError((e as Error).message);
    } finally {
      if (mode !== 'none' && shownOrg.current === name) setScanning(null);
    }
  }
  useEffect(() => {
    shownOrg.current = current;
    setList(null);
    setListError(null);
    setScanning(null);
    if (!current) return;
    void scan(current, 'none').then(() => (signedIn ? scan(current, 'auto') : undefined));
  }, [current, signedIn]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list?.repos ?? []).filter((r) => (!sitesOnly || r.kind === 'site' || r.kind === 'wp-content') && (!q || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(q)));
  }, [list, query, sitesOnly]);
  const stored = Boolean(list?.listedAt);

  function pick(repo: OrgRepo) {
    setState((s) => switchRepo(s, repo, blank));
  }
  function pickPasted() {
    const url = pasted.trim();
    const repo = pastedRepo(url);
    if (repo) pick(repo);
  }

  if (!status) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Checking Claude Code, the GitHub CLI and the GitLab CLI...</p>;
  const shownNs = parseNamespaceRef(current);
  return (
    <WithClaudeCard card={<ClaudeCard status={status} org={org} setState={setState} next={nextClaudeStep(org)} />}>
    <div className="grid max-w-4xl gap-4">
      {!anySignedIn ? (
        <Notice tone="warning">
          The GitHub CLI lists your organizations' repos and the GitLab CLI your groups' projects: {status.gh.problem ?? 'gh is not set up'}; {status.glab.hosts[0]?.problem ?? 'glab is not set up'}. Install the one for your host (
          <code className="font-mono">sudo apt install gh</code> or <code className="font-mono">sudo apt install glab</code>), sign in with <code className="font-mono">gh auth login</code> or{' '}
          <code className="font-mono">glab auth login</code>, then come back. {stored ? 'The list below is from the last check and still installs, as cloning uses git.' : 'Or paste a repo URL below.'}
        </Notice>
      ) : (
        current && !signedIn && shownNs && (
          <Notice tone="warning">
            {shownNs.provider === 'github' ? (
              <>The GitHub CLI checks for new repos of {namespaceShortLabel(current)}: {status.gh.problem ?? 'it is not set up'}. Sign in with <code className="font-mono">gh auth login</code>.</>
            ) : (
              <>The GitLab CLI checks for new projects on {shownNs.host}: {status.glab.hosts.find((h) => h.host === shownNs.host)?.problem ?? 'it is not set up'}. Sign in with <code className="font-mono">glab auth login{shownNs.host === 'gitlab.com' ? '' : ` --hostname ${shownNs.host}`}</code>.</>
            )}{' '}
            The list below is from the last check and still installs, as cloning uses git.
          </Notice>
        )
      )}
      {(anySignedIn || selected.length > 0) && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field htmlFor="org" label="Organization or group">
              <Select id="org" value={current} onChange={(e) => setState((s) => switchOrg(s, e.target.value))} wrapClassName="min-w-56">
                {selected.length === 0 && <option value="">Pick organizations or groups first</option>}
                {selected.map((o) => <option key={o} value={o}>{namespaceLabel(o)}</option>)}
              </Select>
            </Field>
            {anySignedIn && <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Organizations and groups to scan'}</Button>}
            <span className="flex-1" />
            {signedIn && (
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={scanning !== null || !current} onClick={() => void scan(current, 'check')}>
                  <RefreshCw className={cn(scanning && 'animate-spin')} />
                  Check now
                </Button>
                <Menu
                  label="More ways to scan"
                  items={[{ label: 'Rescan all repos', icon: <RefreshCw />, disabled: scanning !== null || !current, onSelect: () => void scan(current, 'full') }]}
                />
              </div>
            )}
          </div>
          {anySignedIn && !editing && selected.length > 0 && !status.glab.hosts.some((h) => h.signedIn) && (
            <p className="-mt-2 text-xs text-muted-foreground">
              GitLab repos list here once the GitLab CLI is {status.glab.installed ? 'signed in' : 'installed and signed in'}:{' '}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setEditing(true)}>how</button>.
            </p>
          )}
          {anySignedIn && (editing || selected.length === 0) && <OrgPicker status={status} {...(onRecheck ? { onRecheck } : {})} />}
          {current && (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={isShared(shownNs ?? { path: '' }) ? 'Filter the repos shared with you' : `Filter the repos of ${namespaceShortLabel(current)}`} aria-label="Filter repos" className="pl-9" />
                </div>
                <Checkbox id="sites-only" checked={sitesOnly} onChange={setSitesOnly} label="WordPress sites only" />
              </div>
              {listError && <p role="alert" className="text-sm text-danger">{listError}</p>}
              {list?.problem && (
                <p role="alert" className="flex items-start gap-2 text-sm text-warning">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>Could not read {shownNs?.host === 'github.com' ? 'GitHub' : (shownNs?.host ?? 'the host')}: {list.problem}.{stored && list.checkedAt ? ` Showing the list from ${ago(list.checkedAt)}.` : ''}</span>
                </p>
              )}
              {scanning && !stored ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Reading the repos of {namespaceShortLabel(current)}; the first scan looks into each one, later ones only into new pushes...</p>
              ) : (
                (scanning || list?.checkedAt) && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                    {scanning && <LoaderCircle className="size-3.5 animate-spin" />}
                    {scanning === 'full' ? 'Reading every repo of ' + namespaceShortLabel(current) + '...' : scanning ? 'Checking for new repos...' : `${list?.repos.length === 1 ? '1 repo' : `${list?.repos.length ?? 0} repos`}, checked for new ones ${ago(list?.checkedAt as string)}`}
                    {!scanning && list?.listedAt && `, all listed ${ago(list.listedAt)}`}
                  </p>
                )
              )}
              <ul role="radiogroup" aria-label="Repos" className="grid max-h-[28rem] gap-2 overflow-y-auto">
                {shown.map((r) => (
                  <li key={r.fullName} className="relative">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={org.repo?.fullName === r.fullName}
                      onClick={() => pick(r)}
                      className={cn('grid w-full gap-1 rounded-lg border bg-card py-3 pr-11 pl-4 text-left text-sm transition-colors hover:border-primary/50', org.repo?.fullName === r.fullName && 'border-primary ring-3 ring-primary/15')}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] font-medium">{shownNs && isShared(shownNs) ? r.fullName : shownNs && r.fullName.toLowerCase().startsWith(`${shownNs.path.toLowerCase()}/`) ? r.fullName.slice(shownNs.path.length + 1) : r.name}</span>
                        <Badge>{REPO_KIND_LABELS[r.kind]}</Badge>
                        {r.local?.installed?.map((i) => <Badge key={`${i.domain}${i.path ?? ''}`} tone="warning">installed as {i.domain}{i.path ?? ''}</Badge>)}
                        {r.local?.archived && <Badge>{r.local.archived.count === 1 ? '1 archived copy' : `${r.local.archived.count} archived copies`}</Badge>}
                        {r.local?.draft && <Badge tone="warning">unfinished install</Badge>}
                        <span className="flex-1" />
                        {r.pushedAt && <span className="text-xs text-muted-foreground">pushed {timeAgo(r.pushedAt)}</span>}
                      </span>
                      {r.description && <span className="text-muted-foreground">{r.description}</span>}
                    </button>
                    <RepoLink url={r.url || repoWeb(r.sshUrl)?.repoUrl} name={r.fullName} />
                  </li>
                ))}
                {list && !scanning && shown.length === 0 && <li className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No repo matches.</li>}
              </ul>
            </>
          )}
        </>
      )}
      <details className="rounded-lg border bg-card px-4 py-3 text-sm" open={!signedIn && !stored}>
        <summary className="cursor-pointer font-medium">Paste a repo URL instead</summary>
        <div className="mt-3 flex gap-2">
          <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="git@gitlab.com:acme/web/site.git" className="font-mono text-[13px]" spellCheck={false} aria-label="Repo URL" />
          <Button variant="outline" disabled={!pastedRepo(pasted.trim())} onClick={pickPasted}>Use it</Button>
        </div>
      </details>
      {org.repo && (
        <OrgBranch url={org.repo.sshUrl} defaultBranch={org.repo.defaultBranch} branch={state.branch} setState={setState} />
      )}
    </div>
    </WithClaudeCard>
  );
}

/** The Claude Code step still ahead for this repo: none once it was read and its links checked or skipped. */
const nextClaudeStep = (org: OrgState): ClaudeStep | null => (org.read.status !== 'done' ? 'read' : org.access.status === 'done' || org.access.status === 'skipped' ? null : 'access');

/**
 * What each host still needs before it lists anything: the CLI, or its
 * sign-in. Cloning needs neither, only your SSH key, so this is only for
 * listing your repos, the ones shared with you and your groups.
 */
function CliHints({ status, onRecheck }: { status: OrgStatus; onRecheck?: () => void }) {
  const lines: Array<{ host: string; text: ReactNode }> = [];
  if (!status.gh.signedIn) {
    lines.push({
      host: 'GitHub',
      text: status.gh.installed
        ? <>not signed in: run <code className="font-mono">gh auth login</code> in a terminal.</>
        : <>the GitHub CLI is not installed: <code className="font-mono">sudo apt install gh</code>, then <code className="font-mono">gh auth login</code>.</>,
    });
  }
  if (!status.glab.installed) {
    lines.push({
      host: 'GitLab',
      text: <>the GitLab CLI is not installed: <code className="font-mono">sudo apt install glab</code>, then <code className="font-mono">glab auth login</code>. It lists your GitLab projects, the ones shared with you and your groups.</>,
    });
  } else {
    for (const h of status.glab.hosts.filter((x) => !x.signedIn)) {
      const login = `glab auth login${h.host === 'gitlab.com' ? '' : ` --hostname ${h.host}`}`;
      lines.push({ host: h.host, text: <>{h.problem && !/not signed in/.test(h.problem) ? `${h.problem}. ` : 'not signed in: '}run <code className="font-mono">{login}</code> in a terminal.</> });
    }
  }
  if (lines.length === 0) return null;
  return (
    <div className="grid gap-1.5 rounded-md border border-warning/40 bg-warning/6 px-3 py-2 text-xs">
      {lines.map((l) => (
        <p key={l.host}>
          <span className="font-medium">{l.host}:</span> {l.text}
        </p>
      ))}
      <p className="text-muted-foreground">
        Cloning needs only your SSH key; these only list repos.{' '}
        {onRecheck && <button type="button" className="font-medium text-primary hover:underline" onClick={onRecheck}>Check again</button>}
      </p>
    </div>
  );
}

/** Signed in to the CLI that lists this namespace: gh for a GitHub organization, glab on the group's host. */
function cliSignedIn(status: OrgStatus, ref: string): boolean {
  const ns = parseNamespaceRef(ref);
  if (!ns) return false;
  return ns.provider === 'github' ? status.gh.signedIn : Boolean(status.glab.hosts.find((h) => h.host === ns.host)?.signedIn);
}

/**
 * A pasted URL as a repo of the list: its whole path on the host, so a
 * project in a GitLab subgroup (acme/web/site) keeps its groups. Null for
 * anything that is not a git URL.
 */
function pastedRepo(url: string): OrgRepo | null {
  const web = gitUrl.safeParse(url).success ? repoWeb(url) : null;
  if (!web) return null;
  const parsed = new URL(web.repoUrl);
  const path = parsed.pathname.slice(1);
  const slash = path.lastIndexOf('/');
  const group = path.slice(0, slash);
  // The organization or group, when it is one the panel can list; other hosts install without one.
  const ref = web.provider === 'GitHub' ? group : web.provider === 'GitLab' ? `${parsed.hostname}/${group}` : '';
  const org = parseNamespaceRef(ref) ? ref : '';
  return { org, name: path.slice(slash + 1), fullName: path, sshUrl: url, url: web.repoUrl, archived: false, kind: 'site' };
}

/** Opens a repo of the list on its host in a new tab, beside its row's button. */
function RepoLink({ url, name }: { url: string | undefined; name: string }) {
  if (!url) return null;
  const where = repoWeb(url)?.name ?? 'its host';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${name} on ${where}`}
      aria-label={`Open ${name} on ${where}`}
      className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

/**
 * The branch to clone, picked from the repo's branches as in an install from
 * a git repo and a dump; typed only when they could not be read.
 */
function OrgBranch({ url, defaultBranch, branch, setState }: { url: string; defaultBranch: string | undefined; branch: string; setState: SetState }) {
  const [read, setRead] = useState<{ url: string; branches?: string[]; defaultBranch?: string; error?: string } | null>(null);
  // The wizard's setter is new on every render: read once per repo, not per render.
  const update = useRef(setState);
  update.current = setState;
  useEffect(() => {
    let current = true;
    setRead(null);
    api.inspectRepo(url).then(
      (found) => {
        if (!current) return;
        setRead({ url, branches: found.branches ?? [], ...(found.defaultBranch ? { defaultBranch: found.defaultBranch } : {}) });
        // A pasted URL has no default branch from its host: take the remote's.
        if (found.defaultBranch) update.current((s) => (s.repoUrl === url && !s.branch ? { ...s, branch: found.defaultBranch as string } : s));
      },
      (err: Error) => current && setRead({ url, error: err.message }),
    );
    return () => {
      current = false;
    };
  }, [url]);
  const shown = read?.url === url ? read : null;
  const main = shown?.defaultBranch ?? defaultBranch;
  const hint = !shown ? 'Reading the branches...' : shown.error ? `The branches could not be read (${shown.error}): type one.` : branch === main ? 'The default branch' : main ? `The default branch is ${main}` : undefined;
  return (
    <Field htmlFor="org-branch" label="Branch" hint={hint}>
      <div className="max-w-sm">
        {shown?.branches && shown.branches.length > 0 ? (
          <BranchPicker
            id="org-branch"
            branches={shown.branches.map((name) => ({ name, current: name === main, remoteOnly: false }))}
            value={branch}
            onChange={(name) => setState((s) => ({ ...s, branch: name }))}
            currentLabel="default"
          />
        ) : (
          <Input id="org-branch" value={branch} onChange={(e) => setState((s) => ({ ...s, branch: e.target.value.trim() }))} disabled={!shown} className="font-mono text-[13px]" spellCheck={false} />
        )}
      </div>
    </Field>
  );
}

/**
 * Which of your organizations and groups the panel scans, from every CLI that
 * is signed in, and your own GitLab hosts; saved in the panel's settings.
 */
function OrgPicker({ status, onRecheck }: { status: OrgStatus; onRecheck?: () => void }) {
  const orgs = useAsync(() => api.orgOrgs(), []);
  const [settings, setSettings] = useState(status.settings);
  const [saving, setSaving] = useState(false);
  const [hostsText, setHostsText] = useState(status.settings.gitlabHosts.join('\n'));
  const [hostsError, setHostsError] = useState<string | null>(null);
  async function save(next: typeof settings) {
    setSettings(next);
    setSaving(true);
    try {
      const saved = await api.saveOrgSettings(next);
      Object.assign(status.settings, saved);
      registerGitlabHosts(saved.gitlabHosts);
    } finally {
      setSaving(false);
    }
  }
  const selected = settings.selected;
  const toggle = (ref: string, on: boolean) => save({ ...settings, selected: on ? [...selected, ref] : selected.filter((n) => n !== ref) });
  async function saveHosts() {
    const hosts = hostsText.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
    const bad = hosts.find((h) => !gitlabHost.safeParse(h).success);
    if (bad) return setHostsError(`${bad} is not a hostname like gitlab.acme.test`);
    setHostsError(null);
    await save({ ...settings, gitlabHosts: [...new Set(hosts)].filter((h) => h !== 'gitlab.com') });
    orgs.reload();
  }
  // One block per host, GitHub first, then gitlab.com and yours.
  const byHost = new Map<string, Array<{ ref: string; label: string }>>();
  for (const n of orgs.data?.namespaces ?? []) byHost.set(n.host, [...(byHost.get(n.host) ?? []), { ref: n.ref, label: namespaceShortLabel(n.ref) }]);
  return (
    <div className="grid gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
      <div>
        <p className="font-medium">Organizations and groups to scan {saving && <LoaderCircle className="inline size-3.5 animate-spin" />}</p>
        <p className="text-muted-foreground">The GitHub organizations and GitLab groups you belong to, your own accounts, and the repos shared with you: ones you were added to outside those. A GitLab group is scanned with its subgroups.</p>
      </div>
      <CliHints status={status} {...(onRecheck ? { onRecheck } : {})} />
      {orgs.error && <p role="alert" className="text-danger">{orgs.error}</p>}
      {orgs.data?.problems.map((p) => <p key={p} role="alert" className="text-warning">{p}</p>)}
      {[...byHost].map(([host, list]) => (
        <div key={host}>
          <p className="text-xs font-medium text-muted-foreground">{host === 'github.com' ? 'GitHub' : host}</p>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
            {list.map((o) => <Checkbox key={o.ref} id={`org-${o.ref}`} checked={selected.includes(o.ref)} onChange={(v) => void toggle(o.ref, v)} label={o.label} />)}
          </div>
        </div>
      ))}
      <Field
        htmlFor="gitlab-hosts"
        label="Your own GitLab hosts"
        hint={hostsError ? <span className="text-danger">{hostsError}</span> : <>One per line, like gitlab.acme.test; gitlab.com is always listed. Sign in to each once with <code className="font-mono whitespace-nowrap">glab auth login --hostname gitlab.acme.test</code>.</>}
      >
        <div className="flex max-w-md items-start gap-2">
          <Textarea id="gitlab-hosts" value={hostsText} onChange={(e) => setHostsText(e.target.value)} rows={2} spellCheck={false} placeholder="gitlab.acme.test" className="min-h-16 flex-1 font-mono text-[13px]" />
          <Button variant="outline" size="sm" disabled={saving || hostsText.trim() === settings.gitlabHosts.join('\n')} onClick={() => void saveHosts()}>Save hosts</Button>
        </div>
      </Field>
    </div>
  );
}

// ── 2. What the repo says ────────────────────────────────────

export function ReadStep({ state, setState, onSkip, status, draftId, saveNow }: { state: WizardState; setState: SetState; onSkip: () => void; status: OrgStatus | null; draftId: string; saveNow: () => Promise<unknown> }) {
  const org = state.org as OrgState;
  const repo = org.repo as OrgRepo;
  const key = readKey(repo.fullName, state.branch);
  const job = useJob();
  const started = useRef<string | null>(null);
  const take = ({ key: _key, ...r }: ReadResult) => setOrg(setState, (o) => ({ ...o, read: { status: 'done', ...r }, access: { status: 'idle' } }));
  const fail = (error: string) => setOrg(setState, (o) => ({ ...o, read: { status: 'error', error } }));

  async function start() {
    if (!status) return;
    setOrg(setState, (o) => ({ ...o, read: { status: 'reading' } }));
    // The job notes itself on the draft, so the draft is saved first.
    await saveNow().catch(() => undefined);
    void job.follow(api.startJob('org.readRepo', { draftId, url: repo.sshUrl, branch: state.branch, fullName: repo.fullName, settings: runFor(org, status, 'read') }));
  }

  // Opening the step, or coming back to it: the answer kept for this repo and branch, the job still reading it, or a new run.
  useEffect(() => {
    if ((org.read.status !== 'idle' && org.read.status !== 'reading') || started.current === key || !status) return;
    let live = true;
    void (async () => {
      const draft = await api.draft(draftId).catch(() => null);
      const noted = draft?.jobs?.read;
      const view = noted ? await api.job(noted.id).catch(() => null) : null;
      if (!live) return;
      started.current = key;
      const next = resumeStep(key, draft?.results?.read, noted, view);
      if (next.use === 'answer' && draft?.results?.read) take(draft.results.read);
      else if (next.use === 'failed') fail(next.reason);
      else if (next.use === 'follow') void job.follow(Promise.resolve(next.jobId));
      else await start();
    })();
    return () => {
      live = false;
    };
  }, [org.read.status, key, status]);

  // The job ended: its answer is on the draft.
  useEffect(() => {
    const view = job.job;
    if (!view || !settled(view)) return;
    if (view.status !== 'done') return fail(failureOf(view));
    api.draft(draftId).then((d) => (d.results?.read?.key === key ? take(d.results.read) : fail('The answer was not kept: read it again')), (err: Error) => fail(err.message));
  }, [job.job?.status]);
  useEffect(() => {
    if (job.error) fail(job.error);
  }, [job.error]);

  // Once the links are checked, nothing more runs: their answer is kept.
  const card = status && <ClaudeCard status={status} org={org} setState={setState} next={org.access.status === 'done' ? null : 'access'} />;
  if (org.read.status === 'reading' || org.read.status === 'idle') {
    return (
      <WithClaudeCard card={card}>
        <Working title={`Claude Code is reading the README files, docs and build files of ${repo.fullName}...`} job={job.job} />
      </WithClaudeCard>
    );
  }
  if (org.read.status === 'error') {
    return (
      <WithClaudeCard card={card}>
        <div className="grid max-w-3xl gap-3">
          <Notice tone="danger">{org.read.error}</Notice>
          <Button variant="outline" className="w-fit" onClick={() => void start()}><RefreshCw />Read it again</Button>
        </div>
      </WithClaudeCard>
    );
  }
  const f = org.read.facts as RepoFacts;
  const source = (field: string) => f.sources.find((s) => s.field === field)?.file;
  const rows: Array<[string, string | null, string]> = [
    ['Production address', f.productionUrl, 'productionUrl'],
    ['WordPress', f.wordpressVersion, 'wordpressVersion'],
    ['PHP', f.phpVersion, 'phpVersion'],
    ['Build', [f.composer && 'composer', f.npm && 'npm'].filter(Boolean).join(' and ') || null, 'composer'],
    ['Local setup in the docs', f.docsLocalSetup, 'docsLocalSetup'],
  ];
  const links = linksOf(f);
  return (
    <WithClaudeCard card={card}>
    <div className="grid max-w-3xl gap-5">
      <p className="text-sm text-muted-foreground">
        From {org.read.files?.length ? org.read.files.join(', ') : 'no doc files: the repo has none'}. Next, the links are checked for the dump, which gives the domains and network.
      </p>
      <DoneActivity lines={org.read.activity} />
      <dl className="grid gap-2 rounded-lg border bg-card p-4 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value, field]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn(!value && 'text-muted-foreground')}>
              {value ?? 'Not found'}
              {value && source(field) && <span className="ml-2 text-xs text-muted-foreground">from {source(field)}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {f.notes.length > 0 && <ul className="grid list-disc gap-1 pl-5 text-sm">{f.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <div role="status" className="grid gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        {links.length > 0 && org.access.status === 'done' ? (
          <p>
            <span className="font-medium">The links are checked already:</span> {org.access.report?.links.filter((l) => l.status === 'ok').length ?? 0} of {org.access.report?.links.length ?? 0} open, {org.access.report?.dumps.length ?? 0} {org.access.report?.dumps.length === 1 ? 'dump' : 'dumps'} found. Continue shows the answer; nothing runs again.
          </p>
        ) : links.length > 0 ? (
          <>
            <p className="font-medium">
              {org.access.status === 'skipped'
                ? 'You skipped the access check. Check access runs it after all, or brings back the answer kept for these links at no cost.'
                : 'Next, Claude checks your access to the linked Asana tasks and Google Docs and Drive files, with your claude.ai account. It only reads them.'}
            </p>
            <ul className="grid gap-1">{links.map((l) => <li key={l} className="truncate font-mono text-[12px] text-muted-foreground" title={l}>{l}</li>)}</ul>
            <p className="text-muted-foreground">It looks for facts for the install and the database dumps in Drive, by name, size and date only.</p>
            <Button variant="ghost" size="sm" className="w-fit" onClick={onSkip}>Skip it and pick a dump myself</Button>
          </>
        ) : (
          <p>The docs link no Asana tasks or Google files. Next, pick the database dump.</p>
        )}
      </div>
    </div>
    </WithClaudeCard>
  );
}

// ── 3. The links and the dump ────────────────────────────────

export function AccessStep({ state, setState, status, cores, draftId, saveNow }: { state: WizardState; setState: SetState; status: OrgStatus | null; cores: string[]; draftId: string; saveNow: () => Promise<unknown> }) {
  const org = state.org as OrgState;
  const repo = org.repo as OrgRepo;
  const links = linksOf(org.read.facts);
  const hints = org.read.facts?.dumpHints ?? [];
  const key = accessKey(repo.fullName, links, hints);
  const job = useJob();
  const check = useJob();
  const started = useRef<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // Which step of the download job shows its output, as on a job's own page.
  const [openStep, setOpenStep] = useState<string | null>(null);
  const downloads = useAsync(() => api.downloads(), []);

  const take = ({ key: _key, ...r }: AccessResult) => setOrg(setState, (o) => ({ ...o, access: { status: 'done', ...r } }));
  const fail = (error: string) => setOrg(setState, (o) => ({ ...o, access: { status: 'error', error } }));

  // Check the links after a skip: the step looks again, as when it opens.
  const recheck = () => {
    started.current = null;
    setOrg(setState, (o) => ({ ...o, access: unskipAccess(o.access) }));
  };

  async function start() {
    if (!status) return;
    setOrg(setState, (o) => ({ ...o, access: { status: 'checking' } }));
    await saveNow().catch(() => undefined);
    void check.follow(api.startJob('org.checkAccess', { draftId, fullName: repo.fullName, links, dumpHints: hints, settings: runFor(org, status, 'access') }));
  }

  // Opening the step, or coming back to it: the answer kept for these links, the job still checking them, or a new run.
  useEffect(() => {
    if ((org.access.status !== 'idle' && org.access.status !== 'checking') || started.current === key || !status) return;
    if (links.length === 0) {
      setOrg(setState, (o) => ({ ...o, access: { status: 'skipped' } }));
      return;
    }
    let live = true;
    void (async () => {
      const draft = await api.draft(draftId).catch(() => null);
      const noted = draft?.jobs?.access;
      const view = noted ? await api.job(noted.id).catch(() => null) : null;
      if (!live) return;
      started.current = key;
      const next = resumeStep(key, draft?.results?.access, noted, view);
      if (next.use === 'answer' && draft?.results?.access) take(draft.results.access);
      else if (next.use === 'failed') fail(next.reason);
      else if (next.use === 'follow') void check.follow(Promise.resolve(next.jobId));
      else await start();
    })();
    return () => {
      live = false;
    };
  }, [org.access.status, key, status]);

  useEffect(() => {
    const view = check.job;
    if (!view || !settled(view)) return;
    if (view.status !== 'done') return fail(failureOf(view));
    api.draft(draftId).then((d) => (d.results?.access?.key === key ? take(d.results.access) : fail('The answer was not kept: check again')), (err: Error) => fail(err.message));
  }, [check.job?.status]);
  useEffect(() => {
    if (check.error) fail(check.error);
  }, [check.error]);

  // Back from another page while a dump came in: follow its download, or take the dump it brought.
  useEffect(() => {
    if (state.upload) return;
    let live = true;
    void (async () => {
      const draft = await api.draft(draftId).catch(() => null);
      const noted = draft?.jobs?.dump;
      const view = noted ? await api.job(noted.id).catch(() => null) : null;
      if (!live || !draft) return;
      if (view && !settled(view)) return void job.follow(Promise.resolve(view.id));
      // Never the dump of a repo you put aside.
      const aside = asideUploads(state.org);
      const kept = draft.attached?.filter((u) => !aside.includes(u)).at(-1);
      if (kept) api.uploadInfo(kept).then((up) => live && setState((s) => (s.upload ? s : applyOrgAnswers(s, up, cores))), () => undefined);
    })();
    return () => {
      live = false;
    };
  }, []);

  const dumps = org.access.report?.dumps ?? [];
  const pick = chosen ?? dumps[0]?.fileId ?? null;
  const dump = dumps.find((d) => d.fileId === pick);

  // A dump job that finished hands its upload to the wizard, filled in from the docs and the dump.
  useEffect(() => {
    if (!job.job || job.job.status !== 'done') return;
    const id = /\bupload ([0-9a-f-]{36})\b/.exec(job.job.steps.map((s) => s.output ?? '').join('\n'))?.[1];
    if (!id) return;
    api.uploadInfo(id).then((upload) => setState((s) => applyOrgAnswers(s, upload, cores)), (err: Error) => setError(err.message));
  }, [job.job?.status]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const up = await api.upload(file, setProgress);
      setState((s) => applyOrgAnswers(s, up, cores));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }
  const working = job.job !== null && !settled(job.job);

  return (
    <WithClaudeCard card={status && <ClaudeCard status={status} org={org} setState={setState} next={org.access.status === 'skipped' && links.length > 0 ? 'access' : null} />}>
    <div className="grid max-w-3xl gap-5">
      {org.access.status === 'checking' && <Working title={`Claude Code is checking ${links.length} links with your claude.ai account...`} job={check.job} />}
      {org.access.status === 'error' && (
        <div className="grid gap-2">
          <Notice tone="danger">{org.access.error}</Notice>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void start()}><RefreshCw />Check again</Button>
        </div>
      )}
      {org.access.status === 'skipped' && links.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
          <p className="min-w-0 flex-1">
            You skipped the access check, so pick the dump below.{' '}
            <span className="text-muted-foreground">Checking the links brings back an answer kept for them at no cost, or runs Claude Code once, at most ${(status ? runFor(org, status, 'access') : DEFAULT_CLAUDE_STEPS.access).budgetUsd.toFixed(2)}.</span>
          </p>
          <Button size="sm" variant="outline" onClick={recheck}><Sparkles />Check the links</Button>
        </div>
      )}
      {org.access.report && (
        <>
          <ul className="grid gap-1.5 rounded-lg border bg-card p-4 text-sm">
            {org.access.report.links.map((l) => (
              <li key={l.url} className="flex items-start gap-2">
                {l.status === 'ok' ? <Check className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />}
                <span className="min-w-0">
                  <span className="font-medium">{l.title ?? (l.status === 'no-access' ? 'No access' : 'Not found')}</span>{' '}
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-muted-foreground hover:underline">{l.url}</a>
                </span>
              </li>
            ))}
          </ul>
          {org.access.report.facts.length > 0 && (
            <ul className="grid list-disc gap-1 pl-5 text-sm">{org.access.report.facts.map((f) => <li key={f.text}>{f.text} <span className="text-xs text-muted-foreground">({f.source})</span></li>)}</ul>
          )}
          <DoneActivity lines={org.access.activity} />
        </>
      )}

      {(org.access.status === 'done' || org.access.status === 'skipped') && !state.upload && (
        <div className="grid gap-3">
          <h3 className="font-medium">The database dump</h3>
          {dumps.length > 0 ? (
            <ul role="radiogroup" aria-label="Dumps" className="grid gap-2">
              {dumps.map((d) => (
                <li key={d.fileId}>
                  <button type="button" role="radio" aria-checked={pick === d.fileId} onClick={() => setChosen(d.fileId)} className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-3 text-left text-sm', pick === d.fileId && 'border-primary ring-3 ring-primary/15')}>
                    <FileArchive className="size-4 text-muted-foreground" />
                    <span className="font-mono text-[13px]">{d.name}</span>
                    <span className="text-xs text-muted-foreground">{[d.sizeBytes !== null ? bytes(d.sizeBytes) : null, d.modifiedAt ? shortDate(d.modifiedAt) : null, d.foundIn].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No dump was found through the links. Download one in your browser or upload it.</p>
          )}
          {dump && status?.rclone.remote && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button className="w-fit" disabled={working} onClick={() => void job.follow(api.startJob('dump.download', { fileId: dump.fileId, name: dump.name, ...(dump.sizeBytes !== null ? { sizeBytes: dump.sizeBytes } : {}), draftId }))}>
                {working ? <LoaderCircle className="animate-spin" /> : <FileArchive />}
                Download it with rclone
              </Button>
              {/* The file itself, to look at it or download it in the browser instead. */}
              <a href={driveUrl(dump.fileId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                Open in Google Drive <ExternalLink className="size-3" />
              </a>
            </div>
          )}
          {dump && !status?.rclone.remote && (
            <p className="text-sm">
              rclone is not set up, so download it in your browser:{' '}
              <a href={driveUrl(dump.fileId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                open {dump.name} in Google Drive <ExternalLink className="size-3" />
              </a>
              , then pick it below.
            </p>
          )}
          <div className="rounded-lg border bg-card p-4 text-sm">
            <p className="flex items-center gap-2 font-medium">
              From your Downloads folder
              <Button variant="ghost" size="sm" onClick={downloads.reload}><RefreshCw className={cn(downloads.loading && 'animate-spin')} />Look again</Button>
            </p>
            {(downloads.data ?? []).length === 0 && <p className="text-muted-foreground">No .sql, .sql.gz or .zip from the last three days yet.</p>}
            <ul className="mt-1 grid gap-1.5">
              {(downloads.data ?? []).map((d) => (
                <li key={d.file} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px]">{d.name}</span>
                  <span className="text-xs text-muted-foreground">{bytes(d.sizeBytes)} · {timeAgo(d.modifiedAt)}</span>
                  <Button size="sm" variant="outline" disabled={working} onClick={() => void job.follow(api.startJob('dump.useDownloaded', { file: d.file, draftId }))}>Use this file</Button>
                </li>
              ))}
            </ul>
          </div>
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-primary hover:underline">
            <Upload className="size-4" />
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Or upload a dump'}
            <input type="file" accept=".sql,.gz,.zip" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
          {job.job && <StepList steps={job.job.steps} open={openStep} setOpen={setOpenStep} />}
          {(job.error || error) && <p role="alert" className="text-sm text-danger">{job.error ?? error}</p>}
        </div>
      )}

      {state.upload && org.prefill && <PrefillSummary prefill={org.prefill} upload={state.upload} onChange={() => {
        // The dump you set aside goes, so coming back to the step does not bring it in again.
        const previous = state.upload?.id;
        if (previous) void api.deleteUpload(previous).catch(() => undefined);
        setState((s) => {
          if (!s.org) return { ...s, upload: null };
          const { prefill: _old, ...org } = s.org;
          return { ...s, upload: null, org };
        });
      }} />}
    </div>
    </WithClaudeCard>
  );
}

/** What the next steps start from: the dump and what it holds, where the docs differ from your setup, and what is left to you. */
function PrefillSummary({ prefill, upload, onChange }: { prefill: Prefill; upload: UploadResult; onChange: () => void }) {
  return (
    <div className="grid gap-3">
    <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
      <p className="flex flex-wrap items-center gap-2 font-medium">
        <Check className="size-4 text-success" />
        {upload.name} ({bytes(upload.size)}) is in; the next steps are filled in.
        <Button variant="ghost" size="sm" onClick={onChange}>Pick another dump</Button>
      </p>
      {prefill.differences.length > 0 && (
        <div>
          <p className="font-medium">Your setup instead of the docs</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5 text-muted-foreground">{prefill.differences.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      {prefill.notes.length > 0 && <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">{prefill.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {prefill.missing.length > 0 && (
        <p className="flex items-center gap-2 text-warning">
          <CircleAlert className="size-4 shrink-0" />
          Not found, fill it in on the next steps: {prefill.missing.join(', ')}.
        </p>
      )}
    </div>
    <DumpFactsCard facts={upload.facts} />
    </div>
  );
}

/** A step with the Claude Code card in a column of its own beside it, below it on narrow screens. */
function WithClaudeCard({ card, children }: { card: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] xl:gap-12">
      <div className="min-w-0">{children}</div>
      {card}
    </div>
  );
}

/** A Claude Code step at work: it runs as a job, so leaving the page loses nothing. */
function Working({ title, job }: { title: string; job: { steps: Array<{ status: string; activity?: string[] }> } | null }) {
  // What Claude Code did so far, kept on the job: coming back from another page shows it too.
  const lines = job?.steps.find((s) => s.status === 'running')?.activity ?? job?.steps[0]?.activity ?? [];
  return (
    <div className="grid max-w-3xl gap-3 text-sm">
      <div className="grid gap-1.5">
        <p className="flex items-center gap-2 text-muted-foreground"><Sparkles className="size-4 animate-pulse text-primary" />{title}</p>
        <p className="text-xs text-muted-foreground">{job ? 'You can leave this page. It keeps running and shows in the jobs list.' : 'Starting...'}</p>
      </div>
      {lines.length > 0 && <ActivityLines lines={lines} live />}
    </div>
  );
}

/** What Claude Code did, a line each: live while it runs, the newest last. */
function ActivityLines({ lines, live = false }: { lines: string[]; live?: boolean }) {
  return (
    <ol className="grid gap-1 rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground" aria-live={live ? 'polite' : undefined} aria-label="What Claude Code did">
      {lines.map((line, i) => (
        <li key={`${i}-${line}`} className={cn('flex min-w-0 gap-2', live && i === lines.length - 1 && 'text-foreground')}>
          <span aria-hidden="true">{live && i === lines.length - 1 ? '>' : '·'}</span>
          <span className="min-w-0 break-words">{line}</span>
        </li>
      ))}
    </ol>
  );
}

/** What a finished Claude Code step did, folded away under its answer. */
function DoneActivity({ lines }: { lines: string[] | undefined }) {
  if (!lines?.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">What Claude Code did ({lines.length === 1 ? '1 step' : `${lines.length} steps`})</summary>
      <div className="mt-2"><ActivityLines lines={lines} /></div>
    </details>
  );
}

/** The settings a Claude Code step runs with: this install's own, or the panel's defaults. */
export const runFor = (org: OrgState, status: OrgStatus, step: ClaudeStep): ClaudeRun => org.claude?.[step] ?? status.settings[step];

export const CLAUDE_MODEL_LABELS: Record<ClaudeModel, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const CLAUDE_STEP_LABELS: Record<ClaudeStep, string> = { read: 'Read the repo', access: 'Links and dump' };

/** What each Claude Code step does, for the card that sets it up the step before. */
const NEXT_STEP: Record<ClaudeStep, { text: string; then?: string }> = {
  read: { text: "Claude Code reads the repo's README, docs and build files and fills in this install.", then: 'You can change these again before Links and dump.' },
  access: { text: 'Claude Code opens the linked Asana tasks and Google files read-only, collects facts for this install and lists the database dumps in Drive.' },
};

/** A model or effort with "recommended" when it is the default this step was tuned for. */
const recommended = (step: ClaudeStep, field: 'model' | 'effort', value: string, label: string) => (DEFAULT_CLAUDE_STEPS[step][field] === value ? `${label} (recommended)` : label);

/**
 * The Claude Code card beside the organization steps: the model, effort and
 * spending cap for the next Claude step of this install, what that step does,
 * and what the runs cost so far. Changes stay with this install unless you
 * make them your defaults.
 */
/** What your defaults are, where they are kept and what they apply to, behind a question mark on the Claude Code card. */
function DefaultsHelp() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" aria-label="About your defaults" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rounded-full p-0.5 hover:bg-foreground/8 hover:text-foreground">
        <CircleHelp className="size-3.5" />
      </button>
      {open && (
        <div role="dialog" aria-label="About your defaults" className="absolute right-0 bottom-full z-30 mb-2 grid w-64 gap-2 rounded-lg border bg-card p-3 text-xs text-muted-foreground shadow-lg">
          <p><span className="font-medium text-foreground">Your defaults</span> are the model, effort and spending cap for each Claude Code step. They are under <Link href="/environment/settings" className="font-medium text-primary hover:underline">Environment, Settings</Link>, and kept in <code className="font-mono text-[11px] break-all">~/.config/devmagic-panel/organizations.json</code>.</p>
          <p>They apply to the next Claude Code step of every install that has not changed its own here, this one included.</p>
          <p><span className="font-medium text-foreground">Use as my defaults</span> saves what this card shows as your defaults. <span className="font-medium text-foreground">Back to my defaults</span> drops this install's own values.</p>
        </div>
      )}
    </div>
  );
}

export function ClaudeCard({ status, org, setState, next }: { status: OrgStatus; org: OrgState; setState: SetState; next: ClaudeStep | null }) {
  const value = next ? runFor(org, status, next) : null;
  const [cap, setCap] = useState(String(value?.budgetUsd ?? ''));
  const [saving, setSaving] = useState(false);
  useEffect(() => setCap(String(value?.budgetUsd ?? '')), [next, value?.budgetUsd]);
  const set = (patch: Partial<ClaudeRun>) => {
    if (!next || !value) return;
    setOrg(setState, (o) => ({ ...o, claude: { ...o.claude, [next]: { ...value, ...patch } } }));
  };
  const source = next ? runSource(org.claude?.[next], status.settings[next]) : 'defaults';
  // This install follows your defaults again for the next step.
  const followDefaults = () => {
    if (!next) return;
    setOrg(setState, (o) => {
      const { [next]: _own, ...rest } = o.claude ?? {};
      return { ...o, claude: rest };
    });
  };
  async function makeDefault() {
    if (!next || !value) return;
    setSaving(true);
    try {
      Object.assign(status.settings, await api.saveOrgSettings({ ...status.settings, [next]: value }));
      followDefaults();
      toast({ tone: 'success', title: `Saved as your defaults for ${CLAUDE_STEP_LABELS[next]}`, detail: 'They show under Environment, Settings, in Claude Code for installs.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Not saved', detail: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }
  const costs = (['read', 'access'] as const).flatMap((step) => {
    const run = step === 'read' ? org.read : org.access;
    return typeof run.costUsd === 'number' ? [{ label: CLAUDE_STEP_LABELS[step], usage: run as ClaudeUsage }] : [];
  });
  return (
    <aside aria-label="Claude Code" className="grid gap-4 rounded-xl border bg-card p-4 text-sm lg:sticky lg:top-4">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 font-medium">
          <Sparkles className="size-4 text-primary" />
          Claude Code
          {status.claude.version && <span className="ml-auto text-xs font-normal text-muted-foreground">{status.claude.version}</span>}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {status.claude.claudeAi ? <CircleCheck className="size-3.5 text-success" /> : <CircleAlert className="size-3.5 text-warning" />}
          {status.claude.claudeAi ? 'Signed in with claude.ai' : 'Signed in without claude.ai: Asana and Google links need it'}
        </p>
      </div>
      {next && value ? (
        <>
          <div className="grid gap-1 rounded-lg bg-muted/60 p-3 text-xs">
            <p className="font-medium text-foreground">Used for the next step: {CLAUDE_STEP_LABELS[next]}</p>
            <p className="text-muted-foreground">{NEXT_STEP[next].text}</p>
            {NEXT_STEP[next].then && <p className="text-muted-foreground">{NEXT_STEP[next].then}</p>}
          </div>
          <Field htmlFor="claude-model" label="Model">
            <Select id="claude-model" value={value.model} onChange={(e) => set({ model: e.target.value as ClaudeModel })}>
              {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{recommended(next, 'model', m, CLAUDE_MODEL_LABELS[m])}</option>)}
            </Select>
          </Field>
          <Field htmlFor="claude-effort" label="Effort" hint="Higher thinks longer and costs more.">
            <Select id="claude-effort" value={value.effort} onChange={(e) => set({ effort: e.target.value as ClaudeEffort })}>
              {CLAUDE_EFFORTS.map((m) => <option key={m} value={m}>{recommended(next, 'effort', m, CLAUDE_EFFORT_LABELS[m])}</option>)}
            </Select>
          </Field>
          <Field htmlFor="claude-cap" label="Spending cap per run, $" hint="From $0.05 to $5.">
            <Input
              id="claude-cap"
              type="number"
              min={0.05}
              max={5}
              step={0.05}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => set({ budgetUsd: Math.min(5, Math.max(0.05, Number(cap) || value.budgetUsd)) })}
            />
          </Field>
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <p className="min-w-0 flex-1">
              {source === 'defaults' ? (
                'Your defaults. A change here is for this install only.'
              ) : (
                <>
                  Changed for this install.{' '}
                  <button type="button" disabled={saving} onClick={() => void makeDefault()} className="font-medium text-primary hover:underline disabled:opacity-50">Use as my defaults</button>
                  {' · '}
                  <button type="button" disabled={saving} onClick={followDefaults} className="font-medium text-foreground hover:underline disabled:opacity-50">Back to my defaults</button>
                </>
              )}
            </p>
            <DefaultsHelp />
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No more Claude Code steps for this install.</p>
      )}
      {costs.length > 0 && (
        <div className="grid gap-2 border-t pt-3 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {costs.map(({ label, usage }) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-mono" title={usageHover(usage, status.claude.claudeAi)}>{usageText(usage)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </aside>
  );
}

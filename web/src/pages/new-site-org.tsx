import type { AccessReport, ClaudeUsage, ClaudeRun, ClaudeStep, InstallDraft, OrgRepo, OrgStatus, Prefill, RepoFacts, UploadResult } from '@devmagic-panel/shared';
import { accessKey, DEFAULT_CLAUDE_RUN, LINKS_EFFORT, gitlabHost, namespaceShortLabel, parseNamespaceRef, prefillFromFacts, registerGitlabHosts, readKey, repoWeb } from '@devmagic-panel/shared';
import { Check, CircleAlert, CircleCheck, CircleHelp, CircleX, ExternalLink, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {} from '@/components/branch-picker';
import { settled, useJob } from '@/components/job-steps';
import { DumpFactsCard } from '@/components/dump-facts';
import {} from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import {} from '@/components/ui/menu';
import { api } from '@/lib/api';
import { failureOf, runSource, usageHover, usageText } from '@/lib/claude-steps';
import { CLAUDE_EFFORT_LABELS, CLAUDE_MODEL_LABELS } from '@/components/claude-run-fields';
import { bytes } from '@/lib/format';
import { Link } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import type { RepoProgress } from '@/lib/org-repos';
import { cn } from '@/lib/utils';
import type { WizardState } from './new-site';
import { Notice } from '@/components/page';

/** Installing from an organization: the repo picked, what Claude Code read, the links it checked and the dump. */
export interface OrgState {
  name: string;
  repo: OrgRepo | null;
  read: { status: 'idle' | 'reading' | 'done' | 'error'; facts?: RepoFacts; files?: string[]; error?: string } & Partial<ClaudeUsage>;
  access: { status: 'idle' | 'checking' | 'done' | 'skipped' | 'error'; report?: AccessReport; error?: string } & Partial<ClaudeUsage>;
  /** This install's own Claude Code settings; unset, the step uses your defaults. */
  run?: ClaudeRun;
  /** The wizard's answers from the docs and the dump, once the dump is in. */
  prefill?: Prefill;
  /** The other repos you picked in this install, by full name, as you left them (lib/org-repos). */
  earlier?: Record<string, RepoProgress>;
  /** Claude Code reads the repo and its links: the Claude steps are in the install. */
  useClaude: boolean;
}

export const newOrgState = (name = '', useClaude = false): OrgState => ({ name, repo: null, read: { status: 'idle' }, access: { status: 'idle' }, useClaude });

type SetState = (update: (s: WizardState) => WizardState) => void;
const setOrg = (setState: SetState, update: (o: OrgState) => OrgState) => setState((s) => (s.org ? { ...s, org: update(s.org) } : s));

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

export function CliHints({ status, onRecheck }: { status: OrgStatus; onRecheck?: () => void }) {
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
export function cliSignedIn(status: OrgStatus, ref: string): boolean {
  const ns = parseNamespaceRef(ref);
  if (!ns) return false;
  return ns.provider === 'github' ? status.gh.signedIn : Boolean(status.glab.hosts.find((h) => h.host === ns.host)?.signedIn);
}

/** Opens a repo of the list on its host in a new tab, beside its row's button. */
export function RepoLink({ url, name }: { url: string | undefined; name: string }) {
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
 * Which of your organizations and groups the panel scans, from every CLI that
 * is signed in, and your own GitLab hosts; saved in the panel's settings.
 */
export function OrgPicker({ status, onRecheck }: { status: OrgStatus; onRecheck?: () => void }) {
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
    if (bad) return setHostsError(`${bad} is not a hostname like gitlab.wandworks.test`);
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
        hint={hostsError ? <span className="text-danger">{hostsError}</span> : <>One per line, like gitlab.wandworks.test; gitlab.com is always listed. Sign in to each once with <code className="font-mono whitespace-nowrap">glab auth login --hostname gitlab.wandworks.test</code>.</>}
      >
        <div className="flex max-w-md items-start gap-2">
          <Textarea id="gitlab-hosts" value={hostsText} onChange={(e) => setHostsText(e.target.value)} rows={2} spellCheck={false} placeholder="gitlab.wandworks.test" className="min-h-16 flex-1 font-mono text-[13px]" />
          <Button variant="outline" size="sm" disabled={saving || hostsText.trim() === settings.gitlabHosts.join('\n')} onClick={() => void saveHosts()}>Save hosts</Button>
        </div>
      </Field>
    </div>
  );
}

// ── 2. Claude reads the project ──────────────────────────────

const withoutKey = <T extends { key: string }>({ key: _key, ...rest }: T) => rest;

/**
 * The one Claude Code step: it reads the repo, then checks the links its docs
 * name, as one job. The repo's answer shows as soon as it is in, while the
 * links are still checked. Both answers are kept on the draft, so coming back
 * runs nothing again, and either part can be skipped.
 */
export function ProjectReadStep({ state, setState, status, draftId, saveNow }: { state: WizardState; setState: SetState; status: OrgStatus | null; draftId: string; saveNow: () => Promise<unknown> }) {
  const org = state.org as OrgState;
  const repo = org.repo as OrgRepo;
  const key = readKey(repo.fullName, state.branch);
  const job = useJob();
  const started = useRef<string | null>(null);
  const linksKeyOf = (facts?: RepoFacts) => accessKey(repo.fullName, linksOf(facts), facts?.dumpHints ?? []);

  /** What the draft keeps for this repo and its links, into the wizard; failed is why the job stopped, when it did. */
  const takeDraft = (draft: InstallDraft | null, failed?: string) =>
    setOrg(setState, (o) => {
      const read = draft?.results?.read?.key === key ? draft.results.read : undefined;
      if (!read) return { ...o, read: { status: 'error', error: failed ?? 'The answer was not kept: read it again' } };
      const kept = draft?.results?.access;
      const access: OrgState['access'] =
        linksOf(read.facts).length === 0 ? { status: 'skipped' }
          : kept?.key === linksKeyOf(read.facts) ? { status: 'done', ...withoutKey(kept) }
            : failed ? { status: 'error', error: failed }
              : { status: 'skipped' };
      return { ...o, read: { status: 'done', ...withoutKey(read) }, access };
    });

  /** Runs the job: the repo's answer, when the draft keeps it, is used again at no cost, so only the links run. */
  async function start() {
    if (!status) return;
    setOrg(setState, (o) => (o.read.status === 'done' ? { ...o, access: { status: 'checking' } } : { ...o, read: { status: 'reading' }, access: { status: 'idle' } }));
    // The job notes itself on the draft, so the draft is saved first.
    await saveNow().catch(() => undefined);
    void job.follow(api.startJob('org.readProject', { draftId, url: repo.sshUrl, branch: state.branch, fullName: repo.fullName, settings: runFor(org, status) }));
  }

  // Opening the step, or coming back to it: the answers kept for this repo and its links, the job still working, or a new run.
  const waiting = org.read.status === 'idle' || org.read.status === 'reading' || org.access.status === 'checking';
  useEffect(() => {
    if (!waiting || started.current === key || !status) return;
    let live = true;
    void (async () => {
      const draft = await api.draft(draftId).catch(() => null);
      const noted = draft?.jobs?.read;
      const view = noted ? await api.job(noted.id).catch(() => null) : null;
      if (!live) return;
      started.current = key;
      const mine = noted?.key === key ? view : null;
      if (mine && (mine.status === 'running' || mine.status === 'queued')) return void job.follow(Promise.resolve(mine.id));
      const kept = draft?.results?.read?.key === key ? draft.results.read : undefined;
      const linksDone = kept && (linksOf(kept.facts).length === 0 || draft?.results?.access?.key === linksKeyOf(kept.facts));
      const failed = mine?.status === 'failed' ? failureOf(mine) : undefined;
      if (failed || linksDone) return takeDraft(draft, failed);
      await start();
    })();
    return () => {
      live = false;
    };
  }, [waiting, key, status]);

  // The repo is read while the links are still checked: its answer shows at once.
  const readStep = job.job?.steps.find((s) => s.id === 'read')?.status;
  useEffect(() => {
    if (readStep !== 'done' || org.read.status === 'done' || !job.job || settled(job.job)) return;
    void api.draft(draftId).then((d) => {
      const read = d.results?.read?.key === key ? d.results.read : undefined;
      if (read) setOrg(setState, (o) => ({ ...o, read: { status: 'done', ...withoutKey(read) }, access: linksOf(read.facts).length > 0 ? { status: 'checking' } : { status: 'skipped' } }));
    }, () => undefined);
  }, [readStep]);

  // The job ended: its answers are on the draft.
  useEffect(() => {
    const view = job.job;
    if (!view || !settled(view)) return;
    api.draft(draftId).then((d) => takeDraft(d, view.status === 'done' ? undefined : failureOf(view)), (err: Error) => takeDraft(null, err.message));
  }, [job.job?.status]);
  useEffect(() => {
    if (job.error) takeDraft(null, job.error);
  }, [job.error]);

  const card = status && <ClaudeRunCard status={status} org={org} />;
  if (org.read.status === 'reading' || org.read.status === 'idle') {
    return (
      <WithClaudeCard card={card}>
        <div className="grid max-w-3xl gap-3">
          <Working title={`Claude Code is reading the README files, docs and build files of ${repo.fullName}...`} job={job.job} />
        </div>
      </WithClaudeCard>
    );
  }
  if (org.read.status === 'error') {
    return (
      <WithClaudeCard card={card}>
        <div className="grid max-w-3xl gap-3">
          <Notice tone="danger">{org.read.error}</Notice>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="w-fit" onClick={() => void start()}><RefreshCw />Read it again</Button>
          </div>
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
  const report = org.access.report;
  return (
    <WithClaudeCard card={card}>
      <div className="grid max-w-3xl gap-5">
        <section className="grid gap-3" aria-label="What the repo says">
          <h3 className="text-sm font-medium">What the repo says</h3>
          <p className="text-sm text-muted-foreground">From {org.read.files?.length ? org.read.files.join(', ') : 'no doc files: the repo has none'}.</p>
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
        </section>

        <section className="grid gap-3 border-t pt-5" aria-label="The links and the dumps">
          <h3 className="text-sm font-medium">The links and the dumps</h3>
          {links.length === 0 && <p className="text-sm text-muted-foreground">The docs link no Asana tasks or Google files, so there is nothing to check.</p>}
          {org.access.status === 'checking' && (
            <>
              <Working title={`Claude Code is checking ${links.length} ${links.length === 1 ? 'link' : 'links'} with your claude.ai account, read-only...`} job={job.job} />
              <Button variant="ghost" size="sm" className="w-fit" onClick={() => setOrg(setState, (o) => ({ ...o, access: { status: 'skipped' } }))}>Skip the links and pick a dump myself</Button>
            </>
          )}
          {org.access.status === 'error' && (
            <div className="grid gap-2">
              <Notice tone="danger">{org.access.error}</Notice>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Button variant="outline" size="sm" className="w-fit" onClick={() => void start()}><RefreshCw />Check the links again</Button>
                <span className="text-muted-foreground">Or go on and pick the dump yourself.</span>
              </div>
            </div>
          )}
          {org.access.status === 'skipped' && links.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
              <p className="min-w-0 flex-1">
                The {links.length === 1 ? 'link was' : `${links.length} links were`} not checked, so pick the dump yourself on the next step.{' '}
                <span className="text-muted-foreground">Checking them brings back an answer kept for them at no cost, or runs Claude Code once, at most ${(status ? runFor(org, status) : DEFAULT_CLAUDE_RUN).budgetUsd.toFixed(2)}.</span>
              </p>
              <Button size="sm" variant="outline" onClick={() => void start()}><Sparkles />Check the links</Button>
            </div>
          )}
          {report && (
            <>
              <ul className="grid gap-1.5 rounded-lg border bg-card p-4 text-sm">
                {report.links.map((l) => (
                  <li key={l.url} className="flex items-start gap-2">
                    {l.status === 'ok' ? <Check className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />}
                    <span className="min-w-0">
                      <span className="font-medium">{l.title ?? (l.status === 'no-access' ? 'No access' : 'Not found')}</span>{' '}
                      <a href={l.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-muted-foreground hover:underline">{l.url}</a>
                    </span>
                  </li>
                ))}
              </ul>
              {report.facts.length > 0 && (
                <ul className="grid list-disc gap-1 pl-5 text-sm">{report.facts.map((fact) => <li key={fact.text}>{fact.text} <span className="text-xs text-muted-foreground">({fact.source})</span></li>)}</ul>
              )}
              <DoneActivity lines={org.access.activity} />
            </>
          )}
        </section>

        {org.access.status !== 'checking' && (
          <p className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            {report?.dumps.length
              ? `Next, pick the dump: Claude found ${report.dumps.length === 1 ? 'one' : report.dumps.length} in Google Drive, and every other way to get one is there too.`
              : 'Next, pick the database dump: upload it, take it from your Downloads folder, a cloud drive, a URL or a server, or go on without one.'}
          </p>
        )}
      </div>
    </WithClaudeCard>
  );
}

/** What the next steps start from: the dump and what it holds, where the docs differ from your setup, and what is left to you. */
export function PrefillSummary({ prefill, upload, onChange }: { prefill: Prefill; upload: UploadResult; onChange: () => void }) {
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

/** The settings the Claude Code step runs with: this install's own, or your defaults. */
export const runFor = (org: OrgState, status: OrgStatus): ClaudeRun => org.run ?? status.settings.run;

/** The two parts of the step, as their costs are listed. */
const PART_LABELS: Record<ClaudeStep, string> = { read: 'Read the repo', access: 'Links and dumps' };

/**
 * The Claude Code card beside the step: how it is signed in, what the step
 * runs with (set on the Code step, or under Settings for every install) and
 * what its two parts cost so far.
 */
export function ClaudeRunCard({ status, org }: { status: OrgStatus; org: OrgState }) {
  const run = runFor(org, status);
  const own = runSource(org.run, status.settings.run) === 'install';
  const costs = (['read', 'access'] as const).flatMap((part) => {
    const usage = part === 'read' ? org.read : org.access;
    return typeof usage.costUsd === 'number' ? [{ label: PART_LABELS[part], usage: usage as ClaudeUsage }] : [];
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
      <div className="grid gap-2 rounded-lg bg-muted/60 p-3 text-xs">
        <p className="font-medium text-foreground">This step runs with</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Model</dt>
          <dd className="text-right">{CLAUDE_MODEL_LABELS[run.model]}</dd>
          <dt className="text-muted-foreground">Effort</dt>
          <dd className="text-right">{CLAUDE_EFFORT_LABELS[run.effort]} for the repo, {CLAUDE_EFFORT_LABELS[LINKS_EFFORT].toLowerCase()} for links</dd>
          <dt className="text-muted-foreground">Spending cap</dt>
          <dd className="text-right">${run.budgetUsd.toFixed(2)} for both</dd>
        </dl>
        <p className="text-muted-foreground">
          {own ? 'Changed for this install on the Code step.' : <>Your defaults, from <Link href="/settings" className="font-medium text-primary hover:underline">Settings</Link>. The Code step changes them for one install.</>}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Read-only: it reads the repo&apos;s docs, never wp-config.php or .env, and only opens the links those docs name.</p>
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

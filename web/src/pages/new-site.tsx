import type { AddressInput, InstallDraft, NewSiteSource, OrgStatus, RepoBuild, RepoInspection, RepoLayout, RepoPreset, Site, UploadResult } from '@devmagic-panel/shared';
import { actions, addressSummary, branchName, branchWebUrl, coreVersion as coreVersionSchema, databaseNameFor, DUMP_SCAN_GB, gitUrl, hostname, isLocalName, MEDIA_PLUGIN, mountFolder, mountPath, LOCAL_HELPER_PLUGINS, localDomainFor, type LocalHelperPlugin, repoWeb, sameRepo } from '@devmagic-panel/shared';
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, CircleCheck, CircleX, Copy, ExternalLink, FileArchive, FolderGit2, Globe, LoaderCircle, Plus, RefreshCw, Search, Sparkles, Upload, Wand2, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BranchPicker } from '@/components/branch-picker';
import { DumpFactsCard } from '@/components/dump-facts';
import { JobScreen } from '@/components/job-screen';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { installLabel } from '@/components/site-bits';
import { AccessStep, linksOf, newOrgState, type OrgState, OrgStep, ReadStep } from './new-site-org';
import { NetworkSection } from './new-site-network';
import { Input, Textarea } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Switch } from '@/components/ui/switch';
import { ReleaseListLink } from '@/components/release-link';
import { api, type DraftInput, isMockup } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { type CreateSiteInput, PRODUCTION_ONLY_PLUGINS, previewSteps } from '@/lib/plan';
import { Link, navigate } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { adminChoices, adminCreateOf, dumpAdmins } from '@/lib/admin-choice';
import { type BuildPick, buildChoice, buildId, buildSteps } from '@/lib/builds';
import { orgCardState, type OrgCardState, skipAccess, unskipAccess } from '@/lib/claude-steps';
import { draftHref, type InstallKind, KIND_LABEL, keptUntil, kindOf, landingStep, STEP_LABEL, stepsFor, type WizardStep } from '@/lib/drafts';
import { type NetworkAnswers, networkPlan, type NetworkPlan, NO_NETWORK_ANSWERS } from '@/lib/network';
import { pluginMatches } from '@/lib/plugin-search';
import { answersHash, stepViews } from '@/lib/steps';
import { useAsync } from '@/lib/use-async';
import { asideUploads } from '@/lib/org-repos';
import { cn } from '@/lib/utils';

type Step = WizardStep;

interface DomainRow {
  prod: string;
  local: string;
}

export interface WizardState {
  source: NewSiteSource;
  repoUrl: string;
  /** Empty until the repo is read; then its default branch, or the one you pick. */
  branch: string;
  /** The repo's branches, default first; null until read, or when the lookup failed (the branch is typed then). */
  branches: string[] | null;
  defaultBranch?: string;
  layout: RepoLayout;
  upload: UploadResult | null;
  domains: DomainRow[];
  coreMode: 'wpcore' | 'standalone';
  coreVersion: string;
  /** null until you type one: admin, or superadmin for a network. */
  adminUser: string | null;
  /** null until you type one: the same as the user name. Never saved; only sent with the install. */
  adminPassword: string | null;
  /** null until you type one: admin@ the primary local domain. */
  adminEmail: string | null;
  /** For a dump that has the user already: leave it, or give it this password and the admin role. */
  adminIfExists: 'keep' | 'update';
  /** For a dump without the user: create it, or add none. */
  adminIfMissing: 'create' | 'skip';
  /** For a dump whose admins the scan read: make an admin for this copy; null until you choose (on when it has none). */
  adminCreate: boolean | null;
  deactivate: string[];
  activate: LocalHelperPlugin[];
  /** The local helpers the repo's branch has, and whether it has BE Media from Production, read in the background for repo URL and branch `key`. */
  helpers: { key: string; list?: LocalHelperPlugin[]; media?: boolean; builds?: RepoBuild[]; error?: string } | null;
  /** Your ticks and scripts in the build checklist, by row (lib/builds); unset rows follow the lookup and the docs. */
  buildPicks: Record<string, BuildPick>;
  /** Where missing images load from; null until set: the first step 2 address that is not a local name. Empty: none. */
  uploadsFrom: string | null;
  /** How they load; null until chosen: BE Media from Production when the repo has it, else a redirect. */
  uploadsVia: 'redirect' | 'plugin' | null;
  /** Search and replace the production domains after the import. */
  replaceOn: boolean;
  /** For a network in the dump: its layout here and the addresses you typed for its sites. */
  network: NetworkAnswers;
  composer: boolean;
  npm: boolean;
  /** What the panel remembers about the repo, read when the URL is pasted. */
  inspection: Inspection;
  /** Install under a path of an existing site, like /learn on local.northwind.com; null for a site of its own. */
  under: { domain: string; path: string } | null;
  /** The primary domain is installed already: archive that site first and install again. */
  replaceExisting: boolean;
  /** Installing from a GitHub organization or GitLab group: the repo, what Claude Code read and the dump; null for the other starts. */
  org: OrgState | null;
  /** A hash of each step's answers when you continued from it, so the step list can open the steps you reached (lib/steps). */
  passed: Partial<Record<Step, string>>;
}

type Inspection =
  | { status: 'idle' | 'reading' | 'none'; url?: string }
  | { status: 'found'; url: string; branch: string; summary: string }
  | { status: 'claude'; url: string; branch: string; summary: string; notes: string }
  | { status: 'error'; url: string; message: string };

const initial: WizardState = {
  replaceExisting: false,
  org: null,
  source: 'repo',
  repoUrl: '',
  branch: '',
  branches: null,
  layout: 'site-root',
  upload: null,
  domains: [{ prod: '', local: '' }],
  coreMode: 'wpcore',
  coreVersion: '',
  adminUser: null,
  adminPassword: null,
  adminEmail: null,
  adminIfExists: 'keep',
  adminIfMissing: 'create',
  adminCreate: null,
  deactivate: [],
  activate: [],
  helpers: null,
  buildPicks: {},
  uploadsFrom: null,
  uploadsVia: null,
  replaceOn: true,
  network: NO_NETWORK_ANSWERS,
  composer: true,
  npm: false,
  inspection: { status: 'idle' },
  under: null,
  passed: {},
};

/**
 * An address as the dump or a site uses it: no scheme, path or trailing dot,
 * lowercase. A port stays on dump addresses and goes from local names.
 */
export function cleanAddress(value: string, keepPort = true): string {
  const host = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  return keepPort ? host : host.replace(/:\d*$/, '');
}

/** The dump's own address goes into the first row, even when the rows came from your last install of the repo. */
function withDumpAddress(domains: DomainRow[], upload: UploadResult | null): DomainRow[] {
  const host = upload?.facts.hosts[0];
  if (!host) return domains;
  return domains.map((d, i) => (i === 0 ? { ...d, prod: host } : d));
}

/** A remembered network layout as the answers the Domains step starts from: the main site keeps its own address. */
function networkAnswersOf(network: NonNullable<RepoPreset['network']>): NetworkAnswers {
  const others = network.sites.filter((x) => x.id !== 1);
  return network.layout === 'subdomain'
    ? { layout: 'subdomain', domains: Object.fromEntries(others.map((x) => [x.id, x.domain])), paths: {} }
    : { layout: 'subdirectory', domains: {}, paths: Object.fromEntries(others.map((x) => [x.id, x.path])) };
}

/** Fills the wizard from the answers of the repo's last install here; a core that is not installed keeps the current choice. */
function applyPreset(state: WizardState, found: RepoInspection, cores: string[]): WizardState {
  const project = found.preset;
  const branch = found.branch;
  const read = { branch, branches: found.branches ?? state.branches, ...(found.defaultBranch ? { defaultBranch: found.defaultBranch } : {}) };
  if (!project) return { ...state, ...read, inspection: { status: 'none', url: state.repoUrl.trim() } };
  const coreOk = project.core && cores.includes(project.core.version);
  const parts = [
    LAYOUTS.find((l) => l.value === project.layout)?.label.toLowerCase() ?? project.layout,
    project.core ? (coreOk ? `WordPress ${project.core.version}` : `WordPress ${project.core.version} (not installed here, pick another)`) : null,
    project.build.composer || project.build.npm ? `${[project.build.composer && 'composer', project.build.npm && 'npm'].filter(Boolean).join(' and ')} build` : null,
  ].filter(Boolean);
  return {
    ...state,
    ...read,
    layout: project.layout,
    // Local addresses always come from the dump (or you), never from the last install; helpers are always your pick.
    ...(project.core && coreOk ? { coreMode: project.core.mode, coreVersion: project.core.version } : {}),
    deactivate: project.deactivate,
    // A network's layout and its sites' addresses, by blog id, as you set them last time.
    ...(project.network ? { network: networkAnswersOf(project.network) } : {}),
    uploadsFrom: project.uploadsFrom ?? '',
    uploadsVia: project.uploadsVia ?? null,
    composer: project.build.composer,
    npm: project.build.npm,
    inspection: { status: 'found', url: state.repoUrl.trim(), branch, summary: parts.join(', ') },
  };
}

const LAYOUTS: Array<{ value: RepoLayout; label: string; hint: string }> = [
  { value: 'site-root', label: 'Full site root', hint: 'wp-content and wp-config in the repo' },
  { value: 'wp-content', label: 'wp-content only', hint: 'cloned into wp-content/' },
  { value: 'theme', label: 'A theme', hint: 'cloned into wp-content/themes/' },
  { value: 'plugin', label: 'A plugin', hint: 'cloned into wp-content/plugins/' },
];

/**
 * The answers each step owns, to tell whether one changed since you continued
 * from it. Never the admin password: these hashes are kept in the draft.
 */
const STEP_ANSWERS: Record<Step, (s: WizardState) => unknown> = {
  start: (s) => [s.source, s.org !== null],
  org: (s) => [s.org?.name, s.org?.repo?.fullName, s.branch.trim()],
  read: (s) => [s.org?.read.status, s.org?.read.facts],
  access: (s) => [s.org?.access.status, s.upload?.id],
  source: (s) => [s.repoUrl.trim(), s.branch.trim(), s.layout, s.upload?.id],
  domains: (s) => [s.domains, s.under, s.replaceExisting, s.replaceOn, s.network],
  wordpress: (s) => [s.coreMode, s.coreVersion, s.adminUser, s.adminEmail, s.adminIfExists, s.adminIfMissing, s.adminCreate, s.deactivate, s.activate, s.uploadsFrom, s.uploadsVia, s.composer, s.npm, s.buildPicks],
  review: () => null,
};

/** The state with this step marked as passed with its answers as they are now. */
const passStep = (s: WizardState, step: Step): WizardState => ({ ...s, passed: { ...s.passed, [step]: answersHash(STEP_ANSWERS[step](s)) } });

/** /learn from "learn", "/learn/" or " /Learn ": one leading slash, none at the end. */
export function cleanPath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

/** Admin, or superadmin for a network dump, with the same word as password and an address at the site. */
export function adminDefaults(state: WizardState, primary: string): { user: string; password: string; email: string } {
  const user = state.source === 'repo' && state.upload?.facts.multisite ? 'superadmin' : 'admin';
  return { user, password: user, email: `admin@${primary || 'local.test'}` };
}

/** The first step 2 address that is not a local name, for "Load missing images from". */
export function uploadsDefault(state: WizardState): string {
  const first = state.domains.map((d) => cleanAddress(d.prod, false)).find(Boolean) ?? '';
  return hostname.safeParse(first).success && !isLocalName(first) ? first : '';
}


/** BE Media from Production when the repo has it, unless you picked the redirect; the redirect otherwise. */
export function uploadsViaFor(state: WizardState): 'redirect' | 'plugin' {
  if (!state.helpers?.media) return 'redirect';
  return state.uploadsVia ?? 'plugin';
}

/** The site's local names, the replace, and a site under a path, from the Domains step. */
function addressesOf(state: WizardState) {
  // Under a path, the site answers at its parent's domain: every address in the dump maps to it.
  const under = state.source !== 'empty' && state.under ? { domain: state.under.domain, path: cleanPath(state.under.path) } : null;
  const locals = under ? [under.domain] : [...new Set(state.domains.map((d) => cleanAddress(d.local, false)).filter(Boolean))];
  // A row whose address is already its local name needs nothing replaced.
  const pairs = state.source === 'repo'
    ? state.domains.map((d) => ({ from: cleanAddress(d.prod), to: under ? under.domain : cleanAddress(d.local, false) })).filter((p) => p.from && p.to && p.from !== p.to)
    : [];
  return { under, locals, replace: state.replaceOn ? pairs : [] };
}

/** What the install's replace step changes, as the server works it out: the same passes, for its label and the Review step. */
export function addressesFor(input: CreateSiteInput, state: WizardState, network: NetworkPlan | null): AddressInput {
  return { hosts: input.replace, moves: input.network ? (network?.moves ?? []) : [], locals: [input.domain, ...input.aliases], httpHosts: state.upload?.facts.httpHosts };
}

/** The dump's network as it will run here, for a site of its own installed from a repo and a dump. */
export function networkFor(state: WizardState): NetworkPlan | null {
  if (state.source !== 'repo' || !state.upload) return null;
  const { under, locals, replace } = addressesOf(state);
  return under ? null : networkPlan(state.upload.facts, state.network ?? NO_NETWORK_ANSWERS, locals[0] ?? '', replace, locals);
}

/** The request the server gets, built from what the wizard collected. */
export function toInput(state: WizardState): CreateSiteInput {
  const { under, replace, locals: names } = addressesOf(state);
  const isRepo = state.source === 'repo';
  // A network's sites on domains of their own are names of this site too; a domain a site moved away from is not.
  const network = networkFor(state);
  const targets = new Set(network?.rows.map((r) => r.here.domain) ?? []);
  const gone = new Set(network?.moves.map((m) => m.from.domain).filter((d) => !targets.has(d)) ?? []);
  const locals = network ? [...new Set([...names.filter((n, i) => i === 0 || !gone.has(n)), ...targets])] : names;
  const defaults = adminDefaults(state, locals[0] ?? '');
  const uploadsFrom = cleanAddress(state.uploadsFrom ?? uploadsDefault(state), false);
  const via = uploadsViaFor(state);
  const uploadsOk = hostname.safeParse(uploadsFrom).success && !isLocalName(uploadsFrom);
  const active = new Set(state.upload?.facts.activePlugins ?? []);
  const helpers = state.helpers?.list;
  return {
    source: state.source,
    domain: locals[0] ?? '',
    ...(under ? { path: under.path } : {}),
    replaceExisting: !under && state.replaceExisting,
    // The organization or group it came from; a pasted URL on another host has none.
    ...(state.org?.repo?.org && isRepo ? { organization: state.org.repo.org } : {}),
    aliases: locals.slice(1),
    ...(isRepo ? { repo: { url: state.repoUrl.trim(), branch: state.branch.trim(), layout: state.layout } } : {}),
    ...(isRepo && state.upload ? { uploadId: state.upload.id } : {}),
    replace,
    ...(state.source !== 'empty'
      ? {
          core: { mode: state.coreMode, version: state.coreVersion },
          admin: {
            user: (state.adminUser ?? defaults.user).trim(),
            email: (state.adminEmail ?? defaults.email).trim(),
            password: state.adminPassword ?? defaults.password,
            ...adminChoices(state),
          },
        }
      : {}),
    // BE Media from Production loading the images is never also deactivated.
    deactivate: isRepo && state.upload ? state.deactivate.filter((slug) => !(via === 'plugin' && uploadsOk && slug === MEDIA_PLUGIN)) : [],
    // Only helpers the repo has, not the ones the dump has on already, and never one set to deactivate.
    activate: isRepo && helpers ? state.activate.filter((slug) => helpers.includes(slug) && !active.has(slug) && !state.deactivate.includes(slug)) : [],
    ...(isRepo && uploadsOk ? { uploadsFrom, uploadsVia: via } : { uploadsVia: 'redirect' as const }),
    build: { composer: isRepo && state.composer, npm: isRepo && state.npm },
    ...(isRepo && state.helpers?.builds ? { builds: buildSteps(state.helpers.builds, state.buildPicks, state.org?.read.facts?.buildCommands ?? []) } : {}),
    // Each site kept where it is: nothing moves, and new sites follow the dump's own setting.
    ...(network && network.layout !== 'keep' ? { network: { layout: network.layout, sites: network.rows.map((r) => ({ id: r.site.id, ...r.here })) } } : {}),
  };
}

/** A draft's answers back in the wizard: never a password, and no dump that is gone. */
export function stateFromDraft(draft: InstallDraft): WizardState {
  const saved = (draft.state ?? {}) as Partial<WizardState>;
  const upload = saved.upload && draft.uploads.includes(saved.upload.id) ? saved.upload : null;
  const kept: WizardState = { ...initial, ...saved, upload, adminPassword: null, org: saved.org ? keptOrg(saved.org, draft.uploads) : null };
  // Lookups that were still running when you left start again: the repo's and its helpers'.
  const state: WizardState = {
    ...kept,
    inspection: kept.inspection.status === 'reading' ? { status: 'idle' } : kept.inspection,
    helpers: kept.helpers && !kept.helpers.list && !kept.helpers.error ? null : kept.helpers,
  };
  if (saved.passed) return state;
  // A draft saved before steps kept their hashes: the steps before where it stopped count as passed.
  const flow = stepsFor(state.source, Boolean(state.org));
  return flow.slice(0, Math.max(0, flow.indexOf(draft.step as Step))).reduce(passStep, state);
}

/** A link to the repo's page in a new tab, inside a field's hint. */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-primary hover:underline">
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** The repos an organization install put aside, each without a dump that is gone. */
function keptOrg(org: OrgState, uploads: string[]): OrgState {
  if (!org.earlier) return org;
  const earlier = Object.fromEntries(Object.entries(org.earlier).map(([name, p]) => [name, p.state.upload && !uploads.includes(p.state.upload.id) ? { ...p, state: { ...p.state, upload: null } } : p]));
  return { ...org, earlier };
}

/** The fallback name of an install that has no domain or repo yet. */
const UNNAMED = 'New site';

/** What an install is called in lists and its header: its domain, else its repo. */
function titleOf(state: WizardState, input: CreateSiteInput): string {
  const repo = state.repoUrl.trim().replace(/\.git$/, '').split(/[:/]/).slice(-2).join('/');
  return `${input.domain}${input.path ?? ''}` || state.org?.repo?.fullName || (state.source === 'repo' && repo) || UNNAMED;
}

/** What a draft keeps of the wizard: all answers but the password, which is only sent with the install. */
export function draftOf(state: WizardState, step: Step, input: CreateSiteInput): DraftInput {
  return {
    kind: state.org ? 'organization' : 'manual',
    title: titleOf(state, input),
    step,
    state: { ...state, adminPassword: null } as unknown as Record<string, unknown>,
    // The dumps of repos an organization install put aside stay with the draft too.
    uploads: [...new Set([...(state.upload ? [state.upload.id] : []), ...asideUploads(state.org)])],
  };
}

/** Where the page stands with its draft; a new install has none until you continue from Start. */
type Opened = { status: 'new' | 'loading' | 'ready' | 'gone' } | { status: 'installing'; jobId?: string } | { status: 'error'; message: string };

/** What the header says about the draft. */
interface Saved {
  updatedAt: string;
  expiresAt?: string;
  failed: boolean;
}

const savedOf = (draft: InstallDraft): Saved => ({ updatedAt: draft.updatedAt, ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}), failed: draft.status === 'failed' });

/**
 * The new site wizard. /sites/new starts an install; continuing from Start
 * makes its draft, and from then on the address names the draft and its step
 * (/sites/new/<draft>/domains), so Back and Forward move between steps, a
 * reload stays, and a link opens it again.
 */
export function NewSitePage({ draft: routeDraft, step: routeStep }: { draft?: string; step?: string }) {
  const [state, setState] = useState<WizardState>(initial);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setTouched(true);
    setState((s) => ({ ...s, [key]: value }));
  };
  const setOrgState = (update: (s: WizardState) => WizardState) => {
    setTouched(true);
    setState(update);
  };
  // The draft the answers are saved to: none until you continue from Start, so looking at the start cards keeps nothing.
  const draftId = useRef<string | null>(null);
  const [opened, setOpened] = useState<Opened>({ status: routeDraft ? 'loading' : 'new' });
  const [saved, setSaved] = useState<Saved | null>(null);
  // Create site starts the install here; it has no address of its own, so Back from its job never starts it again.
  const [running, setRunning] = useState(false);
  const [touched, setTouched] = useState(false);
  // Another start card picked in a draft past Start: asked before its answers go.
  const [switchTo, setSwitchTo] = useState<InstallKind | null>(null);
  const [discarding, setDiscarding] = useState<'ask' | 'busy' | null>(null);
  // The save that waits for a pause in your changes.
  const pending = useRef<(() => void) | null>(null);

  const cores = useAsync(() => api.cores(), []);
  const sites = useAsync(() => api.sites(), []);
  const assistant = useAsync(() => api.assistant(), []);
  const orgStatus = useAsync(() => api.orgStatus(), []);

  function fresh() {
    draftId.current = null;
    setState({ ...initial, coreVersion: cores.data?.[0] ?? '' });
    setSaved(null);
    setTouched(false);
    setRunning(false);
    setSwitchTo(null);
    setDiscarding(null);
    setSubmitError(null);
    setOpened({ status: 'new' });
  }

  // The address names the draft: open it, or start again at /sites/new.
  useEffect(() => {
    // The draft this page made when you continued from Start is open already.
    if (routeDraft && routeDraft === draftId.current) return;
    // Another draft, or a new install: the last change to this one is saved first.
    pending.current?.();
    if (!routeDraft) {
      if (opened.status !== 'new') fresh();
      return;
    }
    let live = true;
    draftId.current = null;
    setOpened({ status: 'loading' });
    api.draft(routeDraft).then(
      (draft) => {
        if (!live) return;
        if (draft.status === 'installing') {
          setOpened({ status: 'installing', ...(draft.jobId ? { jobId: draft.jobId } : {}) });
          return;
        }
        const next = stateFromDraft(draft);
        draftId.current = draft.id;
        setState(next);
        // The dump as the panel reads it now: a draft from before a better dump scan gets the new facts, its answers stay.
        if (next.upload) {
          const id = next.upload.id;
          api.uploadInfo(id).then((upload) => live && setState((s) => (s.upload?.id === id ? { ...s, upload } : s)), () => undefined);
        }
        setSaved(savedOf(draft));
        setTouched(false);
        setRunning(false);
        setSwitchTo(null);
        setDiscarding(null);
        setSubmitError(null);
        setOpened({ status: 'ready' });
        // Without a step, or with one it cannot open yet, it opens where it stopped or as far as it got.
        const land = landingStep(stepsFor(next.source, Boolean(next.org)), routeStep ?? draft.step, next.passed);
        if (land !== routeStep) navigate(draftHref(draft.id, land), { replace: true });
      },
      (err: Error & { status?: number }) => {
        if (live) setOpened(err.status === 404 ? { status: 'gone' } : { status: 'error', message: err.message });
      },
    );
    return () => {
      live = false;
    };
  }, [routeDraft]);

  // The newest core is the default.
  useEffect(() => {
    const newest = cores.data?.[0];
    if (newest) setState((s) => (s.coreVersion ? s : { ...s, coreVersion: newest }));
  }, [cores.data]);

  const flow = stepsFor(state.source, Boolean(state.org));
  const inDraft = opened.status === 'ready';
  const step: Step = inDraft ? landingStep(flow, routeStep, state.passed) : 'start';
  // A step the draft's kind has not, or one it cannot open yet: the address moves to the one it opens.
  useEffect(() => {
    if (inDraft && draftId.current && step !== routeStep) navigate(draftHref(draftId.current, step), { replace: true });
  }, [inDraft, step, routeStep]);
  const index = flow.indexOf(step);
  const input = toInput(state);
  const kind = kindOf(state.source, Boolean(state.org));
  const title = titleOf(state, input);

  /** Saves the draft and keeps what the header says about it. */
  const persist = (id: string, s: WizardState, at: Step) =>
    api.saveDraft(id, draftOf(s, at, toInput(s))).then((draft) => {
      if (draftId.current === id) setSaved(savedOf(draft));
      return draft;
    });
  // Right away, for a step whose job notes itself on the draft.
  const saveNow = () => (draftId.current ? persist(draftId.current, state, step) : Promise.resolve());
  // Saved a moment after each change, until the install starts.
  useEffect(() => {
    // Once the install starts the draft is the server's: nothing waits to be saved.
    if (running) pending.current = null;
    if (!touched || running || !draftId.current) return;
    const save = () => {
      pending.current = null;
      // Read when it runs: a discarded draft is not made again.
      if (draftId.current) void persist(draftId.current, state, step).catch(() => undefined);
    };
    pending.current = save;
    const timer = window.setTimeout(save, 800);
    return () => window.clearTimeout(timer);
  }, [state, step, touched]);
  // Leaving the page saves a change still waiting, so Back right after one keeps it.
  useEffect(() => () => pending.current?.(), []);

  // The browser tab names the install.
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    document.title = inDraft && title !== UNNAMED ? `${title} · New site` : 'New site';
  }, [inDraft, title]);

  const goTo = (s: Step) => {
    if (draftId.current) navigate(draftHref(draftId.current, s));
  };
  function applyKind(next: InstallKind) {
    setTouched(true);
    setSwitchTo(null);
    setState((s) => (next === 'org' ? { ...s, source: 'repo', org: s.org ?? newOrgState(orgStatus.data?.settings.selected[0] ?? '') } : { ...s, source: next, org: null }));
  }
  // Past Start the draft has answers for its kind: switching asks first.
  const choose = (next: InstallKind) => (next === kind ? setSwitchTo(null) : state.passed.start !== undefined ? setSwitchTo(next) : applyKind(next));

  async function discard() {
    const id = draftId.current;
    if (!id) return;
    setDiscarding('busy');
    // Nothing saves it again once it goes.
    draftId.current = null;
    try {
      await api.discardDraft(id);
      toast({ tone: 'success', title: 'Install discarded' });
      navigate('/sites/new', { replace: true });
    } catch (err) {
      draftId.current = id;
      setDiscarding(null);
      toast({ tone: 'danger', title: 'Not discarded', detail: (err as Error).message });
    }
  }
  const taken = new Set((sites.data ?? []).flatMap((s) => [s.domain, ...s.aliases]));
  // The site the primary domain already belongs to: a reinstall archives it first and frees its names.
  const existing = state.source !== 'empty' && state.under ? undefined : (sites.data ?? []).find((s) => !s.path && s.domain === input.domain);
  const freed = new Set(existing && state.replaceExisting ? [existing.domain, ...existing.aliases] : []);
  // Two rows may share a local name: www.shop.com and shop.com both become local.shop.com.
  const network = networkFor(state);
  const domainErrors = state.domains.map((d) => {
    const local = cleanAddress(d.local, false);
    if (!local) return null;
    if (!isLocalName(local)) return 'Use local.*, *.test or *.localhost';
    if (taken.has(local) && !freed.has(local)) return existing && local === existing.domain ? 'Installed already: see below' : 'Another site already uses this domain';
    return null;
  });
  // A network site's own domain may be another site's already.
  const networkErrors = new Map((network?.rows ?? []).filter((r) => !r.main && taken.has(r.here.domain) && !freed.has(r.here.domain)).map((r) => [r.site.id, 'Another site already uses this domain']));
  const uploadsTyped = cleanAddress(state.uploadsFrom ?? '', false);
  const uploadsError =
    state.source !== 'repo' || state.uploadsFrom === null || uploadsTyped === ''
      ? null
      : isLocalName(uploadsTyped)
        ? 'A local name would load images from this site itself'
        : !hostname.safeParse(uploadsTyped).success
          ? 'A domain like www.example.com'
          : null;

  // A network needs a domain of its own: a dump that holds one drops "install under a path", from a draft too.
  const networkDump = state.source === 'repo' && Boolean(state.upload?.facts.multisite);
  useEffect(() => {
    if (networkDump && state.under) setState((s) => ({ ...s, under: null }));
  }, [networkDump, state.under]);

  // The local helpers the chosen branch has, read in the background so step 4 only offers those.
  const repoUrl = state.repoUrl.trim();
  const helpersKey = `${repoUrl}|${state.branch}`;
  useEffect(() => {
    if (state.source !== 'repo' || !gitUrl.safeParse(repoUrl).success || !branchName.safeParse(state.branch).success || state.helpers?.key === helpersKey) return;
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, helpers: { key: helpersKey } }));
      api.repoHelpers(repoUrl, state.branch).then(
        ({ helpers: list, mediaPlugin, builds }) =>
          // Nothing is ticked for you: you pick the helpers to turn on.
          setState((s) => (s.helpers?.key !== helpersKey ? s : { ...s, helpers: { key: helpersKey, list, media: mediaPlugin, builds }, activate: s.activate.filter((slug) => list.includes(slug)) })),
        (err: Error) => setState((s) => (s.helpers?.key === helpersKey ? { ...s, helpers: { key: helpersKey, error: err.message } } : s)),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state.source, repoUrl, state.branch, helpersKey, state.helpers?.key]);
  // Where a site under a path goes, and what stops it: no parent, an odd path, or one already served.
  const underFolder = input.path ? mountFolder(input.domain, input.path) : null;
  const underError = !state.under || state.source === 'empty'
    ? null
    : !state.under.domain
      ? 'Pick the site to put it under'
      : !mountPath.safeParse(input.path ?? '').success
        ? 'A path like /learn'
        : !underFolder
          ? 'This path gives no usable folder name'
          : (sites.data ?? []).some((s) => (s.domain === input.domain && (s.path === input.path || s.mounts?.some((m) => m.path === input.path))) || s.docroot.endsWith(`/${underFolder}`))
            ? `${input.domain}${input.path} or its folder is already taken`
            : null;
  const dbName = input.domain ? databaseNameFor(underFolder ?? input.domain, (sites.data ?? []).flatMap((s) => (s.db ? [s.db.name] : []))) : '';

  const canNext: Record<Step, boolean> = {
    start: true,
    org: Boolean(state.org?.repo) && branchName.safeParse(state.branch.trim()).success,
    read: state.org?.read.status === 'done',
    access: state.upload !== null,
    source: gitUrl.safeParse(repoUrl).success && branchName.safeParse(state.branch.trim()).success && state.upload !== null,
    domains: state.under && state.source !== 'empty'
      ? !underError && Boolean(input.path)
      : Boolean(input.domain) && domainErrors.every((e) => !e) && state.domains.every((d) => d.local.trim()) && !network?.rows.some((r) => r.error) && networkErrors.size === 0,
    wordpress: Boolean(input.admin?.user) && Boolean(input.admin?.email.includes('@')) && coreVersionSchema.safeParse(state.coreVersion).success && !uploadsError,
    review: true,
  };

  function next() {
    if (step === 'review') {
      const parsed = actions['site.create'].input.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setSubmitError(`${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
        return;
      }
      setSubmitError(null);
      // The draft gets your last change before the install takes it over.
      pending.current?.();
      setRunning(true);
      return;
    }
    const n = flow[index + 1];
    if (!n) return;
    let passed = passStep(state, step);
    // Check access after a skip checks: the answer kept for these links comes back, or Claude Code runs.
    if (step === 'read' && passed.org) passed = { ...passed, org: { ...passed.org, access: unskipAccess(passed.org.access) } };
    setTouched(true);
    setState(passed);
    if (!draftId.current) {
      // Continuing from Start makes the draft; Back comes back to Start with your choice.
      const id = crypto.randomUUID();
      draftId.current = id;
      setOpened({ status: 'ready' });
      void persist(id, passed, n).catch(() => undefined);
      navigate(draftHref(id, 'start'), { replace: true });
    }
    navigate(draftHref(draftId.current, n));
  }
  const back = () => {
    const p = flow[index - 1];
    if (p) goTo(p);
  };
  const views = stepViews(flow, step, state.passed, (s) => answersHash(STEP_ANSWERS[s](state)), (s) => canNext[s]);
  const stale = flow.some((s) => views[s].stale);

  const wizard = (opened.status === 'new' || inDraft) && !running;
  const named = inDraft && title !== UNNAMED;

  return (
    <div className="pt-2">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/sites" className="hover:text-foreground">Sites</Link>
        <ChevronRight className="size-3.5 shrink-0" />
        {inDraft ? (
          <>
            <Link href="/sites/new" className="shrink-0 hover:text-foreground">New site</Link>
            <ChevronRight className="size-3.5 shrink-0" />
            <span aria-current="page" className={cn('truncate text-foreground', named && 'font-mono text-[13px]')}>{named ? title : 'Draft'}</span>
          </>
        ) : (
          <span aria-current="page" className="text-foreground">New site</span>
        )}
      </nav>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className={cn('min-w-0 truncate text-2xl font-semibold tracking-tight', named && 'font-mono')}>{named ? title : 'New site'}</h1>
        {inDraft && <Badge tone="primary">{KIND_LABEL[kind]}</Badge>}
      </div>
      {inDraft && saved && <SavedLine saved={saved} discarding={discarding} onDiscarding={setDiscarding} onDiscard={() => void discard()} />}

      {wizard && (
        <>
          <ol className="mt-5 flex flex-wrap items-center gap-1 text-sm" aria-label="Steps">
            {flow.map((s, i) => {
              const view = views[s];
              return (
                <li key={s} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!view.open || s === step}
                    onClick={() => goTo(s)}
                    aria-current={s === step ? 'step' : undefined}
                    title={view.stale ? 'An answer before this step changed: continue to check it again' : undefined}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 transition-colors',
                      s === step
                        ? 'border-primary/25 bg-secondary font-medium text-secondary-foreground'
                        : view.open
                          ? 'border-foreground/10 bg-foreground/4 text-foreground hover:border-foreground/20 hover:bg-foreground/10'
                          : 'cursor-not-allowed border-foreground/10 bg-foreground/4 text-muted-foreground opacity-60',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
                        view.done ? 'bg-primary text-primary-foreground' : s === step ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {view.done ? <Check className="size-3" /> : i + 1}
                    </span>
                    {/* The first step names the kind you picked, which sets the steps after it. */}
                    {s === 'start' ? KIND_LABEL[kind] : STEP_LABEL[s]}
                  </button>
                  {i < flow.length - 1 && <ChevronRight className="size-3.5 text-muted-foreground" />}
                </li>
              );
            })}
          </ol>
          {stale && <p className="mt-2 text-xs text-muted-foreground">An answer changed: continue to check the next steps again, or put it back to open them.</p>}
        </>
      )}

      <div className="mt-6">
        {opened.status === 'loading' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Opening the install...</p>}
        {(opened.status === 'gone' || opened.status === 'error') && <DraftGone {...(opened.status === 'error' ? { error: opened.message } : {})} />}
        {opened.status === 'installing' && <DraftInstalling {...(opened.jobId ? { jobId: opened.jobId } : {})} />}
        {wizard && step === 'start' && (
          <>
            {switchTo && (
              <div role="alert" className="mb-4 max-w-3xl rounded-xl border border-warning/30 bg-warning/6 p-4 text-sm">
                <p className="font-medium">Switch this install to {KIND_LABEL[switchTo]}?</p>
                <p className="mt-1 text-muted-foreground">
                  {state.org ? 'Its organization, repo read and dump answers are dropped. ' : ''}Answers both kinds use, like the domains, stay.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => applyKind(switchTo)}>Switch</Button>
                  <Button size="sm" variant="soft" onClick={() => setSwitchTo(null)}>Keep {KIND_LABEL[kind]}</Button>
                </div>
              </div>
            )}
            <StartStep
              value={state.source}
              fromOrg={Boolean(state.org)}
              org={{ status: orgStatus.data ?? null, checking: orgStatus.loading, error: orgStatus.error, onRecheck: orgStatus.reload }}
              onChange={choose}
              onPickOrg={() => choose('org')}
            />
          </>
        )}
        {wizard && step === 'org' && <OrgStep state={state} setState={setOrgState} status={orgStatus.data ?? null} blank={initial} onRecheck={orgStatus.reload} />}
        {wizard && step === 'read' && (
          <ReadStep
            state={state}
            setState={setOrgState}
            status={orgStatus.data ?? null}
            draftId={draftId.current ?? ''}
            saveNow={saveNow}
            onSkip={() => {
              setOrgState((s) => passStep(s.org ? { ...s, org: { ...s.org, access: skipAccess(s.org.access) } } : s, 'read'));
              goTo('access');
            }}
          />
        )}
        {wizard && step === 'access' && <AccessStep state={state} setState={setOrgState} status={orgStatus.data ?? null} cores={cores.data ?? []} draftId={draftId.current ?? ''} saveNow={saveNow} />}
        {wizard && step === 'source' && <SourceStep state={state} setState={setState} sites={sites.data ?? []} cores={cores.data ?? []} assistantOn={assistant.data?.enabled === true} />}
        {wizard && step === 'domains' && <DomainsStep state={state} set={set} errors={domainErrors} sites={sites.data ?? []} underError={underError} underFolder={underFolder} existing={existing} network={network} networkErrors={networkErrors} summary={state.upload ? addressSummary(addressesFor(input, state, network), input.network?.layout) : null} />}
        {wizard && step === 'wordpress' && <WordPressStep state={state} set={set} cores={cores.data ?? []} input={input} uploadsError={uploadsError} />}
        {wizard && step === 'review' && <ReviewStep state={state} set={set} input={input} dbName={dbName} cores={cores.data} />}
        {running && <RunScreen input={{ ...input, ...(draftId.current ? { draftId: draftId.current } : {}) }} onBack={() => setRunning(false)} />}
      </div>

      {wizard && submitError && <p role="alert" className="mt-4 text-sm text-danger">{submitError}</p>}

      {wizard && (
        <div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
          <Button variant="soft" onClick={back} disabled={index === 0}>
            <ArrowLeft />
            Back
          </Button>
          <Button onClick={next} disabled={!canNext[step]}>
            {step === 'review' ? <Wand2 /> : null}
            {step === 'review' ? 'Create site' : step === 'read' && linksOf(state.org?.read.facts).length > 0 && state.org?.access.status !== 'done' ? 'Check access' : 'Continue'}
            {step !== 'review' && <ArrowRight />}
          </Button>
        </div>
      )}
    </div>
  );
}

/** When the draft was saved and when it goes, kept current while you stay on a step; Discard asks first. */
function SavedLine({ saved, discarding, onDiscarding, onDiscard }: { saved: Saved; discarding: 'ask' | 'busy' | null; onDiscarding: (v: 'ask' | null) => void; onDiscard: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {saved.failed && <span className="font-medium text-warning">The install failed: change what it needs and create it again ·</span>}
      <span>Draft, saved {timeAgo(saved.updatedAt)}{saved.expiresAt ? `, kept until ${keptUntil(saved.expiresAt)}` : ''}</span>
      <span aria-hidden>·</span>
      {discarding ? (
        <span role="group" aria-label="Discard this install" className="inline-flex flex-wrap items-center gap-x-2">
          Discard this install? Its answers and any dump it holds go.
          <button type="button" disabled={discarding === 'busy'} onClick={onDiscard} className="font-medium text-danger hover:underline disabled:opacity-50">Discard</button>
          <button type="button" disabled={discarding === 'busy'} onClick={() => onDiscarding(null)} className="font-medium text-foreground hover:underline disabled:opacity-50">Keep</button>
        </span>
      ) : (
        <button type="button" onClick={() => onDiscarding('ask')} className="font-medium hover:text-foreground hover:underline">Discard</button>
      )}
    </p>
  );
}

/** A draft's address that opens nothing: it was installed, discarded or ran out, or the panel could not read it. */
function DraftGone({ error }: { error?: string }) {
  return (
    <Card className="max-w-xl p-5">
      <p className="font-medium">{error ? 'This install did not open' : 'This install is no longer here'}</p>
      <p className="mt-1 text-sm text-muted-foreground">{error ?? 'It was installed or discarded, or it ran out 24 hours after its last change.'}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => navigate('/sites/new', { replace: true })}><Plus />Start a new install</Button>
        <ButtonLink variant="outline" href="/sites">Sites</ButtonLink>
      </div>
    </Card>
  );
}

/** A draft whose install runs: its answers stay as they are until it ends. */
function DraftInstalling({ jobId }: { jobId?: string }) {
  return (
    <Card className="max-w-xl p-5">
      <p className="font-medium">This install is running</p>
      <p className="mt-1 text-sm text-muted-foreground">Its answers stay as they are while it runs. If it fails, the draft opens here again to change and run it once more.</p>
      {jobId && <ButtonLink className="mt-4" href={`/jobs/${encodeURIComponent(jobId)}`}>See progress<ArrowRight /></ButtonLink>}
    </Card>
  );
}

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;

// ── Start ────────────────────────────────────────────────────

// Only colours and the shadow animate: the Claude card swaps its 1px border for a 2px one and a pixel of padding,
// and animating both would move its content by a pixel on the way.
const START_CARD = 'flex h-full w-full flex-col items-start gap-3 rounded-xl p-5 text-left transition-[color,background-color,border-color,box-shadow]';
/** The picked card: a light tint and a 2px edge (its border and a 1px ring), so the choice never rests on the icon alone. */
const START_PICKED = 'border-primary bg-primary/6 shadow-[0_0_0_1px_var(--primary)]';

/** The radio mark in every start card's top right corner. */
function RadioMark({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card',
        disabled && 'opacity-50',
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

/** A start card's icon, badge, radio mark, title and text; the text is kept to three lines at four cards a row. */
function StartCardBody({ icon, active, badge, title, text, muted }: { icon: ReactNode; active: boolean; badge?: ReactNode; title: string; text: string; muted?: boolean }) {
  return (
    <>
      <span className="flex w-full items-start gap-2">
        <span className={cn('inline-flex size-9 items-center justify-center rounded-lg [&_svg]:size-4.5', active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{icon}</span>
        <span className="ml-auto flex items-center gap-2">
          {badge}
          <RadioMark checked={active} disabled={muted === true} />
        </span>
      </span>
      <span>
        <span className={cn('block font-medium', muted && 'text-muted-foreground')}>{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{text}</span>
      </span>
    </>
  );
}

type StartChoice = NewSiteSource | 'org';

function StartStep({ value, fromOrg, org, onChange, onPickOrg }: { value: NewSiteSource; fromOrg: boolean; org: OrgCardProps; onChange: (v: NewSiteSource) => void; onPickOrg: () => void }) {
  const options: Array<{ value: NewSiteSource; title: string; text: string; icon: ReactNode; recommended?: boolean }> = [
    { value: 'repo', title: 'From Git and DB dump', text: 'Clone a project, import its database and map its domains to local ones.', icon: <FolderGit2 />, recommended: true },
    { value: 'wordpress', title: 'Fresh WordPress', text: 'A clean install, linked to a shared core or with its own copy.', icon: <Wand2 /> },
    { value: 'empty', title: 'Empty site', text: 'Folder, certificate, vhost and hosts line only. For anything that is not WordPress.', icon: <Globe /> },
  ];
  const usable = (['ready', 'api'] as OrgCardState[]).includes(orgCardState(org));
  const picked: StartChoice = fromOrg ? 'org' : value;
  const order: StartChoice[] = [...(usable ? (['org'] as const) : []), ...options.map((o) => o.value)];
  // One card is in the tab order, the picked one; arrow keys move the choice, as in any radio group.
  const focusable = order.includes(picked) ? picked : order[0];
  const refs = useRef(new Map<StartChoice, HTMLButtonElement>());
  const keep = (id: StartChoice) => (el: HTMLButtonElement | null) => void (el ? refs.current.set(id, el) : refs.current.delete(id));
  const pick = (id: StartChoice) => (id === 'org' ? onPickOrg() : onChange(id));
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const move = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!move || !(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'radio') return;
    e.preventDefault();
    const next = order[(Math.max(0, order.indexOf(picked)) + move + order.length) % order.length] as StartChoice;
    pick(next);
    refs.current.get(next)?.focus();
  }
  return (
    <div role="radiogroup" aria-label="What are you setting up?" onKeyDown={onKeyDown} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <OrgCard {...org} checked={fromOrg} onPick={onPickOrg} buttonRef={keep('org')} tabIndex={focusable === 'org' ? 0 : -1} />
      {options.map((o) => {
        const on = !fromOrg && value === o.value;
        return (
          <button
            key={o.value}
            ref={keep(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={focusable === o.value ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(START_CARD, 'border bg-card hover:border-primary/50', on && START_PICKED)}
          >
            <StartCardBody icon={o.icon} active={on} badge={o.recommended && <Badge tone="success">Most used</Badge>} title={o.title} text={o.text} />
          </button>
        );
      })}
    </div>
  );
}

interface OrgCardProps {
  status: OrgStatus | null;
  checking: boolean;
  error: string | null;
  onRecheck: () => void;
}

/**
 * The organization start. It can be picked once Claude Code is installed and
 * signed in, and gets the animated border with a claude.ai sign-in, the one
 * that reaches Asana and Google. One status line of fixed height says where it
 * stands, and How to set up opens over the cards, so no card changes height.
 */
function OrgCard({ status, checking, error, onRecheck, checked, onPick, buttonRef, tabIndex }: OrgCardProps & { checked: boolean; onPick: () => void; buttonRef: (el: HTMLButtonElement | null) => void; tabIndex: number }) {
  const state = orgCardState({ status, checking });
  const usable = state === 'ready' || state === 'api';
  const on = checked && usable;
  const [help, setHelp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!help) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setHelp(false);
    const escape = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setHelp(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [help]);
  useEffect(() => setHelp(false), [state]);
  const recheck = () => {
    setHelp(false);
    onRecheck();
  };
  const link = (label: string, onClick: () => void, expanded?: boolean) => (
    <button type="button" onClick={onClick} aria-expanded={expanded} className="pointer-events-auto font-medium text-primary hover:underline">{label}</button>
  );
  const howTo = link('How to set up', () => setHelp((v) => !v), help);
  const command = (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/60 py-1 pr-1 pl-2.5">
      <code className="font-mono text-[12px] whitespace-nowrap text-foreground">claude auth login</code>
      <button
        type="button"
        aria-label="Copy the command"
        className="rounded-md p-1.5 hover:bg-foreground/8 hover:text-foreground"
        onClick={() => void navigator.clipboard?.writeText('claude auth login').then(() => toast({ tone: 'success', title: 'Command copied' }))}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
  return (
    <div ref={box} className="relative flex">
      <button
        ref={buttonRef}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={!usable}
        tabIndex={tabIndex}
        onClick={onPick}
        className={cn(
          START_CARD,
          'pb-12',
          // The Claude border is 2px: a pixel less padding keeps the card the size of the others.
          state === 'ready' ? 'ai-border p-[19px] pb-[47px] hover:shadow-md' : usable ? 'border bg-card hover:border-primary/50' : 'cursor-not-allowed border border-dashed bg-card/60',
          on && (state === 'ready' ? 'ai-picked' : START_PICKED),
        )}
      >
        <StartCardBody
          icon={<FolderGit2 />}
          active={on}
          badge={<Badge tone="primary"><Sparkles className="size-3" />Claude</Badge>}
          title="From an organization or group"
          text="Pick a repo from a GitHub organization or a GitLab group. Claude reads its docs and links and fills in the rest."
          muted={!usable}
        />
      </button>
      <p role="status" title={state === 'error' ? (error ?? undefined) : undefined} className="pointer-events-none absolute inset-x-5 bottom-4 flex h-5 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
        {state === 'checking' && <><LoaderCircle className="animate-spin text-primary" />Checking Claude Code...</>}
        {state === 'ready' && <><CircleCheck className="text-success" />Signed in with claude.ai</>}
        {state === 'api' && <><CircleAlert className="text-warning" />Signed in without claude.ai ·{howTo}</>}
        {state === 'signed-out' && <><CircleAlert className="text-warning" />Not signed in ·{howTo}</>}
        {state === 'missing' && <><CircleAlert className="text-warning" />Not installed ·{howTo}</>}
        {state === 'error' && <><CircleX className="text-danger" />Could not check ·{link('Check again', recheck)}</>}
      </p>
      {help && (
        <div role="dialog" aria-label="Set up Claude Code" className="absolute inset-x-2 top-full z-20 mt-2 grid gap-2.5 rounded-lg border bg-card p-3.5 text-xs text-muted-foreground shadow-lg">
          {state === 'missing' ? (
            <p>
              Claude Code is not installed. Install it, then sign in with <code className="font-mono text-foreground">claude auth login</code>. <Link href="/environment" className="font-medium text-primary hover:underline">Environment</Link> has the steps.
            </p>
          ) : (
            <>
              <p>{state === 'api' ? 'Asana and Google links need a claude.ai sign-in.' : 'Claude Code is not signed in.'} Run this in a terminal:</p>
              {command}
            </>
          )}
          <Button variant="soft" size="sm" className="justify-self-start" onClick={recheck}>
            <RefreshCw />
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Repo and database ────────────────────────────────────────

/** Existing sites (their themes and plugins, and their mounted folders) whose git remote is this repo. */
export function sitesUsingRepo(sites: Site[], url: string): Array<{ domain: string; path?: string; branch: string }> {
  if (!gitUrl.safeParse(url).success) return [];
  return sites.flatMap((site) => [
    ...(site.git?.remote && sameRepo(site.git.remote, url) ? [{ domain: site.domain, ...(site.path ? { path: site.path } : {}), branch: site.git.branch }] : []),
    ...(site.repos ?? []).flatMap((r) =>
      r.git.remote && sameRepo(r.git.remote, url) ? [{ domain: site.domain, ...(site.path ? { path: site.path } : {}), branch: r.git.branch }] : [],
    ),
    ...(site.mounts ?? []).flatMap((m) =>
      m.git?.remote && sameRepo(m.git.remote, url) ? [{ domain: site.domain, path: m.path, branch: m.git.branch }] : [],
    ),
  ]);
}

function SourceStep({ state, setState, sites, cores, assistantOn }: {
  state: WizardState;
  setState: (fn: (s: WizardState) => WizardState) => void;
  sites: Site[];
  cores: string[];
  assistantOn: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set: Setter = (key, value) => setState((s) => ({ ...s, [key]: value }));
  const urlInvalid = state.repoUrl.trim() !== '' && !gitUrl.safeParse(state.repoUrl.trim()).success;
  const usedBy = sitesUsingRepo(sites, state.repoUrl.trim());
  const facts = state.upload?.facts;
  const repoUrl = state.repoUrl.trim();
  const inspection = state.inspection;
  // The repo and its branch on GitHub, GitLab or Bitbucket, from an SSH URL too.
  const web = urlInvalid || !repoUrl ? null : repoWeb(repoUrl);
  const branchUrl = web && state.branches?.includes(state.branch) ? branchWebUrl(repoUrl, state.branch) : null;

  // Looks the repo up shortly after a valid URL is pasted or typed, once per URL.
  useEffect(() => {
    if (urlInvalid || !repoUrl || inspection.url === repoUrl) return;
    const timer = window.setTimeout(() => {
      // Another repo: its branches and helpers are read again.
      setState((s) => ({ ...s, branch: '', branches: null, helpers: null, inspection: { status: 'reading', url: repoUrl } }));
      api.inspectRepo(repoUrl).then(
        (found) => setState((s) => (s.repoUrl.trim() === repoUrl ? applyPreset(s, found, cores) : s)),
        (err: Error) => setState((s) => (s.repoUrl.trim() === repoUrl ? { ...s, inspection: { status: 'error', url: repoUrl, message: err.message } } : s)),
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [repoUrl, urlInvalid, inspection.url, cores, setState]);

  async function pickDump(f: File | undefined) {
    if (!f) return;
    setError(null);
    setProgress(0);
    try {
      const upload = await api.upload(f, setProgress);
      // The dump this one replaces is not used by anything: drop it now rather than at the daily prune.
      const previous = state.upload?.id;
      if (previous && previous !== upload.id) void api.deleteUpload(previous).catch(() => undefined);
      setState((s) => ({
        ...s,
        upload,
        // Every address and its local name come from this dump; you change them in step 2.
        domains: upload.suggestions.replace.length ? upload.suggestions.replace.map((r) => ({ prod: r.from, local: r.to })) : withDumpAddress(s.domains, upload),
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] xl:gap-12">
      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Git repository" htmlFor="repo" hint={urlInvalid ? <span className="text-danger">Use an SSH or HTTPS URL, like git@github.com:team/repo.git or git@gitlab.com:group/sub/repo.git</span> : <>SSH or HTTPS, from GitHub, GitLab or any git host. Cloned as you, so your SSH key works for private repos.{web && <> <WebLink href={web.repoUrl}>Open on {web.name}</WebLink></>}</>}>
            <Input id="repo" value={state.repoUrl} onChange={(e) => set('repoUrl', e.target.value)} placeholder="git@github.com:AcmeCo/northwind.git" className="font-mono text-[13px]" spellCheck={false} aria-invalid={urlInvalid || undefined} />
          </Field>
          <Field label="Branch" htmlFor="branch" hint={(state.branches && state.branch === state.defaultBranch) || branchUrl ? <>{state.branches && state.branch === state.defaultBranch ? 'The default branch' : ''}{branchUrl && <> <WebLink href={branchUrl}>Open</WebLink></>}</> : undefined}>
            {state.branches && state.branches.length > 0 ? (
              <BranchPicker
                id="branch"
                branches={state.branches.map((name) => ({ name, current: name === state.defaultBranch, remoteOnly: false }))}
                value={state.branch}
                onChange={(name) => set('branch', name)}
                currentLabel="default"
              />
            ) : (
              // Typed only when the branches could not be read; until then it waits for the repo.
              <Input
                id="branch"
                value={state.branch}
                onChange={(e) => set('branch', e.target.value.trim())}
                placeholder={inspection.status === 'reading' ? 'Reading the repo...' : inspection.status === 'error' ? 'Type the branch' : 'After the repo URL'}
                disabled={inspection.status !== 'error'}
                className="font-mono text-[13px]"
                spellCheck={false}
              />
            )}
          </Field>
        </div>

        <ProjectStatus inspection={inspection} />
        {assistantOn && <ClaudeFill state={state} setState={setState} cores={cores} />}

        {usedBy.length > 0 && (
          <div role="status" className="rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <CircleAlert className="size-4 shrink-0 text-warning" />
              {usedBy.length === 1 ? 'A site on this machine already uses this repo' : `${usedBy.length} sites on this machine already use this repo`}
            </p>
            <ul className="mt-2 grid gap-1 pl-6">
              {usedBy.map((u) => (
                <li key={`${u.domain}${u.path ?? ''}`}>
                  <Link href={siteHref(u)} className="font-mono text-[13px] font-medium hover:underline">
                    {u.domain}
                    {u.path ?? ''}
                  </Link>
                  <span className="text-muted-foreground"> on </span>
                  <span className="font-mono text-[13px]">{u.branch}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground">Open it instead, or continue to set up a second copy (for example to test another branch next to it).</p>
          </div>
        )}

        <fieldset>
          <legend className="text-sm font-medium">What the repo holds</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {LAYOUTS.map((l) => (
              <label key={l.value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50', state.layout === l.value && 'border-primary bg-primary/5')}>
                <input type="radio" name="layout" checked={state.layout === l.value} onChange={() => set('layout', l.value)} className="mt-0.5 accent-[var(--primary)]" />
                <span>
                  <span className="font-medium">{l.label}</span>
                  <span className="block text-xs text-muted-foreground">{l.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <p className="text-sm font-medium">Database dump</p>
          <button
            type="button"
            disabled={progress !== null}
            onClick={() => file.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void pickDump(e.dataTransfer.files[0]);
            }}
            className="mt-2 flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center text-sm transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:cursor-progress"
          >
            {progress !== null ? (
              <>
                <LoaderCircle className="size-6 animate-spin text-primary" />
                <span className="font-medium">{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Reading the dump...'}</span>
                <span className="h-1.5 w-48 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
              </>
            ) : state.upload ? (
              <>
                <FileArchive className="size-6 text-primary" />
                <span className="font-medium">{state.upload.name}</span>
                <span className="text-xs text-muted-foreground">{bytes(state.upload.size)} · click to choose another</span>
              </>
            ) : (
              <>
                <Upload className="size-6 text-muted-foreground" />
                <span><span className="font-medium">Drop a dump here</span> or click to choose</span>
                <span className="text-xs text-muted-foreground">.sql, .sql.gz or .zip. It stays on this machine.</span>
              </>
            )}
          </button>
          <input ref={file} type="file" accept=".sql,.gz,.zip" className="sr-only" onChange={(e) => void pickDump(e.target.files?.[0])} tabIndex={-1} />
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      </div>

      <DumpFactsCard facts={facts ?? null}>
        {isMockup && <p className="mt-4 text-xs text-muted-foreground">Mockup: any file works, nothing is uploaded.</p>}
      </DumpFactsCard>
    </div>
  );
}

// ── Domains ──────────────────────────────────────────────────

function DomainsStep({ state, set, errors, sites, underError, underFolder, existing, network, networkErrors, summary }: {
  state: WizardState;
  set: Setter;
  /** What the replace step will change, or null when the dump already answers here. */
  summary?: string | null;
  errors: Array<string | null>;
  /** The dump's network as it will run here, and errors on its sites the page knows, by blog id. */
  network: NetworkPlan | null;
  networkErrors: Map<number, string>;
  sites: Site[];
  underError: string | null;
  underFolder: string | null;
  /** The site the primary domain belongs to already, if any. */
  existing: Site | undefined;
}) {
  const fromDump = state.source === 'repo';
  const under = state.source !== 'empty' ? state.under : null;
  const facts = state.upload?.facts;
  const update = (i: number, row: Partial<DomainRow>) => set('domains', state.domains.map((d, j) => (j === i ? { ...d, ...row } : d)));
  // Where an address came from, shown under its row.
  const hostOf = (url?: string) => {
    try {
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  };
  const sourceOf = (prod: string) =>
    !facts || !prod ? null : hostOf(facts.home) === prod ? `home in the dump: ${facts.home}` : hostOf(facts.siteUrl) === prod ? `siteurl in the dump: ${facts.siteUrl}` : facts.sites?.some((x) => x.domain === prod) ? 'a site of the network' : null;

  // A network's site list needs the room of a table.
  return (
    <div className={cn('grid gap-4', network ? 'max-w-5xl' : 'max-w-3xl')}>
      <p className="text-sm text-muted-foreground">
        {under
          ? `The site answers at its parent's domain and the path${fromDump ? ', so every address the database uses is replaced with that domain' : ''}. The parent's certificate and hosts line already cover it.`
          : <>
              {fromDump
                ? 'Each address the database uses maps to a local one: production, staging or another local copy. Search and replace runs for every pair; the first local domain is the primary.'
                : 'The first domain is the primary. Add aliases for other languages or brands that share this site.'}{' '}
              One certificate, one vhost and one hosts line cover all of them.
            </>}
      </p>
      {state.source !== 'empty' && !(fromDump && facts?.multisite) && <UnderPath state={state} set={set} sites={sites} error={underError} folder={underFolder} />}
      {fromDump && facts?.multisite && (
        <p className="text-xs text-muted-foreground">
          A multisite network needs a domain of its own, so it is not installed under a path of another site.
          {facts.domainMapping && ' Its sites get their domains from a domain mapping plugin\'s own table: they keep them, and those domains are replaced like the others above.'}
        </p>
      )}
      {fromDump && facts?.multisite && facts.sites && !network && !facts.domainMapping && <NetworkNote sites={facts.sites} />}
      <div className="grid gap-2">
        <div className={cn('hidden gap-3 px-1 text-xs font-medium text-muted-foreground', !(under && !fromDump) && 'sm:grid', fromDump ? 'grid-cols-[minmax(0,1fr)_1.4rem_minmax(0,1fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_2rem]')}>
          {fromDump && <span>In the database</span>}
          {fromDump && <span />}
          <span>Local address</span>
          <span />
        </div>
        {(under && !fromDump ? [] : state.domains).map((d, i) => {
          const same = fromDump && !under && cleanAddress(d.prod) !== '' && cleanAddress(d.prod) === cleanAddress(d.local, false);
          const source = fromDump ? sourceOf(cleanAddress(d.prod)) : null;
          return (
            <div key={i} className={cn('grid items-start gap-3', fromDump ? 'sm:grid-cols-[minmax(0,1fr)_1.4rem_minmax(0,1fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_2rem]')}>
              {fromDump && (
                <div>
                  <Input
                    value={d.prod}
                    aria-label={`Address in the database ${i + 1}`}
                    onChange={(e) => update(i, { prod: e.target.value, local: d.local || localDomainFor(cleanAddress(e.target.value)) })}
                    // A pasted URL keeps only its address: no scheme, path or trailing slash.
                    onBlur={() => update(i, { prod: cleanAddress(d.prod) })}
                    placeholder="www.example.com"
                    className="font-mono text-[13px]"
                    spellCheck={false}
                  />
                  {source && <p className="mt-1 truncate text-xs text-muted-foreground" title={source}>{source}</p>}
                </div>
              )}
              {fromDump && <ArrowRight className="mt-3 hidden size-4 text-muted-foreground sm:block" />}
              {under ? (
                <p className="flex h-10 items-center rounded-md border border-teal-500/45 bg-teal-500/[0.04] px-3 font-mono text-[13px] text-muted-foreground dark:border-teal-400/40">
                  {under.domain || 'the site below'}{cleanPath(under.path)}
                </p>
              ) : (
              <div>
                <div className="relative">
                  <Input
                    value={d.local}
                    aria-label={`Local domain ${i + 1}`}
                    aria-invalid={errors[i] ? true : undefined}
                    onChange={(e) => update(i, { local: e.target.value.toLowerCase().trim() })}
                    onBlur={() => update(i, { local: cleanAddress(d.local, false) })}
                    placeholder="local.example.com"
                    spellCheck={false}
                    // The name this site gets here: tinted so it reads as the one being set; the primary badge keeps its room.
                    className={cn('font-mono text-[13px]', i === 0 && d.local && 'pr-20', errors[i] ? 'border-danger' : 'border-teal-500/45 bg-teal-500/[0.04] focus-visible:border-teal-500 dark:border-teal-400/40 dark:bg-teal-400/[0.05]')}
                  />
                  {i === 0 && d.local && <Badge className="absolute top-1/2 right-2 -translate-y-1/2">primary</Badge>}
                </div>
                {errors[i] && <p className="mt-1 text-xs text-danger">{errors[i]}</p>}
                {!errors[i] && same && <p className="mt-1 text-xs text-muted-foreground">Same as the database address, nothing to replace</p>}
              </div>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove domain ${i + 1}`}
                disabled={state.domains.length === 1}
                onClick={() => set('domains', state.domains.filter((_, j) => j !== i))}
                className="mt-0.5 size-9"
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>
      {!(under && !fromDump) && (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => set('domains', [...state.domains, { prod: '', local: '' }])}>
          <Plus />
          {under ? 'Add an address' : 'Add domain'}
        </Button>
      )}
      {network && facts && (
        <NetworkSection facts={facts} plan={network} main={cleanAddress(state.domains[0]?.local ?? '', false)} answers={state.network ?? NO_NETWORK_ANSWERS} errors={networkErrors} onChange={(answers) => set('network', answers)} nothingChanges={summary === null} />
      )}
      {existing && <ReinstallNote site={existing} state={state} set={set} />}
      {fromDump && state.upload && <ReplaceOptions state={state} set={set} summary={summary ?? null} />}
    </div>
  );
}

/** The primary domain is a site already: installing again archives it first, once you tick it. */
function ReinstallNote({ site, state, set }: { site: Site; state: WizardState; set: Setter }) {
  return (
    <div role="status" className="grid gap-3 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <CircleAlert className="size-4 shrink-0 text-warning" />
        {site.domain} is installed already
      </p>
      <p className="text-muted-foreground">
        {installLabel(site.install)}.{' '}
        {site.removable
          ? 'Installing again archives it first, with its folder, vhost, certificate and database. Restore it from the Archive for 14 days, or with Undo on the install.'
          : 'The panel cannot archive it first: its folder or vhost is not in the usual place. Remove it by hand, or pick another domain.'}
      </p>
      {site.removable && (
        <Checkbox
          id="replace-existing"
          checked={state.replaceExisting}
          onChange={(v) => set('replaceExisting', v)}
          label={`Archive ${site.domain} and install it again`}
        />
      )}
    </div>
  );
}

/**
 * Install under a path of an existing site: its own folder and database,
 * served at the site's domain and the path by the site's vhost.
 */
function UnderPath({ state, set, sites, error, folder }: { state: WizardState; set: Setter; sites: Site[]; error: string | null; folder: string | null }) {
  const parents = sites.filter((s) => !s.path).sort((a, b) => a.domain.localeCompare(b.domain));
  const parent = parents.find((s) => s.domain === state.under?.domain);
  // The path the dump's site lives at (its home address), to warn when it differs: only the domain gets replaced.
  let dumpPath: string | null = null;
  try {
    if (state.source === 'repo' && state.upload?.facts.home) dumpPath = cleanPath(new URL(state.upload.facts.home).pathname);
  } catch {
    dumpPath = null;
  }
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
      <Checkbox
        id="under"
        checked={state.under !== null}
        onChange={(on) => set('under', on ? { domain: '', path: '' } : null)}
        label="Install under a path of an existing site"
        hint="Like Northwind Learn at local.northwind.com/learn: its own folder, database and git, served by that site's vhost."
      />
      {state.under && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Site" htmlFor="under-site">
            <Select id="under-site" value={state.under.domain} onChange={(e) => set('under', { ...(state.under as { domain: string; path: string }), domain: e.target.value })}>
              <option value="">Pick a site</option>
              {parents.map((s) => <option key={s.domain} value={s.domain}>{s.domain}</option>)}
            </Select>
          </Field>
          <Field label="Path" htmlFor="under-path">
            <Input
              id="under-path"
              value={state.under.path}
              onChange={(e) => set('under', { ...(state.under as { domain: string; path: string }), path: e.target.value })}
              onBlur={() => set('under', { ...(state.under as { domain: string; path: string }), path: cleanPath(state.under?.path ?? '') })}
              placeholder="/learn"
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>
          <p className={cn('text-xs sm:col-span-2', error ? 'text-danger' : 'text-muted-foreground')}>
            {error ?? (folder && parent ? `At https://${parent.domain}${cleanPath(state.under.path)}/, in /var/www/${folder}.` : 'Pick the site and the path.')}
            {!error && parent && !parent.vhostManaged && ' Its vhost was made by hand, so the install shows the lines to add to it.'}
          </p>
          {dumpPath !== null && cleanPath(state.under.path) && dumpPath !== cleanPath(state.under.path) && (
            <p role="status" className="rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs sm:col-span-2">
              The database's site is at {dumpPath || '/'}, but this one goes under {cleanPath(state.under.path)}. Search and replace changes the domain only, so links
              would miss the path: use the same path as the site in the dump.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** How a network's sites spread over domains, and which ones live under a path and need no row. */
function NetworkNote({ sites }: { sites: Array<{ domain: string; path: string }> }) {
  const domains = [...new Set(sites.map((x) => x.domain))];
  const underPath = sites.filter((x) => x.path !== '/');
  const hosts = [...new Set(underPath.map((x) => x.domain))];
  return (
    <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      A network: {sites.length} site{sites.length === 1 ? '' : 's'} on {domains.length} domain{domains.length === 1 ? '' : 's'}.
      {underPath.length > 0 && (
        <>
          {' '}{underPath.length} {underPath.length === 1 ? 'is' : 'are'} under a path of <span className="font-mono text-[13px]">{hosts.join(', ')}</span> ({underPath.map((x) => x.path).join(', ')}) and need{underPath.length === 1 ? 's' : ''} no row of {underPath.length === 1 ? 'its' : 'their'} own.
        </>
      )}
    </p>
  );
}

/** Whether to replace at all: production URLs only, so email addresses and plain text keep the production domain. */
function ReplaceOptions({ state, set, summary }: { state: WizardState; set: Setter; summary: string | null }) {
  // Every address of the dump is its local name already: there is nothing to turn off.
  const anyToReplace = state.domains.some((d) => cleanAddress(d.prod) && cleanAddress(d.prod) !== cleanAddress(d.local, false));
  return (
    <div className="mt-2 grid gap-3 border-t pt-4">
      {anyToReplace && (
        <Checkbox
          id="replace-on"
          checked={state.replaceOn}
          onChange={(v) => set('replaceOn', v)}
          label="Search and replace the production domains after the import"
          hint="URLs only, so email addresses and plain text keep the production domain. Turn it off for a dump that already uses the local domains. Either way, http:// links become https:// where the dump has them."
        />
      )}
      {summary ? (
        <p className="text-xs text-muted-foreground">One step after the import: {summary.charAt(0).toLowerCase()}{summary.slice(1)}.</p>
      ) : (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/8 px-3 py-2 text-sm">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <span>Already set up for here: no search and replace. Every address in the dump answers here, on https.</span>
        </p>
      )}
    </div>
  );
}

// ── WordPress ────────────────────────────────────────────────

const OTHER_VERSION = 'other';

/** 7.1.3 before 7.0.4 before 6.8.10 before 6.8.9. */
function newerFirst(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function WordPressStep({ state, set, cores, input, uploadsError }: { state: WizardState; set: Setter; cores: string[]; input: CreateSiteInput; uploadsError: string | null }) {
  // The production address the repo's docs give, offered when the dump names none.
  const docsProduction = state.org?.prefill?.productionHint;
  const defaults = adminDefaults(state, input.domain);
  const isRepo = state.source === 'repo';
  const toggle = (slug: string, on: boolean) => set('deactivate', on ? [...state.deactivate, slug] : state.deactivate.filter((s) => s !== slug));
  const active = state.upload?.facts.activePlugins;
  const productionOnly = new Set<string>(PRODUCTION_ONLY_PLUGINS);
  // Production-only ones first; a preset may name plugins this dump does not list, so they stay visible.
  const deactivatable = [...new Set([...(active ? [...active].sort((a, b) => Number(productionOnly.has(b)) - Number(productionOnly.has(a))) : PRODUCTION_ONLY_PLUGINS), ...state.deactivate])];
  // A dump with many plugins gets a search over both plugin lists; ticks stay as they are while rows are hidden.
  const [find, setFind] = useState('');
  const searchable = deactivatable.length > PLUGIN_SEARCH_FROM;
  const query = searchable ? find : '';
  const found = deactivatable.filter((slug) => pluginMatches(slug, query));
  const ticked = deactivatable.filter((slug) => state.deactivate.includes(slug)).length;
  // Installed cores, plus WordPress.org's newest when it is not: that one is added on the way.
  const report = useAsync(() => api.coresReport().catch(() => null), []);
  const latest = report.data?.latest;
  const versions = [...new Set([...cores, ...(latest ? [latest] : [])])].sort(newerFirst);
  // Other version: a field for any exact number, which stays open while you type (an empty one is not filled for you).
  const [otherPicked, setOtherPicked] = useState(false);
  const other = otherPicked || (state.coreVersion !== '' && !versions.includes(state.coreVersion)) || versions.length === 0;
  useEffect(() => {
    if (!otherPicked && state.coreVersion === '' && latest) set('coreVersion', latest);
  }, [latest, state.coreVersion, otherPicked]);
  const addedNote = state.coreMode === 'wpcore' ? 'added to the shared cores' : 'downloaded';
  const via = uploadsViaFor(state);
  const uploadsOn = Boolean(input.uploadsFrom);
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="grid h-fit gap-4">
        <h2 className="text-sm font-semibold">Core</h2>
        <div role="radiogroup" aria-label="Core" className="grid gap-2">
          {([
            ['wpcore', 'Shared core (recommended)', 'Symlinked to the shared cores folder; switch versions in seconds.'],
            ['standalone', 'Own copy', 'Downloads WordPress into the site folder.'],
          ] as const).map(([value, label, hint]) => (
            <label key={value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', state.coreMode === value && 'border-primary bg-primary/5')}>
              <input type="radio" name="core" checked={state.coreMode === value} onChange={() => set('coreMode', value)} className="mt-0.5 accent-[var(--primary)]" />
              <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
            </label>
          ))}
        </div>
        <Field
          label="Version"
          htmlFor="version"
          hint={
            <>
              {versions.length === 0 && 'No shared cores yet and WordPress.org could not be asked: type a version. '}
              {other && state.coreVersion !== '' && !coreVersionSchema.safeParse(state.coreVersion).success && <span className="text-danger">A version like 6.8.3. </span>}
              {state.coreVersion && !cores.includes(state.coreVersion) && state.coreMode === 'wpcore' && `WordPress ${state.coreVersion} is added to the shared cores first. `}
              <ReleaseListLink />
            </>
          }
        >
          <Select
            id="version"
            value={other ? OTHER_VERSION : state.coreVersion}
            onChange={(e) => {
              const picked = e.target.value === OTHER_VERSION;
              setOtherPicked(picked);
              set('coreVersion', picked ? '' : e.target.value);
            }}
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === latest ? ' (latest)' : ''}
                {cores.includes(v) ? '' : ` (${addedNote})`}
              </option>
            ))}
            <option value={OTHER_VERSION}>Other version...</option>
          </Select>
          {other && (
            <Input
              id="version-other"
              autoFocus={otherPicked}
              aria-label="Other version"
              value={state.coreVersion}
              onChange={(e) => set('coreVersion', e.target.value.trim())}
              placeholder="An exact release, like 6.8.3"
              className="font-mono text-[13px]"
              spellCheck={false}
              aria-invalid={state.coreVersion !== '' && !coreVersionSchema.safeParse(state.coreVersion).success ? true : undefined}
            />
          )}
        </Field>

        <AdminSection state={state} set={set} input={input} defaults={defaults} />
      </section>

      <section className="grid h-fit gap-4">
        {state.source === 'repo' && (
          <>
            {searchable && <PluginSearch value={find} onChange={setFind} found={found.length} total={deactivatable.length} ticked={ticked} />}
            <h2 className="text-sm font-semibold">Deactivate after import</h2>
            <p className="-mt-2 text-xs text-muted-foreground">
              {active ? 'The plugins active in the dump. Tick the ones to turn off locally.' : 'The dump does not say which plugins are active, so these are the usual production-only ones. Only active ones are touched.'}
              {state.inspection.status === 'found' && state.deactivate.length > 0 && ' Ticked: the ones you turned off on your last install of this repo.'}
            </p>
            {query.trim() && found.length === 0 && <p className="text-sm text-muted-foreground">No active plugin matches the search.</p>}
            <div className="grid gap-2.5 sm:grid-cols-2">
              {found.map((slug) => {
                // One choice per plugin: a helper you turn on below, or the plugin loading the images, is not also turned off.
                const keptOn = (state.activate as string[]).includes(slug) ? 'Set to turn on under Local helpers' : slug === MEDIA_PLUGIN && via === 'plugin' && uploadsOn ? 'Loads the missing images, see Uploads' : null;
                return (
                  <Checkbox
                    key={slug}
                    id={`p-${slug}`}
                    checked={!keptOn && state.deactivate.includes(slug)}
                    onChange={(v) => toggle(slug, v)}
                    disabled={Boolean(keptOn)}
                    label={<code className="font-mono text-[13px]">{slug}</code>}
                    hint={keptOn ?? (active && productionOnly.has(slug) ? 'Usually production only' : undefined)}
                  />
                );
              })}
            </div>

            <HelpersSection state={state} set={set} query={query} />

            <h2 className="mt-2 text-sm font-semibold">Load missing images from production</h2>
            {state.helpers?.media && (
              <div role="radiogroup" aria-label="How missing images load" className="grid gap-2">
                {([
                  ['plugin', 'BE Media from Production', 'The repo has it: the panel sets BE_MEDIA_FROM_PRODUCTION_URL in wp-config.php (unless it is there already) and turns the plugin on.'],
                  ['redirect', 'Redirect in the vhost', 'The panel\'s vhost (Local mode for a site under a path) sends a missing file under wp-content/uploads to the same path there.'],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', via === value && 'border-primary bg-primary/5')}>
                    <input type="radio" name="uploads-via" checked={via === value} onChange={() => set('uploadsVia', value)} className="mt-0.5 accent-[var(--primary)]" />
                    <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                  </label>
                ))}
              </div>
            )}
            <Field
              label="Production domain"
              htmlFor="uploads-from"
              hint={uploadsError ? <span className="text-danger">{uploadsError}</span> : 'The production domain, with www. when the live site has it. Empty: missing images stay missing. A local address in the dump is never filled in here.'}
            >
              <Input
                id="uploads-from"
                value={state.uploadsFrom ?? uploadsDefault(state)}
                onChange={(e) => set('uploadsFrom', e.target.value)}
                onBlur={() => set('uploadsFrom', cleanAddress(state.uploadsFrom ?? uploadsDefault(state), false))}
                placeholder="www.example.com"
                aria-invalid={uploadsError ? true : undefined}
                className={cn('font-mono text-[13px]', uploadsError && 'border-danger')}
                spellCheck={false}
              />
              {/* A dump that is already a local copy names no production domain; the docs may. */}
              {docsProduction && !(state.uploadsFrom ?? uploadsDefault(state)) && (
                <button type="button" className="justify-self-start text-xs font-medium text-primary hover:underline" onClick={() => set('uploadsFrom', docsProduction)}>
                  Use <span className="font-mono">{docsProduction}</span>, from the repo's docs
                </button>
              )}
            </Field>

            <BuildSection state={state} set={set} />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The admin user. When the scan read the dump's users, it names its admins
 * and one-click login signs you in as the first; an admin for this copy is
 * made only when you switch it on (on by default when the dump has none). A
 * dump it could not read keeps the two choices. Fresh WordPress always makes one.
 */
function AdminSection({ state, set, input, defaults }: { state: WizardState; set: Setter; input: CreateSiteInput; defaults: { user: string; password: string; email: string } }) {
  const isRepo = state.source === 'repo';
  const found = dumpAdmins(state);
  const network = Boolean(state.upload?.facts.multisite);
  const create = adminCreateOf(state);
  const user = (state.adminUser ?? defaults.user).trim();
  const fields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Username" htmlFor="admin" hint={isRepo ? undefined : 'One-click login from the panel signs you in as this user.'}>
        <Input id="admin" value={state.adminUser ?? defaults.user} onChange={(e) => set('adminUser', e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" value={state.adminEmail ?? defaults.email} onChange={(e) => set('adminEmail', e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Password" htmlFor="admin-password" hint="For this local copy only: logins work from this computer alone.">
        <PasswordInput id="admin-password" value={state.adminPassword ?? defaults.password} onChange={(e) => set('adminPassword', e.target.value)} autoComplete="new-password" />
      </Field>
    </div>
  );
  const title = <h2 className="mt-2 text-sm font-semibold">Admin user</h2>;
  if (!isRepo) return <>{title}{fields}</>;
  if (!found) {
    return (
      <>
        {title}
        {state.upload && (
          <p className="text-sm text-muted-foreground">
            {state.upload.facts.partial
              ? `The dump's admins are not known: the panel reads the first ${DUMP_SCAN_GB} GB of a dump and its users come later.`
              : "The dump's admins are not known: its users could not be read."}{' '}
            Choose what happens to this user.
          </p>
        )}
        {fields}
        <div className="grid gap-3 text-sm">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">When the database has {input.admin?.user || 'this user'} already</legend>
            {([
              ['keep', 'Leave it as it is', 'Its password and role stay; one-click login still works.'],
              ['update', 'Set this password and make it an administrator', undefined],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2.5">
                <input type="radio" name="admin-exists" checked={state.adminIfExists === value} onChange={() => set('adminIfExists', value)} className="mt-0.5 accent-[var(--primary)]" />
                <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
              </label>
            ))}
          </fieldset>
          <Checkbox
            id="admin-create"
            checked={state.adminIfMissing === 'create'}
            onChange={(v) => set('adminIfMissing', v ? 'create' : 'skip')}
            label={`Create ${input.admin?.user || 'it'} when the database does not have it`}
            hint={state.adminIfMissing === 'skip' ? 'No user is added; one-click login signs you in as the first administrator.' : undefined}
          />
        </div>
      </>
    );
  }
  const taken = found.some((login) => login.toLowerCase() === user.toLowerCase());
  return (
    <>
      {title}
      {found.length > 0 ? (
        <div className="grid gap-1.5 rounded-lg border bg-card p-3 text-sm">
          <p className="font-medium">{network ? 'Super admins in the dump' : 'Admin users in the dump'}</p>
          <p className="flex flex-wrap gap-1.5">{found.map((login) => <Badge key={login} className="font-mono text-[12px]">{login}</Badge>)}</p>
          <p className="text-xs text-muted-foreground">Log in with one click signs you in as <code className="font-mono">{found[0]}</code>.</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">The dump has no {network ? 'super admin' : 'administrator'}, so this copy gets one.</p>
      )}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Create an admin user for this copy</p>
          <p className="text-xs text-muted-foreground">{create ? 'With the name and password below.' : 'No user is touched.'}</p>
        </div>
        <Switch checked={create} label="Create an admin user for this copy" onChange={(on) => set('adminCreate', on)} />
      </div>
      {create && fields}
      {create && (taken ? (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
          <code className="font-mono">{user}</code> is in the dump: its password changes to this one and it stays an administrator.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">A new administrator next to the ones in the dump.</p>
      ))}
    </>
  );
}

/** Rows of the right height while the repo lookup reads, so the column does not jump when it answers. */
function Placeholders({ rows }: { rows: number }) {
  return (
    <div className="grid gap-2.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="grid flex-1 gap-1.5">
            <span className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
            <span className="h-3 w-3/5 animate-pulse rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The local helpers to turn on: the ones the branch holds (a plugin folder,
 * or required from WordPress Packagist in composer.json). One the dump has
 * on stays on; when the repo cannot be read, only those are kept.
 */
/** More plugins than this in the dump and the WordPress step offers a search. */
const PLUGIN_SEARCH_FROM = 8;

/**
 * Finds plugins in Deactivate after import and Activate after import at once:
 * only the matching rows show, ticked or not, and Clear or Escape shows them all.
 */
function PluginSearch({ value, onChange, found, total, ticked }: { value: string; onChange: (v: string) => void; found: number; total: number; ticked: number }) {
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault();
              onChange('');
            }
          }}
          placeholder="Find a plugin to deactivate or activate"
          aria-label="Find a plugin to deactivate or activate"
          spellCheck={false}
          autoComplete="off"
          className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button type="button" aria-label="Clear the search" onClick={() => onChange('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {value.trim() ? `${found} of ${total} plugins match` : `${total} plugins`}
        {ticked > 0 && ` · ${ticked} set to deactivate`}
      </p>
    </div>
  );
}

function HelpersSection({ state, set, query }: { state: WizardState; set: Setter; query: string }) {
  const helpers = state.helpers;
  const active = new Set(state.upload?.facts.activePlugins ?? []);
  const list = helpers?.list?.filter((slug) => pluginMatches(slug, query));
  const toggle = (slug: LocalHelperPlugin, on: boolean) => set('activate', on ? [...state.activate, slug] : state.activate.filter((s) => s !== slug));
  const onInDump = (slug: string) => (
    <p key={slug} className="flex items-start gap-2.5 text-sm">
      <Check className="mt-0.5 size-4 shrink-0 text-success" />
      <span><code className="font-mono text-[13px]">{slug}</code><span className="block text-xs text-muted-foreground">{state.deactivate.includes(slug) ? 'On in the dump; set to deactivate above' : 'On in the dump: it stays on'}</span></span>
    </p>
  );
  const dumpHelpers = (Object.keys(LOCAL_HELPER_PLUGINS) as LocalHelperPlugin[]).filter((slug) => active.has(slug) && pluginMatches(slug, query));
  return (
    <>
      <h2 className="mt-2 text-sm font-semibold">Activate after import</h2>
      {!helpers || (!helpers.list && !helpers.error) ? (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Looking for the local helpers in the repo...</p>
          <Placeholders rows={2} />
        </>
      ) : helpers.error ? (
        <>
          <p className="-mt-2 text-xs text-warning">Could not read the repo's plugins, so nothing new is turned on: {helpers.error}</p>
          {dumpHelpers.length > 0 && <div className="grid gap-2.5">{dumpHelpers.map(onInDump)}</div>}
        </>
      ) : helpers.list?.length === 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">None of the local helpers are in this repo or its composer.json.</p>
      ) : (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">The local helpers this branch has, as a plugin folder or in composer.json. Tick the ones to turn on; nothing is downloaded.</p>
          {query.trim() && list?.length === 0 && <p className="text-sm text-muted-foreground">No local helper matches the search.</p>}
          <div className="grid gap-2.5">
            {list?.map((slug) =>
              active.has(slug) ? (
                onInDump(slug)
              ) : (
                <Checkbox
                  key={slug}
                  id={`h-${slug}`}
                  checked={!state.deactivate.includes(slug) && state.activate.includes(slug)}
                  onChange={(v) => toggle(slug, v)}
                  disabled={state.deactivate.includes(slug)}
                  label={<code className="font-mono text-[13px]">{slug}</code>}
                  hint={state.deactivate.includes(slug) ? 'Set to deactivate above; untick it there to turn it on here' : LOCAL_HELPER_PLUGINS[slug]}
                />
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

/**
 * The build checklist: every composer.json and package.json the repo lookup
 * found, ticked only where the repo does not hold what it makes. Most ship
 * their built files, so those wait closed below. The docs of an organization
 * install can tick a row and pick its script.
 */
function BuildSection({ state, set }: { state: WizardState; set: Setter }) {
  const helpers = state.helpers;
  const commands = state.org?.read.facts?.buildCommands ?? [];
  const docsFile = state.org?.read.facts?.sources.find((s) => s.field === 'buildCommands')?.file ?? 'the docs';
  const builds = helpers?.builds;
  const pick = (build: RepoBuild, patch: BuildPick) => set('buildPicks', { ...state.buildPicks, [buildId(build)]: { ...buildChoice(build, state.buildPicks, commands), ...patch } });
  const row = (build: RepoBuild) => {
    const choice = buildChoice(build, state.buildPicks, commands);
    const id = `b-${buildId(build).replace(/[^\w-]/g, '-')}`;
    const install = build.tool === 'composer' ? 'composer install' : build.tool === 'npm' ? 'npm ci' : `${build.tool} install`;
    return (
      <div key={id} className="flex items-start gap-2.5 text-sm">
        <input id={id} type="checkbox" checked={choice.on} onChange={(e) => pick(build, { on: e.target.checked })} className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--primary)]" />
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={id} className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono text-[13px]">{install}</code>
            {build.tool !== 'composer' && <span className="text-muted-foreground">then</span>}
            {choice.fromDocs && <Badge tone="primary">from {docsFile}</Badge>}
          </label>
          {build.tool !== 'composer' && (
            <Select aria-label={`Script to run in ${build.dir || 'the repo root'}`} value={choice.script ?? ''} onChange={(e) => pick(build, { on: true, script: e.target.value })} className="h-8 font-mono text-[13px]" wrapClassName="max-w-64">
              {!choice.script && <option value="">Pick a script</option>}
              {build.scripts.map((name) => <option key={name} value={name}>{`${build.tool} run ${name}`}</option>)}
            </Select>
          )}
          <span className="text-xs text-muted-foreground">
            in <code className="font-mono">{build.dir || '/'}</code> · {build.why}
            {choice.fromDocs && build.builtInRepo && `; ${docsFile} builds it${choice.script ? ` with ${choice.script}` : ''}, tick it to run it anyway`}
          </span>
          {choice.script && build.stopsOthers?.includes(choice.script) && (
            <span className="text-xs text-warning">{choice.script} runs its builds with concurrently --kill-others, so the first to finish stops the others: pick one of its parts, or change it to --kill-others-on-fail.</span>
          )}
        </div>
      </div>
    );
  };
  // A build the docs name stays in view even when it is off, with why.
  const needed = (builds ?? []).filter((b) => {
    const choice = buildChoice(b, state.buildPicks, commands);
    return choice.on || choice.fromDocs || b.needed;
  });
  const rest = (builds ?? []).filter((b) => !needed.includes(b));
  return (
    <>
      <h2 className="mt-2 text-sm font-semibold">Build</h2>
      {!helpers || (!helpers.list && !helpers.error) ? (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Reading the repo's composer.json and package.json files...</p>
          <Placeholders rows={2} />
        </>
      ) : !builds ? (
        <>
          <p className="-mt-2 text-xs text-warning">Could not read the repo's build files, so these run at the repo root when they are there.</p>
          <div className="grid gap-2.5">
            <Checkbox id="composer" checked={state.composer} onChange={(v) => set('composer', v)} label={<>Run <code className="font-mono">composer install</code></>} hint="When a composer.json is found" />
            <Checkbox id="npm" checked={state.npm} onChange={(v) => set('npm', v)} label={<>Run <code className="font-mono">npm ci && npm run build</code></>} hint="When a package.json with a build script is found" />
          </div>
        </>
      ) : builds.length === 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">No composer.json or package.json in this repo has something to build.</p>
      ) : (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Ticked where the repo does not hold what the build makes. Each runs in its folder, as you, after the clone.</p>
          {needed.length > 0 ? <div className="grid gap-3">{needed.map(row)}</div> : <p className="text-xs text-muted-foreground">Nothing needs a build.</p>}
          {rest.length > 0 && (
            <details className="rounded-lg border bg-card px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Ships its built files ({rest.length})</summary>
              <div className="mt-3 grid gap-3">{rest.map(row)}</div>
            </details>
          )}
        </>
      )}
    </>
  );
}

// ── Review ───────────────────────────────────────────────────

/**
 * Asks Claude to fill in the wizard from a plain description, the repo, the
 * dump and conventions.md. It only fills the steps; you review them and install.
 */
function ClaudeFill({ state, setState, cores }: { state: WizardState; setState: (fn: (s: WizardState) => WizardState) => void; cores: string[] }) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const repoUrl = state.repoUrl.trim();

  async function fill() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.suggestWizard({
        description: description.trim(),
        ...(gitUrl.safeParse(repoUrl).success ? { repoUrl } : {}),
        ...(state.branch.trim() && state.inspection.status !== 'idle' ? { branch: state.branch.trim() } : {}),
        ...(state.upload ? { uploadId: state.upload.id } : {}),
      });
      setSent(result.sent);
      setState((s) => {
        const next = applyPreset(s, { branch: result.branch, preset: result.preset }, cores);
        const summary = next.inspection.status === 'found' ? next.inspection.summary : '';
        return { ...next, inspection: { status: 'claude', url: s.repoUrl.trim(), branch: result.branch, summary, notes: result.notes } };
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-primary/25 bg-primary/4 p-3">
      <label htmlFor="claude-describe" className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-primary" />Describe the site to Claude</label>
      <Textarea
        id="claude-describe"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Acme main site plus its shop.acme.com subdomain, repo above, develop branch. Same setup as BikeTours."
        rows={3}
        disabled={busy}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || description.trim().length < 3} onClick={() => void fill()}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
          {busy ? 'Claude is reading...' : 'Fill the wizard'}
        </Button>
        <span className="text-xs text-muted-foreground">Reads conventions.md, the repo's docs, your last install of it, the dump facts and your similar sites. You review every step before Install.</span>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {sent && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What was sent to Claude</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono whitespace-pre-wrap">{sent}</pre>
        </details>
      )}
    </div>
  );
}

function ProjectStatus({ inspection }: { inspection: Inspection }) {
  if (inspection.status === 'claude') {
    return (
      <div role="status" className="-mt-2 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/6 px-3 py-2 text-sm">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          Filled by Claude on <span className="font-mono text-[13px]">{inspection.branch}</span>: {inspection.summary}. {inspection.notes} Check every step before you install.
        </span>
      </div>
    );
  }
  if (inspection.status === 'reading') {
    return <p className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Reading the repo...</p>;
  }
  if (inspection.status === 'found') {
    return (
      <p role="status" className="-mt-2 flex items-start gap-2 rounded-lg border border-success/30 bg-success/8 px-3 py-2 text-sm">
        <Check className="mt-0.5 size-4 shrink-0 text-success" />
        <span>Filled from your last install of this repo, on <span className="font-mono text-[13px]">{inspection.branch}</span>: {inspection.summary}. Check the next steps, then install.</span>
      </p>
    );
  }
  if (inspection.status === 'none') {
    return <p className="-mt-2 text-xs text-muted-foreground">First install of this repo here. The panel remembers your answers for next time.</p>;
  }
  if (inspection.status === 'error') {
    return <p className="-mt-2 text-xs text-warning">Could not read the repo: {inspection.message}</p>;
  }
  return null;
}

function ReviewStep({ state, set, input, dbName, cores }: { state: WizardState; set: Setter; input: CreateSiteInput; dbName: string; cores: string[] | undefined }) {
  const network = useMemo(() => networkFor(state), [state]);
  const addresses = useMemo(() => addressesFor(input, state, network), [input, state, network]);
  const steps = useMemo(() => previewSteps(input, dbName, state.upload?.name, cores, addresses), [input, dbName, state.upload?.name, cores, addresses]);
  const summary = addressSummary(addresses, input.network?.layout);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <dl className="grid h-fit gap-3 rounded-xl border bg-card p-5 text-sm">
        {input.path ? (
          <>
            <ReviewRow label="Address"><span className="font-mono">https://{input.domain}{input.path}/</span></ReviewRow>
            <ReviewRow label="Folder"><span className="font-mono">/var/www/{mountFolder(input.domain, input.path)}</span></ReviewRow>
          </>
        ) : (
          <ReviewRow label="Primary domain"><span className="font-mono">{input.domain}</span></ReviewRow>
        )}
        {input.aliases.length > 0 && <ReviewRow label="Aliases">{input.aliases.map((a) => <span key={a} className="block font-mono">{a}</span>)}</ReviewRow>}
        {input.repo && <ReviewRow label="Repo"><span className="font-mono break-all">{input.repo.url}</span> <span className="text-muted-foreground">({input.repo.branch})</span></ReviewRow>}
        {state.upload && <ReviewRow label="Dump">{state.upload.name} <span className="text-muted-foreground">({bytes(state.upload.size)})</span></ReviewRow>}
        {input.replace.length > 0 && (
          <ReviewRow label="Replace">{input.replace.map((r) => <span key={r.from} className="block font-mono text-[13px]">{r.from} → {r.to}</span>)}</ReviewRow>
        )}
        {network && (
          <ReviewRow label="Network">
            {network.rows.length} sites, {network.layout === 'keep' ? 'each where the dump has it' : network.layout === 'subdirectory' ? `subdirectory network on ${input.domain}` : 'subdomain network'}
            {network.moves.length === 0
              ? <span className="text-muted-foreground">, nothing moves</span>
              : network.moves.map((m) => {
                  const name = network.rows.find((r) => r.site.id === m.id)?.site.name;
                  return <span key={m.id} className="block font-mono text-[13px]" title={name}>{m.from.domain}{m.from.path} → {m.to.domain}{m.to.path}</span>;
                })}
          </ReviewRow>
        )}
        {state.upload && (
          <ReviewRow label="Search and replace">
            {summary ?? <span className="text-muted-foreground">skipped: every address in the dump already answers here on https</span>}
          </ReviewRow>
        )}
        {input.core && <ReviewRow label="WordPress">{input.core.version} · {input.core.mode === 'wpcore' ? 'shared core' : 'own copy'}</ReviewRow>}
        {input.core && <ReviewRow label="Database"><span className="font-mono">{dbName}</span></ReviewRow>}
        {input.admin && (
          <ReviewRow label="Admin">
            {input.source !== 'repo'
              ? input.admin.user
              : input.admin.ifExists === 'keep' && input.admin.ifMissing === 'skip'
                ? <span className="text-muted-foreground">none added; the database's users stay</span>
                : <>
                    {input.admin.user}
                    <span className="text-muted-foreground">
                      {input.admin.ifExists === 'keep' ? ': left as it is when the database has it' : ': gets this password and the admin role when the database has it'}
                      {input.admin.ifMissing === 'create' ? ', created when it does not' : ', not created when it does not'}
                    </span>
                  </>}
          </ReviewRow>
        )}
        {input.uploadsFrom && <ReviewRow label="Uploads">missing files load from {input.uploadsFrom}</ReviewRow>}
        {input.repo && state.inspection.status === 'found' && <ReviewRow label="Settings">from your last install of this repo</ReviewRow>}
        {input.repo && state.inspection.status === 'claude' && <ReviewRow label="Settings">filled by Claude, reviewed by you</ReviewRow>}
      </dl>
      <div>
        <p className="text-sm font-medium">The panel will run {steps.length} steps</p>
        <ol className="mt-3 grid gap-1.5 text-sm">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-3">
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">If a step fails, the run stops. You can retry from that step or undo everything it created.</p>
      </div>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

// ── Install ──────────────────────────────────────────────────


function RunScreen({ input, onBack }: { input: CreateSiteInput; onBack: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The job's own page shows the progress, so it can be found again from the header after leaving.
    api.createSite(input).then((id) => {
      setJobId(id);
      navigate(`/jobs/${encodeURIComponent(id)}`);
    }, (err: Error) => setError(err.message));
    // Starts once per mount; StrictMode's second mount is skipped by the ref.
  }, []);

  if (error) {
    return (
      <div className="max-w-3xl rounded-xl border border-danger/30 bg-danger/6 p-4 text-sm">
        <p className="font-medium text-danger">The install did not start</p>
        <p className="mt-1">{error}</p>
        <Button variant="outline" className="mt-3" onClick={onBack}>Back to the answers</Button>
      </div>
    );
  }
  if (!jobId) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Starting the install...</p>;
  return <JobScreen jobId={jobId} wordpress={input.source !== 'empty'} />;
}

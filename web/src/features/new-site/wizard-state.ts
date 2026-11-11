import type { AddressInput, DumpPlugin, DumpTheme, InstallDraft, RepoInspection, RepoPreset } from '@devmagic-panel/shared';
import { presetPlacement, repoTarget, hostname, isLocalName, MEDIA_PLUGIN } from '@devmagic-panel/shared';
import { newOrgState, type OrgState } from './org';
import { placedRows } from './code';
import { type DraftInput } from '@/lib/api';
import { type CreateSiteInput } from '@/lib/plan';
import { adminChoices, cleanUserOf } from '@/lib/admin-choice';
import { buildSteps } from '@/lib/builds';
import { migrateDraftState, migrateStep, stepsFor } from '@/lib/drafts';
import { type NetworkAnswers, networkPlan, type NetworkPlan, NO_NETWORK_ANSWERS } from '@/lib/network';
import { answersHash } from '@/lib/steps';
import { allRows, type RepoRow } from '@/lib/project-repos';
import { missingPlugins, missingThemes, pluginChoices, repoPluginPaths, repoThemeNames, themeChoices } from '@/lib/missing-plugins';
import { pastedRepo } from '@/lib/org-repos';
import { asideUploads } from '@/lib/org-repos';
import { type Step, type WizardState } from './wizard-shared';

export const initial: WizardState = {
  replaceExisting: false,
  server: null,
  org: null,
  source: 'repo',
  repoUrl: '',
  branch: '',
  branches: null,
  placement: null,
  remember: true,
  extra: [],
  trust: {},
  noDump: false,
  pluginPicks: {},
  wporg: {},
  rememberedPlugins: [],
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

/** A remembered network layout as the answers the Domains step starts from: the main site keeps its own address. */
export function networkAnswersOf(network: NonNullable<RepoPreset['network']>): NetworkAnswers {
  const others = network.sites.filter((x) => x.id !== 1);
  return network.layout === 'subdomain'
    ? { layout: 'subdomain', domains: Object.fromEntries(others.map((x) => [x.id, x.domain])), paths: {} }
    : { layout: 'subdirectory', domains: {}, paths: Object.fromEntries(others.map((x) => [x.id, x.path])) };
}

/** Fills the wizard from the answers of the repo's last install here; a core that is not installed keeps the current choice. */
export function applyPreset(state: WizardState, found: RepoInspection, cores: string[]): WizardState {
  const project = found.preset;
  const branch = found.branch;
  const read = { branch, branches: found.branches ?? state.branches, ...(found.defaultBranch ? { defaultBranch: found.defaultBranch } : {}) };
  if (!project) return { ...state, ...read, inspection: { status: 'none', url: state.repoUrl.trim() } };
  const coreOk = project.core?.mode === 'repo' || (project.core?.version !== undefined && cores.includes(project.core.version));
  const placement = presetPlacement(project, state.repoUrl.trim());
  const composer = project.builds ? project.builds.some((b) => b.tool === 'composer') : (project.build?.composer ?? false);
  const npm = project.builds ? project.builds.some((b) => b.tool !== 'composer') : (project.build?.npm ?? false);
  const parts = [
    `into ${repoTarget(placement) || 'the site root'}`,
    project.core?.mode === 'repo' ? "the repo's own WordPress" : project.core?.version ? (coreOk ? `WordPress ${project.core.version}` : `WordPress ${project.core.version} (not installed here, pick another)`) : null,
    composer || npm ? `${[composer && 'composer', npm && 'npm'].filter(Boolean).join(' and ')} build` : null,
  ].filter(Boolean);
  // The other repos it had, each where it went, unless picked already.
  const known = new Set(allRows(state).map((r) => r.url));
  const extra = [
    ...state.extra,
    ...project.extra
      .filter((x) => !known.has(x.url))
      .map((x): RepoRow => ({ url: x.url, branch: x.branch ?? '', branches: null, placement: { dir: x.dir, folder: x.folder }, helpers: null, buildPicks: {} })),
  ];
  if (project.extra.length) parts.push(`${project.extra.length} more repo${project.extra.length === 1 ? '' : 's'}`);
  return {
    ...state,
    ...read,
    extra,
    placement,
    // Local addresses always come from the dump (or you), never from the last install; helpers are always your pick.
    ...(project.core && coreOk ? { coreMode: project.core.mode, ...(project.core.version ? { coreVersion: project.core.version } : {}) } : {}),
    deactivate: project.deactivate,
    rememberedPlugins: project.installPlugins ?? [],
    // A network's layout and its sites' addresses, by blog id, as you set them last time.
    ...(project.network ? { network: networkAnswersOf(project.network) } : {}),
    uploadsFrom: project.uploadsFrom ?? '',
    uploadsVia: project.uploadsVia ?? null,
    composer,
    npm,
    inspection: { status: 'found', url: state.repoUrl.trim(), branch, summary: parts.join(', ') },
  };
}


/**
 * The answers each step owns, to tell whether one changed since you continued
 * from it. Never the admin password: these hashes are kept in the draft.
 */
export const STEP_ANSWERS: Record<Step, (s: WizardState) => unknown> = {
  start: (s) => [s.source, s.org !== null],
  code: (s) => [placedRows(s).map((r) => [r.url, r.branch, r.placement]), s.org?.useClaude],
  read: (s) => [s.org?.read.status, s.org?.read.facts],
  database: (s) => [s.upload?.id, s.noDump, Boolean(s.cleanCopy)],
  domains: (s) => [s.domains, s.under, s.replaceExisting, s.replaceOn, s.network, s.server],
  wordpress: (s) => [s.coreMode, s.coreVersion, s.adminUser, s.adminEmail, s.adminIfExists, s.adminIfMissing, s.adminCreate, s.deactivate, s.activate, s.uploadsFrom, s.uploadsVia, s.composer, s.npm, s.buildPicks, s.pluginPicks],
  review: () => null,
};

/** The state with this step marked as passed with its answers as they are now. */
export const passStep = (s: WizardState, step: Step): WizardState => ({ ...s, passed: { ...s.passed, [step]: answersHash(STEP_ANSWERS[step](s)) } });

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
export function addressesOf(state: WizardState) {
  // Under a path, the site answers at its parent's domain: every address in the dump maps to it.
  const under = state.source !== 'empty' && state.under ? { domain: state.under.domain, path: cleanPath(state.under.path) } : null;
  const locals = under ? [under.domain] : [...new Set(state.domains.map((d) => cleanAddress(d.local, false)).filter(Boolean))];
  // A row whose address is already its local name needs nothing replaced.
  const pairs = state.source === 'repo' && !state.noDump
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

/** The plugins the dump has that no repo brings, and whether every repo's lookup is in to tell. */
export function missingOf(state: WizardState): { missing: DumpPlugin[]; reading: boolean } {
  const plugins = state.upload?.facts.plugins;
  if (state.source !== 'repo' || state.noDump || !plugins?.length) return { missing: [], reading: false };
  const rows = placedRows(state);
  const reading = rows.some((r) => !r.helpers || (!r.helpers.plugins && !r.helpers.error && !r.helpers.list));
  const present = repoPluginPaths(rows.map((r) => ({ placement: r.placement, ...(r.helpers?.plugins ? { plugins: r.helpers.plugins } : {}) })));
  return { missing: reading ? [] : missingPlugins(plugins, present), reading };
}

/** The themes the dump's sites use that none of the install's repos brings. */
export function missingThemesOf(state: WizardState): DumpTheme[] {
  const themes = state.upload?.facts.themes;
  if (state.source !== 'repo' || state.noDump || !themes?.length) return [];
  const rows = placedRows(state);
  if (rows.some((r) => !r.helpers || (!r.helpers.plugins && !r.helpers.error && !r.helpers.list))) return [];
  return missingThemes(themes, repoThemeNames(rows.map((r) => ({ placement: r.placement, ...(r.helpers?.themes ? { themes: r.helpers.themes } : {}), ...(r.helpers?.themeIn ? { themeIn: r.helpers.themeIn } : {}) }))));
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
  // The local helpers any of the repos has.
  const missing = pluginChoices(missingOf(state).missing, state.pluginPicks, state.wporg, state.rememberedPlugins, state.serverHas);
  const themes = themeChoices(missingThemesOf(state), state.themePicks ?? {}, state.wporgThemes ?? {}, state.serverHas);
  const helpers = state.helpers?.list || state.extra.some((r) => r.helpers?.list) ? [...new Set([...(state.helpers?.list ?? []), ...state.extra.flatMap((r) => r.helpers?.list ?? [])])] : undefined;
  return {
    source: state.source,
    domain: locals[0] ?? '',
    ...(under ? { path: under.path } : {}),
    replaceExisting: !under && state.replaceExisting,
    // A site under a path runs on its parent's server.
    server: !under && state.server ? state.server : 'apache',
    // The organization or group it came from; a pasted URL on another host has none.
    ...(state.org?.repo?.org && isRepo ? { organization: state.org.repo.org } : {}),
    aliases: locals.slice(1),
    repos: isRepo ? placedRows(state).map((r) => ({ url: r.url, branch: r.branch, ...r.placement })) : [],
    remember: state.remember,
    ...(isRepo && state.upload && !state.noDump ? { uploadId: state.upload.id } : {}),
    replace,
    ...(state.source !== 'empty'
      ? {
          core: state.coreMode === 'repo' ? { mode: 'repo' as const, ...(state.helpers?.core?.version ? { version: state.helpers.core.version } : {}) } : { mode: state.coreMode, version: state.coreVersion },
          admin: {
            user: (state.adminUser ?? defaults.user).trim(),
            email: (state.adminEmail ?? defaults.email).trim(),
            password: state.adminPassword ?? defaults.password,
            ...adminChoices(state),
          },
        }
      : {}),
    // BE Media from Production loading the images is never also deactivated; a missing plugin you chose to turn off joins the list.
    deactivate: isRepo && state.upload && !state.noDump ? [...new Set([...state.deactivate, ...missing.off])].filter((slug) => !(via === 'plugin' && uploadsOk && slug === MEDIA_PLUGIN)) : [],
    installPlugins: isRepo && state.upload && !state.noDump ? missing.install : [],
    installThemes: isRepo && state.upload && !state.noDump ? themes.install : [],
    ...(isRepo && state.upload && !state.noDump && state.serverFrom && state.copyUploads
      ? { copyUploads: { ...state.serverFrom, ...(state.uploadsMonths ? { months: state.uploadsMonths } : {}), ...(state.serverSecret ? { password: state.serverSecret } : {}) } }
      : {}),
    ...(isRepo && state.upload && !state.noDump && state.serverFrom && missing.copy.length + themes.copy.length
      ? { copyFromServer: { ...state.serverFrom, plugins: missing.copy, themes: themes.copy, ...(state.serverSecret ? { password: state.serverSecret } : {}) } }
      : {}),
    ...(isRepo && state.upload && !state.noDump && state.cleanCopy && state.source !== 'empty' ? { clean: { user: cleanUserOf(state, (state.adminUser ?? defaults.user).trim(), state.adminPassword ?? defaults.password) } } : {}),
    // Only helpers a repo has, not the ones the dump has on already, and never one set to deactivate.
    activate: isRepo && helpers ? state.activate.filter((slug) => helpers.includes(slug) && !active.has(slug) && !state.deactivate.includes(slug)) : [],
    ...(isRepo && uploadsOk ? { uploadsFrom, uploadsVia: via } : { uploadsVia: 'redirect' as const }),
    build: { composer: isRepo && state.composer, npm: isRepo && state.npm },
    ...(isRepo && (state.helpers?.builds || state.extra.some((r) => r.helpers?.builds))
      ? {
          builds: [
            ...buildSteps(state.helpers?.builds ?? [], state.buildPicks, state.org?.read.facts?.buildCommands ?? []),
            ...state.extra.flatMap((r, i) => buildSteps(r.helpers?.builds ?? [], r.buildPicks, [], i + 1)),
          ],
        }
      : {}),
    // Each site kept where it is: nothing moves, and new sites follow the dump's own setting.
    ...(network && network.layout !== 'keep' ? { network: { layout: network.layout, sites: network.rows.map((r) => ({ id: r.site.id, ...r.here })) } } : {}),
  };
}

/** A draft's answers back in the wizard: never a password, and no dump that is gone. */
export function stateFromDraft(draft: InstallDraft): WizardState {
  const saved = migrateDraftState(draft.state) as Partial<WizardState>;
  // An install from a repo and a dump from before 1.28 had no project state: its repo becomes the picked one.
  if (saved.source === 'repo' && !saved.org) saved.org = { ...newOrgState('', false), repo: pastedRepo(saved.repoUrl?.trim() ?? '') };
  const upload = saved.upload && draft.uploads.includes(saved.upload.id) ? saved.upload : null;
  const kept: WizardState = { ...initial, ...saved, upload, adminPassword: null, serverSecret: null, org: saved.org ? keptOrg(saved.org, draft.uploads) : null };
  // Lookups that were still running when you left start again: the repo's and its helpers'.
  const state: WizardState = {
    ...kept,
    inspection: kept.inspection.status === 'reading' ? { status: 'idle' } : kept.inspection,
    helpers: kept.helpers && !kept.helpers.list && !kept.helpers.error ? null : kept.helpers,
  };
  if (saved.passed) return state;
  // A draft saved before steps kept their hashes: the steps before where it stopped count as passed.
  const flow = stepsFor(state.source, Boolean(state.org?.useClaude));
  return flow.slice(0, Math.max(0, flow.indexOf(migrateStep(draft.step) as Step))).reduce(passStep, state);
}


/** The repos an organization install put aside, each without a dump that is gone. */
export function keptOrg(org: OrgState, uploads: string[]): OrgState {
  if (!org.earlier) return org;
  const earlier = Object.fromEntries(Object.entries(org.earlier).map(([name, p]) => [name, p.state.upload && !uploads.includes(p.state.upload.id) ? { ...p, state: { ...p.state, upload: null } } : p]));
  return { ...org, earlier };
}

/** The fallback name of an install that has no domain or repo yet. */
export const UNNAMED = 'New site';

/** What an install is called in lists and its header: its domain, else its repo. */
export function titleOf(state: WizardState, input: CreateSiteInput): string {
  const repo = state.repoUrl.trim().replace(/\.git$/, '').split(/[:/]/).slice(-2).join('/');
  return `${input.domain}${input.path ?? ''}` || state.org?.repo?.fullName || (state.source === 'repo' && repo) || UNNAMED;
}

/** What a draft keeps of the wizard: all answers but the password, which is only sent with the install. */
export function draftOf(state: WizardState, step: Step, input: CreateSiteInput): DraftInput {
  return {
    kind: state.org ? 'organization' : 'manual',
    title: titleOf(state, input),
    step,
    state: { ...state, adminPassword: null, serverSecret: null } as unknown as Record<string, unknown>,
    // The dumps of repos an organization install put aside stay with the draft too.
    uploads: [...new Set([...(state.upload ? [state.upload.id] : []), ...asideUploads(state.org)])],
  };
}

/** Where the page stands with its draft; a new install has none until you continue from Start. */
export type Opened = { status: 'new' | 'loading' | 'ready' | 'gone' } | { status: 'installing'; jobId?: string } | { status: 'error'; message: string };

/** What the header says about the draft. */
export interface Saved {
  updatedAt: string;
  expiresAt?: string;
  failed: boolean;
}

export const savedOf = (draft: InstallDraft): Saved => ({ updatedAt: draft.updatedAt, ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}), failed: draft.status === 'failed' });

import type { LocalHelperPlugin, OrgRepo, RepoBuild, RepoKind, RepoLookup, RepoPlacement } from '@devmagic-panel/shared';
import { placementForKind, placementProblems, REPO_KIND_LABELS, repoTarget, repoWeb, sameRepo, THEME_REPOS_DIR } from '@devmagic-panel/shared';
import type { WizardState } from '@/features/new-site/wizard-shared';
import type { BuildPick } from './builds';

/** What the lookup read from a repo's branch: its local helpers, BE Media, builds, what it holds. */
export interface RepoHelpers {
  key: string;
  list?: LocalHelperPlugin[];
  media?: boolean;
  builds?: RepoBuild[];
  /** The Nodes nvm has, for a build's Node. */
  nodes?: string[];
  kind?: RepoLookup['kind'];
  /** The theme is this folder of the repo. */
  themeIn?: string;
  /** A plugin is this folder of the repo, by its header. */
  pluginIn?: string;
  /** The theme or plugin by its header: name, version, a child theme's parent. */
  header?: RepoLookup['header'];
  core?: RepoLookup['core'];
  uploads?: boolean;
  /** Its plugin folders, as paths in the repo. */
  plugins?: string[];
  /** Its theme folders, as paths in the repo. */
  themes?: string[];
  error?: string;
}

/** A repo of the install besides the main one: a theme, a plugin, any folder of the site. */
export interface RepoRow {
  url: string;
  branch: string;
  /** Its branches, default first; null until read, or when they could not be read (the branch is typed then). */
  branches: string[] | null;
  defaultBranch?: string;
  /** Where it goes; null until you chose: then by what it holds. */
  placement: RepoPlacement | null;
  /** Its name in the list it came from, and what that list says it holds. */
  fullName?: string;
  kind?: RepoKind;
  helpers: RepoHelpers | null;
  buildPicks: Record<string, BuildPick>;
}

const ROOT: RepoPlacement = { dir: '', folder: '' };

/** A listed or pasted repo as a row of the install. */
export const rowOf = (repo: Pick<OrgRepo, 'sshUrl' | 'fullName' | 'kind' | 'defaultBranch'>): RepoRow => ({
  url: repo.sshUrl,
  branch: repo.defaultBranch ?? '',
  branches: null,
  ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
  placement: null,
  fullName: repo.fullName,
  kind: repo.kind,
  helpers: null,
  buildPicks: {},
});

/** Where an added repo goes: what you chose, else by what it holds (the lookup, then the list), else the plugins folder. */
export function rowPlacement(row: RepoRow): RepoPlacement {
  if (row.placement) return row.placement;
  const kind = row.helpers?.kind ?? row.kind;
  // An added repo is never the site root by default: the main repo is.
  const byKind = kind && kind !== 'site' ? placementForKind(kind, row.url, row.helpers?.themeIn) : null;
  return byKind ?? { dir: 'wp-content/plugins', folder: placementForKind('plugin', row.url)?.folder ?? '' };
}

/**
 * What a picked repo is, for its badge: the theme or plugin WordPress would
 * see by its header (name and version), else what its files hold, else where
 * it goes. Null while nothing is known yet.
 */
export function repoKindLabel(helpers: RepoHelpers | null | undefined, kind: RepoKind | undefined, placement: RepoPlacement | null): string | null {
  const header = helpers?.header;
  if (header) {
    const named = `${header.name}${header.version ? ` ${header.version}` : ''}`;
    const what = header.kind === 'plugin' ? `Plugin: ${named}` : header.parent ? `Child theme of ${header.parent}: ${named}` : `Theme: ${named}`;
    return header.folder ? `${what}, in the repo's ${header.folder} folder` : what;
  }
  const holds = helpers?.kind ?? kind;
  if (holds === 'theme' && helpers?.themeIn) return `Theme, in the repo's ${helpers.themeIn} folder`;
  if (holds && holds !== 'other') return REPO_KIND_LABELS[holds];
  if (!placement) return null;
  const dir = placement.dir.replace(/\/+$/, '');
  if (dir === THEME_REPOS_DIR || dir.endsWith('themes')) return 'No theme header: goes in themes';
  if (dir.endsWith('mu-plugins')) return 'Goes in mu-plugins';
  if (dir.endsWith('plugins')) return 'No plugin header: goes in plugins';
  return holds === 'other' ? 'Not a theme or plugin' : null;
}

/** Where the main repo goes: what you or a last install chose, else by what the repo holds, else the site root. */
export function placementOf(state: Pick<WizardState, 'placement' | 'helpers' | 'repoUrl'>): RepoPlacement {
  return state.placement ?? (state.helpers?.kind ? placementForKind(state.helpers.kind, state.repoUrl.trim(), state.helpers.themeIn) : null) ?? ROOT;
}

/** The main repo's row, from the wizard's own fields. */
export function mainRow(s: WizardState): RepoRow | null {
  const url = s.repoUrl.trim();
  if (!url) return null;
  return {
    url,
    branch: s.branch.trim(),
    branches: s.branches,
    ...(s.defaultBranch ? { defaultBranch: s.defaultBranch } : {}),
    placement: s.placement,
    ...(s.org?.repo && sameRepo(s.org.repo.sshUrl, url) ? { fullName: s.org.repo.fullName, kind: s.org.repo.kind } : {}),
    helpers: s.helpers,
    buildPicks: s.buildPicks,
  };
}

/** Every repo the install has, the main one first. */
export const allRows = (s: WizardState): RepoRow[] => [...(mainRow(s) ? [mainRow(s) as RepoRow] : []), ...s.extra];

/** Whether a repo is picked already, main or added, by any of its URLs. */
export const isPicked = (s: WizardState, url: string): boolean => allRows(s).some((r) => sameRepo(r.url, url) || r.url === url);

/** The wizard with a repo as the main one: its branch, lookups and read start again; every other answer stays. */
export function withMain(s: WizardState, row: RepoRow, listed: OrgRepo | null): WizardState {
  const same = s.repoUrl.trim() !== '' && sameRepo(s.repoUrl.trim(), row.url);
  if (same) return s;
  const { defaultBranch: _old, ...rest } = s;
  return {
    ...rest,
    repoUrl: row.url,
    branch: row.branch,
    branches: row.branches,
    ...(row.defaultBranch ? { defaultBranch: row.defaultBranch } : {}),
    placement: row.placement,
    helpers: row.helpers,
    buildPicks: row.buildPicks,
    inspection: { status: 'idle' },
    // What Claude read was about the other repo.
    org: s.org ? { ...s.org, repo: listed, read: { status: 'idle' }, access: { status: 'idle' } } : s.org,
  };
}

/**
 * Picks a repo: the first one is the main repo, later ones are added, each
 * with its own branch and folder. Picking one already there changes nothing.
 */
export function pickRepo(s: WizardState, repo: OrgRepo): WizardState {
  if (isPicked(s, repo.sshUrl)) return s;
  const row = rowOf(repo);
  if (!s.repoUrl.trim()) return withMain(s, row, repo);
  return { ...s, extra: [...s.extra, row] };
}

/** Leaves a repo out; when it was the main one, the next becomes main. */
export function unpickRepo(s: WizardState, url: string): WizardState {
  const main = s.repoUrl.trim();
  if (main && (main === url || sameRepo(main, url))) {
    const [next, ...others] = s.extra;
    const cleared = { ...s, extra: others };
    if (!next) return { ...cleared, repoUrl: '', branch: '', branches: null, placement: null, helpers: null, buildPicks: {}, inspection: { status: 'idle' }, org: s.org ? { ...s.org, repo: null, read: { status: 'idle' }, access: { status: 'idle' } } : s.org };
    return withMain({ ...cleared, repoUrl: '' }, next, listedOf(next));
  }
  return { ...s, extra: s.extra.filter((r) => !(r.url === url || sameRepo(r.url, url))) };
}

/**
 * The picked repos in the order they show: the added ones as picked, with the
 * main one at its place among them (mainAt; first until Make main moved the
 * role). The rows themselves come main first, as everything else reads them.
 */
export function shownOrder<T>(rows: readonly T[], mainAt = 0): T[] {
  const [main, ...rest] = rows;
  if (main === undefined) return [];
  rest.splice(Math.min(Math.max(0, mainAt), rest.length), 0, main);
  return rest;
}

/**
 * An added repo becomes the main one, and the main one an added repo. Only
 * the role moves: both stay where they show in the list, and in their folders.
 */
export function makeMain(s: WizardState, url: string): WizardState {
  const row = s.extra.find((r) => r.url === url);
  const old = mainRow(s);
  if (!row || !old) return s;
  // The old main repo keeps where it went, so it does not move to the plugins folder.
  const kept: RepoRow = { ...old, placement: old.placement ?? (old.helpers?.kind ? placementForKind(old.helpers.kind, old.url, old.helpers.themeIn) : null) ?? ROOT };
  // As shown now, with the old main as a row of its own; the new main keeps its place in it.
  const shown = shownOrder<RepoRow | null>([null, ...s.extra], s.mainAt).map((r) => r ?? kept);
  const promoted = withMain({ ...s, repoUrl: '', extra: shown.filter((r) => r !== row), mainAt: shown.indexOf(row) }, row, listedOf(row));
  return promoted;
}

/** A row as the repo the Claude steps read: its path on the host. */
export function listedOf(row: RepoRow): OrgRepo | null {
  if (!row.fullName) return null;
  const name = row.fullName.split('/').pop() as string;
  return { org: '', name, fullName: row.fullName, sshUrl: row.url, url: repoWeb(row.url)?.repoUrl ?? '', archived: false, kind: row.kind ?? 'site', ...(row.defaultBranch ? { defaultBranch: row.defaultBranch } : {}) };
}

/** Changes one added repo, by its URL. */
export const updateRow = (s: WizardState, url: string, change: (r: RepoRow) => RepoRow): WizardState => ({ ...s, extra: s.extra.map((r) => (r.url === url ? change(r) : r)) });

/** Why the picked repos cannot be installed as placed: two at one path, two at the root. */
export function rowsProblem(rows: Array<{ placement: RepoPlacement }>): string | null {
  return placementProblems(rows.map((r) => r.placement))[0] ?? null;
}

/** One line of the site plan: a repo at its path, how deep, and what it is. */
export interface PlanLine {
  path: string;
  depth: number;
  url: string;
  label: string;
  branch: string;
  main: boolean;
}

/** The repos as a folder tree of the site, shallow first: what the Site plan shows. */
export function planLines(rows: Array<{ url: string; branch: string; placement: RepoPlacement; fullName?: string }>): PlanLine[] {
  return rows
    .map((r, i) => {
      const path = repoTarget(r.placement);
      return { path, depth: path ? path.split('/').length : 0, url: r.url, label: r.fullName ?? r.url.replace(/\.git$/, '').split(/[:/]/).slice(-2).join('/'), branch: r.branch, main: i === 0 };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

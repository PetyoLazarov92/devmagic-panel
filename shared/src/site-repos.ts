import { z } from 'zod';

/**
 * Where a repo of a site goes: a folder of the site (`dir`, '' for the site
 * root) and the folder it is cloned into there (`folder`, '' for `dir`
 * itself). wandworks/blocks into wp-content/plugins is
 * `{ dir: 'wp-content/plugins', folder: 'wandworks-blocks' }`; a whole site
 * repo is `{ dir: '', folder: '' }`.
 */
export interface RepoPlacement {
  dir: string;
  folder: string;
}

/** The most repos one site takes. */
export const MAX_SITE_REPOS_PER_INSTALL = 10;
/** How deep a repo may go in the site. */
const MAX_DEPTH = 8;

const SEGMENT = /^[A-Za-z0-9_@+][A-Za-z0-9_.@+-]{0,99}$/;

/** A folder of a site, relative to its root: '' or wp-content/plugins. Never `.`, `..` or a leading slash. */
export const siteDir = z
  .string()
  .max(300)
  .refine((dir) => dir === '' || dir.split('/').every((part) => SEGMENT.test(part)), 'A folder of the site, like wp-content/plugins')
  .refine((dir) => dir.split('/').length <= MAX_DEPTH, `At most ${MAX_DEPTH} folders deep`);

/** The folder a repo is cloned into: a plain name, or '' for the folder above itself. */
export const cloneFolder = z.union([z.literal(''), z.string().regex(SEGMENT, 'A folder name: letters, digits and . _ - @ +, not starting with a dot')]);

/** The path of a repo in its site, like wp-content/plugins/wandworks-blocks; '' is the site root. */
export const repoTarget = (p: RepoPlacement): string => [p.dir, p.folder].filter(Boolean).join('/');

/** A repo's name from its URL: wandworks-blocks from git@github.com:wandworks/wandworks-blocks.git. */
export function repoBaseName(url: string): string {
  const name = url.replace(/\.git$/, '').replace(/[:/]+$/, '').split(/[:/]/).pop() ?? '';
  return SEGMENT.test(name) ? name : '';
}

/** The quick picks for Install to, in the order the wizard shows them. */
export const PLACEMENT_DIRS = [
  { dir: '', label: 'Site root' },
  { dir: 'wp-content', label: 'wp-content' },
  { dir: 'wp-content/themes', label: 'Themes' },
  { dir: 'wp-content/plugins', label: 'Plugins' },
  { dir: 'wp-content/mu-plugins', label: 'Must-use plugins' },
] as const;

/** The old fixed layouts, kept for drafts, presets and inputs from before 1.28. */
export type LegacyLayout = 'site-root' | 'wp-content' | 'theme' | 'plugin';

/** Where an old layout put the repo. */
export function placementForLayout(layout: LegacyLayout, url: string): RepoPlacement {
  switch (layout) {
    case 'site-root':
      return { dir: '', folder: '' };
    case 'wp-content':
      return { dir: '', folder: 'wp-content' };
    case 'theme':
      return { dir: 'wp-content/themes', folder: repoBaseName(url) };
    case 'plugin':
      return { dir: 'wp-content/plugins', folder: repoBaseName(url) };
  }
}

/** What a repo holds, as the org scan and the repo lookup read it from its top level. */
export type RepoHolds = 'site' | 'wp-content' | 'theme' | 'plugin' | 'other';

/** Where a repo goes by default, from what it holds; null when nothing says (you pick). */
export function placementForKind(kind: RepoHolds, url: string): RepoPlacement | null {
  if (kind === 'site') return { dir: '', folder: '' };
  if (kind === 'wp-content') return { dir: '', folder: 'wp-content' };
  if (kind === 'theme') return { dir: 'wp-content/themes', folder: repoBaseName(url) };
  if (kind === 'plugin') return { dir: 'wp-content/plugins', folder: repoBaseName(url) };
  return null;
}

/** Folders WordPress core brings: a shared core links them into the site. */
export const CORE_DIRS = ['wp-admin', 'wp-includes'] as const;
/** Where WordPress keeps media. */
export const UPLOADS_DIR = 'wp-content/uploads';

const under = (path: string, top: string) => path === top || path.startsWith(`${top}/`);

/**
 * Why a set of repo placements cannot be installed: two repos at one path, or
 * more than one at the site root. A repo inside another one's folder is fine:
 * it is cloned after it. Empty when they can.
 */
export function placementProblems(repos: readonly RepoPlacement[]): string[] {
  const problems: string[] = [];
  const targets = repos.map(repoTarget);
  if (targets.filter((t) => t === '').length > 1) problems.push('Only one repo can be the site root');
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t) && t !== '') problems.push(`Two repos go to ${t}`);
    seen.add(t);
  }
  return problems;
}

/**
 * Advice about where a repo goes, never a refusal: core and uploads are
 * usually kept out of git, but a repo may patch core on purpose. With a
 * shared core, a repo placed in a core folder cannot work (it would go
 * through the core's link): that one is a problem, said apart.
 */
export function placementWarnings(target: string): string[] {
  const warnings: string[] = [];
  if (CORE_DIRS.some((d) => under(target, d))) warnings.push('WordPress core is usually kept out of git; fine if the repo patches core on purpose');
  if (under(target, UPLOADS_DIR)) warnings.push('Uploads are usually kept out of git; fine if the repo keeps some media on purpose');
  return warnings;
}

/** A target inside a folder a shared core links into the site: it would write into the core every site uses. */
export const throughCoreLink = (target: string): boolean => CORE_DIRS.some((d) => under(target, d));

/** Folders of the repo's own top level that make it hold WordPress core, as the lookup reads them. */
export const holdsCore = (topLevel: readonly string[]): boolean => CORE_DIRS.every((d) => topLevel.includes(d));

/** Whose a repo is: its host and the path before its name (wandworks, or wandworks/web on GitLab). */
export interface RepoOwner {
  host: string;
  owner: string;
}

/** The host and owner of a git URL, or null when it names none. */
export function repoOwner(url: string, web: { repoUrl: string } | null): RepoOwner | null {
  if (!web) return null;
  try {
    const u = new URL(web.repoUrl);
    const path = u.pathname.replace(/^\/+|\/+$/g, '');
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return null;
    return { host: u.hostname.toLowerCase(), owner: path.slice(0, slash).toLowerCase() };
  } catch {
    return null;
  }
}

/** A repo whose owner, or a group above it, is one of these: wandworks/web/site is under wandworks. */
export function ownedBy(owner: RepoOwner, list: readonly RepoOwner[]): boolean {
  return list.some((t) => t.host === owner.host && (owner.owner === t.owner || owner.owner.startsWith(`${t.owner}/`)));
}

/** A trusted owner as Settings and the wizard show it. */
export interface TrustedOwner extends RepoOwner {
  at: string;
}

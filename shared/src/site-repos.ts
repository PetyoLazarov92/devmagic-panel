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
  { dir: 'wp-content/repos', label: 'Theme inside the repo' },
] as const;

/**
 * Where a repo goes whose theme is one of its folders (tooling on top, the
 * theme in wandworks/). Each repo right in this folder is one more themes
 * folder to WordPress, through Local mode, so the theme keeps its own name
 * (wandworks, as production's database has it) and nothing in the database
 * changes. In wp-content/themes WordPress would list it as repo/wandworks.
 */
export const THEME_REPOS_DIR = 'wp-content/repos';

/**
 * A folder's files say theme: functions.php with style.css, or, where the
 * build makes style.css, with index.php and one more file only a theme has.
 */
export function looksLikeTheme(names: readonly string[]): boolean {
  const has = (n: string) => names.includes(n);
  if (!has('functions.php')) return false;
  return has('style.css') || (has('index.php') && ['header.php', 'footer.php', 'screenshot.png', 'theme.json'].some(has));
}

/**
 * One field of a WordPress file header, as get_file_data reads it: within
 * the first 8 KB, a line like " * Plugin Name: Wandworks Blocks" (or right
 * after <?php), without a comment's or PHP's closing after the value.
 */
export function headerField(text: string, field: string): string | undefined {
  const m = new RegExp(`^(?:[ \\t]*<\\?php)?[ \\t/*#@]*${field}:(.*)$`, 'mi').exec(text.slice(0, 8192));
  const value = m?.[1]?.replace(/\s*(?:\*\/|\?>).*$/, '').trim();
  return value ? value.slice(0, 120) : undefined;
}

/** A theme or plugin as WordPress names it from its header, and the folder of the repo it is in when not the top. */
export interface WpHeader {
  kind: 'theme' | 'plugin';
  name: string;
  version?: string;
  /** A child theme's parent, from its Template field. */
  parent?: string;
  /** The repo's folder it is in; none when it is the repo itself. */
  folder?: string;
}

/** A header in one file: style.css for a theme, a .php file for a plugin. */
function headerOf(path: string, text: string): WpHeader | undefined {
  const name = path.split('/').at(-1) ?? '';
  const field = name === 'style.css' ? 'Theme Name' : name.endsWith('.php') ? 'Plugin Name' : undefined;
  const title = field ? headerField(text, field) : undefined;
  if (!field || !title) return undefined;
  const version = headerField(text, 'Version');
  const parent = field === 'Theme Name' ? headerField(text, 'Template') : undefined;
  return { kind: field === 'Theme Name' ? 'theme' : 'plugin', name: title, ...(version ? { version } : {}), ...(parent ? { parent } : {}) };
}

/** The files a header is read from: style.css and .php files at the top and one folder down, never in folders tools fill. */
export function headerCandidate(path: string): boolean {
  const parts = path.split('/');
  if (parts.length > 2 || (parts.length === 2 && (!SEGMENT.test(parts[0] as string) || ['node_modules', 'vendor', 'bower_components'].includes(parts[0] as string)))) return false;
  const name = parts.at(-1) ?? '';
  return name === 'style.css' || name.endsWith('.php');
}

/**
 * What WordPress would take a repo for, by the headers it reads: a theme by
 * style.css's Theme Name, a plugin by a PHP file's Plugin Name, at the top
 * first, else in the one folder below that has one. Undefined when none has,
 * or several folders do.
 */
export function wpHeaderIn(files: ReadonlyMap<string, string>): WpHeader | undefined {
  const found = [...files].filter(([path]) => headerCandidate(path)).flatMap(([path, text]) => {
    const header = headerOf(path, text);
    const parts = path.split('/');
    return header ? [{ ...header, ...(parts.length === 2 ? { folder: parts[0] as string } : {}) }] : [];
  });
  // A theme's style.css wins over a PHP file of the same folder that happens to have a plugin's header.
  const pick = (list: WpHeader[]) => list.find((h) => h.kind === 'theme') ?? list[0];
  const top = found.filter((h) => !h.folder);
  if (top.length) return pick(top);
  const folders = [...new Set(found.map((h) => h.folder))];
  return folders.length === 1 ? pick(found) : undefined;
}

/**
 * The one folder of a repo's top level that is a theme, from the repo's file
 * paths: wandworks for wandworks/functions.php and the rest. Undefined when
 * none or several are, or one is named like a folder tools fill.
 */
export function themeFolderIn(paths: Iterable<string>): string | undefined {
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.length !== 2) continue;
    const [folder = '', name = ''] = parts;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), name]);
  }
  const themes = [...byFolder].filter(([folder, names]) => SEGMENT.test(folder) && !['node_modules', 'vendor'].includes(folder) && looksLikeTheme(names)).map(([folder]) => folder);
  return themes.length === 1 ? themes[0] : undefined;
}

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
export function placementForKind(kind: RepoHolds, url: string, themeIn?: string): RepoPlacement | null {
  if (themeIn) return { dir: THEME_REPOS_DIR, folder: repoBaseName(url) };
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
  if (target !== THEME_REPOS_DIR && under(target, THEME_REPOS_DIR)) warnings.push('WordPress reads the theme inside this repo under its own name through Local mode, so Local mode has to stay on for this site');
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

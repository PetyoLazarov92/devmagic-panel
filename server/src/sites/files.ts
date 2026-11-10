import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_IMAGE_TYPES, FILE_TEXT_MAX, type FileEntry, type FileListing, type FileShortcut, type FileView, isSitePath, nameOf } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { findVhost } from './discover.js';
import { LOCAL_MODE_FILE } from './local-mode.js';
import { SiteNotFoundError } from './site-actions.js';

/**
 * A site's Files tab. Everything works as you, never as root, and stays in
 * the site's folder: a path is checked as written and again after links are
 * followed. A link that leaves the folder is only read when it leads into
 * the shared cores (a site's wp-admin and wp-includes), and never written.
 */

export class FileRefused extends Error {}

/** A very long folder is cut here; the rest is counted. */
export const FOLDER_MAX = 5000;
const PANEL_FILES = new Set(['devmagic-panel-login.php', LOCAL_MODE_FILE]);

export interface FilesContext {
  /** The site's folder. */
  root: string;
  /** Folders outside it that a link may be read through: the shared cores. */
  readRoots: readonly string[];
}

/** The folder a site's files are in: its vhost's, or the one its path is served from. */
export function siteFolder(config: SystemConfig, domain: string, path?: string): string {
  const vhost = findVhost(config, domain);
  if (!vhost?.docroot || vhost.names[0] !== domain) throw new SiteNotFoundError(`no site called ${domain}`);
  const docroot = path === undefined ? vhost.docroot : vhost.mounts.find((m) => m.path === path)?.docroot;
  if (!docroot || !existsSync(docroot)) throw new SiteNotFoundError(`no site at ${domain}${path ?? ''}`);
  return docroot;
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const canWrite = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const whyNot = (error: unknown, what: string): string => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? `you may not read ${what}` : code === 'ENOENT' ? `${what} is not there any more` : code === 'ENOTDIR' ? `${what} is not a folder` : (error as Error).message;
};
const modeOf = (mode: number) => (mode & 0o7777).toString(8).padStart(3, '0');

export interface Located {
  /** The path as written, under the site's folder. */
  full: string;
  /** The same after links are followed. */
  real: string;
  /** It is in the site's own folder; false for something read through a link into the shared cores. */
  inside: boolean;
}

/** Where a path of the Files tab is on disk, refused when it is not the site's to show. */
export function locate(ctx: FilesContext, rel: string): Located {
  if (!isSitePath(rel)) throw new FileRefused('Give a path inside the site, like wp-content/themes');
  const root = real(ctx.root);
  if (root === null) throw new FileRefused("the site's folder is not there");
  const full = rel ? join(root, rel) : root;
  let resolved: string;
  try {
    resolved = realpathSync(full);
  } catch (error) {
    throw new FileRefused(whyNot(error, rel || 'the folder'));
  }
  if (within(resolved, root)) return { full, real: resolved, inside: true };
  if (ctx.readRoots.some((r) => within(resolved, real(r) ?? '\0'))) return { full, real: resolved, inside: false };
  throw new FileRefused(`${rel} is a link that leaves the site's folder`);
}

function entryOf(root: string, dir: Located, rel: string, name: string): FileEntry {
  const full = join(dir.real, name);
  try {
    const st = lstatSync(full);
    const kind: FileEntry['kind'] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other';
    const entry: FileEntry = {
      name,
      kind,
      modifiedAt: st.mtime.toISOString(),
      mode: modeOf(st.mode),
      writable: dir.inside && kind !== 'link' && canWrite(full),
      ...(kind === 'file' ? { sizeBytes: st.size } : {}),
    };
    if (kind === 'dir' && existsSync(join(full, '.git'))) return { ...entry, note: 'repo' };
    if (kind === 'file' && PANEL_FILES.has(name) && rel === 'wp-content/mu-plugins') return { ...entry, note: 'panel' };
    if (kind !== 'link') return entry;
    const to = real(full);
    let targetKind: FileEntry['targetKind'] = 'missing';
    try {
      if (to) targetKind = statSync(to).isDirectory() ? 'dir' : 'file';
    } catch {
      // a link to nothing
    }
    const outside = to !== null && !within(to, root);
    return { ...entry, target: readlinkSync(full), targetKind, ...(outside ? { outside: true as const } : {}) };
  } catch {
    return { name, kind: 'other', writable: false };
  }
}

/** How many entries a folder has, leaving out hidden ones and index.php (WordPress puts one in each to stop listings). */
function countOf(dir: string): { count?: number } {
  try {
    return { count: readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'index.php').length };
  } catch {
    return {};
  }
}

/** The places of a site worth one click, the ones that are there, with how many entries a folder has and how big a file is. */
export function shortcuts(root: string): FileShortcut[] {
  const found: FileShortcut[] = [];
  const add = (label: string, path: string, kind: FileShortcut['kind']) => {
    try {
      const st = statSync(join(root, path));
      if (kind === 'file' && st.isFile()) found.push({ label, path, kind, sizeBytes: st.size });
      if (kind === 'dir' && st.isDirectory()) found.push({ label, path, kind, ...countOf(join(root, path)) });
    } catch {
      // not there
    }
  };
  add('wp-content', 'wp-content', 'dir');
  add('Themes', 'wp-content/themes', 'dir');
  add('Plugins', 'wp-content/plugins', 'dir');
  add('Uploads', 'wp-content/uploads', 'dir');
  for (const repo of repoFolders(root)) if (repo && !found.some((f) => f.path === repo)) found.push({ label: `Repo: ${nameOf(repo)}`, path: repo, kind: 'dir' });
  add('wp-config.php', 'wp-config.php', 'file');
  add('debug.log', 'wp-content/debug.log', 'file');
  return found;
}

/** The git repos of a site, where installs place them: the folder itself, wp-content, and one level into themes, plugins, mu-plugins and repos. */
export function repoFolders(root: string): string[] {
  const repos: string[] = [];
  const isRepo = (rel: string) => existsSync(join(root, rel, '.git'));
  for (const rel of ['', 'wp-content']) if (isRepo(rel)) repos.push(rel);
  for (const parent of ['wp-content/themes', 'wp-content/plugins', 'wp-content/mu-plugins', 'wp-content/repos']) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, parent), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.slice(0, 500)) if (isRepo(`${parent}/${name}`)) repos.push(`${parent}/${name}`);
  }
  return repos;
}

const CORE_NOTE = 'This folder is part of a shared WordPress core, outside the site. It is read only here.';

/** One folder's entries, folders first. */
export function listFolder(ctx: FilesContext, rel: string, max = FOLDER_MAX): FileListing {
  const dir = locate(ctx, rel);
  const root = real(ctx.root) as string;
  let names: string[];
  try {
    names = readdirSync(dir.real, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => d.name);
  } catch (error) {
    throw new FileRefused(whyNot(error, rel || 'the folder'));
  }
  return {
    dir: rel,
    root,
    entries: names.slice(0, max).map((name) => entryOf(root, dir, rel, name)),
    more: Math.max(0, names.length - max),
    writable: dir.inside && canWrite(dir.real),
    ...(dir.inside ? {} : { readOnly: CORE_NOTE }),
    shortcuts: shortcuts(root),
  };
}

const extension = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
/** The type a file is shown with as it is, or undefined: only the four image types, never SVG or HTML. */
export const imageType = (name: string): string | undefined => FILE_IMAGE_TYPES[extension(name)];

/** Bytes that are text: no NUL, and valid UTF-8. */
export function isText(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export const hashOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** One file to look at: its text when it is text and small enough, else what it is. */
export function readFile(ctx: FilesContext, rel: string): FileView {
  const at = locate(ctx, rel);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(at.real);
  } catch (error) {
    throw new FileRefused(whyNot(error, rel));
  }
  if (!st.isFile()) throw new FileRefused(`${rel} is not a file`);
  const name = nameOf(rel);
  const facts = {
    path: rel,
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    mode: modeOf(st.mode),
    writable: at.inside && canWrite(at.real),
    ...(at.inside ? {} : { readOnly: CORE_NOTE }),
    ...(PANEL_FILES.has(name) && rel === `wp-content/mu-plugins/${name}` ? { note: 'panel' as const } : {}),
  };
  if (imageType(name)) return { ...facts, kind: 'image' };
  if (st.size > FILE_TEXT_MAX) return { ...facts, kind: 'large' };
  let bytes: Buffer;
  try {
    bytes = readFileSync(at.real);
  } catch (error) {
    throw new FileRefused(whyNot(error, rel));
  }
  if (!isText(bytes)) return { ...facts, kind: 'binary' };
  const text = bytes.toString('utf8');
  return { ...facts, kind: 'text', text, hash: hashOf(bytes), eol: text.includes('\r\n') ? 'crlf' : 'lf' };
}

/** A file to send as it is: where it is and how large. */
export function rawFile(ctx: FilesContext, rel: string): { file: string; name: string; sizeBytes: number; image?: string } {
  const at = locate(ctx, rel);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(at.real);
  } catch (error) {
    throw new FileRefused(whyNot(error, rel));
  }
  if (!st.isFile()) throw new FileRefused(`${rel} is not a file`);
  const name = nameOf(rel);
  const image = imageType(name);
  return { file: at.real, name, sizeBytes: st.size, ...(image ? { image } : {}) };
}

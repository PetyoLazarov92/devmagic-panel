/**
 * A site's Files tab: one folder's entries, and one file to look at. Paths
 * are always relative to the site's folder ('' is the folder itself), with
 * forward slashes and no leading one.
 */

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  sizeBytes?: number;
  modifiedAt?: string;
  /** Its permissions, like 644. */
  mode?: string;
  /** You can change it: write the file, or add to and remove from the folder. */
  writable: boolean;
  /** Where a link points, as written. */
  target?: string;
  targetKind?: 'dir' | 'file' | 'missing';
  /** A link that leaves the site's folder, like a shared core's wp-admin: read only. */
  outside?: true;
  /** One of the panel's two mu-plugins, or the top folder of a git repo. */
  note?: 'panel' | 'repo';
}

export interface FileShortcut {
  label: string;
  path: string;
  kind: 'dir' | 'file';
}

export interface FileListing {
  /** The folder listed, relative to the site's folder. */
  dir: string;
  /** The site's folder on disk, for Copy path. */
  root: string;
  entries: FileEntry[];
  /** Entries left out of a very long folder. */
  more: number;
  writable: boolean;
  /** Why nothing here can change: the folder is outside the site's own (a shared core). */
  readOnly?: string;
  /** Places of this site worth one click: wp-content, themes, each repo, debug.log. */
  shortcuts: FileShortcut[];
}

/** The image types shown as they are; everything else is text or a download. */
export const FILE_IMAGE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A file larger than this is not opened as text. */
export const FILE_TEXT_MAX = 2 * 1024 * 1024;

export interface FileView {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  mode: string;
  writable: boolean;
  readOnly?: string;
  /** text: opened here. image: shown. binary and large: facts and Download. */
  kind: 'text' | 'image' | 'binary' | 'large';
  text?: string;
  /** sha256 of the file as read, sent back with a save so a change on disk since is noticed. */
  hash?: string;
  eol?: 'lf' | 'crlf';
  note?: 'panel';
}

/** A path inside a site's folder as the Files tab sends it: no leading slash, no dot folders that climb, no control characters. */
export function isSitePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 4096) return false;
  if (path === '') return true;
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255);
}

/** The folder a path is in ('' for the site's folder) and its last name. */
export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** A file or folder name on its own: no slash, not a dot folder that climbs, no control characters. */
export function isFileName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[\u0000-\u001f\u007f\\/]/.test(name) && name.trim() === name;
}

/** What a save answers when the file is not the one the editor opened any more. */
export const FILE_CHANGED = 'The file changed on disk since you opened it';

/** Most that one delete moves to the file trash; more than this is left to a terminal. */
export const FILE_TRASH_MAX = 1024 * 1024 * 1024;
/** Deleted files are kept this many days. */
export const FILE_TRASH_DAYS = 14;

/** One delete from the Files tab that can still be put back. */
export interface FileTrashEntry {
  /** 20261110-091500-a1b2c3 */
  id: string;
  deletedAt: string;
  /** What was deleted, as paths in the site's folder. */
  items: string[];
  sizeBytes: number;
  /** Why it is here when not a plain delete: a file a newer one replaced. */
  reason?: 'replaced';
}

export const isFileTrashId = (id: unknown): id is string => typeof id === 'string' && /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id);

/** Most matches one search of the Files tab lists. */
export const FILE_FIND_MAX = 200;

/** One match of a search under a folder: an entry by its name, or a line of a file. */
export interface FileMatch {
  /** Relative to the site's folder. */
  path: string;
  kind: 'file' | 'dir';
  line?: number;
  /** The line that matched, cut when it is very long. */
  text?: string;
}

export interface FileFindResult {
  matches: FileMatch[];
  /** There is more than is listed: the search stopped at its limit. */
  more: boolean;
}

/** What git says about an entry. A folder is modified when something in it changed. */
export type FileGitState = 'modified' | 'new' | 'added' | 'deleted' | 'renamed' | 'conflict';

export interface FileGitStatus {
  /** The repo the folder is in, relative to the site's folder ('' is the folder itself); absent outside a repo. */
  repo?: string;
  branch?: string;
  /** By the entry's name in the folder asked about. */
  entries: Record<string, FileGitState>;
}

/** The permissions the Files tab sets: a short list, never a number typed by hand. */
export const FILE_MODES = ['644', '640', '600', '755', '750'] as const;
export type FileMode = (typeof FILE_MODES)[number];
/** What each one means, in words. */
export const FILE_MODE_WORDS: Readonly<Record<FileMode, string>> = {
  '644': 'you write, everyone reads',
  '640': 'you write, your group reads',
  '600': 'only you read and write',
  '755': 'you write, everyone reads and opens or runs it',
  '750': 'you write, your group reads and opens or runs it',
};
/** A folder needs one of these: without the last bit nobody can open it. */
export const FOLDER_MODES: readonly FileMode[] = ['755', '750'];

export interface FileSize {
  /** What a folder holds, in bytes, everything below it counted. */
  bytes: number;
}

/** A diff longer than this is cut. */
export const FILE_DIFF_MAX = 400_000;

export interface FileDiff {
  /** A unified diff; empty when the two are the same. */
  diff: string;
  cut: boolean;
}

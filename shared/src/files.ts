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

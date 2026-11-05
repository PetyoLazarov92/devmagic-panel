import type { FolderEntry, FolderListing } from '@devmagic-panel/shared';

/**
 * The Developer options' file lists as folders you open: the paths a list
 * names, grouped under the listed folders they sit in, with what each folder
 * holds on disk read when you open it.
 */

/** A path a list names, with what it says about it. */
export interface ListedPath {
  path: string;
  kind: string;
  exists: boolean;
  note: string;
  sizeBytes?: number;
  onUninstall?: 'remove' | 'ask' | 'keep';
}

/** One row: a listed path, an entry read from disk, or both. */
export interface TreeNode {
  path: string;
  name: string;
  folder: boolean;
  listed?: ListedPath;
  entry?: FolderEntry;
}

const absolute = (path: string) => path.startsWith('/');
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** The top rows: every listed path not inside a listed folder, in the list's order. Only a folder that is there opens. */
export function topRows(listed: ListedPath[]): TreeNode[] {
  const folders = listed.filter((l) => l.kind === 'dir' && absolute(l.path)).map((l) => l.path);
  return listed
    .filter((l) => !(absolute(l.path) && folders.some((f) => f !== l.path && l.path.startsWith(`${f}/`))))
    .map((l) => ({ path: l.path, name: l.path, folder: l.kind === 'dir' && l.exists && absolute(l.path), listed: l }));
}

/**
 * An open folder's rows, folders first: what it holds on disk, each with what
 * the list says about it, and the listed paths the disk listing leaves out (a
 * folder the panel cannot read, one gone, or past the listing's cap).
 */
export function childRows(folder: string, listed: ListedPath[], listing: FolderListing | undefined): TreeNode[] {
  const rows = new Map<string, TreeNode>();
  for (const entry of listing?.entries ?? []) {
    const path = `${folder}/${entry.name}`;
    const own = listed.find((l) => l.path === path);
    rows.set(entry.name, { path, name: entry.name, folder: entry.kind === 'dir' || (entry.kind === 'link' && entry.targetKind === 'dir'), entry, ...(own ? { listed: own } : {}) });
  }
  for (const l of listed) {
    if (!absolute(l.path) || !l.path.startsWith(`${folder}/`)) continue;
    const name = l.path.slice(folder.length + 1).split('/')[0] as string;
    if (rows.has(name)) continue;
    const path = `${folder}/${name}`;
    rows.set(name, path === l.path ? { path, name, folder: l.kind === 'dir' && l.exists, listed: l } : { path, name, folder: true });
  }
  return [...rows.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
}

/** Expand all: the top folders and every folder on the way to a listed path, so the whole list shows. */
export function foldersShowingAll(listed: ListedPath[]): string[] {
  const tops = topRows(listed).filter((r) => r.folder).map((r) => r.path);
  const open = new Set(tops);
  for (const l of listed) {
    const top = tops.find((t) => l.path.startsWith(`${t}/`));
    if (!top) continue;
    for (let p = parentOf(l.path); p.length > top.length; p = parentOf(p)) open.add(p);
  }
  return [...open];
}

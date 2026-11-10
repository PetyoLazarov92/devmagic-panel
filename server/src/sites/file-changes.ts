import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FILE_CHANGED, FILE_TRASH_DAYS, FILE_TRASH_MAX, type FileTrashEntry, isFileName, isFileTrashId, isSitePath, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { FileRefused, type FilesContext, hashOf, isText, locate } from './files.js';

/**
 * What the Files tab changes: a file's text, a new file or folder, a name, a
 * place, a copy, a delete. All as you, never as root, and only in the site's
 * own folder: a link is renamed, moved or deleted as the link it is, and a
 * write never goes through one that leaves the folder. A delete moves the
 * files to the panel's file trash, where they stay 14 days.
 */

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export const why = (error: unknown, what: string): string => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return `you may not change ${what}: it belongs to another account (often the web server's)`;
  if (code === 'ENOENT') return `${what} is not there any more`;
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return `${what} is already there`;
  if (code === 'ENOSPC') return 'the disk is full';
  return (error as Error).message;
};

interface Entry {
  /** The folder it is in, after links are followed. */
  dir: string;
  /** The entry itself; a link stays a link. */
  full: string;
  name: string;
}

/** An entry of the site's own folder, by the folder it is in: the entry itself is never followed. */
export function entryAt(ctx: FilesContext, rel: string): Entry {
  if (!isSitePath(rel) || rel === '') throw new FileRefused('Give a file or folder inside the site');
  const dir = locate(ctx, parentOf(rel));
  if (!dir.inside) throw new FileRefused(`${rel} is part of a shared WordPress core, outside the site: it is read only here`);
  const name = nameOf(rel);
  return { dir: dir.real, full: join(dir.real, name), name };
}

export const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** An entry that is there. */
export function present(ctx: FilesContext, rel: string): Entry {
  const entry = entryAt(ctx, rel);
  if (!exists(entry.full)) throw new FileRefused(`${rel} is not there any more`);
  return entry;
}

/** A folder of the site's own to put things in. */
export function folderAt(ctx: FilesContext, rel: string): string {
  const dir = locate(ctx, rel);
  if (!dir.inside) throw new FileRefused(`${rel || 'That folder'} is part of a shared WordPress core, outside the site: it is read only here`);
  if (!statSync(dir.real).isDirectory()) throw new FileRefused(`${rel} is not a folder`);
  return dir.real;
}

export interface WriteInput {
  file: string;
  content: string;
  /** The hash the editor read; a file that differs now is not written. */
  hash?: string | undefined;
  /** Write even though the file changed on disk. */
  force?: boolean | undefined;
  eol?: 'lf' | 'crlf' | undefined;
}

/** Saves a file's text: a temp file next to it, then a rename, with the mode it had. Answers the new hash. */
export function writeFile(ctx: FilesContext, { file, content, hash, force, eol }: WriteInput): { hash: string } {
  const at = locate(ctx, file);
  if (!at.inside) throw new FileRefused(`${file} is part of a shared WordPress core, outside the site: it is read only here`);
  const st = statSync(at.real);
  if (!st.isFile()) throw new FileRefused(`${file} is not a file`);
  const before = readFileSync(at.real);
  if (!isText(before)) throw new FileRefused(`${file} is not text`);
  if (!force && hash !== undefined && hashOf(before) !== hash) throw new FileRefused(FILE_CHANGED);
  const text = eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : eol === 'lf' ? content.replace(/\r\n/g, '\n') : content;
  const bytes = Buffer.from(text, 'utf8');
  const temp = join(dirname(at.real), `.${nameOf(at.real)}.${randomBytes(4).toString('hex')}.dmp-tmp`);
  try {
    writeFileSync(temp, bytes, { mode: st.mode & 0o7777, flag: 'wx' });
    // The mode as it was, whatever the umask made of it.
    chmodSync(temp, st.mode & 0o7777);
    renameSync(temp, at.real);
  } catch (error) {
    rmSync(temp, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw new FileRefused(why(error, file));
    // A folder you may not add to, with a file you may write: in place then.
    try {
      writeFileSync(at.real, bytes);
    } catch (inner) {
      throw new FileRefused(why(inner, file));
    }
  }
  return { hash: hashOf(bytes) };
}

/** A new empty file or folder. */
export function createEntry(ctx: FilesContext, dir: string, name: string, kind: 'file' | 'dir'): string {
  if (!isFileName(name)) throw new FileRefused('Give a name without slashes');
  const folder = folderAt(ctx, dir);
  const full = join(folder, name);
  const rel = joinPath(dir, name);
  if (exists(full)) throw new FileRefused(`${rel} is already there`);
  try {
    if (kind === 'dir') mkdirSync(full);
    else writeFileSync(full, '', { flag: 'wx' });
  } catch (error) {
    throw new FileRefused(why(error, rel));
  }
  return rel;
}

/** Another name in the same folder. */
export function renameEntry(ctx: FilesContext, rel: string, name: string): string {
  if (!isFileName(name)) throw new FileRefused('Give a name without slashes');
  const entry = present(ctx, rel);
  const to = join(entry.dir, name);
  const renamed = joinPath(parentOf(rel), name);
  if (exists(to)) throw new FileRefused(`${renamed} is already there`);
  try {
    renameSync(entry.full, to);
  } catch (error) {
    throw new FileRefused(why(error, rel));
  }
  return renamed;
}

/** Each entry with the place it goes to in a folder, refused before anything moves. */
function placed(ctx: FilesContext, files: string[], to: string, freeName: boolean): Array<{ from: Entry; rel: string; target: string; targetRel: string }> {
  const folder = folderAt(ctx, to);
  return files.map((rel) => {
    const from = present(ctx, rel);
    if (from.full === folder || within(folder, from.full)) throw new FileRefused(`${rel} cannot go into itself`);
    let name = from.name;
    if (exists(join(folder, name))) {
      if (!freeName) throw new FileRefused(`${joinPath(to, name)} is already there`);
      name = copyName(folder, name);
    }
    return { from, rel, target: join(folder, name), targetRel: joinPath(to, name) };
  });
}

/** theme.json, then theme copy.json, theme copy 2.json: the first that is free. */
export function copyName(folder: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`;
    if (!exists(join(folder, candidate))) return candidate;
  }
  throw new FileRefused(`too many copies of ${name}`);
}

/** Moves entries into another folder of the site. */
export function moveEntries(ctx: FilesContext, files: string[], to: string): string[] {
  const moves = placed(ctx, files, to, false);
  for (const move of moves) {
    try {
      renameSync(move.from.full, move.target);
    } catch (error) {
      throw new FileRefused((error as NodeJS.ErrnoException).code === 'EXDEV' ? `${move.rel} and ${to || 'the site folder'} are on different disks: move it in a terminal` : why(error, move.rel));
    }
  }
  return moves.map((m) => m.targetRel);
}

/** How much an entry holds, stopped once it passes the most allowed. */
export function sizeOf(path: string, max = Number.POSITIVE_INFINITY): { bytes: number; files: number } {
  const total = { bytes: 0, files: 0 };
  const walk = (at: string) => {
    const st = lstatSync(at);
    total.files += 1;
    if (!st.isDirectory()) {
      total.bytes += st.size;
      return;
    }
    for (const name of readdirSync(at)) {
      if (total.bytes > max) return;
      walk(join(at, name));
    }
  };
  walk(path);
  return total;
}

/** Copies entries into a folder of the site; a copy next to its original gets a name of its own. Links are copied as links. */
export async function copyEntries(ctx: FilesContext, files: string[], to: string): Promise<string[]> {
  const copies = placed(ctx, files, to, true);
  let bytes = 0;
  for (const copy of copies) {
    bytes += sizeOf(copy.from.full, FILE_TRASH_MAX).bytes;
    if (bytes > FILE_TRASH_MAX) throw new FileRefused('That is more than 1 GB: copy it in a terminal');
  }
  for (const copy of copies) {
    try {
      await cp(copy.from.full, copy.target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    } catch (error) {
      throw new FileRefused(why(error, copy.rel));
    }
  }
  return copies.map((c) => c.targetRel);
}

// The file trash: <dataDir>/file-trash/<id>/entry.json and items/<n>, one folder per delete.

interface TrashRecord extends FileTrashEntry {
  /** The site it came from: local.shop.com, or local.shop.com/learn. */
  site: string;
}

export const fileTrashDir = (dataDir: string): string => join(dataDir, 'file-trash');
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

function readRecord(dir: string): TrashRecord | null {
  try {
    const record = JSON.parse(readFileSync(join(dir, 'entry.json'), 'utf8')) as TrashRecord;
    return isFileTrashId(record.id) && Array.isArray(record.items) && record.items.every((i) => isSitePath(i) && i !== '') ? record : null;
  } catch {
    return null;
  }
}

/** Moves an entry out of the site, copying when the trash is on another disk. */
export async function carry(from: string, to: string): Promise<void> {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/** Deletes entries: they go to the file trash, to be put back within 14 days. */
export async function deleteEntries(ctx: FilesContext, trash: string, site: string, files: string[], reason?: FileTrashEntry['reason'], now = new Date()): Promise<FileTrashEntry> {
  const entries = files.map((rel) => ({ rel, entry: present(ctx, rel) }));
  // A folder and something in it: the folder takes it along.
  const top = entries.filter(({ rel }) => !files.some((other) => other !== rel && rel.startsWith(`${other}/`)));
  let sizeBytes = 0;
  for (const { entry } of top) {
    sizeBytes += sizeOf(entry.full, FILE_TRASH_MAX).bytes;
    if (sizeBytes > FILE_TRASH_MAX) throw new FileRefused('That is more than 1 GB, too much to keep for Undo: delete it in a terminal');
  }
  const id = `${stamp(now)}-${randomBytes(3).toString('hex')}`;
  const dir = join(trash, id);
  mkdirSync(join(dir, 'items'), { recursive: true, mode: 0o700 });
  const record: TrashRecord = { id, site, deletedAt: now.toISOString(), items: [], sizeBytes, ...(reason ? { reason } : {}) };
  try {
    for (const { rel, entry } of top) {
      try {
        await carry(entry.full, join(dir, 'items', String(record.items.length)));
      } catch (error) {
        throw new FileRefused(why(error, rel));
      }
      record.items.push(rel);
    }
  } finally {
    // What moved is recorded, also when a later one failed, so it can be put back.
    if (record.items.length) writeFileSync(join(dir, 'entry.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    else rmSync(dir, { recursive: true, force: true });
  }
  const { site: _site, ...entry } = record;
  return entry;
}

/** What can still be put back for a site, newest first. */
export function listFileTrash(trash: string, site: string): FileTrashEntry[] {
  let names: string[];
  try {
    names = readdirSync(trash);
  } catch {
    return [];
  }
  return names
    .filter(isFileTrashId)
    .map((name) => readRecord(join(trash, name)))
    .filter((r): r is TrashRecord => r !== null && r.site === site)
    .map(({ site: _site, ...entry }) => entry)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** Puts a delete back where it was. Something that took its place in the meantime stays, and so does the deleted one, in the trash. */
export async function restoreEntries(ctx: FilesContext, trash: string, site: string, id: string): Promise<string[]> {
  if (!isFileTrashId(id)) throw new FileRefused('No such delete');
  const dir = join(trash, id);
  const record = readRecord(dir);
  if (!record || record.site !== site) throw new FileRefused('That delete is not kept any more');
  const root = realpathSync(ctx.root);
  const back: string[] = [];
  const left: string[] = [];
  const kept: Array<{ rel: string; index: number }> = [];
  for (const [index, rel] of record.items.entries()) {
    const from = join(dir, 'items', String(index));
    if (!exists(from)) continue;
    const target = join(root, rel);
    // The folder it was in, made again when it is gone, and still the site's own.
    let parent = dirname(target);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!within(realpathSync(parent), root)) throw new FileRefused(`${rel} would land outside the site's folder`);
    if (exists(target)) {
      left.push(rel);
      kept.push({ rel, index });
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      await carry(from, target);
    } catch (error) {
      throw new FileRefused(why(error, rel));
    }
    back.push(rel);
  }
  if (kept.length === 0) rmSync(dir, { recursive: true, force: true });
  if (left.length) throw new FileRefused(`${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} there again: rename or delete ${left.length === 1 ? 'it' : 'them'} first${back.length ? `. Put back: ${back.join(', ')}` : ''}`);
  return back;
}

/** Removes deletes older than 14 days. */
export function pruneFileTrash(trash: string, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(trash);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const name of names.filter(isFileTrashId)) {
    const dir = join(trash, name);
    const at = Date.parse(readRecord(dir)?.deletedAt ?? '') || statSync(dir).mtimeMs;
    if (now - at < FILE_TRASH_DAYS * 86_400_000) continue;
    rmSync(dir, { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
}

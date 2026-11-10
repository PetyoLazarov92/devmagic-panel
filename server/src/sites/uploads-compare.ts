import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FILE_TRASH_MAX, isUploadsFolder, RESIZED_COPY, splitSshHost, UPLOADS_LISTED, uploadsFolderOf, type UploadsCompare, type UploadsFolder, type UploadsHere } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import { formatBytes } from './db.js';
import { keepReplaced } from './file-changes.js';
import { MoreDumpsRefused } from './more-dumps.js';
import type { ServerSource } from './server-files.js';
import { ROOM_TO_SPARE, rsyncProblem, rsyncSsh, serverUploadsDir, transferred, UPLOADS_LEFT_OUT, uploadsTarget } from './server-uploads.js';
import { freeSpace } from './space.js';

/**
 * Uploads from production, compared before anything is copied: rsync lists
 * what the server's uploads hold (a read: no dry run of a copy, nothing
 * written there), the panel walks what is here, and the two are compared
 * folder by folder. A copy then names its files one by one, the ones the
 * comparison found, so what comes is what the view showed.
 *
 * Here a copy only adds. Files that changed on production come only when
 * asked for, and the local ones go to the file trash first, for Undo.
 */

/** Where the panel's database notes a site's last copy of uploads that finished. */
export const uploadsCopied = (site: string): string => `uploads-copy:${site}`;

export interface Listed {
  file: string;
  bytes: number;
  /** Last change, in milliseconds. */
  mtime: number;
}

/** A file's line of rsync --list-only: its kind and rights, size, date, time and name. Folders and links have another first letter. */
const LINE = /^-\S+\s+(\d+) (\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d) (.+)$/;

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
const LEFT_FOLDERS = UPLOADS_LEFT_OUT.filter((p) => p.startsWith('/')).map((p) => glob(p.slice(1, -1)));
const LEFT_NAMES = UPLOADS_LEFT_OUT.filter((p) => !p.startsWith('/')).map(glob);

/** Whether a file of uploads is one the copy leaves on the server: code, Apache rules, dumps, and plugins' cache, log and backup folders. */
export function leftOut(file: string): boolean {
  const parts = file.split('/');
  return (parts.length > 1 && LEFT_FOLDERS.some((r) => r.test(parts[0] as string))) || LEFT_NAMES.some((r) => r.test(parts.at(-1) as string));
}

/** A name the copy can ask for: inside uploads, and printed by rsync as it is (it escapes odd bytes as \#012). */
const plain = (file: string) => !file.startsWith('/') && !file.split('/').some((p) => p === '' || p === '.' || p === '..') && !/\\#\d{3}/.test(file);

/** The files of rsync's listing, in the time zone this machine prints them in. */
export function parseListing(stdout: string): Listed[] {
  const out: Listed[] = [];
  for (const line of stdout.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const file = m[8] as string;
    if (!plain(file) || leftOut(file)) continue;
    out.push({ file, bytes: Number(m[1]), mtime: new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime() });
  }
  return out;
}

/** Every file under a folder here, without links, by its path in it. */
export function walkLocal(dir: string): Map<string, { bytes: number; mtime: number }> {
  const out = new Map<string, { bytes: number; mtime: number }>();
  const walk = (at: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), path);
      else if (entry.isFile()) {
        const stat = lstatSync(join(at, entry.name), { throwIfNoEntry: false });
        if (stat) out.set(path, { bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** What the site has in wp-content/uploads here. */
export function uploadsHere(docroot: string): Omit<UploadsHere, 'last'> {
  const target = uploadsTarget(docroot);
  if ('problem' in target) return { exists: false, files: 0, bytes: 0, freeBytes: freeSpace(docroot).bytes };
  let bytes = 0;
  const local = walkLocal(target.local);
  for (const f of local.values()) bytes += f.bytes;
  return { exists: local.size > 0 || lstatSync(target.local, { throwIfNoEntry: false }) !== undefined, files: local.size, bytes, freeBytes: freeSpace(target.content).bytes };
}

/** The server's uploads as rsync lists them. Read only. */
export async function listServerUploads(exec: Executor, src: ServerSource, dir: string, signal?: AbortSignal): Promise<Listed[]> {
  const parts = splitSshHost(src.host);
  if (!parts) throw new MoreDumpsRefused(`${src.host} is not an ssh alias or user@host`);
  const r = await exec(
    'rsync',
    ['--list-only', '--recursive', '--no-links', '--no-h', '--8-bit-output', '--timeout=120', ...UPLOADS_LEFT_OUT.map((p) => `--exclude=${p}`), '-e', rsyncSsh(parts.port), '--', `${parts.host}:${dir}/`],
    { timeoutMs: 30 * 60_000, maxBufferBytes: 512 * 1024 ** 2, ...(signal ? { signal } : {}) },
  );
  // 23 and 24: a file it could not read, or one that went away while it listed; the rest is still the list.
  if (r.code !== 0 && r.code !== 23 && r.code !== 24) {
    throw new MoreDumpsRefused(/No such file or directory/i.test(r.stderr) ? `${src.host} has no ${dir}` : rsyncProblem(src.host, r));
  }
  return parseListing(r.stdout);
}

export interface UploadsRead {
  dir: string;
  server: Listed[];
  local: Map<string, { bytes: number; mtime: number }>;
  content: string;
  localDir: string;
}

/** Both sides, read: the server's uploads and the ones here. */
export async function readUploads(exec: Executor, docroot: string, src: ServerSource, signal?: AbortSignal): Promise<UploadsRead> {
  const target = uploadsTarget(docroot);
  if ('problem' in target) throw new MoreDumpsRefused(target.problem);
  const dir = await serverUploadsDir(exec, src);
  const server = await listServerUploads(exec, src, dir, signal);
  return { dir, server, local: walkLocal(target.local), content: target.content, localDir: target.local };
}

/** Newer on the server by more than a second, which is how exact a file's time is everywhere. */
const newer = (server: Listed, local: { mtime: number }) => server.mtime > local.mtime + 1000;

/** The comparison as the view shows it: each folder with what is new in it, what changed, and what is only here. */
export function summarize(read: UploadsRead, host: string): UploadsCompare {
  const folders = new Map<string, UploadsFolder>();
  const unusual = new Set<string>();
  const changed: Listed[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of read.server) {
    seen.add(f.file);
    bytes += f.bytes;
    const { key, kind, site } = uploadsFolderOf(f.file);
    if (!isUploadsFolder(key)) {
      unusual.add(key);
      continue;
    }
    let folder = folders.get(key);
    if (!folder) {
      folder = { key, kind, ...(site === undefined ? {} : { site }), files: 0, bytes: 0, newFiles: 0, newBytes: 0, newResizedFiles: 0, newResizedBytes: 0, changedFiles: 0, changedBytes: 0 };
      folders.set(key, folder);
    }
    folder.files += 1;
    folder.bytes += f.bytes;
    const here = read.local.get(f.file);
    if (!here) {
      folder.newFiles += 1;
      folder.newBytes += f.bytes;
      if (RESIZED_COPY.test(f.file)) {
        folder.newResizedFiles += 1;
        folder.newResizedBytes += f.bytes;
      }
    } else if (newer(f, here)) {
      folder.changedFiles += 1;
      folder.changedBytes += f.bytes;
      changed.push(f);
    }
  }
  const onlyHere = [...read.local.keys()].filter((file) => !seen.has(file) && !leftOut(file)).sort();
  changed.sort((a, b) => b.mtime - a.mtime);
  return {
    host,
    dir: read.dir,
    files: read.server.length,
    bytes,
    // Months newest first, then the rest by name.
    folders: [...folders.values()].sort((a, b) => (a.site ?? 0) - (b.site ?? 0) || (a.kind === 'media' && b.kind === 'media' ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key))),
    changed: changed.slice(0, UPLOADS_LISTED).map((f) => ({ file: f.file, bytes: f.bytes, changedAt: new Date(f.mtime).toISOString() })),
    changedFiles: changed.length,
    onlyHere: onlyHere.slice(0, UPLOADS_LISTED),
    onlyHereFiles: onlyHere.length,
    unusual: unusual.size,
    freeBytes: freeSpace(read.content).bytes,
  };
}

/** What a site's own server has in uploads next to what is here. Read only, on both sides. */
export async function compareUploads(exec: Executor, docroot: string, src: ServerSource): Promise<UploadsCompare> {
  return summarize(await readUploads(exec, docroot, src), src.host);
}

export interface UploadsChoice {
  folders: readonly string[];
  maxFileMb?: number | undefined;
  originalsOnly?: boolean | undefined;
  changed?: boolean | undefined;
}

/** The files a choice brings: the new ones in its folders, and with changed the ones newer on the server. */
export function chosen(read: UploadsRead, choice: UploadsChoice): { fresh: Listed[]; changed: Listed[] } {
  const folders = new Set(choice.folders);
  const most = choice.maxFileMb ? choice.maxFileMb * 1024 ** 2 : Infinity;
  const fresh: Listed[] = [];
  const changed: Listed[] = [];
  for (const f of read.server) {
    if (!folders.has(uploadsFolderOf(f.file).key) || f.bytes > most) continue;
    const here = read.local.get(f.file);
    if (!here) {
      if (!(choice.originalsOnly && RESIZED_COPY.test(f.file))) fresh.push(f);
    } else if (choice.changed && newer(f, here)) changed.push(f);
  }
  return { fresh, changed };
}

/** Most files one run replaces: each is kept for Undo, one by one. */
export const REPLACED_MAX = 2000;

export interface ChosenCopy {
  /** The file trash, the site's name in it, and the site's folder: where a replaced file is kept and how it is named. */
  trash: string;
  site: string;
  root: string;
  /** Stops rsync when it aborts; what came so far stays. */
  signal?: AbortSignal;
  progress?: (fraction: number, note: string) => void;
  now?: Date;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
const count = (n: number, word = 'file') => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * Copies the folders you chose in the Uploads from production view. It
 * compares again first, so it brings what is new now, names each file to
 * rsync, and refuses when they would not fit on this disk. One step's work,
 * with an executor that signs in.
 */
export async function copyChosenUploads(exec: Executor, docroot: string, src: ServerSource, choice: UploadsChoice, deps: ChosenCopy): Promise<ExecResult[]> {
  const parts = splitSshHost(src.host);
  if (!parts) return [fail(`${src.host} is not an ssh alias or user@host`)];
  let read: UploadsRead;
  try {
    read = await readUploads(exec, docroot, src, deps.signal);
  } catch (error) {
    if (deps.signal?.aborted) return [fail('stopped before anything was copied')];
    if (error instanceof MoreDumpsRefused) return [fail(error.message)];
    throw error;
  }
  const { fresh, changed } = chosen(read, choice);
  const sum = (list: readonly Listed[]) => list.reduce((n, f) => n + f.bytes, 0);
  const results: ExecResult[] = [ok(`${src.host} has ${count(read.server.length)} in ${read.dir}; ${count(fresh.length)} of the folders you chose ${fresh.length === 1 ? 'is' : 'are'} not here yet (${formatBytes(sum(fresh))})`)];
  if (fresh.length === 0 && changed.length === 0) return [...results, ok('nothing to bring: what you chose is here already')];

  const free = freeSpace(read.content).bytes;
  if (sum(fresh) + sum(changed) + ROOM_TO_SPARE > free) {
    return [...results, fail(`that is ${formatBytes(sum(fresh) + sum(changed))} and this disk has ${formatBytes(free)} free: not copied. Choose fewer folders, or make room`)];
  }
  // The uploads folder as the file trash names it: its path in the site's folder.
  let prefix = '';
  if (changed.length) {
    const replacedBytes = changed.reduce((n, f) => n + (read.local.get(f.file)?.bytes ?? 0), 0);
    if (changed.length > REPLACED_MAX || replacedBytes > FILE_TRASH_MAX) {
      return [...results, fail(`${count(changed.length)} changed on production (${formatBytes(replacedBytes)} here): more than is kept for Undo, so nothing was copied. Choose fewer folders, or leave the changed files out`)];
    }
    mkdirSync(read.localDir, { recursive: true });
    prefix = relative(realpathSync(deps.root), realpathSync(read.localDir)).split(sep).join('/');
    if (prefix === '' || prefix.startsWith('..')) return [...results, fail('wp-content/uploads is not in the site\'s folder, so a replaced file could not be kept for Undo: nothing was copied')];
  }
  mkdirSync(read.localDir, { recursive: true });

  const base = ['--times', '--partial', '--no-links', '--no-perms', '--no-owner', '--no-group', '--chmod=D755,F644', '--timeout=120', '--stats', '--info=progress2'];
  // The names go to rsync on its stdin, each ended by a zero byte, so no name is read as an option or a pattern.
  const run = (list: readonly Listed[], more: string[], label: string) => {
    let done = 0;
    return exec('rsync', [...base, ...more, ...UPLOADS_LEFT_OUT.filter((p) => !p.startsWith('/')).map((p) => `--exclude=${p}`), '--from0', '--files-from=-', '-e', rsyncSsh(parts.port), '--', `${parts.host}:${read.dir}/`, `${read.localDir}/`], {
      input: list.map((f) => `${f.file}\0`).join(''),
      timeoutMs: 6 * 60 * 60_000,
      maxBufferBytes: 256 * 1024 ** 2,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onStdout: (chunk) => {
        const at = [...chunk.matchAll(/xfr#(\d+)/g)].at(-1)?.[1];
        if (!at || Number(at) <= done) return;
        done = Number(at);
        deps.progress?.(Math.min(1, done / list.length), `${label}: ${done.toLocaleString('en-US')} of ${list.length.toLocaleString('en-US')}`);
      },
    });
  };
  // 23 and 24: some files could not be read there, or went away since the comparison; the others came.
  const partly = (r: ExecResult) => r.code === 23 || r.code === 24;
  const stopped = () => deps.signal?.aborted === true;

  if (fresh.length) {
    const r = await run(fresh, ['--ignore-existing'], 'New files');
    if (stopped()) return [...results, fail('stopped: what came so far is kept, and a new run brings the rest')];
    if (r.code !== 0 && !partly(r)) return [...results, fail(rsyncProblem(src.host, r))];
    const { files, bytes } = transferred(r.stdout);
    results.push(ok(`copied ${files ?? 'the new'} file${files === '1' ? '' : 's'}${Number.isFinite(bytes) && bytes > 0 ? ` (${formatBytes(bytes)})` : ''} into wp-content/uploads; files that were here already were left as they are, and nothing was written on ${src.host}`));
    if (partly(r)) results.push(ok(`some files could not be read on ${src.host} or are gone there since the comparison; they were skipped`));
  }
  if (changed.length) {
    let r: ExecResult | undefined;
    const kept = await keepReplaced(deps.trash, deps.site, prefix, async (backup) => {
      r = await run(changed, ['--update', '--backup', `--backup-dir=${backup}`], 'Changed files');
    }, deps.now);
    if (stopped()) return [...results, fail(`stopped${kept ? `: ${count(kept.items.length)} replaced so far ${kept.items.length === 1 ? 'is' : 'are'} kept under Changes you can undo` : ''}`)];
    if (!r || (r.code !== 0 && !partly(r))) return [...results, fail(r ? rsyncProblem(src.host, r) : 'rsync did not run')];
    results.push(ok(kept
      ? `brought ${count(kept.items.length)} that changed on production; the ones they replaced are kept for 14 days under Changes you can undo`
      : 'no file that changed on production was brought: the ones here are as new'));
  }
  results.push(ok('left on the server: PHP files, .htaccess, SQL dumps, links, and the cache, log and backup folders of plugins'));
  return results;
}

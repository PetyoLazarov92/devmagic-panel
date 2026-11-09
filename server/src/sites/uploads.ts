import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Executor } from '../exec.js';
import { analyzeDump, sqlFileFor, type DumpFacts } from './dump.js';
import { checkDumpFile, DumpTypeError } from './dump-type.js';

export { DumpTypeError };

/**
 * Database dumps uploaded for the new site wizard, kept in the panel's data
 * folder (readable only by the panel user) until the install that uses them
 * succeeds.
 */
export interface UploadInfo {
  id: string;
  name: string;
  size: number;
  facts: DumpFacts;
}

export const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;

/**
 * How the dump scan reads a dump; an upload read by an older scan is read
 * again before its facts are used. 2: MariaDB's one row per line, and the
 * main site's tables told from a network's subsites. 3: the hosts it has
 * http:// links for, read to the end of the dump. 4: the hosts each table
 * has, so search and replace can leave out the tables without them. 5:
 * whether it makes views, triggers or routines, which decides whether an
 * import can go through a side database. 6: every plugin the dump names, by
 * file, with its version and WordPress.org slug from the update check.
 */
export const DUMP_SCAN_VERSION = 6;
/** A dump no job needs goes after a day: a wizard left half way, or one uploaded again. */
export const UPLOAD_KEEP_MS = 24 * 3_600_000;
const EXTENSIONS = ['.sql', '.sql.gz', '.zip'];

export class UploadError extends Error {}

export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.-]+/g, '_').slice(-120);
  if (!EXTENSIONS.some((ext) => clean.toLowerCase().endsWith(ext))) {
    throw new UploadError('Upload a .sql, .sql.gz or .zip dump');
  }
  return clean;
}

const dirFor = (uploadsDir: string, id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new UploadError('unknown upload');
  return join(uploadsDir, id);
};

/** Streams the request body to disk, enforcing the size limit, then reads its facts. */
export async function saveUpload(
  exec: Executor,
  uploadsDir: string,
  name: string,
  body: NodeJS.ReadableStream,
  limit = MAX_UPLOAD_BYTES,
): Promise<UploadInfo> {
  const fileName = cleanName(name);
  const id = randomUUID();
  const dir = dirFor(uploadsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, fileName);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > limit) done(new UploadError(`The dump is larger than ${Math.round(limit / 1024 ** 3)} GB`));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(file, { mode: 0o600 }));
    checkDumpFile(file, fileName);
    const sql = file.endsWith('.zip') ? await sqlFileFor(exec, file, dir) : file;
    const facts = await analyzeDump(sql);
    const info: UploadInfo = { id, name: fileName, size, facts };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...info, file, scanVersion: DUMP_SCAN_VERSION }), { mode: 0o600 });
    return info;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function readUpload(uploadsDir: string, id: string): (UploadInfo & { file: string; dir: string }) | null {
  const dir = dirFor(uploadsDir, id);
  const meta = join(dir, 'meta.json');
  if (!existsSync(meta)) return null;
  return { ...(JSON.parse(readFileSync(meta, 'utf8')) as UploadInfo & { file: string }), dir };
}

/** An upload with facts from the current dump scan: one an older scan read is read again, and its meta.json rewritten. */
export async function currentUpload(exec: Executor, uploadsDir: string, id: string): Promise<(UploadInfo & { file: string; dir: string }) | null> {
  const upload = readUpload(uploadsDir, id);
  if (!upload || (upload as { scanVersion?: number }).scanVersion === DUMP_SCAN_VERSION || !existsSync(upload.file)) return upload;
  const sql = upload.file.endsWith('.zip') ? await sqlFileFor(exec, upload.file, upload.dir) : upload.file;
  const facts = await analyzeDump(sql);
  const { dir, ...meta } = upload;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, facts, scanVersion: DUMP_SCAN_VERSION }), { mode: 0o600 });
  return { ...upload, facts };
}

export function removeUpload(uploadsDir: string, id: string): void {
  rmSync(dirFor(uploadsDir, id), { recursive: true, force: true });
}

/**
 * Removes dumps nothing needs any more: older than `maxAgeMs` and not used by
 * a job that may still read them (a running install, or a failed one waiting
 * for Retry). A wizard left half way leaves its dump here; this is where it goes.
 */
export function pruneUploads(uploadsDir: string, maxAgeMs: number, inUse: ReadonlySet<string>, now = Date.now()): string[] {
  if (!existsSync(uploadsDir)) return [];
  const removed: string[] = [];
  for (const id of readdirSync(uploadsDir)) {
    if (!/^[0-9a-f-]{36}$/.test(id) || inUse.has(id)) continue;
    const dir = join(uploadsDir, id);
    if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

/**
 * A dump that arrives another way than an upload, like a download from Google
 * Drive or a file in your Downloads folder: `put` writes it to the path it
 * gets, then its facts are read as for an upload. Nothing is left behind when
 * it fails.
 */
export async function adoptUpload(exec: Executor, uploadsDir: string, name: string, put: (file: string) => Promise<void>, onRead?: (fraction: number) => void): Promise<UploadInfo> {
  const fileName = cleanName(name);
  const id = randomUUID();
  const dir = dirFor(uploadsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, fileName);
  try {
    await put(file);
    const size = statSync(file).size;
    if (size > MAX_UPLOAD_BYTES) throw new UploadError(`The dump is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} GB`);
    checkDumpFile(file, fileName);
    const sql = file.endsWith('.zip') ? await sqlFileFor(exec, file, dir) : file;
    const facts = await analyzeDump(sql, onRead);
    const info: UploadInfo = { id, name: fileName, size, facts };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...info, file, scanVersion: DUMP_SCAN_VERSION }), { mode: 0o600 });
    return info;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Uploads and downloads a stopped panel left half way: a folder without its
 * meta.json. Run at start, when nothing can still be writing to one.
 */
export function removeUnfinishedUploads(uploadsDir: string): string[] {
  if (!existsSync(uploadsDir)) return [];
  const removed: string[] = [];
  for (const id of readdirSync(uploadsDir)) {
    if (!/^[0-9a-f-]{36}$/.test(id) || existsSync(join(uploadsDir, id, 'meta.json'))) continue;
    rmSync(join(uploadsDir, id), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FILE_TRASH_MAX, isFileName, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { exists, folderAt, present, sizeOf, why } from './file-changes.js';
import { FileRefused, type FilesContext } from './files.js';
import { dropLinks } from './server-files.js';

/**
 * The Files tab's files in and out of a site: uploads from the browser, a
 * folder or a selection downloaded as a zip, and archives packed and unpacked
 * in place. All as you, in the site's own folder, and nothing is ever written
 * over: an upload or an unpacked archive that meets a name that is taken is
 * refused or gets a free name.
 */

/** The most one upload, one zip or one unpacked archive may hold. */
export const TRANSFER_MAX = FILE_TRASH_MAX;
/** How long an upload waits for its action before housekeeping removes it. */
export const STAGED_KEEP_MS = 24 * 60 * 60 * 1000;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isStagedId = (id: string): boolean => STAGED_ID.test(id);

export const stagedDir = (dataDir: string): string => join(dataDir, 'file-uploads');

/** Streams one upload into the panel's own folder, where it waits for file.upload to place it. */
export async function stageUpload(dir: string, body: NodeJS.ReadableStream, limit = TRANSFER_MAX): Promise<{ id: string; sizeBytes: number }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const file = join(dir, id);
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sizeBytes += chunk.length;
      if (sizeBytes > limit) done(new FileRefused('That file is larger than 1 GB: copy it in a terminal'));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(file, { mode: 0o600 }));
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  return { id, sizeBytes };
}

/** Removes uploads that never reached a folder. */
export function pruneStaged(dir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const file = join(dir, name);
    if (now - statSync(file).mtimeMs < STAGED_KEEP_MS) continue;
    rmSync(file, { recursive: true, force: true });
    n += 1;
  }
  return n;
}

export interface PlaceOutcome {
  placed: string[];
  /** Names that are in the folder already: left as they are, the upload dropped. */
  taken: string[];
}

/** Puts staged uploads into a folder of the site, each under its name. A name that is taken stays as it is. */
export async function placeUploads(ctx: FilesContext, staged: string, dir: string, uploads: ReadonlyArray<{ id: string; name: string }>): Promise<PlaceOutcome> {
  const folder = folderAt(ctx, dir);
  const out: PlaceOutcome = { placed: [], taken: [] };
  for (const { id, name } of uploads) {
    if (!isStagedId(id) || !isFileName(name)) throw new FileRefused('That upload is not one of the Files tab');
    const from = join(staged, id);
    if (!exists(from)) throw new FileRefused(`The upload of ${name} is gone: send it again`);
    const target = join(folder, name);
    if (exists(target)) {
      out.taken.push(name);
      rmSync(from, { force: true });
      continue;
    }
    try {
      try {
        // A hard link fails when the name was taken meanwhile, so nothing is ever written over.
        linkSync(from, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await cp(from, target, { errorOnExist: true, force: false });
      }
      chmodSync(target, 0o644);
      unlinkSync(from);
      out.placed.push(joinPath(dir, name));
    } catch (error) {
      throw new FileRefused(`Could not put ${name} there: ${why(error, dir || 'the site folder')}`);
    }
  }
  return out;
}

/** The entries of one folder a zip is made of: their folder and their names. */
function sameFolder(ctx: FilesContext, files: readonly string[]): { dir: string; rel: string; names: string[] } {
  if (files.length === 0) throw new FileRefused('Name a file or folder');
  const rel = parentOf(files[0] as string);
  if (files.some((f) => parentOf(f) !== rel)) throw new FileRefused('The files of one zip are all in one folder');
  const entries = files.map((f) => present(ctx, f));
  let bytes = 0;
  for (const entry of entries) {
    bytes += sizeOf(entry.full, TRANSFER_MAX).bytes;
    if (bytes > TRANSFER_MAX) throw new FileRefused('That is more than 1 GB: pack it in a terminal');
  }
  return { dir: (entries[0] as { dir: string }).dir, rel, names: entries.map((e) => e.name) };
}

/** Runs zip in the folder: names only, links stored as links (never followed out of the site). */
async function zipInto(exec: Executor, cwd: string, names: readonly string[], target: string): Promise<void> {
  const result = await exec('zip', ['-r', '-q', '-y', target, '--', ...names], { cwd, timeoutMs: 10 * 60_000 });
  if (result.code === 127) throw new FileRefused('zip is not installed: sudo apt install zip');
  if (result.code !== 0) {
    rmSync(target, { force: true });
    throw new FileRefused(`zip could not pack that: ${(result.stderr || result.stdout).trim().split('\n').pop() ?? `exit ${result.code}`}`);
  }
}

/** A zip of entries of one folder, written to the panel's scratch folder for one download. The caller removes it. */
export async function zipForDownload(exec: Executor, ctx: FilesContext, scratch: string, files: readonly string[]): Promise<{ file: string; name: string }> {
  const { dir, rel, names } = sameFolder(ctx, files);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const file = join(scratch, `${randomUUID()}.zip`);
  await zipInto(exec, dir, names, file);
  return { file, name: `${zipStem(rel, names)}.zip` };
}

const zipStem = (rel: string, names: readonly string[]): string => (names.length === 1 ? (names[0] as string) : nameOf(rel) || 'files');

/** name, then name 2, name 3: the first that is free in the folder. */
export function freeName(folder: string, stem: string, ext = ''): string {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem}${n === 1 ? '' : ` ${n}`}${ext}`;
    if (!exists(join(folder, candidate))) return candidate;
  }
  throw new FileRefused(`too many entries called ${stem}${ext}`);
}

/** Packs entries of one folder into a zip next to them. Returns its path in the site. */
export async function compressEntries(exec: Executor, ctx: FilesContext, files: readonly string[]): Promise<string> {
  const { dir, rel, names } = sameFolder(ctx, files);
  const name = freeName(dir, zipStem(rel, names), '.zip');
  const temp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.dmp-tmp`);
  try {
    await zipInto(exec, dir, names, temp);
    linkSync(temp, join(dir, name));
  } catch (error) {
    if (error instanceof FileRefused) throw error;
    throw new FileRefused(`Could not make ${name}: ${why(error, rel || 'the site folder')}`);
  } finally {
    rmSync(temp, { force: true });
  }
  return joinPath(rel, name);
}

/** The archives the Files tab unpacks, by ending: what the folder is called without it, and how to read one. */
export function archiveKind(name: string): { stem: string; kind: 'zip' | 'tar' } | null {
  const m = /^(.+?)\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i.exec(name);
  if (!m) return null;
  return { stem: m[1] as string, kind: (m[2] as string).toLowerCase() === 'zip' ? 'zip' : 'tar' };
}

const leaves = (name: string): boolean => name.startsWith('/') || name.split('/').includes('..') || /[\0-\x1f]/.test(name);

/** unzip -Z1's names and unzip -Zs's listing: refuses a name that leaves the folder, an entry under a link and more than the cap. */
export function checkZip(names: string, listing: string, max = TRANSFER_MAX): string | null {
  const list = names.split('\n').filter((l) => l !== '');
  if (list.length === 0) return 'the archive is empty';
  const bad = list.find(leaves);
  if (bad) return `the archive holds ${bad.slice(0, 120)}, which leaves the folder it is unpacked into`;
  // A link's line starts with l and ends with its name, after the date and time.
  const links = listing.split('\n').flatMap((line) => {
    const m = /^l\S+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(line);
    return m ? [m[1] as string] : [];
  });
  const under = list.find((n) => links.some((l) => n.startsWith(`${l}/`)));
  if (under) return `the archive holds ${under.slice(0, 120)} under a link, which is not unpacked`;
  const m = /(\d+) bytes uncompressed/.exec(listing);
  if (!m) return 'the panel cannot read how large the archive is unpacked';
  if (Number(m[1]) > max) return 'it unpacks to more than 1 GB: unpack it in a terminal';
  return null;
}

/** tar --numeric-owner -tv's listing: refuses a hard link, a name that leaves the folder, an entry under a link, and more than the cap. */
export function checkTar(listing: string, max = TRANSFER_MAX): string | null {
  const lines = listing.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'the archive is empty';
  const links: string[] = [];
  const names: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const m = /^(\S)\S*\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s(.+)$/.exec(line);
    if (!m) return `the archive's listing has a line the panel cannot read: ${line.slice(0, 120)}`;
    const [, type, size, rest] = m as unknown as [string, string, string, string];
    if (type === 'h') return `the archive holds a hard link (${rest.slice(0, 120)}), which is not unpacked`;
    const name = (type === 'l' ? rest.split(' -> ')[0] ?? rest : rest).replace(/\/$/, '').replace(/^\.\//, '');
    if (leaves(name)) return `the archive holds ${name.slice(0, 120)}, which leaves the folder it is unpacked into`;
    if (type !== '-' && type !== 'd') links.push(name);
    names.push(name);
    bytes += Number(size);
    if (bytes > max) return 'it unpacks to more than 1 GB: unpack it in a terminal';
  }
  const under = names.find((n) => links.some((l) => n.startsWith(`${l}/`)));
  if (under) return `the archive holds ${under.slice(0, 120)} under a link, which is not unpacked`;
  return null;
}

const lastLine = (text: string) => text.trim().split('\n').pop() ?? '';

/**
 * Unpacks an archive of the site into a new folder next to it, named after
 * it. Its listing is checked first, links in it are dropped, and the folder
 * appears only once everything is unpacked.
 */
export async function extractArchive(exec: Executor, ctx: FilesContext, rel: string): Promise<{ folder: string; dropped: number }> {
  const entry = present(ctx, rel);
  const archive = archiveKind(entry.name);
  if (!archive || !lstatSync(entry.full).isFile()) throw new FileRefused('The Files tab unpacks zip, tar, tar.gz, tgz, tar.bz2 and tar.xz files');
  const refuse = (text: string): never => {
    throw new FileRefused(`${entry.name} was not unpacked: ${text}`);
  };
  const missing = (program: string) => refuse(`${program} is not installed: sudo apt install ${program}`);
  const opts = { cwd: entry.dir, timeoutMs: 10 * 60_000, maxBufferBytes: 64 * 1024 * 1024 };

  if (archive.kind === 'zip') {
    const names = await exec('unzip', ['-Z1', entry.full], opts);
    if (names.code === 127) missing('unzip');
    if (names.code !== 0) refuse(lastLine(names.stderr || names.stdout) || 'unzip cannot read it');
    const listing = await exec('unzip', ['-Zs', entry.full], opts);
    const problem = checkZip(names.stdout, listing.stdout);
    if (problem) refuse(problem);
  } else {
    const listing = await exec('tar', ['--numeric-owner', '-tvf', entry.full], opts);
    if (listing.code === 127) missing('tar');
    if (listing.code !== 0) refuse(lastLine(listing.stderr) || 'tar cannot read it');
    const problem = checkTar(listing.stdout);
    if (problem) refuse(problem);
  }

  const name = freeName(entry.dir, archive.stem);
  const temp = join(entry.dir, `.${name}.${randomBytes(4).toString('hex')}.dmp-tmp`);
  try {
    mkdirSync(temp, { mode: 0o755 });
  } catch (error) {
    refuse(why(error, parentOf(rel) || 'the site folder'));
  }
  try {
    const run = archive.kind === 'zip'
      ? await exec('unzip', ['-q', '-o', entry.full, '-d', temp], opts)
      : await exec('tar', ['-xf', entry.full, '-C', temp, '--no-same-owner', '--no-same-permissions'], opts);
    if (run.code !== 0) refuse(lastLine(run.stderr || run.stdout) || `exit ${run.code}`);
    const dropped = dropLinks(temp);
    renameSync(temp, join(entry.dir, name));
    return { folder: joinPath(parentOf(rel), name), dropped };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (error instanceof FileRefused) throw error;
    return refuse(why(error, name));
  }
}

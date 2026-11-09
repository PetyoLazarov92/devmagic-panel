import { randomUUID } from 'node:crypto';
import { copyFile, link } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { ActionInput } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { checkFreeSpace } from '../sites/create.js';
import { formatBytes, progressNote } from '../sites/db.js';
import { adoptUpload, MAX_UPLOAD_BYTES, removeUpload } from '../sites/uploads.js';
import { fetchDump, FetchRefused, type Getter, shownUrl } from '../sites/fetch-dump.js';

export class DumpRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const DUMP = /\.(?:sql|sql\.gz|zip)$/i;

/** The first Google Drive remote rclone has, like gdrive; null without rclone or one. */
export async function rcloneRemote(exec: Executor): Promise<{ installed: boolean; remote?: string }> {
  const r = await exec('rclone', ['listremotes', '--long'], { timeoutMs: 15_000 });
  if (r.code === 127) return { installed: false };
  const remote = r.code === 0 ? /^([A-Za-z0-9_. -]+?):\s+drive\s*$/m.exec(r.stdout)?.[1] : undefined;
  return { installed: true, ...(remote ? { remote } : {}) };
}

/** Your Downloads folder: the one your desktop names in user-dirs.dirs, else ~/Downloads. */
export function downloadsDir(home: string): string {
  try {
    const dirs = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const named = /^XDG_DOWNLOAD_DIR="(.+)"$/m.exec(dirs)?.[1]?.replace(/^\$HOME/, home);
    if (named?.startsWith('/') && existsSync(named)) return named;
  } catch {
    // no user-dirs.dirs
  }
  return join(home, 'Downloads');
}

/** Dumps in your Downloads folder from the last three days, newest first, for the browser fallback. */
export function recentDownloads(home: string, now = Date.now()): Array<{ file: string; name: string; sizeBytes: number; modifiedAt: string }> {
  const dir = downloadsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => DUMP.test(n))
    .flatMap((name) => {
      try {
        const st = statSync(join(dir, name));
        return st.isFile() && now - st.mtimeMs < 3 * 86_400_000 ? [{ file: join(dir, name), name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export interface DumpContext {
  exec: Executor;
  uploadsDir: string;
  home: string;
}

/** The share of a download step that is the download; reading the dump after it is the rest. */
const DOWNLOADING = 0.85;
const readingNote = (fraction: number) => `reading it for its site, plugins and admins: ${Math.round(fraction * 100)}%`;

/** The upload a dump job made, from its output, for the wizard. */
export const uploadIdOf = (output: string) => /\bupload ([0-9a-f-]{36})\b/.exec(output)?.[1];

/**
 * Downloads a dump from Google Drive with rclone into the uploads, after a
 * free space check: to a .part file renamed when complete, then read as an
 * upload. A failed or stopped download leaves nothing; Undo removes the dump.
 */
export async function planDriveDownload(ctx: DumpContext, input: ActionInput<'dump.download'>, onUpload: (id: string) => void): Promise<JobStep[]> {
  const { remote, installed } = await rcloneRemote(ctx.exec);
  if (!installed) throw new DumpRefused('rclone is not installed: download the dump in your browser and pick it from your Downloads folder instead');
  if (!remote) throw new DumpRefused('rclone has no Google Drive remote yet: run rclone config once, or download the dump in your browser');
  const fileId = input.fileId ?? driveIdOf(input.link ?? '');
  if (!fileId) throw new DumpRefused('That is not a link to a Google Drive file');
  const steps: JobStep[] = [];
  if (input.sizeBytes) {
    // The dump, and room to unpack a zip or read a gzip next to it.
    steps.push({ id: 'space', label: 'Check free disk space', weight: 0.2, run: async () => checkFreeSpace([{ path: existsSync(ctx.uploadsDir) ? ctx.uploadsDir : ctx.home, bytes: (input.sizeBytes as number) * 2, what: 'the dump' }]) });
  }
  steps.push({
    id: 'download',
    label: `Download ${input.name ?? 'the file'} from Google Drive and read it`,
    weight: 8,
    run: async (job) => {
      const started = Date.now();
      // A link alone gives no name: rclone keeps the file's own in a folder of its own, then it is taken from there.
      const scratch = join(ctx.uploadsDir, `.drive-${randomUUID()}`);
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      try {
        const timer = setInterval(() => {
          const done = folderBytes(scratch);
          if (input.sizeBytes) job.progress(Math.min(done / input.sizeBytes, 1) * DOWNLOADING, progressNote(done, input.sizeBytes, started));
          else if (done > 0) job.progress(0.1, `${formatBytes(done)} so far`);
        }, 1000);
        let r: ExecResult;
        try {
          r = await ctx.exec('rclone', ['backend', 'copyid', `${remote}:`, fileId, input.name ? join(scratch, 'dump.part') : `${scratch}/`], { timeoutMs: 3 * 60 * 60_000 });
        } finally {
          clearInterval(timer);
        }
        if (r.code !== 0) throw new Error(`rclone could not download it: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? `exit ${r.code}`}`);
        const got = readdirSync(scratch).filter((n) => !n.startsWith('.'));
        if (got.length !== 1) throw new Error('rclone did not download one file');
        const downloaded = join(scratch, got[0] as string);
        const name = input.name ?? got[0] as string;
        if (!DUMP.test(name)) throw new Error(`${name} is not a .sql, .sql.gz or .zip file`);
        const info = await adoptUpload(ctx.exec, ctx.uploadsDir, name, async (file) => renameSync(downloaded, file), (fraction) => job.progress(DOWNLOADING + fraction * (1 - DOWNLOADING), readingNote(fraction)));
        onUpload(info.id);
        job.onUndo(`Remove the downloaded ${info.name}`, async () => {
          removeUpload(ctx.uploadsDir, info.id);
          return ok(`removed ${info.name}`);
        });
        return ok(`downloaded ${info.name} (${formatBytes(info.size)}): upload ${info.id}${info.facts.multisite ? ', a multisite network' : ''}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  });
  return steps;
}

/** A Google Drive file's id from its link: /file/d/<id>/view, open?id=<id>, uc?id=<id>. */
export function driveIdOf(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(drive|docs)\.google\.com$/.test(u.hostname)) return null;
  const id = /\/d\/([A-Za-z0-9_-]{10,120})(?:\/|$)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id') ?? '';
  return /^[A-Za-z0-9_-]{10,120}$/.test(id) ? id : null;
}

function folderBytes(dir: string): number {
  try {
    return readdirSync(dir).reduce((n, name) => n + statSync(join(dir, name)).size, 0);
  } catch {
    return 0;
  }
}

/** The rclone remotes, with their type (drive, dropbox, onedrive, s3, sftp, webdav...); empty without rclone. */
export async function rcloneRemotes(exec: Executor): Promise<{ installed: boolean; remotes: Array<{ name: string; type: string }> }> {
  const r = await exec('rclone', ['listremotes', '--long'], { timeoutMs: 15_000 });
  if (r.code === 127) return { installed: false, remotes: [] };
  const remotes = r.code === 0 ? [...r.stdout.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_. -]{0,63}?):\s+(\S+)\s*$/gm)].map((m) => ({ name: m[1] as string, type: m[2] as string })) : [];
  return { installed: true, remotes };
}

/** A folder or a dump in a remote, as the Database step lists them. */
export interface RemoteEntry {
  name: string;
  path: string;
  dir: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

/** One folder of a remote: its folders and its dumps, never other files, read with rclone lsjson. */
export async function listRemote(exec: Executor, remote: string, path: string): Promise<RemoteEntry[]> {
  const known = await rcloneRemotes(exec);
  if (!known.remotes.some((r) => r.name === remote)) throw new DumpRefused(`rclone has no remote called ${remote}`);
  const r = await exec('rclone', ['lsjson', '--max-depth', '1', '--no-mimetype', '--', `${remote}:${path}`], { timeoutMs: 60_000, maxBufferBytes: 32 * 1024 * 1024 });
  if (r.code !== 0) throw new DumpRefused(`rclone could not list ${remote}:${path}: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`);
  let list: Array<{ Name?: string; Path?: string; IsDir?: boolean; Size?: number; ModTime?: string }>;
  try {
    list = JSON.parse(r.stdout) as typeof list;
  } catch {
    throw new DumpRefused('rclone answered something that is not a list');
  }
  return list
    .filter((e) => typeof e.Name === 'string' && (e.IsDir || DUMP.test(e.Name)))
    .map((e) => ({ name: e.Name as string, path: path ? `${path}/${e.Name}` : (e.Name as string), dir: Boolean(e.IsDir), sizeBytes: !e.IsDir && typeof e.Size === 'number' && e.Size >= 0 ? e.Size : null, modifiedAt: e.ModTime && !Number.isNaN(Date.parse(e.ModTime)) ? e.ModTime : null }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.name.localeCompare(b.name))
    .slice(0, 500);
}

/** Downloads a dump from any rclone remote (Dropbox, OneDrive, S3, SFTP, WebDAV...) into the uploads, like the Drive download. */
export async function planRemoteDownload(ctx: DumpContext, input: ActionInput<'dump.fromRemote'>, onUpload: (id: string) => void): Promise<JobStep[]> {
  const known = await rcloneRemotes(ctx.exec);
  if (!known.installed) throw new DumpRefused('rclone is not installed');
  if (!known.remotes.some((r) => r.name === input.remote)) throw new DumpRefused(`rclone has no remote called ${input.remote}`);
  const name = input.path.split('/').pop() as string;
  const steps: JobStep[] = [];
  if (input.sizeBytes) {
    steps.push({ id: 'space', label: 'Check free disk space', weight: 0.2, run: async () => checkFreeSpace([{ path: existsSync(ctx.uploadsDir) ? ctx.uploadsDir : ctx.home, bytes: (input.sizeBytes as number) * 2, what: 'the dump' }]) });
  }
  steps.push({
    id: 'download',
    label: `Download ${name} from ${input.remote} and read it`,
    weight: 8,
    run: async (job) => {
      const started = Date.now();
      const info = await adoptUpload(ctx.exec, ctx.uploadsDir, name, async (file) => {
        const part = `${file}.part`;
        const timer = setInterval(() => {
          try {
            const done = statSync(part).size;
            if (input.sizeBytes) job.progress(Math.min(done / input.sizeBytes, 1) * DOWNLOADING, progressNote(done, input.sizeBytes, started));
          } catch {
            // not started yet
          }
        }, 1000);
        try {
          const r = await ctx.exec('rclone', ['copyto', '--', `${input.remote}:${input.path}`, part], { timeoutMs: 3 * 60 * 60_000 });
          if (r.code !== 0 || !existsSync(part)) throw new Error(`rclone could not download it: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? `exit ${r.code}`}`);
          renameSync(part, file);
        } finally {
          clearInterval(timer);
          rmSync(part, { force: true });
        }
      }, (fraction) => job.progress(DOWNLOADING + fraction * (1 - DOWNLOADING), readingNote(fraction)));
      onUpload(info.id);
      job.onUndo(`Remove the downloaded ${info.name}`, async () => {
        removeUpload(ctx.uploadsDir, info.id);
        return ok(`removed ${info.name}`);
      });
      return ok(`downloaded ${info.name} (${formatBytes(info.size)}) from ${input.remote}: upload ${info.id}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}`);
    },
  });
  return steps;
}

/**
 * Downloads a dump from a public HTTPS address (fetch-dump.ts) into the
 * uploads: the free space is checked against the size the server gives
 * before the body, the type from the first bytes, and the address shown
 * without its query.
 */
export function planFetch(ctx: DumpContext, input: ActionInput<'dump.fetch'>, onUpload: (id: string) => void, get?: Getter): JobStep[] {
  const shown = shownUrl(input.url);
  return [
    {
      id: 'download',
      label: `Download the dump from ${new URL(input.url).host} and read it`,
      weight: 8,
      run: async (job) => {
        const started = Date.now();
        mkdirSync(ctx.uploadsDir, { recursive: true, mode: 0o700 });
        const scratch = join(ctx.uploadsDir, `.fetch-${randomUUID()}.part`);
        try {
          const got = await fetchDump(input.url, scratch, {
            maxBytes: MAX_UPLOAD_BYTES,
            ...(get ? { get } : {}),
            beforeBody: (total) => {
              if (total === null) return;
              const room = checkFreeSpace([{ path: ctx.uploadsDir, bytes: total * 2, what: 'the dump' }]);
              if (room.code !== 0) throw new FetchRefused(room.stderr);
            },
            onBytes: (done, total) => job.progress(total ? Math.min(done / total, 1) * DOWNLOADING : 0.1, total ? progressNote(done, total, started) : `${formatBytes(done)} so far`),
          });
          const info = await adoptUpload(ctx.exec, ctx.uploadsDir, got.name, async (file) => renameSync(scratch, file), (fraction) => job.progress(DOWNLOADING + fraction * (1 - DOWNLOADING), readingNote(fraction)));
          onUpload(info.id);
          job.onUndo(`Remove the downloaded ${info.name}`, async () => {
            removeUpload(ctx.uploadsDir, info.id);
            return ok(`removed ${info.name}`);
          });
          return ok(`downloaded ${info.name} (${formatBytes(info.size)}) from ${shown}: upload ${info.id}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}`);
        } catch (error) {
          return { code: 1, stdout: '', stderr: `${shown}: ${(error as Error).message}` };
        } finally {
          rmSync(scratch, { force: true });
        }
      },
    },
  ];
}

/**
 * Takes a dump from your Downloads folder into the uploads: a hard link when
 * it is on the same disk, else a copy. Only a file in that folder.
 */
export function planUseDownloaded(ctx: DumpContext, input: ActionInput<'dump.useDownloaded'>, onUpload: (id: string) => void): JobStep[] {
  const dir = downloadsDir(ctx.home);
  let real: string;
  try {
    real = realpathSync(input.file);
  } catch {
    throw new DumpRefused(`${input.file} does not exist`);
  }
  if (!real.startsWith(`${realpathSync(dir)}${sep}`) || !DUMP.test(real) || !statSync(real).isFile()) throw new DumpRefused(`Only a .sql, .sql.gz or .zip file in ${dir} can be used`);
  return [
    {
      id: 'take',
      label: `Take ${basename(real)} from ${dir} and read it`,
      weight: 4,
      run: async (job) => {
        const info = await adoptUpload(ctx.exec, ctx.uploadsDir, basename(real), async (file) => {
          await link(real, file).catch(() => copyFile(real, file));
        }, (fraction) => job.progress(fraction, readingNote(fraction)));
        onUpload(info.id);
        job.onUndo(`Remove ${info.name} from the uploads`, async () => {
          removeUpload(ctx.uploadsDir, info.id);
          return ok(`removed ${info.name}; ${real} stays`);
        });
        return ok(`took ${info.name} (${formatBytes(info.size)}): upload ${info.id}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}; your file stays in ${dir}`);
      },
    },
  ];
}

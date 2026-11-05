import { copyFile, link } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { ActionInput } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { checkFreeSpace } from '../sites/create.js';
import { formatBytes, progressNote } from '../sites/db.js';
import { adoptUpload, removeUpload } from '../sites/uploads.js';

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
  const steps: JobStep[] = [];
  if (input.sizeBytes) {
    // The dump, and room to unpack a zip or read a gzip next to it.
    steps.push({ id: 'space', label: 'Check free disk space', weight: 0.2, run: async () => checkFreeSpace([{ path: existsSync(ctx.uploadsDir) ? ctx.uploadsDir : ctx.home, bytes: (input.sizeBytes as number) * 2, what: 'the dump' }]) });
  }
  steps.push({
    id: 'download',
    label: `Download ${input.name} from Google Drive and read it`,
    weight: 8,
    run: async (job) => {
      const started = Date.now();
      const info = await adoptUpload(ctx.exec, ctx.uploadsDir, input.name, async (file) => {
        const part = `${file}.part`;
        const timer = input.sizeBytes
          ? setInterval(() => {
              try {
                const done = statSync(part).size;
                job.progress(Math.min(done / (input.sizeBytes as number), 1) * DOWNLOADING, progressNote(done, input.sizeBytes as number, started));
              } catch {
                // not started yet
              }
            }, 1000)
          : undefined;
        try {
          const r = await ctx.exec('rclone', ['backend', 'copyid', `${remote}:`, input.fileId, part], { timeoutMs: 3 * 60 * 60_000 });
          if (r.code !== 0 || !existsSync(part)) throw new Error(`rclone could not download it: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? `exit ${r.code}`}`);
          renameSync(part, file);
        } finally {
          if (timer) clearInterval(timer);
          rmSync(part, { force: true });
        }
      }, (fraction) => job.progress(DOWNLOADING + fraction * (1 - DOWNLOADING), readingNote(fraction)));
      onUpload(info.id);
      job.onUndo(`Remove the downloaded ${info.name}`, async () => {
        removeUpload(ctx.uploadsDir, info.id);
        return ok(`removed ${info.name}`);
      });
      return ok(`downloaded ${info.name} (${formatBytes(info.size)}): upload ${info.id}${info.facts.multisite ? ', a multisite network' : ''}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}`);
    },
  });
  return steps;
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

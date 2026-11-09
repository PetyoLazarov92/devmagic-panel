import { randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { formatBytes, snapshotDir, wpFor } from './db.js';
import { MAX_UNZIPPED_BYTES } from './dump.js';
import { siteFor } from './site-actions.js';
import { adoptUpload, removeUpload, type UploadInfo } from './uploads.js';

/**
 * Dumps from places the Database step reaches besides uploads and
 * downloads: a server over SSH (a dump file there, or a fresh export with
 * WP-CLI), and this machine (another site's database, one of its snapshots,
 * or the dump in a deleted site's archive). Each lands in the uploads like
 * any dump, checked by its first bytes and read for its facts.
 */

export interface MoreDumpsContext {
  config: SystemConfig;
  exec: Executor;
  uploadsDir: string;
  dmpRoot: string;
}

export class MoreDumpsRefused extends Error {}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

/** ssh never asks for a password or trusts a new host key on the fly, and gives up on a host that does not answer. */
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'Compression=yes'];

/** What ssh says when it stops, said plainly; a run that says nothing gets its exit code and what to try. */
function sshProblem(host: string, stderr: string, code = 1, hint = ''): string {
  const last = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (/Host key verification failed|No .* host key is known/i.test(stderr)) return `${host} is not in your known_hosts: connect once in a terminal with ssh ${host}, check its key, then try again`;
  if (/Permission denied/i.test(stderr)) return `${host} refused your SSH key: the panel uses your ssh-agent and ~/.ssh/config, and never asks for a password`;
  if (/Could not resolve hostname/i.test(stderr)) return `${host} is not a host your ssh knows: use an alias from ~/.ssh/config or user@host`;
  if (last) return last;
  return `${host} ended with exit ${code} and printed nothing${hint ? `: ${hint}` : ''}`;
}

/** Why a quiet wp db export fails, and how to see it. */
const exportHint = (host: string, path: string) =>
  `WP-CLI on the server stopped without a word, as PHP does on a fatal error with display_errors off (shared hosts often block mysqldump this way). Run ssh ${host} wp --path=${path} db export - --debug > /dev/null in a terminal to see why, or take A dump file there instead`;

/** The upload a dump job made, said for the wizard: "upload <id>". */
const madeUpload = (info: UploadInfo, from: string) => ok(`took ${info.name} (${formatBytes(info.size)}) from ${from}: upload ${info.id}${info.facts.hosts[0] ? `, for ${info.facts.hosts[0]}` : ''}`);

async function adopt(ctx: MoreDumpsContext, job: JobRuntime, name: string, file: string, onUpload: (id: string) => void, from: string): Promise<ExecResult> {
  const info = await adoptUpload(ctx.exec, ctx.uploadsDir, name, async (target) => renameSync(file, target), (fraction) => job.progress(0.8 + fraction * 0.2, `reading it: ${Math.round(fraction * 100)}%`));
  onUpload(info.id);
  job.onUndo(`Remove ${info.name} from the uploads`, async () => {
    removeUpload(ctx.uploadsDir, info.id);
    return ok(`removed ${info.name}`);
  });
  return madeUpload(info, from);
}

/** A scratch file in the uploads folder, removed whatever happens. */
function scratch(ctx: MoreDumpsContext, name: string): string {
  mkdirSync(ctx.uploadsDir, { recursive: true, mode: 0o700 });
  return join(ctx.uploadsDir, `.more-${randomUUID()}-${name}`);
}

/**
 * From a server over SSH, with your own ssh config and agent (an alias from
 * ~/.ssh/config, or user@host): a dump file there, copied with sftp, or a
 * fresh export with WP-CLI on the server, streamed into a gzip here. Only
 * reads on the server; the remote command is fixed, its path checked.
 */
export function planServerDump(ctx: MoreDumpsContext, input: ActionInput<'dump.fromServer'>, onUpload: (id: string) => void): JobStep[] {
  const from = `${input.host}:${input.path}`;
  if (input.mode === 'file') {
    return [
      {
        id: 'download',
        label: `Copy ${basename(input.path)} from ${input.host} and read it`,
        weight: 8,
        run: async (job) => {
          const name = basename(input.path);
          const part = scratch(ctx, name);
          const timer = setInterval(() => {
            try {
              job.progress(0.1, `${formatBytes(statSync(part).size)} so far`);
            } catch {
              // not started yet
            }
          }, 1000);
          try {
            // sftp reads its commands from stdin; the remote path holds no spaces, quotes or shell characters.
            const r = await ctx.exec('sftp', ['-q', '-b', '-', ...SSH_OPTIONS, '--', input.host], { input: `get ${input.path} ${part}\n`, timeoutMs: 3 * 60 * 60_000 });
            if (r.code !== 0 || !existsSync(part)) return { code: 1, stdout: '', stderr: sshProblem(input.host, r.stderr, r.code, 'sftp could not copy it; check the path and that the file is there') };
            return await adopt(ctx, job, name, part, onUpload, from);
          } finally {
            clearInterval(timer);
            rmSync(part, { force: true });
          }
        },
      },
    ];
  }
  const leftOut = input.excludeRows ?? [];
  return [
    {
      id: 'export',
      label: `Export the database on ${input.host} with WP-CLI${leftOut.length ? `, without the rows of ${leftOut.length} table${leftOut.length === 1 ? '' : 's'},` : ''} and read it`,
      weight: 8,
      run: async (job) => {
        const name = `${input.host.replace(/^.*@/, '').replace(/[^\w.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.sql.gz`;
        const part = scratch(ctx, name);
        const exported = { bytes: 0 };
        const timer = setInterval(() => job.progress(0.1, `${formatBytes(exported.bytes)} of SQL so far`), 1000);
        try {
          const r = await exportOverSsh(ctx.exec, input.host, input.path, leftOut, part, exported);
          if ('error' in r) return { code: 1, stdout: '', stderr: r.error };
          const out = await adopt(ctx, job, name, part, onUpload, from);
          return r.notes.length ? [ok(r.notes.join('\n')), out] : out;
        } catch (error) {
          return { code: 1, stdout: '', stderr: (error as Error).message };
        } finally {
          clearInterval(timer);
          rmSync(part, { force: true });
        }
      },
    },
  ];
}

/** mysqldump's last line: a dump without it was cut off on the way. */
const DUMP_DONE = /-- Dump completed/;
/** A plain absolute path to a program, as command -v answers it. */
const PROGRAM_PATH = /^\/[A-Za-z0-9._/+-]{1,200}$/;

/** WP-CLI as the server runs it: wp, or through php with exec allowed again for this one run. */
type WpRun = string[];

/**
 * Runs WP-CLI on a server over SSH, read only: `wp ...` as it is, and when
 * that ends at once with exit 255 and not a word (PHP stopped on a function
 * the host disabled, with errors hidden), once more as `php -d
 * disable_functions= -d display_errors=stderr <wp> ...`: the same command,
 * with those functions back for that process only, and its errors shown.
 */
async function sshWp(exec: Executor, host: string, wp: WpRun | null, args: string[], stdoutTo?: Writable): Promise<{ result: ExecResult; wp: WpRun; fellBack: boolean }> {
  const run = (cmd: WpRun) => exec('ssh', [...SSH_OPTIONS, '--', host, ...cmd, ...args], { timeoutMs: 3 * 60 * 60_000, ...(stdoutTo ? { stdoutTo } : {}) });
  if (wp) return { result: await run(wp), wp, fellBack: false };
  return { result: await run(['wp']), wp: ['wp'], fellBack: false };
}

/** The fallback form of WP-CLI on a server, once the plain one died without a word; null when wp cannot be found. */
async function fallbackWp(exec: Executor, host: string): Promise<WpRun | null> {
  const where = await exec('ssh', [...SSH_OPTIONS, '--', host, 'command', '-v', 'wp'], { timeoutMs: 60_000 });
  const path = where.stdout.trim().split('\n')[0] ?? '';
  return where.code === 0 && PROGRAM_PATH.test(path) ? ['php', '-d', 'disable_functions=', '-d', 'display_errors=stderr', path] : null;
}

/**
 * mysqldump's switches as WP-CLI must get them: it reads a bare --no-x as
 * "x is off" and hands mysqldump --x=, which stops it ("unknown variable
 * 'tablespaces='"). With =true the switch goes through as it is.
 */
const NO_TABLESPACES = '--no-tablespaces=true';
const NO_DATA = '--no-data=true';

const quietDeath = (r: ExecResult, bytes: number) => r.code === 255 && bytes === 0 && !r.stderr.trim();

/**
 * Exports a WordPress database over SSH into one gzip file here, streamed:
 * nothing is written on the server, and the database password never leaves
 * it. Compressed in transit (Compression=yes), no tablespaces for shared
 * hosts, the fallback above when WP-CLI dies without a word, and a dump that
 * does not end the way mysqldump ends one (a dropped connection) refused.
 * Tables in leftOut come as their structure only: a second export with
 * --no-data, appended as a second gzip member, read as one file.
 */
export async function exportOverSsh(exec: Executor, host: string, path: string, leftOut: readonly string[], file: string, seen: { bytes: number } = { bytes: 0 }): Promise<{ notes: string[] } | { error: string }> {
  const base = [`--path=${path}`, 'db', 'export', '-', '--single-transaction', '--quick', NO_TABLESPACES, '--skip-plugins', '--skip-themes'];
  const parts: string[][] = [[...base, ...(leftOut.length ? [`--exclude_tables=${leftOut.join(',')}`] : [])], ...(leftOut.length ? [[...base, `--tables=${leftOut.join(',')}`, NO_DATA]] : [])];
  const gzip = createGzip({ level: 1 });
  const written = pipeline(gzip, createWriteStream(file, { mode: 0o600 }));
  written.catch(() => undefined);
  const notes: string[] = [];
  let wp: WpRun | null = null;
  const run = async (): Promise<{ notes: string[] } | { error: string }> => {
    for (const [i, args] of parts.entries()) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let bytes = 0;
        let tail = '';
        const piece = new Transform({
          transform(chunk: Buffer, _enc, next) {
            bytes += chunk.length;
            seen.bytes += chunk.length;
            if (seen.bytes > MAX_UNZIPPED_BYTES) return next(new MoreDumpsRefused(`the export is larger than ${MAX_UNZIPPED_BYTES / 1024 ** 3} GB`));
            tail = (tail + chunk.toString('latin1')).slice(-300);
            next(null, chunk);
          },
        });
        let broke: Error | undefined;
        const into = new Promise<void>((resolve) => {
          piece.on('error', (e) => {
            broke = e;
            resolve();
          });
          piece.on('end', resolve);
        });
        piece.pipe(gzip, { end: false });
        const { result, wp: used } = await sshWp(exec, host, wp, args, piece);
        await into;
        if (broke) throw broke;
        if (quietDeath(result, bytes) && !wp) {
          const fallback = await fallbackWp(exec, host);
          if (!fallback) return { error: sshProblem(host, result.stderr, result.code, exportHint(host, path)) };
          wp = fallback;
          notes.push(`WP-CLI on ${host} stopped without a word (its PHP disables exec and similar functions), so the export ran again as php -d disable_functions= ${fallback.at(-1)}: for that one run only, nothing changed on the server`);
          continue;
        }
        wp = used;
        if (result.code !== 0) {
          return { error: /wp: command not found|No such file/i.test(result.stderr) ? `${host} has no WP-CLI as wp, or no WordPress at ${path}` : sshProblem(host, result.stderr, result.code, exportHint(host, path)) };
        }
        if (bytes === 0) return { error: `${host} sent no SQL: ${exportHint(host, path)}` };
        if (!DUMP_DONE.test(tail)) return { error: `the ${i === 0 ? 'export' : 'structure of the tables left out'} from ${host} stopped before its end (no "-- Dump completed" line), so it was not used: try again` };
        break;
      }
    }
    if (leftOut.length) notes.push(`left out the rows of ${leftOut.join(', ')}; their tables come empty`);
    gzip.end();
    await written;
    return { notes };
  };
  let done = false;
  try {
    const out = await run();
    done = !('error' in out);
    return out;
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    // A refused export closes its file before the caller removes it, so nothing is left behind.
    if (!done) {
      gzip.destroy();
      await written.catch(() => undefined);
    }
  }
}

/** The tables of a WordPress database on a server, biggest first, with their size, read with WP-CLI (and its fallback). */
export async function serverTables(exec: Executor, host: string, path: string): Promise<Array<{ name: string; bytes: number }>> {
  const args = [`--path=${path}`, 'db', 'size', '--tables', '--size_format=b', '--format=json', '--skip-plugins', '--skip-themes'];
  let { result } = await sshWp(exec, host, null, args);
  if (quietDeath(result, result.stdout.length)) {
    const fallback = await fallbackWp(exec, host);
    if (fallback) ({ result } = await sshWp(exec, host, fallback, args));
  }
  if (result.code !== 0) throw new MoreDumpsRefused(sshProblem(host, result.stderr, result.code, exportHint(host, path)));
  let list: Array<{ Name?: unknown; Size?: unknown }>;
  try {
    list = JSON.parse(result.stdout) as typeof list;
  } catch {
    throw new MoreDumpsRefused(`${host} answered something that is not a list of tables`);
  }
  return list
    .flatMap((t) => (typeof t.Name === 'string' && TABLE_NAME.test(t.Name) ? [{ name: t.Name, bytes: Number.parseInt(String(t.Size ?? '0'), 10) || 0 }] : []))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 2000);
}

/** A table name as the export takes it: letters, digits, _ and $. */
export const TABLE_NAME = /^[A-Za-z0-9_$]{1,64}$/;

/**
 * From this machine: another site's database exported with WP-CLI, one of
 * its snapshots, or the dump a deleted site's archive holds (copied out by
 * dmp-root, which keeps the archive as it is).
 */
export function planLocalDump(ctx: MoreDumpsContext, input: ActionInput<'dump.fromLocal'>, onUpload: (id: string) => void): JobStep[] {
  if (input.kind === 'site') {
    const site = siteFor(ctx.config, input.domain, input.path);
    return [
      {
        id: 'export',
        label: `Export the database of ${site.host} and read it`,
        weight: 6,
        run: async (job) => {
          const name = `${site.key.replace(/@/g, '-')}-${new Date().toISOString().slice(0, 10)}.sql`;
          const part = scratch(ctx, name);
          const structure = `${part}.structure`;
          const leftOut = input.excludeRows ?? [];
          const wp = wpFor(ctx.exec, site.docroot, site.host);
          try {
            const r = await wp(['db', 'export', part, ...(leftOut.length ? [`--exclude_tables=${leftOut.join(',')}`] : [])]);
            if (r.code !== 0) return r;
            // The tables left out come as their structure only, so a plugin finds its table, empty.
            if (leftOut.length) {
              const s2 = await wp(['db', 'export', structure, `--tables=${leftOut.join(',')}`, NO_DATA]);
              if (s2.code !== 0) return s2;
              appendFileSync(part, readFileSync(structure));
            }
            const out = await adopt(ctx, job, name, part, onUpload, site.host);
            return leftOut.length ? [ok(`left out the rows of ${leftOut.join(', ')}; their tables come empty`), out] : out;
          } finally {
            rmSync(part, { force: true });
            rmSync(structure, { force: true });
          }
        },
      },
    ];
  }
  if (input.kind === 'snapshot') {
    const site = siteFor(ctx.config, input.domain, input.path);
    const file = join(snapshotDir(ctx.config, site.key), input.snapshot);
    if (!existsSync(file)) throw new MoreDumpsRefused(`${site.host} has no snapshot ${input.snapshot}`);
    return [
      {
        id: 'take',
        label: `Take the snapshot ${input.snapshot} of ${site.host} and read it`,
        weight: 4,
        run: async (job) => {
          // A copy: the snapshot stays where it is, for its own site.
          const part = scratch(ctx, input.snapshot);
          try {
            const { copyFile } = await import('node:fs/promises');
            await copyFile(file, part);
            return await adopt(ctx, job, input.snapshot, part, onUpload, `${site.host}'s snapshots`);
          } finally {
            rmSync(part, { force: true });
          }
        },
      },
    ];
  }
  return [
    {
      id: 'take',
      label: `Take the database dump of the deleted ${input.id.slice(0, -16)}`,
      weight: 4,
      run: async (job) => {
        const r = await runRoot(ctx.exec, ctx.dmpRoot, ['trash-dump', input.id], 30 * 60_000);
        if (r.code !== 0) return r;
        const copy = /^DUMP=(.+)$/m.exec(r.stdout)?.[1]?.trim();
        if (!copy || !copy.startsWith(join(ctx.config.BACKUP_DIR, 'sites') + '/') || !existsSync(copy)) return { code: 1, stdout: r.stdout, stderr: 'dmp-root gave no dump to take' };
        try {
          return await adopt(ctx, job, `${input.id}.sql.gz`, copy, onUpload, `the archive of ${input.id.slice(0, -16)}`);
        } finally {
          rmSync(copy, { force: true });
        }
      },
    },
  ];
}

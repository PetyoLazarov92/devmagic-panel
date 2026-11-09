import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
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
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'];

/** What ssh says when it stops, said plainly. */
function sshProblem(host: string, stderr: string): string {
  const last = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (/Host key verification failed|No .* host key is known/i.test(stderr)) return `${host} is not in your known_hosts: connect once in a terminal with ssh ${host}, check its key, then try again`;
  if (/Permission denied/i.test(stderr)) return `${host} refused your SSH key: the panel uses your ssh-agent and ~/.ssh/config, and never asks for a password`;
  if (/Could not resolve hostname/i.test(stderr)) return `${host} is not a host your ssh knows: use an alias from ~/.ssh/config or user@host`;
  return last || 'ssh stopped';
}

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
            if (r.code !== 0 || !existsSync(part)) return { code: 1, stdout: '', stderr: sshProblem(input.host, r.stderr) };
            return await adopt(ctx, job, name, part, onUpload, from);
          } finally {
            clearInterval(timer);
            rmSync(part, { force: true });
          }
        },
      },
    ];
  }
  return [
    {
      id: 'export',
      label: `Export the database on ${input.host} with WP-CLI and read it`,
      weight: 8,
      run: async (job) => {
        const name = `${input.host.replace(/^.*@/, '').replace(/[^\w.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.sql.gz`;
        const part = scratch(ctx, name);
        let raw = 0;
        // The SQL as it comes, counted and capped, gzipped on its way to disk.
        const counter = new Transform({
          transform(chunk: Buffer, _enc, next) {
            raw += chunk.length;
            if (raw > MAX_UNZIPPED_BYTES) return next(new MoreDumpsRefused(`the export is larger than ${MAX_UNZIPPED_BYTES / 1024 ** 3} GB`));
            next(null, chunk);
          },
        });
        // The executor ends the counter with ssh's stdout; the file is done once this settles.
        const written = pipeline(counter, createGzip({ level: 1 }), createWriteStream(part, { mode: 0o600 }));
        written.catch(() => undefined);
        const timer = setInterval(() => job.progress(0.1, `${formatBytes(raw)} of SQL so far`), 1000);
        try {
          // A fixed command: wp reads the site at the path, writes SQL to stdout, and changes nothing.
          const r = await ctx.exec('ssh', [...SSH_OPTIONS, '--', input.host, 'wp', `--path=${input.path}`, 'db', 'export', '-', '--single-transaction', '--quick', '--skip-plugins', '--skip-themes'], { stdoutTo: counter, timeoutMs: 3 * 60 * 60_000 });
          await written;
          if (r.code !== 0) return { code: 1, stdout: '', stderr: /wp: command not found|No such file/i.test(r.stderr) ? `${input.host} has no WP-CLI as wp, or no WordPress at ${input.path}` : sshProblem(input.host, r.stderr) };
          return await adopt(ctx, job, name, part, onUpload, from);
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
          try {
            const r = await wpFor(ctx.exec, site.docroot, site.host)(['db', 'export', part]);
            if (r.code !== 0) return r;
            return await adopt(ctx, job, name, part, onUpload, site.host);
          } finally {
            rmSync(part, { force: true });
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

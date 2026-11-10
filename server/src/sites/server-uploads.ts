import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { splitSshHost } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import { formatBytes } from './db.js';
import { MoreDumpsRefused, SSH_OPTIONS, sshProblem, sshTarget } from './more-dumps.js';
import { serverDir, type ServerSource } from './server-files.js';
import { freeSpace } from './space.js';

/**
 * A site's uploads copied from its own server over SSH, only when you ask
 * for it: missing uploads load from production as it is, so this is for when
 * the files have to be on this disk. Only reads on the server: WP-CLI says
 * where wp-content is, du says how much there is, and rsync brings the files.
 * Nothing is written or deleted there.
 *
 * Here it only adds: a file that exists is never written over and nothing is
 * deleted, so a second run brings what is new. PHP files, links and the
 * cache, log and backup folders plugins keep in uploads are left out. It
 * refuses when the files would not fit on this disk.
 */

/** Left on the server: code (uploads should hold none, and one there is often a sign of a break-in), per-folder Apache rules, dumps, and the folders plugins keep caches, logs and backups in. */
export const UPLOADS_LEFT_OUT = [
  '*.php', '*.phtml', '*.phar', '.htaccess', '*.sql', '*.sql.gz',
  '/cache/', '/wc-logs/', '/wp-rocket-config/', '/backup/', '/backups/', '/backup-*/', '/backwpup*/', '/updraft/', '/ai1wm-backups/', '/wpallimport/', '/wpallexport/', '/wp-file-manager-pro/', '/ShortpixelBackups/', '/sucuri/', '/wflogs/',
];

/** Room kept free on the disk after the copy. */
const ROOM_TO_SPARE = 1024 ** 3;

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** The year and month folders of the last `months` months, newest first, as WordPress names them: 2026/11. */
export function recentFolders(months: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** rsync's filter for the months to bring: those folders and what is in them, on every site of a network, and nothing else. */
export function monthFilters(months: number, now = new Date()): string[] {
  const folders = recentFolders(months, now);
  const years = [...new Set(folders.map((f) => f.split('/')[0] as string))];
  const at = ['/', '/sites/*/'];
  return [
    '--include=/sites/', '--include=/sites/*/',
    ...at.flatMap((base) => years.map((y) => `--include=${base}${y}/`)),
    ...at.flatMap((base) => folders.map((f) => `--include=${base}${f}/***`)),
    '--exclude=*',
  ];
}

/** The uploads folder on the server: uploads beside the plugins folder its WordPress names. */
export async function serverUploadsDir(exec: Executor, src: ServerSource): Promise<string> {
  return `${dirname(await serverDir(exec, src, 'plugin'))}/uploads`;
}

/** How much the uploads on the server hold, in bytes, read with du. */
export async function serverUploadsSize(exec: Executor, src: ServerSource, dir: string): Promise<number> {
  const r = await exec('ssh', [...SSH_OPTIONS, ...sshTarget(src.host), 'du', '-sk', '--', dir], { timeoutMs: 10 * 60_000 });
  const kb = Number(/^(\d+)\s/.exec(r.stdout.trim())?.[1]);
  if (r.code !== 0 || !Number.isFinite(kb)) {
    throw new MoreDumpsRefused(/No such file/i.test(r.stderr) ? `${src.host} has no ${dir}` : sshProblem(src.host, r.stderr, r.code, 'du could not read the uploads there'));
  }
  return kb * 1024;
}

/**
 * Copies the uploads into the site: all of them, or the last `months`
 * months. One step's work, with an executor that signs in.
 */
export async function copyUploads(exec: Executor, docroot: string, src: ServerSource, months: number | undefined, now = new Date()): Promise<ExecResult[]> {
  const content = join(docroot, 'wp-content');
  const local = join(content, 'uploads');
  const real = (path: string) => existsSync(path) && lstatSync(path).isDirectory();
  // Through a link the files would land somewhere else: a shared folder, or another site.
  if (!real(content) || (existsSync(local) && !real(local)) || lstatSync(local, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return [fail('wp-content/uploads is not a folder of this site (wp-content is missing, or one of them is a link), so nothing was copied into it')];
  }
  const parts = splitSshHost(src.host);
  if (!parts) return [fail(`${src.host} is not an ssh alias or user@host`)];
  let dir: string;
  let bytes: number;
  try {
    dir = await serverUploadsDir(exec, src);
    bytes = await serverUploadsSize(exec, src, dir);
  } catch (error) {
    return [fail((error as Error).message)];
  }
  const results: ExecResult[] = [ok(`${src.host} has ${formatBytes(bytes)} in ${dir}${months ? `; bringing the last ${months} month${months === 1 ? '' : 's'} of it` : ''}`)];
  // The whole size is the most it can be; a part of it by months is less, and unknown until it is here.
  const free = freeSpace(content).bytes;
  if (!months && bytes + ROOM_TO_SPARE > free) {
    return [...results, fail(`the uploads are ${formatBytes(bytes)} and this disk has ${formatBytes(free)} free: not copied. Bring only the last months instead, or make room`)];
  }
  mkdirSync(local, { recursive: true });
  // ssh as rsync runs it: the same options as every connection of the panel's, and the port when one was given. No word of it has a space.
  const ssh = ['ssh', ...SSH_OPTIONS, ...(parts.port !== undefined ? ['-p', String(parts.port)] : [])].join(' ');
  const r = await exec(
    'rsync',
    [
      '--recursive', '--times', '--partial', '--ignore-existing', '--no-links', '--no-perms', '--no-owner', '--no-group', '--chmod=D755,F644', '--timeout=120', '--stats',
      ...UPLOADS_LEFT_OUT.map((p) => `--exclude=${p}`),
      ...(months ? monthFilters(months, now) : []),
      '-e', ssh, '--', `${parts.host}:${dir}/`, `${local}/`,
    ],
    { timeoutMs: 6 * 60 * 60_000, maxBufferBytes: 16 * 1024 ** 2 },
  );
  if (r.code !== 0) {
    const text = `${r.stderr}\n${r.stdout}`;
    const why = /rsync: (command )?not found|rsync: not found/i.test(text)
      ? `${src.host} has no rsync, which this copy needs on both sides`
      : r.code === 127
        ? 'rsync is not installed on this machine: sudo apt install rsync, then Retry'
        : /No space left/i.test(text)
          ? 'this disk is full: what came so far is kept, and Retry goes on once there is room'
          : sshProblem(src.host, r.stderr, r.code, 'rsync stopped; what came so far is kept, and Retry goes on from there');
    return [...results, fail(why)];
  }
  const stat = (label: string) => new RegExp(`${label}:\\s*([\\d,.]+)`).exec(r.stdout)?.[1]?.replace(/[,.]/g, '');
  const files = stat('Number of regular files transferred') ?? stat('Number of files transferred');
  const sent = Number(stat('Total transferred file size'));
  results.push(ok(`copied ${files ?? 'the new'} file${files === '1' ? '' : 's'}${Number.isFinite(sent) && sent > 0 ? ` (${formatBytes(sent)})` : ''} into wp-content/uploads; files that were here already were left as they are, and nothing was written on ${src.host}`));
  results.push(ok('left on the server: PHP files, .htaccess, SQL dumps, links, and the cache, log and backup folders of plugins'));
  return results;
}

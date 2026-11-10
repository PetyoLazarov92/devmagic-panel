import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerFiles, ServerItem } from '@devmagic-panel/shared';
import { SERVER_ITEM } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import { formatBytes } from './db.js';
import { MoreDumpsRefused, SSH_OPTIONS, sshProblem, sshTarget, wpOverSsh } from './more-dumps.js';
import { excludeLocally } from './mu-plugins.js';

/**
 * Plugins and themes a site's database names that neither a repo nor
 * WordPress.org has (paid and custom ones), copied from the site's own server
 * over SSH when you tick them. Only reads there: WP-CLI says where the
 * plugins and themes folders are and what they hold, and tar streams one
 * folder to this machine. Nothing is written on the server.
 *
 * What arrives is checked before it is unpacked: every entry inside the one
 * folder asked for, no hard links, nothing through a link; then it is unpacked
 * in a folder of its own, links and anything that is not a file or a folder
 * are dropped, and only then is it moved into place. A folder that exists is
 * never written over, and what lands inside a repo is kept out of its git
 * status locally. Never mu-plugins, drop-ins or core.
 */

export interface ServerSource {
  host: string;
  /** The WordPress folder on the server. */
  folder: string;
  wpCli?: string | undefined;
}

export type ServerKind = 'plugin' | 'theme';

/** The most one plugin or theme may be, and one run. */
export const MAX_ITEM_BYTES = 500 * 1024 ** 2;
export const MAX_RUN_BYTES = 3 * 1024 ** 3;

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
/** An absolute path of plain characters, as WP-CLI answers it and tar gets it. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]{1,400}$/;
const plain = (path: string) => PLAIN_PATH.test(path) && !path.split('/').includes('..');
const LOCAL_DIR = { plugin: 'plugins', theme: 'themes' } as const;

/** The plugins or themes folder on the server, as its WordPress says. */
export async function serverDir(exec: Executor, src: ServerSource, kind: ServerKind): Promise<string> {
  const out = await wpOverSsh(exec, src.host, src.folder, [kind, 'path'], src.wpCli ?? 'wp');
  const dir = (out.trim().split('\n').at(-1) ?? '').trim().replace(/\/$/, '');
  if (!plain(dir)) throw new MoreDumpsRefused(`${src.host} named its ${LOCAL_DIR[kind]} folder in a way the panel does not take (spaces or special characters), so nothing is copied from it`);
  return dir;
}

/** What the server has of a kind: name, version and whether it is on. Read only. */
export async function serverItems(exec: Executor, src: ServerSource, kind: ServerKind): Promise<ServerItem[]> {
  const out = await wpOverSsh(exec, src.host, src.folder, [kind, 'list', '--fields=name,version,status', '--format=json'], src.wpCli ?? 'wp');
  let list: Array<{ name?: unknown; version?: unknown; status?: unknown }>;
  try {
    list = JSON.parse(out.slice(out.indexOf('['))) as typeof list;
  } catch {
    throw new MoreDumpsRefused(`${src.host} answered something that is not a list of ${LOCAL_DIR[kind]}`);
  }
  if (!Array.isArray(list)) throw new MoreDumpsRefused(`${src.host} answered something that is not a list of ${LOCAL_DIR[kind]}`);
  return list
    .flatMap((p) =>
      typeof p.name === 'string' && SERVER_ITEM.test(p.name) && !p.name.includes('..')
        ? [{ name: p.name, ...(typeof p.version === 'string' && /^[\w.+-]{1,40}$/.test(p.version) ? { version: p.version } : {}), ...(typeof p.status === 'string' && /^[a-z-]{1,30}$/.test(p.status) ? { status: p.status } : {}) }]
        : [],
    )
    .slice(0, 2000);
}

/** Both lists, for the wizard and the Plugins tab: what could be copied. */
export async function serverFiles(exec: Executor, src: ServerSource): Promise<ServerFiles> {
  return { plugins: await serverItems(exec, src, 'plugin'), themes: await serverItems(exec, src, 'theme') };
}

/**
 * Reads tar's listing of an archive (tar --numeric-owner -tv) and refuses
 * what must not be unpacked: an entry outside the one folder asked for, a
 * hard link (it could name a file of yours outside the folder), or an entry
 * under a link. Returns how many links it holds; they are dropped later.
 */
export function checkListing(listing: string, item: string): { links: number; entries: number } | { error: string } {
  const lines = listing.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { error: 'the archive is empty' };
  const links: string[] = [];
  const names: string[] = [];
  for (const line of lines) {
    const m = /^(\S)\S*\s+\d+\/\d+\s+\S+\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s(.+)$/.exec(line);
    if (!m) return { error: `the archive's listing has a line the panel cannot read: ${line.slice(0, 120)}` };
    const type = m[1] as string;
    const rest = m[2] as string;
    if (type === 'h') return { error: `the archive holds a hard link (${rest.slice(0, 120)}), which is not unpacked` };
    const name = (type === 'l' ? rest.split(' -> ')[0] ?? rest : rest).replace(/\/$/, '');
    if (name !== item && !name.startsWith(`${item}/`)) return { error: `the archive holds ${name.slice(0, 120)}, which is outside ${item}` };
    if (name.startsWith('/') || name.split('/').includes('..')) return { error: `the archive holds ${name.slice(0, 120)}, which leaves ${item}` };
    if (type === 'l') links.push(name);
    else if (type !== '-' && type !== 'd') links.push(name);
    names.push(name);
  }
  const under = names.find((n) => links.some((l) => n.startsWith(`${l}/`)));
  if (under) return { error: `the archive holds ${under.slice(0, 120)} under a link, which is not unpacked` };
  return { links: links.length, entries: names.length };
}

/** Removes everything that is not a file or a folder from an unpacked tree: links, sockets, devices. Returns how many went. */
export function dropLinks(path: string): number {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).reduce((n, name) => n + dropLinks(join(path, name)), 0);
  if (stat.isFile()) return 0;
  rmSync(path, { force: true });
  return 1;
}

const sizeOf = (path: string): number => {
  const stat = lstatSync(path);
  return stat.isDirectory() ? readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0) : stat.size;
};

/** One folder (or single file) of the server's `dir`, streamed with tar into `file` here. Returns what went wrong, or null. */
async function fetchTar(exec: Executor, host: string, dir: string, item: string, file: string, run: { bytes: number }): Promise<string | null> {
  let size = 0;
  let over: string | null = null;
  const count = new Transform({
    transform(chunk: Buffer, _enc, next) {
      size += chunk.length;
      run.bytes += chunk.length;
      if (size > MAX_ITEM_BYTES) over = `it is larger than ${formatBytes(MAX_ITEM_BYTES)}`;
      else if (run.bytes > MAX_RUN_BYTES) over = `this run copied ${formatBytes(MAX_RUN_BYTES)} already`;
      if (over) return next(new Error(over));
      next(null, chunk);
    },
  });
  const written = pipeline(count, createWriteStream(file, { mode: 0o600 }));
  written.catch(() => undefined);
  // The command is fixed and its words are plain: a checked folder and a name of letters, digits, dots and dashes.
  const r = await exec('ssh', [...SSH_OPTIONS, ...sshTarget(host), 'tar', '--hard-dereference', '-cf', '-', '-C', dir, '--', item], { timeoutMs: 60 * 60_000, stdoutTo: count });
  await written.catch(() => undefined);
  if (over) return over;
  if (r.code !== 0) {
    if (/No such file or directory|Cannot stat/i.test(r.stderr)) return `${host} has no ${item} in ${dir}`;
    if (/tar: (command )?not found|unrecognized option|invalid option/i.test(r.stderr)) return `${host} has no tar that can do this (GNU tar is needed)`;
    return sshProblem(host, r.stderr, r.code, 'tar could not read it there');
  }
  if (size === 0) return `${host} sent nothing for ${item}`;
  return null;
}

export interface CopyOutcome {
  results: ExecResult[];
  /** The folders and files this run made, for Undo. */
  made: string[];
  failed: string[];
}

/**
 * Copies plugins and themes from the server into the site, each on its own:
 * one that fails is noted and the rest go on. `scratch` is a folder of the
 * panel's for the archives, emptied again whatever happens.
 */
export async function copyFromServer(exec: Executor, docroot: string, src: ServerSource, want: { plugins: readonly string[]; themes: readonly string[] }, scratch: string): Promise<CopyOutcome> {
  const results: ExecResult[] = [];
  const made: string[] = [];
  const failed: string[] = [];
  const run = { bytes: 0 };
  const content = join(docroot, 'wp-content');
  for (const kind of ['plugin', 'theme'] as const) {
    const items = [...new Set(kind === 'plugin' ? want.plugins : want.themes)].filter((i) => SERVER_ITEM.test(i) && !i.includes('..'));
    if (items.length === 0) continue;
    const parent = join(content, LOCAL_DIR[kind]);
    // Through a link the files would land somewhere else: a shared folder, or another site.
    const real = (path: string) => existsSync(path) && lstatSync(path).isDirectory();
    if (!real(content) || !real(parent)) {
      failed.push(...items);
      results.push(ok(`warn: wp-content/${LOCAL_DIR[kind]} is not a folder of this site (missing, or a link), so no ${kind} was copied into it`));
      continue;
    }
    let dir: string;
    try {
      dir = await serverDir(exec, src, kind);
    } catch (error) {
      failed.push(...items);
      results.push(ok(`warn: no ${kind} was copied: ${(error as Error).message}`));
      continue;
    }
    for (const item of items) {
      const target = join(parent, item);
      if (existsSync(target)) {
        results.push(ok(`${item}: wp-content/${LOCAL_DIR[kind]}/${item} is there already; left as it is`));
        continue;
      }
      const id = randomUUID();
      const archive = join(scratch, `.server-${id}.tar`);
      const incoming = join(parent, `.devmagic-panel-incoming-${id}`);
      const fail = (why: string) => {
        failed.push(item);
        results.push(ok(`warn: ${item} was not copied: ${why}`));
      };
      try {
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const problem = await fetchTar(exec, src.host, dir, item, archive, run);
        if (problem) {
          fail(problem);
          continue;
        }
        const listed = await exec('tar', ['--numeric-owner', '-tvf', archive], { timeoutMs: 10 * 60_000, maxBufferBytes: 64 * 1024 ** 2 });
        if (listed.code !== 0) {
          fail(`what ${src.host} sent is not a tar archive (${(listed.stderr.trim().split('\n').at(-1) ?? `exit ${listed.code}`).slice(0, 200)})`);
          continue;
        }
        const checked = checkListing(listed.stdout, item);
        if ('error' in checked) {
          fail(checked.error);
          continue;
        }
        mkdirSync(incoming, { mode: 0o755 });
        const unpacked = await exec('tar', ['-xf', archive, '-C', incoming, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 20 * 60_000 });
        const got = join(incoming, item);
        if (unpacked.code !== 0 || !existsSync(got)) {
          fail(`tar could not unpack it (${(unpacked.stderr.trim().split('\n').at(-1) ?? `exit ${unpacked.code}`).slice(0, 200)})`);
          continue;
        }
        const dropped = dropLinks(got);
        if (!existsSync(got)) {
          fail('it is a link on the server, not a folder');
          continue;
        }
        const bytes = sizeOf(got);
        renameSync(got, target);
        made.push(target);
        await excludeLocally(exec, target, 'devmagic-panel: copied from the server for this local copy');
        results.push(ok(`${item}: copied from ${src.host} into wp-content/${LOCAL_DIR[kind]} (${formatBytes(bytes)}${statSync(target).isDirectory() ? `, ${checked.entries} entries` : ''})${dropped ? `; ${dropped} link${dropped === 1 ? '' : 's'} left out` : ''}`));
      } catch (error) {
        fail((error as Error).message);
      } finally {
        rmSync(archive, { force: true });
        rmSync(incoming, { recursive: true, force: true });
      }
    }
  }
  const wanted = new Set([...want.plugins, ...want.themes]).size;
  const done = wanted - new Set(failed).size;
  results.push(ok(failed.length ? `copied ${done} of ${wanted} from ${src.host}; not copied: ${[...new Set(failed)].join(', ')}` : `copied ${done} from ${src.host}; nothing was written there`));
  return { results, made, failed: [...new Set(failed)] };
}

/** Removes what a copy made, for Undo. */
export function removeCopied(paths: readonly string[]): ExecResult {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
  return ok(`removed ${paths.length} folder${paths.length === 1 ? '' : 's'} copied from the server`);
}

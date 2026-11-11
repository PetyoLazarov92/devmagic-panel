import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, GitDetails, GitPullRequest, GitTidyPreview } from '@devmagic-panel/shared';
import { GIT_KEEP_DAYS, repoFolder } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { openPullsOf } from '../repo-hosts/index.js';
import { findVhost } from './discover.js';
import type { HandlerOutcome } from './site-actions.js';
import { SiteNotFoundError } from './site-actions.js';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** Remote git never asks for a password or a host key: it fails at once instead. */
export const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' };

/**
 * The repo folder for a site or one of its mounted folders, read from the
 * vhost; never a path from the request. With `repo`, one of the repos inside
 * that folder (wp-content, a theme or plugin folder), already checked by
 * repoFolder; it must be a real folder there, reached through no symlink.
 */
export function gitFolder(config: SystemConfig, domain: string, mount?: string, repo?: string): string {
  const vhost = findVhost(config, domain);
  if (!vhost?.docroot || vhost.names[0] !== domain) throw new SiteNotFoundError(`no site called ${domain}`);
  const base = mount === undefined ? vhost.docroot : vhost.mounts.find((m) => m.path === mount)?.docroot;
  if (!base) throw new SiteNotFoundError(`${domain} serves nothing under ${mount}`);
  let folder = base;
  if (repo !== undefined) {
    if (!repoFolder.safeParse(repo).success) throw new SiteNotFoundError(`${repo} is not a repo folder of a site`);
    folder = join(base, repo);
    let real: string;
    try {
      real = realpathSync(folder);
    } catch {
      throw new SiteNotFoundError(`${folder} does not exist`);
    }
    if (real !== join(realpathSync(base), repo)) throw new SiteNotFoundError(`${folder} is reached through a link, so the panel leaves it alone`);
  }
  if (!existsSync(join(folder, '.git'))) throw new SiteNotFoundError(`${folder} is not a git repository`);
  return folder;
}

const git = (exec: Executor, dir: string, args: string[], remote = false) =>
  exec('git', ['-C', dir, ...args], remote ? { timeoutMs: 120_000, env: NO_PROMPTS } : { timeoutMs: 10_000 });

export function parseBranches(refs: string): GitDetails['branches'] {
  const local: GitDetails['branches'] = [];
  const remote: string[] = [];
  for (const line of refs.split('\n')) {
    const [ref = '', head = ''] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice('refs/heads/'.length), current: head === '*', remoteOnly: false });
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') remote.push(ref.slice('refs/remotes/origin/'.length));
  }
  const names = new Set(local.map((b) => b.name));
  return [...local, ...remote.filter((n) => !names.has(n)).map((name) => ({ name, current: false, remoteOnly: true }))];
}

export function parseChanges(porcelain: string): GitDetails['changes'] {
  return porcelain
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
}

export async function readGitDetails(exec: Executor, dir: string): Promise<GitDetails> {
  const [refs, log, status] = await Promise.all([
    git(exec, dir, ['for-each-ref', '--sort=-committerdate', '--count=300', '--format=%(refname)%1f%(HEAD)', 'refs/heads', 'refs/remotes/origin']),
    git(exec, dir, ['log', '-15', '--format=%h%x1f%s%x1f%an%x1f%aI']),
    git(exec, dir, ['status', '--porcelain', '--untracked-files=normal']),
  ]);
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', date = ''] = line.split('\x1f');
      return { hash, subject, author, date };
    });
  const fetchHead = join(dir, '.git', 'FETCH_HEAD');
  return {
    branches: parseBranches(refs.stdout),
    commits,
    changes: parseChanges(status.stdout).slice(0, 200),
    ...(existsSync(fetchHead) ? { fetchedAt: statSync(fetchHead).mtime.toISOString() } : {}),
  };
}

/**
 * The open pull requests (GitHub) or merge requests (GitLab) of the repo's
 * origin, through that host's CLI and its own sign-in. None for any other
 * host or when the CLI is missing or signed out: the Git card then shows
 * none, and no error.
 */
export async function readPullRequests(exec: Executor, dir: string): Promise<GitPullRequest[]> {
  const remote = await git(exec, dir, ['remote', 'get-url', 'origin']);
  return remote.code === 0 ? openPullsOf(exec, remote.stdout.trim()) : [];
}

export interface GitActionContext {
  config: SystemConfig;
  exec: Executor;
}

export async function fetchOrigin(ctx: GitActionContext, { domain, mount, repo }: ActionInput<'git.fetch'>): Promise<HandlerOutcome> {
  const dir = gitFolder(ctx.config, domain, mount, repo);
  const r = await git(ctx.exec, dir, ['fetch', '--prune', 'origin'], true);
  return { results: [r.code === 0 ? { ...r, stdout: r.stdout || r.stderr || 'Fetched, nothing new' } : r] };
}

export async function pull(ctx: GitActionContext, { domain, mount, repo }: ActionInput<'git.pull'>): Promise<HandlerOutcome> {
  const dir = gitFolder(ctx.config, domain, mount, repo);
  const upstream = await git(ctx.exec, dir, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  if (upstream.code !== 0) return { results: [failed('This branch has no remote branch to pull from. Push it first, or switch to a branch on origin.')] };
  return { results: [await git(ctx.exec, dir, ['pull', '--ff-only'], true)] };
}

export async function switchBranch(ctx: GitActionContext, { domain, mount, repo, branch }: ActionInput<'git.switch'>): Promise<HandlerOutcome> {
  const dir = gitFolder(ctx.config, domain, mount, repo);
  const status = await git(ctx.exec, dir, ['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return { results: [status] };
  const changed = parseChanges(status.stdout).length;
  if (changed > 0) {
    return { results: [failed(`${changed} uncommitted change${changed === 1 ? '' : 's'} in ${dir}: commit or stash ${changed === 1 ? 'it' : 'them'} first`)] };
  }
  const current = await git(ctx.exec, dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.stdout.trim() === branch) return { results: [ok(`already on ${branch}`)] };
  // A branch only on origin is created tracking origin/<branch> (git's own guess, which needs one match).
  return { results: [await git(ctx.exec, dir, ['switch', branch])] };
}

/** Where Tidy up keeps a deleted branch: refs/devmagic-panel/deleted/<stamp>/<branch>, out of every branch list. */
const KEPT = 'refs/devmagic-panel/deleted';
const stampOf = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dateOfStamp = (stamp: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null;
};

/** git count-objects -v: loose objects, packs and garbage, in bytes. */
export async function objectsBytes(exec: Executor, dir: string): Promise<number> {
  const r = await git(exec, dir, ['count-objects', '-v']);
  let kib = 0;
  for (const line of r.stdout.split('\n')) {
    const m = /^(size|size-pack|size-garbage): (\d+)$/.exec(line.trim());
    if (m) kib += Number(m[2]);
  }
  return kib * 1024;
}

/** The branches Tidy up kept, newest first: name, commit and when. */
async function keptBranches(exec: Executor, dir: string): Promise<Array<{ ref: string; name: string; hash: string; deletedAt: Date }>> {
  const r = await git(exec, dir, ['for-each-ref', '--format=%(refname)%1f%(objectname)', KEPT]);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref = '', hash = ''] = line.split('\x1f');
      const [stamp = '', ...name] = ref.slice(KEPT.length + 1).split('/');
      const at = dateOfStamp(stamp);
      return at && name.length ? [{ ref, name: name.join('/'), hash, deletedAt: at }] : [];
    })
    .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}

/** Local branches whose branch on origin is gone, after a fetch with prune; and which are in origin's default branch. */
async function goneBranches(exec: Executor, dir: string): Promise<{ gone: GitTidyPreview['gone']; mainBranch?: string }> {
  const [refs, head] = await Promise.all([
    git(exec, dir, ['for-each-ref', '--format=%(refname:short)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD)%1f%(objectname:short)%1f%(subject)%1f%(committerdate:iso-strict)', 'refs/heads']),
    git(exec, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const mainBranch = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined;
  const merged = new Set<string>();
  if (mainBranch) {
    const r = await git(exec, dir, ['branch', '--format=%(refname:short)', '--merged', mainBranch]);
    for (const b of r.stdout.split('\n')) if (b.trim()) merged.add(b.trim());
  }
  const gone = refs.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [name = '', upstream = '', track = '', star = '', hash = '', subject = '', date = ''] = line.split('\x1f');
      return upstream && track === '[gone]' ? [{ name, current: star === '*', merged: merged.has(name), hash, subject, date }] : [];
    });
  return { gone, ...(mainBranch ? { mainBranch } : {}) };
}

/** What Tidy up would do; the Git card fetches with prune first, so gone branches show. Read only. */
export async function readTidyPreview(exec: Executor, dir: string, now = new Date()): Promise<GitTidyPreview> {
  const [{ gone, mainBranch }, bytes, kept] = await Promise.all([goneBranches(exec, dir), objectsBytes(exec, dir), keptBranches(exec, dir)]);
  const since = now.getTime() - GIT_KEEP_DAYS * 86_400_000;
  return { objectsBytes: bytes, gone, ...(mainBranch ? { mainBranch } : {}), kept: kept.filter((k) => k.deletedAt.getTime() >= since).map((k) => ({ name: k.name, deletedAt: k.deletedAt.toISOString() })) };
}

/**
 * Tidy up: fetch with prune, delete the gone branches asked for (each kept
 * under refs/devmagic-panel/deleted first, so Undo puts it back), forget kept
 * ones older than GIT_KEEP_DAYS, and with gc, git gc. History is never
 * rewritten and the working files are never touched.
 */
export async function tidy(ctx: GitActionContext, { domain, mount, repo, branches, gc }: ActionInput<'git.tidy'>, now = new Date()): Promise<HandlerOutcome> {
  const dir = gitFolder(ctx.config, domain, mount, repo);
  const results: ExecResult[] = [];
  const fetched = await git(ctx.exec, dir, ['fetch', '--prune', 'origin'], true);
  results.push(fetched.code === 0 ? { ...fetched, stdout: fetched.stdout || fetched.stderr || 'Fetched, nothing new', stderr: '' } : { ...fetched, code: 0, stdout: `warn: could not fetch from origin, so only branches already known gone are deleted: ${(fetched.stderr || fetched.stdout).trim().split('\n').at(-1) ?? ''}`, stderr: '' });
  const before = gc ? await objectsBytes(ctx.exec, dir) : 0;
  if (branches.length) {
    const { gone } = await goneBranches(ctx.exec, dir);
    const deleted: string[] = [];
    const left: string[] = [];
    for (const name of branches) {
      const b = gone.find((g) => g.name === name);
      if (!b || b.current) {
        left.push(name);
        continue;
      }
      const full = await git(ctx.exec, dir, ['rev-parse', '--verify', `refs/heads/${name}`]);
      const keep = await git(ctx.exec, dir, ['update-ref', `${KEPT}/${stampOf(now)}/${name}`, full.stdout.trim()]);
      if (full.code !== 0 || keep.code !== 0) {
        left.push(name);
        continue;
      }
      const del = await git(ctx.exec, dir, ['branch', '-D', '--', name]);
      if (del.code === 0) deleted.push(name);
      else left.push(name);
    }
    if (deleted.length) results.push(ok(`deleted ${deleted.length} branch${deleted.length === 1 ? '' : 'es'} gone from origin: ${deleted.join(', ')}; kept ${GIT_KEEP_DAYS} days for Undo`));
    if (left.length) results.push(ok(`warn: left as ${left.length === 1 ? 'it is' : 'they are'}, being current or still on origin: ${left.join(', ')}`));
  }
  const since = now.getTime() - GIT_KEEP_DAYS * 86_400_000;
  const old = (await keptBranches(ctx.exec, dir)).filter((k) => k.deletedAt.getTime() < since);
  for (const k of old) await git(ctx.exec, dir, ['update-ref', '-d', k.ref]);
  if (old.length) results.push(ok(`forgot ${old.length} branch${old.length === 1 ? '' : 'es'} deleted more than ${GIT_KEEP_DAYS} days ago`));
  if (gc) {
    const r = await ctx.exec('git', ['-C', dir, 'gc', '--quiet'], { timeoutMs: 20 * 60_000 });
    if (r.code !== 0) return { results: [...results, r] };
    const after = await objectsBytes(ctx.exec, dir);
    results.push(ok(`packed with git gc: ${mib(before)} before, ${mib(after)} now`));
  }
  return { results };
}

/** Puts back branches Tidy up deleted, the newest kept copy of each. */
export async function restoreBranches(ctx: GitActionContext, { domain, mount, repo, branches }: ActionInput<'git.restoreBranches'>): Promise<HandlerOutcome> {
  const dir = gitFolder(ctx.config, domain, mount, repo);
  const kept = await keptBranches(ctx.exec, dir);
  const back: string[] = [];
  const results: ExecResult[] = [];
  for (const name of branches) {
    const k = kept.find((x) => x.name === name);
    if (!k) {
      results.push(ok(`warn: ${name} is not kept any more`));
      continue;
    }
    const made = await git(ctx.exec, dir, ['branch', '--', name, k.hash]);
    if (made.code !== 0) {
      results.push(ok(`warn: ${name} was not put back: ${(made.stderr || made.stdout).trim().split('\n').at(-1) ?? ''}`));
      continue;
    }
    await git(ctx.exec, dir, ['update-ref', '-d', k.ref]);
    back.push(name);
  }
  if (back.length) results.unshift(ok(`put back ${back.join(', ')}`));
  return { results: results.length ? results : [ok('nothing to put back')] };
}

const mib = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`);

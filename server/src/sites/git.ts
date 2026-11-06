import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, GitDetails, GitPullRequest } from '@devmagic-panel/shared';
import { repoFolder } from '@devmagic-panel/shared';
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

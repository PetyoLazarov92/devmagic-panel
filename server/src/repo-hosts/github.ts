import type { CliStatus, GitPullRequest } from '@devmagic-panel/shared';
import { z } from 'zod';
import type { Executor } from '../exec.js';
import { HostRefused } from './types.js';

/**
 * The GitHub CLI, with its own browser sign-in, for what git over SSH cannot
 * do: list the organizations you belong to and their repos. The panel never
 * reads its token.
 */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
const gh = (exec: Executor, args: string[], timeoutMs = 60_000) => exec('gh', args, { timeoutMs, env: GH_ENV });

/** The GitHub CLI refused or did not answer; the stored list stays. */
export class GhRefused extends HostRefused {}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

export async function ghStatus(exec: Executor): Promise<CliStatus> {
  const user = await gh(exec, ['api', 'user', '--jq', '.login'], 20_000);
  if (user.code === 127) return { installed: false, signedIn: false, problem: 'the GitHub CLI (gh) is not installed' };
  if (user.code !== 0) return { installed: true, signedIn: false, problem: /auth login|not logged/i.test(user.stderr) ? 'not signed in: run gh auth login' : firstLine(user.stderr) || 'no answer' };
  return { installed: true, signedIn: true, user: user.stdout.trim() };
}

/** The organizations you belong to, and yourself for your own repos. */
export async function ghOrgs(exec: Executor): Promise<string[]> {
  const orgs = await gh(exec, ['api', 'user/orgs', '--paginate', '--jq', '.[].login']);
  if (orgs.code !== 0) throw new GhRefused(`the GitHub CLI cannot list your organizations: ${firstLine(orgs.stderr) || 'no answer'}`);
  const me = await gh(exec, ['api', 'user', '--jq', '.login'], 20_000);
  return [...new Set([...orgs.stdout.split('\n'), ...(me.code === 0 ? [me.stdout] : [])].map((s) => s.trim()).filter(Boolean))];
}

/** One repo as the REST API lists it, trimmed by --jq to what the panel keeps. */
const ghRepo = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  pushed_at: z.string().nullable().optional(),
  default_branch: z.string().nullable().optional(),
  ssh_url: z.string(),
  html_url: z.string(),
});

export interface GhRepo {
  name: string;
  description?: string;
  archived: boolean;
  pushedAt?: string;
  defaultBranch?: string;
  sshUrl: string;
  url: string;
}

/** The REST API's largest page. */
export const REPO_PAGE_SIZE = 100;

/** Waits before the second and third try when GitHub times out or is busy. */
export const RETRY_WAITS_MS = [2_000, 5_000];

const busy = (stderr: string) => /HTTP 5\d\d|timed? ?out|connection reset|unexpected EOF/i.test(stderr);

/**
 * One page of the repos you can read in an organization, or of your own
 * account's, newest push first. Through the REST API: the GraphQL one that
 * gh repo list uses times out on large organizations. A timeout or a busy
 * GitHub is tried again twice.
 */
export async function ghRepoPage(exec: Executor, owner: { org: string } | { self: true }, page: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<GhRepo[]> {
  const base = 'self' in owner ? 'user/repos?affiliation=owner&' : `orgs/${owner.org}/repos?type=all&`;
  const args = ['api', `${base}per_page=${REPO_PAGE_SIZE}&sort=pushed&direction=desc&page=${page}`, '--jq', 'map({name, description, archived, pushed_at, default_branch, ssh_url, html_url})'];
  const whose = 'self' in owner ? 'your account' : owner.org;
  for (let attempt = 0; ; attempt++) {
    const r = await gh(exec, args, 60_000);
    if (r.code === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout || '[]');
      } catch {
        parsed = null;
      }
      const list = z.array(ghRepo).safeParse(parsed);
      if (!list.success) throw new GhRefused('the GitHub CLI answered with something that is not a repo list');
      return list.data.map((x) => ({
        name: x.name,
        ...(x.description ? { description: x.description } : {}),
        archived: x.archived ?? false,
        ...(x.pushed_at ? { pushedAt: x.pushed_at } : {}),
        ...(x.default_branch ? { defaultBranch: x.default_branch } : {}),
        sshUrl: x.ssh_url,
        url: x.html_url,
      }));
    }
    const wait = RETRY_WAITS_MS[attempt];
    if (wait === undefined || !busy(r.stderr)) throw new GhRefused(`the GitHub CLI cannot list the repos of ${whose}: ${firstLine(r.stderr) || 'no answer'}`);
    await sleep(wait);
  }
}

/** The signed-in account's login, to tell your own repos from an organization's. */
export async function ghLogin(exec: Executor): Promise<string | null> {
  const me = await gh(exec, ['api', 'user', '--jq', '.login'], 20_000);
  return me.code === 0 ? me.stdout.trim() || null : null;
}

/** The names at a repo's top level: none for an empty repo, null when GitHub did not answer. */
export async function ghTopNames(exec: Executor, fullName: string): Promise<string[] | null> {
  const r = await gh(exec, ['api', `repos/${fullName}/contents`, '--jq', '.[].name'], 30_000);
  if (r.code === 0) return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return /empty|HTTP 404/i.test(r.stderr) ? [] : null;
}

/** One open pull request as gh pr list --json gives it; only GitHub links, as they go into an href. */
const ghPull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/),
  headRefName: z.string(),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
});

/**
 * The open pull requests of a GitHub repo (owner/name) from its own branches,
 * or null when gh is missing, not signed in or GitHub did not answer.
 */
export async function ghOpenPulls(exec: Executor, repo: string): Promise<GitPullRequest[] | null> {
  const r = await gh(exec, ['pr', 'list', `--repo=${repo}`, '--state=open', '--limit=200', '--json=number,title,url,headRefName,isDraft,isCrossRepository'], 20_000);
  if (r.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || '[]');
  } catch {
    return null;
  }
  const list = z.array(ghPull).safeParse(parsed);
  if (!list.success) return null;
  return list.data
    .filter((p) => !p.isCrossRepository)
    .map((p) => ({ kind: 'pull' as const, number: p.number, title: p.title, url: p.url, branch: p.headRefName, draft: p.isDraft }));
}

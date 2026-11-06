import type { CliStatus, GitPullRequest, Namespace } from '@devmagic-panel/shared';
import { coveringGroups } from '@devmagic-panel/shared';
import { z } from 'zod';
import type { Executor } from '../exec.js';
import { HostRefused, type HostRepo } from './types.js';

/**
 * The GitLab CLI, with its own sign-in (glab auth login, per host), for what
 * git over SSH cannot do: list your groups, their projects and open merge
 * requests. Only `glab api`, which glab 1.36 (Ubuntu 24.04) already has, and
 * always with --hostname, so the folder it runs in never picks the host. The
 * panel never reads its config, keyring or token.
 */
const GLAB_ENV = {
  // Both the old and the GLAB_ names: glab renamed them after 1.36.
  GLAB_NO_PROMPT: 'true',
  NO_PROMPT: 'true',
  GLAB_CHECK_UPDATE: 'false',
  CHECK_UPDATE: 'false',
  GLAB_SEND_TELEMETRY: 'false',
  GLAB_COLOR: 'never',
  NO_COLOR: '1',
};

/** The oldest glab the panel is tested with: the one Ubuntu 24.04 ships. */
export const MIN_GLAB = [1, 36] as const;

/** A folder that is never a git repo, so glab finds no remote to guess a host from. */
const NEUTRAL_CWD = '/';

export class GlabRefused extends HostRefused {}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const enc = encodeURIComponent;

/** GitLab's largest page. */
export const PROJECT_PAGE_SIZE = 100;
const MAX_GROUP_PAGES = 20;
/** Waits before the second and third try when GitLab times out, is busy or rate limits. */
export const GLAB_RETRY_WAITS_MS = [2_000, 5_000];
const busy = (stderr: string) => /HTTP 5\d\d|HTTP 429|429 Too Many|timed? ?out|connection reset|unexpected EOF/i.test(stderr);
const signedOut = (stderr: string) => /401|unauthori[sz]ed|auth login|no token|not authenticated|not logged/i.test(stderr);

function glab(exec: Executor, host: string, path: string, timeoutMs = 60_000) {
  return exec('glab', ['api', '--hostname', host, path], { timeoutMs, env: GLAB_ENV, cwd: NEUTRAL_CWD });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

/** glab's version, like 1.36.0, from `glab --version` ("glab version 1.36.0 (...)" or "glab 1.53.0 (...)"). */
export async function glabVersion(exec: Executor): Promise<string | null | undefined> {
  const r = await exec('glab', ['--version'], { timeoutMs: 10_000, env: GLAB_ENV, cwd: NEUTRAL_CWD });
  if (r.code === 127) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null;
}

export function glabTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < MIN_GLAB[0] || (major === MIN_GLAB[0] && minor < MIN_GLAB[1]);
}

const user = z.object({ username: z.string().min(1) });

export async function glabStatus(exec: Executor, host: string): Promise<CliStatus> {
  const r = await glab(exec, host, 'user', 20_000);
  if (r.code === 127) return { installed: false, signedIn: false, problem: 'the GitLab CLI (glab) is not installed' };
  const me = r.code === 0 ? user.safeParse(parseJson(r.stdout)) : null;
  if (me?.success) return { installed: true, signedIn: true, user: me.data.username };
  if (r.code !== 0 && signedOut(r.stderr)) return { installed: true, signedIn: false, problem: `not signed in to ${host}: run glab auth login --hostname ${host}` };
  return { installed: true, signedIn: false, problem: firstLine(r.stderr) || `no answer from ${host}` };
}

async function glabLogin(exec: Executor, host: string): Promise<string | null> {
  const r = await glab(exec, host, 'user', 20_000);
  const me = r.code === 0 ? user.safeParse(parseJson(r.stdout)) : null;
  return me?.success ? me.data.username : null;
}

const group = z.object({ full_path: z.string() });

/**
 * The groups you can clone from (Reporter or more: a Guest cannot read a
 * private project's code), cut to the smallest set that covers them, as each
 * is scanned with its subgroups, and your own account. As namespace refs.
 */
export async function glabNamespaces(exec: Executor, host: string): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= MAX_GROUP_PAGES; page++) {
    const r = await glab(exec, host, `groups?min_access_level=20&per_page=${PROJECT_PAGE_SIZE}&page=${page}`);
    if (r.code !== 0) throw new GlabRefused(`the GitLab CLI cannot list your groups on ${host}: ${firstLine(r.stderr) || 'no answer'}`);
    const list = z.array(group).safeParse(parseJson(r.stdout));
    if (!list.success) throw new GlabRefused(`the GitLab CLI answered with something that is not a group list on ${host}`);
    paths.push(...list.data.map((g) => g.full_path));
    if (list.data.length < PROJECT_PAGE_SIZE) break;
  }
  const me = await glabLogin(exec, host);
  return [...coveringGroups(paths), ...(me ? [me] : [])].map((p) => `${host}/${p}`).filter((ref, i, all) => all.indexOf(ref) === i);
}

/** One project as the REST API lists it. Older servers leave some fields out. */
const project = z.object({
  name: z.string(),
  path_with_namespace: z.string(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  last_activity_at: z.string().nullable().optional(),
  default_branch: z.string().nullable().optional(),
  ssh_url_to_repo: z.string(),
  web_url: z.string(),
  empty_repo: z.boolean().optional(),
});

/**
 * One page of a group's projects with its subgroups', or of your own, newest
 * activity first. Only projects you can clone; projects shared in from other
 * groups are left to the group that owns them. A busy GitLab is tried again
 * twice.
 */
export async function glabProjectPage(exec: Executor, ns: Namespace, self: boolean, page: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<HostRepo[]> {
  const order = `order_by=last_activity_at&sort=desc&per_page=${PROJECT_PAGE_SIZE}&page=${page}`;
  const path = self
    ? `users/${enc(ns.path)}/projects?${order}`
    : `groups/${enc(ns.path)}/projects?include_subgroups=true&with_shared=false&min_access_level=20&${order}`;
  for (let attempt = 0; ; attempt++) {
    const r = await glab(exec, ns.host, path);
    if (r.code === 0) {
      const list = z.array(project).safeParse(parseJson(r.stdout));
      if (!list.success) throw new GlabRefused('the GitLab CLI answered with something that is not a project list');
      return list.data.map((p) => ({
        name: p.name,
        path: p.path_with_namespace,
        ...(p.description ? { description: p.description } : {}),
        archived: p.archived ?? false,
        ...(p.last_activity_at ? { pushedAt: p.last_activity_at } : {}),
        ...(p.default_branch ? { defaultBranch: p.default_branch } : {}),
        sshUrl: p.ssh_url_to_repo,
        url: p.web_url,
        ...(p.empty_repo ? { empty: true } : {}),
      }));
    }
    const wait = GLAB_RETRY_WAITS_MS[attempt];
    if (wait === undefined || !busy(r.stderr)) throw new GlabRefused(`the GitLab CLI cannot list the projects of ${ns.path} on ${ns.host}: ${firstLine(r.stderr) || 'no answer'}`);
    await sleep(wait);
  }
}

/** The names at a project's top level on its default branch: none for an empty one, null when GitLab did not answer. */
export async function glabTopNames(exec: Executor, host: string, path: string): Promise<string[] | null> {
  const r = await glab(exec, host, `projects/${enc(path)}/repository/tree?per_page=100`, 30_000);
  if (r.code !== 0) return /404|not found/i.test(r.stderr) ? [] : null;
  const list = z.array(z.object({ name: z.string() })).safeParse(parseJson(r.stdout));
  return list.success ? list.data.map((n) => n.name) : null;
}

const mergeRequest = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  web_url: z.string(),
  source_branch: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_project_id: z.number(),
  target_project_id: z.number(),
});

/**
 * The open merge requests of a project from its own branches, or null when
 * glab is missing, not signed in or GitLab did not answer. Only links into
 * this project on this host, as they go into an href.
 */
export async function glabOpenMerges(exec: Executor, host: string, path: string): Promise<GitPullRequest[] | null> {
  const r = await glab(exec, host, `projects/${enc(path)}/merge_requests?state=opened&per_page=100`, 20_000);
  if (r.code !== 0) return null;
  const list = z.array(mergeRequest).safeParse(parseJson(r.stdout));
  if (!list.success) return null;
  const own = `https://${host}/${path}/-/merge_requests/`.toLowerCase();
  return list.data
    .filter((m) => m.source_project_id === m.target_project_id && m.web_url.toLowerCase() === `${own}${m.iid}`)
    .map((m) => ({ kind: 'merge' as const, number: m.iid, title: m.title, url: m.web_url, branch: m.source_branch, draft: m.draft ?? m.work_in_progress ?? false }));
}

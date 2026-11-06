import type { GitPullRequest, Namespace, OrgNamespace, OrgSettings, OrgStatus, Site } from '@devmagic-panel/shared';
import { GITHUB_HOST, gitlabHostsWith, isShared, namespaceLabel, parseNamespaceRef, repoWeb, SHARED } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { ghLogin, ghOpenPulls, ghOrgs, ghRepoPage, ghStatus, ghTopNames } from './github.js';
import { glabNamespaces, glabOpenMerges, glabProjectPage, glabSharedFilter, glabStatus, glabTopNames, glabVersion } from './gitlab.js';
import { HostRefused, type RepoHost } from './types.js';

export { HostRefused, type HostRepo, type RepoHost } from './types.js';
export { GitHostDetector } from './detect.js';

/** Every git remote of the sites, mounts under a path included. */
export const remotesOf = (sites: Site[]): string[] =>
  sites.flatMap((s) => [s.git?.remote, ...(s.mounts ?? []).map((m) => m.git?.remote)]).filter((r): r is string => Boolean(r));

/** A check reads back this far before the last one, for clocks that differ a little. */
const GITHUB_OVERLAP_MS = 10 * 60_000;
/** GitLab updates a project's activity time about once an hour, so a check reads back further. */
const GITLAB_OVERLAP_MS = 70 * 60_000;

export function githubHost(exec: Executor, sleep?: (ms: number) => Promise<void>): RepoHost {
  return {
    provider: 'github',
    host: GITHUB_HOST,
    checkOverlapMs: GITHUB_OVERLAP_MS,
    status: () => ghStatus(exec),
    login: () => ghLogin(exec),
    namespaces: async () => [...(await ghOrgs(exec)), SHARED],
    repoPage: async (ns, self, page) =>
      (await ghRepoPage(exec, isShared(ns) ? { shared: true } : self ? { self: true } : { org: ns.path }, page, sleep)).map(({ fullName, ...r }) => ({ ...r, path: fullName ?? `${ns.path}/${r.name}` })),
    topNames: (path) => ghTopNames(exec, path),
    openPulls: (path) => ghOpenPulls(exec, path),
  };
}

export function gitlabHost(exec: Executor, host: string, sleep?: (ms: number) => Promise<void>): RepoHost {
  return {
    provider: 'gitlab',
    host,
    checkOverlapMs: GITLAB_OVERLAP_MS,
    status: () => glabStatus(exec, host),
    login: async () => {
      const s = await glabStatus(exec, host);
      return s.user ?? null;
    },
    namespaces: () => glabNamespaces(exec, host),
    repoPage: (ns, self, page) => glabProjectPage(exec, ns, self, page, sleep),
    keepFor: async (ns) => (isShared(ns) ? glabSharedFilter(exec, host) : null),
    topNames: (path) => glabTopNames(exec, host, path),
    openPulls: (path) => glabOpenMerges(exec, host, path),
  };
}

/** The host a namespace lives on. */
export function hostFor(exec: Executor, ns: Namespace, sleep?: (ms: number) => Promise<void>): RepoHost {
  return ns.provider === 'github' ? githubHost(exec, sleep) : gitlabHost(exec, ns.host, sleep);
}

/** The host of a namespace ref, or null for one that is not. */
export function hostOfRef(exec: Executor, ref: string, sleep?: (ms: number) => Promise<void>): { host: RepoHost; ns: Namespace } | null {
  const ns = parseNamespaceRef(ref);
  return ns ? { host: hostFor(exec, ns, sleep), ns } : null;
}

/**
 * The GitLab hosts the panel uses, read from what is there (AGENTS rule 5):
 * the ones in the settings, the hosts of selected GitLab groups and the hosts
 * of the sites' own remotes, sites made by hand included. Empty when you use
 * no GitLab, so the Environment page shows nothing about it.
 */
export function gitlabHostsInUse(settings: Pick<OrgSettings, 'selected' | 'gitlabHosts'>, sites: Site[]): string[] {
  const found = new Set<string>(settings.gitlabHosts.map((h) => h.toLowerCase()));
  for (const ref of settings.selected) {
    const ns = parseNamespaceRef(ref);
    if (ns?.provider === 'gitlab') found.add(ns.host);
  }
  for (const remote of remotesOf(sites)) {
    const web = repoWeb(remote);
    if (web?.provider === 'GitLab') found.add(new URL(web.repoUrl).hostname);
  }
  if (found.size === 0) return [];
  // gitlab.com first when it is used, then the rest by name.
  const all = gitlabHostsWith([...found]);
  return found.has('gitlab.com') ? all : all.filter((h) => h !== 'gitlab.com');
}

/**
 * The open pull requests (GitHub) or merge requests (GitLab, yours too) of a
 * remote, through that host's CLI and its own sign-in. None for any other
 * host, or when the CLI is missing or signed out: the Git card then shows
 * none, and no error.
 */
export async function openPullsOf(exec: Executor, remote: string): Promise<GitPullRequest[]> {
  const web = repoWeb(remote);
  if (!web) return [];
  const url = new URL(web.repoUrl);
  const path = url.pathname.slice(1);
  if (web.provider === 'GitHub') return /^\w[\w.-]*\/[\w.-]+$/.test(path) ? ((await ghOpenPulls(exec, path)) ?? []) : [];
  if (web.provider === 'GitLab') return /^[\w.-]+(\/[\w.-]+)+$/.test(path) ? ((await glabOpenMerges(exec, url.hostname, path)) ?? []) : [];
  return [];
}

/** The GitLab CLI on each host: its version once, then who is signed in where. */
export async function glabOverview(exec: Executor, hosts: readonly string[]): Promise<OrgStatus['glab']> {
  const version = await glabVersion(exec);
  if (version === undefined) return { installed: false, hosts: hosts.map((host) => ({ host, installed: false, signedIn: false, problem: 'the GitLab CLI (glab) is not installed' })) };
  const statuses = await Promise.all(hosts.map(async (host) => ({ host, ...(await glabStatus(exec, host)) })));
  return { installed: true, ...(version ? { version } : {}), hosts: statuses };
}

/**
 * Every organization and group you can scan, from each CLI that is signed in:
 * GitHub, gitlab.com and your own GitLab hosts. A host that fails adds its
 * problem; the others still list.
 */
export async function listNamespaces(exec: Executor, gitlabHosts: readonly string[]): Promise<{ namespaces: OrgNamespace[]; problems: string[] }> {
  const hosts = [githubHost(exec), ...gitlabHostsWith(gitlabHosts).map((h) => gitlabHost(exec, h))];
  const results = await Promise.all(
    hosts.map(async (host) => {
      const status = await host.status();
      // A CLI that is missing or signed out lists nothing; the status says why, so no problem here.
      if (!status.signedIn) return { refs: [] as string[], problem: null };
      try {
        return { refs: await host.namespaces(), problem: null };
      } catch (error) {
        if (error instanceof HostRefused) return { refs: [] as string[], problem: error.message };
        throw error;
      }
    }),
  );
  const namespaces = results.flatMap((r) => r.refs).flatMap((ref): OrgNamespace[] => {
    const ns = parseNamespaceRef(ref);
    return ns ? [{ ref, label: namespaceLabel(ref), provider: ns.provider, host: ns.host }] : [];
  });
  return { namespaces, problems: results.flatMap((r) => (r.problem ? [r.problem] : [])) };
}

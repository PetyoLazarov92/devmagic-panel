/**
 * Web links for a site's git remote: the repository, the current branch and a
 * commit. Works for GitHub, GitLab (gitlab.com and your own), Bitbucket and
 * Gitea or Forgejo (Codeberg and your own) remotes in SSH or HTTPS form; any
 * other host gets GitHub-style links, which most hosts accept.
 */
export type WebProvider = 'GitHub' | 'GitLab' | 'Bitbucket' | 'Gitea' | 'Git';

export interface RepoWeb {
  provider: WebProvider;
  /** What to call the host in the UI: "GitHub", "Codeberg", or the host itself for your own server. */
  name: string;
  repoUrl: string;
}

/**
 * Hosts whose kind their name does not tell (git.acme.test runs GitLab,
 * gitlab.acme.test says so), and SSH aliases from ~/.ssh/config
 * (gitlab-work for gitlab.com). The panel registers them on the server and in
 * the browser, by source: the GitLab hosts in its settings, and the ones it
 * found by asking each host once over SSH. Every link helper below knows them
 * without passing them around.
 */
const knownBySource = new Map<string, Map<string, WebProvider>>();
const known = new Map<string, WebProvider>();
const aliases = new Map<string, string>();

function rebuildKnown(): void {
  known.clear();
  for (const hosts of knownBySource.values()) for (const [host, provider] of hosts) known.set(host, provider);
}

/** The hosts of one source and what they run, replacing that source's earlier list. */
export function registerGitHosts(source: string, hosts: Readonly<Record<string, 'GitLab' | 'Gitea'>>): void {
  knownBySource.set(source, new Map(Object.entries(hosts).map(([h, p]) => [h.toLowerCase(), p])));
  rebuildKnown();
}

export function registerGitlabHosts(hosts: readonly string[], source = 'settings'): void {
  registerGitHosts(source, Object.fromEntries(hosts.map((h) => [h, 'GitLab' as const])));
}

/** SSH aliases and the real host each stands for, as `ssh -G` resolves them. */
export function registerHostAliases(map: Readonly<Record<string, string>>): void {
  aliases.clear();
  for (const [alias, host] of Object.entries(map)) aliases.set(alias.toLowerCase(), host.toLowerCase());
}

/** The real host behind an SSH alias, or the host itself. */
export const realHost = (host: string): string => aliases.get(host.toLowerCase()) ?? host.toLowerCase();

const PUBLIC_NAMES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
};

/** The kind of a git host by its name, its alias and the registered hosts; `except` leaves one source out, to ask again. */
export function providerOfHost(host: string, except?: string): WebProvider {
  const h = realHost(host);
  if (h === 'github.com') return 'GitHub';
  if (h === 'bitbucket.org') return 'Bitbucket';
  const registered = except === undefined ? known.get(h) : [...knownBySource].find(([source, hosts]) => source !== except && hosts.has(h))?.[1].get(h);
  if (registered) return registered;
  if (/(^|[.-])gitlab([.-]|$)/.test(h)) return 'GitLab';
  if (h === 'codeberg.org' || /(^|[.-])(gitea|forgejo)([.-]|$)/.test(h)) return 'Gitea';
  return 'Git';
}

/** git@github.com:AcmeCo/northwind.git, ssh://..., https://... to https://github.com/AcmeCo/northwind */
export function repoWeb(remote: string): RepoWeb | null {
  const trimmed = remote.trim();
  let host: string;
  let webHost: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp?.[1] && scp[2] && !trimmed.includes('://')) {
    // An SSH alias (git@gitlab-work:acme/site.git) links to its real host.
    host = realHost(scp[1]);
    webHost = host;
    path = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) return null;
    host = url.protocol === 'ssh:' ? realHost(url.hostname) : url.hostname;
    // An HTTPS port is the web's port too (gitlab.acme.test:8443); an SSH port is not.
    webHost = url.protocol === 'https:' || url.protocol === 'http:' ? url.host : host;
    path = url.pathname;
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!host || !/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null;
  const provider = providerOfHost(host);
  return { provider, name: PUBLIC_NAMES[host.toLowerCase()] ?? host.toLowerCase(), repoUrl: `https://${webHost.toLowerCase()}/${path}` };
}

const segments = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

export function branchWebUrl(remote: string, branch: string): string | null {
  const web = repoWeb(remote);
  if (!web) return null;
  if (web.provider === 'GitLab') return `${web.repoUrl}/-/tree/${segments(branch)}`;
  if (web.provider === 'Bitbucket') return `${web.repoUrl}/src/${segments(branch)}`;
  if (web.provider === 'Gitea') return `${web.repoUrl}/src/branch/${segments(branch)}`;
  return `${web.repoUrl}/tree/${segments(branch)}`;
}

export function commitWebUrl(remote: string, hash: string): string | null {
  const web = repoWeb(remote);
  if (!web || !/^[0-9a-f]{4,40}$/i.test(hash)) return null;
  if (web.provider === 'GitLab') return `${web.repoUrl}/-/commit/${hash}`;
  if (web.provider === 'Bitbucket') return `${web.repoUrl}/commits/${hash}`;
  return `${web.repoUrl}/commit/${hash}`;
}

/**
 * A commit subject split into text and links: "#30" becomes the pull request
 * on GitHub and Bitbucket, the issue on GitLab, where "!30" is the merge
 * request, and the issue or pull request on Gitea (it sends one to the other).
 * Other hosts get no links.
 */
export function subjectLinks(remote: string | undefined, subject: string): Array<{ text: string; href?: string }> {
  const web = remote ? repoWeb(remote) : null;
  if (!web || web.provider === 'Git') return [{ text: subject }];
  const parts: Array<{ text: string; href?: string }> = [];
  let last = 0;
  // A ref stands alone, or follows this repo's own path ("team/shop!7", as GitLab writes merge requests).
  const own = new URL(web.repoUrl).pathname.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of subject.matchAll(new RegExp(`(^|[^\\w&/]|${own})([#!])(\\d{1,7})\\b`, 'g'))) {
    const [sign, number] = [m[2] as string, m[3] as string];
    const path =
      web.provider === 'GitLab' ? (sign === '!' ? `/-/merge_requests/${number}` : `/-/issues/${number}`)
      : sign === '!' ? null
      : web.provider === 'Bitbucket' ? `/pull-requests/${number}`
      : web.provider === 'Gitea' ? `/issues/${number}`
      : `/pull/${number}`;
    if (!path) continue;
    const start = (m.index ?? 0) + (m[1] as string).length;
    if (start > last) parts.push({ text: subject.slice(last, start) });
    parts.push({ text: `${sign}${number}`, href: `${web.repoUrl}${path}` });
    last = start + sign.length + number.length;
  }
  if (last < subject.length) parts.push({ text: subject.slice(last) });
  return parts;
}

/**
 * True when two remotes point at the same repository, whatever their form:
 * git@github.com:AcmeCo/site.git and https://github.com/acmeco/site match.
 */
/** One key for every way to write a repo's URL (SSH or HTTPS, with or without .git), or null for an unknown host. */
export function repoKey(url: string): string | null {
  return repoWeb(url)?.repoUrl.toLowerCase() ?? null;
}

export function sameRepo(a: string, b: string): boolean {
  const wa = repoWeb(a);
  const wb = repoWeb(b);
  return Boolean(wa && wb && wa.repoUrl.toLowerCase() === wb.repoUrl.toLowerCase());
}

/**
 * Fuzzy match for pickers: every character of the query appears in the text
 * in order, not necessarily next to each other ("tsedit" finds
 * "feature/ts-editor"). Case is ignored. Runs of matched characters, matches
 * right after a / - _ or . and matches near the start score higher, so the
 * best fits sort first. Null when the text does not match.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, positions: [] };
  const t = text.toLowerCase();
  let best: { score: number; positions: number[] } | null = null;
  // Try each place the first character occurs and keep the best alignment, so "tsedit" lights up "ts-editor", not the t of "feature".
  for (let start = t.indexOf(q[0] as string); start !== -1; start = t.indexOf(q[0] as string, start + 1)) {
    const positions = [start];
    let score = start === 0 || '/-_.'.includes(t[start - 1] as string) ? 3 : 0;
    let ok = true;
    for (const ch of q.slice(1)) {
      const prev = positions.at(-1) as number;
      const at = t.indexOf(ch, prev + 1);
      if (at === -1) {
        ok = false;
        break;
      }
      if (at === prev + 1) score += 5;
      else if ('/-_.'.includes(t[at - 1] as string)) score += 3;
      score -= Math.min(at - prev - 1, 10) * 0.1;
      positions.push(at);
    }
    if (!ok) break;
    score -= start * 0.05;
    if (!best || score > best.score) best = { score, positions };
  }
  if (!best) return null;
  // A whole-word or prefix hit beats a scattered one; shorter names win ties.
  if (t.includes(q)) best.score += 10;
  if (t.startsWith(q)) best.score += 5;
  best.score -= t.length * 0.01;
  return best;
}

/**
 * Where a remote reaches its host: the host as written (an SSH alias stays an
 * alias, so ssh uses its settings), the user and port for SSH, and whether it
 * is SSH at all. Null for anything that is not a git remote.
 */
export function remoteEndpoint(remote: string): { host: string; user: string; port?: number; ssh: boolean } | null {
  const trimmed = remote.trim();
  const scp = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp?.[1] && scp[2] && !trimmed.includes('://')) return { host: scp[2].toLowerCase(), user: scp[1], ssh: true };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol) || !url.hostname) return null;
  const ssh = url.protocol === 'ssh:';
  return { host: url.hostname.toLowerCase(), user: (ssh && url.username) || 'git', ...(ssh && url.port ? { port: Number(url.port) } : {}), ssh };
}

/**
 * Web links for a site's git remote: the repository, the current branch and a
 * commit. Works for GitHub, GitLab and Bitbucket remotes in SSH or HTTPS form.
 */
export interface RepoWeb {
  provider: 'GitHub' | 'GitLab' | 'Bitbucket' | 'Git';
  repoUrl: string;
}

/** git@github.com:AcmeCo/northwind.git, ssh://..., https://... to https://github.com/AcmeCo/northwind */
export function repoWeb(remote: string): RepoWeb | null {
  const trimmed = remote.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp?.[1] && scp[2] && !trimmed.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!host || !/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null;
  const provider = host === 'github.com' ? 'GitHub' : host.includes('gitlab') ? 'GitLab' : host === 'bitbucket.org' ? 'Bitbucket' : 'Git';
  return { provider, repoUrl: `https://${host}/${path}` };
}

const segments = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

export function branchWebUrl(remote: string, branch: string): string | null {
  const web = repoWeb(remote);
  if (!web) return null;
  if (web.provider === 'GitLab') return `${web.repoUrl}/-/tree/${segments(branch)}`;
  if (web.provider === 'Bitbucket') return `${web.repoUrl}/src/${segments(branch)}`;
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
 * on GitHub and Bitbucket and the issue on GitLab, where "!30" is the merge
 * request. Other hosts get no links.
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

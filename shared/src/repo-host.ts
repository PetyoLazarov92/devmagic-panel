import { z } from 'zod';

/**
 * Where an organization start lists repos from: GitHub organizations through
 * the GitHub CLI, GitLab groups (gitlab.com or your own GitLab) through the
 * GitLab CLI. Cloning never needs either: it is git over SSH as you.
 */
export const REPO_PROVIDERS = ['github', 'gitlab'] as const;
export type RepoProvider = (typeof REPO_PROVIDERS)[number];

export const GITHUB_HOST = 'github.com';
export const GITLAB_HOST = 'gitlab.com';

const GITHUB_ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** One part of a GitLab path: letters, digits, _ . -, not starting with - or . and not ending in . */
const GITLAB_SEGMENT = '[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?';
/** GitLab allows 20 levels of groups, then the project. */
const GITLAB_PATH = new RegExp(`^${GITLAB_SEGMENT}(?:/${GITLAB_SEGMENT}){0,20}$`);

const isGitlabPath = (path: string) =>
  path.length <= 255 && GITLAB_PATH.test(path) && !path.split('/').some((s) => /\.(git|atom)$/i.test(s) || s.includes('..'));

/** A GitLab group or project path, like acme/web/shop. */
export const gitlabPath = z.string().max(255).refine(isGitlabPath, 'A GitLab path like acme/web');

/** The hostname of a GitLab server, like gitlab.acme.test; no scheme, port or path. */
export const gitlabHost = z
  .string()
  .max(253)
  .transform((h) => h.trim().toLowerCase())
  .refine((h) => HOST.test(h) && h !== GITHUB_HOST, 'A GitLab hostname like gitlab.acme.test');

export interface Namespace {
  provider: RepoProvider;
  host: string;
  /** The organization (GitHub) or group or user path (GitLab). */
  path: string;
}

/**
 * How a namespace is written in settings, the panel's database and how a site
 * was installed: a GitHub organization by its bare name (acme), as before
 * GitLab came, and a GitLab group with its host first (gitlab.com/acme/web).
 * They never collide: a GitHub name has no dot or slash, a GitLab one always
 * starts with a hostname, which has a dot.
 */
export function parseNamespaceRef(ref: string): Namespace | null {
  if (GITHUB_ORG.test(ref)) return { provider: 'github', host: GITHUB_HOST, path: ref };
  const slash = ref.indexOf('/');
  if (slash < 1) return null;
  const host = ref.slice(0, slash);
  const path = ref.slice(slash + 1);
  if (!HOST.test(host) || host === GITHUB_HOST || !isGitlabPath(path)) return null;
  return { provider: 'gitlab', host, path };
}

export const namespaceRefOf = (ns: Namespace): string => (ns.provider === 'github' ? ns.path : `${ns.host}/${ns.path}`);

export const namespaceRef = z.string().max(300).refine((ref) => parseNamespaceRef(ref) !== null, 'An organization like acme or a GitLab group like gitlab.com/acme/web');

/** acme (GitHub), acme/web (gitlab.com) */
export function namespaceLabel(ref: string): string {
  const ns = parseNamespaceRef(ref);
  if (!ns) return ref;
  return ns.provider === 'github' ? `${ns.path} (GitHub)` : `${ns.path} (${ns.host})`;
}

/** The GitLab hosts the panel lists from: gitlab.com and the ones you added, without duplicates. */
export function gitlabHostsWith(extra: readonly string[]): string[] {
  return [...new Set([GITLAB_HOST, ...extra.map((h) => h.toLowerCase())])];
}

/**
 * The smallest set of groups that covers every group you belong to: a
 * subgroup goes when its parent is in the list, since the parent is scanned
 * with its subgroups. A subgroup whose parent you do not belong to stays.
 */
export function coveringGroups(paths: readonly string[]): string[] {
  const all = [...new Set(paths)];
  const lower = new Set(all.map((p) => p.toLowerCase()));
  return all
    .filter((p) => {
      const parts = p.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) if (lower.has(parts.slice(0, i).join('/'))) return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
}

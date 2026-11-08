import type { CliStatus, GitPullRequest, Namespace } from '@devmagic-panel/shared';

/** A host's CLI refused or did not answer: the stored list stays, with this as its problem. */
export class HostRefused extends Error {}

/** One repo as a host lists it, trimmed to what the panel keeps. */
export interface HostRepo {
  name: string;
  /** Its path on the host: wandworks/shop, wandworks/web/shop. */
  path: string;
  description?: string;
  archived: boolean;
  /** The last push (GitHub) or activity (GitLab), newest first in a listing. */
  pushedAt?: string;
  defaultBranch?: string;
  sshUrl: string;
  url: string;
  /** Known to have no commits, so there is nothing to look into. */
  empty?: boolean;
}

/**
 * What the organization start needs from a git host, through its own CLI and
 * that CLI's own sign-in: GitHub through gh, GitLab through glab. Cloning
 * never goes through these; it is git over SSH as you.
 */
export interface RepoHost {
  provider: 'github' | 'gitlab';
  host: string;
  /** How far back a check reads before the last one: GitLab updates its activity time about once an hour. */
  checkOverlapMs: number;
  status(): Promise<CliStatus>;
  /** The signed-in account, to tell your own repos from an organization's or group's. */
  login(): Promise<string | null>;
  /** The namespaces you can scan, as namespace refs: organizations or groups, and yourself. */
  namespaces(): Promise<string[]>;
  /** One page of a namespace's repos, newest first. */
  repoPage(ns: Namespace, self: boolean, page: number): Promise<HostRepo[]>;
  /** Which listed repos to keep, when a listing gives more than the namespace holds; applied after paging, so a short page still ends the listing. */
  keepFor?(ns: Namespace): Promise<((r: HostRepo) => boolean) | null>;
  /** The names at a repo's top level: none for an empty repo, null when the host did not answer. */
  topNames(path: string): Promise<string[] | null>;
  /** Open pull or merge requests from the repo's own branches, or null when the CLI cannot say. */
  openPulls(path: string): Promise<GitPullRequest[] | null>;
}

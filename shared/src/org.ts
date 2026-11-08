import { z } from 'zod';
import { type ClaudeRun, claudeRun, hostname } from './actions.js';
import { gitlabHost, namespaceRef } from './repo-host.js';
import { type InstallHow, type RepoLayout } from './sites.js';

/**
 * Installing a site from a GitHub organization or a GitLab group: the repos
 * the GitHub CLI or the GitLab CLI lists, what Claude Code reads from a repo's docs and from the Asana tasks
 * and Google files they link, and how that becomes the new site wizard's
 * answers. The local setup always wins over the docs; what nothing answers
 * stays empty for you to fill in.
 */

/** A GitHub organization or user (wandworks), or a GitLab group or user with its host (gitlab.com/wandworks/web). */
export const orgName = namespaceRef;

/** What a repo holds, from its top-level files. */
export type RepoKind = 'site' | 'wp-content' | 'theme' | 'plugin' | 'other';

export interface OrgRepo {
  /** The namespace it was listed from (wandworks, gitlab.com/wandworks/web). */
  org: string;
  name: string;
  /** Its path on its host: wandworks/shop, or wandworks/web/shop in a GitLab subgroup. */
  fullName: string;
  description?: string;
  sshUrl: string;
  url: string;
  defaultBranch?: string;
  pushedAt?: string;
  archived: boolean;
  kind: RepoKind;
  /** The repo on this machine: installed sites, archived copies, an unfinished install. */
  local?: {
    installed?: Array<{ domain: string; path?: string; how: InstallHow }>;
    archived?: { count: number; latest: string };
    draft?: { id: string; expiresAt?: string };
  };
}

/**
 * How much of an organization or group to read from its host: nothing (the stored list),
 * what is due, the repos pushed since the last check, or every repo.
 */
export const orgScanMode = z.enum(['none', 'auto', 'check', 'full']);
export type OrgScanMode = z.infer<typeof orgScanMode>;

/** An organization's repos as stored, with when they were read and why reading again failed. */
export interface OrgRepoList {
  repos: OrgRepo[];
  /** Last checked for new pushes. */
  checkedAt?: string;
  /** Last listed in full, which finds deleted, renamed and archived repos too. */
  listedAt?: string;
  /** Why this scan could not read the host; the stored list is still there. */
  problem?: string;
}

/** The Claude Code steps of an install from an organization. */
export type ClaudeStep = 'read' | 'access';

/**
 * The recommended defaults: Sonnet reads several docs into a form, which
 * Haiku gets wrong more often and Opus does no better; checking links is
 * mostly opening them, so low effort is enough.
 */
export const DEFAULT_CLAUDE_STEPS: Record<ClaudeStep, ClaudeRun> = {
  read: { model: 'sonnet', effort: 'medium', budgetUsd: 0.5 },
  access: { model: 'sonnet', effort: 'low', budgetUsd: 0.5 },
};

export interface OrgSettings {
  /** The organizations and groups to scan, as namespace refs. */
  selected: string[];
  /** Your own GitLab servers, listed beside gitlab.com. */
  gitlabHosts: string[];
  /** The hosts your own account was ticked on, once each, the first time its CLI was signed in; after that it is yours to untick. */
  accountHosts: string[];
  /** The defaults for each Claude Code step; an install can change them for itself. */
  read: ClaudeRun;
  access: ClaudeRun;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = { selected: [], gitlabHosts: [], accountHosts: [], ...DEFAULT_CLAUDE_STEPS };

/** Settings saved before effort came: one model and cap for both steps. */
function fromOneModel(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (v.read !== undefined || v.access !== undefined) return value;
  const step = (id: ClaudeStep) => ({
    ...DEFAULT_CLAUDE_STEPS[id],
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
    ...(typeof v.budgetUsd === 'number' ? { budgetUsd: v.budgetUsd } : {}),
  });
  return { ...v, read: step('read'), access: step('access') };
}

/**
 * Settings from v1.4 and v1.5 kept one flag for every host. It was set once
 * the GitHub CLI was signed in, so it stands for github.com: GitLab hosts get
 * their account ticked when glab signs in.
 */
function fromOneFlag(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const { accountsTicked, ...v } = value as Record<string, unknown>;
  return v.accountHosts === undefined && accountsTicked === true ? { ...v, accountHosts: ['github.com'] } : v;
}

export const orgSettingsInput = z.preprocess(
  (value) => fromOneFlag(fromOneModel(value)),
  z.object({
    selected: z.array(orgName).max(40),
    gitlabHosts: z.array(gitlabHost).max(10).default([]),
    accountHosts: z.array(hostname).max(20).default([]),
    read: claudeRun.default(DEFAULT_CLAUDE_STEPS.read),
    access: claudeRun.default(DEFAULT_CLAUDE_STEPS.access),
  }),
);

/** A CLI that lists repos, signed in with its own sign-in, which the panel never reads. */
export interface CliStatus {
  installed: boolean;
  signedIn: boolean;
  user?: string;
  problem?: string;
}

/** The git hosts whose kind their name does not tell: your GitLab hosts, the ones found over SSH, and SSH aliases. */
export interface GitHosts {
  gitlab: string[];
  detected: Record<string, 'GitLab' | 'Gitea'>;
  aliases: Record<string, string>;
}

/** An organization or group you can scan, as the CLIs list them. */
export interface OrgNamespace {
  ref: string;
  label: string;
  provider: 'github' | 'gitlab';
  host: string;
}

/** What the organization start needs, and what is there. */
export interface OrgStatus {
  /** Signed in at all, and with claude.ai: only that sign-in reaches the Asana and Google connectors. */
  claude: { found: boolean; path?: string; version?: string; signedIn: boolean; claudeAi: boolean };
  gh: CliStatus;
  /** The GitLab CLI on each GitLab host: gitlab.com first, then yours. */
  glab: { installed: boolean; version?: string; hosts: Array<CliStatus & { host: string }> };
  rclone: { installed: boolean; remote?: string };
  settings: OrgSettings;
}

/** The kind of a repo by the names at its top level. */
export function classifyRepo(names: string[]): RepoKind {
  const has = (n: string) => names.includes(n);
  if (has('wp-config-sample.php') || has('wp-includes') || has('wp-admin') || has('wp-content')) return 'site';
  if (has('themes') && has('plugins')) return 'wp-content';
  if (has('style.css') && has('functions.php')) return 'theme';
  if (has('readme.txt') && names.some((n) => n.endsWith('.php'))) return 'plugin';
  return 'other';
}

export const REPO_KIND_LABELS: Record<RepoKind, string> = {
  site: 'WordPress site',
  'wp-content': 'wp-content folder',
  theme: 'Theme',
  plugin: 'Plugin',
  other: 'Not a WordPress site',
};

export const layoutForKind = (kind: RepoKind): RepoLayout => (kind === 'wp-content' ? 'wp-content' : kind === 'theme' ? 'theme' : kind === 'plugin' ? 'plugin' : 'site-root');

const text = z.string().max(500);

/**
 * What Claude Code reads from a repo's docs, mostly where the database dumps
 * are: the Asana and Google links to check next. The site's addresses,
 * network and domains come from the dump alone; the production address here
 * is only offered for missing images when the dump is a local copy. Each
 * answer null or empty when the docs do not say.
 */
export const repoFacts = z.object({
  productionUrl: text.nullable(),
  /** How the docs run it locally (Docker, Lando, DDEV, Valet...), to tell you what differs. */
  docsLocalSetup: text.nullable(),
  wordpressVersion: text.nullable(),
  phpVersion: text.nullable(),
  /** A branch the docs say to work on. */
  branch: text.nullable(),
  composer: z.boolean(),
  npm: z.boolean(),
  /** Build commands the docs give for a local setup, with the folder they run in (empty for the root). */
  buildCommands: z.array(z.object({ folder: text, command: text })).max(10).default([]),
  asanaLinks: z.array(text).max(20),
  googleLinks: z.array(text).max(20),
  /** Where the docs say database dumps live, in their words. */
  dumpHints: z.array(text).max(10),
  notes: z.array(text).max(10),
  /** Which file each answer came from: field name and file path. */
  sources: z.array(z.object({ field: text, file: text })).max(40),
});
export type RepoFacts = z.infer<typeof repoFacts>;

/** What Claude Code finds behind the linked Asana tasks and Google files. */
export const accessReport = z.object({
  links: z.array(z.object({ url: text, status: z.enum(['ok', 'no-access', 'not-found']), title: text.nullable() })).max(40),
  /** Facts for the install found in tasks and docs, with where each came from. */
  facts: z.array(z.object({ text, source: text })).max(30),
  /** Database dumps in Google Drive: only their details, never their contents. */
  dumps: z
    .array(z.object({ fileId: text, name: text, sizeBytes: z.number().nullable(), modifiedAt: text.nullable(), foundIn: text }))
    .max(20),
});
export type AccessReport = z.infer<typeof accessReport>;

const ASANA = /^https:\/\/app\.asana\.com\/[\w/.?=&%-]+$/;
const GOOGLE = /^https:\/\/(?:docs|drive)\.google\.com\/[\w/.?=&%#-]+$/;
export const driveFileId = z.string().regex(/^[A-Za-z0-9_-]{10,120}$/, 'Not a Google Drive file id');
const DUMP_NAME = /^[^/\\\0]{1,200}\.(?:sql|sql\.gz|zip|gz)$/i;

/** The links Claude may follow: Asana and Google only, https, no duplicates. */
export function cleanLinks(asana: string[], google: string[]): string[] {
  return [...new Set([...asana.filter((u) => ASANA.test(u)), ...google.filter((u) => GOOGLE.test(u))])].slice(0, 30);
}

/** Claude's dump list with every entry checked: a Drive id, a dump file name, sizes and dates as numbers and dates. */
export function cleanDumps(dumps: AccessReport['dumps']): AccessReport['dumps'] {
  return dumps
    .filter((d) => driveFileId.safeParse(d.fileId).success && DUMP_NAME.test(d.name))
    .map((d) => ({ ...d, sizeBytes: d.sizeBytes !== null && Number.isFinite(d.sizeBytes) && d.sizeBytes >= 0 ? Math.round(d.sizeBytes) : null, modifiedAt: d.modifiedAt && !Number.isNaN(Date.parse(d.modifiedAt)) ? d.modifiedAt : null }))
    .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
}

/** A production address as a bare host: https://www.shop.com/x to www.shop.com; null for anything else. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  return hostname.safeParse(bare).success ? bare : null;
}

/** The wizard's answers from an organization's repo, the local setup first. */
export interface Prefill {
  repoUrl: string;
  branch: string;
  layout: RepoLayout;
  coreVersion: string;
  /** The production address the docs give, offered for missing images when the dump holds none. */
  productionHint: string;
  composer: boolean;
  npm: boolean;
  /** Worth knowing, like a branch the docs mention. */
  notes: string[];
  /** Where the docs differ from your setup, and what the panel does instead. */
  differences: string[];
  /** What nothing answered: left empty for you. */
  missing: string[];
}

/**
 * The wizard's answers for a repo besides the dump's: the build and notes
 * from Claude's reading of the docs, and your setup for how it runs here
 * (wpcore, the newest core you have, Apache). Addresses, domains and the
 * network come from the dump. What nothing answers stays empty.
 */
export function prefillFromFacts(repo: Pick<OrgRepo, 'sshUrl' | 'defaultBranch' | 'kind'>, facts: RepoFacts | null, cores: string[]): Prefill {
  const notes: string[] = [];
  const differences: string[] = [];
  const missing: string[] = [];
  const prod = hostOf(facts?.productionUrl);
  if (facts?.docsLocalSetup) differences.push(`The docs run it with ${facts.docsLocalSetup}; the panel installs it with your Apache, wpcore and MySQL instead.`);

  const newest = cores[0] ?? '';
  const wanted = facts?.wordpressVersion?.replace(/^v/i, '').trim();
  // Always the newest core you have; a version the docs name is only a note.
  const coreVersion = newest;
  if (wanted && wanted !== newest) {
    notes.push(`The docs mention WordPress ${wanted}; the newest core you have, ${newest || 'none yet'}, is picked. ${cores.includes(wanted) ? `You can pick ${wanted} on the WordPress step.` : `Add ${wanted} on the WordPress page to use it.`}`);
  }
  if (!coreVersion) missing.push('a WordPress core');
  if (facts?.phpVersion) notes.push(`The docs ask for PHP ${facts.phpVersion}; your PHP serves every site.`);
  const branch = repo.defaultBranch ?? '';
  if (facts?.branch && facts.branch !== branch) notes.push(`The docs mention the ${facts.branch} branch; the default branch ${branch || '(none)'} is picked. Change the branch if you need ${facts.branch}.`);
  if (!branch) missing.push('a branch');
  return {
    repoUrl: repo.sshUrl,
    branch,
    layout: layoutForKind(repo.kind),
    coreVersion,
    productionHint: repo.kind === 'site' || repo.kind === 'wp-content' ? (prod ?? '') : '',
    composer: facts?.composer ?? false,
    npm: facts?.npm ?? false,
    notes,
    differences,
    missing,
  };
}

/** What reading a repo found, kept on the install draft for the repo and branch it read. */
/** The tokens a Claude Code run used, as it reports them. */
export interface ClaudeTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What a Claude Code run took. The cost is Claude Code's estimate at API
 * prices: signed in with claude.ai it is not billed, and the run counts
 * toward the plan's usage limits instead.
 */
export interface ClaudeUsage {
  costUsd: number;
  durationMs?: number;
  tokens?: ClaudeTokens;
  /** What it did, a line each, the last 20, like "Reading README.md". */
  activity?: string[];
}

export const totalTokens = (t: ClaudeTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

export interface ReadResult extends ClaudeUsage {
  key: string;
  facts: RepoFacts;
  files: string[];
}

/** What checking the links found, kept on the install draft for the links it checked. */
export interface AccessResult extends ClaudeUsage {
  key: string;
  report: AccessReport;
}

/** Which answer a read belongs to: the same repo and branch read once is not read again. */
export const readKey = (fullName: string, branch: string) => `${fullName}@${branch}`;

/** Which answer a link check belongs to: the same links and dump hints. */
export const accessKey = (fullName: string, links: string[], dumpHints: string[]) => JSON.stringify([fullName, [...links].sort(), [...dumpHints].sort()]);

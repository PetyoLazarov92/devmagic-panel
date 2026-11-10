import type { CheckFix, CheckStatus } from './environment.js';
import type { LocalHelperPlugin, WpDebugConstant } from './actions.js';
import type { AccessResult, ReadResult } from './org.js';
import type { SiteServer } from './nginx.js';

/**
 * A local site as the panel shows it. Everything here is read from the system
 * (vhost, cert, wp-config.php, git, wpcore); only `notes` and `prodUrl` come
 * from sites.json.
 */
/**
 * Database name for a new site, from its primary domain: drop the local./www.
 * prefix, dots and dashes become underscores, lowercase a-z 0-9 _ only,
 * at most 64 characters (MySQL's limit). local.learn.spellbook.example gives
 * learn_spellbook_example. A copy of a site adds `__label`; taken names get `_2`.
 * Its user is the first 32 characters (MySQL's limit for users), so a name
 * whose user is among `users` counts as taken too.
 */
export function databaseNameFor(domain: string, taken: Iterable<string> = [], label?: string, users: Iterable<string> = []): string {
  const base = domain
    .toLowerCase()
    .replace(/^(www\.)?local\./, '')
    .replace(/[.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  const suffix = label ? `__${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}` : '';
  const name = `${base.slice(0, 64 - suffix.length)}${suffix}` || 'site';
  const used = new Set(taken);
  const usedUsers = new Set(users);
  const free = (candidate: string) => !used.has(candidate) && !usedUsers.has(candidate.slice(0, 32));
  if (free(name)) return name;
  for (let n = 2; ; n++) {
    const tail = `_${n}`;
    const candidate = `${name.slice(0, 64 - tail.length)}${tail}`;
    if (free(candidate)) return candidate;
    // A tail past the 32nd character leaves the user as it was: a shorter name changes it.
    const short = `${name.slice(0, 32 - tail.length)}${tail}`;
    if (free(short)) return short;
  }
}

/** Suggests the local name for a production domain: example.com gives local.example.com. */
export function localDomainFor(prodDomain: string): string {
  const host = prodDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return host.startsWith('local.') ? host : `local.${host}`;
}

export interface SiteCore {
  /** wpcore: files linked to a shared core; standalone: its own copy; none: not WordPress. */
  kind: 'wpcore' | 'standalone' | 'none';
  version?: string;
}

export interface SiteCert {
  expiresAt: string;
  names: string[];
  /** new: signed by the devmagic-panel CA; legacy: the old LocalhostCA. */
  issuer: 'new' | 'legacy' | 'unknown';
}

export interface SiteGit {
  /** `git remote get-url origin`, for links to the repo and branch. */
  remote?: string;
  branch: string;
  /** The tracked remote branch, like origin/master; null when the branch was never pushed. */
  upstream: string | null;
  dirty: number;
  /** Commits not pushed and not pulled yet; 0 when there is no upstream to compare with. */
  ahead: number;
  behind: number;
  lastCommit: { hash: string; subject: string; author: string; date: string };
}

/** Where a repo inside a site's folder sits; the site's own repo is `git` on the site. */
/** folder: a repo the panel cloned into another folder of the site, from how it was installed. */
export type SiteRepoKind = 'wp-content' | 'theme' | 'plugin' | 'mu-plugin' | 'folder';

/** A repo inside a site's own folder: wp-content, or a theme or plugin folder. */
export interface SiteRepo {
  /** From the site's folder: wp-content, wp-content/themes/wandworks. */
  folder: string;
  kind: SiteRepoKind;
  /** The theme or plugin folder's name; wp-content for wp-content. */
  name: string;
  git: SiteGit;
}

const REPO_KIND_NAMES: Record<SiteRepoKind, string> = { 'wp-content': 'wp-content', theme: 'Theme', plugin: 'Plugin', 'mu-plugin': 'Must-use plugin', folder: 'Repo' };

/** wp-content, Theme: wandworks, Plugin: wandworks-blocks */
export const siteRepoLabel = (repo: Pick<SiteRepo, 'kind' | 'name'> & { folder?: string }): string =>
  repo.kind === 'wp-content' ? 'wp-content' : repo.kind === 'folder' ? `${REPO_KIND_NAMES.folder}: ${repo.folder ?? repo.name}` : `${REPO_KIND_NAMES[repo.kind]}: ${repo.name}`;

/** The site's repos in the order the Git card shows them: its own, those inside it, then mounted folders'. */
export function siteRepos(site: Pick<Site, 'git' | 'repos' | 'mounts' | 'path'>): Array<{ label: string; git: SiteGit; repo?: string; mount?: string }> {
  // A site under a path reaches its own folder through that mount.
  const own = site.path ? { mount: site.path } : {};
  return [
    ...(site.git ? [{ label: 'Site', git: site.git, ...own }] : []),
    ...(site.repos ?? []).map((r) => ({ label: siteRepoLabel(r), git: r.git, repo: r.folder, ...own })),
    ...(site.mounts ?? []).flatMap((m) => (m.git ? [{ label: m.path, git: m.git, mount: m.path }] : [])),
  ];
}

/** The longer git view of one repo, loaded when its Git card opens. */
export interface GitDetails {
  /** Local branches, then branches only on origin; the current one is marked. */
  branches: Array<{ name: string; current: boolean; remoteOnly: boolean }>;
  /** The newest commits on the current branch. */
  commits: Array<{ hash: string; subject: string; author: string; date: string }>;
  /** Uncommitted changes, `git status --porcelain` style codes like ` M` or `??`. */
  changes: Array<{ code: string; path: string }>;
  /** When origin was last fetched, if ever. */
  fetchedAt?: string;
}

/**
 * An open pull request on GitHub (through the GitHub CLI) or merge request on
 * GitLab (through the GitLab CLI), for the branch it comes from. Ones from
 * forks are left out: their branch names say nothing about this repo's
 * branches.
 */
export interface GitPullRequest {
  /** pull: #12 on GitHub; merge: !12 on GitLab. */
  kind: 'pull' | 'merge';
  number: number;
  title: string;
  url: string;
  /** The head branch, matched to the repo's branches by name. */
  branch: string;
  draft: boolean;
}

/**
 * A WordPress network, read from MULTISITE and SUBDOMAIN_INSTALL in
 * wp-config.php and its sites from the database.
 */
export interface SiteNetwork {
  /** Where new sites go: SUBDOMAIN_INSTALL in wp-config.php. */
  mode: 'subdirectory' | 'subdomain';
  /** What the network is by where its sites are; the mode until the sites are read. */
  type: 'subdirectory' | 'subdomain' | 'mixed';
  /**
   * Its sites, at a domain an old domain mapping plugin gives one when it has
   * it. `served: false` when this site's vhost or /etc/hosts lacks the host.
   */
  sites: Array<{
    id: number;
    url: string;
    title: string;
    served?: false;
    /** Archived in Network Admin: visitors see that it is archived, a super admin can still open its wp-admin. */
    archived?: true;
    /** Marked as spam in Network Admin. */
    spam?: true;
    /** Public is off: search engines are asked not to index it. */
    hidden?: true;
  }>;
  /** Sites deleted in Network Admin but still in its blogs table, apart from the others: their tables may be gone. */
  deleted?: Array<{ id: number; url: string }>;
}

/** A network's super admins, each with how many of its sites (deleted ones left out) they have a role on. */
export interface NetworkAdmins {
  sites: number;
  admins: Array<{ login: string; member: number }>;
}

export interface SiteSalts {
  /** The keys the site's WordPress asks for, from its wp-config-sample.php. */
  names: string[];
  missing: string[];
  /** Still 'put your unique phrase here'. */
  placeholder: string[];
  /** The same value as another key. */
  duplicate: string[];
  /** SECRET_KEY or SECRET_SALT, still in wp-config.php. */
  legacy: string[];
}

export interface SiteConstant {
  name: string;
  value?: string | boolean | number;
  /** The PHP of a value that is not a plain one, like __DIR__ . '/'. */
  code?: string;
  hidden?: true;
}

export interface SiteIssue {
  /** Stable code for the kind of problem, like `cert.uncovered`. */
  id: string;
  status: Exclude<CheckStatus, 'ok'>;
  text: string;
  /** What to do by hand when there is no one-click fix. */
  hint?: string;
  fix?: CheckFix;
}

/** Mailpit's default SMTP address, where Local mode sends mail, and its web UI. */
export const MAILPIT_SMTP = { host: '127.0.0.1', port: 1025 } as const;
export const MAILPIT_WEB = 'http://localhost:8025/';

/**
 * The Local mode mu-plugin: mail goes to Mailpit, search engines are told
 * not to index, a Local label shows in the admin bar, logins work from this
 * computer only and chosen outgoing hosts are blocked.
 */
export interface SiteLocalMode {
  enabled: boolean;
  /** False when the file on disk is an older version than the panel writes. */
  current: boolean;
  blockedHosts: string[];
  /** Repos in wp-content/repos with a theme in a folder of theirs: each is one more themes folder to WordPress. */
  themeFolders?: string[];
  /** Production host the plugin sends missing uploads to, for vhosts the panel did not make. */
  uploadsFrom?: string;
}

/** One Aura finding: a site problem, or a machine one when `domain` is absent. */
export interface AuraItem extends SiteIssue {
  domain?: string;
  /** For a site under a path of the domain, like /learn. */
  path?: string;
}

export interface AuraReport {
  checkedAt: string;
  items: AuraItem[];
}

export interface Site {
  /** The host the site answers on; for a site under a path, its parent's domain. */
  domain: string;
  /**
   * Set for a WordPress install under a path of the domain (an Alias in the
   * domain's vhost), like /learn: its own folder, database, git and tools,
   * while the vhost, certificate and hosts line stay the parent's.
   */
  path?: string;
  /** When it came here: the install time the panel recorded, else when its folder was made (or last changed, where the filesystem keeps no creation time). */
  addedAt?: string;
  aliases: string[];
  docroot: string;
  /** False for vhosts made by hand or by devmagic: the panel leaves those files as they are. */
  vhostManaged: boolean;
  /**
   * The web server that has the site: Apache, nginx in front of its Apache
   * vhost, or nginx with PHP-FPM (both nginx modes point its hosts line at
   * nginx's address).
   */
  server: SiteServer;
  /**
   * Moving the site to another server (site.setServer), for a site of its own
   * (not one under a path).
   */
  move?: SiteMove;
  /** True when the panel can move the site to Deleted sites: its folder is WEB_DIR/<domain> and its vhost <domain>-ssl.conf or <domain>.conf. */
  removable: boolean;
  /** True for sites the panel created (its vhost marker and its folder in the registry). */
  panelMade: boolean;
  title?: string;
  core: SiteCore;
  /** The PHP version the site runs, and whether it is its own (a PHP-FPM pool) or the default. */
  php?: { version: string; own: boolean };
  /** Set when the site is a multisite network. */
  network?: SiteNetwork;
  cert?: SiteCert;
  /** Names of the site that /etc/hosts does not point to this machine; left out when all are there. */
  notInHosts?: string[];
  git?: SiteGit;
  /** Repos inside the site's folder: wp-content, themes, plugins; at most 20. */
  repos?: SiteRepo[];
  db?: { name: string; sizeBytes: number; tables: number };
  debug: {
    enabled: boolean;
    logBytes: number;
    /** Each debug constant as wp-config.php sets it, or null when it leaves it to WordPress's default. */
    constants: Record<WpDebugConstant, boolean | null>;
  };
  /**
   * Every constant wp-config.php defines, in its order, read from the file
   * (not run): a value, the PHP code when it is not a plain value, or hidden
   * for secrets, whose value never leaves the server.
   */
  constants?: SiteConstant[];
  /** WordPress's keys and salts in wp-config.php: which its WordPress asks for, and which it would not use. */
  salts?: SiteSalts;
  /** WordPress sites only. */
  localMode?: SiteLocalMode;
  /** The id of the install job while the site is still being created; its actions wait until then. */
  installing?: string;
  /** Another job working on the site now, like a removal or an import: its actions wait until it ends. */
  busy?: { jobId?: string; title: string };
  /** Where missing uploads load from: the panel's vhost rule, Local mode for vhosts made by hand, or BE Media from Production. */
  uploadsFrom?: { host: string; via: 'apache' | 'local-mode' | 'plugin' };
  /** BE Media from Production, when the site has it: on in the database (null when it cannot be read), and the host its constant names. */
  mediaPlugin?: { active: boolean | null; host?: string };
  /** Extra docroots served under a path, like Spellbook's /learn; each can be its own repo. */
  mounts?: Array<{ path: string; docroot: string; git?: SiteGit }>;
  prodUrl?: string;
  notes?: string;
  /** How the site came to this machine. */
  install?: SiteInstall;
  health: CheckStatus;
  issues: SiteIssue[];
}

/** How a site came to this machine: by the panel (and from what), restored from an archive, or by hand. */
export const INSTALL_HOWS = ['organization', 'repo', 'wordpress', 'empty', 'restore', 'panel', 'hand'] as const;
export type InstallHow = (typeof INSTALL_HOWS)[number];
export const INSTALL_HOW_LABELS: Record<InstallHow, string> = {
  organization: 'From an organization or group',
  repo: 'From a repo',
  wordpress: 'Fresh WordPress',
  empty: 'Empty site',
  restore: 'Restored',
  panel: 'Made by the panel',
  hand: 'Made by hand',
};

/** One plugin of a site, as WP-CLI lists it, with what the panel knows about it. */
export interface SitePlugin {
  /** The slug WP-CLI takes, like wp-rocket. */
  name: string;
  title: string;
  /** Must-use plugins and drop-ins always load; they cannot be turned on or off. */
  status: 'active' | 'inactive' | 'active-network' | 'must-use' | 'dropin';
  version: string;
  /** A newer version WordPress already found; the panel makes no update check of its own. */
  update?: string;
  /** Plugins this one needs, from its Requires Plugins header. */
  requires?: string[];
  /** Titles of the active plugins that need this one. */
  requiredBy?: string[];
  /** Turned off at install as production-only. */
  productionOnly?: true;
  /** One of the local helpers, like Query Monitor. */
  localHelper?: true;
  /** From the site's folder: its folder (wp-content/plugins/acf), or its one file for a plugin like hello.php. */
  path?: string;
  /** The plugin is one file right in the plugins folder, so path is a file. */
  oneFile?: true;
  /** From its header, as plain text. */
  description?: string;
  author?: string;
}

export interface SitePlugins {
  plugins: SitePlugin[];
  /** A multisite network: plugins are turned on network-wide. */
  network: boolean;
}

/** A theme a site has, as WP-CLI lists it, with where its folder is. */
export interface SiteTheme {
  name: string;
  title: string;
  /** active: this site's theme; parent: the one an active child theme takes its templates from. */
  status: 'active' | 'parent' | 'inactive';
  version: string;
  /** A newer version WordPress already found. */
  update?: string;
  /** Its folder in the site: wp-content/themes/wandworks, or wp-content/repos/theme-kit/wandworks. */
  folder: string;
  /** In a repo of its own under wp-content/repos, which Local mode makes a themes folder. */
  inRepo?: true;
}

export interface SiteThemes {
  themes: SiteTheme[];
  /** A multisite network: each site has a theme of its own; this is the main site's. */
  network: boolean;
}

export interface SiteInstall {
  how: InstallHow;
  /** When it was installed or restored; unknown for sites made by hand. */
  at?: string;
  /** The repo it was cloned from (the main one). */
  repo?: string;
  /** Every repo the install cloned, with its path in the site ('' for the site root). */
  repos?: Array<{ url: string; branch: string; path: string }>;
  /** The organization it was picked from. */
  org?: string;
  /** For a restore: when the copy it came from was archived. */
  archivedAt?: string;
  /** Steps of the install that failed and were skipped, with what is left to do. */
  skipped?: Array<{ label: string; todo: string }>;
  /** A site made by hand the panel took over: when, its vhost files kept to give back, its folder, and how many lines its vhost lost. */
  takenOver?: { at: string; files: string[]; docroot: string; dropped: number };
}

/** A plugin on WordPress.org: its name and latest version. */
export interface WporgPlugin {
  name: string;
  version: string;
}

/** A theme a dump names: the active one of a site, or the parent a child theme needs. */
export interface DumpTheme {
  /** Its folder in wp-content/themes. */
  name: string;
  /** Only as the parent of an active child theme. */
  parent?: true;
  /** On a network: on how many sites it is the theme. */
  sites?: number;
  /** The version production ran, from WordPress's update check. */
  version?: string;
}

/** A plugin a dump names: see DumpFacts.plugins. */
export interface DumpPlugin {
  /** Its file in wp-content/plugins: akismet/akismet.php, or hello.php. */
  file: string;
  /** Active on the main site, a network's other sites or network-wide. */
  active: boolean;
  network?: boolean;
  /** On a network: on how many sites it is active. */
  sites?: number;
  /** The version production ran, from WordPress's update check. */
  version?: string;
  /** Its slug on WordPress.org, when WordPress's update check found it there. */
  slug?: string;
}

/** A plugin or theme a server has, as its WP-CLI lists it. */
export interface ServerItem {
  /** Its folder, or a single-file plugin's name without .php. */
  name: string;
  version?: string;
  /** active, inactive, active-network, must-use, dropin, parent. */
  status?: string;
}

/** What a site's server has that could be copied from it: its plugins and themes. */
export interface ServerFiles {
  plugins: ServerItem[];
  themes: ServerItem[];
}

/** What taking over a site made by hand would do, read by dmp-root vhost-adopt --check. */
export interface TakeoverPreview {
  /** Its vhost files in sites-available, and the enabled ones. */
  files: string[];
  enabled: string[];
  /** Its names; the panel's vhost answers to the same. */
  names: string[];
  /** Its folder, right in WEB_DIR. */
  docroot?: string;
  /** Sites under a path it serves: /learn=local.learn.spellbook.example. */
  mounts: string[];
  /** Lines the panel's vhost does not have: left out with dropLines, kept in the originals. */
  extra: string[];
  /** Its own lines in /etc/hosts outside the panel's block: they move into the takeover record, and Give back puts them back. */
  hostsLines: string[];
  /** Lines there that name it with other hosts: they stay, and keep it off nginx until edited by hand. */
  hostsShared: string[];
  /** Why it cannot be taken over now. */
  problems: string[];
}

export interface SiteLog {
  /** The file read; for Apache it may be the shared error.log. */
  file: string;
  /** True when other sites write to the same file and lines are filtered for this one. */
  shared: boolean;
  exists: boolean;
  lines: LogLine[];
}

export interface LogLine {
  time: string;
  level: 'fatal' | 'error' | 'warning' | 'notice' | 'deprecated' | 'info';
  message: string;
  source?: string;
}

export type RepoLayout = 'site-root' | 'wp-content' | 'theme' | 'plugin';

export type NewSiteSource = 'empty' | 'wordpress' | 'repo';

export interface RunStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output?: string;
  durationMs?: number;
  /** How far a running step is, 0 to 1, when it can tell. */
  progress?: number;
  /** What the step is doing now, like "1.2 GB of 3.4 GB, 2 min left". */
  note?: string;
  /** What it did so far, a line each, the last 20: Claude Code's steps list their tool calls here. */
  activity?: string[];
  /** Set when the job may go on without this step: what skipping it leaves undone, and how to do it yourself. */
  skippable?: string;
}

export interface RunSummary {
  id: number;
  action: string;
  title: string;
  target?: string;
  ok: boolean | null;
  /** The panel stopped (restart, reboot, logout) before the run finished. */
  interrupted?: true;
  /** Steps the job finished without (Skip and continue). */
  skipped?: number;
  startedAt: string;
  durationMs?: number;
}

/** A page of Run history, newest first. */
export interface RunPage {
  runs: RunSummary[];
  /** 1 is the newest page. */
  page: number;
  pageSize: number;
  /** Every run kept; older ones are pruned after RUN_KEEP_DAYS days or beyond RUN_KEEP_MAX runs. */
  total: number;
}

/** Run history keeps runs this many days, and at most this many runs. */
export const RUN_KEEP_DAYS = 90;
export const RUN_KEEP_MAX = 2000;

/** One run with what it printed; its job too while the panel still holds it in memory. */
export interface RunDetail extends RunSummary {
  /** The input as stored: fields called password read "(hidden)". */
  input: unknown;
  output: string;
  jobId?: string;
}

/**
 * How much SQL the dump scan reads, unpacked: most dumps to the end, where
 * the users tables are. A 7 GB dump reads in under a minute.
 */
export const DUMP_SCAN_GB = 16;

/** What the wizard reads from a database dump without importing it. */
export interface DumpFacts {
  tablePrefix?: string;
  siteUrl?: string;
  home?: string;
  dbVersion?: number;
  multisite: boolean;
  /** For a network: true when sites live on their own hosts, false when under paths of one host. */
  subdomainInstall?: boolean;
  /** For a network: its path on the main host, from the site table (usually /). */
  networkPath?: string;
  /**
   * For a network: its sites from the blogs table with their blog id and name,
   * main site first (at most 500). A site an old domain mapping plugin gives a
   * domain is at that domain, `mapped`.
   */
  sites?: Array<{ id: number; domain: string; path: string; name?: string; mapped?: true }>;
  /** For a network: it maps domains to its sites with a plugin's own table (WordPress MU Domain Mapping, Mercator). */
  domainMapping?: true;
  /** The hosts the dump's addresses use (home first, then siteurl and a network's domains), with a port when they have one. */
  hosts: string[];
  /** Plugin slugs active on the main site, and network-wide for a multisite, when the dump says. */
  activePlugins?: string[];
  /**
   * Every plugin the dump names, by its file in wp-content/plugins: active on
   * the main site, on other sites of a network (how many) or network-wide,
   * and the ones production had installed but not active, from WordPress's
   * own update check (its version there, and its WordPress.org slug when the
   * check found it there) or the recently turned off list.
   */
  plugins?: DumpPlugin[];
  /** The themes the dump's sites use, and the parents their child themes need. */
  themes?: DumpTheme[];
  /** True when the scan stopped after DUMP_SCAN_GB of a very large dump, before its users. */
  partial: boolean;
  /**
   * The hosts the dump has http:// links for, plain or as JSON escapes them,
   * with a port when they have one; unset when the scan did not read the whole
   * dump, so every host is taken to have them.
   */
  httpHosts?: string[];
  /**
   * Each table the dump creates (a plain CREATE TABLE) and the hosts its rows
   * have after two slashes, case kept; '*' for a table with too many to list.
   * Search and replace leaves out a table with none it looks for. Unset when
   * the scan did not read the whole dump or could not tell rows' tables.
   */
  tableHosts?: Record<string, string[]>;
  /**
   * The dump makes a view, trigger, procedure, function or event, which an
   * import cannot swap in from a side database; unset when the scan did not
   * read the whole dump.
   */
  storedObjects?: boolean;
  /** The main site's administrators by login, oldest first; unset when the scan did not read the users through. */
  admins?: string[];
  /** For a network: its super admins by login. */
  superAdmins?: string[];
}

/** The services sites depend on, and Xdebug for Apache's PHP. */
/** What Clean this database reads from a site's live database before it runs. */
export interface CleanPreview {
  /** The database's tables, for what the clean-up would remove. */
  tables: string[];
  prefix: string;
  multisite: boolean;
  /** Its administrators by login (a network's super admins), oldest first. */
  admins: string[];
  sizeBytes: number;
  /** The rows of the tables it empties, which the copy leaves out. */
  leftOutBytes?: number;
  /** Why it cannot be cleaned here, when it cannot. */
  blocked?: string;
}

export interface ServicesReport {
  checkedAt: string;
  services: Array<{
    id: 'apache' | 'nginx' | 'mysql' | 'mailpit' | 'cron';
    label: string;
    state: 'running' | 'stopped' | 'missing';
    detail: string;
    /** Only Apache, nginx (once the panel set it up) and MySQL can be restarted from the panel. */
    canRestart: boolean;
    /** For Mailpit when it is not running: the panel can install it, or start the copy it installed. */
    offer?: 'install' | 'start';
  }>;
  /** The PHP version Apache's mod_php loads (or PHP-FPM's for every site once mod_php is off), and the command line's full version; the PHP tab has the rest. */
  php: { apache?: string; fpm?: string; cli?: string };
}

/** WordPress.org's word on a release: the newest, an older safe one, or one with known security issues. */
export type CoreSecurity = 'latest' | 'outdated' | 'insecure';

/** The shared cores and who uses them, for the WordPress cores page. */
export interface CoresReport {
  coresDir: string;
  /** False when wpcore has no config or cores folder yet. */
  ready: boolean;
  /** The newest WordPress release, when WordPress.org could be asked. */
  latest?: string;
  /** Sites by name: local.shop.com, or local.spellbook.example/learn for one under a path. */
  cores: Array<{ version: string; status?: CoreSecurity; sites: string[] }>;
  /** Sites with their own copy of WordPress, which wpcore does not manage. */
  standalone: Array<{ domain: string; version: string; status?: CoreSecurity }>;
  /** Releases worth adding: the newest of each recent branch, not installed yet. */
  available: Array<{ version: string; status: CoreSecurity }>;
  /** Every release with known security issues, newest first; adding one needs a typed confirmation. */
  insecure: string[];
}

/** A database snapshot of one site, newest first in lists. */
export interface SnapshotInfo {
  name: string;
  /** Why it was taken, like before-import, or a label you typed. */
  label?: string;
  sizeBytes: number;
  createdAt: string;
}

/** What the leftover check found in a clean copy: email addresses per table, a few masked as samples. */
export interface LeftoverEmails {
  total: number;
  /** The tables with the most, at most 10. */
  tables: Array<{ table: string; count: number; samples: string[] }>;
}

/** A site's tables a swap kept aside in a database of their own, until purgeAt. */
export interface KeptDatabaseInfo {
  name: string;
  reason: string;
  createdAt: string;
  purgeAt: string;
  /** Data and indexes, when the MySQL admin account can read it. */
  sizeBytes?: number;
}

/** A gzipped dump of a site's clean database, made to share with the team. */
export interface CleanCopyInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  leftoverEmails?: LeftoverEmails;
}

/** A site in Deleted sites: archived by dmp-root, restorable until purgeAt. */
/**
 * An unfinished install: the wizard's answers and the files it holds, kept
 * for 24 hours after the last change so you can continue or change it.
 * While its install runs it stays; once that is done it goes, with its files.
 */
export interface InstallDraft {
  id: string;
  kind: 'manual' | 'organization';
  /** What it installs, like local.shop.com or wandworks/shop. */
  title: string;
  /** The wizard step it is on. */
  step: string;
  /** The wizard's answers; never a password. */
  state: unknown;
  /** Uploads and downloads it holds, by upload id. */
  uploads: string[];
  status: 'open' | 'installing' | 'failed';
  jobId?: string;
  /** Kept by the server, never by the wizard's saves: the newest job per step, with what it is for (readKey, accessKey). */
  jobs?: Partial<Record<'read' | 'access' | 'dump', { id: string; key?: string }>>;
  /** What those jobs found, so leaving the page loses nothing. */
  results?: { read?: ReadResult; access?: AccessResult };
  /** Dumps a job brought in for it: kept until the draft goes, whatever the wizard saves. */
  attached?: string[];
  createdAt: string;
  updatedAt: string;
  /** When it goes if nothing changes; none while its install runs. */
  expiresAt?: string;
}

/** Why a site went to the archive: deleted, or replaced by a reinstall or a restore. */
export const ARCHIVE_REASONS = ['deleted', 'reinstall', 'restore'] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface TrashEntry {
  id: string;
  domain: string;
  deletedAt: string;
  purgeAt: string;
  sizeBytes: number;
  panelMade: boolean;
  dbName?: string;
  reason: ArchiveReason;
  /** The archive holds the database export. */
  hasDump: boolean;
  /** How the site had been installed, when the panel knew. */
  install?: SiteInstall;
  /** A site at this domain exists now: restoring replaces it, after it goes to the archive; refusal says why it cannot. */
  replaces?: { refusal: string | null };
  /** A job working on this domain now, like this entry's restore: Restore and Delete wait until it ends. */
  busy?: { jobId?: string; title: string };
}

/** What removing a site would take, for the confirmation. */
export interface RemovalInfo {
  /** Null when the panel cannot move it to Deleted sites, with the reason. */
  refusal: string | null;
  sizeBytes?: number;
  freeBytes?: number;
  trashDays: number;
}

/** A message Mailpit caught, as the Mail page lists it. */
export interface MailSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  /** The site that sent it, from the tag Local mode adds; null for mail from elsewhere. */
  site: string | null;
  read: boolean;
}

export interface MailPage {
  total: number;
  messages: MailSummary[];
}

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  text: string;
  html: string;
}

export interface UploadResult {
  id: string;
  name: string;
  size: number;
  facts: DumpFacts;
  suggestions: { replace: Array<{ from: string; to: string }> };
}

export interface JobView {
  id: string;
  title: string;
  target?: string;
  /** The action that started it, like site.create. */
  kind?: string;
  /** Queued waits for a free slot: at most two site installs run at once. */
  status: 'queued' | 'running' | 'done' | 'failed' | 'undoing' | 'undone';
  steps: RunStep[];
  undo: RunStep[];
  /** What Undo would take back, newest first; empty when the job made nothing it can remove, like a restore. */
  undoable: string[];
  /** The whole job, 0 to 1: finished steps plus the running one, weighted by how long each usually takes. */
  progress: number;
  startedAt: string;
  /** Its row in Run history. */
  runId: number;
  /** Stop ends it at its next safe point, like between two batches of a clean-up. */
  stoppable?: boolean;
  /** Stop was asked for and the job ends at its next safe point. */
  stopping?: boolean;
}

/** One thing install.sh put on the machine, from its root-owned list. */
export interface InstalledPath {
  /** file, dir, link, line, store, modules, packages or setting. */
  kind: string;
  path: string;
  /** What the uninstaller does with it: remove it, ask you, or keep it. */
  onUninstall: 'remove' | 'ask' | 'keep';
  note: string;
  exists: boolean;
  sizeBytes?: number;
}

/** One entry of a folder the Developer options open: its name and kind, never its contents. */
export interface FolderEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  sizeBytes?: number;
  modifiedAt?: string;
  /** Where a link points, and whether that is a folder. */
  target?: string;
  targetKind?: 'dir' | 'file' | 'missing';
}

/** A folder's entries, folders first, at most FOLDER_ENTRIES of them. */
export interface FolderListing {
  path: string;
  entries: FolderEntry[];
  /** How many more entries the folder has. */
  more: number;
  /** Why it could not be listed, like a folder only root can read. */
  error?: string;
}

/** The most entries a folder listing returns: a release's node_modules alone holds thousands. */
export const FOLDER_ENTRIES = 200;

/** The hidden Developer options: versions, services, settings, files and logs. */
export interface DeveloperReport {
  version: string;
  /** git describe of the repository the panel runs from. */
  commit?: string;
  node: string;
  repo: string;
  /** The running server process. */
  server: { pid: number; startedAt: string; memoryBytes: number; nodePath: string; port: number; runningJobs: number };
  /** The services the panel needs, with whether each runs now and starts at boot. */
  services: ServiceState[];
  /** Whether your user services keep running after you log out; null when unknown. */
  linger: boolean | null;
  config: Array<{ key: string; value: string }>;
  /** null until install.sh has written its list (installs before v0.5.0). */
  installedFiles: InstalledPath[] | null;
  panelFiles: Array<{ path: string; note: string; exists: boolean; sizeBytes?: number; kind: 'dir' | 'file' }>;
  logs: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
}

/** One systemd unit as the Developer options show it. */
export interface ServiceState {
  unit: string;
  label: string;
  /** user: your systemd user instance; system: the machine's. */
  scope: 'user' | 'system';
  /** active, inactive, failed, or not installed. */
  active: string;
  /** enabled starts it at boot (a user service with lingering on, before you log in). */
  enabled: string;
  since?: string;
}

/** A release installed in the panel's releases folder, one it can switch to. */
export interface InstalledRelease {
  /** The folder name: v0.6.0, or v0.6.0-dev.1a2b3c4 for one built from a checkout. */
  name: string;
  version: string;
  /** The one `current` points at, which the panel runs. */
  current: boolean;
  installedAt: string;
  built?: string;
  /** panel: the panel can switch to it; terminal: its root scripts differ from the installed ones, so its install.sh does it. */
  mode: 'panel' | 'terminal';
  /** For terminal: its install.sh, the command that switches to it. */
  command?: string;
  /** Its install.sh has --from-panel (0.25.0 and later), so the Updates page can install it with your sudo password. */
  fromPanel?: true;
  /**
   * From the changelog of the newest release here: what switching to it adds
   * (a newer one) or removes (an older one), newest first, or what the
   * running one changed. Missing when no changelog has its versions.
   */
  changes?: { kind: 'adds' | 'removes' | 'running'; sections: ChangelogSection[] };
}

/** One version's part of the changelog. */
export interface ChangelogSection {
  version: string;
  date?: string;
  items: string[];
}

/** Whether a newer release is out, what it brings, and how it gets installed. */
/** The ways the panel reaches its releases, in the order it tries them. */
export const UPDATE_WAYS = ['https', 'gh', 'git'] as const;
export type UpdateWay = (typeof UPDATE_WAYS)[number];
export const UPDATE_WAY_LABELS: Record<UpdateWay, string> = {
  https: 'public GitHub releases',
  gh: 'the GitHub CLI',
  git: 'git over SSH',
};

export interface UpdateStatus {
  /** The running version, like 0.6.0. */
  current: string;
  /** The release the panel runs from, like v0.6.0; none when it runs from a checkout. */
  release?: string;
  /** The newest release, like v0.6.1. */
  latest?: string;
  available: boolean;
  checkedAt: string;
  /** The way that read the releases this time. */
  source?: UpdateWay;
  /** When no way could read them: why each one failed. */
  access?: Array<{ way: UpdateWay; problem: string }>;
  /** What each release newer than the running one changes, from its release notes. */
  changelog: ChangelogSection[];
  /** panel: the Update button installs it; terminal: the panel downloads it and you run `command`; blocked: see reason. */
  mode: 'panel' | 'terminal' | 'blocked';
  reason?: string;
  /** The panel updates itself, but the release changes install.sh too: run `command` afterwards for that part. */
  installerChanged?: true;
  /** For terminal: what to run once the panel downloaded it; with installerChanged, what to run after the update. */
  command?: string;
  /** The size of the release package, for the confirmation. */
  packageBytes?: number;
  /** No way could read the releases, or reading one failed. */
  error?: string;
  /** A one-time note, like the GitHub token an older panel saved being deleted. */
  notice?: string;
  /** Installed releases, newest first. */
  releases: InstalledRelease[];
  /** The last install from the Updates page (install.sh --from-panel), as it went. */
  install?: InstallStatus & { interrupted?: true };
}

/** What install.sh --from-panel wrote to update-status.json. */
export interface InstallStatus {
  release: string;
  /** The release the panel ran before. */
  previous: string;
  state: 'running' | 'done' | 'failed';
  /** Where it is or stopped: password, packages, config, scripts, backup, system, restart, finish. */
  step: string;
  message: string;
  /** A failure put everything back, the release before included. */
  rolledBack: boolean;
  started: string;
  finished: string;
  /** The install log. */
  log: string;
}

export type BuildTool = 'composer' | 'npm' | 'yarn' | 'pnpm';

/** A build the repo lookup found: a composer.json or package.json in a folder of the repo. */
export interface RepoBuild {
  /** The folder in the repo, empty for its root. */
  dir: string;
  tool: BuildTool;
  /** For npm, yarn and pnpm: the scripts that build and end, never a watcher or a server. */
  scripts: string[];
  /** The one picked: build, prod, production or build:prod when there. */
  script?: string;
  /** Ticked by default: what it makes is not in the repo. */
  needed: boolean;
  /** Why it is ticked or not, in a few words. */
  why: string;
  /** What it makes is in the repo already: the docs naming its build do not tick it. */
  builtInRepo?: boolean;
  /** Scripts that run their builds with concurrently --kill-others, so the first to finish stops the rest. */
  stopsOthers?: string[];
  /** The Node it would run on and why, like "Node 16.20.2 from nvm (node-sass 7 runs on Node 16 at most)", or why none can be picked. */
  node?: string;
}

/** What the repo's branch holds for the WordPress step: the local helpers, BE Media from Production, and its builds. */
export interface RepoLookup {
  helpers: LocalHelperPlugin[];
  mediaPlugin: boolean;
  builds: RepoBuild[];
  /** The Nodes nvm has, newest first: what a build can be put on. */
  nodes?: string[];
  /** What the repo holds by its top level: a whole site, wp-content, a theme or a plugin. */
  kind?: 'site' | 'wp-content' | 'theme' | 'plugin' | 'other';
  /** The theme is this folder of the repo, not the repo itself: it goes to wp-content/repos, which Local mode makes a themes folder. */
  themeIn?: string;
  /** It holds WordPress core (wp-admin and wp-includes), and the version its wp-includes/version.php names. */
  core?: { version?: string };
  /** It keeps media in wp-content/uploads. */
  uploads?: boolean;
  /** The plugins it holds, as paths in the repo of each plugins folder's entries: wp-content/plugins/akismet, plugins/hello.php. */
  plugins?: string[];
  /** The themes it holds, as paths in the repo of each themes folder's entries: wp-content/themes/wandworks, themes/wandworks. */
  themes?: string[];
}

/** What the site page needs to move a site between web servers. */
export interface SiteMove {
  /** Why the site cannot run on a server; a server not listed here is open to it. */
  refusals: Partial<Record<SiteServer, string>>;
  /** The .htaccess rules nginx with PHP-FPM would not read. */
  ignored: string[];
  /** The PHP-FPM version the site would run on with nginx alone. */
  php?: string;
  /** With nginx in front of Apache. */
  front: {
    /** Folders with an .htaccess of their own, which always go to Apache, like /wp-content/uploads/wc-logs. */
    apachePaths: string[];
    /** Rules of the root .htaccess about images, CSS, JS or fonts, which do not run for the ones nginx serves itself. */
    staticRules: string[];
    /** Whether nginx serves those files itself now, for a site in front of Apache already. */
    static?: boolean;
  };
}

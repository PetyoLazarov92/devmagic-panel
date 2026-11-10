import type { FileListing, FileTrashEntry, FileView, HtaccessChanges, HtaccessReport, ActionId, ActionRunResult, ApacheReport, DbCellQuery, DbCellValue, DbOverview, DbRowsPage, DbRowsQuery, CleanupInfo, DbQuery, DbQueryResult, DbSchema, DbStructure, MysqlProcess, ProfileList, ProfileSummary, SlowQueryReport, RowChangeInfo, WriteCheck, WpDbReport, WpDbSection, NginxReport, NginxState, CronReport, CronRunView, WpCronReport, AssistantSettings, AuraReport, Briefing, ChatReply, ChatTurn, CleanCopyInfo, CleanPreview, CoresReport, DeveloperReport, EnvironmentReport, FolderListing, GitDetails, GitPullRequest, InstallDraft, JobView, KeptDatabaseInfo, LocalHelperPlugin, MailMessage, MailPage, GitHosts, OrgNamespace, OrgRepoList, OrgScanMode, LocalConstant, OrgSettings, OrgStatus, Preferences, PreferencesUpdate, QueuedProposal, RcloneRemotes, RememberedRepo, RemoteEntry, ProductionSettings, ServerFiles, ServerSignIn, ServerTables, RepoPreset, RepoTrustAnswer, TakeoverPreview, TrustedOwner, DumpPlugin, DumpTheme, WporgPlugin, RemovalInfo, RepoInspection, RepoLookup, RunDetail, RunPage, RunStep, MysqlReport, MysqlSettings, NetworkAdmins, PhpFpmFinding, PhpInfo, PhpIniReport, PhpPackage, PhpReport, PhpSettings, ServicesReport, SiteCompat, SitePhp, SessionInfo, Site, SiteLog, SitePlugins, SiteThemes, SnapshotInfo, TrashEntry, UpdateStatus, UploadResult, UploadsCompare, UploadsHere, VersionCompat, WizardSuggestion } from '@devmagic-panel/shared';
import type { CreateSiteInput } from '@/lib/plan';
import { noteStatus, refused } from '@/lib/session-watch';
import { mockApi } from '@/mock/api';
import { mockFileUrl } from '@/mock/files';

/** ?path=/learn (or &path=) for a site under a path; nothing for a site at its domain's root. */
const atPath = (path: string | undefined, sep: '?' | '&') => (path ? `${sep}path=${encodeURIComponent(path)}` : '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The rest of the answer, like retryAt on a 429. */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The answer to a request made after the session ended: it does not go out. */
const loggedOut = () => new ApiError(401, 'Log in first');

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (refused(url)) throw loggedOut();
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  noteStatus(url, res.status);
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data as Record<string, unknown>);
  return data as T;
}

/** What the wizard saves as a draft; the server sets its status and times. */
export interface DraftInput {
  kind?: 'manual' | 'organization';
  title: string;
  step: string;
  state: Record<string, unknown>;
  uploads: string[];
}

export interface Api {
  session: () => Promise<SessionInfo & { setupRequired: boolean }>;
  /** The running panel's version from /healthz, or null while it does not answer (a restart). */
  health: () => Promise<string | null>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** When the panel password was last set. */
  passwordInfo: () => Promise<{ changedAt?: string }>;
  changePassword: (current: string, next: string) => Promise<void>;
  /** The ways back in when the password is forgotten, and how long the computer-password way is locked. */
  resetWays: () => Promise<{ system: boolean; reason?: string; command: string; lockedUntil?: string }>;
  resetPassword: (system: string, next: string) => Promise<void>;
  environment: () => Promise<EnvironmentReport>;
  assistant: () => Promise<AssistantSettings>;
  saveAssistant: (settings: Partial<Pick<AssistantSettings, 'enabled' | 'model'>>) => Promise<AssistantSettings>;
  saveAssistantKey: (apiKey: string) => Promise<AssistantSettings>;
  removeAssistantKey: () => Promise<AssistantSettings>;
  testAssistant: () => Promise<{ ok: boolean; error?: string }>;
  briefing: () => Promise<Briefing>;
  chat: (messages: ChatTurn[]) => Promise<ChatReply>;
  proposals: () => Promise<QueuedProposal[]>;
  closeProposal: (id: string, status: 'ran' | 'dismissed') => Promise<void>;
  mcpCommand: () => Promise<{ command: string }>;
  conventions: () => Promise<{ text: string; saved: boolean; path: string }>;
  saveConventions: (text: string) => Promise<{ text: string; saved: boolean; path: string }>;
  suggestWizard: (input: { description: string; repoUrl?: string; branch?: string; uploadId?: string }) => Promise<WizardSuggestion>;
  services: () => Promise<ServicesReport>;
  /** Every database and account on the MySQL server, for the Services page's MySQL tab. */
  mysql: () => Promise<MysqlReport>;
  mysqlSettings: () => Promise<MysqlSettings>;
  /** The database browser: a database's tables, a table's structure, a page of its rows and one value in full. */
  dbOverview: (database: string) => Promise<DbOverview>;
  dbStructure: (database: string, table: string) => Promise<DbStructure>;
  dbRows: (database: string, table: string, query: DbRowsQuery) => Promise<DbRowsPage>;
  dbCell: (database: string, table: string, query: DbCellQuery) => Promise<DbCellValue>;
  /** What SQL that writes would change, before it runs. */
  checkWrite: (database: string, sql: string) => Promise<WriteCheck>;
  /** What MySQL runs now. */
  mysqlProcesses: () => Promise<MysqlProcess[]>;
  /** The queries that cost the most time, of one database or every site's. */
  slowQueries: (database?: string) => Promise<SlowQueryReport>;
  /** Xdebug's profiles of a site, or all of them. */
  profiles: (domain?: string, path?: string) => Promise<ProfileList>;
  profile: (version: string, name: string) => Promise<ProfileSummary>;
  /** The clean-ups saved for Undo on a database, or one site of it (local.shop.com/learn). */
  cleanups: (database: string, site?: string) => Promise<CleanupInfo[]>;
  /** Table and column names, for the SQL editor's suggestions. */
  dbSchema: (database: string) => Promise<DbSchema>;
  /** The row changes saved for Undo on a table, newest first. */
  rowChanges: (database: string, table: string) => Promise<RowChangeInfo[]>;
  /** One statement that reads, run as the read-only account. */
  dbQuery: (database: string, query: DbQuery) => Promise<DbQueryResult>;
  /** A WordPress site's database as WordPress sees it; blog picks a site of a network. */
  /** The WordPress view of a site's database; sections picks the parts to read, sizes reads every postmeta value for its size. */
  wordpressDb: (domain: string, path?: string, blog?: number, options?: { sections?: readonly WpDbSection[]; sizes?: boolean; signal?: AbortSignal }) => Promise<WpDbReport>;
  /** The report kept from the last reads of the WordPress view, at once; undefined when there is none. */
  wordpressDbKept: (domain: string, path?: string, blog?: number) => Promise<WpDbReport | undefined>;
  /** The vhosts, modules and configtest for the Apache tab, and Apache's own error log. */
  apache: () => Promise<ApacheReport>;
  apacheLog: () => Promise<SiteLog>;
  /** nginx next to Apache for the nginx tab: installed, set up, nginx -t, configs; and nginx's own error log. */
  nginx: () => Promise<NginxReport>;
  nginxLog: () => Promise<SiteLog>;
  /** Whether a new site can run on nginx, for the new site wizard. */
  nginxState: () => Promise<NginxState>;
  /** The installed PHP versions for the PHP tab, and per version its php.ini changes and PHP's own info. */
  php: () => Promise<PhpReport>;
  phpIni: (version: string) => Promise<PhpIniReport>;
  phpInfo: (version: string, sapi: 'web' | 'cli') => Promise<PhpInfo>;
  phpFpmCheck: () => Promise<PhpFpmFinding[]>;
  phpSettings: (version: string) => Promise<PhpSettings>;
  phpPackages: (version: string) => Promise<PhpPackage[]>;
  phpVersionCompat: (version: string) => Promise<VersionCompat>;
  /** A site's PHP version and settings, and PHP info from the PHP that serves it. */
  sitePhp: (domain: string, path?: string) => Promise<SitePhp>;
  sitePhpCompat: (domain: string, path?: string) => Promise<SiteCompat>;
  sitePhpInfo: (domain: string, path?: string) => Promise<PhpInfo>;
  aura: () => Promise<AuraReport>;
  runAction: (id: ActionId, input: Record<string, unknown>) => Promise<ActionRunResult>;
  sites: () => Promise<Site[]>;
  site: (domain: string, path?: string) => Promise<Site | null>;
  logs: (domain: string, source: 'debug' | 'apache', path?: string) => Promise<SiteLog>;
  /** The site's repo, or a mounted folder's when `mount` is set (like /learn). */
  gitDetails: (domain: string, mount?: string, repo?: string) => Promise<GitDetails>;
  /** Open pull requests (GitHub) or merge requests (GitLab) by branch; none when the CLI is missing or signed out, or origin is elsewhere. */
  gitPulls: (domain: string, mount?: string, repo?: string) => Promise<GitPullRequest[]>;
  snapshots: (domain: string, path?: string) => Promise<SnapshotInfo[]>;
  /** Gzipped clean copies of the site's database, to share with the team. */
  cleanCopies: (domain: string, path?: string) => Promise<CleanCopyInfo[]>;
  /** The site's tables swaps kept aside, until they are purged. */
  keptDatabases: (domain: string, path?: string) => Promise<KeptDatabaseInfo[]>;
  /** What Clean this database would remove and who could stay, read from the site's live database. */
  cleanPreview: (domain: string, path?: string) => Promise<CleanPreview>;
  /** Every plugin of a site, read with WP-CLI. */
  plugins: (domain: string, path?: string) => Promise<SitePlugins>;
  themes: (domain: string, path?: string) => Promise<SiteThemes>;
  /** One folder of a site's files; dir is relative to the site's folder. */
  files: (domain: string, dir: string, path?: string) => Promise<FileListing>;
  /** One file to look at: its text, or what it is. */
  fileView: (domain: string, file: string, path?: string) => Promise<FileView>;
  /** What the Files tab deleted on a site and can still put back, newest first. */
  fileTrash: (domain: string, path?: string) => Promise<FileTrashEntry[]>;
  /** What the site has in wp-content/uploads, the room on its disk and the last copy from its server. */
  uploadsHere: (domain: string, path?: string) => Promise<UploadsHere>;
  /** The uploads on the site's server next to the ones here, folder by folder. Only reads, on both sides. */
  compareUploads: (domain: string, path: string | undefined, server: { host: string; folder: string; wpCli?: string; password?: string }) => Promise<UploadsCompare>;
  /** Sends one file to the panel, where file.upload picks it up by its id and puts it in a folder. */
  stageFile: (file: File, onProgress: (fraction: number) => void) => Promise<{ id: string; sizeBytes: number }>;
  /** Your crontab: the panel's tasks with their last run, your own lines, and system cron read only. */
  cron: () => Promise<CronReport>;
  /** A task's runs, newest first, without output. */
  cronRuns: (id: string) => Promise<CronRunView[]>;
  /** One run with its output. */
  cronRun: (run: number) => Promise<CronRunView>;
  /** A site's WP-Cron events and intervals, how WP-Cron runs there, and its cron tasks; url picks a network site. */
  wpCron: (domain: string, path?: string, url?: string) => Promise<WpCronReport>;
  /** wp cron test: whether WordPress can start WP-Cron by itself. */
  wpCronTest: (domain: string, path?: string, url?: string) => Promise<{ ok: boolean; output: string }>;
  networkAdmins: (domain: string, path?: string) => Promise<NetworkAdmins>;
  /** A repo's default branch, and the answers from its last install here. */
  inspectRepo: (url: string, branch?: string) => Promise<RepoInspection>;
  /** The local helper plugins a branch already has. */
  /** The local helpers the repo's branch has, and whether it has BE Media from Production. */
  repoHelpers: (url: string, branch: string) => Promise<RepoLookup>;
  /** How often each host appears in an uploaded dump: anywhere, in URLs and in emails. Reads the whole dump. */
  /** Starts an action that runs as a job (site.create, db.*) and answers with the job id. */
  startJob: (id: ActionId, input: Record<string, unknown>) => Promise<string>;
  /** Newest first, 50 at a time; `before` gives the page after that run id. */
  runs: (page?: number) => Promise<RunPage>;
  developer: () => Promise<DeveloperReport>;
  developerLog: (name: string) => Promise<{ name: string; text: string }>;
  developerStartup: () => Promise<{ text: string }>;
  developerFolder: (path: string) => Promise<FolderListing>;
  /** Whether a newer release is out; refresh asks the repository again. */
  update: (refresh?: boolean) => Promise<UpdateStatus>;
  /** How the panel looks, kept in its database: theme, the sites' view and order. */
  preferences: () => Promise<Preferences>;
  savePreferences: (update: PreferencesUpdate) => Promise<Preferences>;
  /** The constants every local site should have, from Settings. */
  localConstants: () => Promise<LocalConstant[]>;
  saveLocalConstants: (list: LocalConstant[]) => Promise<LocalConstant[]>;
  rememberedRepos: () => Promise<RememberedRepo[]>;
  saveRememberedRepo: (key: string, preset: RepoPreset) => Promise<{ ok: true }>;
  forgetRememberedRepo: (key: string) => Promise<{ ok: true }>;
  run: (id: number) => Promise<RunDetail>;
  cores: () => Promise<string[]>;
  /** fresh: ask WordPress.org for its release list now, not the panel's hour-old copy. */
  coresReport: (fresh?: boolean) => Promise<CoresReport>;
  /** Streams a multi-step run; resolves true when every step succeeded. */
  playRun: (steps: RunStep[], onUpdate: (steps: RunStep[]) => void, failAt?: string) => Promise<boolean>;
  upload: (file: File, onProgress: (fraction: number) => void) => Promise<UploadResult>;
  /** Drops a dump the wizard no longer uses. */
  deleteUpload: (id: string) => Promise<unknown>;
  createSite: (input: CreateSiteInput) => Promise<string>;
  removeSite: (domain: string) => Promise<string>;
  /** Whether a site can go to Deleted sites, its size and the free space there. */
  removal: (domain: string) => Promise<RemovalInfo>;
  /** A site's .htaccess files read for nginx, and for a site on nginx what its file has. */
  htaccess: (domain: string) => Promise<HtaccessReport>;
  /** Changes to the .htaccess files of sites on nginx after since, and the time to ask from next. */
  htaccessChanges: (since?: string) => Promise<HtaccessChanges>;
  /** Deleted sites, newest first. */
  trash: () => Promise<TrashEntry[]>;
  /** What installing from an organization needs, and its settings. */
  orgStatus: () => Promise<OrgStatus>;
  saveOrgSettings: (settings: OrgSettings) => Promise<OrgSettings>;
  /** One small Claude Code run: which connectors it reaches. */
  orgTest: () => Promise<{ asana: boolean; drive: boolean; docs: boolean; costUsd: number }>;
  /** Organizations and groups from each signed-in CLI, and what a host that failed said. */
  orgOrgs: () => Promise<{ namespaces: OrgNamespace[]; problems: string[] }>;
  /** Your own GitLab hosts, the ones found over SSH and SSH aliases, so links to them are right. */
  gitHosts: () => Promise<GitHosts>;
  orgRepos: (org: string, scan: OrgScanMode) => Promise<OrgRepoList>;
  /** Dumps in your Downloads folder from the last days. */
  downloads: () => Promise<Array<{ file: string; name: string; sizeBytes: number; modifiedAt: string }>>;
  rcloneRemotes: () => Promise<RcloneRemotes>;
  /** A server's tables with their sizes, over SSH and read only, for leaving the rows of some out. */
  /** How a server signs you in over SSH: with your key, or with a password. Runs nothing there but true. */
  serverSignIn: (host: string) => Promise<ServerSignIn>;
  /** password: the server's own, when it asks for one; for this read only. */
  serverTables: (host: string, path: string, password?: string, wpCli?: string) => Promise<ServerTables>;
  /** The plugins and themes a server has, read only, for copying the ones a site lacks. */
  serverFiles: (host: string, path: string, password?: string, wpCli?: string) => Promise<ServerFiles>;
  /** What a site keeps for Refresh from production; null until it is set up. */
  productionSettings: (domain: string, path?: string) => Promise<ProductionSettings | null>;
  saveProductionSettings: (domain: string, path: string | undefined, settings: ProductionSettings) => Promise<ProductionSettings>;
  takeoverPreview: (domain: string) => Promise<TakeoverPreview>;
  missingPlugins: (domain: string, path?: string) => Promise<DumpPlugin[]>;
  wporgPlugins: (slugs: string[]) => Promise<Record<string, WporgPlugin | null>>;
  /** The themes a site's database uses that its files lack, and whether themes are on WordPress.org. */
  missingThemes: (domain: string, path?: string) => Promise<DumpTheme[]>;
  wporgThemes: (slugs: string[]) => Promise<Record<string, WporgPlugin | null>>;
  remoteList: (remote: string, path: string) => Promise<RemoteEntry[]>;
  repoTrust: (url: string) => Promise<RepoTrustAnswer>;
  trustedOwners: () => Promise<TrustedOwner[]>;
  trustOwner: (host: string, owner: string) => Promise<TrustedOwner[]>;
  untrustOwner: (host: string, owner: string) => Promise<TrustedOwner[]>;
  /** An upload's facts, for a dump a job brought in. */
  uploadInfo: (id: string) => Promise<UploadResult>;
  /** Unfinished installs, newest first. */
  drafts: () => Promise<InstallDraft[]>;
  draft: (id: string) => Promise<InstallDraft>;
  saveDraft: (id: string, draft: DraftInput) => Promise<InstallDraft>;
  discardDraft: (id: string) => Promise<void>;
  job: (id: string) => Promise<JobView>;
  /** Mail Mailpit caught, newest first, from one site or all. */
  mail: (site?: string, start?: number) => Promise<MailPage>;
  /** Messages nobody opened; null while Mailpit is not running. */
  mailUnread: () => Promise<{ unread: number | null }>;
  mailMessage: (id: string) => Promise<MailMessage>;
  /** Queued, running and recent jobs. */
  jobs: () => Promise<JobView[]>;
  retryJob: (id: string) => Promise<JobView>;
  /** Asks a stoppable job to end at its next safe point. */
  stopJob: (id: string) => Promise<JobView>;
  skipJob: (id: string) => Promise<JobView>;
  undoJob: (id: string) => Promise<JobView>;
}

/** fetch() cannot report upload progress, so files go up with XHR. */
function xhrUpload<T>(url: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  if (refused(url)) return Promise.reject(loggedOut());
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      noteStatus(url, xhr.status);
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText) as T & { error?: string };
        } catch {
          return { error: `Upload failed (${xhr.status})` } as T & { error?: string };
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: the connection dropped'));
    xhr.send(file);
  });
}
const uploadWithProgress = (file: File, onProgress: (fraction: number) => void) => xhrUpload<UploadResult>(`/api/uploads?name=${encodeURIComponent(file.name)}`, file, onProgress);

const notWired = () => Promise.reject(new ApiError(501, 'Not wired to the server yet (Phase 1 mockup)'));

const realApi: Api = {
  session: () => request('GET', '/api/session'),
  health: () =>
    fetch('/healthz', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ version?: string }>) : null))
      .then((data) => data?.version ?? null, () => null),
  login: (password) => request('POST', '/api/login', { password }),
  logout: () => request('POST', '/api/logout', {}),
  passwordInfo: () => request('GET', '/api/password'),
  changePassword: (current, next) => request('POST', '/api/password', { current, next }),
  resetWays: () => request('GET', '/api/password/reset'),
  resetPassword: (system, next) => request('POST', '/api/password/reset', { system, next }),
  environment: () => request('GET', '/api/environment'),
  assistant: () => request('GET', '/api/assistant'),
  saveAssistant: (settings) => request('PUT', '/api/assistant', settings),
  saveAssistantKey: (apiKey) => request('PUT', '/api/assistant/key', { apiKey }),
  removeAssistantKey: () => request('DELETE', '/api/assistant/key', {}),
  testAssistant: () => request('POST', '/api/assistant/test', {}),
  briefing: () => request('GET', '/api/assistant/briefing'),
  chat: (messages) => request('POST', '/api/assistant/chat', { messages }),
  proposals: () => request('GET', '/api/proposals'),
  closeProposal: (id, status) => request('POST', `/api/proposals/${encodeURIComponent(id)}/close`, { status }),
  mcpCommand: () => request('GET', '/api/mcp'),
  conventions: () => request('GET', '/api/assistant/conventions'),
  saveConventions: (text) => request('PUT', '/api/assistant/conventions', { text }),
  suggestWizard: (input) => request('POST', '/api/assistant/wizard', input),
  services: () => request('GET', '/api/services'),
  mysql: () => request('GET', '/api/mysql'),
  mysqlSettings: () => request('GET', '/api/mysql/settings'),
  dbOverview: (database) => request('GET', `/api/mysql/databases/${encodeURIComponent(database)}`),
  dbStructure: (database, table) => request('GET', `/api/mysql/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}`),
  // POSTs: a filter's value or a row's key is data, and stays out of URLs and Apache's log.
  dbRows: (database, table, query) => request('POST', `/api/mysql/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/rows`, query),
  dbCell: (database, table, query) => request('POST', `/api/mysql/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/cell`, query),
  checkWrite: (database, sql) => request('POST', `/api/mysql/databases/${encodeURIComponent(database)}/check-write`, { sql }),
  mysqlProcesses: () => request('GET', '/api/mysql/processes'),
  slowQueries: (database) => request('GET', `/api/mysql/slow-queries${database ? `?database=${encodeURIComponent(database)}` : ''}`),
  profiles: (domain, path) => request('GET', `/api/profiles${domain ? `?domain=${encodeURIComponent(domain)}${path ? `&path=${encodeURIComponent(path)}` : ''}` : ''}`),
  profile: (version, name) => request('GET', `/api/profiles/${encodeURIComponent(version)}/${encodeURIComponent(name)}`),
  cleanups: (database, site) => request('GET', `/api/mysql/databases/${encodeURIComponent(database)}/cleanups${site ? `?site=${encodeURIComponent(site)}` : ''}`),
  dbSchema: (database) => request('GET', `/api/mysql/databases/${encodeURIComponent(database)}/schema`),
  rowChanges: (database, table) => request('GET', `/api/mysql/databases/${encodeURIComponent(database)}/row-changes?table=${encodeURIComponent(table)}`),
  dbQuery: (database, query) => request('POST', `/api/mysql/databases/${encodeURIComponent(database)}/query`, query),
  wordpressDb: (domain, path, blog, options = {}) => {
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    if (blog && blog !== 1) query.set('blog', String(blog));
    if (options.sections) query.set('sections', options.sections.join(','));
    if (options.sizes) query.set('sizes', '1');
    const q = query.toString();
    return request('GET', `/api/sites/${encodeURIComponent(domain)}/db/wordpress${q ? `?${q}` : ''}`, undefined, options.signal);
  },
  wordpressDbKept: (domain, path, blog) => {
    const query = new URLSearchParams({ cached: '1' });
    if (path) query.set('path', path);
    if (blog && blog !== 1) query.set('blog', String(blog));
    return request<WpDbReport | undefined>('GET', `/api/sites/${encodeURIComponent(domain)}/db/wordpress?${query.toString()}`);
  },
  apache: () => request('GET', '/api/apache'),
  apacheLog: () => request('GET', '/api/apache/log'),
  nginx: () => request('GET', '/api/nginx'),
  nginxLog: () => request('GET', '/api/nginx/log'),
  nginxState: () => request('GET', '/api/nginx/state'),
  php: () => request('GET', '/api/php'),
  phpIni: (version) => request('GET', `/api/php/${encodeURIComponent(version)}/ini`),
  phpInfo: (version, sapi) => request('GET', `/api/php/${encodeURIComponent(version)}/info?sapi=${sapi}`),
  phpFpmCheck: () => request('GET', '/api/php/fpm-check'),
  phpSettings: (version) => request('GET', `/api/php/${encodeURIComponent(version)}/settings`),
  phpPackages: (version) => request('GET', `/api/php/${encodeURIComponent(version)}/packages`),
  phpVersionCompat: (version) => request('GET', `/api/php/${encodeURIComponent(version)}/compat`),
  sitePhp: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/php${atPath(path, '?')}`),
  sitePhpCompat: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/php/compat${atPath(path, '?')}`),
  sitePhpInfo: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/php/info${atPath(path, '?')}`),
  aura: () => request('GET', '/api/aura'),
  runAction: (id, input) => request('POST', `/api/actions/${id}`, input),
  sites: () => request('GET', '/api/sites'),
  site: async (domain, path) => {
    try {
      return await request<Site>('GET', `/api/sites/${encodeURIComponent(domain)}${atPath(path, '?')}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  logs: (domain, source, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/logs?source=${source}${atPath(path, '&')}`),
  gitDetails: (domain, mount, repo) => request('GET', `/api/sites/${encodeURIComponent(domain)}/git${gitQuery(mount, repo)}`),
  gitPulls: (domain, mount, repo) => request('GET', `/api/sites/${encodeURIComponent(domain)}/git/pulls${gitQuery(mount, repo)}`),
  snapshots: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/snapshots${atPath(path, '?')}`),
  cleanCopies: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/clean-copies${atPath(path, '?')}`),
  keptDatabases: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/kept-databases${atPath(path, '?')}`),
  cleanPreview: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/clean-preview${atPath(path, '?')}`),
  plugins: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/plugins${atPath(path, '?')}`),
  themes: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/themes${atPath(path, '?')}`),
  files: (domain, dir, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/files?dir=${encodeURIComponent(dir)}${atPath(path, '&')}`),
  fileView: (domain, file, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/files/view?file=${encodeURIComponent(file)}${atPath(path, '&')}`),
  fileTrash: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/files/trash${atPath(path, '?')}`),
  uploadsHere: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/uploads${atPath(path, '?')}`),
  compareUploads: (domain, path, server) => request('POST', `/api/sites/${encodeURIComponent(domain)}/uploads/compare`, { ...(path ? { path } : {}), ...server }),
  stageFile: (file, onProgress) => xhrUpload('/api/files/uploads', file, onProgress),
  cron: () => request('GET', '/api/cron'),
  cronRuns: (id) => request('GET', `/api/cron/tasks/${encodeURIComponent(id)}/runs`),
  cronRun: (run) => request('GET', `/api/cron/runs/${run}`),
  wpCron: (domain, path, url) => request('GET', `/api/sites/${encodeURIComponent(domain)}/wp-cron?${new URLSearchParams({ ...(path ? { path } : {}), ...(url ? { url } : {}) })}`),
  wpCronTest: (domain, path, url) => request('GET', `/api/sites/${encodeURIComponent(domain)}/wp-cron/test?${new URLSearchParams({ ...(path ? { path } : {}), ...(url ? { url } : {}) })}`),
  networkAdmins: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/network-admins${atPath(path, '?')}`),
  inspectRepo: (url, branch) => request('GET', `/api/repo/inspect?url=${encodeURIComponent(url)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`),
  repoHelpers: (url, branch) => request('GET', `/api/repo/helpers?url=${encodeURIComponent(url)}&branch=${encodeURIComponent(branch)}`),
  startJob: async (id, input) => {
    const result = await request<ActionRunResult>('POST', `/api/actions/${id}`, input);
    if (!result.data?.jobId) throw new ApiError(500, result.output || 'The job did not start');
    return result.data.jobId;
  },
  runs: (page) => request('GET', page === undefined || page === 1 ? '/api/runs' : `/api/runs?page=${page}`),
  run: (id) => request('GET', `/api/runs/${id}`),
  developer: () => request('GET', '/api/developer'),
  developerLog: (name) => request('GET', `/api/developer/logs/${encodeURIComponent(name)}`),
  developerStartup: () => request('GET', '/api/developer/startup'),
  developerFolder: (path) => request('GET', `/api/developer/folder?path=${encodeURIComponent(path)}`),
  update: (refresh) => request('GET', refresh ? '/api/update?refresh=1' : '/api/update'),
  preferences: () => request('GET', '/api/preferences'),
  savePreferences: (update) => request('PUT', '/api/preferences', update),
  localConstants: () => request('GET', '/api/local-constants'),
  saveLocalConstants: (list) => request('PUT', '/api/local-constants', list),
  rememberedRepos: () => request('GET', '/api/remembered/repos'),
  saveRememberedRepo: (key, preset) => request('PUT', '/api/remembered/repos', { key, preset }),
  forgetRememberedRepo: (key) => request('POST', '/api/remembered/repos/forget', { key }),
  cores: () => request('GET', '/api/cores'),
  coresReport: (fresh) => request('GET', `/api/cores/report${fresh ? '?fresh=1' : ''}`),
  playRun: notWired,
  upload: uploadWithProgress,
  deleteUpload: (id) => request('DELETE', `/api/uploads/${encodeURIComponent(id)}`),
  createSite: async (input) => {
    const result = await request<ActionRunResult>('POST', '/api/actions/site.create', input);
    if (!result.data?.jobId) throw new ApiError(500, result.output || 'The install did not start');
    return result.data.jobId;
  },
  removal: (domain) => request('GET', `/api/sites/${encodeURIComponent(domain)}/removal`),
  htaccess: (domain) => request('GET', `/api/sites/${encodeURIComponent(domain)}/htaccess`),
  htaccessChanges: (since) => request('GET', `/api/htaccess/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  trash: () => request('GET', '/api/trash'),
  orgStatus: () => request('GET', '/api/org/status'),
  saveOrgSettings: (settings) => request('PUT', '/api/org/settings', settings),
  orgTest: () => request('POST', '/api/org/test', {}),
  orgOrgs: () => request('GET', '/api/org/orgs'),
  gitHosts: () => request('GET', '/api/git-hosts'),
  orgRepos: (org, scan) => request('GET', `/api/org/repos?${new URLSearchParams({ org, scan })}`),
  downloads: () => request('GET', '/api/downloads'),
  rcloneRemotes: () => request('GET', '/api/dumps/remotes'),
  serverSignIn: (host) => request('POST', '/api/dumps/server-sign-in', { host }),
  serverTables: (host, path, password, wpCli) => request('POST', '/api/dumps/server-tables', { host, path, ...(password ? { password } : {}), ...(wpCli ? { wpCli } : {}) }),
  serverFiles: (host, path, password, wpCli) => request('POST', '/api/dumps/server-files', { host, path, ...(password ? { password } : {}), ...(wpCli ? { wpCli } : {}) }),
  productionSettings: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/production${atPath(path, '?')}`),
  saveProductionSettings: (domain, path, settings) => request('PUT', `/api/sites/${encodeURIComponent(domain)}/production${atPath(path, '?')}`, settings),
  takeoverPreview: (domain) => request('GET', `/api/sites/${encodeURIComponent(domain)}/takeover`),
  missingPlugins: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/missing-plugins${atPath(path, '?')}`),
  wporgPlugins: (slugs) => request('POST', '/api/wporg/plugins', { slugs }),
  missingThemes: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/missing-themes${atPath(path, '?')}`),
  wporgThemes: (slugs) => request('POST', '/api/wporg/themes', { slugs }),
  remoteList: (remote, path) => request('POST', '/api/dumps/remote-list', { remote, path }),
  repoTrust: (url) => request('GET', `/api/repo-trust?url=${encodeURIComponent(url)}`),
  trustedOwners: () => request('GET', '/api/trusted-owners'),
  trustOwner: (host, owner) => request('POST', '/api/trusted-owners', { host, owner }),
  untrustOwner: (host, owner) => request('POST', '/api/trusted-owners/remove', { host, owner }),
  uploadInfo: (id) => request('GET', `/api/uploads/${encodeURIComponent(id)}`),
  drafts: () => request('GET', '/api/drafts'),
  draft: (id) => request('GET', `/api/drafts/${encodeURIComponent(id)}`),
  saveDraft: (id, draft) => request('PUT', `/api/drafts/${encodeURIComponent(id)}`, draft),
  discardDraft: async (id) => {
    await request('DELETE', `/api/drafts/${encodeURIComponent(id)}`, {});
  },
  removeSite: async (domain) => {
    const result = await request<ActionRunResult>('POST', '/api/actions/site.remove', { domain, confirm: domain });
    if (!result.data?.jobId) throw new ApiError(500, result.output || 'Removing did not start');
    return result.data.jobId;
  },
  job: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`),
  jobs: () => request('GET', '/api/jobs'),
  mail: (site, start) => request('GET', `/api/mail?${new URLSearchParams({ ...(site ? { site } : {}), ...(start ? { start: String(start) } : {}) })}`),
  mailMessage: (id) => request('GET', `/api/mail/${encodeURIComponent(id)}`),
  mailUnread: () => request('GET', '/api/mail/unread'),
  retryJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/retry`, {}),
  stopJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/stop`, {}),
  skipJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/skip`, {}),
  undoJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/undo`, {}),
};

/** A site's file as it is: a download, or with show the image itself (the server shows only png, jpg, gif and webp). */
export const fileUrl = (domain: string, file: string, path?: string, show = false) =>
  isMockup ? mockFileUrl(file, show) : `/api/sites/${encodeURIComponent(domain)}/files/raw?file=${encodeURIComponent(file)}${show ? '&show=1' : ''}${atPath(path, '&')}`;

/** Files and folders of one folder of a site as one zip, made for this download. */
export const zipUrl = (domain: string, files: readonly string[], path?: string) =>
  `/api/sites/${encodeURIComponent(domain)}/files/zip?${files.map((f) => `file=${encodeURIComponent(f)}`).join('&')}${atPath(path, '&')}`;

/** Where the browser downloads a clean copy from. */
export const cleanCopyUrl = (domain: string, name: string, path?: string) =>
  `/api/sites/${encodeURIComponent(domain)}/clean-copies/${encodeURIComponent(name)}${atPath(path, '?')}`;

/** Where the browser downloads a snapshot from. */
/** An Xdebug profile as it was written, for KCachegrind or an IDE. */
export const profileUrl = (version: string, name: string) => `/api/profiles/${encodeURIComponent(version)}/${encodeURIComponent(name)}/download`;

export const snapshotUrl = (domain: string, name: string, path?: string) =>
  `/api/sites/${encodeURIComponent(domain)}/snapshots/${encodeURIComponent(name)}${atPath(path, '?')}`;

/** A database, or the tables named, as a gzipped dump to download (the server streams it from mysqldump). */
export const dbExportUrl = (database: string, tables: readonly string[] = []) => {
  const q = new URLSearchParams();
  for (const t of tables) q.append('table', t);
  const query = q.toString();
  return `/api/mysql/databases/${encodeURIComponent(database)}/export${query ? `?${query}` : ''}`;
};

/** `npm run mockup` serves the UI on sample data, with no server behind it. */
export const isMockup = import.meta.env.VITE_MOCK === '1';

/** The mockup built for the public demo (npm run build:demo): it speaks to visitors and links to the real panel. */
export const isDemo = isMockup && import.meta.env.VITE_DEMO === '1';

/** Where the demo sends a visitor for the real panel. */
export const DEMO_HOME = 'https://webtimeless.cloud/devmagic-panel/';

/**
 * The mockup's own session: logging out and in works, ?session=ends ends
 * it 15 seconds after the page opens, to show the login dialog, and
 * ?panel=starting answers 503 for the first 8 seconds, like Apache while the
 * panel starts, to show the waiting page.
 */
function withMockSession(mock: Api): Api {
  let signedIn = true;
  const params = new URLSearchParams(window.location.search);
  if (params.get('session') === 'ends') window.setTimeout(() => (signedIn = false), 15_000);
  const startsAt = params.get('panel') === 'starting' ? Date.now() + 8000 : 0;
  const guarded = Object.fromEntries(
    Object.entries(mock).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        if (refused('/api/mock')) return Promise.reject(loggedOut());
        if (!signedIn) {
          noteStatus('/api/mock', 401);
          return Promise.reject(loggedOut());
        }
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as Api;
  return {
    ...guarded,
    session: async () => {
      if (Date.now() < startsAt) throw new ApiError(503, 'Request failed (503)');
      return { ...(await mock.session()), authenticated: signedIn };
    },
    // Open without a session, like the server's own routes for a forgotten password.
    resetWays: mock.resetWays,
    resetPassword: mock.resetPassword,
    login: async () => {
      signedIn = true;
    },
    logout: async () => {
      signedIn = false;
    },
  };
}

const base: Api = isMockup ? withMockSession(mockApi) : realApi;

/** Fired when an action starts a job, so the header shows it without waiting for its next poll. */
export const JOB_STARTED = 'dmp:job-started';

/** ?mount=/learn&repo=wp-content/themes/wandworks for one repo of a site; empty for its own. */
function gitQuery(mount?: string, repo?: string): string {
  const q = new URLSearchParams({ ...(mount ? { mount } : {}), ...(repo ? { repo } : {}) }).toString();
  return q ? `?${q}` : '';
}

export const api: Api = {
  ...base,
  runAction: async (id, input) => {
    const result = await base.runAction(id, input);
    if (result.data?.jobId) window.dispatchEvent(new Event(JOB_STARTED));
    return result;
  },
};

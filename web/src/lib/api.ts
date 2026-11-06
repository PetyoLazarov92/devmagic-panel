import type { ActionId, ActionRunResult, ApacheReport, CronReport, CronRunView, WpCronReport, AssistantSettings, AuraReport, Briefing, ChatReply, ChatTurn, CleanCopyInfo, CleanPreview, CoresReport, DeveloperReport, EnvironmentReport, FolderListing, GitDetails, GitPullRequest, InstallDraft, JobView, KeptDatabaseInfo, LocalHelperPlugin, MailMessage, MailPage, GitHosts, OrgNamespace, OrgRepoList, OrgScanMode, LocalConstant, OrgSettings, OrgStatus, Preferences, PreferencesUpdate, QueuedProposal, RemovalInfo, RepoInspection, RepoLookup, RunDetail, RunPage, RunStep, MysqlReport, NetworkAdmins, PhpFpmFinding, PhpInfo, PhpIniReport, PhpPackage, PhpReport, PhpSettings, ServicesReport, SiteCompat, SitePhp, SessionInfo, Site, SiteLog, SitePlugins, SnapshotInfo, TrashEntry, UpdateStatus, UploadResult, VersionCompat, WizardSuggestion } from '@devmagic-panel/shared';
import type { CreateSiteInput } from '@/lib/plan';
import { noteStatus, refused } from '@/lib/session-watch';
import { mockApi } from '@/mock/api';

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

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  if (refused(url)) throw loggedOut();
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
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
  /** The vhosts, modules and configtest for the Apache tab, and Apache's own error log. */
  apache: () => Promise<ApacheReport>;
  apacheLog: () => Promise<SiteLog>;
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
  gitDetails: (domain: string, mount?: string) => Promise<GitDetails>;
  /** Open pull requests (GitHub) or merge requests (GitLab) by branch; none when the CLI is missing or signed out, or origin is elsewhere. */
  gitPulls: (domain: string, mount?: string) => Promise<GitPullRequest[]>;
  snapshots: (domain: string, path?: string) => Promise<SnapshotInfo[]>;
  /** Gzipped clean copies of the site's database, to share with the team. */
  cleanCopies: (domain: string, path?: string) => Promise<CleanCopyInfo[]>;
  /** The site's tables swaps kept aside, until they are purged. */
  keptDatabases: (domain: string, path?: string) => Promise<KeptDatabaseInfo[]>;
  /** What Clean this database would remove and who could stay, read from the site's live database. */
  cleanPreview: (domain: string, path?: string) => Promise<CleanPreview>;
  /** Every plugin of a site, read with WP-CLI. */
  plugins: (domain: string, path?: string) => Promise<SitePlugins>;
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
  skipJob: (id: string) => Promise<JobView>;
  undoJob: (id: string) => Promise<JobView>;
}

/** fetch() cannot report upload progress, so dumps go up with XHR. */
function uploadWithProgress(file: File, onProgress: (fraction: number) => void): Promise<UploadResult> {
  const url = `/api/uploads?name=${encodeURIComponent(file.name)}`;
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
          return JSON.parse(xhr.responseText) as UploadResult & { error?: string };
        } catch {
          return { error: `Upload failed (${xhr.status})` } as UploadResult & { error?: string };
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: the connection dropped'));
    xhr.send(file);
  });
}

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
  apache: () => request('GET', '/api/apache'),
  apacheLog: () => request('GET', '/api/apache/log'),
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
  gitDetails: (domain, mount) =>
    request('GET', `/api/sites/${encodeURIComponent(domain)}/git${mount ? `?mount=${encodeURIComponent(mount)}` : ''}`),
  gitPulls: (domain, mount) =>
    request('GET', `/api/sites/${encodeURIComponent(domain)}/git/pulls${mount ? `?mount=${encodeURIComponent(mount)}` : ''}`),
  snapshots: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/snapshots${atPath(path, '?')}`),
  cleanCopies: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/clean-copies${atPath(path, '?')}`),
  keptDatabases: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/kept-databases${atPath(path, '?')}`),
  cleanPreview: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/clean-preview${atPath(path, '?')}`),
  plugins: (domain, path) => request('GET', `/api/sites/${encodeURIComponent(domain)}/plugins${atPath(path, '?')}`),
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
  trash: () => request('GET', '/api/trash'),
  orgStatus: () => request('GET', '/api/org/status'),
  saveOrgSettings: (settings) => request('PUT', '/api/org/settings', settings),
  orgTest: () => request('POST', '/api/org/test', {}),
  orgOrgs: () => request('GET', '/api/org/orgs'),
  gitHosts: () => request('GET', '/api/git-hosts'),
  orgRepos: (org, scan) => request('GET', `/api/org/repos?${new URLSearchParams({ org, scan })}`),
  downloads: () => request('GET', '/api/downloads'),
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
  skipJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/skip`, {}),
  undoJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/undo`, {}),
};

/** Where the browser downloads a clean copy from. */
export const cleanCopyUrl = (domain: string, name: string, path?: string) =>
  `/api/sites/${encodeURIComponent(domain)}/clean-copies/${encodeURIComponent(name)}${atPath(path, '?')}`;

/** Where the browser downloads a snapshot from. */
export const snapshotUrl = (domain: string, name: string, path?: string) =>
  `/api/sites/${encodeURIComponent(domain)}/snapshots/${encodeURIComponent(name)}${atPath(path, '?')}`;

/** `npm run mockup` serves the UI on sample data, with no server behind it. */
export const isMockup = import.meta.env.VITE_MOCK === '1';

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

export const api: Api = {
  ...base,
  runAction: async (id, input) => {
    const result = await base.runAction(id, input);
    if (result.data?.jobId) window.dispatchEvent(new Event(JOB_STARTED));
    return result;
  },
};

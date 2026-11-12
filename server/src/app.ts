import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { ActionRunResult, ApacheReport, DbCellValue, DbOverview, DbRowsPage, CleanupInfo, DbQueryResult, DbSchema, MysqlProcess, ProfileList, ProfileSummary, SlowQueryReport, WriteCheck, DbStructure, RowChangeInfo, WpDbReport, WpDbSection, CronReport, CronRunView, DeveloperReport, EnvironmentReport, InstallDraft, UpdateStatus, MailMessage, MailPage, MysqlReport, MysqlSettings, NginxReport, NginxState, HtaccessChanges, Preferences, QueuedProposal, RememberedRepo, ServicesReport, SessionInfo, SiteLog } from '@devmagic-panel/shared';
import { FILE_TEXT_MAX, gitUrl, isActionId, localConstants, localName, mountPath, mysqlDatabaseName, mysqlIdentifier, preferences, preferencesUpdate, repoPreset, RUN_KEEP_DAYS, RUN_KEEP_MAX, WP_DB_ON_DEMAND, WP_DB_SECTIONS } from '@devmagic-panel/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ActionBusyError, ActionInputError, cronCtx, type CronSetup, runAction } from './actions.js';
import { cronReport } from './cron.js';
import { GlobalLock, LoginLimiter, SESSION_COOKIE, Sessions } from './auth.js';
import { checkSystemPassword, newPasswordProblem, resetWays, type ResetWays, setPanelPassword } from './panel-password.js';
import { WPCORE_BIN, type SystemConfig } from './config.js';
import type { CoreStatusSource } from './core-status.js';
import { defaultLogsDir, developerReport, type DeveloperContext, listFolder, readLog, REPO_DIR, startupLog } from './developer.js';
import { panelCli, UpdateChecker, type UpdateContext } from './update.js';
import { installStillNews, settleInstall } from './update-install.js';
import { DraftRefused, draftId, draftInput, Drafts } from './drafts.js';
import { checkEnvironment, type HostPaths } from './environment.js';
import type { Executor } from './exec.js';
import { DEFAULT_UPDATE_REPO, defaultSources, gitUrlFor, type ReleaseSource } from './release-source.js';
import { githubTokenNotice, verifyPassword, type Secrets } from './secrets.js';
import { servicesReport } from './services.js';
import { apacheErrorLog, apacheReport } from './apache.js';
import { nginxErrorLog, nginxReport, nginxSetUp } from './nginx.js';
import { nginxPhpVersion } from './sites/server-switch.js';
import { HtaccessWatcher } from './sites/htaccess-watch.js';
import { type BrowseContext, type CleanupWhere, dbCell, dbOverview, dbRows, dbSchema, dbStructure } from './mysql-browse.js';
import { runQuery } from './mysql-query.js';
import { cleanupViewWhere, listCleanups } from './mysql-cleanup.js';
import { readSettings } from './mysql-settings.js';
import { slowQueries } from './mysql-slow.js';
import { listProfiles, ProfileError, profileFile, profileSummary } from './profiles.js';
import { readSiteVhosts } from './sites/vhost.js';
import { checkWrite, mysqlProcesses } from './mysql-write.js';
import { exportDatabase } from './mysql-transfer.js';
import { listRowChanges } from './mysql-rows.js';
import { databaseSummary, wordpressReport, wordpressTables } from './mysql-wordpress.js';
import { MysqlRefused, mysqlBackupsDir, mysqlReport, pruneMysqlBackups } from './mysql-server.js';
import { BrowseError } from './mysql-sql.js';
import { Jobs } from './jobs.js';
import { defaultClaude, type ClaudeFactory } from './assistant/briefing.js';
import { defaultConventions, readConventions } from './assistant/conventions.js';
import { readLocalConstants, saveLocalConstants } from './local-constants.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerCreateRoutes } from './sites/create-routes.js';
import { purgeKept } from './sites/kept.js';
import { registerSiteRoutes } from './sites/routes.js';
import { fileTrashDir, pruneFileTrash } from './sites/file-changes.js';
import { pruneStaged, stagedDir } from './sites/file-transfer.js';
import { sitesByVersion } from './php/pools.js';
import { registerPhpRoutes } from './php/routes.js';
import { pruneUploads, removeUnfinishedUploads, UPLOAD_KEEP_MS } from './sites/uploads.js';
import { readOrgSettings, registerOrgRoutes } from './org/routes.js';
import { repoTrust } from './repo-trust.js';
import { GitHostDetector, gitlabHostsInUse, remotesOf } from './repo-hosts/index.js';
import { listTrash } from './sites/trash.js';
import type { RunStore } from './store.js';
import { installedCores, readWpcoreConfig } from './wpcore.js';
import { type Downloader, listMail, mailpitFetch, type MailpitFetch, mailpitPaths, readMail, unreadMail } from './mailpit.js';
import { cachedReport, forgetReport, keepReport, SharedReads } from './wordpress-report-cache.js';
import { tableGrowth } from './table-growth.js';

export interface AppDeps {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  /** Read on demand so `cli.js setup` takes effect without a restart. */
  secrets: () => Secrets | null;
  hostPaths: HostPaths;
  dmpRoot: string;
  /** The bundled wpcore that the sudoers rule allows. */
  wpcoreBin?: string;
  version: string;
  production: boolean;
  webRoot?: string;
  /** Where uploaded dumps wait for the install that uses them. */
  uploadsDir: string;
  /** Where the API key is saved and the panel's settings live; the assistant routes need both. */
  secretsFile?: string;
  settingsFile?: string;
  /** Makes the Anthropic client; tests pass a fake. */
  claude?: ClaudeFactory;
  /** WordPress.org's status per core version; tests leave it out and get none. */
  coreStatus?: CoreStatusSource;
  /** Mailpit's API and the Mailpit release download; tests pass fakes. */
  mailpit?: MailpitFetch;
  download?: Downloader;
  /** Where install.sh writes its logs; tests pass a temp folder. */
  logsDir?: string;
  /** The folder the panel runs from (a release, or a checkout), for updates and the self-check; tests pass a temp one. */
  repo?: string;
  /** fetch, for the public way to the releases; tests pass a fake. */
  fetch?: typeof fetch;
  /** The ways to the releases; tests pass their own. */
  updateSources?: ReleaseSource[];
  /** Look for a newer release at start and every six hours; off in tests. */
  checkUpdates?: boolean;
  /** Prunes Run history (RUN_KEEP_DAYS, RUN_KEEP_MAX) and dumps nothing needs (a day old) at start and every hour. */
  housekeeping?: boolean;
  logger?: boolean;
  /** What the panel's crontab lines run, and /etc for the system cron; tests pass their own. */
  cron?: CronSetup;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The meta row that holds the preferences. */
const PREFERENCES_KEY = 'preferences';
/** Room for one action's input: a text file of the Files tab at its largest, as JSON. */
const ACTION_BODY_MAX = 4 * FILE_TEXT_MAX;

/** Hosts the panel answers to; anything else is refused (DNS rebinding). */
export function allowedHosts(config: SystemConfig, production: boolean): Set<string> {
  const hosts = new Set([config.PANEL_DOMAIN, `127.0.0.1:${config.PANEL_PORT}`, `localhost:${config.PANEL_PORT}`]);
  if (!production) ['localhost:5173', '127.0.0.1:5173'].forEach((h) => hosts.add(h));
  return hosts;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: '127.0.0.1',
    bodyLimit: 1024 * 1024,
  });
  const sessions = new Sessions(deps.store, () => deps.secrets()?.panelPasswordHash);
  const jobs = new Jobs(deps.store);
  // A job on a site may have changed its database: the WordPress view reads it anew next time.
  jobs.onEnd((view) => {
    if (view.target) forgetReport(deps.store, view.target);
  });
  const limiter = new LoginLimiter();
  const resetLock = new GlobalLock();
  // Too many wrong passwords: when to try again, for the login page's countdown, and as Retry-After.
  const tooMany = (reply: FastifyReply, client: string) => {
    const at = limiter.retryAt(client);
    return reply
      .code(429)
      .header('retry-after', String(Math.max(1, Math.ceil((at - Date.now()) / 1000))))
      .send({ error: 'Too many attempts. Try again in a few minutes.', retryAt: new Date(at).toISOString() });
  };
  // Whether the computer password can reset the panel's: asked of sudo at most every few minutes.
  let ways: { at: number; value: Promise<ResetWays> } | undefined;
  const currentWays = () => {
    if (!ways || Date.now() - ways.at > 5 * 60_000) ways = { at: Date.now(), value: resetWays(deps.exec) };
    return ways.value;
  };
  const hosts = allowedHosts(deps.config, deps.production);
  const logsDir = deps.logsDir ?? defaultLogsDir(deps.hostPaths.home);
  const update: UpdateContext = {
    exec: deps.exec,
    appDir: deps.repo ?? REPO_DIR,
    dataDir: dirname(deps.uploadsDir),
    version: deps.version,
    logsDir,
    dmpRoot: deps.dmpRoot,
    sources: deps.updateSources ?? defaultSources(deps.exec, deps.config.UPDATE_REPO ?? DEFAULT_UPDATE_REPO, deps.config.UPDATE_GIT_URL ?? gitUrlFor(deps.config.UPDATE_REPO ?? DEFAULT_UPDATE_REPO), dirname(deps.uploadsDir), deps.fetch),
    memory: {},
    notice: () => githubTokenNotice(join(dirname(deps.uploadsDir), 'github-token-removed')),
  };
  const updates = new UpdateChecker(update);
  // An install from the Updates page that ended while no job of this panel followed it (it restarted): its run is finished here.
  const following = (runId: number) => ['running', 'queued'].includes(jobs.forRun(runId)?.status ?? '');
  const install = () => settleInstall({ exec: deps.exec, dataDir: update.dataDir, store: deps.store }, following);
  const drafts = new Drafts(deps.store, deps.uploadsDir);
  // Watches the .htaccess files of sites on nginx; only for the running panel, never in tests.
  const htaccessWatcher = deps.housekeeping ? new HtaccessWatcher(deps.config) : null;
  if (htaccessWatcher) {
    try {
      htaccessWatcher.refresh();
    } catch (error) {
      app.log.warn(`htaccess watch: ${(error as Error).message}`);
    }
    app.addHook('onClose', async () => htaccessWatcher.close());
  }
  if (deps.housekeeping) {
    const running = (jobId: string) => ['running', 'queued', 'undoing'].includes(jobs.get(jobId)?.status ?? '');
    const sweep = () => {
      try {
        const gone = drafts.sweep(running);
        if (gone) app.log.info(`housekeeping: ${gone} install drafts ran out`);
      } catch (error) {
        app.log.warn(`housekeeping: ${(error as Error).message}`);
      }
    };
    // The panel may have just restarted in the middle of an install from the Updates page; its installer goes on for up to a minute.
    void install().catch(() => undefined);
    setTimeout(() => void install().catch(() => undefined), 90_000).unref();
    // A job a stopped panel left half way ended with it: its run says so, and what it saved first is still kept.
    const cut = deps.store.stopUnfinished(
      'Stopped: the panel restarted while it ran. What it saved first is still kept (a clean-up shows under Changes you can undo), and its page can start it again.',
      (action) => action.startsWith('panel.'),
    );
    if (cut) app.log.warn(`housekeeping: ${cut} runs were cut off by a restart`);
    // Uploads and downloads a stopped panel left half way go at start: nothing can still be writing them.
    const unfinished = removeUnfinishedUploads(deps.uploadsDir);
    if (unfinished.length) app.log.info(`housekeeping: removed ${unfinished.length} unfinished downloads`);
    sweep();
    setInterval(sweep, 10 * 60_000).unref();
    const tidy = () => {
      try {
        const runs = deps.store.prune(RUN_KEEP_DAYS, RUN_KEEP_MAX);
        const dumps = pruneUploads(deps.uploadsDir, UPLOAD_KEEP_MS, new Set([...jobs.uploadsInUse(), ...drafts.uploadsInUse()]));
        if (runs || dumps.length) app.log.info(`housekeeping: pruned ${runs} runs and ${dumps.length} dumps`);
        const saved = pruneMysqlBackups(mysqlBackupsDir(deps.uploadsDir));
        if (saved.length) app.log.info(`housekeeping: removed ${saved.length} MySQL backups older than 14 days`);
        const files = pruneFileTrash(fileTrashDir(dirname(deps.uploadsDir)));
        if (files.length) app.log.info(`housekeeping: removed ${files.length} deletes of the Files tab older than 14 days`);
        pruneStaged(stagedDir(dirname(deps.uploadsDir)));
      } catch (error) {
        app.log.warn(`housekeeping: ${(error as Error).message}`);
      }
    };
    // Kept databases go after their 7 days, except a site's a job is working on.
    const purge = () =>
      // A record's site is its key (local.shop.com@learn); jobs lock local.shop.com/learn.
      void purgeKept(deps.store, deps.exec, deps.secrets()?.mysql, (site) => jobs.busyFor(site.replaceAll('@', '/')) !== undefined)
        .then((dropped) => dropped.length && app.log.info(`housekeeping: dropped ${dropped.length} kept databases: ${dropped.join(', ')}`))
        .catch((error: Error) => app.log.warn(`housekeeping: ${error.message}`));
    tidy();
    purge();
    setInterval(() => {
      tidy();
      purge();
    }, 60 * 60_000).unref();
  }
  if (deps.checkUpdates) {
    const check = () => void updates.status(true).catch((error: Error) => app.log.warn(`update check: ${error.message}`));
    setTimeout(check, 30_000).unref();
    setInterval(check, 6 * 60 * 60_000).unref();
  }

  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return reply.code(421).send({ error: 'unknown host' });
    if (UNSAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      let originHost = '';
      try {
        originHost = origin ? new URL(origin).host.toLowerCase() : '';
      } catch {
        originHost = '';
      }
      if (!hosts.has(originHost)) return reply.code(403).send({ error: 'cross-origin request refused' });
    }
  });

  const authenticated = (request: FastifyRequest) => sessions.touch(request.cookies[SESSION_COOKIE]);

  app.get('/healthz', async () => ({ status: 'ok', version: deps.version }));

  app.get('/api/session', async (request): Promise<SessionInfo & { setupRequired: boolean }> => ({
    authenticated: authenticated(request),
    user: deps.config.PANEL_USER,
    version: deps.version,
    setupRequired: !deps.secrets()?.panelPasswordHash,
  }));

  app.post<{ Body: { password?: unknown } }>('/api/login', async (request, reply) => {
    const client = request.ip;
    if (limiter.blocked(client)) return tooMany(reply, client);
    const hash = deps.secrets()?.panelPasswordHash;
    if (!hash) return reply.code(409).send({ error: 'No panel password yet. Run: node ~/.local/share/devmagic-panel/current/server/dist/cli.js setup' });
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!password || !(await verifyPassword(password, hash))) {
      limiter.fail(client);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    limiter.reset(client);
    reply.setCookie(SESSION_COOKIE, sessions.create(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: 'auto',
      path: '/',
    });
    return reply.code(204).send();
  });

  // A forgotten panel password: the ways back in, and a reset with the computer password.
  app.get('/api/password/reset', async () => {
    const until = resetLock.until();
    return { ...(await currentWays()), ...(until ? { lockedUntil: new Date(until).toISOString() } : {}) };
  });

  app.post<{ Body: { system?: unknown; next?: unknown } }>('/api/password/reset', async (request, reply) => {
    const current = deps.secrets();
    if (!current?.panelPasswordHash || !deps.secretsFile) return reply.code(409).send({ error: 'No panel password yet: run the setup command on a terminal' });
    const until = resetLock.until();
    if (until) return reply.code(429).send({ error: `Too many attempts: try again after ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, or use the terminal`, lockedUntil: new Date(until).toISOString() });
    if (!(await currentWays()).system) return reply.code(409).send({ error: 'Your computer password cannot reset the panel password here: use the terminal' });
    const problem = newPasswordProblem(request.body?.next, deps.config.PANEL_USER);
    if (problem) return reply.code(400).send({ error: problem, field: 'next' });
    const system = typeof request.body?.system === 'string' ? request.body.system : '';
    if (!system || !(await checkSystemPassword(deps.exec, system))) {
      resetLock.fail();
      // 403, not 401: the page is not signed out, only this answer is wrong.
      return reply.code(403).send({ error: 'Your computer password was not accepted', field: 'system' });
    }
    await setPanelPassword(deps.secretsFile, current, request.body?.next as string);
    return reply.code(204).send();
  });

  app.post('/api/logout', async (request, reply) => {
    sessions.destroy(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // Everything below needs a session.
  app.register(async (api) => {
    const orgSettingsFile = join(deps.settingsFile ? dirname(deps.settingsFile) : join(deps.hostPaths.home, '.config', 'devmagic-panel'), 'organizations.json');
    // Whether code from a repo may run here: your organizations and groups, owners you trusted, repos your CLI listed.
    const trustOf = (url: string) => repoTrust(url, deps.store, readOrgSettings(orgSettingsFile).selected);
    // What runs the hosts in the sites' remotes, when their name does not say: asked over SSH once a week.
    const gitHosts = new GitHostDetector(deps.exec, deps.store);
    gitHosts.apply();
    // Read at request time, once the site routes below exist.
    const gitlabHosts = async () => {
      const sites = await siteRoutes.sites();
      await gitHosts.refresh(remotesOf(sites)).catch(() => undefined);
      return gitlabHostsInUse(readOrgSettings(orgSettingsFile), sites);
    };
    api.addHook('onRequest', async (request, reply) => {
      if (!authenticated(request)) return reply.code(401).send({ error: 'Log in first' });
    });

    // The panel password: when it was set, and changing it with the current one.
    api.get('/api/password', async () => {
      const changedAt = deps.secrets()?.panelPasswordChangedAt;
      return changedAt ? { changedAt } : {};
    });

    api.post<{ Body: { current?: unknown; next?: unknown } }>('/api/password', async (request, reply) => {
      const current = deps.secrets();
      if (!current?.panelPasswordHash || !deps.secretsFile) return reply.code(409).send({ error: 'The panel cannot write its secrets file here' });
      const client = request.ip;
      if (limiter.blocked(client)) return tooMany(reply, client);
      const given = typeof request.body?.current === 'string' ? request.body.current : '';
      if (!given || !(await verifyPassword(given, current.panelPasswordHash))) {
        limiter.fail(client);
        // 403, not 401: the session is fine, so the page must not open the login dialog.
        return reply.code(403).send({ error: 'The current password is not right', field: 'current' });
      }
      const problem = newPasswordProblem(request.body?.next, deps.config.PANEL_USER);
      if (problem) return reply.code(400).send({ error: problem, field: 'next' });
      await setPanelPassword(deps.secretsFile, current, request.body?.next as string);
      // Every other session ended with the old password; this browser gets a new one.
      reply.setCookie(SESSION_COOKIE, sessions.create(), { httpOnly: true, sameSite: 'strict', secure: 'auto', path: '/' });
      return reply.code(204).send();
    });

    api.get('/api/environment', async (): Promise<EnvironmentReport> =>
      checkEnvironment({
        config: deps.config,
        exec: deps.exec,
        secrets: deps.secrets(),
        paths: deps.hostPaths,
        dmpRoot: deps.dmpRoot,
        gitlabHosts,
        ...(deps.production ? { self: { repo: deps.repo ?? REPO_DIR, version: deps.version } } : {}),
      }),
    );

    // A file the Files tab saves is up to 2 MB of text, and JSON makes it larger: more room than the other routes get.
    api.post<{ Params: { id: string }; Body: unknown }>('/api/actions/:id', { bodyLimit: ACTION_BODY_MAX }, async (request, reply): Promise<ActionRunResult | undefined> => {
      const { id } = request.params;
      if (!isActionId(id)) return reply.code(404).send({ error: `unknown action: ${id}` });
      try {
        return await runAction(
          {
            config: deps.config, exec: deps.exec, store: deps.store, dmpRoot: deps.dmpRoot,
            wpcoreBin: deps.wpcoreBin ?? WPCORE_BIN, wpcoreConf: deps.hostPaths.wpcoreConf, home: deps.hostPaths.home,
            jobs, uploadsDir: deps.uploadsDir, secrets: deps.secrets(), ...(deps.secretsFile ? { secretsFile: deps.secretsFile } : {}), ...(deps.coreStatus ? { coreStatus: deps.coreStatus } : {}),
            ...(deps.mailpit ? { mailpit: deps.mailpit } : {}), ...(deps.download ? { download: deps.download } : {}), update, drafts,
            claudeCode: { home: deps.hostPaths.home, searchPath: deps.hostPaths.searchPath ?? process.env.PATH ?? '', workDir: join(deps.uploadsDir, '..', 'tmp') },
            ...(deps.cron ? { cron: deps.cron } : {}),
            repoTrusted: (url: string) => trustOf(url).trusted,
          },
          id,
          request.body,
        );
      } catch (error) {
        if (error instanceof ActionInputError) return reply.code(400).send({ error: error.message });
        if (error instanceof ActionBusyError) return reply.code(409).send({ error: error.message, ...(error.jobId ? { jobId: error.jobId } : {}) });
        throw error;
      }
    });

    const mailpitBin = mailpitPaths(dirname(deps.uploadsDir), deps.hostPaths.home).bin;
    api.get('/api/services', async (): Promise<ServicesReport> => servicesReport(deps.config, deps.exec, Date.now, mailpitBin));
    // The Services page's MySQL and Apache tabs, read only; their changes are registry actions.
    // The MySQL settings the MySQL page changes: what runs now, what the panel's file keeps, what an import holds raised.
    api.get('/api/mysql/settings', async (_request, reply): Promise<MysqlSettings | undefined> => {
      try {
        return await readSettings({ config: deps.config, exec: deps.exec, mysql: deps.secrets()?.mysql, dmpRoot: deps.dmpRoot, memo: deps.store });
      } catch (error) {
        return reply.code(error instanceof MysqlRefused ? 409 : 500).send({ error: (error as Error).message });
      }
    });
    api.get('/api/mysql', async (): Promise<MysqlReport> =>
      mysqlReport({ config: deps.config, exec: deps.exec, mysql: deps.secrets()?.mysql, kept: () => deps.store.keptDatabases(), backupsDir: mysqlBackupsDir(deps.uploadsDir) }));
    // The database browser: reads only, in a read-only transaction with a time limit. Rows and full
    // values are POSTs, so a filter's value or a row's key never reaches a URL or Apache's log.
    const wordpressReads = new SharedReads<WpDbReport>();
    const browse = (): BrowseContext => ({ config: deps.config, exec: deps.exec, mysql: deps.secrets()?.mysql, readOnly: deps.secrets()?.mysqlReadOnly, kept: () => deps.store.keptDatabases() });
    const browsing = async <T>(reply: FastifyReply, read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof BrowseError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    };
    type TableParams = { Params: { database: string; table: string } };
    // A clean-up's rows, for the Tables view: the site's tables read again, and the condition the clean-up itself would use.
    const cleanupWhere: CleanupWhere = async (database, table, view) => {
      if (!localName.safeParse(view.domain).success || (view.path !== undefined && !mountPath.safeParse(view.path).success)) throw new BrowseError('A local site like local.wandworks.example, with its path if it has one', 400);
      const t = await wordpressTables(browse(), view.domain, view.path, view.blog ?? 1);
      if (t.database !== database) throw new BrowseError(`${view.domain} keeps its tables in ${t.database}`, 400);
      try {
        return cleanupViewWhere(t, view, table);
      } catch (error) {
        throw new BrowseError((error as Error).message, 400);
      }
    };
    api.get<{ Params: { database: string } }>('/api/mysql/databases/:database', async (request, reply): Promise<DbOverview | undefined> =>
      browsing(reply, () => dbOverview(browse(), request.params.database)));
    api.get<TableParams>('/api/mysql/databases/:database/tables/:table', async (request, reply): Promise<DbStructure | undefined> =>
      browsing(reply, () => dbStructure(browse(), request.params.database, request.params.table)));
    api.post<TableParams>('/api/mysql/databases/:database/tables/:table/rows', async (request, reply): Promise<DbRowsPage | undefined> =>
      browsing(reply, () => dbRows(browse(), request.params.database, request.params.table, request.body, cleanupWhere)));
    api.post<TableParams>('/api/mysql/databases/:database/tables/:table/cell', async (request, reply): Promise<DbCellValue | undefined> =>
      browsing(reply, () => dbCell(browse(), request.params.database, request.params.table, request.body)));
    // The row changes saved for Undo on a table, newest first: kinds and counts, never values.
    api.get<{ Params: { database: string }; Querystring: { table?: string } }>('/api/mysql/databases/:database/row-changes', async (request, reply): Promise<RowChangeInfo[] | undefined> => {
      const { database } = request.params;
      const { table } = request.query;
      if (!mysqlDatabaseName.safeParse(database).success || (table !== undefined && !mysqlIdentifier.safeParse(table).success)) return reply.code(400).send({ error: 'A database like wandworks_example and a table like wp_options' });
      return listRowChanges(deps.config, database, table);
    });
    // The clean-ups saved for Undo on a database (or one site of it, ?site=local.shop.com/learn), newest first, without their rows.
    api.get<{ Params: { database: string }; Querystring: { site?: string } }>('/api/mysql/databases/:database/cleanups', async (request, reply): Promise<CleanupInfo[] | undefined> => {
      const { database } = request.params;
      if (!mysqlDatabaseName.safeParse(database).success) return reply.code(400).send({ error: 'A database like wandworks_example' });
      return listCleanups(deps.config, database, request.query.site);
    });
    // What SQL that writes would do, before it runs: its tables, the room for their copy, and the rows it changes, tried and rolled back.
    api.post<{ Params: { database: string } }>('/api/mysql/databases/:database/check-write', async (request, reply): Promise<WriteCheck | undefined> =>
      browsing(reply, () => checkWrite({ ...browse(), siteBusy: () => false }, request.params.database, request.body)));
    // A database, or the tables named (?table=a&table=b), as a gzipped dump to download, streamed from mysqldump.
    api.get<{ Params: { database: string }; Querystring: { table?: string | string[] } }>('/api/mysql/databases/:database/export', async (request, reply) =>
      browsing(reply, async () => {
        const asked = request.query.table;
        const tables = (asked === undefined ? [] : Array.isArray(asked) ? asked : [asked]).slice(0, 2000);
        if (tables.some((t) => !mysqlIdentifier.safeParse(t).success)) throw new BrowseError('A table name like wp_options');
        const { filename, stream } = await exportDatabase(browse(), request.params.database, tables);
        return reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="${filename}"`).send(stream);
      }));
    // The queries that cost the most time, of one database (?database=wandworks_example) or every site's: MySQL's statement statistics, or the slow log table.
    api.get<{ Querystring: { database?: string } }>('/api/mysql/slow-queries', async (request, reply): Promise<SlowQueryReport | undefined> =>
      browsing(reply, () => slowQueries(browse(), request.query.database)));
    // What MySQL runs now, for the MySQL tab's Processes.
    api.get('/api/mysql/processes', async (_request, reply): Promise<MysqlProcess[] | undefined> => browsing(reply, () => mysqlProcesses(browse())));
    // Table and column names, for the SQL editor's suggestions.
    api.get<{ Params: { database: string } }>('/api/mysql/databases/:database/schema', async (request, reply): Promise<DbSchema | undefined> =>
      browsing(reply, () => dbSchema(browse(), request.params.database)));
    // The SQL runner: one statement that reads, as the read-only account. A POST: the SQL can hold data.
    api.post<{ Params: { database: string } }>('/api/mysql/databases/:database/query', async (request, reply): Promise<DbQueryResult | undefined> =>
      browsing(reply, () => runQuery(browse(), request.params.database, request.body)));
    // A WordPress site's database as WordPress sees it: autoload, transients, clean-up counts, users. ?blog= picks a site of a network,
    // ?sections=autoload,users the parts to read (the page asks for the slow ones one at a time), ?sizes=1 the size of every postmeta value.
    // ?cached=1 answers with the report kept from the last reads, at once, or 204 when there is none.
    api.get<{ Params: { domain: string }; Querystring: { path?: string; blog?: string; sections?: string; sizes?: string; cached?: string } }>('/api/sites/:domain/db/wordpress', async (request, reply): Promise<WpDbReport | undefined> =>
      browsing(reply, async () => {
        const { domain } = request.params;
        const { path, blog, sections, sizes, cached } = request.query;
        if (!localName.safeParse(domain).success || (path !== undefined && !mountPath.safeParse(path).success)) throw new BrowseError(`no site called ${domain}${path ?? ''}`, 404);
        if (blog !== undefined && !/^\d{1,9}$/.test(blog)) throw new BrowseError('A site of the network by its number, like 2');
        const parts = sections === undefined ? undefined : sections.split(',');
        const unknown = parts?.find((p) => !(WP_DB_SECTIONS as readonly string[]).includes(p));
        if (unknown !== undefined) throw new BrowseError(`No part of the WordPress view called ${unknown.slice(0, 40)}`);
        const site = blog === undefined ? 1 : Number(blog);
        if (cached === '1') return cachedReport(deps.store, domain, path, site) ?? reply.code(204).send();
        // The read stops in MySQL once the browser no longer waits for it (another view, Check again).
        const gone = new AbortController();
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) gone.abort();
        });
        const wanted = (parts as WpDbSection[] | undefined) ?? WP_DB_SECTIONS.filter((s) => !WP_DB_ON_DEMAND.includes(s));
        const id = `${domain}${path ?? ''}#${site}:${wanted.join(',')}:${sizes === '1' ? 'sizes' : ''}`;
        const report = await wordpressReads.read(id, (signal) => wordpressReport({ ...browse(), signal }, domain, path, site, Date.now, { sections: wanted, sizes: sizes === '1', history: (database, tables) => tableGrowth(deps.store, database, tables) }), gone.signal);
        keepReport(deps.store, domain, path, site, report, wanted);
        return report;
      }));
    // Xdebug's profiles: a site's (?domain=local.wandworks.example, &path=/learn for a site under a path) or all of them, newest first.
    const profiling = async <T>(reply: FastifyReply, run: () => Promise<T> | T): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof ProfileError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    };
    api.get<{ Querystring: { domain?: string; path?: string } }>('/api/profiles', async (request, reply): Promise<ProfileList | undefined> =>
      profiling(reply, () => {
        const { domain, path } = request.query;
        // Every site's hosts: a profile's name runs its host and request together, so the longest known host decides.
        const known = [...new Set(readSiteVhosts(deps.config).flatMap((v) => v.names))];
        if (domain === undefined) return listProfiles(deps.config, dirname(deps.uploadsDir), [], '', Date.now(), known);
        if (!localName.safeParse(domain).success || (path !== undefined && !mountPath.safeParse(path).success)) throw new ProfileError(`no site called ${domain}${path ?? ''}`, 404);
        const vhost = readSiteVhosts(deps.config).find((v) => v.names[0] === domain);
        const hosts = vhost ? [...new Set(vhost.names)] : [domain];
        return listProfiles(deps.config, dirname(deps.uploadsDir), hosts, path ? `/${path.slice(1).replace(/[^A-Za-z0-9-]/g, '_')}` : '', Date.now(), [...new Set([...known, ...hosts])]);
      }));
    api.get<{ Params: { version: string; name: string } }>('/api/profiles/:version/:name', async (request, reply): Promise<ProfileSummary | undefined> =>
      profiling(reply, () => profileSummary(deps.config, dirname(deps.uploadsDir), request.params.version, request.params.name)));
    // The file as Xdebug wrote it, for KCachegrind, QCachegrind or an IDE.
    api.get<{ Params: { version: string; name: string } }>('/api/profiles/:version/:name/download', async (request, reply) =>
      profiling(reply, () => {
        const file = profileFile(deps.config, request.params.version, request.params.name);
        return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${request.params.name}"`).send(createReadStream(file));
      }));
    api.get('/api/apache', async (): Promise<ApacheReport> => apacheReport(deps.config, deps.exec, deps.dmpRoot));
    api.get('/api/apache/log', async (): Promise<SiteLog> => apacheErrorLog(deps.config));
    api.get('/api/nginx', async (): Promise<NginxReport> => nginxReport(deps.config, deps.exec, deps.dmpRoot));
    api.get('/api/nginx/log', async (): Promise<SiteLog> => nginxErrorLog(deps.config));
    // Changes to the .htaccess files of sites on nginx since the time the browser last asked, for a notice with Review.
    let watchedAt = 0;
    api.get<{ Querystring: { since?: string } }>('/api/htaccess/changes', async (request): Promise<HtaccessChanges> => {
      if (!htaccessWatcher) return { now: new Date().toISOString(), changes: [] };
      // A site that moved to nginx since is watched within a minute.
      if (Date.now() - watchedAt > 60_000) {
        watchedAt = Date.now();
        htaccessWatcher.refresh();
      }
      const since = request.query.since && !Number.isNaN(Date.parse(request.query.since)) ? request.query.since : undefined;
      return htaccessWatcher.changes(since);
    });
    api.get('/api/nginx/state', async (): Promise<NginxState> => {
      const php = nginxPhpVersion(deps.config, '');
      return { setUp: nginxSetUp(deps.config), ...(php ? { php } : {}) };
    });
    // The Services page's Cron tab: your crontab, the panel's tasks and their runs, system cron read only.
    const cron = () => cronCtx({ config: deps.config, exec: deps.exec, store: deps.store, uploadsDir: deps.uploadsDir, update, ...(deps.cron ? { cron: deps.cron } : {}) });
    api.get('/api/cron', async (): Promise<CronReport> => cronReport(cron()));
    api.get<{ Params: { id: string } }>('/api/cron/tasks/:id/runs', async (request, reply): Promise<CronRunView[] | undefined> => {
      if (!/^[a-z0-9]{6}$/.test(request.params.id)) return reply.code(400).send({ error: 'A task id like k3f9q2' });
      return deps.store.cronRuns(request.params.id);
    });
    api.get<{ Params: { run: string } }>('/api/cron/runs/:run', async (request, reply): Promise<CronRunView | undefined> => {
      const run = /^\d{1,12}$/.test(request.params.run) ? deps.store.cronRun(Number(request.params.run)) : undefined;
      return run ?? reply.code(404).send({ error: 'No such run' });
    });
    registerPhpRoutes(api, { config: deps.config, exec: deps.exec, dmpRoot: deps.dmpRoot, sitesByVersion: sitesByVersion(deps.config), store: deps.store, dataDir: dirname(deps.uploadsDir) });

    // The hidden Developer options: versions, services, settings, installed files and logs.
    const developer: DeveloperContext = {
      config: deps.config,
      exec: deps.exec,
      version: deps.version,
      home: deps.hostPaths.home,
      dataDir: dirname(deps.uploadsDir),
      configDir: deps.secretsFile ? dirname(deps.secretsFile) : join(deps.hostPaths.home, '.config', 'devmagic-panel'),
      logsDir,
      runningJobs: () => jobs.list().filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'undoing').length,
    };
    api.get('/api/developer', async (): Promise<DeveloperReport> => developerReport(developer));
    api.get<{ Params: { name: string } }>('/api/developer/logs/:name', async (request, reply) => {
      const text = readLog(developer.logsDir, request.params.name);
      return text === null ? reply.code(404).send({ error: 'No such log' }) : { name: request.params.name, text };
    });
    api.get('/api/developer/startup', async () => ({ text: await startupLog(deps.exec) }));
    // One folder of the two file lists, opened in the tree: names and sizes only, never contents.
    api.get<{ Querystring: { path?: string } }>('/api/developer/folder', async (request, reply) => {
      const listing = listFolder(developer, String(request.query.path ?? ''));
      return listing ?? reply.code(403).send({ error: 'Only the folders the Developer options list can be opened' });
    });

    // Install drafts: the wizard's answers, kept a day after the last change. No registry actions: they change only the panel's own data.
    api.get('/api/drafts', async (): Promise<InstallDraft[]> => drafts.list());
    api.get<{ Params: { id: string } }>('/api/drafts/:id', async (request, reply): Promise<InstallDraft | undefined> => {
      const draft = draftId.safeParse(request.params.id).success ? drafts.get(request.params.id) : undefined;
      return draft ?? reply.code(404).send({ error: 'No such draft: it ran out or was finished' });
    });
    api.put<{ Params: { id: string }; Body: unknown }>('/api/drafts/:id', async (request, reply): Promise<InstallDraft | undefined> => {
      const body = draftInput.safeParse(request.body);
      if (!draftId.safeParse(request.params.id).success || !body.success) return reply.code(400).send({ error: body.error?.issues[0]?.message ?? 'Not a draft id' });
      try {
        return drafts.save(request.params.id, body.data);
      } catch (error) {
        if (error instanceof DraftRefused) return reply.code(409).send({ error: error.message });
        throw error;
      }
    });
    api.delete<{ Params: { id: string } }>('/api/drafts/:id', async (request, reply) => {
      if (!draftId.safeParse(request.params.id).success) return reply.code(400).send({ error: 'Not a draft id' });
      try {
        drafts.discard(request.params.id);
        return { ok: true };
      } catch (error) {
        if (error instanceof DraftRefused) return reply.code(409).send({ error: error.message });
        throw error;
      }
    });

    // How the panel looks (theme, the sites' view and order), kept in its database. Not an action: it changes nothing on the machine.
    const readPreferences = (): Preferences => {
      try {
        const saved = preferences.safeParse(JSON.parse(deps.store.getMeta(PREFERENCES_KEY) ?? '{}'));
        return saved.success ? saved.data : preferences.parse({});
      } catch {
        return preferences.parse({});
      }
    };
    api.get('/api/preferences', async (): Promise<Preferences> => readPreferences());
    api.put<{ Body: unknown }>('/api/preferences', async (request, reply): Promise<Preferences | undefined> => {
      const update = preferencesUpdate.safeParse(request.body);
      if (!update.success) return reply.code(400).send({ error: update.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      const next = preferences.parse({ ...readPreferences(), ...update.data });
      deps.store.setMeta(PREFERENCES_KEY, JSON.stringify(next));
      return next;
    });

    // What the new site wizard remembers per repo: listed, changed and forgotten in Settings. Panel settings, not an action.
    const rememberedName = (key: string) => key.replace(/^https?:\/\//, '');
    api.get('/api/remembered/repos', async (): Promise<RememberedRepo[]> =>
      deps.store.presets().map(({ repo, preset, updatedAt }) => {
        const read = repoPreset.safeParse(preset);
        return { key: repo, name: rememberedName(repo), updatedAt, preset: read.success ? read.data : null };
      }),
    );
    const rememberedKey = z.string().min(1).max(600);
    api.put<{ Body: unknown }>('/api/remembered/repos', async (request, reply) => {
      const body = z.object({ key: rememberedKey, preset: repoPreset }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      // Only answers the wizard made can be changed: nothing new is remembered from here.
      if (deps.store.preset(body.data.key) === undefined) return reply.code(404).send({ error: 'Nothing is remembered for this repo' });
      // Placement replaces the old layout once you save.
      const { layout: _old, ...preset } = body.data.preset;
      deps.store.savePreset(body.data.key, preset);
      return { ok: true };
    });
    api.post<{ Body: unknown }>('/api/remembered/repos/forget', async (request, reply) => {
      const body = z.object({ key: rememberedKey }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Which repo?' });
      if (!deps.store.deletePreset(body.data.key)) return reply.code(404).send({ error: 'Nothing is remembered for this repo' });
      return { ok: true };
    });

    // Owners whose repos may run here, trusted once in the wizard or Settings. Panel settings, not an action.
    api.get<{ Querystring: { url?: string } }>('/api/repo-trust', async (request, reply) => {
      const url = gitUrl.safeParse(request.query.url);
      if (!url.success) return reply.code(400).send({ error: 'A git URL' });
      return trustOf(url.data);
    });
    api.get('/api/trusted-owners', async () => deps.store.trustedOwners());
    const ownerBody = z.object({ host: z.string().regex(/^[a-z0-9.-]{1,253}(:\d{1,5})?$/), owner: z.string().regex(/^[a-z0-9_.-]{1,100}(\/[a-z0-9_.-]{1,100}){0,20}$/).refine((o) => !o.split('/').some((p) => p === '.' || p === '..')) });
    api.post<{ Body: unknown }>('/api/trusted-owners', async (request, reply) => {
      const body = ownerBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'A host and an owner like github.com and wandworks' });
      deps.store.trustOwner(body.data.host, body.data.owner);
      return deps.store.trustedOwners();
    });
    api.post<{ Body: unknown }>('/api/trusted-owners/remove', async (request, reply) => {
      const body = ownerBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'A host and an owner like github.com and wandworks' });
      deps.store.untrustOwner(body.data.host, body.data.owner);
      return deps.store.trustedOwners();
    });

    // The constants every local site should have, written on new installs and checked by Aura. Panel settings, not an action.
    api.get('/api/local-constants', async () => readLocalConstants(deps.store));
    api.put<{ Body: unknown }>('/api/local-constants', async (request, reply) => {
      const list = localConstants.safeParse(request.body);
      if (!list.success) return reply.code(400).send({ error: list.error.issues.map((i) => `${i.path.join('.') || 'list'}: ${i.message}`).join('; ') });
      saveLocalConstants(deps.store, list.data);
      return list.data;
    });

    // Whether a newer release is out; ?refresh=1 reads the releases again.
    api.get<{ Querystring: { refresh?: string } }>('/api/update', async (request): Promise<UpdateStatus> => {
      const [status, found] = await Promise.all([updates.status(request.query.refresh === '1'), install()]);
      const last = installStillNews(found, status.releases);
      return last ? { ...status, install: last } : status;
    });

    // Mail the sites sent, read from Mailpit on 127.0.0.1; 503 while Mailpit is not running.
    const mailpit = deps.mailpit ?? mailpitFetch;
    api.get<{ Querystring: { site?: string; start?: string } }>('/api/mail', async (request, reply): Promise<MailPage | undefined> => {
      const site = request.query.site ? localName.safeParse(request.query.site) : null;
      if (site && !site.success) return reply.code(400).send({ error: 'Give a local site name' });
      const start = Math.max(0, Math.min(100_000, Number(request.query.start ?? 0) || 0));
      try {
        return await listMail(mailpit, site?.data, start);
      } catch (error) {
        return reply.code(503).send({ error: `Mailpit is not reachable: ${(error as Error).message}` });
      }
    });
    // For the sidebar's dot: null while Mailpit is not running, so no dot then.
    api.get('/api/mail/unread', async (): Promise<{ unread: number | null }> => {
      try {
        return { unread: await unreadMail(mailpit) };
      } catch {
        return { unread: null };
      }
    });
    api.get<{ Params: { id: string } }>('/api/mail/:id', async (request, reply): Promise<MailMessage | undefined> => {
      if (!/^[\w-]{1,64}$/.test(request.params.id)) return reply.code(400).send({ error: 'Not a message id' });
      try {
        return (await readMail(mailpit, request.params.id)) ?? reply.code(404).send({ error: 'No such message' });
      } catch (error) {
        return reply.code(503).send({ error: `Mailpit is not reachable: ${(error as Error).message}` });
      }
    });

    // Changes MCP clients like Claude Code suggested; each runs only when clicked in the panel.
    api.get('/api/proposals', async (): Promise<QueuedProposal[]> => deps.store.pendingProposals());
    api.post<{ Params: { id: string }; Body: { status?: unknown } }>('/api/proposals/:id/close', async (request, reply) => {
      const status = request.body?.status;
      if (status !== 'ran' && status !== 'dismissed') return reply.code(400).send({ error: 'status must be ran or dismissed' });
      return deps.store.closeProposal(request.params.id, status) ? reply.code(204).send() : reply.code(404).send({ error: 'no such pending proposal' });
    });

    // The command that adds the panel's MCP server to Claude Code, with this machine's node and paths:
    // through current for a release, so it keeps working after updates.
    api.get('/api/mcp', async () => {
      return { command: `claude mcp add devmagic-panel -- ${process.execPath} --disable-warning=ExperimentalWarning ${panelCli(update)} mcp` };
    });

    registerCreateRoutes(api, { exec: deps.exec, jobs, uploadsDir: deps.uploadsDir });
    const siteRoutes = registerSiteRoutes(api, {
      cron,
      config: deps.config,
      exec: deps.exec,
      secrets: deps.secrets,
      wpcoreConf: deps.hostPaths.wpcoreConf,
      store: deps.store,
      coreStatus: deps.coreStatus ?? (async () => null),
      workDir: join(deps.uploadsDir, '..', 'tmp'),
      jobs,
      dmpRoot: deps.dmpRoot,
    });
    registerOrgRoutes(api, {
      exec: deps.exec,
      store: deps.store,
      gitHosts,
      home: deps.hostPaths.home,
      searchPath: deps.hostPaths.searchPath ?? process.env.PATH ?? '',
      workDir: join(deps.uploadsDir, '..', 'tmp'),
      settingsFile: orgSettingsFile,
      sites: siteRoutes.sites,
      installs: () => deps.store.installs(),
      trash: async () => (await listTrash(deps.exec, deps.dmpRoot)).map((e) => {
        const install = deps.store.archivedInstall(e.id);
        return install ? { ...e, install } : e;
      }),
      drafts: () => drafts.list(),
      secrets: deps.secrets,
      ...(deps.secretsFile ? { secretsFile: deps.secretsFile } : {}),
    });
    if (deps.secretsFile && deps.settingsFile) {
      const conventionsFile = join(dirname(deps.settingsFile), 'conventions.md');
      const conventions = () => readConventions(conventionsFile, deps.config, deps.hostPaths.wpcoreConf).text;
      registerAssistantRoutes(api, {
        secrets: deps.secrets,
        secretsFile: deps.secretsFile,
        settingsFile: deps.settingsFile,
        claude: deps.claude ?? defaultClaude,
        aura: siteRoutes.aura,
        chat: {
          config: deps.config,
          exec: deps.exec,
          store: deps.store,
          wpcoreConf: deps.hostPaths.wpcoreConf,
          sites: siteRoutes.sites,
          aura: siteRoutes.aura,
          environment: () => checkEnvironment({ config: deps.config, exec: deps.exec, secrets: deps.secrets(), paths: deps.hostPaths, dmpRoot: deps.dmpRoot, gitlabHosts }),
          coreStatus: deps.coreStatus ?? (async () => null),
          conventions,
          databaseSummary: (domain, path) => databaseSummary(browse(), domain, path),
        },
        wizard: {
          exec: deps.exec,
          workDir: join(deps.uploadsDir, '..', 'tmp'),
          uploadsDir: deps.uploadsDir,
          sites: siteRoutes.sites,
          cores: () => {
            const conf = readWpcoreConfig(deps.hostPaths.wpcoreConf);
            return conf ? installedCores(conf.coresDir) : [];
          },
          conventions,
          preset: (repo) => deps.store.preset(repo),
        },
        conventionsFile,
        defaultConventions: () => defaultConventions(deps.config, deps.hostPaths.wpcoreConf),
      });
    }
  });

  if (deps.webRoot && existsSync(deps.webRoot)) {
    // The build's files under /assets/ have their hash in the name and never
    // change, so the browser keeps them; the page itself is checked on each
    // load. A tab restored after a reboot then still gets the app from the
    // cache while the panel starts, and the app waits for it.
    await app.register(fastifyStatic, {
      root: deps.webRoot,
      cacheControl: false,
      setHeaders: (reply, file) => reply.header('cache-control', file.startsWith(join(deps.webRoot as string, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    // Page routes (which can end in a domain, like /sites/local.a.com) get the
    // app shell; a missing build file under /assets/ stays a 404.
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/assets/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

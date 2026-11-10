import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuraReport, CompatScan, CleanCopyInfo, CleanPreview, CoresReport, HtaccessReport, KeptDatabaseInfo, GitDetails, GitPullRequest, NetworkAdmins, RemovalInfo, FileListing, FileTrashEntry, FileView, RepoInspection, RepoLookup, RunDetail, RunPage, RunSummary, Site, SiteLog, SitePlugins, SiteThemes, SnapshotInfo, TakeoverPreview, TrashEntry, DumpPlugin, DumpTheme } from '@devmagic-panel/shared';
import { actions, branchName, cleanCopyName, gitUrl, isActionId, localName, mountPath, productionSettings, wpSlug, repoFolder, repoKey, repoPreset, snapshotName } from '@devmagic-panel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SystemConfig } from '../config.js';
import type { CoreStatusSource } from '../core-status.js';
import { readAura, wpCronSites } from '../aura.js';
import type { Executor } from '../exec.js';
import type { Secrets } from '../secrets.js';
import type { Jobs } from '../jobs.js';
import { INTERRUPTED, type RunRecord, type RunStore } from '../store.js';
import { installedCores, readWpcoreConfig } from '../wpcore.js';
import { debugLogPath, discoverSites, findVhost } from './discover.js';
import { coresReport } from './cores.js';
import { listSnapshots, snapshotDir } from './db.js';
import { cleanDir, listCleanCopies } from './export.js';
import { listKept } from './kept.js';
import { takeoverPreview, TakeoverRefused } from './takeover.js';
import { missingOnSite, missingThemesOnSite } from './install-plugins.js';
import { wporgPlugins, wporgThemes } from '../wporg-plugins.js';
import { z } from 'zod';
import { cleanPreview } from './clean-current.js';
import { readLocalConstants } from '../local-constants.js';
import { gitFolder, readGitDetails, readPullRequests } from './git.js';
import { parseApacheErrorLog, parseDebugLog, parseNginxErrorLog, tailFile } from './logs.js';
import { removalRefusal } from './remove.js';
import { readHtaccessReport } from './htaccess-rules.js';
import { htaccessDismissed } from './htaccess-watch.js';
import { inspectRepo, repoLookup, RepoRefused } from './repo.js';
import { currentSite } from './archive.js';
import { listTrash, TRASH_DAYS, trashFreeBytes } from './trash.js';
import { productionOnlyFor, readPlugins, readThemes } from './plugins.js';
import { readNetworkAdmins } from './network-admin.js';
import { fileTrashDir, listFileTrash } from './file-changes.js';
import { SiteActionRefused, siteFor, SiteNotFoundError, siteKey } from './site-actions.js';
import { parseWpConfig } from './wpconfig.js';
import { FileRefused, type FilesContext, listFolder, rawFile, readFile, siteFolder } from './files.js';
import type { WpCronReport } from '@devmagic-panel/shared';
import { readProduction, saveProduction } from './refresh.js';
import { type CronContext, CronRefused } from '../cron.js';
import { readWpCron, testWpCron } from './wp-cron.js';

export interface SiteRouteDeps {
  config: SystemConfig;
  exec: Executor;
  secrets: () => Secrets | null;
  wpcoreConf: string;
  store: RunStore;
  /** Scratch space for short-lived clones. */
  workDir: string;
  /** WordPress.org's status per core version, or null offline. */
  coreStatus: CoreStatusSource;
  /** Running jobs, to mark sites that are still being installed. */
  jobs?: Jobs;
  dmpRoot: string;
  /** The crontab and its runs, for a site's Cron tab and Aura. */
  cron: () => CronContext;
}

const CACHE_MS = 3000;

/** A site's debug.log, or its Apache error log filtered down to the site when the log is shared. */
export function readSiteLog(config: SystemConfig, domain: string, source: 'debug' | 'apache', path?: string): SiteLog | null {
  const vhost = findVhost(config, domain);
  if (!vhost?.docroot) return null;
  // A site under a path has its own folder, and shares its parent's vhost and Apache log.
  const docroot = path === undefined ? vhost.docroot : vhost.mounts.find((m) => m.path === path)?.docroot;
  if (!docroot) return null;
  if (source === 'apache' && vhost.server === 'nginx') {
    // A site on nginx logs to its own file, PHP's errors among them (FastCGI sent in stderr).
    const file = vhost.errorLog ?? join(config.NGINX_LOG_DIR, 'error.log');
    return { file, shared: false, exists: existsSync(file), lines: parseNginxErrorLog(tailFile(file, 512 * 1024)) };
  }
  if (source === 'apache') {
    const file = vhost.errorLog ?? join(config.APACHE_LOG_DIR, 'error.log');
    const shared = path !== undefined || !vhost.names.some((n) => file.includes(n));
    // A shared log has every site's lines: keep the ones naming this site's folder, or its domains when it is the vhost's own.
    const keep = shared ? (line: string) => line.includes(docroot) || (path === undefined && vhost.names.some((n) => line.includes(n))) : undefined;
    return { file, shared, exists: existsSync(file), lines: parseApacheErrorLog(tailFile(file, 512 * 1024), keep) };
  }
  const configFile = join(docroot, 'wp-config.php');
  const wp = existsSync(configFile) ? parseWpConfig(readFileSync(configFile, 'utf8')) : parseWpConfig('');
  const file = debugLogPath(docroot, wp);
  return { file, shared: false, exists: existsSync(file), lines: parseDebugLog(tailFile(file)) };
}

/** Read-only site routes; registered inside the authenticated scope. */
export function registerSiteRoutes(api: FastifyInstance, deps: SiteRouteDeps): { aura: () => Promise<AuraReport>; sites: () => Promise<Site[]> } {
  let cached: { at: number; sites: Promise<Site[]> } | null = null;
  const sites = () => {
    // A job that ended since (an install, a removal) changed what discovery sees.
    if (!cached || Date.now() - cached.at > CACHE_MS || (deps.jobs?.finishedAt ?? 0) >= cached.at) {
      cached = {
        at: Date.now(),
        sites: deps.coreStatus().then((coreStatus) => {
          const installs = deps.store.installs();
          return discoverSites({
            config: deps.config, exec: deps.exec, secrets: deps.secrets(), wpcoreConf: deps.wpcoreConf, coreStatus,
            htaccessDismissed: (domain) => htaccessDismissed(deps.store, domain),
            repoPaths: (site) => (installs.get(site)?.repos ?? []).map((r) => r.path),
          });
        }),
      };
      cached.sites.catch(() => {
        cached = null;
      });
    }
    return cached.sites;
  };

  // Any change (an action, a job step, an undo) can change what discovery sees.
  api.addHook('onResponse', async (request) => {
    if (request.method !== 'GET') cached = null;
  });

  // A site whose install job is still queued or running is marked, and so is one another job
  // works on (a removal, an import), so the UI holds its actions back.
  // Each site also says how it came here: what the panel recorded, else by the panel or by hand.
  const marked = (list: Site[]) => {
    const installs = deps.store.installs();
    return list.map((site) => {
      const key = `${site.domain}${site.path ?? ''}`;
      const install = installs.get(key);
      // The recorded install time first: a folder can be older than the site, like a repo cloned before.
      const s: Site = { ...site, ...(install?.at ? { addedAt: install.at } : {}), install: install ?? { how: site.panelMade ? 'panel' : 'hand' } };
      const job = deps.jobs?.activeFor('site.create', key);
      if (job) return { ...s, installing: job.id };
      const busy = deps.jobs?.busyFor(key);
      return busy ? { ...s, busy: { title: busy.title, ...(busy.jobId ? { jobId: busy.jobId } : {}) } } : s;
    });
  };

  api.get('/api/sites', async () => marked(await sites()));

  const aura = async (): Promise<AuraReport> =>
    readAura({ config: deps.config, exec: deps.exec, localConstants: readLocalConstants(deps.store), compatScans: (key) => deps.store.compatScans(key) as CompatScan[], wpCronTasks: () => wpCronSites(deps.exec) }, await sites());
  api.get('/api/aura', aura);

  // ?path=/learn picks the WordPress install under that path of the domain.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain', async (request, reply) => {
    const site = marked(await sites()).find((s) => s.domain === request.params.domain && s.path === request.query.path);
    return site ?? reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
  });

  // What removing a site would take: whether it can go to Deleted sites, its size and the free space there.
  api.get<{ Params: { domain: string } }>('/api/sites/:domain/removal', async (request, reply): Promise<RemovalInfo | undefined> => {
    const vhost = findVhost(deps.config, request.params.domain);
    if (!vhost?.docroot || vhost.names[0] !== request.params.domain) return reply.code(404).send({ error: `no site called ${request.params.domain}` });
    const refusal = removalRefusal(deps.config, request.params.domain, vhost.docroot, vhost.file);
    const du = refusal ? null : await deps.exec('du', ['-sb', '--', vhost.docroot], { timeoutMs: 60_000 });
    const size = du ? Number(du.stdout.split('\t')[0]) : NaN;
    const free = trashFreeBytes(deps.config);
    return { refusal, ...(Number.isFinite(size) ? { sizeBytes: size } : {}), ...(free !== undefined ? { freeBytes: free } : {}), trashDays: TRASH_DAYS };
  });

  // A site's .htaccess files read for nginx: what each rule is there, and for a site on nginx what its file has.
  api.get<{ Params: { domain: string } }>('/api/sites/:domain/htaccess', async (request, reply): Promise<HtaccessReport | undefined> => {
    const vhost = findVhost(deps.config, request.params.domain);
    if (!vhost?.docroot || vhost.names[0] !== request.params.domain) return reply.code(404).send({ error: `no site called ${request.params.domain}` });
    const applied = vhost.server === 'nginx' ? { rules: vhost.rules ?? [], sums: vhost.htaccessSums ?? {} } : undefined;
    return readHtaccessReport(vhost.docroot, applied, Date.now(), true, htaccessDismissed(deps.store, request.params.domain));
  });

  // Deleted sites, newest first; dmp-root reads the root-only trash.
  api.get('/api/trash', async (_request, reply): Promise<TrashEntry[] | undefined> => {
    try {
      // An entry whose domain a job works on (its restore, a new install) waits; the page shows that job.
      return (await listTrash(deps.exec, deps.dmpRoot)).map((entry) => {
        const install = deps.store.archivedInstall(entry.id);
        const current = currentSite(deps, entry.domain);
        const e: TrashEntry = { ...entry, ...(install ? { install } : {}), ...(current ? { replaces: { refusal: current.refusal } } : {}) };
        const busy = deps.jobs?.busyFor(e.domain);
        return busy ? { ...e, busy: { title: busy.title, ...(busy.jobId ? { jobId: busy.jobId } : {}) } } : e;
      });
    } catch (error) {
      return reply.code(503).send({ error: (error as Error).message });
    }
  });

  api.get<{ Params: { domain: string }; Querystring: { source?: string; path?: string } }>('/api/sites/:domain/logs', async (request, reply): Promise<SiteLog | undefined> => {
    const { path } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    const log = readSiteLog(deps.config, request.params.domain, request.query.source === 'apache' ? 'apache' : 'debug', path);
    return log ?? reply.code(404).send({ error: `no site called ${request.params.domain}` });
  });

  // The Files tab: a folder's entries, one file to look at, and a file as it is. Read only, in the site's folder.
  const filesOf = (domain: string, path: string | undefined): FilesContext => ({ root: siteFolder(deps.config, domain, path), readRoots: [readWpcoreConfig(deps.wpcoreConf)?.coresDir ?? ''].filter(Boolean) });
  const filesAnswer = <T>(request: { params: { domain: string }; query: { path?: string } }, reply: FastifyReply, read: (ctx: FilesContext) => T): T | undefined => {
    const refuse = (code: number, error: string): undefined => {
      void reply.code(code).send({ error });
      return undefined;
    };
    const { path } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return refuse(400, 'path must be like /learn');
    try {
      return read(filesOf(request.params.domain, path));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return refuse(404, error.message);
      if (error instanceof FileRefused) return refuse(400, error.message);
      throw error;
    }
  };
  api.get<{ Params: { domain: string }; Querystring: { path?: string; dir?: string } }>('/api/sites/:domain/files', async (request, reply): Promise<FileListing | FastifyReply> =>
    filesAnswer(request, reply, (ctx) => listFolder(ctx, request.query.dir ?? '')) ?? reply);
  api.get<{ Params: { domain: string }; Querystring: { path?: string; file?: string } }>('/api/sites/:domain/files/view', async (request, reply): Promise<FileView | FastifyReply> =>
    filesAnswer(request, reply, (ctx) => readFile(ctx, request.query.file ?? '')) ?? reply);
  // What the Files tab deleted and can still put back.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/files/trash', async (request, reply): Promise<FileTrashEntry[] | FastifyReply> =>
    filesAnswer(request, reply, () => listFileTrash(fileTrashDir(dirname(deps.workDir)), siteKey(request.params.domain, request.query.path))) ?? reply);
  // Always a download, except the four image types the tab shows: a site's HTML or SVG never runs in the panel's origin.
  api.get<{ Params: { domain: string }; Querystring: { path?: string; file?: string; show?: string } }>('/api/sites/:domain/files/raw', async (request, reply) => {
    const raw = filesAnswer(request, reply, (ctx) => rawFile(ctx, request.query.file ?? ''));
    if (!raw) return reply;
    const inline = request.query.show === '1' && raw.image !== undefined;
    return reply
      .header('content-type', inline ? raw.image : 'application/octet-stream')
      .header('content-length', raw.sizeBytes)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(raw.name)}`)
      .send(createReadStream(raw.file));
  });

  // Every theme of a site, with where its folder is. Read only.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/themes', async (request, reply): Promise<SiteThemes | undefined> => {
    const { path } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    try {
      return await readThemes(deps.exec, siteFor(deps.config, request.params.domain, path));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof SiteActionRefused) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  // Every plugin of a site, with the ones its install turned off as production-only marked.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/plugins', async (request, reply): Promise<SitePlugins | undefined> => {
    const { domain } = request.params;
    const { path } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    try {
      const site = siteFor(deps.config, domain, path);
      return await readPlugins(deps.exec, site, productionOnlyFor(deps.store, site.host));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof SiteActionRefused) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  // A site's WP-Cron events and intervals, how WP-Cron runs there, and the panel's cron tasks for it.
  api.get<{ Params: { domain: string }; Querystring: { path?: string; url?: string } }>('/api/sites/:domain/wp-cron', async (request, reply): Promise<WpCronReport | undefined> => {
    const { domain } = request.params;
    const { path, url } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    if (url !== undefined && !/^https?:\/\/[^\s]{1,490}$/.test(url)) return reply.code(400).send({ error: 'url must be a site address' });
    try {
      return await readWpCron(deps.cron(), siteFor(deps.config, domain, path), url);
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof SiteActionRefused || error instanceof CronRefused) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  // Whether WordPress can start WP-Cron by itself (wp cron test); changes nothing.
  api.get<{ Params: { domain: string }; Querystring: { path?: string; url?: string } }>('/api/sites/:domain/wp-cron/test', async (request, reply): Promise<{ ok: boolean; output: string } | undefined> => {
    const { path, url } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    if (url !== undefined && !/^https?:\/\/[^\s]{1,490}$/.test(url)) return reply.code(400).send({ error: 'url must be a site address' });
    try {
      return await testWpCron(deps.exec, siteFor(deps.config, request.params.domain, path), url);
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // A network's super admins, each with how many of its sites they have a role on.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/network-admins', async (request, reply): Promise<NetworkAdmins | undefined> => {
    const { domain } = request.params;
    const { path } = request.query;
    if (path !== undefined && !mountPath.safeParse(path).success) return reply.code(400).send({ error: 'path must be like /learn' });
    try {
      return await readNetworkAdmins(deps.exec, siteFor(deps.config, domain, path));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof SiteActionRefused) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  // Branches, recent commits and uncommitted changes of the site's repo, a mounted folder's (?mount=/learn) or a repo inside it (?repo=wp-content/themes/wandworks).
  api.get<{ Params: { domain: string }; Querystring: { mount?: string; repo?: string } }>('/api/sites/:domain/git', async (request, reply): Promise<GitDetails | undefined> => {
    const { mount, repo } = request.query;
    if (mount !== undefined && !mountPath.safeParse(mount).success) return reply.code(400).send({ error: 'mount must be a path like /learn' });
    if (repo !== undefined && !repoFolder.safeParse(repo).success) return reply.code(400).send({ error: 'repo must be a folder like wp-content/themes/wandworks' });
    try {
      return await readGitDetails(deps.exec, gitFolder(deps.config, request.params.domain, mount, repo));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // Open pull or merge requests, for the Git card's branches. Its own request, as gh or glab can take seconds.
  api.get<{ Params: { domain: string }; Querystring: { mount?: string; repo?: string } }>('/api/sites/:domain/git/pulls', async (request, reply): Promise<GitPullRequest[] | undefined> => {
    const { mount, repo } = request.query;
    if (mount !== undefined && !mountPath.safeParse(mount).success) return reply.code(400).send({ error: 'mount must be a path like /learn' });
    if (repo !== undefined && !repoFolder.safeParse(repo).success) return reply.code(400).send({ error: 'repo must be a folder like wp-content/themes/wandworks' });
    try {
      return await readPullRequests(deps.exec, gitFolder(deps.config, request.params.domain, mount, repo));
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  /** The snapshot folder key of a site, or null when there is no such site (or path). */
  const snapshotKey = (domain: string, path: string | undefined): string | null => {
    if (path !== undefined && !mountPath.safeParse(path).success) return null;
    const vhost = findVhost(deps.config, domain);
    if (vhost?.names[0] !== domain || (path !== undefined && !vhost.mounts.some((m) => m.path === path))) return null;
    return siteKey(domain, path);
  };

  // What a site's database names that its files lack, for the Plugins tab's Missing plugins. Read only.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/missing-plugins', async (request, reply): Promise<DumpPlugin[] | undefined> => {
    const key = snapshotKey(request.params.domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    try {
      const site = siteFor(deps.config, request.params.domain, request.query.path);
      return await missingOnSite(deps.exec, site.docroot, site.host);
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
  // Refresh from production: where the site's production is and how to copy it, kept in the panel's database. No secret in it.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/production', async (request, reply) => {
    if (!snapshotKey(request.params.domain, request.query.path)) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    return readProduction(deps.store, request.params.domain, request.query.path);
  });
  api.put<{ Params: { domain: string }; Querystring: { path?: string }; Body: unknown }>('/api/sites/:domain/production', async (request, reply) => {
    if (!snapshotKey(request.params.domain, request.query.path)) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    const body = productionSettings.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'An ssh host, a folder and table names' });
    return saveProduction(deps.store, request.params.domain, request.query.path, body.data);
  });
  // The themes a site's database uses that its files lack. Read only.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/missing-themes', async (request, reply): Promise<DumpTheme[] | undefined> => {
    if (!snapshotKey(request.params.domain, request.query.path)) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    try {
      const site = siteFor(deps.config, request.params.domain, request.query.path);
      return await missingThemesOnSite(deps.exec, site.docroot, site.host);
    } catch (error) {
      if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
  api.post<{ Body: unknown }>('/api/wporg/themes', async (request, reply) => {
    const body = z.object({ slugs: z.array(z.string().max(200)).max(100) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Theme slugs like twentytwentyfive' });
    return wporgThemes(body.data.slugs, deps.store);
  });
  // Whether plugins are on WordPress.org, by slug, kept a day. Read only.
  api.post<{ Body: unknown }>('/api/wporg/plugins', async (request, reply) => {
    // A name that cannot be a slug is left out of the answer, not a reason to refuse the rest.
    const body = z.object({ slugs: z.array(z.string().max(200)).max(100) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Plugin slugs like wp-rocket' });
    return wporgPlugins(body.data.slugs, deps.store);
  });

  // What taking over a site made by hand would do: read by dmp-root, which changes nothing with --check.
  api.get<{ Params: { domain: string } }>('/api/sites/:domain/takeover', async (request, reply): Promise<TakeoverPreview | undefined> => {
    const domain = localName.safeParse(request.params.domain);
    if (!domain.success) return reply.code(400).send({ error: 'A local name' });
    try {
      return await takeoverPreview(deps, domain.data);
    } catch (error) {
      if (error instanceof TakeoverRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/snapshots', async (request, reply): Promise<SnapshotInfo[] | undefined> => {
    const key = snapshotKey(request.params.domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    return listSnapshots(deps.config, key);
  });

  // Downloads one snapshot; the name must match the snapshot pattern, so it can never leave the folder.
  api.get<{ Params: { domain: string; name: string }; Querystring: { path?: string } }>('/api/sites/:domain/snapshots/:name', async (request, reply) => {
    const { domain, name } = request.params;
    if (!snapshotName.safeParse(name).success) return reply.code(400).send({ error: 'not a snapshot name' });
    const key = snapshotKey(domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${domain}${request.query.path ?? ''}` });
    const file = join(snapshotDir(deps.config, key), name);
    if (!existsSync(file)) return reply.code(404).send({ error: `no snapshot called ${name}` });
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${key}-${name}"`)
      .send(createReadStream(file));
  });

  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/clean-copies', async (request, reply): Promise<CleanCopyInfo[] | undefined> => {
    const key = snapshotKey(request.params.domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    return listCleanCopies(deps.config, key);
  });

  // Downloads one clean copy; the name must match the clean copy pattern, so it can never leave the folder.
  api.get<{ Params: { domain: string; name: string }; Querystring: { path?: string } }>('/api/sites/:domain/clean-copies/:name', async (request, reply) => {
    const { domain, name } = request.params;
    if (!cleanCopyName.safeParse(name).success) return reply.code(400).send({ error: 'not a clean copy name' });
    const key = snapshotKey(domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${domain}${request.query.path ?? ''}` });
    const file = join(cleanDir(deps.config, key), name);
    if (!existsSync(file)) return reply.code(404).send({ error: `no clean copy called ${name}` });
    return reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="${name}"`).send(createReadStream(file));
  });

  // What Clean this database would remove, and who could stay, read from the live database.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/clean-preview', async (request, reply): Promise<CleanPreview | undefined> => {
    if (!snapshotKey(request.params.domain, request.query.path)) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    return cleanPreview({ config: deps.config, exec: deps.exec, secrets: deps.secrets(), store: deps.store }, request.params.domain, request.query.path);
  });

  // A site's kept databases, with their size and when they go.
  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/kept-databases', async (request, reply): Promise<KeptDatabaseInfo[] | undefined> => {
    const key = snapshotKey(request.params.domain, request.query.path);
    if (!key) return reply.code(404).send({ error: `no site called ${request.params.domain}${request.query.path ?? ''}` });
    return listKept(deps.store, deps.exec, deps.secrets()?.mysql, key);
  });

  // What a repo URL tells before cloning: its default branch, and the wizard's answers from its last install here.
  api.get<{ Querystring: { url?: string; branch?: string } }>('/api/repo/inspect', async (request, reply): Promise<RepoInspection | undefined> => {
    const url = gitUrl.safeParse(request.query.url ?? '');
    const branch = request.query.branch ? branchName.safeParse(request.query.branch) : null;
    if (!url.success || (branch && !branch.success)) return reply.code(400).send({ error: 'Give a git URL and, optionally, a branch name' });
    try {
      const found = await inspectRepo(deps.exec, deps.workDir, url.data, branch?.data);
      const key = repoKey(url.data);
      const preset = key ? repoPreset.safeParse(deps.store.preset(key)) : null;
      return { ...found, ...(preset?.success ? { preset: preset.data } : {}) };
    } catch (error) {
      if (error instanceof RepoRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // What a branch holds for the WordPress step: its local helpers and its builds. Nothing is downloaded but a few small files.
  api.get<{ Querystring: { url?: string; branch?: string } }>('/api/repo/helpers', async (request, reply): Promise<RepoLookup | undefined> => {
    const url = gitUrl.safeParse(request.query.url ?? '');
    const branch = branchName.safeParse(request.query.branch ?? '');
    if (!url.success || !branch.success) return reply.code(400).send({ error: 'Give a git URL and a branch name' });
    try {
      return await repoLookup(deps.exec, deps.workDir, url.data, branch.data);
    } catch (error) {
      if (error instanceof RepoRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // Every shared core with its WordPress.org status and the sites on it, plus releases worth adding.
  // ?fresh=1 asks WordPress.org now instead of the hour-old copy.
  api.get<{ Querystring: { fresh?: string } }>('/api/cores/report', async (request): Promise<CoresReport> =>
    coresReport(deps.config, deps.wpcoreConf, await deps.coreStatus({ fresh: request.query.fresh === '1' })),
  );

  // Installed cores in the folder shared with the wpcore CLI, newest first.
  api.get('/api/cores', async (): Promise<string[]> => {
    const conf = readWpcoreConfig(deps.wpcoreConf);
    return conf ? installedCores(conf.coresDir) : [];
  });

  // Newest first, a numbered page at a time: ?page=2 is the second newest.
  api.get<{ Querystring: { page?: string } }>('/api/runs', async (request, reply): Promise<RunPage | undefined> => {
    const asked = request.query.page ?? '1';
    if (!/^[1-9]\d{0,6}$/.test(asked)) return reply.code(400).send({ error: 'page must be a number from 1' });
    const page = Number(asked);
    const { runs, total } = deps.store.page(page, RUNS_PAGE);
    return { runs: runs.map(runSummary), page, pageSize: RUNS_PAGE, total };
  });

  api.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply): Promise<RunDetail | undefined> => {
    const record = /^\d{1,12}$/.test(request.params.id) ? deps.store.get(Number(request.params.id)) : undefined;
    if (!record) return reply.code(404).send({ error: 'No such run' });
    let input: unknown = null;
    try {
      input = JSON.parse(record.input);
    } catch {
      // input is always JSON we wrote; show nothing for anything else
    }
    const job = deps.jobs?.forRun(record.id);
    return { ...runSummary(record), input, output: record.output, ...(job ? { jobId: job.id } : {}) };
  });

  return { aura, sites };
}

/** Run history pages hold this many runs. */
export const RUNS_PAGE = 50;

function runSummary(r: RunRecord): RunSummary {
  let target: string | undefined;
  try {
    const input = JSON.parse(r.input) as { domain?: unknown };
    if (typeof input.domain === 'string') target = input.domain;
  } catch {
    // input is always JSON we wrote; ignore anything else
  }
  return {
    id: r.id,
    action: r.action,
    title: isActionId(r.action) ? actions[r.action].title : r.action,
    ...(target ? { target } : {}),
    ok: r.exitCode === null ? null : r.exitCode === 0,
    ...(r.exitCode === INTERRUPTED ? { interrupted: true as const } : {}),
    ...(r.skipped ? { skipped: r.skipped } : {}),
    startedAt: r.startedAt,
    ...(r.finishedAt ? { durationMs: Date.parse(r.finishedAt) - Date.parse(r.startedAt) } : {}),
  };
}

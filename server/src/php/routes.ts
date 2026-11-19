import type { PhpFpmFinding, PhpInfo, PhpIniReport, PhpPackage, PhpReport, PhpSettings, SiteCompat, SitePhp, VersionCompat } from '@devmagic-panel/shared';
import { localName, mountPath, PHP_VERSION_PATTERN } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import type { SystemConfig } from '../config.js';
import type { Executor } from '../exec.js';
import type { RunStore } from '../store.js';
import { readSiteCompat, readVersionCompat } from './compat.js';
import { readFpmFindings } from './fpm-check.js';
import { cliInfo, PhpInfoUnavailable, webInfo } from './info.js';
import { readIniReport } from './ini.js';
import { SiteActionRefused, siteFor, SiteNotFoundError } from '../sites/site-actions.js';
import { poolFolder, sitePool } from './pools.js';
import { readPhpSettings } from './settings.js';
import { defaultPhpVersion, readSitePhp } from './site-php.js';
import { majorsOf, type PhpReleases } from './releases.js';
import { apachePhpVersion, APT_LISTS_READ_KEY, APT_PATHS, type AptPaths, installedVersions, phpReport, readPhpPackages, type SitesByVersion } from './versions.js';

export interface PhpRouteDeps {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  sitesByVersion?: SitesByVersion;
  apt?: AptPaths;
  /** For a site's compatibility scans; the panel's data folder holds the scanner. */
  store?: RunStore;
  dataDir?: string;
  /** php.net's releases, to say when one is out that apt's sources lack; left out, they are not compared. */
  releases?: PhpReleases;
}

/** The Services page's PHP tab, read only; its changes are registry actions. */
export function registerPhpRoutes(api: FastifyInstance, deps: PhpRouteDeps): void {
  const known = (version: string) => PHP_VERSION_PATTERN.test(version) && installedVersions(deps.config).some((v) => v.version === version);

  // Check again (refresh=1) reads php.net again once its list is over an hour old; an opening reads it in the background when it is due.
  api.get<{ Querystring: { refresh?: string } }>('/api/php', async (request): Promise<PhpReport> => {
    const majors = majorsOf(installedVersions(deps.config).map((v) => v.version));
    if (deps.releases && request.query.refresh === '1') await deps.releases.refreshForced(majors);
    else if (deps.releases) void deps.releases.refresh(majors);
    return phpReport(deps.config, deps.exec, deps.sitesByVersion, Date.now, deps.apt ?? APT_PATHS, deps.store?.getMeta(APT_LISTS_READ_KEY), deps.releases?.kept() ?? null);
  });
  api.get('/api/php/fpm-check', async (): Promise<PhpFpmFinding[]> => readFpmFindings(deps.config));

  api.get<{ Params: { version: string } }>('/api/php/:version/ini', async (request, reply): Promise<PhpIniReport> => {
    if (!known(request.params.version)) return reply.code(404).send({ error: 'No such PHP version' });
    return readIniReport(deps.config, request.params.version);
  });

  api.get<{ Params: { version: string } }>('/api/php/:version/packages', async (request, reply): Promise<PhpPackage[]> => {
    if (!known(request.params.version)) return reply.code(404).send({ error: 'No such PHP version' });
    return readPhpPackages(deps.exec, request.params.version);
  });

  api.get<{ Params: { version: string } }>('/api/php/:version/compat', async (request, reply): Promise<VersionCompat> => {
    if (!known(request.params.version)) return reply.code(404).send({ error: 'No such PHP version' });
    if (!deps.store || !deps.dataDir) return reply.code(404).send({ error: 'Compatibility scans are not available' });
    return readVersionCompat({ config: deps.config, exec: deps.exec, store: deps.store, dataDir: deps.dataDir }, request.params.version);
  });

  api.get<{ Params: { version: string } }>('/api/php/:version/settings', async (request, reply): Promise<PhpSettings> => {
    if (!known(request.params.version)) return reply.code(404).send({ error: 'No such PHP version' });
    return readPhpSettings(deps.config, request.params.version);
  });

  api.get<{ Params: { version: string }; Querystring: { sapi?: string } }>('/api/php/:version/info', async (request, reply): Promise<PhpInfo> => {
    const { version } = request.params;
    if (!known(version)) return reply.code(404).send({ error: 'No such PHP version' });
    try {
      if (request.query.sapi === 'cli') return await cliInfo(deps.exec, deps.dmpRoot, version);
      // mod_php answers on the vhost itself; another version through its FPM pool.
      return await webInfo(deps.exec, deps.config, deps.dmpRoot, apachePhpVersion(deps.config) === version ? 'info.php' : `php${version}/info.php`);
    } catch (error) {
      if (error instanceof PhpInfoUnavailable) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // A site's PHP tab: its version and settings, and PHP info from the PHP that serves it.
  const siteOf = (domain: string, path: string | undefined) => {
    if (!localName.safeParse(domain).success || (path !== undefined && !mountPath.safeParse(path).success)) throw new SiteActionRefused('Give a local site name and path');
    return siteFor(deps.config, domain, path);
  };
  const refusal = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof SiteNotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof SiteActionRefused) return reply.code(400).send({ error: error.message });
    if (error instanceof PhpInfoUnavailable) return reply.code(409).send({ error: error.message });
    throw error;
  };

  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/php', async (request, reply): Promise<SitePhp> => {
    try {
      return readSitePhp(deps.config, siteOf(request.params.domain, request.query.path));
    } catch (error) {
      return refusal(reply, error) as never;
    }
  });

  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/php/compat', async (request, reply): Promise<SiteCompat> => {
    try {
      const site = siteOf(request.params.domain, request.query.path);
      if (!deps.store || !deps.dataDir) return reply.code(404).send({ error: 'Compatibility scans are not available' }) as never;
      return await readSiteCompat({ config: deps.config, exec: deps.exec, store: deps.store, dataDir: deps.dataDir }, site);
    } catch (error) {
      return refusal(reply, error) as never;
    }
  });

  api.get<{ Params: { domain: string }; Querystring: { path?: string } }>('/api/sites/:domain/php/info', async (request, reply): Promise<PhpInfo> => {
    try {
      const site = siteOf(request.params.domain, request.query.path);
      const folder = poolFolder(deps.config, site.docroot);
      if (folder && sitePool(deps.config, site.docroot)) return await webInfo(deps.exec, deps.config, deps.dmpRoot, `dmp-${folder}/info.php`);
      const version = defaultPhpVersion(deps.config);
      return await webInfo(deps.exec, deps.config, deps.dmpRoot, version && apachePhpVersion(deps.config) !== version ? `php${version}/info.php` : 'info.php');
    } catch (error) {
      return refusal(reply, error) as never;
    }
  });
}

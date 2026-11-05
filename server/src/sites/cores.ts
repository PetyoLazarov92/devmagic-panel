import type { ActionInput, CoresReport } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { latestOf, type CoreStatusMap } from '../core-status.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { installedCores, readWpcoreConfig } from '../wpcore.js';
import { readCore } from './discover.js';
import { readSiteVhosts } from './vhost.js';

export class CoreRefused extends Error {}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Which site uses which core, read from each site's wp-includes: the vhost's
 * own and every WordPress install it serves under a path, named
 * local.northwind.com/learn.
 */
function sitesByCore(config: SystemConfig): Array<{ domain: string; core: ReturnType<typeof readCore> }> {
  return readSiteVhosts(config).flatMap((v) => {
    const domain = v.names[0];
    if (!v.docroot || !domain) return [];
    const under = v.mounts.map((m) => ({ domain: `${domain}${m.path}`, core: readCore(m.docroot) })).filter((s) => s.core.kind !== 'none');
    return [{ domain, core: readCore(v.docroot) }, ...under];
  });
}

/** The newest release of each recent branch (7.1, 7.0, 6.9...) that is still safe. */
export function addableReleases(status: CoreStatusMap, installed: string[], branches = 6): CoresReport['available'] {
  const tips = new Map<string, string>();
  for (const version of Object.keys(status)) {
    const branch = version.split('.').slice(0, 2).join('.');
    const tip = tips.get(branch);
    if (!tip || compare(version, tip) > 0) tips.set(branch, version);
  }
  return [...tips.values()]
    .sort((a, b) => compare(b, a))
    .slice(0, branches)
    .filter((v) => status[v] !== 'insecure' && !installed.includes(v))
    .map((version) => ({ version, status: status[version] as CoresReport['available'][number]['status'] }));
}

export function coresReport(config: SystemConfig, wpcoreConf: string, status: CoreStatusMap | null): CoresReport {
  const conf = readWpcoreConfig(wpcoreConf);
  const coresDir = conf?.coresDir ?? '';
  const installed = conf ? installedCores(conf.coresDir) : [];
  const sites = sitesByCore(config);
  const latest = status ? latestOf(status) : undefined;
  const statusOf = (v: string) => (status?.[v] ? { status: status[v] } : {});
  return {
    coresDir,
    ready: conf !== null && installed.length > 0,
    ...(latest ? { latest } : {}),
    cores: installed.map((version) => ({
      version,
      ...statusOf(version),
      sites: sites.filter((s) => s.core.kind === 'wpcore' && s.core.version === version).map((s) => s.domain),
    })),
    standalone: sites.flatMap((s) => (s.core.kind === 'standalone' && s.core.version ? [{ domain: s.domain, version: s.core.version, ...statusOf(s.core.version) }] : [])),
    available: status ? addableReleases(status, installed) : [],
    insecure: status ? Object.keys(status).filter((v) => status[v] === 'insecure').sort((a, b) => compare(b, a)) : [],
  };
}

export interface CoreContext {
  config: SystemConfig;
  exec: Executor;
  wpcoreBin: string;
  wpcoreConf: string;
  coreStatus?: () => Promise<CoreStatusMap | null>;
}

/** Downloads a release into the shared cores folder; wpcore never gets to ask anything (stdin answers no). */
export async function planAddCore(ctx: CoreContext, { version, confirmInsecure }: ActionInput<'core.add'>): Promise<JobStep[]> {
  const conf = readWpcoreConfig(ctx.wpcoreConf);
  if (!conf) throw new CoreRefused('wpcore has no config yet; run the installer first');
  if (installedCores(conf.coresDir).includes(version)) throw new CoreRefused(`WordPress ${version} is already installed`);
  const status = (await ctx.coreStatus?.()) ?? null;
  if (status && !status[version]) throw new CoreRefused(`WordPress ${version} is not a release on wordpress.org`);
  if (status?.[version] === 'insecure' && confirmInsecure !== version) {
    throw new CoreRefused(`WordPress ${version} has known security issues; to add it for testing, confirm by typing the version`);
  }
  return [
    {
      id: 'add',
      label: `Download WordPress ${version} into ${conf.coresDir}`,
      run: () => ctx.exec('sudo', ['-n', ctx.wpcoreBin, 'add', version], { input: 'n\n', timeoutMs: 10 * 60_000 }),
    },
  ];
}

export async function removeCore(ctx: CoreContext, { version }: ActionInput<'core.remove'>): Promise<ExecResult[]> {
  const conf = readWpcoreConfig(ctx.wpcoreConf);
  if (!conf || !installedCores(conf.coresDir).includes(version)) throw new CoreRefused(`WordPress ${version} is not installed`);
  const users = sitesByCore(ctx.config).filter((s) => s.core.kind === 'wpcore' && s.core.version === version);
  if (users.length) throw new CoreRefused(`WordPress ${version} is used by ${users.map((u) => u.domain).join(', ')}; switch them first`);
  // wpcore asks to confirm; the panel already did, with the typed version.
  return [await ctx.exec('sudo', ['-n', ctx.wpcoreBin, 'remove-core', version], { input: 'y\n', timeoutMs: 120_000 })];
}

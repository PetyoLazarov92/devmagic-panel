import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { SiteActionRefused } from '../sites/site-actions.js';
import { readPools } from './pools.js';
import { apachePhpVersion, fpmDefaultVersion, installedVersions } from './versions.js';

/**
 * Installing, updating and removing PHP versions and their module packages,
 * as jobs through dmp-root (php-install, php-package, php-upgrade,
 * php-remove), which only takes php<version>-<name> packages from the
 * sources apt already has. apt can take minutes, so the steps get time.
 */

const APT_TIMEOUT = 30 * 60_000;

export interface AptContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
}

const root = (ctx: AptContext, args: string[]) => ctx.exec('sudo', ['-n', ctx.dmpRoot, ...args], { timeoutMs: APT_TIMEOUT });
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
const tidy = (r: ExecResult): ExecResult => (r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` });
const installed = (ctx: AptContext, version: string) => installedVersions(ctx.config).some((v) => v.version === version);

/** Why a version cannot go: Apache runs it, the command line is it, or a site's pool runs it (dmp-root checks again). */
export async function removalRefusal(ctx: AptContext, version: string): Promise<string | undefined> {
  if (apachePhpVersion(ctx.config) === version) return `Apache runs PHP ${version} as mod_php`;
  if (fpmDefaultVersion(ctx.config) === version) return `every site without a PHP of its own runs on PHP ${version} through PHP-FPM`;
  const cli = await ctx.exec('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']);
  if (cli.code === 0 && cli.stdout.trim() === version) return `php on the command line is PHP ${version}`;
  const sites = readPools(ctx.config).filter((p) => p.version === version).map((p) => p.folder);
  if (sites.length > 0) return `these sites run on it: ${sites.join(', ')}`;
  return undefined;
}

export function planInstallVersion(ctx: AptContext, version: string): JobStep[] {
  if (installed(ctx, version)) throw new SiteActionRefused(`PHP ${version} is installed already.`);
  return [
    {
      id: 'install',
      label: `Install PHP ${version} with PHP-FPM, the command line and the common modules`,
      weight: 10,
      run: async (job) => {
        const r = await root(ctx, ['php-install', version]);
        if (r.code === 0) job.onUndo(`Remove PHP ${version} again`, async () => tidy(await root(ctx, ['php-remove', version])));
        return tidy(r);
      },
    },
  ];
}

export function planPhpPackage(ctx: AptContext, version: string, name: string, how: 'install' | 'remove'): JobStep[] {
  if (!installed(ctx, version)) throw new SiteActionRefused(`PHP ${version} is not installed.`);
  const other = how === 'install' ? 'remove' : 'install';
  return [
    {
      id: how,
      label: `${how === 'install' ? 'Install' : 'Remove'} php${version}-${name}`,
      weight: 3,
      run: async (job) => {
        const r = await root(ctx, ['php-package', version, name, how]);
        if (r.code === 0) job.onUndo(`${other === 'install' ? 'Install' : 'Remove'} php${version}-${name} again`, async () => tidy(await root(ctx, ['php-package', version, name, other])));
        return tidy(r);
      },
    },
  ];
}

/** An update has no Undo: apt keeps no older build to go back to. */
export function planUpgradeVersion(ctx: AptContext, version: string): JobStep[] {
  if (!installed(ctx, version)) throw new SiteActionRefused(`PHP ${version} is not installed.`);
  return [{ id: 'upgrade', label: `Update PHP ${version} to the newest build apt has`, weight: 5, run: async () => tidy(await root(ctx, ['php-upgrade', version])) }];
}

export async function planRemoveVersion(ctx: AptContext, version: string): Promise<JobStep[]> {
  if (!installed(ctx, version)) throw new SiteActionRefused(`PHP ${version} is not installed.`);
  const why = await removalRefusal(ctx, version);
  if (why) throw new SiteActionRefused(`PHP ${version} stays: ${why}.`);
  return [
    {
      id: 'remove',
      label: `Remove PHP ${version} (its settings stay in ${ctx.config.PHP_CONF_DIR}/${version})`,
      weight: 5,
      run: async (job) => {
        const r = await root(ctx, ['php-remove', version]);
        if (r.code === 0) job.onUndo(`Install PHP ${version} again`, async () => tidy(await root(ctx, ['php-install', version])));
        return tidy(r);
      },
    },
  ];
}

/** php on the command line onto a version with a command line; no Undo needed, the old version is one click away. */
export async function setCliVersion(ctx: AptContext, version: string): Promise<ExecResult[]> {
  const v = installedVersions(ctx.config).find((x) => x.version === version);
  if (!v) throw new SiteActionRefused(`PHP ${version} is not installed.`);
  if (!v.sapis.includes('cli')) throw new SiteActionRefused(`PHP ${version} has no command line: install php${version}-cli first.`);
  return [tidy(await ctx.exec('sudo', ['-n', ctx.dmpRoot, 'php-cli', version]))];
}

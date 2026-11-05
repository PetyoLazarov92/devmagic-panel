import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PhpModule, PhpPackage, PhpReport, PhpSapi, PhpVersion, PhpXdebug } from '@devmagic-panel/shared';
import { PHP_OFFERED_VERSIONS, PHP_REQUIRED_MODULES, PHP_SAPIS, PHP_VERSION_PATTERN } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { Executor } from '../exec.js';
import { hasSapi } from './ini.js';
import { unitState } from '../services.js';

/** Same file name as DMP_XDEBUG_INI_NAME in scripts/lib/php.sh. */
export const XDEBUG_INI = '99-devmagic-panel-xdebug.ini';

/** The PHP version of the enabled mod_php, from mods-enabled/php8.3.load (as dmp-root reads it). */
export function apachePhpVersion(config: SystemConfig): string | undefined {
  const mods = join(dirname(config.APACHE_SITES_AVAILABLE), 'mods-enabled');
  if (!existsSync(mods)) return undefined;
  for (const name of readdirSync(mods)) {
    const m = /^php(\d+\.\d+)\.load$/.exec(name);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * The installed versions, newest first, and the parts each has. A part is
 * installed when its package's marker is in PHP_LIB_DIR/<version>/sapi
 * (php8.3-cli puts sapi/cli there) and its config folder exists; apt remove
 * takes the markers and leaves /etc/php/<version>, so a removed version is
 * not listed.
 */
export function installedVersions(config: SystemConfig): Array<{ version: string; sapis: PhpSapi[] }> {
  if (!existsSync(config.PHP_LIB_DIR) || !existsSync(config.PHP_CONF_DIR)) return [];
  return readdirSync(config.PHP_LIB_DIR)
    .filter((name) => PHP_VERSION_PATTERN.test(name) && existsSync(join(config.PHP_CONF_DIR, name, 'mods-available')))
    .map((version) => ({
      version,
      sapis: PHP_SAPIS.filter((sapi) => hasSapi(config, version, sapi)),
    }))
    .filter((v) => v.sapis.length > 0)
    .sort((a, b) => Number(b.version) - Number(a.version));
}

/** The version every site without a pool runs once mod_php is off: STATE_DIR/php-default, which dmp-root php-switch-fpm writes. */
export function fpmDefaultVersion(config: SystemConfig): string | undefined {
  try {
    const version = readFileSync(join(config.STATE_DIR, 'php-default'), 'utf8').trim();
    return PHP_VERSION_PATTERN.test(version) && existsSync(join(config.PHP_LIB_DIR, version, 'sapi', 'fpm')) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The versions with mod_php installed (their package's marker), whether Apache loads one or not. */
export const modPhpVersions = (config: SystemConfig): string[] =>
  existsSync(config.PHP_LIB_DIR) ? readdirSync(config.PHP_LIB_DIR).filter((v) => PHP_VERSION_PATTERN.test(v) && existsSync(join(config.PHP_LIB_DIR, v, 'sapi', 'apache2'))).sort().reverse() : [];

/** The web part whose settings sites see for a version: Apache's when mod_php is this version, else FPM's. */
export function webSapi(config: SystemConfig, version: string): 'apache2' | 'fpm' | undefined {
  if (apachePhpVersion(config) === version && hasSapi(config, version, 'apache2')) return 'apache2';
  if (hasSapi(config, version, 'fpm')) return 'fpm';
  return hasSapi(config, version, 'apache2') ? 'apache2' : undefined;
}

/** `xdebug.mode=debug` style settings from an ini file. */
function iniValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const m = new RegExp(`^\\s*${key.replace('.', '\\.')}\\s*=\\s*"?([^"\\n;]+?)"?\\s*$`, 'm').exec(readFileSync(file, 'utf8'));
  return m?.[1];
}

/** A module is on for a SAPI when its conf.d has the priority link phpenmod makes, like 20-soap.ini. */
const enabledIn = (confD: string): Set<string> =>
  new Set(existsSync(confD) ? readdirSync(confD).map((f) => /^\d+-([a-z0-9_]+)\.ini$/.exec(f)?.[1]).filter((n): n is string => Boolean(n)) : []);

export function readXdebug(config: SystemConfig, version: string): PhpXdebug {
  const base = join(config.PHP_CONF_DIR, version);
  const moduleIni = join(base, 'mods-available', 'xdebug.ini');
  if (!existsSync(moduleIni)) return { installed: false, enabled: false, reason: `Xdebug is not installed for PHP ${version}: apt install php${version}-xdebug` };
  const sapi = webSapi(config, version);
  if (!sapi) return { installed: true, enabled: false, reason: `PHP ${version} has no web part (mod_php or FPM) to debug.` };
  const confD = join(base, sapi, 'conf.d');
  const panelIni = join(confD, XDEBUG_INI);
  const mode = iniValue(panelIni, 'xdebug.mode') ?? iniValue(moduleIni, 'xdebug.mode');
  const start = iniValue(panelIni, 'xdebug.start_with_request') ?? iniValue(moduleIni, 'xdebug.start_with_request');
  const modes = mode?.split(',').map((m) => m.trim()).filter(Boolean);
  return { installed: true, enabled: enabledIn(confD).has('xdebug'), ...(modes?.length ? { modes } : {}), ...(start ? { startWithRequest: start } : {}) };
}

/** The library a module's ini loads, like soap.so from `extension=soap.so`. */
function moduleLibrary(file: string): string | undefined {
  try {
    return /^\s*(?:zend_)?extension\s*=\s*"?([^"\s;]+)"?/m.exec(readFileSync(file, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/** Where a version loads its modules from (PHP_EXTENSION_DIR), asked from its command line; undefined without one. */
export async function extensionDir(exec: Executor, version: string): Promise<string | undefined> {
  const r = await exec(`php${version}`, ['-n', '-r', 'echo PHP_EXTENSION_DIR;']);
  const dir = r.stdout.trim();
  return r.code === 0 && dir.startsWith('/') ? dir : undefined;
}

/**
 * The modules installed for a version, less Xdebug, each with the parts it is
 * on for. With the version's extension folder, one whose library is not there
 * is marked missing: apt remove takes the library and keeps the ini and its links.
 */
export function readPhpModules(config: SystemConfig, version: string, extDir?: string): PhpModule[] {
  const base = join(config.PHP_CONF_DIR, version);
  const available = join(base, 'mods-available');
  if (!existsSync(available)) return [];
  const parts = PHP_SAPIS.filter((sapi) => hasSapi(config, version, sapi)).map((sapi) => [sapi, enabledIn(join(base, sapi, 'conf.d'))] as const);
  return readdirSync(available)
    .map((f) => /^([a-z0-9_]{1,40})\.ini$/.exec(f)?.[1])
    .filter((n): n is string => Boolean(n) && n !== 'xdebug')
    .sort()
    .map((name) => {
      const lib = extDir ? moduleLibrary(join(available, `${name}.ini`)) : undefined;
      const missing = lib !== undefined && !existsSync(lib.startsWith('/') ? lib : join(extDir as string, lib.endsWith('.so') ? lib : `${lib}.so`));
      return {
        name,
        ...Object.fromEntries(parts.map(([sapi, on]) => [sapi, on.has(name)])),
        required: (PHP_REQUIRED_MODULES as readonly string[]).includes(name),
        ...(missing ? { missing: true } : {}),
      };
    });
}

/** Where apt keeps its sources and what system this is; tests point them at a temp tree. */
export interface AptPaths {
  sourcesDir: string;
  osRelease: string;
}
export const APT_PATHS: AptPaths = { sourcesDir: '/etc/apt/sources.list.d', osRelease: '/etc/os-release' };

/** Whether apt has a source of PHP versions, and whether this is an Ubuntu (Mint too) or a Debian system. */
export function readAptSources(paths: AptPaths): PhpReport['sources'] {
  let php = false;
  if (existsSync(paths.sourcesDir)) {
    for (const file of readdirSync(paths.sourcesDir).filter((f) => f.endsWith('.list') || f.endsWith('.sources'))) {
      try {
        if (/ondrej\/php|packages\.sury\.org\/php/.test(readFileSync(join(paths.sourcesDir, file), 'utf8'))) php = true;
      } catch {
        // An unreadable source says nothing.
      }
    }
  }
  let release = '';
  try {
    release = readFileSync(paths.osRelease, 'utf8');
  } catch {
    release = '';
  }
  const family = `${/^ID=(.*)$/m.exec(release)?.[1] ?? ''} ${/^ID_LIKE=(.*)$/m.exec(release)?.[1] ?? ''}`.replaceAll('"', '');
  const distro = /\bubuntu\b/.test(family) ? 'ubuntu' : /\bdebian\b/.test(family) ? 'debian' : 'other';
  return { php, distro };
}

/** The php<version>-* packages apt has, with whether each is installed; FPM, the command line and tools left out. */
export async function readPhpPackages(exec: Executor, version: string): Promise<PhpPackage[]> {
  const [names, installed] = await Promise.all([
    exec('apt-cache', ['pkgnames', `php${version}-`], { timeoutMs: 20_000 }),
    exec('dpkg-query', ['-W', '-f=${binary:Package} ${db:Status-Abbrev}\n', `php${version}-*`], { timeoutMs: 20_000 }),
  ]);
  const have = new Set(installed.stdout.split('\n').filter((l) => /\sii/.test(l)).map((l) => (l.split(' ')[0] ?? '').replace(/:.*$/, '')));
  const skip = new Set(['cli', 'fpm', 'cgi', 'common', 'dev', 'phpdbg', 'embed', 'dbg']);
  return [...new Set(names.stdout.split('\n').map((n) => n.trim()))]
    .map((pkg) => ({ pkg, name: pkg.slice(`php${version}-`.length) }))
    .filter(({ pkg, name }) => pkg.startsWith(`php${version}-`) && /^[a-z0-9][a-z0-9.+-]{1,30}$/.test(name) && !skip.has(name))
    .map(({ pkg, name }) => ({ name, installed: have.has(pkg) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Debian's package version, like 1:8.3.14-1+ubuntu24.04.1, as the PHP release it carries: 8.3.14. */
export const upstreamVersion = (pkg: string): string => pkg.replace(/^\d+:/, '').split(/[-+~]/)[0] ?? pkg;

/**
 * Installed and candidate package versions from `apt-cache policy`, which
 * needs no root. One call for every version's php<v>-common.
 */
export async function packageVersions(exec: Executor, versions: string[]): Promise<Map<string, { installed?: string; candidate?: string }>> {
  const out = new Map<string, { installed?: string; candidate?: string }>();
  if (versions.length === 0) return out;
  const r = await exec('apt-cache', ['policy', ...versions.map((v) => `php${v}-common`)], { timeoutMs: 20_000 });
  if (r.code !== 0) return out;
  let current: string | undefined;
  for (const line of r.stdout.split('\n')) {
    const head = /^php(\d\.\d)-common:$/.exec(line);
    if (head) {
      current = head[1] as string;
      out.set(current, {});
      continue;
    }
    const field = /^\s+(Installed|Candidate):\s+(\S+)/.exec(line);
    const value = field?.[2];
    if (!current || !field || !value || value === '(none)') continue;
    const entry = out.get(current) as { installed?: string; candidate?: string };
    if (field[1] === 'Installed') entry.installed = value;
    else entry.candidate = value;
  }
  return out;
}

/** The new build apt offers, like 8.3.14, or "a new build of 8.3.6" when only the package revision moved. */
export function updateLabel(installed?: string, candidate?: string): string | undefined {
  if (!installed || !candidate || installed === candidate) return undefined;
  const from = upstreamVersion(installed);
  const to = upstreamVersion(candidate);
  // apt-cache only offers a candidate it would install; a lower one means the installed came from elsewhere.
  if (to.localeCompare(from, undefined, { numeric: true }) < 0) return undefined;
  return to === from ? `a new build of ${to}` : to;
}

/** Sites whose pool runs a version, filled in once sites can have their own (see pools). */
export type SitesByVersion = (version: string) => string[];

export async function phpReport(config: SystemConfig, exec: Executor, sitesByVersion: SitesByVersion = () => [], now = Date.now, apt: AptPaths = APT_PATHS): Promise<PhpReport> {
  const versions = installedVersions(config);
  const apache = apachePhpVersion(config);
  const offered = PHP_OFFERED_VERSIONS.filter((v) => !versions.some((i) => i.version === v));
  const [packages, offers, cli, extDirs, ...fpm] = await Promise.all([
    packageVersions(exec, versions.map((v) => v.version)),
    packageVersions(exec, offered),
    exec('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']),
    Promise.all(versions.map((v) => (v.sapis.includes('cli') ? extensionDir(exec, v.version) : Promise.resolve(undefined)))),
    ...versions.map((v) => (v.sapis.includes('fpm') ? unitState(exec, `php${v.version}-fpm`) : Promise.resolve('missing' as const))),
  ]);
  const cliVersion = cli.code === 0 ? cli.stdout.trim() : undefined;
  const list: PhpVersion[] = versions.map(({ version, sapis }, i) => {
    const pkg = packages.get(version);
    const state = fpm[i];
    const update = updateLabel(pkg?.installed, pkg?.candidate);
    return {
      version,
      ...(pkg?.installed ? { patch: upstreamVersion(pkg.installed) } : {}),
      ...(update ? { update } : {}),
      sapis,
      apache: apache === version,
      cli: cliVersion === version,
      ...(state && state !== 'missing' ? { fpm: state } : {}),
      sites: sitesByVersion(version),
      modules: readPhpModules(config, version, extDirs[i]),
      xdebug: readXdebug(config, version),
    };
  });
  const fpmDefault = apache ? undefined : fpmDefaultVersion(config);
  const defaultVersion = apache ?? fpmDefault ?? cliVersion;
  const available = offered.filter((v) => offers.get(v)?.candidate);
  return {
    checkedAt: new Date(now()).toISOString(),
    versions: list,
    ...(defaultVersion ? { defaultVersion } : {}),
    available,
    sources: readAptSources(apt),
    mode: apache ? 'mod_php' : fpmDefault ? 'fpm' : 'none',
    modPhp: modPhpVersions(config),
  };
}

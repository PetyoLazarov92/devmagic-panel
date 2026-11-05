import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PhpIniKey } from '@devmagic-panel/shared';
import { isLocalName, isPhpIniKey, PHP_VERSION_PATTERN } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';

/** Same first line as DMP_POOL_MARKER in scripts/lib/fpm.sh. */
export const POOL_MARKER = '; Managed by devmagic-panel. Edits here are overwritten.';
/** How long a folder name may be for its socket, /run/php/dmp-<folder>.sock (fpm.sh checks the same). */
export const MAX_POOL_FOLDER = 81;

export interface SitePool {
  version: string;
  /** The site's folder in WEB_DIR, which names the pool: dmp-<folder>. */
  folder: string;
  values: Partial<Record<PhpIniKey, string>>;
}

/** The panel's pools, from /etc/php/<version>/fpm/pool.d/dmp-<folder>.conf, the record dmp-root keeps. */
export function readPools(config: SystemConfig): SitePool[] {
  if (!existsSync(config.PHP_CONF_DIR)) return [];
  const pools: SitePool[] = [];
  for (const version of readdirSync(config.PHP_CONF_DIR).filter((v) => PHP_VERSION_PATTERN.test(v))) {
    const dir = join(config.PHP_CONF_DIR, version, 'fpm', 'pool.d');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const folder = /^dmp-(.+)\.conf$/.exec(file)?.[1];
      if (!folder || !isLocalName(folder)) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      if (!text.startsWith(POOL_MARKER)) continue;
      const values: Partial<Record<PhpIniKey, string>> = {};
      for (const m of text.matchAll(/^php_admin_value\[([^\]]+)\] = (.*)$/gm)) {
        if (isPhpIniKey(m[1] as string)) values[m[1] as PhpIniKey] = (m[2] as string).trim();
      }
      pools.push({ version, folder, values });
    }
  }
  return pools;
}

/** The pool folder of a site: its folder's name when it sits right in WEB_DIR and is a local name. */
export function poolFolder(config: SystemConfig, docroot: string): string | undefined {
  const folder = basename(docroot);
  return dirname(docroot) === config.WEB_DIR && isLocalName(folder) && folder.length <= MAX_POOL_FOLDER ? folder : undefined;
}

export function sitePool(config: SystemConfig, docroot: string): SitePool | undefined {
  const folder = poolFolder(config, docroot);
  return folder ? readPools(config).find((p) => p.folder === folder) : undefined;
}

/** The sites (their folders) whose pool runs each version, for the PHP tab. */
export const sitesByVersion = (config: SystemConfig) => (version: string) =>
  readPools(config).filter((p) => p.version === version).map((p) => p.folder).sort();

/** The first `file` on a PATH, like `command -v`. */
export function findOnPath(file: string, searchPath = process.env.PATH ?? ''): string | undefined {
  return searchPath.split(':').filter(Boolean).map((dir) => join(dir, file)).find((p) => existsSync(p));
}

/**
 * WP-CLI for a site on a PHP version of its own. WP-CLI's phar starts with
 * `#!/usr/bin/env php`, so it runs on whatever `php` is; php<version> runs it
 * instead. A wp that is not a PHP script gets WP_CLI_PHP, which its launcher reads.
 */
export function wpCommand(version: string | undefined, args: string[], searchPath?: string): { file: string; args: string[]; env?: Record<string, string> } {
  if (!version) return { file: 'wp', args };
  const wp = findOnPath('wp', searchPath);
  let head = '';
  try {
    head = wp ? readFileSync(wp, 'latin1').slice(0, 64) : '';
  } catch {
    head = '';
  }
  if (wp && /^#!.*\bphp\b/.test(head)) return { file: `php${version}`, args: [wp, ...args] };
  return { file: 'wp', args, env: { WP_CLI_PHP: `php${version}` } };
}

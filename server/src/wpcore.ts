import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecResult, Executor } from './exec.js';

/**
 * The panel shares wpcore's own settings with the wpcore CLI: one
 * /etc/wpcore.conf and one cores folder, so a core added from either side is
 * visible to both. The panel never keeps a second config or cores folder.
 */
export interface WpcoreConfig {
  coresDir: string;
  sitesDir: string;
  sitePrefix: string;
}

const DEFAULTS: WpcoreConfig = { coresDir: '/var/www/wp-cores', sitesDir: '/var/www', sitePrefix: 'local.' };

/** Reads KEY="value" lines; wpcore sources the file, so values may be quoted. */
export function parseWpcoreConf(text: string): WpcoreConfig {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const m = /^\s*([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*(?:#.*)?$/.exec(raw);
    if (m?.[1]) values[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return {
    coresDir: values.CORES_DIR || DEFAULTS.coresDir,
    sitesDir: values.SITES_DIR || DEFAULTS.sitesDir,
    sitePrefix: values.SITE_PREFIX ?? DEFAULTS.sitePrefix,
  };
}

export function readWpcoreConfig(file: string): WpcoreConfig | null {
  if (!existsSync(file)) return null;
  return parseWpcoreConf(readFileSync(file, 'utf8'));
}

/** Core versions installed in the shared cores folder, newest first. */
export function installedCores(coresDir: string): string[] {
  if (!existsSync(coresDir)) return [];
  return readdirSync(coresDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * wpcore links every PHP file of a core's root into the site, index.php too,
 * over the one a repo may track. Afterwards git puts the repo's index.php back
 * as a file, so git shows no change and a custom one keeps working. Only
 * index.php: it only loads wp-blog-header.php and runs with any core, where
 * the other root files must match the core's wp-includes. wpcore reads a
 * site's version from its wp-includes link and removes only links, so a real
 * index.php changes nothing for it; a switch links it again, and this runs
 * again. Never fails the step: with the link the site works as before.
 */
export async function keepRepoIndex(exec: Executor, docroot: string): Promise<ExecResult> {
  const quiet: ExecResult = { code: 0, stdout: '', stderr: '' };
  try {
    if (!lstatSync(join(docroot, 'index.php')).isSymbolicLink()) return quiet;
  } catch {
    return quiet;
  }
  const git = (...args: string[]) => exec('git', ['-C', docroot, ...args], { timeoutMs: 10_000 });
  if ((await git('ls-files', '--error-unmatch', '--', 'index.php')).code !== 0) return quiet;
  const r = await git('checkout', '--', 'index.php');
  return r.code === 0
    ? { code: 0, stdout: "index.php is the repo's own again, not a link to the core", stderr: '' }
    : { code: 0, stdout: `index.php stays a link to the core, as git could not put the repo's back: ${(r.stderr || r.stdout).trim()}`, stderr: '' };
}

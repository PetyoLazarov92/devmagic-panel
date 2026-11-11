import { accessSync, constants, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DumpPlugin, DumpTheme } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import { PLUGIN_FILE, THEME_NAME } from './dump.js';
import { themeDir } from './local-mode.js';
import { excludeLocally } from './mu-plugins.js';

/**
 * Plugins a site's database has (active, or installed on production) that
 * its files lack, installed from WordPress.org only: a slug and maybe a
 * version, never a zip, URL or path. Done the way wp-cli-plugin-install-missing
 * should have: every plugin is tried and a failure is noted, never the end of
 * the run; success is WP-CLI's exit code, not a quiet stderr; WordPress.org's
 * checksums are checked after; nothing of the site is loaded (--skip-plugins
 * --skip-themes); and a folder that lands inside a repo is kept out of its
 * git status locally.
 */

export interface PluginToInstall {
  slug: string;
  /** Production's version, when the dump's update check had it. */
  version?: string | undefined;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1)?.replace(/^Error:\s*/, '') ?? `exit ${r.code}`;
/**
 * Why WP-CLI installed nothing: its last line only says "No plugins
 * installed.", and the reason is the warning before it ("Plugin not found.",
 * "Could not create directory.").
 */
function reason(r: ExecResult, slug: string): string {
  const warning = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter((l) => /^Warning:/.test(l)).at(-1);
  return warning ? warning.replace(/^Warning:\s*/, '').replace(new RegExp(`^${slug}:\\s*`), '') : lastLine(r);
}

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * WordPress unpacks a plugin in wp-content/upgrade first. Once the web server
 * made that folder (its own updates, minutes after an install), you cannot
 * write in it and every install ends in "Could not create directory". It only
 * holds work in progress, so it is moved aside for the run, in the same
 * folder, and put back after, as it was. Returns how to put it back.
 */
export function ownUpgradeFolder(docroot: string): { note?: string; restore: () => void } {
  const upgrade = join(docroot, 'wp-content', 'upgrade');
  const aside = join(docroot, 'wp-content', 'upgrade.devmagic-panel-aside');
  const restore = () => {
    if (!existsSync(aside)) return;
    try {
      rmSync(upgrade, { recursive: true, force: true });
      renameSync(aside, upgrade);
    } catch {
      // Left aside: the next run puts it back.
    }
  };
  // One left from a run that was cut short.
  restore();
  if (!existsSync(upgrade) || writable(upgrade)) return { restore: () => undefined };
  try {
    renameSync(upgrade, aside);
  } catch {
    return { note: 'warn: wp-content/upgrade was made by the web server and you cannot write in it, so WordPress has nowhere to unpack a plugin', restore: () => undefined };
  }
  return { note: 'wp-content/upgrade was made by the web server and you cannot write in it: moved aside for this run and put back after', restore };
}
/** What verify-checksums says when a file differs, is missing or was added: anything but "no checksums for this version". */
const MISMATCH = /doesn't verify against checksum|File is missing|File was added|Plugin doesn't verify/i;

export interface InstallOutcome {
  results: ExecResult[];
  /** The folders this run made, for Undo. */
  installed: string[];
  failed: string[];
}

export async function installPlugins(exec: Executor, docroot: string, host: string, plugins: readonly PluginToInstall[]): Promise<InstallOutcome> {
  const wp = (args: string[]) => exec('wp', [`--path=${docroot}`, `--url=https://${host}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs: 10 * 60_000 });
  const results: ExecResult[] = [];
  const installed: string[] = [];
  const failed: string[] = [];
  const upgrade = plugins.length ? ownUpgradeFolder(docroot) : { restore: () => undefined };
  if (upgrade.note) results.push(ok(upgrade.note));
  try {
    await each();
  } finally {
    upgrade.restore();
  }
  async function each(): Promise<void> {
   for (const { slug, version } of plugins) {
    const folder = join(docroot, 'wp-content', 'plugins', slug);
    if (existsSync(folder)) {
      results.push(ok(`${slug}: wp-content/plugins/${slug} is there already; left as it is`));
      continue;
    }
    let r = await wp(['plugin', 'install', slug, ...(version ? [`--version=${version}`] : [])]);
    let got = version ?? 'the latest version';
    // Production's version may be gone from WordPress.org: the latest is better than none.
    if (r.code !== 0 && version) {
      if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
      const latest = await wp(['plugin', 'install', slug]);
      if (latest.code === 0) {
        results.push(ok(`${slug}: ${version}, production's version, is not on WordPress.org (${reason(r, slug)}); took the latest instead`));
        got = 'the latest version';
      }
      r = latest;
    }
    if (r.code !== 0) {
      if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
      failed.push(slug);
      results.push(ok(`warn: ${slug} was not installed: ${reason(r, slug)}`));
      continue;
    }
    const check = await wp(['plugin', 'verify-checksums', slug]);
    if (check.code !== 0 && MISMATCH.test(`${check.stdout}\n${check.stderr}`)) {
      rmSync(folder, { recursive: true, force: true });
      failed.push(slug);
      results.push(ok(`warn: ${slug} did not match WordPress.org's checksums, so it was removed again`));
      continue;
    }
    installed.push(folder);
    await excludeLocally(exec, folder, 'devmagic-panel: installed from WordPress.org for this local copy');
    results.push(ok(`${slug}: installed ${got} from WordPress.org${check.code === 0 ? ', checksums match' : ', WordPress.org has no checksums for it'}`));
   }
  }
  const done = plugins.length - failed.length;
  results.push(ok(failed.length ? `installed ${done} of ${plugins.length}; not installed: ${failed.join(', ')}` : `installed ${done} plugin${done === 1 ? '' : 's'} from WordPress.org`));
  return { results, installed, failed };
}

/** Removes what an install run made, for Undo. */
export function removeInstalled(folders: readonly string[]): ExecResult {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
  return ok(`removed ${folders.length} plugin folder${folders.length === 1 ? '' : 's'}`);
}

/** A plugin entry's slug for WordPress.org: what its update check said, else its folder or file name. */
export const slugOf = (p: Pick<DumpPlugin, 'file' | 'slug'>): string => p.slug ?? (p.file.includes('/') ? (p.file.split('/')[0] as string) : p.file.replace(/\.php$/, ''));

/** A plugin entry is on disk: its folder (akismet/...) or its single file (hello.php) in wp-content/plugins. */
export function pluginPresent(docroot: string, file: string): boolean {
  if (file.includes('..') || file.startsWith('/')) return false;
  return existsSync(join(docroot, 'wp-content', 'plugins', file.includes('/') ? (file.split('/')[0] as string) : file));
}

/**
 * Themes the database uses that the files lack, installed from
 * WordPress.org by slug the same way: each on its own, production's version
 * first and the latest when that one is gone, a failure noted, nothing
 * activated (the database says which theme is on), kept out of git locally.
 * WordPress.org has no checksums for themes to check against.
 */
export async function installThemes(exec: Executor, docroot: string, host: string, themes: readonly PluginToInstall[]): Promise<InstallOutcome> {
  const wp = (args: string[]) => exec('wp', [`--path=${docroot}`, `--url=https://${host}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs: 10 * 60_000 });
  const results: ExecResult[] = [];
  const installed: string[] = [];
  const failed: string[] = [];
  const upgrade = themes.length ? ownUpgradeFolder(docroot) : { restore: () => undefined };
  if (upgrade.note) results.push(ok(upgrade.note));
  try {
    for (const { slug, version } of themes) {
      const folder = join(docroot, 'wp-content', 'themes', slug);
      if (existsSync(themeDir(docroot, slug))) {
        results.push(ok(`${slug}: the theme is there already; left as it is`));
        continue;
      }
      let r = await wp(['theme', 'install', slug, ...(version ? [`--version=${version}`] : [])]);
      let got = version ?? 'the latest version';
      if (r.code !== 0 && version) {
        if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
        const latest = await wp(['theme', 'install', slug]);
        if (latest.code === 0) {
          results.push(ok(`${slug}: ${version}, production's version, is not on WordPress.org (${reason(r, slug)}); took the latest instead`));
          got = 'the latest version';
        }
        r = latest;
      }
      if (r.code !== 0 || !existsSync(folder)) {
        if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
        failed.push(slug);
        results.push(ok(`warn: the theme ${slug} was not installed: ${reason(r, slug)}`));
        continue;
      }
      installed.push(folder);
      await excludeLocally(exec, folder, 'devmagic-panel: installed from WordPress.org for this local copy');
      results.push(ok(`${slug}: installed ${got} of the theme from WordPress.org`));
    }
  } finally {
    upgrade.restore();
  }
  const done = themes.length - failed.length;
  results.push(ok(failed.length ? `installed ${done} of ${themes.length} themes; not installed: ${failed.join(', ')}` : `installed ${done} theme${done === 1 ? '' : 's'} from WordPress.org`));
  return { results, installed, failed };
}

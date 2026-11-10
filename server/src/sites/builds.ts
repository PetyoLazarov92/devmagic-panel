import { dirname, posix } from 'node:path';
import type { BuildTool, RepoBuild } from '@devmagic-panel/shared';

/**
 * Which builds a repo needs. Most composer.json and package.json files in a
 * WordPress repo ship inside plugins that already hold their vendor/ or
 * built files, so a build is ticked only when what it makes is not in the
 * repo: no vendor/ for Composer, an output folder git ignores for npm, and
 * never for a wordpress.org plugin. Watchers and dev servers are never offered.
 */

/** The files the lookup reads besides the tree: build manifests, ignore rules and plugin readmes. */
export const BUILD_FILES = /(^|\/)(composer\.json|package\.json|\.gitignore|readme\.txt|\.nvmrc|\.node-version)$/;
/** Folders whose files are someone else's: never a build of the site. */
export const SKIPPED_DIRS = /(^|\/)(vendor|node_modules|bower_components)\//;

/** Scripts that keep running: a watcher or a dev server can never be an install step. */
const KEEPS_RUNNING = /--watch\b|(^|[\s&;|])(watch|nodemon|browser-sync|webpack-dev-server)\b|wp-scripts start|\bserve\b|--hot\b|\bvite(\s*$|\s+(--|dev\b|serve\b))/;
/** Scripts that are not builds: tests, linters, packaging and the like. */
const NOT_A_BUILD = /^(test|lint|format|prettier|eslint|stylelint|clean|eject|prepare|preinstall|postinstall|install|precommit|commit|release|version|ver|start|serve|dev-server|watch|zip|plugin-zip|ziptheme|packages-update|check|env|deploy)(:|$)/i;
/**
 * A script that runs its builds with concurrently and --kill-others (-k): the
 * first to finish stops the rest, which suits watchers but cuts a one-off
 * build short. --kill-others-on-fail stops them only on a failure.
 */
export const STOPS_OTHERS = /\bconcurrently\b.*\s(?:--kill-others|-k)(?=\s|$)/;
/** The scripts to pick, first one found wins. */
const PREFERRED = ['build', 'prod', 'production', 'build:prod'];
/** Output folders a build writes, relative to its own folder. */
const OUTPUTS = ['build', 'dist', 'public/build', 'assets/dist', 'assets/build', 'static/dist', 'js/dist', 'css/dist', 'assets/js/dist', 'assets/css/dist'];
/** Requirements that are not packages to install: the platform, and the installer every plugin lists. */
const NOT_A_PACKAGE = /^(php|php-64bit|hhvm|composer-plugin-api|composer-runtime-api|ext-.+|lib-.+|composer\/installers)$/;

export interface BuildFiles {
  /** Every file in the repo by path. */
  paths: Set<string>;
  /** The contents of the BUILD_FILES the lookup read. */
  text: Map<string, string>;
}

const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parent = (dir: string) => (dir.includes('/') ? dirname(dir) : '');

function json(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A plugin from wordpress.org: its readme has a Stable tag, and it ships what it builds. */
const fromWordPressOrg = (dir: string, files: BuildFiles) => /^\s*Stable tag:/im.test(files.text.get(inDir(dir, 'readme.txt')) ?? '');

/** A .gitignore pattern as a regex over a path relative to its folder: * within a name, ** across folders. */
function globRegex(glob: string): RegExp {
  const body = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}(?:/|$)`);
}

/**
 * The first of the folders (relative to dir) that a .gitignore in dir or a
 * folder above ignores. A pattern without a slash matches a name at any
 * depth; one with a slash is relative to its .gitignore. Negations are not
 * followed: they are rare around build output.
 */
export function ignoredFolder(dir: string, files: BuildFiles, folders: string[]): string | null {
  for (let at = dir; ; at = parent(at)) {
    const rules = files.text.get(inDir(at, '.gitignore'));
    if (rules) {
      const rel = at === dir ? '' : posix.relative(at, dir);
      for (const raw of rules.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const rule = line.replace(/\/\*{0,2}$/, '').replace(/\/$/, '');
        const anchored = rule.replace(/^\//, '').includes('/') || rule.startsWith('/');
        const pattern = globRegex(rule.replace(/^\//, ''));
        for (const folder of folders) {
          const path = rel ? `${rel}/${folder}` : folder;
          const hit = anchored ? pattern.test(path) : path.split('/').some((name) => pattern.test(name));
          if (hit) return folder;
        }
      }
    }
    if (!at) return null;
  }
}

/** The output folder of a build that git ignores, if any. */
export const ignoredOutput = (dir: string, files: BuildFiles) => ignoredFolder(dir, files, OUTPUTS);

/** The composer.json build of a folder, or none when it installs nothing. */
function composerBuild(dir: string, files: BuildFiles, installed: Set<BuildTool>): RepoBuild | null {
  const manifest = json(files.text.get(inDir(dir, 'composer.json')));
  if (!manifest) return null;
  // What it runs on, and the plugins it brings in from WordPress Packagist (dev ones included: composer install brings them).
  const runtime = Object.keys((manifest.require ?? {}) as Record<string, unknown>).filter((name) => !NOT_A_PACKAGE.test(name));
  const dev = Object.keys((manifest['require-dev'] ?? {}) as Record<string, unknown>).filter((name) => name.startsWith('wpackagist-'));
  if (runtime.length + dev.length === 0) return null;
  const config = manifest.config as { 'vendor-dir'?: unknown } | undefined;
  const vendorDir = typeof config?.['vendor-dir'] === 'string' ? posix.normalize(config['vendor-dir']).replace(/\/$/, '') : 'vendor';
  const committed = files.paths.has(`${inDir(dir, vendorDir)}/autoload.php`);
  const wporg = fromWordPressOrg(dir, files);
  // A project you develop ignores its vendor/; a plugin that bundles its libraries another way does not.
  const ignored = Boolean(ignoredFolder(dir, files, [vendorDir]));
  const inRepo = committed || wporg || !ignored;
  const why = wporg
    ? 'a wordpress.org plugin, built already'
    : committed
      ? `its ${vendorDir}/ is in the repo`
      : !ignored
        ? `${vendorDir}/ is not ignored by git: its libraries ship with it`
        : !installed.has('composer')
          ? 'composer is not installed'
          : `${vendorDir}/ is ignored by git`;
  return { dir, tool: 'composer', scripts: [], needed: !committed && !wporg && ignored && installed.has('composer'), why, ...(inRepo ? { builtInRepo: true } : {}) };
}

/** The package.json build of a folder, or none when it has no script that builds. */
function packageBuild(dir: string, files: BuildFiles, installed: Set<BuildTool>, node?: (dir: string) => string | undefined): RepoBuild | null {
  const manifest = json(files.text.get(inDir(dir, 'package.json')));
  const scripts = (manifest?.scripts ?? {}) as Record<string, unknown>;
  const offered = Object.entries(scripts)
    .filter(([name, command]) => typeof command === 'string' && !KEEPS_RUNNING.test(command) && !NOT_A_BUILD.test(name))
    .map(([name]) => name);
  if (offered.length === 0) return null;
  const stopsOthers = offered.filter((name) => STOPS_OTHERS.test(scripts[name] as string));
  const script = PREFERRED.find((name) => offered.includes(name) && !stopsOthers.includes(name));
  const tool: BuildTool = files.paths.has(inDir(dir, 'package-lock.json')) ? 'npm' : files.paths.has(inDir(dir, 'yarn.lock')) ? 'yarn' : files.paths.has(inDir(dir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  const output = ignoredOutput(dir, files);
  const wporg = fromWordPressOrg(dir, files);
  const why = wporg
    ? 'a wordpress.org plugin, built already'
    : !installed.has(tool)
      ? `${tool} is not installed`
      : !output
        ? 'its built files are in the repo'
        : !script
          ? `${output}/ is ignored by git: pick its build script`
          : `${output}/ is ignored by git`;
  return {
    dir,
    tool,
    scripts: offered,
    ...(script ? { script } : {}),
    needed: Boolean(script && output && !wporg && installed.has(tool)),
    why,
    ...(!output || wporg ? { builtInRepo: true } : {}),
    ...(stopsOthers.length ? { stopsOthers } : {}),
    ...(node?.(dir) ? { node: node(dir) as string } : {}),
  };
}

/** Every build in the repo, the ones it needs first, then by folder; Composer before npm in the same folder. */
export function planBuilds(files: BuildFiles, installed: Set<BuildTool>, node?: (dir: string) => string | undefined): RepoBuild[] {
  const dirs = (name: string) => [...files.text.keys()].filter((p) => posix.basename(p) === name && !SKIPPED_DIRS.test(p)).map((p) => (p.includes('/') ? dirname(p) : ''));
  const builds = [
    ...dirs('composer.json').flatMap((dir) => composerBuild(dir, files, installed) ?? []),
    ...dirs('package.json').flatMap((dir) => packageBuild(dir, files, installed, node) ?? []),
  ];
  const depth = (dir: string) => (dir ? dir.split('/').length : 0);
  return builds
    .sort((a, b) => Number(b.needed) - Number(a.needed) || depth(a.dir) - depth(b.dir) || a.dir.localeCompare(b.dir) || Number(a.tool !== 'composer') - Number(b.tool !== 'composer'))
    .slice(0, 40);
}

/** Plugins Composer brings in from WordPress Packagist, by slug: they count as in the repo when Composer runs. */
export function composerPlugins(files: BuildFiles): string[] {
  const slugs = new Set<string>();
  for (const [path, text] of files.text) {
    if (posix.basename(path) !== 'composer.json' || SKIPPED_DIRS.test(path)) continue;
    const manifest = json(text);
    for (const key of ['require', 'require-dev']) {
      for (const name of Object.keys((manifest?.[key] ?? {}) as Record<string, unknown>)) {
        const m = /^wpackagist-plugin\/([a-z0-9_-]{1,100})$/.exec(name);
        if (m) slugs.add(m[1] as string);
      }
    }
  }
  return [...slugs];
}

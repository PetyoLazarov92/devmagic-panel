import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionInput, CompatComponent, CompatIssue, CompatScan, SiteCompat, VersionCompat } from '@devmagic-panel/shared';
import { COMPAT_ISSUE_LIMIT, COMPAT_STALE_MS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import type { RunStore } from '../store.js';
import { LOCAL_MODE_FILE, themeDir } from '../sites/local-mode.js';
import { LOGIN_PLUGIN_FILE, SiteActionRefused, siteFor, SiteNotFoundError, type SiteRef } from '../sites/site-actions.js';
import { readSiteVhosts } from '../sites/vhost.js';
import { defaultPhpVersion } from './site-php.js';
import { findOnPath, wpCommand } from './pools.js';
import { requiresPhpOf } from './requirements.js';
import { installedVersions } from './versions.js';

/**
 * The PHP compatibility check: PHPCompatibilityWP (on PHP_CodeSniffer) scans a
 * site's themes and plugins for what a PHP version removed or deprecated. The
 * scanner is fetched once with Composer, pinned by scripts/php-compat/composer.lock,
 * into the panel's data folder; nothing goes into the site. It runs on the
 * version's own php binary, so its tokenizer reads that version's syntax.
 */

/** scripts/php-compat in the checkout or the release, from server/src/php or server/dist/php alike. */
export const COMPAT_SOURCE_DIR = fileURLToPath(new URL('../../../scripts/php-compat', import.meta.url));

export interface CompatContext {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  /** The panel's data folder; the scanner goes in tools/php-compat. */
  dataDir: string;
  /** Where composer.json and composer.lock come from; tests point it at a temp tree. */
  sourceDir?: string;
  searchPath?: string;
}

const toolDir = (ctx: CompatContext) => join(ctx.dataDir, 'tools', 'php-compat');
const sourceDir = (ctx: CompatContext) => ctx.sourceDir ?? COMPAT_SOURCE_DIR;
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';

/** Installed, and from the lock this panel ships: a panel update with a new lock fetches it again. */
export function compatInstalled(ctx: CompatContext): boolean {
  const dir = toolDir(ctx);
  if (!existsSync(join(dir, 'vendor', 'bin', 'phpcs'))) return false;
  try {
    return readFileSync(join(dir, 'composer.lock'), 'utf8') === readFileSync(join(sourceDir(ctx), 'composer.lock'), 'utf8');
  } catch {
    return false;
  }
}

/** The scanner's packages and versions from the lock, like PHPCompatibilityWP 3.0.0-alpha2. */
export function compatTool(ctx: Pick<CompatContext, 'sourceDir'>): string {
  const names: Record<string, string> = {
    'phpcompatibility/phpcompatibility-wp': 'PHPCompatibilityWP',
    'phpcompatibility/php-compatibility': 'PHPCompatibility',
    'squizlabs/php_codesniffer': 'PHP_CodeSniffer',
  };
  try {
    const lock = JSON.parse(readFileSync(join(ctx.sourceDir ?? COMPAT_SOURCE_DIR, 'composer.lock'), 'utf8')) as { packages: Array<{ name: string; version: string }> };
    return Object.entries(names)
      .map(([name, label]) => {
        const found = lock.packages.find((p) => p.name === name);
        return found ? `${label} ${found.version}` : undefined;
      })
      .filter(Boolean)
      .join(', ');
  } catch {
    return 'PHPCompatibilityWP';
  }
}

/** Fetches the scanner into a folder beside the old one and swaps it in once Composer is done. */
async function installCompat(ctx: CompatContext): Promise<ExecResult> {
  const dir = toolDir(ctx);
  const part = `${dir}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  for (const file of ['composer.json', 'composer.lock']) copyFileSync(join(sourceDir(ctx), file), join(part, file));
  // No plugins and no scripts: a package cannot run code while it is installed.
  const r = await ctx.exec('composer', ['install', '--no-dev', '--no-plugins', '--no-scripts', '--no-progress', '--no-interaction', `--working-dir=${part}`], {
    timeoutMs: 600_000,
    env: { XDEBUG_MODE: 'off', COMPOSER_NO_INTERACTION: '1' },
  });
  if (r.code !== 0) {
    rmSync(part, { recursive: true, force: true });
    return { code: 1, stdout: '', stderr: `Composer could not fetch the scanner: ${lastLine(r)}\n` };
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(part, dir);
  return { code: 0, stdout: `${compatTool(ctx)} installed in ${dir}`, stderr: '' };
}

interface WpRow {
  name: string;
  title: string;
  status: string;
  version: string;
  update: string;
  update_version: string;
  file?: string;
}

/** What gets scanned: a component and the folder or file it is. */
export interface CompatTarget {
  component: Omit<CompatComponent, 'files' | 'errors' | 'warnings' | 'issues'>;
  path: string;
  /** Files inside it left out, as phpcs --ignore patterns. */
  ignore?: string[];
}

async function wpList(ctx: CompatContext, site: SiteRef, what: 'plugin' | 'theme'): Promise<WpRow[]> {
  const fields = what === 'plugin' ? 'name,title,status,version,update,update_version,file' : 'name,title,status,version,update,update_version';
  const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=https://${site.host}/`, what, 'list', '--format=json', `--fields=${fields}`, '--skip-update-check', '--skip-plugins', '--skip-themes'], ctx.searchPath);
  const r = await ctx.exec(cmd.file, cmd.args, { timeoutMs: 120_000, ...(cmd.env ? { env: cmd.env } : {}) });
  if (r.code !== 0) throw new SiteActionRefused(`WP-CLI could not list the ${what}s: ${lastLine(r)}`);
  try {
    return JSON.parse(r.stdout) as WpRow[];
  } catch {
    throw new SiteActionRefused(`WP-CLI listed the ${what}s in a form the panel cannot read`);
  }
}

const updateOf = (row: WpRow) => (row.update === 'available' && row.update_version ? { update: row.update_version } : {});

/**
 * The folders of a site to scan: its themes and plugins (with scope active only
 * the active ones, a child theme's parent and network-activated plugins), the
 * whole mu-plugins folder but the panel's own two files, drop-ins, and the
 * root vendor folder. Never WordPress core: it declares its own support.
 */
export async function compatTargets(ctx: CompatContext, site: SiteRef, scope: 'active' | 'all'): Promise<CompatTarget[]> {
  const content = join(site.docroot, 'wp-content');
  const [plugins, themes] = [await wpList(ctx, site, 'plugin'), await wpList(ctx, site, 'theme')];
  const targets: CompatTarget[] = [];
  for (const t of themes) {
    if (scope === 'active' && t.status !== 'active' && t.status !== 'parent') continue;
    const dir = themeDir(site.docroot, t.name);
    const requiresPhp = requiresPhpOf(join(dir, 'style.css'));
    targets.push({ component: { kind: 'theme', name: t.name, title: t.title || t.name, version: t.version, status: t.status, ...updateOf(t), ...(requiresPhp ? { requiresPhp } : {}) }, path: dir });
  }
  for (const p of plugins) {
    if (!p.file || p.status === 'must-use') continue;
    if (p.status === 'dropin') {
      targets.push({ component: { kind: 'dropin', name: p.name, title: p.title || p.name, version: p.version, status: 'dropin' }, path: join(content, p.file) });
      continue;
    }
    if (scope === 'active' && p.status !== 'active' && p.status !== 'active-network') continue;
    const main = join(content, 'plugins', p.file);
    const requiresPhp = requiresPhpOf(main);
    targets.push({
      component: { kind: 'plugin', name: p.name, title: p.title || p.name, version: p.version, status: p.status === 'active-network' ? 'network' : p.status, ...updateOf(p), ...(requiresPhp ? { requiresPhp } : {}) },
      path: p.file.includes('/') ? dirname(main) : main,
    });
  }
  const mu = join(content, 'mu-plugins');
  if (existsSync(mu)) {
    targets.push({ component: { kind: 'mu-plugin', name: 'mu-plugins', title: 'Must-use plugins', status: 'must-use' }, path: mu, ignore: [`*/mu-plugins/${LOGIN_PLUGIN_FILE}`, `*/mu-plugins/${LOCAL_MODE_FILE}`] });
  }
  const vendor = join(site.docroot, 'vendor');
  if (existsSync(vendor)) targets.push({ component: { kind: 'vendor', name: 'vendor', title: 'Composer packages (vendor)', status: 'active' }, path: vendor });
  return targets;
}

interface PhpcsReport {
  files: Record<string, { errors: number; warnings: number; messages: Array<{ message: string; source: string; type: string; line: number }> }>;
}

/** One component's phpcs report as counts and its first issues, errors first, with paths relative to it. */
export function readReport(json: string, target: CompatTarget): Pick<CompatComponent, 'files' | 'errors' | 'warnings' | 'issues'> {
  const report = JSON.parse(json) as PhpcsReport;
  const issues: CompatIssue[] = [];
  let errors = 0;
  let warnings = 0;
  for (const [file, found] of Object.entries(report.files)) {
    const rel = file === target.path ? basename(file) : relative(target.path, file);
    for (const m of found.messages) {
      const type = m.type === 'ERROR' ? 'error' : 'warning';
      if (type === 'error') errors++;
      else warnings++;
      issues.push({ file: rel, line: m.line, type, message: m.message, source: m.source });
    }
  }
  issues.sort((a, b) => (a.type === b.type ? 0 : a.type === 'error' ? -1 : 1));
  return { files: Object.keys(report.files).length, errors, warnings, issues: issues.slice(0, COMPAT_ISSUE_LIMIT) };
}

/** The phpcs command line for one component on one version. */
export function phpcsArgs(tool: string, version: string, target: CompatTarget, cache: string, parallel = Math.max(1, Math.floor(availableParallelism() / 2))): string[] {
  const vendor = join(tool, 'vendor');
  const standards = ['phpcompatibility/php-compatibility', 'phpcompatibility/phpcompatibility-paragonie', 'phpcompatibility/phpcompatibility-wp', 'phpcsstandards/phpcsutils'].map((p) => join(vendor, p));
  const ignore = ['*/node_modules/*', '*/.git/*', '*/vendor/*/tests/*', '*/vendor/*/test/*', ...(target.ignore ?? [])];
  return [
    '-d', 'memory_limit=1G',
    join(vendor, 'bin', 'phpcs'),
    '--standard=PHPCompatibilityWP',
    '--runtime-set', 'installed_paths', standards.join(','),
    '--runtime-set', 'testVersion', version,
    '--extensions=php',
    '--report=json',
    '-q',
    '--no-colors',
    `--parallel=${parallel}`,
    `--cache=${cache}`,
    `--ignore=${ignore.join(',')}`,
    target.path,
  ];
}

/** The commit a site's repo is on, when its folder is one. */
export async function siteCommit(exec: Executor, docroot: string): Promise<string | undefined> {
  if (!existsSync(join(docroot, '.git'))) return undefined;
  const r = await exec('git', ['-C', docroot, 'rev-parse', '--short=12', 'HEAD'], { timeoutMs: 15_000 });
  return r.code === 0 && /^[0-9a-f]{7,40}$/.test(r.stdout.trim()) ? r.stdout.trim() : undefined;
}

const cliVersions = (config: SystemConfig) => installedVersions(config).filter((v) => v.sapis.includes('cli')).map((v) => v.version);

/** A site's PHP tab: its last scan per version, and whether a check can run. */
export async function readSiteCompat(ctx: CompatContext, site: SiteRef): Promise<SiteCompat> {
  const scans = (ctx.store.compatScans(site.key) as CompatScan[]).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const commit = await siteCommit(ctx.exec, site.docroot);
  return {
    scans,
    ...(commit ? { commit } : {}),
    versions: cliVersions(ctx.config),
    installed: compatInstalled(ctx),
    composer: Boolean(findOnPath('composer', ctx.searchPath)),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Refused before anything runs: the version is missing or has no command line, or neither the scanner nor Composer is there. */
function checkReady(ctx: CompatContext, version: string): boolean {
  if (!installedVersions(ctx.config).some((v) => v.version === version)) throw new SiteActionRefused(`PHP ${version} is not installed: install it on the PHP tab first.`);
  if (!cliVersions(ctx.config).includes(version)) throw new SiteActionRefused(`PHP ${version} has no command line, which the scanner runs on: install php${version}-cli on the PHP tab first.`);
  const installed = compatInstalled(ctx);
  if (!installed && !findOnPath('composer', ctx.searchPath)) {
    throw new SiteActionRefused('The scanner is fetched once with Composer, which is not installed: run ./install.sh, which offers it, or sudo apt install composer.');
  }
  return installed;
}

const toolStep = (ctx: CompatContext): JobStep => ({ id: 'tool', label: `Fetch the scanner (${compatTool(ctx)}) with Composer, once`, weight: 2, run: () => installCompat(ctx) });

/** Scans each of a site's folders on the version's own php and keeps the result as the site's last scan of that version. */
async function scanSite(ctx: CompatContext, site: SiteRef, version: string, scope: CompatScan['scope'], targets: CompatTarget[], progress: (fraction: number, note: string) => void): Promise<CompatScan> {
  const tool = toolDir(ctx);
  const cacheDir = join(tool, 'cache', site.key, version);
  mkdirSync(cacheDir, { recursive: true });
  const components: CompatComponent[] = [];
  for (const [i, target] of targets.entries()) {
    progress(i / Math.max(1, targets.length), target.component.title);
    const cache = join(cacheDir, `${target.component.kind}-${target.component.name}.json`);
    const r = await ctx.exec(`php${version}`, phpcsArgs(tool, version, target, cache), { timeoutMs: 900_000, maxBufferBytes: 64 * 1024 * 1024, env: { XDEBUG_MODE: 'off' } });
    // phpcs 4: 1 and 2 mean it found something, 16 and up that it could not run.
    let found: Pick<CompatComponent, 'files' | 'errors' | 'warnings' | 'issues'> | undefined;
    // A folder with no PHP file left to scan (mu-plugins with only the panel's two): nothing to find.
    if (/All specified files were excluded/.test(`${r.stdout}${r.stderr}`)) found = { files: 0, errors: 0, warnings: 0, issues: [] };
    else if (r.code < 16) {
      try {
        found = readReport(r.stdout, target);
      } catch {
        found = undefined;
      }
    }
    components.push(found ? { ...target.component, ...found } : { ...target.component, files: 0, errors: 0, warnings: 0, issues: [], failed: lastLine(r) || `phpcs stopped with ${r.code}` });
  }
  const commit = await siteCommit(ctx.exec, site.docroot);
  const scan: CompatScan = {
    version,
    scope,
    checkedAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    tool: compatTool(ctx),
    files: components.reduce((n, c) => n + c.files, 0),
    errors: components.reduce((n, c) => n + c.errors, 0),
    warnings: components.reduce((n, c) => n + c.warnings, 0),
    components,
  };
  ctx.store.saveCompatScan(site.key, version, scan);
  return scan;
}

const scanLine = (scan: CompatScan) => {
  const hit = scan.components.filter((c) => c.errors > 0).map((c) => c.title);
  return `PHP ${scan.version}: ${plural(scan.errors, 'error')} and ${plural(scan.warnings, 'warning')} in ${plural(scan.files, 'file')}${hit.length ? `; errors in ${hit.join(', ')}` : ''}`;
};

/**
 * php.checkCompat as a job: fetch the scanner when it is missing, list the
 * site's components, scan each on the version's own php, keep the result.
 */
export function planCheckCompat(ctx: CompatContext, site: SiteRef, { version, scope }: Pick<ActionInput<'php.checkCompat'>, 'version' | 'scope'>): JobStep[] {
  const installed = checkReady(ctx, version);
  let targets: CompatTarget[] = [];
  const steps: JobStep[] = installed ? [] : [toolStep(ctx)];
  steps.push({
    id: 'list',
    label: `List ${site.host}'s ${scope === 'all' ? 'themes and plugins' : 'active theme and plugins'}`,
    run: async () => {
      try {
        targets = await compatTargets(ctx, site, scope);
      } catch (error) {
        if (error instanceof SiteActionRefused) return { code: 1, stdout: '', stderr: `${error.message}\n` };
        throw error;
      }
      return { code: 0, stdout: `${plural(targets.length, 'folder')} to scan: ${targets.map((t) => t.component.title).join(', ')}`, stderr: '' };
    },
  });
  steps.push({
    id: 'scan',
    label: `Scan them against PHP ${version}`,
    weight: 8,
    run: async (job) => {
      const scan = await scanSite(ctx, site, version, scope, targets, (f, note) => job.progress(f, note));
      const failed = scan.components.filter((c) => c.failed);
      return {
        code: failed.length === scan.components.length && scan.components.length > 0 ? 1 : 0,
        stdout: scanLine(scan),
        stderr: failed.length ? `the scanner could not read ${failed.map((c) => `${c.title} (${c.failed})`).join(', ')}\n` : '',
      };
    },
  });
  return steps;
}

/**
 * php.checkCompatAll: every WordPress site of this machine in turn, as one
 * job with a step per site. A site WP-CLI cannot read is noted and passed
 * over, so one broken site does not stop the rest; the last step sums up.
 */
export function planCheckCompatAll(ctx: CompatContext, sites: SiteRef[], { version, scope }: Pick<ActionInput<'php.checkCompatAll'>, 'version' | 'scope'>): JobStep[] {
  const installed = checkReady(ctx, version);
  if (sites.length === 0) throw new SiteActionRefused('There is no WordPress site to check.');
  const results: Array<{ host: string; scan?: CompatScan; skipped?: string }> = [];
  const steps: JobStep[] = installed ? [] : [toolStep(ctx)];
  for (const site of sites) {
    steps.push({
      id: `site-${site.key}`,
      label: `Scan ${site.host}`,
      weight: 4,
      run: async (job) => {
        let targets: CompatTarget[];
        try {
          targets = await compatTargets(ctx, site, scope);
        } catch (error) {
          if (!(error instanceof SiteActionRefused)) throw error;
          results.push({ host: site.host, skipped: error.message });
          return { code: 0, stdout: `not scanned: ${error.message}`, stderr: '' };
        }
        const scan = await scanSite(ctx, site, version, scope, targets, (f, note) => job.progress(f, note));
        results.push({ host: site.host, scan });
        return { code: 0, stdout: scanLine(scan), stderr: '' };
      },
    });
  }
  steps.push({
    id: 'summary',
    label: 'Sum up',
    run: async () => {
      const done = results.filter((r) => r.scan);
      const errors = done.filter((r) => (r.scan?.errors ?? 0) > 0).map((r) => `${r.host} (${plural(r.scan?.errors ?? 0, 'error')})`);
      const skipped = results.filter((r) => r.skipped).map((r) => r.host);
      return {
        code: 0,
        stdout: [
          `${plural(done.length, 'site')} checked against PHP ${version}: ${errors.length ? `errors in ${errors.join(', ')}` : 'no errors'}.`,
          ...(skipped.length ? [`Not scanned, WP-CLI could not read them: ${skipped.join(', ')}.`] : []),
        ].join('\n'),
        stderr: '',
      };
    },
  });
  return steps;
}

/** Every WordPress site of this machine: each vhost's own install and the ones it serves under a path. */
export function wordpressSites(config: SystemConfig): SiteRef[] {
  const out: SiteRef[] = [];
  for (const v of readSiteVhosts(config)) {
    const domain = v.names[0];
    if (!domain || !v.docroot) continue;
    for (const path of [undefined, ...v.mounts.map((m) => m.path)]) {
      try {
        out.push(siteFor(config, domain, path));
      } catch (error) {
        if (!(error instanceof SiteNotFoundError)) throw error;
      }
    }
  }
  return out;
}

/** A version's page: every WordPress site with its last scan of that version, and the version it runs. */
export async function readVersionCompat(ctx: CompatContext, version: string): Promise<VersionCompat> {
  const sites = await Promise.all(
    wordpressSites(ctx.config).map(async (site): Promise<VersionCompat['sites'][number]> => {
      const scan = (ctx.store.compatScans(site.key) as CompatScan[]).find((s) => s.version === version);
      const runs = site.php ?? defaultPhpVersion(ctx.config);
      const base = { domain: site.domain, ...(site.path ? { path: site.path } : {}), host: site.host, ...(runs ? { runs } : {}) };
      if (!scan) return base;
      const commit = await siteCommit(ctx.exec, site.docroot);
      return {
        ...base,
        scan: {
          checkedAt: scan.checkedAt,
          scope: scan.scope,
          files: scan.files,
          errors: scan.errors,
          warnings: scan.warnings,
          withErrors: scan.components.filter((c) => c.errors > 0).map((c) => c.title),
          failed: scan.components.filter((c) => c.failed).length,
          stale: Boolean((scan.commit && commit && scan.commit !== commit) || Date.now() - Date.parse(scan.checkedAt) > COMPAT_STALE_MS),
        },
      };
    }),
  );
  return { version, sites, cli: cliVersions(ctx.config).includes(version), installed: compatInstalled(ctx), composer: Boolean(findOnPath('composer', ctx.searchPath)) };
}

/**
 * Deletes kept scans and the scanner's cache for them (see RunStore.deleteCompatScans
 * for `where`). The cache only makes the next scan faster, so it goes with them.
 */
export function forgetCompat(store: RunStore, dataDir: string | undefined, where: { key?: string; domain?: string; version?: string }): number {
  const gone = store.deleteCompatScans(where);
  if (dataDir) {
    const cache = join(dataDir, 'tools', 'php-compat', 'cache');
    for (const { site, version } of gone) rmSync(join(cache, site, version), { recursive: true, force: true });
    // A site removed with its vhost: its cache folders go even for versions without a kept scan.
    if (where.domain && !where.version) {
      for (const site of [where.domain, ...listDirs(cache).filter((d) => d.startsWith(`${where.domain}@`))]) rmSync(join(cache, site), { recursive: true, force: true });
    }
  }
  return gone.length;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompatScan } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { type ActionContext, runAction } from '../src/actions.js';
import { Jobs, type JobRuntime } from '../src/jobs.js';
import { compatInstalled, type CompatContext, forgetCompat, phpcsArgs, planCheckCompat, planCheckCompatAll, readReport, readSiteCompat, readVersionCompat, wordpressSites } from '../src/php/compat.js';
import { SiteActionRefused, siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

type Tree = ReturnType<typeof wpSiteTree>;

const LOCK = JSON.stringify({ packages: [
  { name: 'phpcompatibility/phpcompatibility-wp', version: '3.0.0-alpha2' },
  { name: 'phpcompatibility/php-compatibility', version: '10.0.0-alpha2' },
  { name: 'squizlabs/php_codesniffer', version: '4.0.4' },
] });

function php(t: Tree, versions: Record<string, string[]>) {
  for (const [version, parts] of Object.entries(versions)) {
    mkdirSync(join(t.config.PHP_CONF_DIR, version, 'mods-available'), { recursive: true });
    mkdirSync(join(t.config.PHP_LIB_DIR, version, 'sapi'), { recursive: true });
    for (const part of parts) {
      mkdirSync(join(t.config.PHP_CONF_DIR, version, part, 'conf.d'), { recursive: true });
      writeFileSync(join(t.config.PHP_LIB_DIR, version, 'sapi', part), '');
    }
  }
}

/** A site with a theme, its parent, an active and an inactive plugin, mu-plugins (the panel's two among them) and a vendor folder. */
function site(t: Tree) {
  const content = join(t.docroot, 'wp-content');
  for (const dir of ['themes/acme-child', 'themes/acme', 'plugins/acme-forms', 'plugins/acme-old', 'mu-plugins', '../vendor']) mkdirSync(join(content, dir), { recursive: true });
  writeFileSync(join(content, 'themes/acme/style.css'), '/*\nTheme Name: Acme\nRequires PHP: 8.1\n*/');
  writeFileSync(join(content, 'plugins/acme-forms/acme-forms.php'), '<?php\n/**\n * Plugin Name: Acme Forms\n * Requires PHP: 7.4\n */');
  writeFileSync(join(content, 'hello.php'), '<?php');
}

const PLUGINS = [
  { name: 'acme-forms', title: 'Acme Forms', status: 'active', version: '1.2.0', update: 'available', update_version: '1.4.1', file: 'acme-forms/acme-forms.php' },
  { name: 'acme-old', title: 'Acme Old', status: 'inactive', version: '0.9', update: 'none', update_version: '', file: 'acme-old/acme-old.php' },
  { name: 'hello', title: 'Hello', status: 'active', version: '1.7', update: 'none', update_version: '', file: 'hello.php' },
  { name: 'loader', title: 'Loader', status: 'must-use', version: '', update: 'none', update_version: '', file: 'loader.php' },
  { name: 'object-cache.php', title: 'Object cache', status: 'dropin', version: '', update: 'none', update_version: '', file: 'object-cache.php' },
];
const THEMES = [
  { name: 'acme-child', title: 'Acme Child', status: 'active', version: '1.0', update: 'none', update_version: '' },
  { name: 'acme', title: 'Acme', status: 'parent', version: '2.4.0', update: 'none', update_version: '' },
  { name: 'spare', title: 'Spare', status: 'inactive', version: '1.0', update: 'none', update_version: '' },
];

/** What phpcs reports for a folder: two findings in acme-forms, nothing elsewhere. */
function phpcs(call: FakeCall) {
  const path = call.args.at(-1) as string;
  if (path.endsWith('acme-forms')) {
    return { code: 2, stdout: JSON.stringify({ files: {
      [join(path, 'lib/parser.php')]: { errors: 1, warnings: 1, messages: [
        { message: 'The constant "E_STRICT" is deprecated since PHP 8.4', source: 'PHPCompatibility.Constants.RemovedConstants.e_strictDeprecated', type: 'WARNING', line: 9 },
        { message: 'Function each() is removed since PHP 8.0', source: 'PHPCompatibility.FunctionUse.RemovedFunctions.eachDeprecatedRemoved', type: 'ERROR', line: 40 },
      ] },
      [join(path, 'acme-forms.php')]: { errors: 0, warnings: 0, messages: [] },
    } }) };
  }
  return { code: 0, stdout: JSON.stringify({ files: { [join(path.endsWith('.php') ? path : join(path, 'index.php'))]: { errors: 0, warnings: 0, messages: [] } } }) };
}

function setup(options: { installed?: boolean; composer?: boolean } = {}) {
  const t = wpSiteTree();
  php(t, { '8.3': ['cli', 'fpm'], '8.4': ['cli', 'fpm'], '8.5': ['fpm'] });
  site(t);
  const source = join(t.root, 'php-compat');
  mkdirSync(source);
  writeFileSync(join(source, 'composer.json'), '{}');
  writeFileSync(join(source, 'composer.lock'), LOCK);
  const dataDir = join(t.root, 'data');
  if (options.installed !== false) {
    mkdirSync(join(dataDir, 'tools/php-compat/vendor/bin'), { recursive: true });
    writeFileSync(join(dataDir, 'tools/php-compat/vendor/bin/phpcs'), '');
    writeFileSync(join(dataDir, 'tools/php-compat/composer.lock'), LOCK);
  }
  const bin = join(t.root, 'bin');
  mkdirSync(bin);
  if (options.composer) writeFileSync(join(bin, 'composer'), '');
  const fake = fakeExec({
    wp: (call) => ({ stdout: JSON.stringify(call.args.includes('plugin') ? PLUGINS : THEMES) }),
    'php8.4 -d memory_limit=1G': phpcs,
    composer: (call) => {
      const dir = (call.args.find((a) => a.startsWith('--working-dir=')) as string).slice('--working-dir='.length);
      mkdirSync(join(dir, 'vendor/bin'), { recursive: true });
      writeFileSync(join(dir, 'vendor/bin/phpcs'), '');
      return { stdout: 'Installing dependencies from lock file' };
    },
  });
  const store = new RunStore(':memory:');
  const ctx: CompatContext = { config: t.config, exec: fake.exec, store, dataDir, sourceDir: source, searchPath: bin };
  return { t, ctx, ...fake, store, site: siteFor(t.config, 'local.shop.com') };
}

const job: JobRuntime = { onUndo: () => undefined, progress: () => undefined };

describe('php.checkCompat', () => {
  it('scans the active theme, its parent, active plugins, mu-plugins, drop-ins and vendor on the version\'s own php, and keeps the result', async () => {
    const s = setup();
    const steps = planCheckCompat(s.ctx, s.site, { version: '8.4', scope: 'active' });
    expect(steps.map((x) => x.id)).toEqual(['list', 'scan']);
    for (const step of steps) expect(await step.run(job)).toMatchObject({ code: 0 });

    const scanned = s.calls.filter((c) => c.file === 'php8.4').map((c) => c.args.at(-1));
    const content = join(s.t.docroot, 'wp-content');
    expect(scanned).toEqual([
      join(content, 'themes/acme-child'),
      join(content, 'themes/acme'),
      join(content, 'plugins/acme-forms'),
      join(content, 'plugins/hello.php'),
      join(content, 'object-cache.php'),
      join(content, 'mu-plugins'),
      join(s.t.docroot, 'vendor'),
    ]);
    const call = s.calls.find((c) => c.file === 'php8.4') as FakeCall;
    expect(call.env).toEqual({ XDEBUG_MODE: 'off' });
    expect(call.args).toEqual(expect.arrayContaining(['--standard=PHPCompatibilityWP', 'testVersion', '8.4', '--report=json']));
    const mu = s.calls.find((c) => c.file === 'php8.4' && c.args.at(-1)?.endsWith('mu-plugins')) as FakeCall;
    expect(mu.args.find((a) => a.startsWith('--ignore='))).toContain('*/mu-plugins/devmagic-panel-login.php,*/mu-plugins/devmagic-panel-local.php');

    const [scan] = s.store.compatScans(s.site.key) as CompatScan[];
    expect(scan).toMatchObject({ version: '8.4', scope: 'active', errors: 1, warnings: 1, tool: 'PHPCompatibilityWP 3.0.0-alpha2, PHPCompatibility 10.0.0-alpha2, PHP_CodeSniffer 4.0.4' });
    const forms = scan?.components.find((c) => c.name === 'acme-forms');
    expect(forms).toMatchObject({ kind: 'plugin', update: '1.4.1', requiresPhp: '7.4', files: 2, errors: 1, warnings: 1 });
    // Errors first, paths relative to the plugin.
    expect(forms?.issues.map((i) => `${i.type} ${i.file}:${i.line}`)).toEqual(['error lib/parser.php:40', 'warning lib/parser.php:9']);
    expect(scan?.components.find((c) => c.name === 'acme')).toMatchObject({ status: 'parent', requiresPhp: '8.1' });
  });

  it('adds inactive plugins and themes with scope all', async () => {
    const s = setup();
    const [list] = planCheckCompat(s.ctx, s.site, { version: '8.4', scope: 'all' });
    const out = (await list?.run(job)) as { stdout: string };
    expect(out.stdout).toContain('Acme Old');
    expect(out.stdout).toContain('Spare');
  });

  it('fetches the scanner with Composer first, without plugins or scripts, and swaps it in', async () => {
    const s = setup({ installed: false, composer: true });
    const steps = planCheckCompat(s.ctx, s.site, { version: '8.4', scope: 'active' });
    expect(steps[0]?.id).toBe('tool');
    expect(await steps[0]?.run(job)).toMatchObject({ code: 0 });
    const composer = s.calls.find((c) => c.file === 'composer') as FakeCall;
    expect(composer.args).toEqual(expect.arrayContaining(['install', '--no-dev', '--no-plugins', '--no-scripts']));
    expect(composer.env).toMatchObject({ XDEBUG_MODE: 'off' });
    const tool = join(s.ctx.dataDir, 'tools/php-compat');
    expect(readFileSync(join(tool, 'composer.lock'), 'utf8')).toBe(LOCK);
    expect(existsSync(`${tool}.part`)).toBe(false);
    expect(compatInstalled(s.ctx)).toBe(true);
  });

  it('fetches it again when the panel ships another lock', () => {
    const s = setup();
    writeFileSync(join(s.ctx.sourceDir as string, 'composer.lock'), LOCK.replace('4.0.4', '4.0.5'));
    expect(compatInstalled(s.ctx)).toBe(false);
  });

  it('refuses before anything runs: no Composer and no scanner, a version without a command line, a version not installed', () => {
    const s = setup({ installed: false });
    expect(() => planCheckCompat(s.ctx, s.site, { version: '8.4', scope: 'active' })).toThrow(/Composer, which is not installed/);
    expect(() => planCheckCompat(s.ctx, s.site, { version: '8.5', scope: 'active' })).toThrow(/no command line/);
    expect(() => planCheckCompat(s.ctx, s.site, { version: '7.4', scope: 'active' })).toThrow(SiteActionRefused);
    expect(s.calls).toEqual([]);
  });

  it('marks a folder phpcs could not read, and fails the step when it could read none', async () => {
    const s = setup();
    const fake = fakeExec({ wp: (call) => ({ stdout: JSON.stringify(call.args.includes('plugin') ? [] : [THEMES[1]]) }), 'php8.4': { code: 16, stderr: 'ERROR: Referenced sniff does not exist' } });
    const ctx = { ...s.ctx, exec: fake.exec };
    const steps = planCheckCompat(ctx, s.site, { version: '8.4', scope: 'active' });
    await steps[0]?.run(job);
    const r = await steps[1]?.run(job);
    expect(r).toMatchObject({ code: 1 });
    const [scan] = s.store.compatScans(s.site.key) as CompatScan[];
    expect(scan?.components.find((c) => c.name === 'acme')?.failed).toBe('ERROR: Referenced sniff does not exist');
  });

  it('counts a folder with nothing left to scan as clean, not as failed', async () => {
    const s = setup();
    const fake = fakeExec({ wp: (call) => ({ stdout: JSON.stringify(call.args.includes('plugin') ? [] : [THEMES[1]]) }), 'php8.4': (call) => (call.args.at(-1)?.endsWith('mu-plugins') ? { code: 16, stdout: 'ERROR: All specified files were excluded or did not match filtering rules.' } : phpcs(call)) });
    const steps = planCheckCompat({ ...s.ctx, exec: fake.exec }, s.site, { version: '8.4', scope: 'active' });
    await steps[0]?.run(job);
    expect(await steps[1]?.run(job)).toMatchObject({ code: 0, stderr: '' });
    const [scan] = s.store.compatScans(s.site.key) as CompatScan[];
    expect(scan?.components.find((c) => c.kind === 'mu-plugin')).toMatchObject({ files: 0, errors: 0 });
    expect(scan?.components.find((c) => c.kind === 'mu-plugin')?.failed).toBeUndefined();
  });

  it('reads a site\'s scans, newest version first, and whether a check can run', async () => {
    const s = setup({ installed: false, composer: true });
    s.store.saveCompatScan(s.site.key, '8.3', { version: '8.3' });
    s.store.saveCompatScan(s.site.key, '8.4', { version: '8.4' });
    const compat = await readSiteCompat(s.ctx, s.site);
    expect(compat.scans.map((x) => x.version)).toEqual(['8.4', '8.3']);
    expect(compat).toMatchObject({ versions: ['8.4', '8.3'], installed: false, composer: true });
  });
});

describe('php.checkCompatAll', () => {
  /** A second site, local.blog.com, whose WP-CLI cannot reach its database. */
  function second(s: ReturnType<typeof setup>) {
    const docroot = join(s.t.config.WEB_DIR, 'local.blog.com');
    mkdirSync(join(docroot, 'wp-content'), { recursive: true });
    writeFileSync(join(docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'blog');\n");
    const conf = join(s.t.config.APACHE_SITES_AVAILABLE, 'local.blog.com-ssl.conf');
    writeFileSync(conf, `<VirtualHost *:443>\n ServerName local.blog.com\n DocumentRoot ${docroot}\n</VirtualHost>\n`);
    symlinkSync(conf, join(s.t.config.APACHE_SITES_ENABLED, 'local.blog.com-ssl.conf'));
  }

  it('scans every WordPress site in turn, passes over one WP-CLI cannot read, and sums up', async () => {
    const s = setup();
    second(s);
    const fake = fakeExec({
      wp: (call) => (call.args.some((a) => a.includes('local.blog.com')) ? { code: 1, stderr: 'Error establishing a database connection' } : { stdout: JSON.stringify(call.args.includes('plugin') ? PLUGINS : THEMES) }),
      'php8.4 -d memory_limit=1G': phpcs,
    });
    const ctx = { ...s.ctx, exec: fake.exec };
    const sites = wordpressSites(s.t.config);
    expect(sites.map((x) => x.host)).toEqual(['local.blog.com', 'local.shop.com']);
    const steps = planCheckCompatAll(ctx, sites, { version: '8.4', scope: 'active' });
    expect(steps.map((x) => x.id)).toEqual(['site-local.blog.com', 'site-local.shop.com', 'summary']);
    const out: string[] = [];
    for (const step of steps) {
      const r = (await step.run(job)) as { code: number; stdout: string };
      expect(r.code).toBe(0);
      out.push(r.stdout);
    }
    expect(out[0]).toBe('not scanned: WP-CLI could not list the plugins: Error establishing a database connection');
    expect(out[2]).toBe('1 site checked against PHP 8.4: errors in local.shop.com (1 error).\nNot scanned, WP-CLI could not read them: local.blog.com.');

    const report = await readVersionCompat(ctx, '8.4');
    expect(report).toMatchObject({ version: '8.4', cli: true, installed: true });
    expect(report.sites).toEqual([
      { domain: 'local.blog.com', host: 'local.blog.com', runs: '8.5' },
      { domain: 'local.shop.com', host: 'local.shop.com', runs: '8.5', scan: expect.objectContaining({ errors: 1, warnings: 1, withErrors: ['Acme Forms'], failed: 0, stale: false }) },
    ]);
  });

  it('refuses before anything runs without a command line for the version, or without a site', () => {
    const s = setup();
    expect(() => planCheckCompatAll(s.ctx, wordpressSites(s.t.config), { version: '8.5', scope: 'active' })).toThrow(/no command line/);
    expect(() => planCheckCompatAll(s.ctx, [], { version: '8.4', scope: 'active' })).toThrow(/no WordPress site/);
  });
});

describe('deleting scans', () => {
  it('deletes one site\'s scan of a version, all of a site\'s, or a version on every site, with the cache for them', () => {
    const store = new RunStore(':memory:');
    const t = wpSiteTree();
    const cache = join(t.root, 'tools/php-compat/cache');
    const put = (key: string, version: string) => {
      store.saveCompatScan(key, version, { version });
      mkdirSync(join(cache, key, version), { recursive: true });
    };
    put('local.shop.com', '8.3');
    put('local.shop.com', '8.4');
    put('local.shop.com@learn', '8.4');
    put('local.blog.com', '8.4');
    put('local.blog.com', '8.3');

    expect(forgetCompat(store, t.root, { key: 'local.shop.com', version: '8.4' })).toBe(1);
    expect((store.compatScans('local.shop.com') as CompatScan[]).map((x) => x.version)).toEqual(['8.3']);
    expect(existsSync(join(cache, 'local.shop.com/8.4'))).toBe(false);
    expect(existsSync(join(cache, 'local.shop.com/8.3'))).toBe(true);
    // A key is one site: the install under a path keeps its own.
    expect(forgetCompat(store, t.root, { key: 'local.shop.com' })).toBe(1);
    expect(store.compatScans('local.shop.com@learn')).toHaveLength(1);
    expect(forgetCompat(store, t.root, { version: '8.4' })).toBe(2);
    expect((store.compatScans('local.blog.com') as CompatScan[]).map((x) => x.version)).toEqual(['8.3']);
    expect(forgetCompat(store, t.root, { version: '8.4' })).toBe(0);
    // LIKE wildcards in a domain match only themselves.
    put('local.a_b.com@learn', '8.4');
    put('local.axb.com@learn', '8.4');
    expect(forgetCompat(store, t.root, { domain: 'local.a_b.com' })).toBe(1);
    expect(store.compatScans('local.axb.com@learn')).toHaveLength(1);
    expect(() => store.deleteCompatScans({})).toThrow();
  });

  it('php.deleteCompat wants a site, a version or both, and says what went', async () => {
    const s = setup();
    const ctx = { config: s.t.config, exec: s.exec, store: s.store, dmpRoot: '/x/dmp-root', wpcoreBin: '/x/wpcore', wpcoreConf: s.t.wpcoreConf, home: s.t.root, jobs: new Jobs(s.store), uploadsDir: join(s.ctx.dataDir, 'uploads'), secrets: null } as ActionContext;
    s.store.saveCompatScan('local.shop.com', '8.4', { version: '8.4' });
    expect(await runAction(ctx, 'php.deleteCompat', {})).toMatchObject({ ok: false, output: expect.stringContaining('Give a site, a PHP version or both') });
    expect(await runAction(ctx, 'php.deleteCompat', { path: '/learn', version: '8.4' })).toMatchObject({ ok: false, output: expect.stringContaining('A path needs the domain') });
    expect(s.store.compatScans('local.shop.com')).toHaveLength(1);
    expect((await runAction(ctx, 'php.deleteCompat', { domain: 'local.shop.com', version: '8.4' })).output).toContain('deleted 1 compatibility scan of local.shop.com on PHP 8.4');
    expect((await runAction(ctx, 'php.deleteCompat', { version: '8.4' })).output).toContain('no compatibility scan of every site on PHP 8.4 was kept');
  });
});

describe('phpcs report', () => {
  it('keeps the first issues only, with the full counts', () => {
    const target = { component: { kind: 'plugin' as const, name: 'big', title: 'Big', status: 'active' }, path: '/w/big' };
    const messages = Array.from({ length: 150 }, (_, i) => ({ message: `m${i}`, source: 's', type: i === 149 ? 'ERROR' : 'WARNING', line: i }));
    const found = readReport(JSON.stringify({ files: { '/w/big/a.php': { errors: 1, warnings: 149, messages } } }), target);
    expect(found).toMatchObject({ files: 1, errors: 1, warnings: 149 });
    expect(found.issues).toHaveLength(100);
    expect(found.issues[0]).toMatchObject({ type: 'error', file: 'a.php', line: 149 });
  });

  it('points phpcs at the standards in the scanner folder and a cache per folder', () => {
    const args = phpcsArgs('/data/tools/php-compat', '8.4', { component: { kind: 'theme', name: 'acme', title: 'Acme', status: 'active' }, path: '/w/acme' }, '/c/theme-acme.json', 2);
    expect(args).toEqual(expect.arrayContaining([
      '/data/tools/php-compat/vendor/bin/phpcs',
      '/data/tools/php-compat/vendor/phpcompatibility/php-compatibility,/data/tools/php-compat/vendor/phpcompatibility/phpcompatibility-paragonie,/data/tools/php-compat/vendor/phpcompatibility/phpcompatibility-wp,/data/tools/php-compat/vendor/phpcsstandards/phpcsutils',
      '--parallel=2',
      '--cache=/c/theme-acme.json',
    ]));
  });
});

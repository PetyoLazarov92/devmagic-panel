import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import type { JobRuntime } from '../src/jobs.js';
import { poolFolder, readPools, sitesByVersion, wpCommand } from '../src/php/pools.js';
import { constraintMinimum, readPhpRequirements } from '../src/php/requirements.js';
import { planMatchFpm, planSitePhp, readSitePhp } from '../src/php/site-php.js';
import { planSwitchToFpm, planSwitchToModPhp } from '../src/php/switch.js';
import { discoverSites } from '../src/sites/discover.js';
import { fromFpm, parseApacheErrorLog } from '../src/sites/logs.js';
import { planAddNetworkAdmin } from '../src/sites/network-admin.js';
import { SiteActionRefused, siteFor } from '../src/sites/site-actions.js';
import { fakeExec, wpSiteTree } from './helpers.js';

type Tree = ReturnType<typeof wpSiteTree>;
const MARKER = '; Managed by devmagic-panel. Edits here are overwritten.';

/** PHP versions with their parts, and mod_php when asked. */
function php(t: Tree, versions: Record<string, string[]>, modPhp?: string) {
  for (const [version, parts] of Object.entries(versions)) {
    mkdirSync(join(t.config.PHP_CONF_DIR, version, 'mods-available'), { recursive: true });
    mkdirSync(join(t.config.PHP_LIB_DIR, version, 'sapi'), { recursive: true });
    for (const part of parts) {
      mkdirSync(join(t.config.PHP_CONF_DIR, version, part, part === 'fpm' ? 'pool.d' : 'conf.d'), { recursive: true });
      writeFileSync(join(t.config.PHP_LIB_DIR, version, 'sapi', part), '');
    }
  }
  if (modPhp) writeFileSync(join(t.root, 'mods-enabled', `php${modPhp}.load`), '');
}

const pool = (t: Tree, version: string, folder: string, lines = '') =>
  writeFileSync(join(t.config.PHP_CONF_DIR, version, 'fpm/pool.d', `dmp-${folder}.conf`), `${MARKER}\n[dmp-${folder}]\npm = ondemand\n${lines}`);

function runtime() {
  const undo: Array<{ label: string; run: () => Promise<ExecResult | ExecResult[]> }> = [];
  const job: JobRuntime = { onUndo: (label, run) => void undo.push({ label, run }), progress: () => undefined };
  return { job, undo };
}

const INFO = (version: string) => JSON.stringify({ version, sapi: 'fpm-fcgi', ini: {}, scannedFiles: [], groups: {}, extensions: {}, zendExtensions: [] });

describe('pools', () => {
  it('reads the panel\'s pools with their settings, and nothing else in pool.d', () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'], '8.3': ['apache2', 'fpm'] }, '8.3');
    pool(t, '8.1', 'local.shop.com', 'php_admin_value[memory_limit] = 1G\nphp_admin_value[auto_prepend_file] = /x.php\n');
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.3/fpm/pool.d/www.conf'), '[www]\n');
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.3/fpm/pool.d/dmp-local.hand.com.conf'), '[dmp-local.hand.com]\n');
    expect(readPools(t.config)).toEqual([{ version: '8.1', folder: 'local.shop.com', values: { memory_limit: '1G' } }]);
    expect(sitesByVersion(t.config)('8.1')).toEqual(['local.shop.com']);
    expect(poolFolder(t.config, t.docroot)).toBe('local.shop.com');
    expect(poolFolder(t.config, '/srv/elsewhere/local.shop.com')).toBeUndefined();
  });

  it('runs WP-CLI\'s phar with the site\'s PHP, and gives another launcher WP_CLI_PHP', () => {
    const t = wpSiteTree();
    const bin = join(t.root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'wp'), '#!/usr/bin/env php\n<?php Phar::mapPhar();');
    chmodSync(join(bin, 'wp'), 0o755);
    expect(wpCommand(undefined, ['cli', 'info'], bin)).toEqual({ file: 'wp', args: ['cli', 'info'] });
    expect(wpCommand('8.1', ['cli', 'info'], bin)).toEqual({ file: 'php8.1', args: [join(bin, 'wp'), 'cli', 'info'] });
    writeFileSync(join(bin, 'wp'), '#!/bin/sh\nexec php "$0.phar" "$@"\n');
    expect(wpCommand('8.1', ['cli', 'info'], bin)).toEqual({ file: 'wp', args: ['cli', 'info'], env: { WP_CLI_PHP: 'php8.1' } });
  });

  it('runs a site\'s WP-CLI on its pool\'s version', async () => {
    const t = wpSiteTree({ multisite: true });
    php(t, { '8.1': ['fpm'] });
    pool(t, '8.1', 'local.shop.com');
    const site = siteFor(t.config, 'local.shop.com');
    expect(site.php).toBe('8.1');
    const fake = fakeExec({ php8: { stdout: '{"added":[]}' }, wp: { stdout: '{"added":[]}' } });
    await planAddNetworkAdmin(fake.exec, site, 'admin')[0]?.run(runtime().job);
    const call = fake.calls[0];
    expect(call?.file === 'php8.1' || call?.env?.WP_CLI_PHP === 'php8.1').toBe(true);
  });
});

describe('what a site\'s code needs', () => {
  it('reads composer.json, WordPress, themes and plugins, and keeps the highest minimum', () => {
    expect(constraintMinimum('^7.4 || ^8.0')).toBe('7.4');
    expect(constraintMinimum('>=8.1')).toBe('8.1');
    const t = wpSiteTree({ ownCore: true });
    writeFileSync(join(t.docroot, 'wp-includes/version.php'), "<?php $wp_version = '6.8.1'; $required_php_version = '7.2.24';");
    writeFileSync(join(t.docroot, 'composer.json'), JSON.stringify({ require: { php: '>=7.4' } }));
    mkdirSync(join(t.docroot, 'wp-content/themes/acme'), { recursive: true });
    writeFileSync(join(t.docroot, 'wp-content/themes/acme/style.css'), '/*\nTheme Name: Acme\nRequires PHP: 8.1\n*/');
    mkdirSync(join(t.docroot, 'wp-content/plugins/shop'), { recursive: true });
    writeFileSync(join(t.docroot, 'wp-content/plugins/shop/helpers.php'), '<?php // Requires PHP: 9.9 (not a header)');
    writeFileSync(join(t.docroot, 'wp-content/plugins/shop/shop.php'), '<?php\n/**\n * Plugin Name: Shop\n * Requires PHP: 8.1\n */');
    expect(readPhpRequirements(t.docroot)).toEqual({ version: '8.1', sources: ['theme acme', 'plugin shop'] });
  });
});

describe('PHP-FPM errors in the Logs tab', () => {
  it('shows them as mod_php wrote them', () => {
    expect(fromFpm("AH01071: Got error 'PHP message: PHP Fatal error:  Uncaught Error: x in /var/www/a.php:3\\nPHP message: PHP Warning:  y'")).toBe('PHP Fatal error:  Uncaught Error: x in /var/www/a.php:3\nPHP Warning:  y');
    const [line] = parseApacheErrorLog("[Fri Oct 30 09:42:00.060301 2026] [proxy_fcgi:error] [pid 1] [client 127.0.0.1:5] AH01071: Got error 'PHP message: PHP Fatal error:  boom'");
    expect(line).toMatchObject({ level: 'fatal', message: 'PHP Fatal error:  boom' });
  });
});

describe('a site\'s PHP', () => {
  // dmp-root in a temp prefix, with the info script installed next to it.
  const ctx = (t: Tree, responses: Parameters<typeof fakeExec>[0] = {}) => {
    const dmpRoot = join(t.root, 'prefix/bin/dmp-root');
    mkdirSync(join(t.root, 'prefix/php'), { recursive: true });
    writeFileSync(join(t.root, 'prefix/php/info.php'), '<?php');
    const fake = fakeExec({ [`sudo -n ${dmpRoot}`]: { stdout: 'ok' }, curl: { stdout: '<!DOCTYPE html>\n200' }, ...responses });
    return { c: { config: t.config, exec: fake.exec, dmpRoot }, fake };
  };

  it('reads its version, settings, choices and what its code needs', () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'], '8.3': ['apache2', 'fpm'] }, '8.3');
    pool(t, '8.1', 'local.shop.com', 'php_admin_value[memory_limit] = 1G\n');
    expect(readSitePhp(t.config, siteFor(t.config, 'local.shop.com'))).toEqual({ version: '8.1', defaultVersion: '8.3', values: { memory_limit: '1G' }, choices: ['8.3', '8.1'] });
  });

  it('moves a site to a version with its settings, checks the pool and the site, and Undo puts it back', async () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'], '8.3': ['apache2', 'fpm'] }, '8.3');
    const { c, fake } = ctx(t, { 'curl -sS --fail-with-body': { stdout: INFO('8.1.31') } });
    const steps = planSitePhp(c, siteFor(t.config, 'local.shop.com'), { version: '8.1', values: { memory_limit: '1G' } });
    expect(steps.map((s) => s.id)).toEqual(['pool', 'fpm', 'site', 'trial']);
    const { job, undo } = runtime();
    for (const step of steps) expect((await step.run(job)) as ExecResult).toMatchObject({ code: 0 });
    expect(fake.calls[0]?.args).toEqual(['-n', c.dmpRoot, 'php-pool-write', 'local.shop.com', '8.1', 'memory_limit=1G']);
    expect(fake.calls[1]?.args.at(-1)).toBe('http://local.devmagic/.devmagic-panel-php/dmp-local.shop.com/info.php');
    expect(fake.calls[2]?.args).toContain('local.shop.com:443:127.0.0.1');
    await undo[0]?.run();
    expect(fake.calls.at(-1)?.args).toEqual(['-n', c.dmpRoot, 'php-pool-remove', 'local.shop.com']);
  });

  it('asks a new pool again while PHP-FPM is still starting it (503), and the site again while it answers 503', async () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'] });
    const site = siteFor(t.config, 'local.shop.com');
    let info = 0;
    let page = 0;
    const { c, fake } = ctx(t, {
      'curl -sS --fail-with-body': () => (++info < 3 ? { code: 22, stderr: 'curl: (22) The requested URL returned error: 503' } : { stdout: INFO('8.1.31') }),
      curl: () => (++page < 2 ? { stdout: 'busy\n503' } : { stdout: '<!DOCTYPE html>\n200' }),
    });
    const quick = { ...c, settle: { delayMs: 0 } };
    const steps = planSitePhp(quick, site, { version: '8.1', values: {} });
    expect(await steps[1]?.run(runtime().job)).toMatchObject({ code: 0, stdout: expect.stringContaining('8.1.31') });
    expect(await steps[2]?.run(runtime().job)).toMatchObject({ code: 0 });
    expect(fake.calls.filter((x) => x.file === 'curl')).toHaveLength(5);
    // A pool that never answers fails with what Apache said, not with a hint to reinstall.
    const down = ctx(t, { 'curl -sS --fail-with-body': { code: 22, stderr: 'curl: (22) The requested URL returned error: 503' } });
    expect(await planSitePhp({ ...down.c, settle: { tries: 2, delayMs: 0 } }, site, { version: '8.1', values: {} })[1]?.run(runtime().job)).toMatchObject({ code: 1, stderr: expect.stringContaining('PHP-FPM did not answer (503)') });
  });

  it('fails the check when the site sends PHP source or a 500, or the pool runs another version', async () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'] });
    const site = siteFor(t.config, 'local.shop.com');
    const source = ctx(t, { curl: { stdout: '<?php echo 1;\n200' } });
    expect(await planSitePhp(source.c, site, { version: '8.1', values: {} }).find((x) => x.id === 'site')?.run(runtime().job)).toMatchObject({ code: 1, stderr: expect.stringContaining('PHP source') });
    const broken = ctx(t, { curl: { stdout: 'oops\n500' } });
    expect(await planSitePhp(broken.c, site, { version: '8.1', values: {} }).find((x) => x.id === 'site')?.run(runtime().job)).toMatchObject({ code: 1, stderr: expect.stringContaining('500') });
    const other = ctx(t, { curl: { stdout: INFO('8.3.6') } });
    expect(await planSitePhp(other.c, site, { version: '8.1', values: {} })[1]?.run(runtime().job)).toMatchObject({ code: 1, stderr: expect.stringContaining('not 8.1') });
  });

  it('puts a site back on the default and Undo gives it its pool again', async () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'] });
    pool(t, '8.1', 'local.shop.com', 'php_admin_value[memory_limit] = 1G\n');
    const { c, fake } = ctx(t);
    const steps = planSitePhp(c, siteFor(t.config, 'local.shop.com'), { version: null, values: {} });
    expect(steps.map((s) => s.id)).toEqual(['pool', 'site', 'trial']);
    const { job, undo } = runtime();
    await steps[0]?.run(job);
    await undo[0]?.run();
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-pool-remove local.shop.com', 'php-pool-write local.shop.com 8.1 memory_limit=1G']);
  });

  it('refuses before anything runs: no FPM, php_value in .htaccess, FPM unlike mod_php, a folder elsewhere, nothing to undo', () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['cli'], '8.3': ['apache2', 'fpm'] }, '8.3');
    const { c, fake } = ctx(t);
    const site = siteFor(t.config, 'local.shop.com');
    expect(() => planSitePhp(c, site, { version: '8.1', values: {} })).toThrow('PHP-FPM is not installed for PHP 8.1');
    expect(() => planSitePhp(c, site, { version: null, values: {} })).toThrow('already runs the PHP every site runs');
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.3/apache2/php.ini'), 'memory_limit = 512M\n');
    expect(() => planSitePhp(c, site, { version: '8.3', values: {} })).toThrow('PHP-FPM 8.3 differs from Apache\'s PHP 8.3 in memory_limit');
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.3/fpm/php.ini'), 'memory_limit = 512M\n');
    expect(planSitePhp(c, site, { version: '8.3', values: {} })).toHaveLength(4);
    writeFileSync(join(t.docroot, '.htaccess'), 'php_value upload_max_filesize 64M\n');
    expect(() => planSitePhp(c, site, { version: '8.3', values: {} })).toThrow(SiteActionRefused);
    expect(() => planSitePhp(c, { ...site, docroot: '/srv/sites/local.shop.com' }, { version: '8.3', values: {} })).toThrow('sits right in');
    expect(fake.calls).toEqual([]);
  });

  it('matches FPM to mod_php, and Undo puts FPM\'s php.ini back', async () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['apache2', 'fpm'] }, '8.3');
    const { c, fake } = ctx(t, { [`sudo -n ${join(t.root, 'prefix/bin/dmp-root')} php-fpm-match`]: { stdout: 'saved 8.3-fpm-20261030101010\n' } });
    const { job, undo } = runtime();
    await planMatchFpm(c, '8.3')[0]?.run(job);
    await undo[0]?.run();
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-fpm-match 8.3', 'php-ini-put-back 8.3 fpm 8.3-fpm-20261030101010']);
    expect(() => planMatchFpm(c, '8.1')).toThrow('PHP-FPM is not installed for PHP 8.1');
  });
});

describe('the last switch', () => {
  const ctx = (t: Tree, responses: Parameters<typeof fakeExec>[0] = {}) => {
    const dmpRoot = join(t.root, 'prefix/bin/dmp-root');
    const fake = fakeExec({ [`sudo -n ${dmpRoot}`]: { stdout: 'ok' }, curl: { stdout: '<!DOCTYPE html>\n200' }, ...responses });
    return { c: { config: t.config, exec: fake.exec, dmpRoot }, fake };
  };

  it('turns mod_php off, checks every site, and Undo turns it back on', async () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['apache2', 'fpm'] }, '8.3');
    writeFileSync(join(t.config.PHP_LIB_DIR, '8.3/sapi/apache2'), '');
    const { c, fake } = ctx(t);
    const steps = planSwitchToFpm(c, '8.3');
    expect(steps.map((s) => s.id)).toEqual(['switch', 'sites']);
    const { job, undo } = runtime();
    await steps[0]?.run(job);
    expect(await steps[1]?.run(job)).toMatchObject({ code: 0, stdout: expect.stringContaining('1 site answer') });
    await undo[0]?.run();
    expect(fake.calls.filter((x) => x.file === 'sudo').map((x) => x.args.slice(2).join(' '))).toEqual(['php-switch-fpm 8.3', 'php-switch-modphp 8.3']);
  });

  it('fails the check listing the sites that broke', async () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['apache2', 'fpm'] }, '8.3');
    const { c } = ctx(t, { curl: { stdout: '<?php phpinfo();\n200' } });
    expect(await planSwitchToFpm(c, '8.3')[1]?.run(runtime().job)).toMatchObject({ code: 1, stderr: expect.stringContaining('1 of 1 sites did not answer: local.shop.com') });
  });

  it('refuses while a php_value would break a site or FPM differs from mod_php', () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['apache2', 'fpm'] }, '8.3');
    writeFileSync(join(t.docroot, '.htaccess'), 'php_value memory_limit 1G\n');
    expect(() => planSwitchToFpm(ctx(t).c, '8.3')).toThrow('Not yet:');
    writeFileSync(join(t.docroot, '.htaccess'), '');
    writeFileSync(join(t.config.PHP_CONF_DIR, '8.3/apache2/php.ini'), 'memory_limit = 512M\n');
    expect(() => planSwitchToFpm(ctx(t).c, '8.3')).toThrow('memory_limit');
    expect(() => planSwitchToFpm(ctx(t).c, '8.1')).toThrow('PHP-FPM is not installed for PHP 8.1');
  });

  it('reads the default FPM version once mod_php is off, and goes back to mod_php', async () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['apache2', 'fpm'] });
    writeFileSync(join(t.config.PHP_LIB_DIR, '8.3/sapi/apache2'), '');
    mkdirSync(t.config.STATE_DIR, { recursive: true });
    writeFileSync(join(t.config.STATE_DIR, 'php-default'), '8.3\n');
    expect(readSitePhp(t.config, siteFor(t.config, 'local.shop.com')).defaultVersion).toBe('8.3');
    expect(() => planSwitchToFpm(ctx(t).c, '8.3')).toThrow('already runs on PHP 8.3');
    const { c, fake } = ctx(t);
    const { job, undo } = runtime();
    await planSwitchToModPhp(c, '8.3')[0]?.run(job);
    await undo[0]?.run();
    expect(fake.calls.map((x) => x.args.slice(2).join(' '))).toEqual(['php-switch-modphp 8.3', 'php-switch-fpm 8.3']);
    expect(() => planSwitchToModPhp(c, '8.1')).toThrow('apt install libapache2-mod-php8.1');
  });

  it('moves the default from one FPM version to another, and Undo moves it back', async () => {
    const t = wpSiteTree();
    php(t, { '8.3': ['fpm'], '8.4': ['fpm'] });
    mkdirSync(t.config.STATE_DIR, { recursive: true });
    writeFileSync(join(t.config.STATE_DIR, 'php-default'), '8.3\n');
    const { c, fake } = ctx(t);
    const steps = planSwitchToFpm(c, '8.4');
    expect(steps[0]?.label).toBe('Run every site without a PHP of its own on PHP 8.4');
    const { job, undo } = runtime();
    await steps[0]?.run(job);
    await undo[0]?.run();
    expect(fake.calls.filter((x) => x.file === 'sudo').map((x) => x.args.slice(2).join(' '))).toEqual(['php-switch-fpm 8.4', 'php-switch-fpm 8.3']);
  });
});

describe('the PHP a site runs, on the Sites list', () => {
  it('is its own pool\'s version, else the default', async () => {
    const t = wpSiteTree();
    php(t, { '8.1': ['fpm'], '8.3': ['apache2', 'fpm'] }, '8.3');
    const ctx = { config: t.config, exec: fakeExec().exec, secrets: null, wpcoreConf: t.wpcoreConf };
    expect((await discoverSites(ctx))[0]?.php).toEqual({ version: '8.3', own: false });
    pool(t, '8.1', 'local.shop.com');
    expect((await discoverSites(ctx))[0]?.php).toEqual({ version: '8.1', own: true });
  });
});

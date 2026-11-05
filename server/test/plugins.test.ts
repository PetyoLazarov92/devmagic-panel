import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoKey } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { productionOnlyFor, readPlugins, requiredPlugins } from '../src/sites/plugins.js';
import { siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

const row = (name: string, status: string, extra: Record<string, string> = {}) => ({ name, title: name.toUpperCase(), status, version: '1.0', update: 'none', update_version: '', file: `${name}/${name}.php`, ...extra });

const LIST = [
  row('devmagic-panel-local', 'must-use', { file: 'devmagic-panel-local.php' }),
  row('advanced-cache.php', 'dropin', { title: '', file: 'advanced-cache.php' }),
  row('acf', 'active'),
  row('acme-blocks', 'active'),
  row('acme-old', 'inactive'),
  row('wp-rocket', 'inactive', { update: 'available', update_version: '3.20' }),
  row('query-monitor', 'active'),
  row('odd', 'recently-active'),
];

/** local.shop.com with plugin files: acme-blocks and acme-old need acf, but only acme-blocks is on. */
function setup(responses: Record<string, FakeResponse> = {}, options: { multisite?: boolean } = {}) {
  const t = wpSiteTree(options);
  for (const name of ['acf', 'acme-blocks', 'acme-old']) mkdirSync(join(t.docroot, 'wp-content/plugins', name), { recursive: true });
  writeFileSync(join(t.docroot, 'wp-content/plugins/acf/acf.php'), '<?php\n/**\n * Plugin Name: ACF\n */\n');
  writeFileSync(join(t.docroot, 'wp-content/plugins/acme-blocks/acme-blocks.php'), '<?php\n/**\n * Plugin Name: Acme Blocks\n * Requires Plugins: acf, not a slug!\n */\n');
  writeFileSync(join(t.docroot, 'wp-content/plugins/acme-old/acme-old.php'), '<?php\n/*\nPlugin Name: Acme Old\nRequires Plugins: acf\n*/\n');
  const fake = fakeExec({ 'wp': { stdout: JSON.stringify(LIST) }, ...responses });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: 'wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
  };
  return { t, fake, store, ctx };
}

describe('requiredPlugins', () => {
  it('reads the Requires Plugins header in either comment style and keeps only slugs', () => {
    expect(requiredPlugins(' * Requires Plugins: woocommerce, acf-pro ,bad slug\n')).toEqual(['woocommerce', 'acf-pro']);
    expect(requiredPlugins('Requires Plugins:acf')).toEqual(['acf']);
    expect(requiredPlugins(' * Plugin Name: Nothing needed')).toEqual([]);
  });
});

describe('readPlugins', () => {
  it('lists the plugins with what each needs, what needs it, updates and the panel tags, without an update check or loading them', async () => {
    const { t, fake } = setup();
    const list = await readPlugins(fake.exec, siteFor(t.config, 'local.shop.com'), ['wp-rocket']);
    expect(fake.calls[0]?.args).toEqual([
      `--path=${t.docroot}`, '--url=https://local.shop.com/', 'plugin', 'list', '--format=json', '--fields=name,title,status,version,update,update_version,file', '--skip-update-check', '--skip-plugins', '--skip-themes',
    ]);
    expect(list.network).toBe(false);
    expect(list.plugins.map((p) => p.name)).not.toContain('odd');
    const by = Object.fromEntries(list.plugins.map((p) => [p.name, p]));
    // Only the active acme-blocks counts: acme-old is off.
    expect(by.acf).toEqual({ name: 'acf', title: 'ACF', status: 'active', version: '1.0', requiredBy: ['ACME-BLOCKS'] });
    expect(by['acme-blocks']?.requires).toEqual(['acf']);
    expect(by['acme-old']?.requires).toEqual(['acf']);
    expect(by['wp-rocket']).toMatchObject({ update: '3.20', productionOnly: true });
    expect(by['query-monitor']?.localHelper).toBe(true);
    expect(by['advanced-cache.php']).toEqual({ name: 'advanced-cache.php', title: 'advanced-cache.php', status: 'dropin', version: '1.0' });
  });

  it('says why when WP-CLI cannot list them', async () => {
    const { t, fake } = setup({ 'wp': { code: 1, stderr: 'Error: Error establishing a database connection.' } });
    await expect(readPlugins(fake.exec, siteFor(t.config, 'local.shop.com'))).rejects.toThrow('WP-CLI could not list the plugins: Error: Error establishing a database connection.');
  });
});

describe('productionOnlyFor', () => {
  it("takes the production-only plugins from the wizard's answers for the site's repo", () => {
    const store = new RunStore(':memory:');
    expect(productionOnlyFor(store, 'local.shop.com')).toEqual([]);
    store.setInstall('local.shop.com', undefined, { how: 'repo', repo: 'git@github.com:acme/shop.git' });
    expect(productionOnlyFor(store, 'local.shop.com')).toEqual([]);
    store.savePreset(repoKey('git@github.com:acme/shop.git') as string, { domains: [{ local: 'local.shop.com' }], layout: 'site-root', deactivate: ['wp-rocket', 'cloudflare'], activate: [], build: { composer: false, npm: true } });
    expect(productionOnlyFor(store, 'local.shop.com')).toEqual(['wp-rocket', 'cloudflare']);
  });
});

describe('site.pluginSet', () => {
  const wpCalls = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.args.includes('activate') || c.args.includes('deactivate')).map((c) => c.args.slice(2).join(' '));

  it('turns a plugin on or off with its hooks running, and does nothing when it already is', async () => {
    const { ctx, fake } = setup({ 'wp': (call) => ({ stdout: call.args.includes('list') ? JSON.stringify(LIST) : 'Success: done' }) });
    expect((await runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'acme-old', active: true })).ok).toBe(true);
    expect((await runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'acf', active: false })).ok).toBe(true);
    const already = await runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'query-monitor', active: true });
    expect(already.output).toBe('QUERY-MONITOR is already on');
    expect(wpCalls(fake.calls)).toEqual(['plugin activate acme-old', 'plugin deactivate acf']);
    // Activation loads the other plugins, as wp-admin does.
    expect(fake.calls.find((c) => c.args.includes('activate'))?.args).not.toContain('--skip-plugins');
  });

  it('turns plugins on network-wide on a multisite network', async () => {
    const { ctx, fake } = setup({ 'wp': (call) => ({ stdout: call.args.includes('list') ? JSON.stringify(LIST) : 'Success: done' }) }, { multisite: true });
    await runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'acme-old', active: true });
    await runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'acf', active: false });
    expect(wpCalls(fake.calls)).toEqual(['plugin activate acme-old --network', 'plugin deactivate acf']);
  });

  it('refuses must-use plugins, unknown ones and names that are not slugs', async () => {
    const { ctx, fake } = setup();
    await expect(runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'devmagic-panel-local', active: false })).rejects.toThrow('a must-use plugin: WordPress always loads it');
    await expect(runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: 'nope', active: true })).rejects.toThrow('local.shop.com has no plugin called nope');
    await expect(runAction(ctx, 'site.pluginSet', { domain: 'local.shop.com', plugin: '--require=evil.php', active: true })).rejects.toThrow('plugin');
    await expect(runAction(ctx, 'site.pluginSet', { domain: 'www.shop.com', plugin: 'acf', active: true })).rejects.toThrow('domain');
    expect(wpCalls(fake.calls)).toEqual([]);
  });
});

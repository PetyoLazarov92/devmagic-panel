import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { batchRows, MissingScans, MISSING_SCAN_MS, scanMissing } from '../src/sites/missing-scan.js';
import { phpArray } from '../src/sites/php-serialized.js';
import { siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { fakeExec, type FakeCall, wpSiteTree } from './helpers.js';

const base = (docroot: string) => `wp --path=${docroot} --url=https://local.shop.com/`;
const ser = (items: string[]) => `a:${items.length}:{${items.map((v, i) => `i:${i};s:${Buffer.byteLength(v)}:"${v}";`).join('')}}`;
const serKeys = (items: string[]) => `a:${items.length}:{${items.map((v) => `s:${Buffer.byteLength(v)}:"${v}";i:1762600000;`).join('')}}`;

describe('reading PHP serialized arrays', () => {
  it('reads plain values and keys, counting bytes, and gives up on anything else', () => {
    expect([...(phpArray(ser(['akismet/akismet.php', 'café/café.php'])) ?? new Map()).values()]).toEqual(['akismet/akismet.php', 'café/café.php']);
    expect([...(phpArray(serKeys(['wandworks-sso/sso.php'])) ?? new Map()).keys()]).toEqual(['wandworks-sso/sso.php']);
    expect(phpArray('a:2:{i:0;a:1:{i:0;s:1:"x";}i:1;s:1:"y";}')?.get(1)).toBe('y');
    expect(phpArray('O:8:"stdClass":0:{}')).toBeNull();
    expect(phpArray('a:1:{i:0;s:99:"short";}')).toBeNull();
    expect(phpArray('twentytwentyfive')).toBeNull();
  });

  it('reads mysql batch output with its escapes', () => {
    expect(batchRows('1\tactive_plugins\ta:0:{}\n2\tstylesheet\tone\\ttwo\n')).toEqual([['1', 'active_plugins', 'a:0:{}'], ['2', 'stylesheet', 'one\ttwo']]);
  });
});

describe('scanning for missing plugins and themes', () => {
  function network() {
    const t = wpSiteTree({ multisite: true });
    mkdirSync(join(t.docroot, 'wp-content/plugins/akismet'), { recursive: true });
    mkdirSync(join(t.docroot, 'wp-content/themes/twentytwentyfive'), { recursive: true });
    const b = base(t.docroot);
    const queries: string[] = [];
    const query = (call: FakeCall) => {
      const sql = call.args[4] as string;
      queries.push(sql);
      if (sql.includes('information_schema')) return { stdout: 't\twp_options\nt\twp_2_options\nt\twp_3_options\nb\t1\nb\t2\nb\t4\n' };
      if (sql.includes('wp_sitemeta')) return { stdout: `0\tactive_sitewide_plugins\t${serKeys(['wandworks-sso/sso.php'])}\n` };
      return {
        stdout: [
          `1\tactive_plugins\t${ser(['akismet/akismet.php', 'redirection/redirection.php'])}`,
          '1\tstylesheet\twandworks',
          '1\ttemplate\twandworks-parent',
          `2\tactive_plugins\t${ser(['redirection/redirection.php', '../../etc/x.php'])}`,
          `2\trecently_activated\t${serKeys(['hello.php'])}`,
          '2\tstylesheet\ttwentytwentyfive',
          '2\ttemplate\ttwentytwentyfive',
        ].join('\n'),
      };
    };
    const fake = fakeExec({
      [`${b} db query`]: query,
      [`${b} transient get update_plugins --network`]: { stdout: JSON.stringify({ checked: { 'redirection/redirection.php': '5.5.1', 'hello.php': '1.7.2', 'akismet/akismet.php': '5.3' }, no_update: { 'hello.php': { slug: 'hello-dolly' } } }) },
      [`${b} transient get update_themes --network`]: { stdout: JSON.stringify({ checked: { 'wandworks-parent': '1.4.0', wandworks: '2.1.0' } }) },
    });
    return { t, fake, queries };
  }

  it('reads every site of a network in one query, with network-wide plugins and production\'s versions, and only sites whose tables are there', async () => {
    const { t, fake, queries } = network();
    const steps: string[] = [];
    const found = await scanMissing(fake.exec, siteFor(t.config, 'local.shop.com'), (step) => steps.push(step));
    expect(found.plugins).toEqual([
      { file: 'redirection/redirection.php', active: true, sites: 2, version: '5.5.1' },
      { file: 'wandworks-sso/sso.php', active: true, network: true },
      { file: 'hello.php', active: false, version: '1.7.2', slug: 'hello-dolly' },
    ]);
    expect(found.themes).toEqual([{ name: 'wandworks', sites: 1, version: '2.1.0' }, { name: 'wandworks-parent', parent: true, version: '1.4.0' }]);
    // Site 4 has no tables and site 3 is no longer in wp_blogs: neither is read.
    const options = queries.find((q) => q.includes('option_name IN')) as string;
    expect(options).toContain('FROM `wp_options`');
    expect(options).toContain('FROM `wp_2_options`');
    expect(options).not.toContain('wp_3_options');
    expect(options).not.toContain('wp_4_options');
    // One WP-CLI run per query, never one per site.
    expect(fake.calls.filter((c) => c.args.includes('option'))).toEqual([]);
    expect(steps).toContain('Reading the plugins and themes of 2 sites');
  });

  it('keeps the result for a while, scans again when asked, goes on without a request, and forgets it after a job', async () => {
    const { t, fake } = network();
    const store = new RunStore(':memory:');
    let now = Date.parse('2026-11-11T10:00:00Z');
    const scans = new MissingScans(store, fake.exec, () => now);
    const ref = () => siteFor(t.config, 'local.shop.com');
    const first = scans.state('local.shop.com', ref);
    expect(first.running?.step).toBeDefined();
    expect(first.scan).toBeUndefined();
    await scans.settled('local.shop.com');
    const kept = scans.state('local.shop.com', ref);
    expect(kept.running).toBeUndefined();
    expect(kept.scan?.plugins).toHaveLength(3);
    const runs = () => fake.calls.filter((c) => c.args.includes('information_schema') || (c.args[4] ?? '').includes('information_schema')).length;
    expect(runs()).toBe(1);
    now += MISSING_SCAN_MS - 1000;
    scans.state('local.shop.com', ref);
    expect(runs()).toBe(1);
    expect(scans.state('local.shop.com', ref, 'force').running).toBeDefined();
    await scans.settled('local.shop.com');
    expect(runs()).toBe(2);
    scans.forget('local.shop.com');
    expect(scans.kept('local.shop.com')).toBeUndefined();
    // The Overview only peeks: nothing starts.
    expect(scans.state('local.shop.com', ref, 'peek')).toEqual({});
    expect(runs()).toBe(2);
  });

  it('says why a scan failed and does not start another on its own', async () => {
    const t = wpSiteTree();
    const fake = fakeExec({ [`${base(t.docroot)} db query`]: { code: 1, stderr: 'ERROR 1045 (28000): Access denied' } });
    const scans = new MissingScans(new RunStore(':memory:'), fake.exec);
    scans.state('local.shop.com', () => siteFor(t.config, 'local.shop.com'));
    await scans.settled('local.shop.com');
    expect(scans.state('local.shop.com', () => siteFor(t.config, 'local.shop.com')).error).toMatch(/Access denied/);
    expect(fake.calls.filter((c) => c.args.includes('query'))).toHaveLength(1);
  });
});

import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { actions, profileGroup } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { deleteProfiles, listProfiles, parseCachegrind, parseProfileName, profileFile, profileSummary } from '../src/profiles.js';
import { tempTree } from './helpers.js';

const WP = '/var/www/local.acme.com';

/**
 * A request as Xdebug 3 writes it, in 10 ns units: {main} (2 ms of its own)
 * calls the theme's acme_prices() 3 times (8 ms in all, 2 ms its own), which
 * calls PHP's strlen (6 ms in all) and WooCommerce's wc_get_price (no time).
 */
const CACHEGRIND = `version: 1
creator: xdebug 3.3.2 (PHP 8.3.6)
cmd: ${WP}/index.php
part: 1
positions: line

events: Time_(10ns) Memory_(bytes)

fl=(1) php:internal
fn=(1) php::strlen
1 600000 0

fl=(2) ${WP}/wp-content/plugins/woocommerce/includes/wc-core-functions.php
fn=(2) wc_get_price
10 0 64

fl=(3) ${WP}/wp-content/themes/acme/functions.php
fn=(3) acme_prices
20 200000 128
cfl=(1)
cfn=(1)
calls=3000 0 0
21 600000 0
cfl=(2)
cfn=(2)
calls=3 0 0
22 0 64

fl=(4) ${WP}/index.php
fn=(4) {main}
1 200000 2048
cfl=(3)
cfn=(3)
calls=3 0 0
5 800000 192

summary: 1000000 4194304

`;

const NAME = 'cachegrind.out.1794045600_250000.local.acme.com_shop_XDEBUG_PROFILE=1';

function setup() {
  const tree = tempTree();
  const dir = join(tree.config.STATE_DIR, 'profiles', '8.3');
  mkdirSync(dir, { recursive: true });
  const data = join(tree.root, 'data');
  return { tree, dir, data, config: tree.config };
}

describe('parseCachegrind', () => {
  it("gives each function its own time and its time with what it calls, and time by plugin and theme", async () => {
    const s = await parseCachegrind(Readable.from([CACHEGRIND]));
    expect(s.script).toBe(`${WP}/index.php`);
    expect(s.totalMs).toBe(10);
    expect(s.peakBytes).toBe(4194304);
    expect(s.functionCount).toBe(4);
    expect(s.functions.map((f) => [f.name, f.group, f.calls, f.selfMs, f.totalMs])).toEqual([
      ['php::strlen', 'theme acme', 3000, 6, 6],
      ['acme_prices', 'theme acme', 3, 2, 8],
      ['{main}', 'WordPress', 1, 2, 10],
      ['wc_get_price', 'plugin woocommerce', 3, 0, 0],
    ]);
    expect(s.functions[0]?.callers).toEqual([{ name: 'acme_prices', calls: 3000 }]);
    // PHP's own strlen counts with the theme that calls it.
    expect(s.groups).toEqual([
      { group: 'theme acme', selfMs: 8 },
      { group: 'WordPress', selfMs: 2 },
    ]);
  });

  it('reads microseconds from an older Xdebug', async () => {
    const s = await parseCachegrind(Readable.from(['events: Time_(µs) Memory_(bytes)\n\nfl=(1) /x.php\nfn=(1) {main}\n1 2500 0\n']));
    expect(s.totalMs).toBe(2.5);
  });
});

describe('profile names and groups', () => {
  it("reads the time, host and request from Xdebug's name", () => {
    expect(parseProfileName('8.3', `${NAME}.gz`)).toEqual({ version: '8.3', name: `${NAME}.gz`, at: '2026-11-07T10:00:00.250Z', host: 'local.acme.com', request: '/shop_XDEBUG_PROFILE=1' });
    expect(parseProfileName('8.3', 'cachegrind.out.12345')).toBeNull();
    // Xdebug 3.5: a dot in the time, and the host's dots as _ run into the request.
    const known = ['local.acme.com', 'local.acme.com.au', 'www.local.acme.com'];
    expect(parseProfileName('8.4', 'cachegrind.out.1794045600.250000.local_acme_com__XDEBUG_PROFILE=1.gz', known)).toMatchObject({ at: '2026-11-07T10:00:00.250Z', host: 'local.acme.com', request: '/_XDEBUG_PROFILE=1' });
    expect(parseProfileName('8.4', 'cachegrind.out.1794045600.250000.local_acme_com_au_shop__XDEBUG_PROFILE=1.gz', known)).toMatchObject({ host: 'local.acme.com.au', request: '/shop__XDEBUG_PROFILE=1' });
    expect(parseProfileName('8.4', 'cachegrind.out.1794045600.250000.local_acme_com_wp-admin_admin-ajax_php.gz', known)).toMatchObject({ host: 'local.acme.com', request: '/wp-admin_admin-ajax_php' });
    expect(parseProfileName('8.3', 'notes.txt')).toBeNull();
  });

  it('puts a file with its plugin, theme, must-use plugin or WordPress', () => {
    expect(profileGroup('/var/www/x/wp-content/plugins/acme-forms/acme-forms.php')).toBe('plugin acme-forms');
    expect(profileGroup('/var/www/x/wp-content/plugins/hello.php')).toBe('plugin hello');
    expect(profileGroup('/var/www/x/wp-content/mu-plugins/devmagic-panel-local.php')).toBe('mu-plugin devmagic-panel-local');
    expect(profileGroup('/var/www/x/wp-includes/plugin.php')).toBe('WordPress');
    expect(profileGroup('/var/www/x/wp-settings.php')).toBe('WordPress');
    expect(profileGroup('php:internal')).toBe('PHP');
    expect(profileGroup('/var/www/x/vendor/acme/lib.php')).toBe('vendor');
  });
});

describe('the profiles of a site', () => {
  it("lists a site's profiles by its hosts and path, newest first, and deletes old ones", () => {
    const { dir, data, config } = setup();
    writeFileSync(join(dir, NAME), CACHEGRIND);
    writeFileSync(join(dir, 'cachegrind.out.1794045000_1.local.shop.com_'), CACHEGRIND);
    writeFileSync(join(dir, 'cachegrind.out.1794045700_1.local.acme.com_learn_wp-admin_'), CACHEGRIND);
    const old = join(dir, 'cachegrind.out.1793500000_1.local.acme.com_');
    writeFileSync(old, CACHEGRIND);
    utimesSync(old, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    const oldStats = join(dir, 'gcstats.1793500000.1.local_acme_com_');
    writeFileSync(oldStats, 'x');
    utimesSync(oldStats, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    writeFileSync(join(dir, 'trace.1794045000.1.local_acme_com_.xt'), 'x');
    const now = new Date('2026-11-07T12:00:00Z').getTime();
    const acme = listProfiles(config, data, ['local.acme.com', 'www.local.acme.com'], '', now);
    expect(acme.versions).toEqual(['8.3']);
    expect(acme.profiles.map((p) => p.request)).toEqual(['/learn_wp-admin_', '/shop_XDEBUG_PROFILE=1']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldStats)).toBe(false);
    expect(existsSync(join(dir, 'trace.1794045000.1.local_acme_com_.xt'))).toBe(true);
    expect(existsSync(join(dir, 'unrelated.txt'))).toBe(true);
    expect(listProfiles(config, data, ['local.acme.com'], '/learn', now).profiles.map((p) => p.request)).toEqual(['/learn_wp-admin_']);
    expect(listProfiles(config, data, [], '', now).profiles).toHaveLength(3);
  });

  it("lists Xdebug 3.5's names under their site, never a longer host's", () => {
    const { dir, data, config } = setup();
    writeFileSync(join(dir, 'cachegrind.out.1794045600.250000.local_acme_com__XDEBUG_PROFILE=1.gz'), gzipSync(CACHEGRIND));
    writeFileSync(join(dir, 'cachegrind.out.1794045700.1.local_acme_com_learn_wp-admin_.gz'), gzipSync(CACHEGRIND));
    writeFileSync(join(dir, 'cachegrind.out.1794045800.1.local_acme_com_au__XDEBUG_PROFILE=1.gz'), gzipSync(CACHEGRIND));
    const now = new Date('2026-11-07T12:00:00Z').getTime();
    const known = ['local.acme.com', 'local.acme.com.au'];
    expect(listProfiles(config, data, ['local.acme.com'], '', now, known).profiles.map((p) => p.request)).toEqual(['/learn_wp-admin_', '/_XDEBUG_PROFILE=1']);
    expect(listProfiles(config, data, ['local.acme.com'], '/learn', now, known).profiles).toHaveLength(1);
    expect(listProfiles(config, data, ['local.acme.com.au'], '', now, known).profiles.map((p) => p.host)).toEqual(['local.acme.com.au']);
  });

  it('reads a gzipped profile once and keeps its summary for the list', async () => {
    const { dir, data, config } = setup();
    writeFileSync(join(dir, `${NAME}.gz`), gzipSync(CACHEGRIND));
    const s = await profileSummary(config, data, '8.3', `${NAME}.gz`);
    expect(s).toMatchObject({ host: 'local.acme.com', totalMs: 10, functionCount: 4 });
    expect(listProfiles(config, data, ['local.acme.com'], '', new Date('2026-11-07T12:00:00Z').getTime()).profiles[0]).toMatchObject({ totalMs: 10, peakBytes: 4194304 });
    expect(existsSync(join(data, 'profiles', `8.3-${NAME}.json`))).toBe(true);
  });

  it('refuses a version or a name that is not a profile, so no other file is read', () => {
    const { config } = setup();
    expect(() => profileFile(config, '../8.3', NAME)).toThrow(/PHP version/);
    expect(() => profileFile(config, '8.3', '../../secrets.json')).toThrow(/profile name/);
    expect(() => profileFile(config, '8.3', NAME)).toThrow(/No profile/);
  });

  it('deletes profiles with their summaries, through an action whose schema takes only profile names', async () => {
    const { dir, data, config } = setup();
    writeFileSync(join(dir, NAME), CACHEGRIND);
    await profileSummary(config, data, '8.3', NAME);
    expect(deleteProfiles(config, data, [{ version: '8.3', name: NAME }]).stdout).toBe('deleted 1 profile\n');
    expect(existsSync(join(dir, NAME))).toBe(false);
    expect(existsSync(join(data, 'profiles', `8.3-${NAME}.json`))).toBe(false);
    const input = actions['profile.delete'].input;
    expect(input.safeParse({ profiles: [{ version: '8.3', name: NAME }] }).success).toBe(true);
    expect(input.safeParse({ profiles: [{ version: '8.3', name: '../panel.db' }] }).success).toBe(false);
    expect(input.safeParse({ profiles: [{ version: '8', name: NAME }] }).success).toBe(false);
  });
});

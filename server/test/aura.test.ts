import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompatScan, Site } from '@devmagic-panel/shared';
import { LOCAL_MODE_DEFAULT_BLOCKED_HOSTS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { coreStatusSource, MAX_AGE_MS, type CoreStatusMap } from '../src/core-status.js';
import { hostsBlockDomains, readAura } from '../src/aura.js';
import { coreIssueFor, discoverSites } from '../src/sites/discover.js';
import { LOCAL_MODE_FILE, localModePlugin, readLocalMode, setLocalMode } from '../src/sites/local-mode.js';
import { parseVhost } from '../src/sites/vhost.js';
import { fakeExec, NO_DEBUG_CONSTANTS, tempTree, wpSiteTree } from './helpers.js';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const STATUS: CoreStatusMap = { '6.8.1': 'insecure', '6.8.3': 'outdated', '7.1.3': 'latest' };

function certResponse(cert: string, names = 'DNS:local.shop.com, DNS:local.shop.de, DNS:www.local.shop.com') {
  return {
    [`openssl x509 -in ${cert}`]: {
      stdout: `notAfter=Jan 26 09:00:00 2029 GMT\nissuer=O = devmagic-panel, CN = devmagic-panel Local CA (dev)\nX509v3 Subject Alternative Name: \n    ${names}\n`,
    },
  };
}

async function discover(t: ReturnType<typeof wpSiteTree>, exec = fakeExec(certResponse(t.cert)).exec, coreStatus: CoreStatusMap | null = null) {
  const [site] = await discoverSites({ config: t.config, exec, secrets: null, wpcoreConf: t.wpcoreConf, coreStatus, now: () => NOW });
  return site as Site;
}

describe('site health checks', () => {
  it('offer a cert reissue, a hosts line and Local mode as fixes', async () => {
    const t = wpSiteTree();
    const site = await discover(t, fakeExec(certResponse(t.cert, 'DNS:local.shop.com')).exec);
    const byId = Object.fromEntries(site.issues.map((i) => [i.id, i]));
    expect(byId['cert.uncovered']?.fix).toEqual({ action: 'cert.reissue', input: { domain: 'local.shop.com' }, label: 'Reissue cert' });
    expect(byId['hosts.missing']?.fix).toEqual({
      action: 'hosts.add',
      input: { domain: 'local.shop.com', aliases: ['local.shop.de', 'www.local.shop.com'] },
      label: 'Add to hosts',
    });
    expect(byId['local.off']?.fix).toEqual({ action: 'site.setLocalMode', input: { domain: 'local.shop.com', enabled: true }, label: 'Turn on Local mode' });
    expect(site.localMode).toEqual({ enabled: false, current: true, blockedHosts: [] });
  });

  it('give a hint instead of a fix when the vhost loads a cert dmp-root does not manage', async () => {
    const t = wpSiteTree();
    const file = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(file, readFileSync(file, 'utf8').replace(t.cert, '/etc/ssl/other/shop.crt'));
    const site = await discover(t, fakeExec(certResponse('/etc/ssl/other/shop.crt', 'DNS:local.shop.com')).exec);
    const issue = site.issues.find((i) => i.id === 'cert.uncovered');
    expect(issue?.fix).toBeUndefined();
    expect(issue?.hint).toContain('/etc/ssl/other/shop.crt');
  });

  it('flag names served on one port only', async () => {
    const t = wpSiteTree();
    const file = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(
      file,
      `<VirtualHost *:80>\n ServerName local.shop.com\n ServerAlias local.shop.de local.wishlist.com\n</VirtualHost>\n${readFileSync(file, 'utf8')}`,
    );
    const drift = (await discover(t)).issues.find((i) => i.id === 'vhost.portDrift');
    expect(drift?.text).toBe(
      'Port 80 and 443 names differ: local.wishlist.com only on port 80 (no HTTPS); www.local.shop.com only on port 443 (no redirect from http)',
    );
    expect(drift?.fix).toBeUndefined();
    expect(drift?.hint).toContain('leaves this vhost as is');
  });

  it('flag an outdated plugin file and offer to rewrite it with the same hosts', async () => {
    const t = wpSiteTree();
    const fake = fakeExec(certResponse(t.cert));
    await setLocalMode(fake.exec, t.docroot, true, ['api.sendgrid.com']);
    const file = join(t.docroot, 'wp-content/mu-plugins', LOCAL_MODE_FILE);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Version: 4', 'Version: 3'));
    const issue = (await discover(t, fake.exec)).issues.find((i) => i.id === 'local.outdated');
    expect(issue?.fix?.input).toEqual({ domain: 'local.shop.com', enabled: true, blockedHosts: ['api.sendgrid.com'] });
  });
});

describe('coreIssueFor', () => {
  const installed = ['7.1.3', '6.8.3'];

  it('fails an insecure shared core and offers the newest safe installed core', () => {
    expect(coreIssueFor('local.a.test', { kind: 'wpcore', version: '6.8.1' }, installed, STATUS)).toEqual({
      id: 'core.insecure',
      status: 'fail',
      text: 'WordPress 6.8.1 has known security issues (latest is 7.1.3)',
      fix: { action: 'core.switch', input: { domain: 'local.a.test', version: '7.1.3' }, label: 'Switch to 7.1.3' },
    });
  });

  it('only hints for a site with its own copy of WordPress', () => {
    const issue = coreIssueFor('local.a.test', { kind: 'standalone', version: '6.8.3' }, installed, STATUS);
    expect(issue).toMatchObject({ id: 'core.outdated', status: 'warn', hint: 'This site has its own copy of WordPress: update it with wp core update.' });
    expect(issue?.fix).toBeUndefined();
  });

  it('suggests installing the latest core when no better one is installed', () => {
    const issue = coreIssueFor('local.a.test', { kind: 'wpcore', version: '6.8.3' }, ['6.8.3'], STATUS);
    expect(issue?.hint).toBe('Add WordPress 7.1.3 on the WordPress page, then switch this site to it.');
  });

  it('is quiet for the latest core and compares installed cores offline', () => {
    expect(coreIssueFor('local.a.test', { kind: 'wpcore', version: '7.1.3' }, installed, STATUS)).toBeNull();
    expect(coreIssueFor('local.a.test', { kind: 'wpcore', version: '6.8.3' }, installed, null)).toMatchObject({
      id: 'core.outdated',
      text: 'WordPress 6.8.3 is older than the newest installed core (7.1.3)',
    });
  });
});

describe('Local mode plugin', () => {
  it('writes the plugin with the default hosts and keeps it out of git', async () => {
    const t = wpSiteTree();
    const muDir = join(t.docroot, 'wp-content/mu-plugins');
    mkdirSync(join(t.docroot, '.git/info'), { recursive: true });
    const { exec } = fakeExec({
      [`git -C ${muDir} rev-parse --show-toplevel`]: { stdout: `${t.docroot}\n` },
      [`git -C ${t.docroot} rev-parse --git-path info/exclude`]: { stdout: '.git/info/exclude\n' },
    });
    const result = await setLocalMode(exec, t.docroot, true);
    expect(result.code).toBe(0);
    const text = readFileSync(join(muDir, LOCAL_MODE_FILE), 'utf8');
    expect(text).toContain("'api.sendgrid.com', 'mailgun.net'");
    // Mailchimp's API, which mailchimp-for-wp reaches at <dc>.api.mailchimp.com: the subdomain rule covers every account.
    expect(text).toContain("'api.mailchimp.com'");
    expect(text).toContain("$phpmailer->Port        = 1025;");
    expect(text).toContain("preg_match( '/^(www\\.)?local\\.|\\.test$|\\.localhost$/', $dmp_local_host )");
    expect(readFileSync(join(t.docroot, '.git/info/exclude'), 'utf8')).toContain(`/wp-content/mu-plugins/${LOCAL_MODE_FILE}`);
    expect(readLocalMode(t.docroot)).toEqual({ enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] });
  });

  it('keeps the chosen hosts when turned on again and removes the file when off', async () => {
    const t = wpSiteTree();
    const { exec } = fakeExec();
    await setLocalMode(exec, t.docroot, true, ['api.hubapi.com', 'api.hubapi.com']);
    await setLocalMode(exec, t.docroot, true);
    expect(readLocalMode(t.docroot).blockedHosts).toEqual(['api.hubapi.com']);
    await setLocalMode(exec, t.docroot, false);
    expect(readLocalMode(t.docroot).enabled).toBe(false);
  });

  it('makes a long My Sites menu scroll, keeps its side menus in view and adds a filter, on a network only', () => {
    const text = localModePlugin([]);
    const block = text.slice(text.indexOf('if ( is_multisite() ) {'));
    expect(block).toContain("#wpadminbar #wp-admin-bar-my-sites > .ab-sub-wrapper { max-height: calc(100vh - var(--wp-admin--admin-bar--height, 32px)); overflow-y: auto;");
    // The side menu of a row opens fixed beside it, so the scrolling list does not cut it off.
    expect(block).toContain("sub.style.position = 'fixed';");
    expect(block).toContain("document.getElementById( 'wp-admin-bar-my-sites-list' )");
    expect(block).toContain("if ( items.length < 10 ) {");
    expect(block).toContain("input.placeholder = 'Filter ' + items.length + ' sites';");
    expect(block).toContain("add_action( 'admin_head', $dmp_my_sites );");
    // After the check that the site's own address is local, like everything else it does.
    expect(text.indexOf('if ( is_multisite() ) {')).toBeGreaterThan(text.indexOf("if ( ! preg_match( '/^(www"));
    expect(text).toContain(' * Version: 4');
  });

  it('refuses anything but a hostname inside the PHP file', () => {
    expect(() => localModePlugin(["x.com'); system('id"])).toThrow(/not a hostname/);
  });
});

describe('readAura', () => {
  const site = (domain: string, extra: Partial<Site> = {}): Site => ({
    domain, aliases: [], docroot: `/var/www/${domain}`, vhostManaged: false, server: 'apache', removable: false, panelMade: false, core: { kind: 'none' },
    debug: { enabled: false, logBytes: 0, constants: NO_DEBUG_CONSTANTS }, health: 'ok', issues: [], ...extra,
  });

  it('lists site issues failures first and finds hosts lines no site uses', async () => {
    const t = tempTree();
    writeFileSync(
      t.config.HOSTS_FILE,
      '127.0.0.1 localhost\n127.0.0.1 local.gone.com\n# BEGIN devmagic-panel (managed by the panel, edit sites there)\n127.0.0.1 local.a.com www.local.a.com\n127.0.0.1 local.gone.test\n# END devmagic-panel\n',
    );
    const sites = [
      site('local.a.com', { issues: [{ id: 'cert.legacy', status: 'warn', text: 'old CA' }, { id: 'php.fatals', status: 'fail', text: 'fatals' }] }),
    ];
    const report = await readAura({ config: t.config, exec: fakeExec().exec, now: () => NOW }, sites);
    expect(report.items.map((i) => [i.id, i.domain])).toEqual([
      ['php.fatals', 'local.a.com'],
      ['cert.legacy', 'local.a.com'],
      ['hosts.stale', undefined],
    ]);
    expect(report.items[2]?.fix).toEqual({ action: 'hosts.remove', input: { domain: 'local.gone.test' }, label: 'Remove the line' });
  });

  it('flags a site whose last compatibility check of the PHP it runs found errors, and no other version', async () => {
    const t = tempTree();
    const scan = (version: string, errors: number) => ({ version, errors, components: [{ title: 'Wandworks Forms', errors }, { title: 'Wandworks', errors: 0 }] });
    const scans: Record<string, unknown[]> = {
      'local.a.com': [scan('8.4', 3), scan('8.3', 0)],
      'local.b.com@learn': [scan('8.3', 2)],
      'local.c.com': [scan('8.4', 5)],
    };
    const sites = [
      site('local.a.com', { php: { version: '8.4', own: true } }),
      site('local.b.com', { path: '/learn', php: { version: '8.3', own: false } }),
      site('local.c.com', { php: { version: '8.3', own: false } }),
    ];
    const report = await readAura({ config: t.config, exec: fakeExec().exec, compatScans: (key) => (scans[key] ?? []) as CompatScan[] }, sites);
    expect(report.items.map((i) => [i.id, i.domain, i.path, i.text])).toEqual([
      ['php.compat', 'local.a.com', undefined, 'The last compatibility check against PHP 8.4, which it runs, found 3 errors in Wandworks Forms'],
      ['php.compat', 'local.b.com', '/learn', 'The last compatibility check against PHP 8.3, which it runs, found 2 errors in Wandworks Forms'],
    ]);
  });

  it('asks for each local constant from Settings a WordPress site lacks or sets another way, with a fix', async () => {
    const t = tempTree();
    const sites = [
      site('local.a.com', { constants: [{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }, { name: 'WANDWORKS_DEV', value: false }] }),
      site('local.b.com', { path: '/learn', constants: [] }),
      site('local.c.com'),
    ];
    const report = await readAura({ config: t.config, exec: fakeExec().exec, localConstants: [{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }, { name: 'WANDWORKS_DEV', value: true }] }, sites);
    expect(report.items.map((i) => [i.domain, i.path, i.text])).toEqual([
      ['local.a.com', undefined, 'wp-config.php sets WANDWORKS_DEV to false, not true as Settings asks'],
      ['local.b.com', '/learn', "wp-config.php has no WP_ENVIRONMENT_TYPE, which every local site should set to 'local'"],
      ['local.b.com', '/learn', 'wp-config.php has no WANDWORKS_DEV, which every local site should set to true'],
    ]);
    expect(report.items[0]?.fix).toEqual({ action: 'site.setConstant', input: { domain: 'local.a.com', name: 'WANDWORKS_DEV', value: true }, label: 'Set WANDWORKS_DEV' });
  });

  it('warns when sites use Local mode and Mailpit is not listening', async () => {
    const t = tempTree();
    const sites = [site('local.a.com', { localMode: { enabled: true, current: true, blockedHosts: [] } })];
    const down = await readAura({ config: t.config, exec: fakeExec({ 'ss -ltnH': { stdout: 'LISTEN 0 511 *:80 *:*\n' } }).exec }, sites);
    expect(down.items.map((i) => i.id)).toEqual(['mailpit.down']);
    const up = await readAura({ config: t.config, exec: fakeExec({ 'ss -ltnH': { stdout: 'LISTEN 0 4096 127.0.0.1:1025 0.0.0.0:*\n' } }).exec }, sites);
    expect(up.items).toEqual([]);
  });

  it('reads only the lines inside the panel block', () => {
    expect(hostsBlockDomains('127.0.0.1 local.x.com\n# BEGIN devmagic-panel (managed by the panel, edit sites there)\n127.0.0.1 local.y.com a\n# note\n# END devmagic-panel\n')).toEqual([
      'local.y.com',
    ]);
  });
});

describe('parseVhost names per port', () => {
  it('keeps port 80 and 443 names apart', () => {
    const v = parseVhost('<VirtualHost *:80>\n ServerName a.test\n ServerAlias b.test\n</VirtualHost>\n<VirtualHost *:443>\n ServerName a.test\n</VirtualHost>\n', '/x.conf', '/log');
    expect(v.byPort).toEqual({ http: ['a.test', 'b.test'], https: ['a.test'] });
  });
});

describe('coreStatusSource', () => {
  it('fetches once, keeps a copy and drops entries it does not understand', async () => {
    const t = tempTree();
    const file = join(t.root, 'status.json');
    let calls = 0;
    const source = coreStatusSource(file, async () => {
      calls++;
      return { '7.1.3': 'latest', '6.8.1': 'insecure', junk: 'latest', '1.0': 'broken' };
    });
    expect(await source()).toEqual({ '7.1.3': 'latest', '6.8.1': 'insecure' });
    expect(await source()).toEqual({ '7.1.3': 'latest', '6.8.1': 'insecure' });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '7.1.3': 'latest', '6.8.1': 'insecure' });
  });

  it('asks again when the copy is over an hour old, or when asked fresh, and keeps the copy offline', async () => {
    const t = tempTree();
    const file = join(t.root, 'status.json');
    let answer: unknown = { '7.1.3': 'latest' };
    const source = coreStatusSource(file, async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    expect(await source()).toEqual({ '7.1.3': 'latest' });
    // A security release came out: the copy still answers within the hour, a fresh check does not.
    answer = { '7.1.3': 'insecure', '7.1.4': 'latest' };
    expect(await source()).toEqual({ '7.1.3': 'latest' });
    expect(await source({ fresh: true })).toEqual({ '7.1.3': 'insecure', '7.1.4': 'latest' });
    answer = { '7.1.4': 'insecure', '7.1.5': 'latest' };
    const old = new Date(Date.now() - MAX_AGE_MS - 1000);
    utimesSync(file, old, old);
    expect(await source()).toEqual({ '7.1.4': 'insecure', '7.1.5': 'latest' });
    answer = new Error('offline');
    expect(await source({ fresh: true })).toEqual({ '7.1.4': 'insecure', '7.1.5': 'latest' });
  });

  it('answers null offline without a copy', async () => {
    const t = tempTree();
    const source = coreStatusSource(join(t.root, 'status.json'), async () => {
      throw new Error('offline');
    });
    expect(await source()).toBeNull();
  });
});

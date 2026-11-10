import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSites, findSiteRepos, folderTime, parseCertText } from '../src/sites/discover.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import type { Secrets } from '../src/secrets.js';
import { fakeExec, tempTree } from './helpers.js';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'pw' } };

function siteTree(options: { multisite?: boolean; dbName?: string } = {}) {
  const tree = tempTree();
  const { root, config } = tree;
  const docroot = join(config.WEB_DIR, 'local.shop.com');
  mkdirSync(join(docroot, 'wp-content'), { recursive: true });
  mkdirSync(join(docroot, '.git'));
  mkdirSync(join(root, 'wp-cores/7.1.3/wp-includes'), { recursive: true });
  mkdirSync(join(root, 'wp-cores/6.8.3'), { recursive: true });
  symlinkSync(join(root, 'wp-cores/7.1.3/wp-includes'), join(docroot, 'wp-includes'));
  writeFileSync(join(root, 'wpcore.conf'), `CORES_DIR="${join(root, 'wp-cores')}"\n`);
  writeFileSync(
    join(docroot, 'wp-config.php'),
    `<?php\ndefine('DB_NAME', '${options.dbName ?? 'shop_com'}');\n$table_prefix = 'wp_';\ndefine('WP_DEBUG', true);\n${options.multisite ? "define('MULTISITE', true);\n" : ''}`,
  );
  writeFileSync(
    join(docroot, 'wp-content/debug.log'),
    '[24-Oct-2026 08:30:00 UTC] PHP Fatal error:  Uncaught Error: x\n[24-Oct-2026 06:00:00 UTC] PHP Fatal error:  old one\n',
  );
  const cert = join(config.CERTS_DIR, 'local.shop.com/local.shop.com.crt');
  writeFileSync(
    join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'),
    `${VHOST_MARKER}\n<VirtualHost *:443>\n ServerName local.shop.com\n ServerAlias local.shop.de www.local.shop.com\n DocumentRoot ${docroot}\n SSLCertificateFile ${cert}\n</VirtualHost>\n`,
  );
  symlinkSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), join(config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
  writeFileSync(join(config.APACHE_SITES_ENABLED, '000-default.conf'), 'ServerName localhost\nDocumentRoot /var/www/html\n');
  writeFileSync(config.HOSTS_FILE, '127.0.0.1 localhost local.shop.com local.shop.de\n');
  return { ...tree, docroot, cert };
}

function responses(docroot: string, cert: string) {
  const git = `git -C ${docroot}`;
  return {
    [`openssl x509 -in ${cert}`]: {
      stdout: 'notAfter=Jan 26 09:00:00 2029 GMT\nissuer=O = devmagic-panel, CN = devmagic-panel Local CA (dev)\nX509v3 Subject Alternative Name: \n    DNS:local.shop.com, DNS:local.shop.de\n',
    },
    [`${git} rev-parse --abbrev-ref HEAD`]: { stdout: 'feature/cart\n' },
    [`${git} remote get-url origin`]: { stdout: 'git@github.com:WandworksCo/shop.git\n' },
    [`${git} rev-parse --abbrev-ref @{upstream}`]: { stdout: 'origin/feature/cart\n' },
    [`${git} rev-list --left-right --count @{upstream}...HEAD`]: { stdout: '1\t3\n' },
    [`${git} status --porcelain`]: { stdout: ' M a.php\n?? b.php\n' },
    [`${git} log -1`]: { stdout: 'abc1234\x1fAdd cart\x1fDev\x1f2026-10-24T08:00:00+00:00\n' },
    'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT table_schema,': { stdout: 'shop_com\t1048576\t12\nother\t1\t1\n' },
    "mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT option_value FROM `shop_com`.`wp_options`": { stdout: 'Shop\n' },
    'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT blog_id,': { stdout: '1\tlocal.shop.com\t/\n2\tlocal.shop.com\t/de/\n' },
    // No domain mapping plugin: its table is not there.
    'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT blog_id, domain FROM `shop_com`.`wp_domain_mapping`': { code: 1, stderr: "ERROR 1146 (42S02): Table 'shop_com.wp_domain_mapping' doesn't exist" },
    'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT 1, CONVERT(option_value USING utf8mb4)': { stdout: '1\tShop\n2\tShop DE\n' },
  };
}

describe('discoverSites', () => {
  it('lists the repos inside a site, a theme on GitLab next to the site\'s own, and leaves one git refuses out', async () => {
    const t = siteTree();
    mkdirSync(join(t.docroot, 'wp-content/themes/wandworks/.git'), { recursive: true });
    mkdirSync(join(t.docroot, 'wp-content/plugins/broken/.git'), { recursive: true });
    const theme = `git -C ${join(t.docroot, 'wp-content/themes/wandworks')}`;
    const { exec } = fakeExec({
      ...responses(t.docroot, t.cert),
      [`${theme} rev-parse --abbrev-ref HEAD`]: { stdout: 'main\n' },
      [`${theme} remote get-url origin`]: { stdout: 'git@gitlab.com:wandworks/web/wandworks-theme.git\n' },
      [`${theme} rev-parse --abbrev-ref @{upstream}`]: { stdout: 'origin/main\n' },
      [`${theme} rev-list --left-right --count @{upstream}...HEAD`]: { stdout: '2\t0\n' },
      [`${theme} status --porcelain`]: { stdout: '' },
      [`${theme} log -1`]: { stdout: 'def5678\x1fHeader spacing\x1fAlex Morgan\x1f2026-10-24T08:00:00+00:00\n' },
    });
    const [site] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.git?.branch).toBe('feature/cart');
    expect(site?.repos).toEqual([
      { folder: 'wp-content/themes/wandworks', kind: 'theme', name: 'wandworks', git: { remote: 'git@gitlab.com:wandworks/web/wandworks-theme.git', branch: 'main', upstream: 'origin/main', dirty: 0, ahead: 0, behind: 2, lastCommit: { hash: 'def5678', subject: 'Header spacing', author: 'Alex Morgan', date: '2026-10-24T08:00:00+00:00' } } },
    ]);
  });

  it('builds a site from its vhost, wp-config, core, cert, git, database and log', async () => {
    const t = siteTree();
    const { exec } = fakeExec(responses(t.docroot, t.cert));
    const [site, ...rest] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(rest).toHaveLength(0);
    expect(site).toMatchObject({
      domain: 'local.shop.com',
      aliases: ['local.shop.de', 'www.local.shop.com'],
      vhostManaged: true,
      title: 'Shop',
      core: { kind: 'wpcore', version: '7.1.3' },
      cert: { issuer: 'new', names: ['local.shop.com', 'local.shop.de'] },
      notInHosts: ['www.local.shop.com'],
      git: { branch: 'feature/cart', upstream: 'origin/feature/cart', dirty: 2, ahead: 3, behind: 1, remote: 'git@github.com:WandworksCo/shop.git' },
      db: { name: 'shop_com', sizeBytes: 1048576, tables: 12 },
      debug: { enabled: true },
      health: 'fail',
    });
    expect(site?.issues.map((i) => [i.id, i.text])).toEqual([
      ['cert.uncovered', 'www.local.shop.com is not covered by the cert'],
      ['hosts.missing', 'www.local.shop.com is missing from /etc/hosts'],
      ['php.fatals', '1 PHP fatal error in the last hour'],
      ['htaccess.missing', 'No .htaccess: pretty permalinks and wp-admin links give 404s'],
      ['local.off', 'Local mode is off: this copy can email real people and call live mail APIs'],
      ['uploads.empty', 'Uploads are nearly empty and missing ones do not load from production'],
      ['wp.notWritable', 'WordPress cannot write to wp-content, so installs and updates from wp-admin fail'],
    ]);
  });

  it('counts BE Media from Production as where uploads load from when it is in the site, set and active', async () => {
    const t = siteTree();
    mkdirSync(join(t.docroot, 'wp-content/plugins/be-media-from-production'), { recursive: true });
    writeFileSync(join(t.docroot, 'wp-config.php'), `${readFileSync(join(t.docroot, 'wp-config.php'), 'utf8')}define( 'BE_MEDIA_FROM_PRODUCTION_URL', 'https://www.shop.com/' );\n`);
    const active = "mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e SELECT option_value FROM `shop_com`.`wp_options` WHERE option_name = 'active_plugins'";
    const on = fakeExec({ ...responses(t.docroot, t.cert), [active]: { stdout: 'a:1:{i:0;s:51:"be-media-from-production/be-media-from-production.php";}\n' } });
    const [site] = await discoverSites({ config: t.config, exec: on.exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.uploadsFrom).toEqual({ host: 'www.shop.com', via: 'plugin' });
    expect(site?.mediaPlugin).toEqual({ active: true, host: 'www.shop.com' });
    expect(site?.issues.map((i) => i.id)).not.toContain('uploads.empty');

    // Deactivated in the database: the warning is back.
    const off = fakeExec({ ...responses(t.docroot, t.cert), [active]: { stdout: 'a:1:{i:0;s:19:"akismet/akismet.php";}\n' } });
    const [offSite] = await discoverSites({ config: t.config, exec: off.exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(offSite?.uploadsFrom).toBeUndefined();
    expect(offSite?.mediaPlugin).toEqual({ active: false, host: 'www.shop.com' });
    expect(offSite?.issues.map((i) => i.id)).toContain('uploads.empty');
  });

  it('reads a multisite network with its sites and titles', async () => {
    const t = siteTree({ multisite: true });
    const { exec, calls } = fakeExec(responses(t.docroot, t.cert));
    const [site] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    // Titles are asked for in utf8mb4 by name: the service's locale would turn Cyrillic into question marks.
    expect(calls.filter((c) => c.file === 'mysql' && (c.args.at(-1) ?? '').includes('blogname')).every((c) => c.args.includes('--default-character-set=utf8mb4'))).toBe(true);
    expect(site?.network).toEqual({
      mode: 'subdirectory',
      type: 'subdirectory',
      sites: [
        { id: 1, url: 'https://local.shop.com/', title: 'Shop' },
        { id: 2, url: 'https://local.shop.com/de/', title: 'Shop DE' },
      ],
    });
    expect(site?.issues.map((i) => i.id)).not.toContain('network.unserved');
  });

  it('tells a subdomain network by its sites, with SUBDOMAIN_INSTALL off, takes mapped domains, and marks the hosts it does not serve', async () => {
    const t = siteTree({ multisite: true });
    const mysql = 'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e';
    const { exec } = fakeExec({
      ...responses(t.docroot, t.cert),
      [`${mysql} SELECT blog_id,`]: { stdout: '1\tlocal.shop.com\t/\n2\tlocal.shop.de\t/\n3\tlocal.shop.fr\t/\n4\tlocal.shop.com\t/it/\n' },
      // An old domain mapping plugin gives site 4 a domain of its own.
      [`${mysql} SELECT blog_id, domain FROM \`shop_com\`.\`wp_domain_mapping\``]: { stdout: '4\tLocal.Shop.IT\n' },
      [`${mysql} SELECT 1, CONVERT(option_value USING utf8mb4)`]: { stdout: '1\tShop\n2\tShop DE\n3\tShop FR\n4\tShop IT\n' },
    });
    const [site] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.network).toEqual({
      mode: 'subdirectory',
      type: 'subdomain',
      sites: [
        { id: 1, url: 'https://local.shop.com/', title: 'Shop' },
        { id: 2, url: 'https://local.shop.de/', title: 'Shop DE' },
        { id: 3, url: 'https://local.shop.fr/', title: 'Shop FR', served: false },
        { id: 4, url: 'https://local.shop.it/', title: 'Shop IT', served: false },
      ],
    });
    expect(site?.issues.find((i) => i.id === 'network.unserved')).toMatchObject({
      text: 'local.shop.fr, local.shop.it are sites of the network this site does not serve here',
      fix: { action: 'site.addAliases', input: { domain: 'local.shop.com', aliases: ['local.shop.fr', 'local.shop.it'] }, label: 'Add as aliases' },
    });
  });

  it("marks archived, spam and hidden network sites, and lists deleted ones apart without reading their tables", async () => {
    const t = siteTree({ multisite: true });
    const mysql = 'mysql --batch --skip-column-names --user root --host localhost --default-character-set=utf8mb4 -e';
    const { exec, calls } = fakeExec({
      ...responses(t.docroot, t.cert),
      // blog_id, domain, path, archived, spam, deleted, public
      [`${mysql} SELECT blog_id,`]: { stdout: '1\tlocal.shop.com\t/\t0\t0\t0\t1\n2\tlocal.shop.com\t/de/\t1\t0\t0\t1\n3\tlocal.shop.com\t/fr/\t0\t1\t0\t0\n4\tlocal.shop.com\t/it/\t0\t0\t1\t1\n' },
      [`${mysql} SELECT 1, CONVERT(option_value USING utf8mb4)`]: { stdout: '1\tShop\n2\tShop DE\n3\tShop FR\n' },
    });
    const [site] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.network?.sites).toEqual([
      { id: 1, url: 'https://local.shop.com/', title: 'Shop' },
      { id: 2, url: 'https://local.shop.com/de/', title: 'Shop DE', archived: true },
      { id: 3, url: 'https://local.shop.com/fr/', title: 'Shop FR', spam: true, hidden: true },
    ]);
    expect(site?.network?.deleted).toEqual([{ id: 4, url: 'https://local.shop.com/it/' }]);
    const titles = calls.map((c) => c.args.at(-1) as string).find((sql) => sql.includes("option_name = 'blogname'") && sql.includes('UNION ALL'));
    expect(titles).not.toContain('wp_4_options');
  });

  it('never puts an unsafe database name into SQL', async () => {
    const t = siteTree({ dbName: "x`; DROP DATABASE y; --" });
    const { exec, calls } = fakeExec(responses(t.docroot, t.cert));
    await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    // The sizes query, after the check for MySQL 8's stats cache.
    const sql = calls.filter((c) => c.file === 'mysql').map((c) => c.args.at(-1) as string);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('information_schema_stats_expiry');
    expect(sql[1]).toContain('information_schema.tables');
    expect(sql.some((q) => q.includes('DROP DATABASE'))).toBe(false);
  });

  it('works without a MySQL account and reports git trouble as an issue', async () => {
    const t = siteTree();
    const r = responses(t.docroot, t.cert);
    const { exec } = fakeExec({ ...r, [`git -C ${t.docroot} rev-parse --abbrev-ref HEAD`]: { code: 128, stderr: "fatal: detected dubious ownership in repository at '/x'\n" } });
    const [site] = await discoverSites({ config: t.config, exec, secrets: null, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.db).toEqual({ name: 'shop_com', sizeBytes: 0, tables: 0 });
    expect(site?.git).toBeUndefined();
    expect(site?.issues.map((i) => i.text)).toContain('git refuses this folder (dubious ownership)');
  });
});

describe('parseCertText', () => {
  it('reads expiry, issuer and SAN names', () => {
    expect(parseCertText('notAfter=May 23 00:00:10 2028 GMT\nissuer=O = Example Dev CA Ltd.\nX509v3 Subject Alternative Name: \n    DNS:a.test, DNS:B.test\n')).toEqual({
      expiresAt: '2028-05-23T00:00:10.000Z',
      names: ['a.test', 'b.test'],
      issuerText: 'O = Example Dev CA Ltd.',
    });
  });
});

describe('discoverSites without a database', () => {
  it('still marks a multisite from wp-config.php, with no sites listed', async () => {
    const t = siteTree({ multisite: true });
    const { exec } = fakeExec(responses(t.docroot, t.cert));
    const [site] = await discoverSites({ config: t.config, exec, secrets: null, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(site?.network).toEqual({ mode: 'subdirectory', type: 'subdirectory', sites: [] });
  });
});

describe('sites under a path', () => {
  /** The shop's vhost also serves a WordPress install at /learn and a plain folder at /docs. */
  function withLearn() {
    const t = siteTree();
    const learn = join(t.config.WEB_DIR, 'local.learn.shop.com');
    const docs = join(t.config.WEB_DIR, 'shop-docs');
    mkdirSync(join(learn, 'wp-content'), { recursive: true });
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(learn, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_learn');\n$table_prefix = 'wp_';\n");
    const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, readFileSync(vhost, 'utf8').replace('</VirtualHost>', ` Alias /learn/ ${learn}/\n Alias /docs ${docs}\n</VirtualHost>`));
    return { ...t, learn, docs };
  }

  it('shows a WordPress install under an Alias as its own site, with the parent keeping its domains and its other folders', async () => {
    const t = withLearn();
    const { exec } = fakeExec(responses(t.docroot, t.cert));
    const [shop, learn, ...rest] = await discoverSites({ config: t.config, exec, secrets, wpcoreConf: join(t.root, 'wpcore.conf'), now: () => NOW });
    expect(rest).toHaveLength(0);
    expect(shop).toMatchObject({ domain: 'local.shop.com', aliases: ['local.shop.de', 'www.local.shop.com'], mounts: [{ path: '/docs', docroot: t.docs }] });
    expect(shop?.path).toBeUndefined();
    expect(learn).toMatchObject({ domain: 'local.shop.com', path: '/learn', docroot: t.learn, aliases: [], removable: false, panelMade: false, db: { name: 'shop_learn' } });
    expect(learn?.mounts).toBeUndefined();
    expect(learn?.cert).toBeUndefined();
    // Its own issues carry the path; the vhost's (cert, hosts) stay with the parent.
    const ids = learn?.issues.map((i) => i.id) ?? [];
    expect(ids).not.toContain('cert.uncovered');
    expect(ids).not.toContain('hosts.missing');
    expect(learn?.issues.find((i) => i.id === 'local.off')?.fix?.input).toEqual({ domain: 'local.shop.com', path: '/learn', enabled: true });
  });
});

describe('when a site came here', () => {
  it("reads its folder's creation time, or its last change where the filesystem keeps none", () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-added-'));
    const at = folderTime(dir);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Math.abs(Date.parse(at as string) - Date.now())).toBeLessThan(60_000);
    expect(folderTime(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('repos inside a site', () => {
  it('finds the usual places, and the folders an install cloned into, while they are real folders with a .git', () => {
    const docroot = mkdtempSync(join(tmpdir(), 'dmp-repos-'));
    for (const dir of ['wp-content/themes/wandworks/.git', 'wp-content/plugins/blocks/.git', 'app/modules/billing/.git', 'app/gone']) mkdirSync(join(docroot, dir), { recursive: true });
    mkdirSync(join(docroot, 'elsewhere/.git'), { recursive: true });
    symlinkSync(join(docroot, 'elsewhere'), join(docroot, 'linked'));
    const found = findSiteRepos(docroot, ['app/modules/billing', 'app/gone', 'linked', '../outside', 'wp-content/plugins/blocks', '']);
    expect(found).toEqual([
      { folder: 'wp-content/themes/wandworks', kind: 'theme', name: 'wandworks' },
      { folder: 'wp-content/plugins/blocks', kind: 'plugin', name: 'blocks' },
      { folder: 'app/modules/billing', kind: 'folder', name: 'billing' },
    ]);
  });
});

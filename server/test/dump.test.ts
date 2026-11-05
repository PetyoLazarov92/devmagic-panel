import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyzeDump, ANY_HOST, emptyFacts, emptyScan, scanSql, TableHosts } from '../src/sites/dump.js';
import { currentUpload, DUMP_SCAN_VERSION, readUpload } from '../src/sites/uploads.js';
import { fakeExec } from './helpers.js';
import { setConstant, setTablePrefix } from '../src/sites/wpconfig-edit.js';

const dump = `-- MySQL dump
CREATE TABLE \`xyz_options\` (option_id bigint);
INSERT INTO \`xyz_options\` VALUES (1,'siteurl','https://www.arcade.bet','yes'),(2,'home','https://www.arcade.bet','yes'),(55,'db_version','60717','yes');
CREATE TABLE \`xyz_blogs\` (blog_id bigint);
INSERT INTO \`xyz_blogs\` VALUES (1,1,'www.arcade.bet','/','2020-01-01','2020-01-01',1,0,0,0,0,0),(2,1,'de.arcade.bet','/','2020-01-01','2020-01-01',1,0,0,0,0,0);
`;

describe('dump analysis', () => {
  it('reads prefix, URLs, db version and network domains', () => {
    const facts = emptyFacts();
    scanSql(dump, facts);
    expect(facts).toEqual({
      tablePrefix: 'xyz_',
      siteUrl: 'https://www.arcade.bet',
      home: 'https://www.arcade.bet',
      dbVersion: 60717,
      multisite: true,
      subdomainInstall: true,
      sites: [{ id: 1, domain: 'www.arcade.bet', path: '/' }, { id: 2, domain: 'de.arcade.bet', path: '/' }],
      hosts: ['www.arcade.bet', 'de.arcade.bet'],
      partial: false,
    });
  });

  it('reads the active plugins of the main site and the network, as mysqldump escapes them', () => {
    const facts = emptyFacts();
    scanSql(
      "INSERT INTO `wp_options` VALUES (33,'active_plugins','a:3:{i:0;s:19:\\\"akismet/akismet.php\\\";i:1;s:23:\\\"wp-rocket/wp-rocket.php\\\";i:2;s:9:\\\"hello.php\\\";}','yes');\n" +
        "INSERT INTO `wp_sitemeta` VALUES (5,1,'active_sitewide_plugins','a:1:{s:27:\\\"wordfence/wordfence.php\\\";i:1700000000;}');\n",
      facts,
    );
    expect(facts.activePlugins).toEqual(['akismet', 'wp-rocket', 'hello', 'wordfence']);
  });

  it('tells a subdirectory network from its paths and reads its path from the site table', () => {
    const facts = emptyFacts();
    scanSql(
      "CREATE TABLE `wp_blogs` (x int);\nINSERT INTO `wp_blogs` VALUES (1,1,'www.a.com','/','x','x',1,0,0,0,0,0),(2,1,'www.a.com','/de/','x','x',1,0,0,0,0,0);\nINSERT INTO `wp_sitemeta` VALUES (1,1,'site_name','A');\nINSERT INTO `wp_site` VALUES (1,'www.a.com','/');\n",
      facts,
    );
    expect(facts).toMatchObject({ multisite: true, subdomainInstall: false, networkPath: '/', hosts: ['www.a.com'], sites: [{ id: 1, domain: 'www.a.com', path: '/' }, { id: 2, domain: 'www.a.com', path: '/de/' }] });
  });

  it('keeps the port of an address and puts home first, even after a network listed it', () => {
    const facts = emptyFacts();
    const state = emptyScan();
    scanSql("INSERT INTO `wp_blogs` VALUES (1,1,'shop.com','/','x','x',1,0,0,0,0,0),(2,1,'deals.shop.com','/','x','x',1,0,0,0,0,0);\n", facts, state);
    scanSql("INSERT INTO `wp_options` VALUES (1,'siteurl','http://localhost:8888','yes'),(2,'home','http://deals.shop.com','yes');\n", facts, state);
    expect(facts.hosts).toEqual(['deals.shop.com', 'localhost:8888', 'shop.com']);
  });

  // As MariaDB's dump writes a network: each row on a line of its own, and the subsites' tables (wp_10_) before the main site's.
  const mariadb = `CREATE TABLE \`wp_10_options\` (x int);
INSERT INTO \`wp_10_options\` VALUES
(1,'siteurl','http://local.acme.com/outlet','yes'),
(2,'home','http://local.acme.com/outlet','yes'),
(3,'blogname','Acme Outlet','yes'),
(4,'active_plugins','a:1:{i:0;s:21:\\"outlet-only/outlet.php\\";}','yes');
CREATE TABLE \`wp_2_options\` (x int);
INSERT INTO \`wp_2_options\` VALUES
(1,'siteurl','http://local.acme.com/repairs','yes'),
(3,'blogname','Acme Repairs &amp; Rescue','yes');
CREATE TABLE \`wp_blogs\` (x int);
INSERT INTO \`wp_blogs\` VALUES
(1,1,'local.acme.com','/','x','x',1,0,0,0,0,0),
(2,1,'local.acme.com','/repairs/','x','x',1,0,0,0,0,0),
(10,1,'local.acme.com','/outlet/','x','x',1,0,0,0,0,0);
CREATE TABLE \`wp_options\` (x int);
INSERT INTO \`wp_options\` VALUES
(1,'siteurl','http://local.acme.com','yes'),
(2,'home','http://local.acme.com','yes'),
(3,'blogname','Acme','yes'),
(4,'db_version','60717','yes'),
(5,'active_plugins','a:1:{i:0;s:19:\\"akismet/akismet.php\\";}','yes');
CREATE TABLE \`wp_site\` (x int);
INSERT INTO \`wp_site\` VALUES
(1,'local.acme.com','/');
CREATE TABLE \`wp_sitemeta\` (x int);
INSERT INTO \`wp_sitemeta\` VALUES
(1,1,'subdomain_install','0'),
(2,1,'site_admins','a:1:{i:0;s:5:\\"admin\\";}');
CREATE TABLE \`wp_usermeta\` (x int);
INSERT INTO \`wp_usermeta\` VALUES
(1,1,'wp_capabilities','a:1:{s:13:\\"administrator\\";b:1;}');
CREATE TABLE \`wp_users\` (x int);
INSERT INTO \`wp_users\` VALUES
(1,'admin','$P$Bx','admin','admin@acme.com','','2020-01-01 00:00:00','',0,'admin');
CREATE TABLE \`wp_yoast_indexable\` (x int);
`;

  it("reads a network from MariaDB's dump: the main site's prefix and address, not a subsite's, its sites by name and its own setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'network.sql');
    writeFileSync(file, mariadb);
    expect(await analyzeDump(file)).toEqual({
      tablePrefix: 'wp_',
      siteUrl: 'http://local.acme.com',
      home: 'http://local.acme.com',
      dbVersion: 60717,
      multisite: true,
      subdomainInstall: false,
      networkPath: '/',
      sites: [
        { id: 1, domain: 'local.acme.com', path: '/', name: 'Acme' },
        { id: 2, domain: 'local.acme.com', path: '/repairs/', name: 'Acme Repairs & Rescue' },
        { id: 10, domain: 'local.acme.com', path: '/outlet/', name: 'Acme Outlet' },
      ],
      hosts: ['local.acme.com'],
      // The main site's plugins only: a subsite's are its own.
      activePlugins: ['akismet'],
      partial: false,
      httpHosts: ['local.acme.com'],
      // The tables the dump creates and the hosts their rows link to: search and replace leaves out the ones without.
      tableHosts: {
        wp_options: ['local.acme.com'], wp_2_options: ['local.acme.com'], wp_10_options: ['local.acme.com'],
        wp_blogs: [], wp_site: [], wp_sitemeta: [], wp_usermeta: [], wp_users: [], wp_yoast_indexable: [],
      },
      storedObjects: false,
      admins: ['admin'],
      superAdmins: ['admin'],
    });
  });

  it('finds the hosts with http links to the end of the dump, plain, JSON-escaped or escaped again in SQL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'http.sql');
    const filler = `INSERT INTO \`wp_postmeta\` VALUES ${Array.from({ length: 4000 }, (_, i) => `(${i},'k','https://www.acme.com/p/${i}')`).join(',')};\n`;
    writeFileSync(
      file,
      [
        "CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.acme.com','yes'),(2,'home','https://www.acme.com','yes'),(3,'db_version','60717','yes'),(4,'active_plugins','a:0:{}','yes');\n",
        "CREATE TABLE `wp_users` (x int);\nINSERT INTO `wp_users` VALUES (1,'admin','x','admin','a@acme.com','','2020-01-01 00:00:00','',0,'admin');\nCREATE TABLE `wp_usermeta` (x int);\nCREATE TABLE `wp_yoast` (x int);\n",
        // After the facts are in: only found by reading on.
        filler,
        "INSERT INTO `wp_posts` VALUES (1,'{\\\"url\\\":\\\"http:\\\\/\\\\/shop.acme.com\\\\/cart\\\"}'),(2,'<a href=\\\"HTTP://Blog.Acme.com:8080/x\\\">'),(3,'http:\\/\\/cdn.acme.com/a.png');\n",
      ].join(''),
    );
    const facts = await analyzeDump(file);
    expect(facts.home).toBe('https://www.acme.com');
    expect(facts.httpHosts?.sort()).toEqual(['blog.acme.com:8080', 'cdn.acme.com', 'shop.acme.com']);
  });

  it('collects http hosts, plain and escaped, and none from https or protocol-relative links', () => {
    const hosts = new Set<string>();
    const scan = new TableHosts(hosts);
    scan.add('a https://www.acme.com and //cdn.acme.com\n');
    expect([...hosts]).toEqual([]);
    scan.add('a http://local.acme.com/ b http:\\/\\/www.acme.com\\/x', true);
    expect([...hosts]).toEqual(['local.acme.com', 'www.acme.com']);
  });

  const TABLES = [
    '-- Host: localhost    Database: acme',
    'DROP TABLE IF EXISTS `wp_options`;',
    'CREATE TABLE `wp_options` (',
    '  `option_id` bigint unsigned NOT NULL',
    ');',
    "INSERT INTO `wp_options` VALUES (1,'siteurl','https://www.acme.com','yes'),(2,'x','{\\\"u\\\":\\\"https:\\\\/\\\\/cdn.acme.com\\\\/a\\\"}','no');",
    'CREATE TABLE `wp_posts` (`ID` bigint);',
    "INSERT INTO `wp_posts` VALUES (1,'How to write INSERT INTO `wp_users` VALUES in a post, see //Shop.Acme.com/help');",
    'CREATE TABLE `wp_actionscheduler_logs` (`log_id` bigint);',
    "INSERT INTO `wp_actionscheduler_logs` VALUES (1,'action complete'),(2,'retry in 5 min');",
    'CREATE TABLE IF NOT EXISTS `wp_kept` (`id` int);',
    "INSERT INTO `wp_kept` VALUES (1,'plain');",
    "INSERT INTO `wp_not_created` VALUES (1,'//www.acme.com');",
    'CREATE TABLE `wp_last` (`id` int);',
  ].join('\n');

  it('lists the hosts each table the dump creates links to, by the statement starting the line its rows are on', () => {
    const scan = new TableHosts();
    scan.add(TABLES, true);
    expect(scan.result()).toEqual({
      wp_options: ['cdn.acme.com', 'www.acme.com'],
      // Words in a row that look like a statement belong to the row; the host keeps its case.
      wp_posts: ['Shop.Acme.com'],
      wp_actionscheduler_logs: [],
      // Created at the very end: still the dump's.
      wp_last: [],
    });
  });

  it('gives the same list however the dump is cut into chunks', () => {
    const whole = new TableHosts();
    whole.add(TABLES, true);
    for (const size of [1, 3, 17, 64, 599, 600, 601, 5000]) {
      const scan = new TableHosts();
      for (let i = 0; i < TABLES.length; i += size) scan.add(TABLES.slice(i, i + size));
      scan.add('', true);
      expect(scan.result(), `chunks of ${size}`).toEqual(whole.result());
    }
  });

  it('says nothing per table when a statement names its table in a way it cannot read', () => {
    const scan = new TableHosts();
    scan.add('CREATE TABLE `wp_options` (`id` int);\nINSERT INTO acme.wp_posts VALUES (1);\n', true);
    expect(scan.result()).toBeUndefined();
  });

  it('notes a dump that makes views, triggers or routines, which an import cannot swap in, and not a table with view in its name', () => {
    const made = (sql: string) => {
      const scan = new TableHosts();
      scan.add(sql, true);
      return scan.storedObjects;
    };
    expect(made('CREATE TABLE `wp_post_views` (`view_count` int);\nINSERT INTO `wp_posts` VALUES (1,\'CREATE VIEW in a post\');\n')).toBe(false);
    expect(made('/*!50001 CREATE VIEW `wp_top` AS SELECT 1 AS `x`*/;\n')).toBe(true);
    expect(made('/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `wp_top` AS select 1 */;\n')).toBe(true);
    expect(made('DELIMITER ;;\n/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `wp_t` BEFORE INSERT ON `wp_posts` FOR EACH ROW SET @x = 1 */;;\nDELIMITER ;\n')).toBe(true);
    expect(made('CREATE DEFINER=`root`@`localhost` PROCEDURE `acme_cleanup`()\nBEGIN\nEND\n')).toBe(true);
  });

  it('counts a table with too many hosts as having every host', () => {
    const scan = new TableHosts();
    const rows = Array.from({ length: 600 }, (_, i) => `(${i},'//site${i}.acme.com')`).join(',');
    scan.add(`CREATE TABLE \`wp_links\` (x int);\nINSERT INTO \`wp_links\` VALUES ${rows};\n`, true);
    expect(scan.result()).toEqual({ wp_links: [ANY_HOST] });
  });

  it('takes the network setting over what its sites suggest, and a plugin table is not taken for the main options', () => {
    const facts = emptyFacts();
    scanSql("CREATE TABLE `wp_aaa_options` (x int);\nINSERT INTO `wp_aaa_options` VALUES (1,'mode','x');\nCREATE TABLE `wp_blogs` (x int);\nINSERT INTO `wp_blogs` VALUES (1,1,'acme.com','/','x','x',1,0,0,0,0,0),(2,1,'shop.acme.com','/','x','x',1,0,0,0,0,0);\nCREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://acme.com','yes');\nCREATE TABLE `wp_sitemeta` (x int);\nINSERT INTO `wp_sitemeta` VALUES (1,1,'subdomain_install','0');\n", facts);
    expect(facts).toMatchObject({ tablePrefix: 'wp_', siteUrl: 'https://acme.com', subdomainInstall: false });
  });

  it("takes a site's domain from a domain mapping plugin's table, and keeps its subdomain among the hosts to replace", () => {
    const facts = emptyFacts();
    scanSql(
      "CREATE TABLE `wp_blogs` (x int);\nINSERT INTO `wp_blogs` VALUES\n(1,1,'acme.com','/','x','x',1,0,0,0,0,0),\n(2,1,'cats.acme.com','/','x','x',1,0,0,0,0,0),\n(3,1,'acme.com','/old/','x','x',1,0,0,0,0,0);\n" +
        "CREATE TABLE `wp_domain_mapping` (x int);\nINSERT INTO `wp_domain_mapping` VALUES\n(1,2,'DailyCats.com',1),\n(2,3,'old-acme.com',0);\n" +
        "CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://acme.com','yes'),(2,'home','https://acme.com','yes');\n",
      facts,
    );
    expect(facts).toMatchObject({
      domainMapping: true,
      sites: [{ id: 1, domain: 'acme.com', path: '/' }, { id: 2, domain: 'dailycats.com', path: '/', mapped: true }, { id: 3, domain: 'acme.com', path: '/old/' }],
      hosts: ['acme.com', 'cats.acme.com', 'dailycats.com'],
    });
  });

  it('reads an upload again when an older scan read it, and keeps its facts after that', async () => {
    const uploads = mkdtempSync(join(tmpdir(), 'uploads-'));
    const id = '11111111-2222-4333-8444-555555555555';
    mkdirSync(join(uploads, id));
    const file = join(uploads, id, 'network.sql');
    writeFileSync(file, mariadb);
    // As the first scan left it: a subsite's prefix, and no scan version.
    writeFileSync(join(uploads, id, 'meta.json'), JSON.stringify({ id, name: 'network.sql', size: 1, file, facts: { multisite: true, tablePrefix: 'wp_10_', hosts: [], partial: false } }));
    const fresh = await currentUpload(fakeExec().exec, uploads, id);
    expect(fresh?.facts).toMatchObject({ tablePrefix: 'wp_', sites: expect.arrayContaining([expect.objectContaining({ id: 10, path: '/outlet/' })]) });
    expect(JSON.parse(readFileSync(join(uploads, id, 'meta.json'), 'utf8'))).toMatchObject({ scanVersion: DUMP_SCAN_VERSION, facts: { tablePrefix: 'wp_' }, file });
    expect(readUpload(uploads, id)?.facts.tablePrefix).toBe('wp_');
    expect(await currentUpload(fakeExec().exec, uploads, '11111111-2222-4333-8444-000000000000')).toBeNull();
  });

  it('streams a gzipped dump', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'site.sql.gz');
    writeFileSync(file, gzipSync(dump));
    expect((await analyzeDump(file)).tablePrefix).toBe('xyz_');
  });

  // As mysqldump writes them: tables in name order, the role serialized with escaped quotes.
  const site = (users: string, extra = '') => `CREATE TABLE \`wp_options\` (x int);
INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://www.acme.com','yes'),(2,'home','https://www.acme.com','yes'),(3,'db_version','60717','yes'),(4,'active_plugins','a:0:{}','yes');
${extra}CREATE TABLE \`wp_usermeta\` (x int);
INSERT INTO \`wp_usermeta\` VALUES (1,1,'wp_capabilities','a:1:{s:13:\\"administrator\\";b:1;}'),(2,2,'wp_capabilities','a:1:{s:6:\\"editor\\";b:1;}'),(3,3,'wp_capabilities','a:1:{s:13:\\"administrator\\";b:1;}'),(4,3,'wp_2_capabilities','a:1:{s:13:\\"administrator\\";b:1;}');
CREATE TABLE \`wp_users\` (x int);
INSERT INTO \`wp_users\` VALUES ${users};
CREATE TABLE \`wp_yoast_indexable\` (x int);
`;
  const users = "(1,'admin','$P$Bx','admin','admin@acme.com','','2020-01-01 00:00:00','',0,'admin'),(2,'editor','$P$By','editor','e@acme.com','','2020-01-01 00:00:00','',0,'Ed'),(3,'dev@acme','$P$Bz','dev','d@acme.com','','2020-01-01 00:00:00','',0,'Dev')";

  it('finds the administrators of the main site by login, oldest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'site.sql');
    writeFileSync(file, site(users));
    expect(await analyzeDump(file)).toMatchObject({ tablePrefix: 'wp_', admins: ['admin', 'dev@acme'], partial: false });
  });

  it('says how much of a large dump it has read on the way to its users', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'site.sql');
    // About 1 MB of posts before the users, as in a real dump: many chunks to read.
    const posts = `CREATE TABLE \`wp_postmeta\` (x int);\n${Array.from({ length: 20 }, () => `INSERT INTO \`wp_postmeta\` VALUES ${Array.from({ length: 1000 }, (_, i) => `(${i},1,'_edit_lock','1700000000:1')`).join(',')};\n`).join('')}`;
    writeFileSync(file, site(users, posts));
    const seen: number[] = [];
    expect(await analyzeDump(file, (f) => seen.push(f))).toMatchObject({ admins: ['admin', 'dev@acme'] });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.every((f) => f > 0 && f <= 1)).toBe(true);
  });

  it('reads users split over chunks, and keeps them unknown when the dump has no users table', async () => {
    const facts = emptyFacts();
    const state = emptyScan();
    const text = site(users);
    // Two chunks cut inside the users rows, with the scan's kept tail between them.
    const cut = text.indexOf("(2,'editor'") + 4;
    scanSql(text.slice(0, cut), facts, state, 20);
    scanSql(text.slice(cut - 20), facts, state, 0);
    expect([...state.adminIds].sort()).toEqual([1, 3]);
    expect(state.logins.get(3)).toBe('dev@acme');

    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'options-only.sql');
    writeFileSync(file, "CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.acme.com','yes');\n");
    expect((await analyzeDump(file)).admins).toBeUndefined();
  });

  it('lists the super admins of a network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-'));
    const file = join(dir, 'network.sql.gz');
    const network = "CREATE TABLE `wp_blogs` (x int);\nINSERT INTO `wp_blogs` VALUES (1,1,'www.acme.com','/','x','x',1,0,0,0,0,0);\nCREATE TABLE `wp_sitemeta` (x int);\nINSERT INTO `wp_sitemeta` VALUES (1,1,'site_admins','a:2:{i:0;s:5:\\\"admin\\\";i:1;s:10:\\\"acme.super\\\";}');\n";
    writeFileSync(file, gzipSync(site(users, network)));
    expect(await analyzeDump(file)).toMatchObject({ multisite: true, admins: ['admin', 'dev@acme'], superAdmins: ['admin', 'acme.super'] });
  });
});

describe('wp-config edits', () => {
  const sample = `<?php\ndefine( 'DB_NAME', 'database_name_here' );\n// define( 'DB_USER', 'old' );\n$table_prefix = 'wp_';\n\n/* That's all, stop editing! Happy publishing. */\nrequire_once ABSPATH . 'wp-settings.php';\n`;

  it('replaces a live define and leaves commented ones', () => {
    const out = setConstant(sample, 'DB_NAME', 'shop_com');
    expect(out).toContain("define( 'DB_NAME', 'shop_com' );");
    expect(out).toContain("// define( 'DB_USER', 'old' );");
  });

  it('adds missing constants before the end marker', () => {
    const out = setConstant(sample, 'WP_ENVIRONMENT_TYPE', 'local');
    expect(out.indexOf("define( 'WP_ENVIRONMENT_TYPE', 'local' );")).toBeLessThan(out.indexOf("/* That's all"));
  });

  it('replaces a define whose value holds ; or ), instead of adding a second one', () => {
    const text = "<?php\ndefine( 'ACME_DEV', 'a;b)' );\n/* That's all, stop editing! */\n";
    const out = setConstant(text, 'ACME_DEV', true);
    expect(out).toContain("define( 'ACME_DEV', true );");
    expect(out.match(/ACME_DEV/g)).toHaveLength(1);
  });

  it('quotes values safely and writes booleans raw', () => {
    expect(setConstant(sample, 'DB_PASSWORD', "it's\\x")).toContain("define( 'DB_PASSWORD', 'it\\'s\\\\x' );");
    expect(setConstant(sample, 'WP_DEBUG', true)).toContain("define( 'WP_DEBUG', true );");
  });

  it('sets the table prefix', () => {
    expect(setTablePrefix(sample, 'xyz_')).toContain("$table_prefix = 'xyz_';");
    expect(() => setTablePrefix(sample, "x'; evil")).toThrow();
  });
});

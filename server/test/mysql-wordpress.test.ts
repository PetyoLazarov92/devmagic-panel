import { describe, expect, it } from 'vitest';
import type { BrowseContext } from '../src/mysql-browse.js';
import { databaseSummary, rolesOf, wordpressReport } from '../src/mysql-wordpress.js';
import { type FakeCall, fakeExec, tempTree, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const json = (...rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).join('\n');

const SINGLE = ['wp_options', 'wp_posts', 'wp_postmeta', 'wp_comments', 'wp_commentmeta', 'wp_terms', 'wp_term_taxonomy', 'wp_term_relationships', 'wp_users', 'wp_usermeta'];
const NETWORK = [...SINGLE, 'wp_termmeta', 'wp_blogs', 'wp_sitemeta', 'wp_2_options', 'wp_2_posts', 'wp_2_postmeta', 'wp_2_comments', 'wp_2_commentmeta', 'wp_2_terms', 'wp_2_term_taxonomy', 'wp_2_term_relationships', 'wp_2_termmeta'];

/** Answers like MySQL for shop_com: the table list, then each section by what its SQL asks. */
function fakeWp(tables: string[], override: (sql: string) => Partial<{ code: number; stdout: string; stderr: string }> | undefined = () => undefined) {
  return fakeExec({
    // The post types WordPress and its plugins register.
    wp: () => ({ stdout: 'post\npage\nattachment\nrevision\nnav_menu_item\nproduct\n' }),
    mysql: (call: FakeCall) => {
      const e = call.args.indexOf('-e');
      if (e >= 0) return call.args[e + 1] === 'SELECT VERSION()' ? { stdout: '8.0.43\n' } : { stdout: 'information_schema_stats_expiry\t86400\n' };
      const sql = call.input ?? '';
      const special = override(sql);
      if (special) return special;
      if (sql.includes('SELECT TABLE_NAME FROM information_schema.TABLES')) return { stdout: `${tables.join('\n')}\n` };
      if (sql.includes('SELECT TABLE_ROWS FROM information_schema.TABLES')) return { stdout: '1200\n' };
      // The health check: tables MySQL does not list are not checked; health.test.ts answers these in full.
      if (sql.includes("JSON_ARRAY('ht'") || sql.includes('DATA_FREE') || sql.includes("JSON_ARRAY('pa'")) return { stdout: '' };
      if (sql.includes('GROUP BY post_type')) return { stdout: json(['post', 900], ['product', 40], ['elementor_library', 1240], ['acme_portfolio', 12]) };
      if (sql.includes('SELECT JSON_ARRAY(blog_id')) return { stdout: json([1, 'local.shop.com', '/', 0, 0, 0], [2, 'local.shop.com', '/outlet/', 0, 0, 0], [3, 'local.shop.com', '/old/', 1, 0, 0]) };
      if (sql.includes("JSON_ARRAY('a'")) return { stdout: json(['a', 412, 912_000], ['o', 'acme_big_cache', 400_000], ['o', 'rewrite_rules', 90_000]) };
      if (sql.includes("JSON_ARRAY('t'")) return { stdout: json(['t', 40, 52_000], ['tx', 7], ['s', 3, 900], ['sx', 1]) };
      if (sql.includes("JSON_ARRAY('p'")) return { stdout: json(['p', '1200', '3', '5'], ['c', '80', '2']) };
      if (sql.includes("JSON_ARRAY('pm'")) return { stdout: json(['pm', 31], ['cm', 0], ['tm', 2], ['tr', 4], ...(sql.includes("'um'") ? [['um', 6]] : [])) };
      if (sql.includes('GROUP BY meta_key') && sql.includes('LENGTH(meta_value)')) return { stdout: json(['_acme_gallery', 900, 4_000_000], [null, 3, 10]) };
      if (sql.includes('GROUP BY meta_key')) return { stdout: json(['_edit_lock', 300_000], ['_acme_gallery', 900]) };
      if (sql.includes("JSON_ARRAY('n'")) return { stdout: json(['n', 2], ['u', 1, 'alex', 'alex.morgan@acme.com', '2024-03-02 10:15:00', 'a:1:{s:13:"administrator";b:1;}'], ['u', 2, 'sam', 'sam.lee@acme.com', '2025-07-19 16:40:00', null]) };
      return { code: 1, stderr: `unexpected: ${sql.slice(0, 200)}` };
    },
  });
}

const ctxFor = (fake: ReturnType<typeof fakeExec>, config = wpSiteTree().config): BrowseContext => ({ config, exec: fake.exec, mysql, kept: () => [] });
const inputs = (fake: ReturnType<typeof fakeExec>) => fake.calls.map((c) => c.input ?? '').join('\n');

describe('the WordPress view of a database', () => {
  it('reads autoload, transients, clean-up counts, meta keys and users of a single site', async () => {
    const fake = fakeWp(SINGLE);
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, () => Date.parse('2026-11-07T09:00:00Z'));
    expect(r).toMatchObject({
      database: 'shop_com',
      prefix: 'wp_',
      blog: 1,
      blogPrefix: 'wp_',
      missingTables: ['wp_termmeta'],
      autoload: { count: 412, bytes: 912_000, limitBytes: 800_000, top: [{ name: 'acme_big_cache', bytes: 400_000 }, { name: 'rewrite_rules', bytes: 90_000 }] },
      transients: { count: 40, bytes: 52_000, expired: 7, site: { count: 3, bytes: 900, expired: 1 } },
      content: { revisions: 1200, autoDrafts: 3, trashedPosts: 5, spamComments: 80, trashedComments: 2 },
      orphans: { postmeta: 31, commentmeta: 0, termmeta: 2, termRelationships: 4, usermeta: 6 },
      metaKeys: { estimatedRows: 1200, sized: true, keys: [{ key: '_acme_gallery', count: 900, bytes: 4_000_000 }, { key: '', count: 3, bytes: 10 }] },
      users: { count: 2, list: [{ id: '1', login: 'alex', roles: ['administrator'] }, { id: '2', login: 'sam', roles: [] }] },
      errors: {},
      checkedAt: '2026-11-07T09:00:00.000Z',
    });
    expect(r.network).toBeUndefined();
    const sql = inputs(fake);
    // Every read is read only, and only tables the database has are named.
    expect(fake.calls.filter((c) => c.input).every((c) => c.input?.startsWith('SET SESSION TRANSACTION READ ONLY;'))).toBe(true);
    expect(sql).toContain("FROM `shop_com`.`wp_options` WHERE autoload IN ('yes', 'on', 'auto-on', 'auto')");
    expect(sql).toContain("option_name LIKE '\\_transient\\_%' AND option_name NOT LIKE '\\_transient\\_timeout\\_%'");
    expect(sql).toContain("option_name LIKE '\\_site\\_transient\\_timeout\\_%' AND CAST(option_value AS UNSIGNED) < UNIX_TIMESTAMP()");
    expect(sql).not.toContain('wp_termmeta');
    expect(sql).toContain("t.taxonomy <> 'link_category'");
    expect(sql).toContain(`m.meta_key = _utf8mb4 X'${Buffer.from('wp_capabilities').toString('hex')}'`);
  });

  it("reads a network's second site from its own tables, with its roles and the network's site transients", async () => {
    const tree = wpSiteTree({ multisite: true });
    const fake = fakeWp(NETWORK);
    const r = await wordpressReport(ctxFor(fake, tree.config), 'local.shop.com', undefined, 2);
    expect(r.network).toEqual([
      { id: 1, domain: 'local.shop.com', path: '/', prefix: 'wp_' },
      { id: 2, domain: 'local.shop.com', path: '/outlet/', prefix: 'wp_2_' },
      { id: 3, domain: 'local.shop.com', path: '/old/', prefix: 'wp_3_', inactive: true },
    ]);
    expect(r.blogPrefix).toBe('wp_2_');
    expect(r.missingTables).toEqual([]);
    expect(r.orphans).not.toHaveProperty('usermeta');
    const sql = inputs(fake);
    expect(sql).toContain('FROM `shop_com`.`wp_2_options` WHERE autoload');
    expect(sql).toContain('FROM `shop_com`.`wp_2_postmeta` m LEFT JOIN `shop_com`.`wp_2_posts` p');
    expect(sql).toContain("FROM `shop_com`.`wp_sitemeta` WHERE meta_key LIKE '\\_site\\_transient\\_%'");
    // Users are the network's; their roles are this site's.
    expect(sql).toContain('FROM `shop_com`.`wp_users` u LEFT JOIN `shop_com`.`wp_usermeta` m');
    expect(sql).toContain(`X'${Buffer.from('wp_2_capabilities').toString('hex')}'`);
    await expect(wordpressReport(ctxFor(fakeWp(NETWORK), tree.config), 'local.shop.com', undefined, 9)).rejects.toMatchObject({ status: 404, message: 'This network has no site 9' });
    await expect(wordpressReport(ctxFor(fakeWp(SINGLE)), 'local.shop.com', undefined, 2)).rejects.toMatchObject({ status: 404 });
  });

  it('gives a section MySQL stopped as null with why, and keeps the rest', async () => {
    const fake = fakeWp(SINGLE, (sql) => (sql.includes('GROUP BY meta_key') ? { code: 1, stderr: 'ERROR 3024 (HY000): maximum statement execution time exceeded' } : undefined));
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined);
    expect(r.metaKeys).toBeNull();
    expect(r.errors).toEqual({ metaKeys: 'MySQL stopped the read after 60 seconds: the tables are too big to read in time' });
    expect(r.autoload?.count).toBe(412);
  });

  it('reads only the parts asked for, with a minute for the ones that read whole tables', async () => {
    const fake = fakeWp(SINGLE);
    const quick = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['autoload', 'transients', 'users'] });
    expect(Object.keys(quick).filter((k) => ['autoload', 'transients', 'users', 'content', 'orphans', 'metaKeys'].includes(k))).toEqual(['autoload', 'transients', 'users']);
    expect(inputs(fake)).not.toContain('GROUP BY meta_key');
    expect(fake.calls.filter((c) => c.input?.includes('JSON_ARRAY')).every((c) => c.input?.includes('max_execution_time = 15000'))).toBe(true);

    const slow = fakeWp(SINGLE);
    const content = await wordpressReport(ctxFor(slow), 'local.shop.com', undefined, 1, Date.now, { sections: ['content'] });
    expect(content.content?.revisions).toBe(1200);
    expect(content).not.toHaveProperty('autoload');
    expect(slow.calls.find((c) => c.input?.includes("JSON_ARRAY('p'"))?.input).toContain('max_execution_time = 60000');
  });

  it('counts the keys of a big postmeta by rows, and their sizes only when asked', async () => {
    const big = (sql: string) => (sql.includes('SELECT TABLE_ROWS') ? { stdout: '2480000\n' } : undefined);
    const fake = fakeWp(SINGLE, big);
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['metaKeys'] });
    expect(r.metaKeys).toEqual({ estimatedRows: 2_480_000, sized: false, keys: [{ key: '_edit_lock', count: 300_000 }, { key: '_acme_gallery', count: 900 }] });
    expect(inputs(fake)).not.toContain('LENGTH(meta_value)');
    expect(inputs(fake)).toContain("TABLE_NAME = _utf8mb4 X'" + Buffer.from('wp_postmeta').toString('hex') + "'");
    const sized = await wordpressReport(ctxFor(fakeWp(SINGLE, big)), 'local.shop.com', undefined, 1, Date.now, { sections: ['metaKeys'], sizes: true });
    expect(sized.metaKeys).toMatchObject({ estimatedRows: 2_480_000, sized: true, keys: [{ key: '_acme_gallery', bytes: 4_000_000 }, { key: '' }] });
  });

  it('refuses a site without a database on this machine', async () => {
    await expect(wordpressReport(ctxFor(fakeWp(SINGLE), tempTree().config), 'local.shop.com', undefined)).rejects.toMatchObject({ status: 404, message: "local.shop.com has no database on this computer's MySQL server" });
  });

  it('reads role names from wp_capabilities', () => {
    expect(rolesOf('a:2:{s:13:"administrator";b:1;s:6:"editor";b:0;}')).toEqual(['administrator']);
    expect(rolesOf(null)).toEqual([]);
  });

  it('gives the assistant names, sizes and counts, never a row value, a user or an email', async () => {
    const fake = fakeWp(SINGLE, (sql) =>
      sql.includes('information_schema.SCHEMATA')
        ? { stdout: ['1', JSON.stringify(['wp_postmeta', 'BASE TABLE', 'InnoDB', 9000, 3_000_000, 1_000_000, 0, 'utf8mb4_unicode_520_ci', null]), JSON.stringify(['acme_log', 'BASE TABLE', 'MyISAM', 10, 1000, 0, 0, 'latin1_swedish_ci', null])].join('\n') }
        : undefined,
    );
    const summary = await databaseSummary(ctxFor(fake), 'local.shop.com');
    expect(summary).toMatchObject({
      database: 'shop_com',
      tables: 2,
      biggestTables: [{ name: 'wp_postmeta', engine: 'InnoDB', rows: 9000, mb: 3.8 }, { name: 'acme_log' }],
      notInnodb: ['acme_log (MyISAM)'],
      autoload: { count: 412, kb: 891, siteHealthLimitKb: 781, biggestOptions: [{ name: 'acme_big_cache', kb: 390.6 }, { name: 'rewrite_rules', kb: 87.9 }] },
      users: 2,
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain('acme.com');
    expect(text).not.toContain('alex');
  });
});

describe('what plugins leave, and revisions past the newest few', () => {
  it('counts oEmbed caches, Akismet history, finished actions, expired sessions and login sessions where the site has their tables', async () => {
    const tables = [...SINGLE, 'wp_actionscheduler_actions', 'wp_actionscheduler_logs', 'wp_woocommerce_sessions'];
    const fake = fakeWp(tables, (sql) => {
      if (sql.includes("JSON_ARRAY('p'")) return { stdout: json(['p', 40, 3, 5], ['c', 80, 2], ['oe', 120], ['ak', 900], ['as', 31_000], ['al', 92_000], ['ws', 14], ['st', 2]) };
      if (sql.includes("JSON_ARRAY('r'")) return { stdout: json(['r', 30, 22, 15, 4]) };
      return undefined;
    });
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['content'] });
    expect(r.content).toEqual({
      revisions: 40,
      revisionsOver: { 1: 30, 3: 22, 5: 15, 10: 4 },
      autoDrafts: 3,
      trashedPosts: 5,
      spamComments: 80,
      trashedComments: 2,
      oembed: 120,
      akismet: 900,
      actionsDone: 31_000,
      actionLogs: 92_000,
      wcSessions: 14,
      sessionTokens: 2,
    });
    const sql = inputs(fake);
    expect(sql).toContain("FROM `shop_com`.`wp_actionscheduler_actions` WHERE status IN ('complete', 'failed', 'canceled')");
    expect(sql).toContain("WHERE meta_key LIKE '\\_oembed\\_%'");
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_date DESC, ID DESC)');
  });

  it('leaves out the counts of tables the site lacks, and keeping revisions where MySQL has no window functions', async () => {
    const fake = fakeWp(SINGLE, (sql) => (sql.includes("JSON_ARRAY('r'") ? { code: 1, stderr: "ERROR 1064 (42000): You have an error in your SQL syntax near '(PARTITION BY'" } : undefined));
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['content'] });
    expect(r.content).not.toHaveProperty('actionsDone');
    expect(r.content).not.toHaveProperty('wcSessions');
    expect(r.content).not.toHaveProperty('revisionsOver');
    expect(r.errors).toEqual({});
  });

  it('looks for duplicate post meta only when asked', async () => {
    const fake = fakeWp(SINGLE, (sql) => (sql.includes('MD5(meta_value)') ? { stdout: json(['_edit_lock', 400], ['_acme_price', 12]) } : undefined));
    const all = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined);
    expect(all).not.toHaveProperty('duplicates');
    expect(inputs(fake)).not.toContain('MD5(meta_value)');
    const asked = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['duplicates'] });
    expect(asked.duplicates).toEqual({ rows: 412, keys: [{ key: '_edit_lock', rows: 400 }, { key: '_acme_price', rows: 12 }] });
    expect(fake.calls.find((c) => c.input?.includes('MD5(meta_value)'))?.input).toContain('max_execution_time = 120000');
  });
});

describe('post types nothing registers any more', () => {
  it("lists the posts of types WP-CLI does not know, with plugins and the theme loaded, the most first", async () => {
    const fake = fakeWp(SINGLE);
    const r = await wordpressReport(ctxFor(fake), 'local.shop.com', undefined, 1, Date.now, { sections: ['postTypes'] });
    expect(r.postTypes).toEqual({ unregistered: [{ type: 'elementor_library', count: 1240 }, { type: 'acme_portfolio', count: 12 }] });
    const wp = fake.calls.find((c) => c.file === 'wp');
    expect(wp?.args).toEqual([expect.stringMatching(/^--path=.*local\.shop\.com$/), '--url=https://local.shop.com/', 'post-type', 'list', '--field=name']);
  });

  it('says why when WP-CLI cannot list them, and keeps the rest', async () => {
    const fake = fakeExec({ wp: { code: 1, stdout: '', stderr: 'Error: Error establishing a database connection.' } });
    const both = fakeWp(SINGLE);
    const exec: typeof fake.exec = (file, args, options) => (file === 'wp' ? fake.exec(file, args, options) : both.exec(file, args, options));
    const r = await wordpressReport({ ...ctxFor(both), exec }, 'local.shop.com', undefined, 1, Date.now, { sections: ['postTypes', 'users'] });
    expect(r.postTypes).toBeNull();
    expect(r.errors).toEqual({ postTypes: 'WP-CLI could not list the post types: Error: Error establishing a database connection.' });
    expect(r.users?.count).toBe(2);
  });
});

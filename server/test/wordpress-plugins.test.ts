import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobRuntime } from '../src/jobs.js';
import { planAutoloadOff, wordpressPlugins } from '../src/wordpress-plugins.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const json = (...rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).join('\n');
const TABLES = ['wp_options', 'wp_posts', 'wp_postmeta', 'wp_users', 'wp_usermeta', 'wp_wc_orders', 'wp_yoast_indexable', 'wp_acme_tools_log', 'wp_mystery', 'wp_2_options'];

/** shop_com with WooCommerce on, Acme Tools installed and off, and Yoast SEO gone but for its tables and options. */
function shop() {
  const tree = wpSiteTree();
  for (const folder of ['woocommerce', 'acme-tools']) mkdirSync(join(tree.docroot, 'wp-content', 'plugins', folder), { recursive: true });
  const fake = fakeExec({
    mysqldump: () => ({ stdout: "REPLACE INTO `wp_options` VALUES (9,'wpseo','x','yes');\n" }),
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? '';
      if (sql.includes('SELECT TABLE_NAME FROM information_schema.TABLES')) return { stdout: `${TABLES.join('\n')}\n` };
      if (sql.includes("JSON_ARRAY('pa'")) {
        return {
          stdout: json(
            ['pa', 'a:1:{i:0;s:27:"woocommerce/woocommerce.php";}'],
            ['po', 'wpseo', 2_000],
            ['po', 'wpseo_titles', 9_000],
            ['po', 'acme_tools_settings', 500],
            ['po', 'woocommerce_queue_flush', 40],
            ['po', 'widget_text', 300],
            ['po', 'rewrite_rules', 90_000],
            ...TABLES.map((t, i) => ['pt', t, (i + 1) * 1_000_000, (i + 1) * 100]),
          ),
        };
      }
      if (sql.includes('COUNT(*)')) return { stdout: '40\t3\n' };
      if (sql.includes('UPDATE')) return { stdout: '3\n' };
      return { stdout: '' };
    },
  });
  return { tree, fake };
}

describe("tables found in the site's code", () => {
  /** A site whose tables no name explains: one in the theme in use, one in another theme, one in a must-use plugin, one in a plugin by another name, one nobody names. */
  function coded() {
    const tree = wpSiteTree();
    mkdirSync(join(tree.docroot, 'wp-content', 'plugins', 'acme-tools'), { recursive: true });
    const content = join(tree.docroot, 'wp-content');
    const tables = ['wp_options', 'wp_posts', 'wp_brand_quotes', 'wp_old_slides', 'wp_shop_queue', 'wp_toolbox_cache', 'wp_mystery', 'wp_log'];
    const fake = fakeExec({
      mysql: (call: FakeCall) => {
        if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
        const sql = call.input ?? '';
        if (sql.includes("JSON_ARRAY('pa'")) {
          return { stdout: json(['pa', 'a:0:{}'], ['th', 'acme-child'], ['th', 'acme-theme'], ...tables.map((t) => ['pt', t, 1_000_000, 100])) };
        }
        return { stdout: '' };
      },
      grep: {
        code: 0,
        stdout: [
          `${content}/themes/acme-theme/inc/quotes.php:brand_quotes`,
          `${content}/themes/acme-theme/inc/quotes.php:brand_quotes`,
          `${content}/themes/old-theme/functions.php:old_slides`,
          `${content}/mu-plugins/shop-queue.php:wp_shop_queue`,
          `${content}/plugins/acme-tools/src/cache.php:toolbox_cache`,
        ].join('\n'),
      },
    });
    return { tree, fake, content, tables };
  }

  it('names the theme, must-use plugin or plugin whose code names a table, and says when nothing does', async () => {
    const { tree, fake, content, tables } = coded();
    const r = await wordpressPlugins({ config: tree.config, exec: fake.exec, mysql, kept: () => [] }, { domain: 'local.shop.com', path: undefined, database: 'shop_com', names: new Set(tables), prefix: 'wp_', blogPrefix: 'wp_', blog: 1, network: false });
    const by = Object.fromEntries((r?.tables ?? []).map((t) => [t.table, t]));
    expect(by.wp_brand_quotes).toMatchObject({ plugin: 'acme-theme', kind: 'theme', by: 'code', state: 'active' });
    expect(by.wp_old_slides).toMatchObject({ plugin: 'old-theme', kind: 'theme', by: 'code', state: 'inactive' });
    expect(by.wp_shop_queue).toMatchObject({ plugin: 'must-use plugins', kind: 'muPlugin', by: 'code', state: 'active' });
    expect(by.wp_toolbox_cache).toMatchObject({ plugin: 'acme-tools', by: 'code', state: 'inactive' });
    expect(by.wp_mystery).toMatchObject({ state: 'unknown', unused: true });
    expect(by.wp_mystery?.plugin).toBeUndefined();
    expect(by.wp_log).toMatchObject({ state: 'unknown' });
    expect(by.wp_log?.unused).toBeUndefined();
    // One grep, whole words, fixed strings, PHP only, each name short and full; never a shell, and a name too short to search is left out.
    const grep = fake.calls.filter((c) => c.file === 'grep');
    expect(grep).toHaveLength(1);
    expect(grep[0]?.args.slice(0, 4)).toEqual(['-rIowF', '--include=*.php', '--exclude-dir=node_modules', '--exclude-dir=.git']);
    expect(grep[0]?.args).toEqual(expect.arrayContaining(['-e', 'brand_quotes', '-e', 'wp_brand_quotes', '--', `${content}/themes`, `${content}/mu-plugins`, `${content}/plugins`]));
    expect(grep[0]?.args).not.toContain('log');
  });

  it('says nothing about where a table is named when the search could not run', async () => {
    const { tree, tables } = coded();
    const failed = fakeExec({
      mysql: (call: FakeCall) => (call.input?.includes("JSON_ARRAY('pa'") ? { stdout: json(['pa', 'a:0:{}'], ...tables.map((t) => ['pt', t, 1_000_000, 100])) } : { stdout: '8.0.43\n' }),
      grep: { code: 124, stdout: '', stderr: 'timed out' },
    });
    const r = await wordpressPlugins({ config: tree.config, exec: failed.exec, mysql, kept: () => [] }, { domain: 'local.shop.com', path: undefined, database: 'shop_com', names: new Set(tables), prefix: 'wp_', blogPrefix: 'wp_', blog: 1, network: false });
    expect(r?.tables.find((t) => t.table === 'wp_mystery')).toEqual({ table: 'wp_mystery', bytes: 1_000_000, rows: 100, state: 'unknown' });
  });
});

describe('what plugins leave', () => {
  it('names the plugin of each table that is not WordPress\'s own, and whether it is on, off or gone', async () => {
    const { tree, fake } = shop();
    const r = await wordpressPlugins({ config: tree.config, exec: fake.exec, mysql, kept: () => [] }, { domain: 'local.shop.com', path: undefined, database: 'shop_com', names: new Set(TABLES), prefix: 'wp_', blogPrefix: 'wp_', blog: 1, network: false });
    expect(r?.tables.map((t) => [t.table, t.plugin ?? null, t.state])).toEqual([
      ['wp_mystery', null, 'unknown'],
      ['wp_acme_tools_log', 'acme-tools', 'inactive'],
      ['wp_yoast_indexable', 'Yoast SEO', 'missing'],
      ['wp_wc_orders', 'WooCommerce', 'active'],
    ]);
  });

  it('finds the autoloaded options of plugins that are off or gone, never WordPress\'s own or an active plugin\'s', async () => {
    const { tree, fake } = shop();
    const r = await wordpressPlugins({ config: tree.config, exec: fake.exec, mysql, kept: () => [] }, { domain: 'local.shop.com', path: undefined, database: 'shop_com', names: new Set(TABLES), prefix: 'wp_', blogPrefix: 'wp_', blog: 1, network: false });
    expect(r?.autoload).toEqual([
      { plugin: 'Yoast SEO', slug: 'wordpress-seo', state: 'missing', count: 2, bytes: 11_000, options: ['wpseo_titles', 'wpseo'] },
      { plugin: 'acme-tools', slug: 'acme-tools', state: 'inactive', count: 1, bytes: 500, options: ['acme_tools_settings'] },
    ]);
  });

  it('turns autoload off in batches after saving the rows with REPLACE, so Undo puts them back as they were', async () => {
    const { tree, fake } = shop();
    const { title, steps } = await planAutoloadOff({ config: tree.config, exec: fake.exec, mysql, kept: () => [], siteBusy: () => false, now: () => new Date('2026-11-07T10:15:00Z') }, { domain: 'local.shop.com', options: ['wpseo', 'wpseo_titles', 'wpseo'] });
    expect(title).toBe('Turn off autoload for 2 options');
    const undos: string[] = [];
    const job: JobRuntime = { onUndo: (label) => void undos.push(label), dropUndo: () => undefined, progress: () => undefined };
    for (const step of steps) await step.run(job);
    const dump = fake.calls.find((c) => c.file === 'mysqldump');
    expect(dump?.args).toEqual(expect.arrayContaining(['--replace', '--no-create-info']));
    expect(dump?.args).not.toContain('--insert-ignore');
    const update = fake.calls.find((c) => c.input?.includes('UPDATE `wp_options`'))?.input ?? '';
    expect(update).toContain("UPDATE `wp_options` SET autoload = IF(autoload = 'yes', 'no', 'off') WHERE (option_name IN (");
    expect(update).toContain('ORDER BY `option_id` LIMIT 5000;');
    expect(fake.calls.some((c) => c.input?.includes('DELETE FROM'))).toBe(false);
    expect(undos).toEqual(['Put the options back as they were']);
  });
});

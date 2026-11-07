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

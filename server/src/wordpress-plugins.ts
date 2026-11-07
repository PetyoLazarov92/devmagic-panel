import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, WpDbPluginOptions, WpDbPlugins, WpDbPluginTable, WpPluginState } from '@devmagic-panel/shared';
import { WP_AUTOLOAD_VALUES } from '@devmagic-panel/shared';
import type { JobStep } from './jobs.js';
import { type BrowseContext, num, parseJson, read } from './mysql-browse.js';
import { planCleanup } from './mysql-cleanup.js';
import type { RowsContext } from './mysql-rows.js';
import { MysqlRefused, siteDatabases } from './mysql-server.js';
import { ident, textLiteral } from './mysql-sql.js';
import { CORE_SCHEMA } from './mysql-health.js';
import { wordpressTables } from './mysql-wordpress.js';

/**
 * The tables and autoloaded options a site has that are not WordPress's own,
 * with the plugin each likely belongs to and whether that plugin is on, off or
 * gone. It is a guess by name (known prefixes, then the plugins folder), shown
 * as one: the panel never deletes by it on its own.
 */
interface Known {
  name: string;
  /** Its folders in wp-content/plugins; on when any of them is. */
  slugs: string[];
}

const ACTION_SCHEDULER: Known = {
  name: 'Action Scheduler (WooCommerce and others)',
  slugs: ['woocommerce', 'action-scheduler', 'wpforms-lite', 'wpforms', 'seo-by-rank-math', 'mailpoet', 'all-in-one-seo-pack', 'wp-mail-smtp', 'the-events-calendar', 'woocommerce-subscriptions'],
};

/** Table name prefixes (after the site's prefix) of plugins that make tables. */
export const KNOWN_TABLES: Array<[string, Known]> = [
  ['actionscheduler_', ACTION_SCHEDULER],
  ['wc_', { name: 'WooCommerce', slugs: ['woocommerce'] }],
  ['woocommerce_', { name: 'WooCommerce', slugs: ['woocommerce'] }],
  ['yoast_', { name: 'Yoast SEO', slugs: ['wordpress-seo', 'wordpress-seo-premium'] }],
  ['rank_math', { name: 'Rank Math SEO', slugs: ['seo-by-rank-math'] }],
  ['aioseo_', { name: 'All in One SEO', slugs: ['all-in-one-seo-pack'] }],
  ['gf_', { name: 'Gravity Forms', slugs: ['gravityforms'] }],
  ['rg_', { name: 'Gravity Forms', slugs: ['gravityforms'] }],
  ['wpforms_', { name: 'WPForms', slugs: ['wpforms-lite', 'wpforms'] }],
  ['e_', { name: 'Elementor', slugs: ['elementor', 'elementor-pro'] }],
  ['icl_', { name: 'WPML', slugs: ['sitepress-multilingual-cms'] }],
  ['redirection_', { name: 'Redirection', slugs: ['redirection'] }],
  ['wfls_', { name: 'Wordfence', slugs: ['wordfence'] }],
  ['wf', { name: 'Wordfence', slugs: ['wordfence'] }],
  ['litespeed_', { name: 'LiteSpeed Cache', slugs: ['litespeed-cache'] }],
  ['frmt_', { name: 'Forminator', slugs: ['forminator'] }],
  ['frm_', { name: 'Formidable Forms', slugs: ['formidable'] }],
  ['ewwwio_', { name: 'EWWW Image Optimizer', slugs: ['ewww-image-optimizer'] }],
  ['wpmailsmtp_', { name: 'WP Mail SMTP', slugs: ['wp-mail-smtp'] }],
  ['mailpoet_', { name: 'MailPoet', slugs: ['mailpoet'] }],
  ['nf3_', { name: 'Ninja Forms', slugs: ['ninja-forms'] }],
  ['tec_', { name: 'The Events Calendar', slugs: ['the-events-calendar'] }],
  ['learnpress_', { name: 'LearnPress', slugs: ['learnpress'] }],
  ['bp_', { name: 'BuddyPress', slugs: ['buddypress'] }],
  ['wsal_', { name: 'WP Activity Log', slugs: ['wp-security-audit-log'] }],
  ['trp_', { name: 'TranslatePress', slugs: ['translatepress-multilingual'] }],
  ['edd_', { name: 'Easy Digital Downloads', slugs: ['easy-digital-downloads'] }],
  ['cmplz_', { name: 'Complianz', slugs: ['complianz-gdpr'] }],
  ['relevanssi', { name: 'Relevanssi', slugs: ['relevanssi'] }],
  ['jetpack_', { name: 'Jetpack', slugs: ['jetpack'] }],
  ['ppress_', { name: 'ProfilePress', slugs: ['wp-user-avatar'] }],
];

/** Option name prefixes of plugins whose options are not named after their folder. */
export const KNOWN_OPTIONS: Array<[string, Known]> = [
  ['wpseo', { name: 'Yoast SEO', slugs: ['wordpress-seo', 'wordpress-seo-premium'] }],
  ['woocommerce_', { name: 'WooCommerce', slugs: ['woocommerce'] }],
  ['wc_', { name: 'WooCommerce', slugs: ['woocommerce'] }],
  ['elementor', { name: 'Elementor', slugs: ['elementor', 'elementor-pro'] }],
  ['rank_math', { name: 'Rank Math SEO', slugs: ['seo-by-rank-math'] }],
  ['aioseo', { name: 'All in One SEO', slugs: ['all-in-one-seo-pack'] }],
  ['wpforms', { name: 'WPForms', slugs: ['wpforms-lite', 'wpforms'] }],
  ['litespeed', { name: 'LiteSpeed Cache', slugs: ['litespeed-cache'] }],
  ['wordfence', { name: 'Wordfence', slugs: ['wordfence'] }],
  ['jetpack', { name: 'Jetpack', slugs: ['jetpack'] }],
  ['mailpoet', { name: 'MailPoet', slugs: ['mailpoet'] }],
  ['rg_gforms', { name: 'Gravity Forms', slugs: ['gravityforms'] }],
  ['gform_', { name: 'Gravity Forms', slugs: ['gravityforms'] }],
  ['icl_sitepress', { name: 'WPML', slugs: ['sitepress-multilingual-cms'] }],
  ['_wpml', { name: 'WPML', slugs: ['sitepress-multilingual-cms'] }],
  ['redirection_', { name: 'Redirection', slugs: ['redirection'] }],
  ['wpcf7', { name: 'Contact Form 7', slugs: ['contact-form-7'] }],
  ['monsterinsights', { name: 'MonsterInsights', slugs: ['google-analytics-for-wordpress'] }],
  ['updraft', { name: 'UpdraftPlus', slugs: ['updraftplus'] }],
  ['wp_rocket', { name: 'WP Rocket', slugs: ['wp-rocket'] }],
  ['w3tc', { name: 'W3 Total Cache', slugs: ['w3-total-cache'] }],
  ['autoptimize', { name: 'Autoptimize', slugs: ['autoptimize'] }],
];

/** Names WordPress itself uses for options: never taken for a plugin's, whatever its folder is called. */
const CORE_OPTION = /^(?:_?(?:site_)?transient_|wp_|widget_|theme_mods_|_wp_|sidebars_widgets|cron$|rewrite_rules$|active_plugins$|recently_|uninstall_plugins$|auto_)/;
const MIN_PREFIX = 4;

/** The plugins that are on, by folder: the site's active_plugins, and the network's on a network. */
const slugsIn = (serialized: string) => new Set([...serialized.matchAll(/s:\d+:"([^"/]+)\//g)].map((m) => m[1] as string));

function stateOf(slugs: string[], active: Set<string>, installed: Set<string>, known: boolean): WpPluginState {
  if (slugs.some((s) => active.has(s))) return 'active';
  if (slugs.some((s) => installed.has(s))) return 'inactive';
  return known ? 'missing' : 'unknown';
}

/** The plugin a name belongs to: a known prefix, else a folder in the plugins folder the name starts with. */
function guess(name: string, known: Array<[string, Known]>, installed: Set<string>): Known | undefined {
  const hit = known.filter(([p]) => name.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  if (hit) return hit[1];
  const folder = [...installed]
    .map((slug) => ({ slug, prefix: slug.replace(/-/g, '_') }))
    .filter(({ prefix }) => prefix.length >= MIN_PREFIX && (name === prefix || name.startsWith(`${prefix}_`)))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return folder ? { name: folder.slug, slugs: [folder.slug] } : undefined;
}

/** The folders in the site's wp-content/plugins, or none when it cannot be read. */
function pluginFolders(docroot: string | undefined): Set<string> {
  if (!docroot) return new Set();
  try {
    return new Set(readdirSync(join(docroot, 'wp-content', 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    return new Set();
  }
}

export async function wordpressPlugins(ctx: BrowseContext, args: { domain: string; path: string | undefined; database: string; names: Set<string>; prefix: string; blogPrefix: string; blog: number; network: boolean }): Promise<WpDbPlugins | null> {
  const { database, names, prefix, blogPrefix, blog } = args;
  const db = ident(database);
  const options = names.has(`${blogPrefix}options`) ? `${db}.${ident(`${blogPrefix}options`)}` : null;
  if (!options) return null;
  const sitemeta = args.network && names.has(`${prefix}sitemeta`) ? `${db}.${ident(`${prefix}sitemeta`)}` : null;
  const autoloaded = `autoload IN (${WP_AUTOLOAD_VALUES.map((v) => `'${v}'`).join(', ')})`;
  const lines = await read(
    ctx,
    `SELECT JSON_ARRAY('pa', option_value) FROM ${options} WHERE option_name = 'active_plugins';\n` +
      (sitemeta ? `SELECT JSON_ARRAY('pa', meta_value) FROM ${sitemeta} WHERE meta_key = 'active_sitewide_plugins';\n` : '') +
      `SELECT JSON_ARRAY('po', option_name, LENGTH(option_value)) FROM ${options} WHERE ${autoloaded};\n` +
      `SELECT JSON_ARRAY('pt', TABLE_NAME, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0), COALESCE(TABLE_ROWS, 0)) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)} AND TABLE_TYPE = 'BASE TABLE';\n`,
  );
  const rows = lines.map(parseJson);
  const active = new Set(rows.filter((r) => r[0] === 'pa').flatMap((r) => [...slugsIn(String(r[1] ?? ''))]));
  const site = siteDatabases(ctx.config).find((s) => s.domain === args.domain && s.path === args.path);
  const installed = pluginFolders(site?.docroot);

  // This site's tables that are not WordPress's own, without another site of the network's (wp_2_) on the first one.
  const core = new Set(Object.keys(CORE_SCHEMA).map((c) => `${CORE_SCHEMA[c]?.shared ? prefix : blogPrefix}${c}`));
  const networkTables = ['blogs', 'blogmeta', 'site', 'sitemeta', 'signups', 'registration_log', 'blog_versions'].map((t) => `${prefix}${t}`);
  const other = new RegExp(`^${prefix}\\d+_`);
  const tables: WpDbPluginTable[] = rows
    .filter((r) => r[0] === 'pt')
    .map(([, t, b, n]) => ({ table: String(t), bytes: num(b), rows: num(n) }))
    .filter((t) => t.table.startsWith(blogPrefix) && !core.has(t.table) && !networkTables.includes(t.table) && (blog !== 1 || !other.test(t.table)))
    .map((t) => {
      const known = guess(t.table.slice(blogPrefix.length), KNOWN_TABLES, installed);
      return { ...t, ...(known ? { plugin: known.name, slug: known.slugs[0] as string } : {}), state: known ? stateOf(known.slugs, active, installed, true) : 'unknown' };
    })
    .sort((a, b) => b.bytes - a.bytes);

  // Autoloaded options of plugins that are off or gone: by a known prefix, or a folder's name.
  const groups = new Map<string, WpDbPluginOptions & { sized: Array<[string, number]> }>();
  for (const [, name, size] of rows.filter((r) => r[0] === 'po')) {
    const option = String(name);
    if (CORE_OPTION.test(option)) continue;
    const known = guess(option, KNOWN_OPTIONS, installed);
    if (!known) continue;
    const state = stateOf(known.slugs, active, installed, true);
    if (state !== 'inactive' && state !== 'missing') continue;
    const slug = known.slugs.find((s) => installed.has(s)) ?? (known.slugs[0] as string);
    const g = groups.get(known.name) ?? { plugin: known.name, slug, state, count: 0, bytes: 0, options: [], sized: [] };
    g.count += 1;
    g.bytes += num(size);
    g.sized.push([option, num(size)]);
    groups.set(known.name, g);
  }
  const autoload = [...groups.values()]
    .map(({ sized, ...g }) => ({ ...g, options: sized.sort((a, b) => b[1] - a[1]).slice(0, 200).map(([o]) => o) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { tables, autoload };
}

/** The job of turning autoload off for some options: the rows saved with REPLACE first, then changed in batches. */
export async function planAutoloadOff(ctx: RowsContext, { domain, path, blog = 1, options }: ActionInput<'db.autoloadOff'>): Promise<{ title: string; steps: JobStep[] }> {
  const t = await wordpressTables({ config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept }, domain, path, blog);
  const table = `${t.blogPrefix}options`;
  if (!t.names.has(table)) throw new MysqlRefused(`${table} is not in ${t.database}`);
  const unique = [...new Set(options)];
  const title = `Turn off autoload for ${unique.length === 1 ? unique[0] : `${unique.length} options`}`;
  const where = `option_name IN (${unique.map((o) => textLiteral(o)).join(', ')}) AND autoload IN (${WP_AUTOLOAD_VALUES.map((v) => `'${v}'`).join(', ')})`;
  // As the site's WordPress writes it: no where it still writes yes, else off.
  const steps = planCleanup(ctx, t.database, 'autoload', title, [{ table, how: 'update', key: 'option_id', where, set: "autoload = IF(autoload = 'yes', 'no', 'off')" }], `${domain}${path ?? ''}`);
  return { title, steps };
}

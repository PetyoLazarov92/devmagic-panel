import type { ProfileInfo, ProfileList, ProfileSummary } from '@devmagic-panel/shared';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const name = (minutes: number, host: string, request: string) => `cachegrind.out.${Math.floor((Date.now() - minutes * 60_000) / 1000)}_120000.${host}${request.replace(/\//g, '_')}.gz`;

export const mockProfileFiles: ProfileInfo[] = [
  { version: '8.3', name: name(3, 'local.spellbook.example', '/shop/?XDEBUG_PROFILE=1'), at: ago(3), host: 'local.spellbook.example', request: '/shop_XDEBUG_PROFILE=1', bytes: 4_800_000, totalMs: 1_840, peakBytes: 48_000_000 },
  { version: '8.3', name: name(40, 'local.spellbook.example', '/?XDEBUG_PROFILE=1'), at: ago(40), host: 'local.spellbook.example', request: '/_XDEBUG_PROFILE=1', bytes: 2_100_000 },
  { version: '8.3', name: name(95, 'local.spellbook.example', '/wp-admin/?XDEBUG_PROFILE=1'), at: ago(95), host: 'local.spellbook.example', request: '/wp-admin__XDEBUG_PROFILE=1', bytes: 6_300_000, totalMs: 2_610, peakBytes: 61_000_000 },
];

export function mockProfiles(domain?: string): ProfileList {
  return { versions: ['8.3'], profiles: mockProfileFiles.filter((p) => !domain || p.host === domain) };
}

export function mockProfile(version: string, file: string): ProfileSummary {
  const info = mockProfileFiles.find((p) => p.version === version && p.name === file) ?? (mockProfileFiles[0] as ProfileInfo);
  const fn = (name: string, path: string, group: string, calls: number, selfMs: number, totalMs: number, callers: Array<[string, number]> = []) => ({ name, file: path, group, calls, selfMs, totalMs, callers: callers.map(([n, c]) => ({ name: n, calls: c })) });
  const root = '/var/www/local.spellbook.example';
  return {
    ...info,
    script: `${root}/index.php`,
    totalMs: info.totalMs ?? 1_840,
    peakBytes: info.peakBytes ?? 48_000_000,
    functionCount: 6_412,
    groups: [
      { group: 'plugin wandworks-builder', selfMs: 820 },
      { group: 'WordPress', selfMs: 510 },
      { group: 'plugin woocommerce', selfMs: 290 },
      { group: 'theme spellbook', selfMs: 160 },
      { group: 'mu-plugin devmagic-panel-local', selfMs: 4 },
      { group: 'PHP', selfMs: 56 },
    ],
    functions: [
      fn('php::preg_match', 'php:internal', 'plugin wandworks-builder', 48_210, 412, 412, [['Wandworks_Builder_Parser->tokens', 47_900], ['wptexturize', 310]]),
      fn('Wandworks_Builder_Parser->tokens', `${root}/wp-content/plugins/wandworks-builder/includes/parser.php`, 'plugin wandworks-builder', 1_604, 214, 702, [['Wandworks_Builder_Parser->parse', 1_604]]),
      fn('php::unserialize', 'php:internal', 'WordPress', 9_840, 166, 166, [['maybe_unserialize', 9_840]]),
      fn('WC_Product_Data_Store_CPT->read', `${root}/wp-content/plugins/woocommerce/includes/data-stores/class-wc-product-data-store-cpt.php`, 'plugin woocommerce', 48, 121, 388, [['WC_Data_Store->read', 48]]),
      fn('wpdb->query', `${root}/wp-includes/class-wpdb.php`, 'WordPress', 312, 98, 274, [['wpdb->get_results', 190], ['wpdb->get_var', 80]]),
      fn('spellbook_related_products', `${root}/wp-content/themes/spellbook/inc/shop.php`, 'theme spellbook', 12, 74, 640, [['{closure:/wp-content/themes/spellbook/woocommerce/single-product.php:12}', 12]]),
      fn('apply_filters', `${root}/wp-includes/plugin.php`, 'WordPress', 21_480, 61, 1_310, [['WP_Hook->apply_filters', 21_480]]),
    ],
  };
}

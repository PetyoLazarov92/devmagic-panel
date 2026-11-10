import type { Site, WpDebugConstant } from '@devmagic-panel/shared';
import { WP_DEBUG_CONSTANTS, WP_DEBUG_DEFAULTS } from '@devmagic-panel/shared';
import type { TabItem } from '../components/ui/tabs.js';

export type Tab = 'overview' | 'logs' | 'network' | 'plugins' | 'database' | 'performance' | 'cron' | 'config' | 'php' | 'domains';

/** What a tab's badge counts: only what needs a look, never how many things a tab lists. */
export interface TabCounts {
  logs: number;
  cron: number;
  config: number;
  domains: number;
}

const NO_COUNTS: TabCounts = { logs: 0, cron: 0, config: 0, domains: 0 };

/**
 * The tabs a site has, always in this order, in three groups: Overview and Logs; WordPress, its data and its speed; the
 * server, set once. Plugins, Cron and PHP need WordPress, Network a multisite, Database a database, Config
 * wp-config.php; a site under a path shares its parent's domains. A tab a site lacks leaves the rest in place.
 */
export function siteTabItems(site: Site, counts: TabCounts = NO_COUNTS): TabItem<Tab>[] {
  const wordpress = site.core.kind !== 'none';
  const badge = (count: number, tone: 'warning' | 'danger') => (count > 0 ? { count, tone } : {});
  const groups: Array<Array<TabItem<Tab> | false>> = [
    [{ value: 'overview', label: 'Overview' }, { value: 'logs', label: 'Logs', ...badge(counts.logs, 'danger') }],
    [
      site.network ? { value: 'network', label: 'Network' } : false,
      wordpress && { value: 'plugins', label: 'Plugins and themes' },
      site.db ? { value: 'database', label: 'Database' } : false,
      wordpress || site.db ? { value: 'performance', label: 'Performance' } : false,
      wordpress && { value: 'cron', label: 'Cron', ...badge(counts.cron, 'warning') },
      site.constants ? { value: 'config', label: 'Config', ...badge(counts.config, 'warning') } : false,
    ],
    // The web server and PHP in one tab: moving to nginx changes how PHP runs, so they are read together.
    [(wordpress || !site.path) && { value: 'php', label: wordpress ? 'Server and PHP' : 'Server' }, !site.path && { value: 'domains', label: 'Domains and SSL', ...badge(counts.domains, 'warning') }],
  ];
  return groups
    .map((group) => group.filter((item): item is TabItem<Tab> => Boolean(item)))
    .filter((group) => group.length > 0)
    .flatMap((group, i) => group.map((item, j) => (i > 0 && j === 0 ? { ...item, startsGroup: true } : item)));
}

/** The names of a site that its certificate or the hosts file leaves out. */
export function uncoveredNames(site: Site): string[] {
  const inCert = new Set(site.cert?.names ?? []);
  const missingHosts = new Set(site.notInHosts ?? []);
  return [site.domain, ...site.aliases].filter((n) => !inCert.has(n) || missingHosts.has(n));
}

/** The debug constants as WordPress reads them: wp-config.php's value, or WordPress's default. */
export function debugValues(site: Site): Record<WpDebugConstant, boolean> {
  return Object.fromEntries(WP_DEBUG_CONSTANTS.map((n) => [n, site.debug.constants[n] ?? WP_DEBUG_DEFAULTS[n]])) as Record<WpDebugConstant, boolean>;
}

/** Where WordPress sends its errors, in a few words. */
export function debugLabel(site: Site): string {
  if (!site.debug.enabled) return 'Off';
  const d = debugValues(site);
  if (d.WP_DEBUG_LOG && !d.WP_DEBUG_DISPLAY) return 'Log only';
  if (d.WP_DEBUG_LOG) return 'Log and page';
  return d.WP_DEBUG_DISPLAY ? 'On the page' : 'On, not shown';
}

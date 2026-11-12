import type { Site } from '@devmagic-panel/shared';
import { SITE_SERVER_LABEL } from '@devmagic-panel/shared';
import { siteHref } from '@/lib/site-ref';
import { Clock, Database, FolderOpen, Gauge, Globe, LayoutDashboard, Network, Puzzle, ScrollText, Server, SlidersHorizontal } from 'lucide-react';
import { type Tab } from '@/lib/site-tabs';

export const tabHref = (site: { domain: string; path?: string }, tab: Tab, extra = '') => `${siteHref(site)}${tab === 'overview' ? '' : `?tab=${tab}${extra}`}`;
export type NetworkSite = NonNullable<Site['network']>['sites'][number];

export const SERVER_NAME = SITE_SERVER_LABEL;

/** The icon of each of a site's sections in its side menu. */
export const SITE_TAB_ICONS: Record<Tab, typeof Server> = {
  overview: LayoutDashboard,
  logs: ScrollText,
  files: FolderOpen,
  network: Network,
  plugins: Puzzle,
  database: Database,
  performance: Gauge,
  cron: Clock,
  config: SlidersHorizontal,
  php: Server,
  domains: Globe,
};

import type { Site } from '@devmagic-panel/shared';
import { SITE_SERVER_LABEL } from '@devmagic-panel/shared';
import { siteHref } from '@/lib/site-ref';
import { type Tab } from '@/lib/site-tabs';

export const tabHref = (site: { domain: string; path?: string }, tab: Tab, extra = '') => `${siteHref(site)}${tab === 'overview' ? '' : `?tab=${tab}${extra}`}`;
export type NetworkSite = NonNullable<Site['network']>['sites'][number];

export const SERVER_NAME = SITE_SERVER_LABEL;

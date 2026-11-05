import type { Site } from '@devmagic-panel/shared';

/**
 * A site is its domain, plus a path when it is a WordPress install under a
 * path of that domain (like /learn on local.northwind.com).
 */
type SiteId = Pick<Site, 'domain' | 'path'>;

/** The fields a WordPress-level action takes to find the site. */
export const siteTarget = (site: SiteId) => ({ domain: site.domain, ...(site.path ? { path: site.path } : {}) });

/** local.northwind.com, or local.northwind.com/learn. */
export const siteName = (site: SiteId) => `${site.domain}${site.path ?? ''}`;

/** The site's page: /sites/local.northwind.com, or /sites/local.northwind.com/learn. */
export const siteHref = (site: SiteId) =>
  `/sites/${encodeURIComponent(site.domain)}${site.path ? `/${encodeURIComponent(site.path.slice(1))}` : ''}`;

/** The site a name like local.northwind.com/learn stands for. */
export function siteFromName(name: string): SiteId {
  const slash = name.indexOf('/');
  return slash < 0 ? { domain: name } : { domain: name.slice(0, slash), path: name.slice(slash) };
}

export const sameSite = (a: SiteId, b: SiteId) => a.domain === b.domain && a.path === b.path;

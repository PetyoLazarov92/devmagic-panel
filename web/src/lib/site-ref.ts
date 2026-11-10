import type { Site } from '@devmagic-panel/shared';

/**
 * A site is its domain, plus a path when it is a WordPress install under a
 * path of that domain (like /learn on local.spellbook.example).
 */
type SiteId = Pick<Site, 'domain' | 'path'>;

/** The fields a WordPress-level action takes to find the site. */
export const siteTarget = (site: SiteId) => ({ domain: site.domain, ...(site.path ? { path: site.path } : {}) });

/** local.spellbook.example, or local.spellbook.example/learn. */
export const siteName = (site: SiteId) => `${site.domain}${site.path ?? ''}`;

/** The site's page: /sites/local.spellbook.example, or /sites/local.spellbook.example/learn. */
export const siteHref = (site: SiteId) =>
  `/sites/${encodeURIComponent(site.domain)}${site.path ? `/${encodeURIComponent(site.path.slice(1))}` : ''}`;

/** A site made by hand: its Overview with the takeover dialog open, so the panel can manage its vhost. */
export const takeoverHref = (site: SiteId) => `${siteHref({ domain: site.domain })}?tab=overview&takeover=1`;

/** What to say where a vhost made by hand stops something. */
export const TAKEOVER_HINT = 'Take it over to let the panel manage its vhost';

/** The site a name like local.spellbook.example/learn stands for. */
export function siteFromName(name: string): SiteId {
  const slash = name.indexOf('/');
  return slash < 0 ? { domain: name } : { domain: name.slice(0, slash), path: name.slice(slash) };
}

export const sameSite = (a: SiteId, b: SiteId) => a.domain === b.domain && a.path === b.path;

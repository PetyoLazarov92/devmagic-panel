/**
 * A multisite network from a dump, set up here as a subdirectory or a
 * subdomain network, in WordPress's words. The dump says where each site is;
 * the wizard suggests where it goes here, and the install moves the sites
 * whose address changes, after the replace.
 */

/**
 * Subdirectory: every site under a path of one domain (local.wandworks.example/shop/).
 * Subdomain: every site on a host of its own, a subdomain or a domain mapped
 * to it (local.shop.wandworks.example, local.shop.com).
 */
export type NetworkLayout = 'subdirectory' | 'subdomain';

/** A site of the network as the dump lists it. */
export interface NetworkSite {
  id: number;
  domain: string;
  path: string;
  name?: string;
}

/** Where a site of the network answers here. */
export interface SiteAddress {
  domain: string;
  path: string;
}

/** A path for a site of a network: / or segments that each end with a slash, like /shop/ or /eu/shop/. */
export const NETWORK_PATH = /^\/(?:[a-z0-9_-]+\/)*$/;

/** The main site: blog 1, which WordPress makes first and keeps at the network's own address. */
export const isMainSite = (site: Pick<NetworkSite, 'id'>) => site.id === 1;

/**
 * What a network is by where its sites are, the main site aside: subdirectory
 * when all are under paths, subdomain when all are on hosts of their own,
 * mixed when some are each; null for a network with the main site only.
 * SUBDOMAIN_INSTALL says only where new sites go, so a network of mapped
 * domains with it off is still a subdomain network here.
 */
export function networkType(sites: ReadonlyArray<Pick<NetworkSite, 'id' | 'path'>>): NetworkLayout | 'mixed' | null {
  const others = sites.filter((s) => !isMainSite(s));
  if (others.length === 0) return null;
  const underPath = others.filter((s) => s.path !== '/').length;
  return underPath === others.length ? 'subdirectory' : underPath === 0 ? 'subdomain' : 'mixed';
}

/** How the dump has its sites: subdirectory when most are under paths, subdomain otherwise. */
export function dumpLayout(sites: NetworkSite[]): NetworkLayout {
  const others = sites.filter((s) => !isMainSite(s));
  const underPath = others.filter((s) => s.path !== '/').length;
  return underPath > others.length - underPath ? 'subdirectory' : 'subdomain';
}

/** The first label of a host, without www. or local.: shop.wandworks.example gives shop. */
function hostSlug(host: string): string {
  return host.replace(/^(?:www\.|local\.)/, '').split('.')[0]?.replace(/[^a-z0-9-]/g, '') || 'site';
}

/** The last segment of a path: /eu/shop/ gives shop. */
function pathSlug(path: string): string {
  return path.split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'site';
}

/**
 * Where each site goes here for a layout, as a suggestion. `mapHost` is the
 * replace: the local name a dump's host becomes; `served` says whether a local
 * name is one of the site's domains here. The main site stays at the main
 * domain; a site already where the layout wants it stays there. Under paths, a
 * site under a path of a domain of its own (WordPress's domain mapping) keeps
 * that domain and path when the domain has a local address, as in production;
 * one without goes under the main domain. A site at the root of its own domain
 * still goes under a path: keeping those is what Keep is for.
 */
export function suggestAddresses(
  sites: NetworkSite[],
  layout: NetworkLayout,
  main: string,
  mapHost: (host: string) => string,
  networkPath = '/',
  served: (host: string) => boolean = () => false,
): Map<number, SiteAddress> {
  const tld = main.split('.').at(-1) ?? 'test';
  const out = new Map<number, SiteAddress>();
  for (const s of sites) {
    const domain = mapHost(s.domain);
    if (isMainSite(s)) out.set(s.id, { domain: main, path: networkPath });
    else if (layout === 'subdirectory' && s.path !== '/' && domain !== main && served(domain)) out.set(s.id, { domain, path: s.path });
    else if (layout === 'subdirectory') out.set(s.id, { domain: main, path: s.path !== '/' && domain === main ? s.path : `/${s.path !== '/' ? pathSlug(s.path) : hostSlug(s.domain)}/` });
    else out.set(s.id, s.path === '/' ? { domain, path: '/' } : { domain: `local.${pathSlug(s.path)}.${tld}`, path: '/' });
  }
  return out;
}

/** A site that moves: where the dump has it, where the replace would leave it, and where it goes here. */
export interface NetworkMove {
  id: number;
  dump: SiteAddress;
  from: SiteAddress;
  to: SiteAddress;
}

/** The sites whose address here differs from where the replace leaves them, the longest address first. */
export function networkMoves(sites: NetworkSite[], targets: ReadonlyArray<{ id: number } & SiteAddress>, mapHost: (host: string) => string): NetworkMove[] {
  const moves: NetworkMove[] = [];
  for (const t of targets) {
    const site = sites.find((s) => s.id === t.id);
    if (!site || isMainSite(site)) continue;
    const from = { domain: mapHost(site.domain), path: site.path };
    if (from.domain !== t.domain || from.path !== t.path) moves.push({ id: t.id, dump: { domain: site.domain, path: site.path }, from, to: { domain: t.domain, path: t.path } });
  }
  return moves.sort((a, b) => b.from.domain.length + b.from.path.length - (a.from.domain.length + a.from.path.length));
}

/** The replace as a function: a dump's host to the local name a pair gives it, else itself. */
export const hostMapper = (pairs: ReadonlyArray<{ from: string; to: string }>) => (host: string) => pairs.find((p) => p.from === host)?.to ?? host;

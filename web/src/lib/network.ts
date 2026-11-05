import type { DumpFacts, NetworkLayout, NetworkSite, SiteAddress } from '@devmagic-panel/shared';
import { dumpLayout, hostMapper, isLocalName, isMainSite, NETWORK_PATH, networkMoves, networkType, suggestAddresses } from '@devmagic-panel/shared';

/** How a network runs here: one of WordPress's two types, or each site kept where the dump has it (for a mixed network). */
export type NetworkChoice = NetworkLayout | 'keep';

/** Your answers for a network: its layout here (null: the dump's) and the addresses you typed, by blog id. */
export interface NetworkAnswers {
  layout: NetworkChoice | null;
  domains: Record<string, string>;
  paths: Record<string, string>;
}

export const NO_NETWORK_ANSWERS: NetworkAnswers = { layout: null, domains: {}, paths: {} };

export interface NetworkRow {
  site: NetworkSite;
  /** Where it is in the dump. */
  dump: SiteAddress;
  here: SiteAddress;
  main: boolean;
  moves: boolean;
  /** Same: the dump's address as it is. Host: only its host is replaced. Moves: it goes to another address. */
  status: 'same' | 'host' | 'moves';
  error?: string;
}

export interface NetworkPlan {
  layout: NetworkChoice;
  dumpLayout: NetworkLayout;
  /** Sites under paths and sites on their own hosts both: keeping each where it is can be chosen. */
  mixed: boolean;
  rows: NetworkRow[];
  moves: ReturnType<typeof networkMoves>;
  /** How many sites each choice moves, with what you typed for it. */
  movesFor: Record<NetworkChoice, number>;
}

/** A path as typed, as a network keeps it: shop, /shop or Shop/ all give /shop/. */
export function cleanSitePath(text: string): string {
  const parts = text.trim().toLowerCase().split('/').map((p) => p.trim().replace(/\s+/g, '-')).filter(Boolean);
  return `/${parts.map((p) => `${p}/`).join('')}`;
}

/**
 * The network of a dump as it will run here: each site's address for the
 * layout you chose (the dump's until you choose), your typed addresses over
 * the suggestions, what is wrong with any, and the sites that move. Null for
 * a dump with no network of two sites or more, or one a domain mapping plugin
 * serves.
 */
export function networkPlan(facts: DumpFacts | undefined, answers: NetworkAnswers, main: string, replace: ReadonlyArray<{ from: string; to: string }>, locals: readonly string[] = []): NetworkPlan | null {
  const sites = facts?.multisite ? (facts.sites ?? []) : [];
  // A domain mapping plugin serves the sites at the domains in its own table: they stay as they are.
  if (sites.length < 2 || !main || facts?.domainMapping) return null;
  const mapHost = hostMapper(replace);
  const fromDump = dumpLayout(sites);
  const mixed = networkType(sites) === 'mixed';
  // A mixed network starts as it is; the others start as the dump has them.
  const layout = answers.layout === 'keep' && !mixed ? fromDump : (answers.layout ?? (mixed ? 'keep' : fromDump));
  const networkPath = facts?.networkPath ?? '/';
  /** Where each site goes for a choice: kept where the replace leaves it, or the suggestion with what you typed. */
  const addressesFor = (choice: NetworkChoice): Map<number, SiteAddress> => {
    if (choice === 'keep') return new Map(sites.map((s) => [s.id, isMainSite(s) ? { domain: main, path: networkPath } : { domain: mapHost(s.domain), path: s.path }]));
    // The site's local domains: a mapped site whose domain is one of them keeps it.
    const served = new Set([...locals, ...replace.map((p) => p.to)]);
    const suggested = suggestAddresses(sites, choice, main, mapHost, networkPath, (host) => served.has(host));
    return new Map(sites.map((site) => {
      const typed = isMainSite(site) ? undefined : choice === 'subdomain' ? answers.domains[site.id] : answers.paths[site.id];
      // A path typed in keeps the site's domain: the main one, or its own when it keeps it.
      const here = typed === undefined ? (suggested.get(site.id) as SiteAddress) : choice === 'subdomain' ? { domain: typed.trim().toLowerCase(), path: '/' } : { domain: suggested.get(site.id)?.domain ?? main, path: cleanSitePath(typed) };
      return [site.id, here];
    }));
  };
  const movesOf = (addresses: Map<number, SiteAddress>) => networkMoves(sites, sites.map((s) => ({ id: s.id, ...(addresses.get(s.id) as SiteAddress) })), mapHost);
  const chosen = addressesFor(layout);
  const rows: NetworkRow[] = sites.map((site) => ({ site, dump: { domain: site.domain, path: site.path }, here: chosen.get(site.id) as SiteAddress, main: isMainSite(site), moves: false, status: 'same' }));
  const count = new Map<string, number>();
  for (const r of rows) count.set(`${r.here.domain}${r.here.path}`, (count.get(`${r.here.domain}${r.here.path}`) ?? 0) + 1);
  for (const r of rows) {
    if (!isLocalName(r.here.domain)) r.error = 'Use a local name: local.example.com, *.test or *.localhost';
    else if (!NETWORK_PATH.test(r.here.path)) r.error = 'A path like /shop/: letters, digits, - and _';
    else if ((count.get(`${r.here.domain}${r.here.path}`) ?? 0) > 1) r.error = 'Another site of the network has this address';
  }
  const moves = movesOf(chosen);
  for (const r of rows) {
    r.moves = moves.some((m) => m.id === r.site.id);
    r.status = r.moves ? 'moves' : r.here.domain === r.dump.domain && r.here.path === r.dump.path ? 'same' : 'host';
  }
  const movesFor = { subdirectory: movesOf(addressesFor('subdirectory')).length, subdomain: movesOf(addressesFor('subdomain')).length, keep: 0 };
  return { layout, dumpLayout: fromDump, mixed, rows, moves, movesFor };
}

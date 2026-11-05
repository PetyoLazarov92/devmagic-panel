import type { NetworkMove } from './network.js';

/**
 * Every address of a dump changed to where it answers here, in one pass per
 * address: a production host to its local name, a site of a network that
 * moves to its address here, path included, and http to https in the same
 * pass. Each pair runs plain and as JSON escapes slashes, the longest address
 * first, so //shop.com never touches //shop.com.br and a site's path goes
 * before its host. An address that stays the same gets no pass, and http gets
 * one only where the dump has http links for that host.
 */

export interface AddressInput {
  /** Production hosts to their local names, from the Domains step; pairs that stay the same are left out. */
  hosts: ReadonlyArray<{ from: string; to: string }>;
  /** The network's sites that move. */
  moves: ReadonlyArray<NetworkMove>;
  /** The local names the site answers on, so their own http links become https. */
  locals: readonly string[];
  /** The hosts the dump has http:// links for; undefined when the scan did not read it all, so every host gets its https pass. */
  httpHosts: readonly string[] | undefined;
}

/** One search-replace: what is searched and what it becomes. */
export type AddressPass = readonly [search: string, replace: string];

const escaped = (text: string) => text.replaceAll('/', '\\/');
const hostOf = (address: string) => address.split('/')[0] as string;

/** The passes, in the order they run. */
export function addressPasses({ hosts, moves, locals, httpHosts }: AddressInput): AddressPass[] {
  const entries: Array<{ from: string; to: string }> = [
    ...moves.map((m) => ({ from: `${m.dump.domain}${m.dump.path}`, to: `${m.to.domain}${m.to.path}` })),
    ...hosts.filter((h) => h.from !== h.to),
  ];
  // A local name that is not already a target only needs its own http links made https.
  for (const name of locals) if (!entries.some((e) => e.from === name)) entries.push({ from: name, to: name });
  entries.sort((a, b) => b.from.length - a.from.length);
  const http = (host: string) => httpHosts === undefined || httpHosts.includes(host);
  const passes: AddressPass[] = [];
  for (const { from, to } of entries) {
    if (http(hostOf(from))) passes.push([`http://${from}`, `https://${to}`], [escaped(`http://${from}`), escaped(`https://${to}`)]);
    if (from !== to) passes.push([`//${from}`, `//${to}`], [escaped(`//${from}`), escaped(`//${to}`)]);
  }
  return passes;
}

/** What the replace step does, for its label and the Review step: "replace 2 domains, move 3 sites to subdomains and use https, 10 passes". */
export function addressSummary(input: AddressInput, layout?: 'subdirectory' | 'subdomain'): string | null {
  const all = addressPasses(input);
  const passes = all.length;
  if (passes === 0 && input.moves.length === 0) return null;
  const hosts = input.hosts.filter((h) => h.from !== h.to).length;
  const parts = [
    hosts ? `replace ${hosts} domain${hosts === 1 ? '' : 's'}` : '',
    input.moves.length ? `move ${input.moves.length} site${input.moves.length === 1 ? '' : 's'}${layout ? ` to ${layout === 'subdirectory' ? 'subdirectories' : 'subdomains'}` : ''}` : '',
    all.some(([search]) => search.startsWith('http://')) ? 'use https' : '',
  ].filter(Boolean);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}, ${passes} pass${passes === 1 ? '' : 'es'}`;
}

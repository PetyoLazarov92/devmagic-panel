import { describe, expect, it } from 'vitest';
import { dumpLayout, hostMapper, networkMoves, networkType, suggestAddresses } from '../src/network.js';

// A local copy under paths, as a team keeps it, and the same network from production on its own domains.
const underPaths = [
  { id: 1, domain: 'local.wandworks-group.example', path: '/' },
  { id: 3, domain: 'local.wandworks-group.example', path: '/wandworks-repairs/' },
  { id: 10, domain: 'local.wandworks-group.example', path: '/wandworks-cleaning/' },
];
const ownDomains = [
  { id: 1, domain: 'wandworks-group.example', path: '/' },
  { id: 3, domain: 'wandworksrepairs.example', path: '/' },
  { id: 10, domain: 'www.wandworkscleaning.example', path: '/' },
];
const same = (host: string) => host;

describe('a network from a dump', () => {
  it('is a subdirectory, subdomain or mixed network by where its sites are, the main site aside', () => {
    expect(networkType(underPaths)).toBe('subdirectory');
    expect(networkType(ownDomains)).toBe('subdomain');
    expect(networkType([...ownDomains, { id: 4, path: '/blog/' }])).toBe('mixed');
    expect(networkType([{ id: 1, path: '/' }])).toBeNull();
  });

  it('tells its layout by where most of its sites are', () => {
    expect(dumpLayout(underPaths)).toBe('subdirectory');
    expect(dumpLayout(ownDomains)).toBe('subdomain');
    expect(dumpLayout([...ownDomains, { id: 4, domain: 'wandworks-group.example', path: '/blog/' }])).toBe('subdomain');
  });

  it('suggests a domain per site from its path, and keeps one already on its own domain', () => {
    const domains = suggestAddresses(underPaths, 'subdomain', 'local.wandworks-group.example', same);
    expect([...domains.values()]).toEqual([
      { domain: 'local.wandworks-group.example', path: '/' },
      { domain: 'local.wandworks-repairs.example', path: '/' },
      { domain: 'local.wandworks-cleaning.example', path: '/' },
    ]);
    const replace = hostMapper([{ from: 'wandworksrepairs.example', to: 'local.wandworksrepairs.example' }]);
    expect(suggestAddresses(ownDomains, 'subdomain', 'local.wandworks-group.example', replace).get(3)).toEqual({ domain: 'local.wandworksrepairs.example', path: '/' });
  });

  it('suggests a path per site from its domain, and keeps one already under a path of the main domain', () => {
    const paths = suggestAddresses(ownDomains, 'subdirectory', 'local.wandworks-group.example', same);
    expect([...paths.values()]).toEqual([
      { domain: 'local.wandworks-group.example', path: '/' },
      { domain: 'local.wandworks-group.example', path: '/wandworksrepairs/' },
      { domain: 'local.wandworks-group.example', path: '/wandworkscleaning/' },
    ]);
    expect(suggestAddresses(underPaths, 'subdirectory', 'local.wandworks-group.example', same).get(10)).toEqual({ domain: 'local.wandworks-group.example', path: '/wandworks-cleaning/' });
  });

  it('keeps a site mapped to a domain of its own on that domain and path when the domain has a local address here', () => {
    const mapped = [
      { id: 1, domain: 'wandworks-group.example', path: '/' },
      { id: 2, domain: 'wandworks-group.example', path: '/uk/bristol/' },
      { id: 21, domain: 'manage.wandworks-group.example', path: '/test/' },
      { id: 22, domain: 'old.wandworks-group.example', path: '/gone/' },
    ];
    const replace = hostMapper([
      { from: 'wandworks-group.example', to: 'local.wandworks-group.example' },
      { from: 'manage.wandworks-group.example', to: 'local.manage.wandworks-group.example' },
    ]);
    const served = (host: string) => ['local.wandworks-group.example', 'local.manage.wandworks-group.example'].includes(host);
    const here = suggestAddresses(mapped, 'subdirectory', 'local.wandworks-group.example', replace, '/', served);
    expect([...here.entries()]).toEqual([
      [1, { domain: 'local.wandworks-group.example', path: '/' }],
      [2, { domain: 'local.wandworks-group.example', path: '/uk/bristol/' }],
      // Mapped in production and served here: it stays as it is.
      [21, { domain: 'local.manage.wandworks-group.example', path: '/test/' }],
      // Its domain has no local address: it moves under the main domain.
      [22, { domain: 'local.wandworks-group.example', path: '/gone/' }],
    ]);
    expect(networkMoves(mapped, [...here].map(([id, a]) => ({ id, ...a })), replace).map((m) => m.id)).toEqual([22]);
  });

  it('moves only the sites whose address changes, never the main site, the longest first', () => {
    const targets = [
      { id: 1, domain: 'local.elsewhere.com', path: '/' },
      { id: 3, domain: 'local.wandworks-repairs.example', path: '/' },
      { id: 10, domain: 'local.wandworks-cleaning.example', path: '/' },
    ];
    expect(networkMoves(underPaths, targets, same)).toEqual([
      { id: 10, dump: { domain: 'local.wandworks-group.example', path: '/wandworks-cleaning/' }, from: { domain: 'local.wandworks-group.example', path: '/wandworks-cleaning/' }, to: { domain: 'local.wandworks-cleaning.example', path: '/' } },
      { id: 3, dump: { domain: 'local.wandworks-group.example', path: '/wandworks-repairs/' }, from: { domain: 'local.wandworks-group.example', path: '/wandworks-repairs/' }, to: { domain: 'local.wandworks-repairs.example', path: '/' } },
    ]);
    // The layout the dump already has: nothing moves.
    expect(networkMoves(underPaths, [...suggestAddresses(underPaths, 'subdirectory', 'local.wandworks-group.example', same)].map(([id, a]) => ({ id, ...a })), same)).toEqual([]);
  });
});

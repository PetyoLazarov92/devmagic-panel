import { describe, expect, it } from 'vitest';
import { dumpLayout, hostMapper, networkMoves, networkType, suggestAddresses } from '../src/network.js';

// A local copy under paths, as a team keeps it, and the same network from production on its own domains.
const underPaths = [
  { id: 1, domain: 'local.acme-group.com', path: '/' },
  { id: 3, domain: 'local.acme-group.com', path: '/acme-repairs/' },
  { id: 10, domain: 'local.acme-group.com', path: '/north-cleanup/' },
];
const ownDomains = [
  { id: 1, domain: 'acme-group.com', path: '/' },
  { id: 3, domain: 'acmerepairs.com', path: '/' },
  { id: 10, domain: 'www.northcleanup.com', path: '/' },
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
    expect(dumpLayout([...ownDomains, { id: 4, domain: 'acme-group.com', path: '/blog/' }])).toBe('subdomain');
  });

  it('suggests a domain per site from its path, and keeps one already on its own domain', () => {
    const domains = suggestAddresses(underPaths, 'subdomain', 'local.acme-group.com', same);
    expect([...domains.values()]).toEqual([
      { domain: 'local.acme-group.com', path: '/' },
      { domain: 'local.acme-repairs.com', path: '/' },
      { domain: 'local.north-cleanup.com', path: '/' },
    ]);
    const replace = hostMapper([{ from: 'acmerepairs.com', to: 'local.acmerepairs.com' }]);
    expect(suggestAddresses(ownDomains, 'subdomain', 'local.acme-group.com', replace).get(3)).toEqual({ domain: 'local.acmerepairs.com', path: '/' });
  });

  it('suggests a path per site from its domain, and keeps one already under a path of the main domain', () => {
    const paths = suggestAddresses(ownDomains, 'subdirectory', 'local.acme-group.com', same);
    expect([...paths.values()]).toEqual([
      { domain: 'local.acme-group.com', path: '/' },
      { domain: 'local.acme-group.com', path: '/acmerepairs/' },
      { domain: 'local.acme-group.com', path: '/northcleanup/' },
    ]);
    expect(suggestAddresses(underPaths, 'subdirectory', 'local.acme-group.com', same).get(10)).toEqual({ domain: 'local.acme-group.com', path: '/north-cleanup/' });
  });

  it('keeps a site mapped to a domain of its own on that domain and path when the domain has a local address here', () => {
    const mapped = [
      { id: 1, domain: 'acme-group.com', path: '/' },
      { id: 2, domain: 'acme-group.com', path: '/uk/bristol/' },
      { id: 21, domain: 'manage.acme-group.com', path: '/test/' },
      { id: 22, domain: 'old.acme-group.com', path: '/gone/' },
    ];
    const replace = hostMapper([
      { from: 'acme-group.com', to: 'local.acme-group.com' },
      { from: 'manage.acme-group.com', to: 'local.manage.acme-group.com' },
    ]);
    const served = (host: string) => ['local.acme-group.com', 'local.manage.acme-group.com'].includes(host);
    const here = suggestAddresses(mapped, 'subdirectory', 'local.acme-group.com', replace, '/', served);
    expect([...here.entries()]).toEqual([
      [1, { domain: 'local.acme-group.com', path: '/' }],
      [2, { domain: 'local.acme-group.com', path: '/uk/bristol/' }],
      // Mapped in production and served here: it stays as it is.
      [21, { domain: 'local.manage.acme-group.com', path: '/test/' }],
      // Its domain has no local address: it moves under the main domain.
      [22, { domain: 'local.acme-group.com', path: '/gone/' }],
    ]);
    expect(networkMoves(mapped, [...here].map(([id, a]) => ({ id, ...a })), replace).map((m) => m.id)).toEqual([22]);
  });

  it('moves only the sites whose address changes, never the main site, the longest first', () => {
    const targets = [
      { id: 1, domain: 'local.elsewhere.com', path: '/' },
      { id: 3, domain: 'local.acme-repairs.com', path: '/' },
      { id: 10, domain: 'local.north-cleanup.com', path: '/' },
    ];
    expect(networkMoves(underPaths, targets, same)).toEqual([
      { id: 10, dump: { domain: 'local.acme-group.com', path: '/north-cleanup/' }, from: { domain: 'local.acme-group.com', path: '/north-cleanup/' }, to: { domain: 'local.north-cleanup.com', path: '/' } },
      { id: 3, dump: { domain: 'local.acme-group.com', path: '/acme-repairs/' }, from: { domain: 'local.acme-group.com', path: '/acme-repairs/' }, to: { domain: 'local.acme-repairs.com', path: '/' } },
    ]);
    // The layout the dump already has: nothing moves.
    expect(networkMoves(underPaths, [...suggestAddresses(underPaths, 'subdirectory', 'local.acme-group.com', same)].map(([id, a]) => ({ id, ...a })), same)).toEqual([]);
  });
});

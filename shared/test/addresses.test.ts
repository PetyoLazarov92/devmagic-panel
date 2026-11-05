import { describe, expect, it } from 'vitest';
import { addressPasses, addressSummary } from '../src/addresses.js';
import { hostMapper, networkMoves, suggestAddresses, type NetworkSite } from '../src/network.js';

const local: NetworkSite[] = [
  { id: 1, domain: 'local.acme-group.com', path: '/' },
  { id: 3, domain: 'local.acme-group.com', path: '/repairs/' },
];
const production: NetworkSite[] = [
  { id: 1, domain: 'acme-group.com', path: '/' },
  { id: 3, domain: 'acmerepairs.com', path: '/' },
];
const targets = (sites: NetworkSite[], layout: 'subdirectory' | 'subdomain', map: (h: string) => string) =>
  [...suggestAddresses(sites, layout, 'local.acme-group.com', map)].map(([id, a]) => ({ id, ...a }));

describe('the addresses of a dump here', () => {
  it('need no pass at all for a local dump on https whose type is kept', () => {
    const moves = networkMoves(local, targets(local, 'subdirectory', (h) => h), (h) => h);
    const input = { hosts: [], moves, locals: ['local.acme-group.com'], httpHosts: [] };
    expect(addressPasses(input)).toEqual([]);
    expect(addressSummary(input, 'subdirectory')).toBeNull();
  });

  it('replace only the hosts for a production dump whose type is kept, with https only for hosts that have http links', () => {
    const hosts = [{ from: 'acme-group.com', to: 'local.acme-group.com' }, { from: 'acmerepairs.com', to: 'local.acmerepairs.com' }];
    const map = hostMapper(hosts);
    const moves = networkMoves(production, targets(production, 'subdomain', map), map);
    expect(moves).toEqual([]);
    const input = { hosts, moves, locals: ['local.acme-group.com', 'local.acmerepairs.com'], httpHosts: ['acmerepairs.com'] };
    expect(addressPasses(input)).toEqual([
      ['http://acmerepairs.com', 'https://local.acmerepairs.com'],
      ['http:\\/\\/acmerepairs.com', 'https:\\/\\/local.acmerepairs.com'],
      ['//acmerepairs.com', '//local.acmerepairs.com'],
      ['\\/\\/acmerepairs.com', '\\/\\/local.acmerepairs.com'],
      ['//acme-group.com', '//local.acme-group.com'],
      ['\\/\\/acme-group.com', '\\/\\/local.acme-group.com'],
    ]);
    expect(addressSummary(input)).toBe('Replace 2 domains and use https, 6 passes');
  });

  it('move a site and replace its host in one pass each when the type changes', () => {
    const hosts = [{ from: 'acme-group.com', to: 'local.acme-group.com' }];
    const map = hostMapper(hosts);
    const moves = networkMoves(production, targets(production, 'subdirectory', map), map);
    const input = { hosts, moves, locals: ['local.acme-group.com'], httpHosts: [] };
    expect(addressPasses(input).filter(([a]) => !a.includes('\\/'))).toEqual([
      ['//acmerepairs.com/', '//local.acme-group.com/acmerepairs/'],
      ['//acme-group.com', '//local.acme-group.com'],
    ]);
    expect(addressSummary(input, 'subdirectory')).toBe('Replace 1 domain and move 1 site to subdirectories, 4 passes');
  });

  it('give every host its https pass when the scan did not read the whole dump', () => {
    const input = { hosts: [], moves: [], locals: ['local.acme.com', 'www.local.acme.com'], httpHosts: undefined };
    expect(addressPasses(input).map(([a]) => a)).toEqual(['http://www.local.acme.com', 'http:\\/\\/www.local.acme.com', 'http://local.acme.com', 'http:\\/\\/local.acme.com']);
    expect(addressSummary(input)).toBe('Use https, 4 passes');
  });
});

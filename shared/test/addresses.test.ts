import { describe, expect, it } from 'vitest';
import { addressPasses, addressSummary } from '../src/addresses.js';
import { hostMapper, networkMoves, suggestAddresses, type NetworkSite } from '../src/network.js';

const local: NetworkSite[] = [
  { id: 1, domain: 'local.wandworks-group.example', path: '/' },
  { id: 3, domain: 'local.wandworks-group.example', path: '/repairs/' },
];
const production: NetworkSite[] = [
  { id: 1, domain: 'wandworks-group.example', path: '/' },
  { id: 3, domain: 'wandworksrepairs.example', path: '/' },
];
const targets = (sites: NetworkSite[], layout: 'subdirectory' | 'subdomain', map: (h: string) => string) =>
  [...suggestAddresses(sites, layout, 'local.wandworks-group.example', map)].map(([id, a]) => ({ id, ...a }));

describe('the addresses of a dump here', () => {
  it('need no pass at all for a local dump on https whose type is kept', () => {
    const moves = networkMoves(local, targets(local, 'subdirectory', (h) => h), (h) => h);
    const input = { hosts: [], moves, locals: ['local.wandworks-group.example'], httpHosts: [] };
    expect(addressPasses(input)).toEqual([]);
    expect(addressSummary(input, 'subdirectory')).toBeNull();
  });

  it('replace only the hosts for a production dump whose type is kept, with https only for hosts that have http links', () => {
    const hosts = [{ from: 'wandworks-group.example', to: 'local.wandworks-group.example' }, { from: 'wandworksrepairs.example', to: 'local.wandworksrepairs.example' }];
    const map = hostMapper(hosts);
    const moves = networkMoves(production, targets(production, 'subdomain', map), map);
    expect(moves).toEqual([]);
    const input = { hosts, moves, locals: ['local.wandworks-group.example', 'local.wandworksrepairs.example'], httpHosts: ['wandworksrepairs.example'] };
    expect(addressPasses(input)).toEqual([
      ['http://wandworksrepairs.example', 'https://local.wandworksrepairs.example'],
      ['http:\\/\\/wandworksrepairs.example', 'https:\\/\\/local.wandworksrepairs.example'],
      ['//wandworksrepairs.example', '//local.wandworksrepairs.example'],
      ['\\/\\/wandworksrepairs.example', '\\/\\/local.wandworksrepairs.example'],
      ['//wandworks-group.example', '//local.wandworks-group.example'],
      ['\\/\\/wandworks-group.example', '\\/\\/local.wandworks-group.example'],
    ]);
    expect(addressSummary(input)).toBe('Replace 2 domains and use https, 6 passes');
  });

  it('move a site and replace its host in one pass each when the type changes', () => {
    const hosts = [{ from: 'wandworks-group.example', to: 'local.wandworks-group.example' }];
    const map = hostMapper(hosts);
    const moves = networkMoves(production, targets(production, 'subdirectory', map), map);
    const input = { hosts, moves, locals: ['local.wandworks-group.example'], httpHosts: [] };
    expect(addressPasses(input).filter(([a]) => !a.includes('\\/'))).toEqual([
      ['//wandworksrepairs.example/', '//local.wandworks-group.example/wandworksrepairs/'],
      ['//wandworks-group.example', '//local.wandworks-group.example'],
    ]);
    expect(addressSummary(input, 'subdirectory')).toBe('Replace 1 domain and move 1 site to subdirectories, 4 passes');
  });

  it('give every host its https pass when the scan did not read the whole dump', () => {
    const input = { hosts: [], moves: [], locals: ['local.wandworks.example', 'www.local.wandworks.example'], httpHosts: undefined };
    expect(addressPasses(input).map(([a]) => a)).toEqual(['http://www.local.wandworks.example', 'http:\\/\\/www.local.wandworks.example', 'http://local.wandworks.example', 'http:\\/\\/local.wandworks.example']);
    expect(addressSummary(input)).toBe('Use https, 4 passes');
  });
});

import type { DumpFacts } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { cleanSitePath, NO_NETWORK_ANSWERS, networkPlan } from '../src/lib/network.js';

// A team's local copy of a network, its sites under paths of one domain.
const facts: DumpFacts = {
  multisite: true, partial: false, hosts: ['local.acme-group.com'], networkPath: '/',
  sites: [
    { id: 1, domain: 'local.acme-group.com', path: '/', name: 'Acme Group' },
    { id: 3, domain: 'local.acme-group.com', path: '/acme-repairs/', name: 'Acme Repairs' },
    { id: 10, domain: 'local.acme-group.com', path: '/north-cleanup/', name: 'North Cleanup' },
  ],
};
const main = 'local.acme-group.com';

describe('the network on the Domains step', () => {
  it('starts as the dump has it, with nothing to move', () => {
    const plan = networkPlan(facts, NO_NETWORK_ANSWERS, main, []);
    expect(plan).toMatchObject({ layout: 'subdirectory', dumpLayout: 'subdirectory', moves: [] });
    expect(plan?.rows.map((r) => `${r.here.domain}${r.here.path}`)).toEqual(['local.acme-group.com/', 'local.acme-group.com/acme-repairs/', 'local.acme-group.com/north-cleanup/']);
  });

  it('moves every site but the main one to a domain of its own, with what you typed over the suggestion', () => {
    const plan = networkPlan(facts, { layout: 'subdomain', domains: { 10: 'Local.NorthCleanup.com ' }, paths: {} }, main, []);
    expect(plan?.rows.map((r) => r.here.domain)).toEqual(['local.acme-group.com', 'local.acme-repairs.com', 'local.northcleanup.com']);
    expect(plan?.moves.map((m) => m.id)).toEqual([10, 3]);
    expect(plan?.rows.every((r) => !r.error)).toBe(true);
  });

  it("keeps a site mapped to a domain of its own when that domain is one of this site's, also with a path typed in", () => {
    const mapped: DumpFacts = { ...facts, sites: [...(facts.sites ?? []), { id: 21, domain: 'local.manage.acme-group.com', path: '/test/', name: 'Test Site' }] };
    const locals = [main, 'local.manage.acme-group.com'];
    const plan = networkPlan(mapped, NO_NETWORK_ANSWERS, main, [], locals);
    expect(plan?.rows.find((r) => r.site.id === 21)?.here).toEqual({ domain: 'local.manage.acme-group.com', path: '/test/' });
    expect(plan?.moves).toEqual([]);
    const typed = networkPlan(mapped, { layout: 'subdirectory', domains: {}, paths: { 21: '/qa/' } }, main, [], locals);
    expect(typed?.rows.find((r) => r.site.id === 21)?.here).toEqual({ domain: 'local.manage.acme-group.com', path: '/qa/' });
    // Not one of this site's domains: it goes under the main one.
    expect(networkPlan(mapped, NO_NETWORK_ANSWERS, main, [], [main])?.rows.find((r) => r.site.id === 21)?.here).toEqual({ domain: main, path: '/test/' });
  });

  it('says what is wrong with an address: not a local name, an odd path, or one another site has', () => {
    const domains = networkPlan(facts, { layout: 'subdomain', domains: { 3: 'acmerepairs.com', 10: 'local.acme-group.com' }, paths: {} }, main, []);
    expect(domains?.rows.map((r) => r.error)).toEqual(['Another site of the network has this address', 'Use a local name: local.example.com, *.test or *.localhost', 'Another site of the network has this address']);
    const taken = networkPlan(facts, { layout: 'subdirectory', domains: {}, paths: { 3: 'north-cleanup' } }, main, []);
    expect(taken?.rows.map((r) => r.error)).toEqual([undefined, 'Another site of the network has this address', 'Another site of the network has this address']);
    const odd = networkPlan(facts, { layout: 'subdirectory', domains: {}, paths: { 10: 'a b!' } }, main, []);
    expect(odd?.rows[2]?.error).toBe('A path like /shop/: letters, digits, - and _');
  });

  it('needs a network of two sites or more and a primary domain', () => {
    expect(networkPlan({ ...facts, sites: (facts.sites ?? []).slice(0, 1) }, NO_NETWORK_ANSWERS, main, [])).toBeNull();
    expect(networkPlan({ ...facts, multisite: false }, NO_NETWORK_ANSWERS, main, [])).toBeNull();
    expect(networkPlan(facts, NO_NETWORK_ANSWERS, '', [])).toBeNull();
  });

  it('says what each type would move, and a status for each site', () => {
    const plan = networkPlan(facts, NO_NETWORK_ANSWERS, main, []);
    expect(plan?.movesFor).toEqual({ subdirectory: 0, subdomain: 2, keep: 0 });
    expect(plan?.rows.map((r) => r.status)).toEqual(['same', 'same', 'same']);
    expect(plan?.mixed).toBe(false);
    const moved = networkPlan(facts, { ...NO_NETWORK_ANSWERS, layout: 'subdomain' }, main, []);
    expect(moved?.rows.map((r) => r.status)).toEqual(['same', 'moves', 'moves']);
  });

  it('keeps each site of a mixed network where it is by default, with only its host replaced', () => {
    const mixed: DumpFacts = {
      ...facts,
      hosts: ['acme-group.com', 'acmerepairs.com'],
      sites: [
        { id: 1, domain: 'acme-group.com', path: '/' },
        { id: 3, domain: 'acmerepairs.com', path: '/' },
        { id: 10, domain: 'acme-group.com', path: '/north-cleanup/' },
      ],
    };
    const replace = [{ from: 'acme-group.com', to: 'local.acme-group.com' }, { from: 'acmerepairs.com', to: 'local.acmerepairs.com' }];
    const plan = networkPlan(mixed, NO_NETWORK_ANSWERS, main, replace);
    expect(plan).toMatchObject({ layout: 'keep', mixed: true, moves: [] });
    expect(plan?.rows.map((r) => `${r.here.domain}${r.here.path}`)).toEqual(['local.acme-group.com/', 'local.acmerepairs.com/', 'local.acme-group.com/north-cleanup/']);
    expect(plan?.rows.map((r) => r.status)).toEqual(['host', 'host', 'host']);
    expect(plan?.movesFor).toEqual({ subdirectory: 1, subdomain: 1, keep: 0 });
    // Keep is only for a mixed network: elsewhere it is the dump's type.
    expect(networkPlan(facts, { ...NO_NETWORK_ANSWERS, layout: 'keep' }, main, [])?.layout).toBe('subdirectory');
  });

  it('keeps a typed path as the network does', () => {
    expect(cleanSitePath('Shop')).toBe('/shop/');
    expect(cleanSitePath('/eu/shop')).toBe('/eu/shop/');
    expect(cleanSitePath(' ')).toBe('/');
  });
});

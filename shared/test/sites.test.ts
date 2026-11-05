import { describe, expect, it } from 'vitest';
import { databaseNameFor, localDomainFor } from '../src/sites.js';

describe('databaseNameFor', () => {
  it.each([
    ['local.northwind.com', 'northwind_com'],
    ['local.learn.northwind.com', 'learn_northwind_com'],
    ['www.local.shop-pms.com', 'shop_pms_com'],
    ['local.northwind.co.jp', 'northwind_co_jp'],
    ['app.test', 'app_test'],
  ])('%s gives %s', (domain, name) => {
    expect(databaseNameFor(domain)).toBe(name);
  });

  it('labels copies with a double underscore', () => {
    expect(databaseNameFor('local.biketours.com', [], 'prod 2026-03-29')).toBe('biketours_com__prod_2026_03_29');
  });

  it('adds a counter when the name is taken', () => {
    expect(databaseNameFor('local.a.com', ['a_com', 'a_com_2'])).toBe('a_com_3');
  });

  it('adds a counter when a MySQL user has the name', () => {
    expect(databaseNameFor('local.a.com', [], undefined, ['a_com'])).toBe('a_com_2');
  });

  it('keeps the user of a long name free of users already there', () => {
    const base = `${'x'.repeat(40)}_com`;
    const name = databaseNameFor(`local.${'x'.repeat(40)}.com`, [], undefined, [base.slice(0, 32)]);
    expect(name).toBe(`${'x'.repeat(30)}_2`);
  });

  it('stays within 64 characters, keeping the start', () => {
    const name = databaseNameFor(`local.${'x'.repeat(80)}.com`, [], 'copy');
    expect(name).toHaveLength(64);
    expect(name.endsWith('__copy')).toBe(true);
  });
});

describe('localDomainFor', () => {
  it.each([
    ['northwind.de', 'local.northwind.de'],
    ['https://www.northwind.com/', 'local.northwind.com'],
    ['local.already.com', 'local.already.com'],
  ])('%s gives %s', (prod, local) => {
    expect(localDomainFor(prod)).toBe(local);
  });
});

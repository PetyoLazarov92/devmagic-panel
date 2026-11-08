import { describe, expect, it } from 'vitest';
import { databaseHref, databaseView } from '../src/lib/database-href.js';

const site = { domain: 'local.wandworks.example' };

describe("the Database tab's views", () => {
  it('opens on Overview where WordPress is, and on Tables where it is not', () => {
    expect(databaseView(null, null, true)).toBe('overview');
    expect(databaseView(null, null, false)).toBe('tables');
  });

  it('keeps an old link to the WordPress view working, and a table always means Tables', () => {
    expect(databaseView('wordpress', null, true)).toBe('overview');
    expect(databaseView('wordpress', null, false)).toBe('tables');
    expect(databaseView(null, 'wp_options', true)).toBe('tables');
    expect(databaseView('tables', null, true)).toBe('tables');
    expect(databaseView('sql', null, true)).toBe('sql');
    expect(databaseView('tools', null, false)).toBe('tools');
  });

  it('writes each view as an address that reads back as the same view', () => {
    expect(databaseHref(site, 'overview')).toBe('/sites/local.wandworks.example?tab=database');
    expect(databaseHref(site, 'overview', undefined, 2)).toBe('/sites/local.wandworks.example?tab=database&blog=2');
    expect(databaseHref(site, 'tables')).toBe('/sites/local.wandworks.example?tab=database&view=tables');
    expect(databaseHref(site, 'tables', { table: 'wp_posts', show: 'structure' })).toBe('/sites/local.wandworks.example?tab=database&table=wp_posts&show=structure');
    expect(databaseHref(site, 'sql')).toBe('/sites/local.wandworks.example?tab=database&view=sql');
  });
});

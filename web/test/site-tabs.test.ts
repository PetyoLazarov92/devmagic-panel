import type { Site, WpDebugConstant } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { debugLabel, siteTabItems, uncoveredNames } from '../src/lib/site-tabs.js';

const OFF: Record<WpDebugConstant, boolean | null> = { WP_DEBUG: false, WP_DEBUG_LOG: null, WP_DEBUG_DISPLAY: null, SCRIPT_DEBUG: null, SAVEQUERIES: null };

// undefined takes a field out, as a site without a database or a certificate has it.
const site = (extra: { [K in keyof Site]?: Site[K] | undefined } = {}): Site => ({
  domain: 'local.acme.com',
  aliases: ['local.acme.de'],
  docroot: '/var/www/local.acme.com',
  vhostManaged: true,
  removable: true,
  panelMade: true,
  core: { kind: 'wpcore', version: '7.1.3' },
  cert: { expiresAt: '2028-05-23T00:00:00Z', names: ['local.acme.com', 'local.acme.de'], issuer: 'new' },
  db: { name: 'acme', sizeBytes: 1000, tables: 12 },
  debug: { enabled: false, logBytes: 0, constants: OFF },
  constants: [],
  health: 'ok',
  issues: [],
  ...extra,
}) as Site;

const values = (s: Site) => siteTabItems(s).map((t) => t.value);

describe('siteTabItems', () => {
  it('puts Logs after Overview, then WordPress and its data, then the server', () => {
    expect(values(site())).toEqual(['overview', 'logs', 'plugins', 'database', 'cron', 'config', 'php', 'domains']);
  });

  it('starts each group after the first with a line', () => {
    const groups = siteTabItems(site()).filter((t) => t.startsGroup).map((t) => t.value);
    expect(groups).toEqual(['plugins', 'php']);
  });

  it('adds Network first in the WordPress group, only on a multisite', () => {
    const network = site({ network: { type: 'subdirectory', mode: 'path', sites: [] } as unknown as NonNullable<Site['network']> });
    expect(values(network).slice(0, 4)).toEqual(['overview', 'logs', 'network', 'plugins']);
    expect(siteTabItems(network).find((t) => t.value === 'network')?.startsGroup).toBe(true);
  });

  it('keeps the order of the rest when a site lacks tabs', () => {
    const empty = site({ core: { kind: 'none' }, db: undefined, constants: undefined });
    expect(values(empty)).toEqual(['overview', 'logs', 'domains']);
    expect(siteTabItems(empty).find((t) => t.value === 'domains')?.startsGroup).toBe(true);
    expect(values(site({ path: '/learn' }))).not.toContain('domains');
  });

  it('counts only what needs a look, colored by how bad it is', () => {
    const items = siteTabItems(site(), { logs: 3, cron: 0, config: 2, domains: 1 });
    const badge = (v: string) => items.find((t) => t.value === v);
    expect(badge('logs')).toMatchObject({ count: 3, tone: 'danger' });
    expect(badge('config')).toMatchObject({ count: 2, tone: 'warning' });
    expect(badge('domains')).toMatchObject({ count: 1, tone: 'warning' });
    expect(badge('cron')?.count).toBeUndefined();
    expect(badge('database')?.count).toBeUndefined();
  });
});

describe('uncoveredNames', () => {
  it('names what the certificate or the hosts file leaves out', () => {
    expect(uncoveredNames(site())).toEqual([]);
    expect(uncoveredNames(site({ cert: { expiresAt: '2028-05-23T00:00:00Z', names: ['local.acme.com'], issuer: 'new' } }))).toEqual(['local.acme.de']);
    expect(uncoveredNames(site({ notInHosts: ['local.acme.com'] }))).toEqual(['local.acme.com']);
    expect(uncoveredNames(site({ cert: undefined }))).toEqual(['local.acme.com', 'local.acme.de']);
  });
});

describe('debugLabel', () => {
  const debug = (constants: Partial<typeof OFF>) => site({ debug: { enabled: true, logBytes: 0, constants: { ...OFF, WP_DEBUG: true, ...constants } } });

  it('says where errors go, with WordPress defaults for constants wp-config.php leaves out', () => {
    expect(debugLabel(site())).toBe('Off');
    expect(debugLabel(debug({ WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false }))).toBe('Log only');
    expect(debugLabel(debug({ WP_DEBUG_LOG: true }))).toBe('Log and page');
    expect(debugLabel(debug({}))).toBe('On the page');
    expect(debugLabel(debug({ WP_DEBUG_DISPLAY: false }))).toBe('On, not shown');
  });
});

import type { Site } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { currentSite, paletteRuns } from '../src/lib/palette.js';

const site = (domain: string, extra: { [K in keyof Site]?: Site[K] | undefined } = {}): Site => ({ domain, aliases: [], docroot: `/var/www/${domain}`, constants: [], health: 'ok', issues: [], ...extra }) as Site;
const git = { branch: 'main', remote: 'git@github.com:acme/site.git' } as unknown as Site['git'];

describe('currentSite', () => {
  it('reads a site and a site under a path from the page address', () => {
    expect(currentSite('/sites/local.acme.com')).toEqual({ domain: 'local.acme.com' });
    expect(currentSite('/sites/local.acme.com/learn')).toEqual({ domain: 'local.acme.com', path: '/learn' });
  });

  it('is no site on the new site wizard or other pages', () => {
    expect(currentSite('/sites/new')).toBeNull();
    expect(currentSite('/sites/new/abc/repo')).toBeNull();
    expect(currentSite('/services/mysql')).toBeNull();
  });
});

describe('paletteRuns', () => {
  const sites = [site('local.acme.com', { git }), site('local.shop.com'), site('local.acme.com', { path: '/learn' })];

  it('puts the open site first, labelled without its name', () => {
    const runs = paletteRuns(sites, { domain: 'local.shop.com' });
    expect(runs[0]).toMatchObject({ here: true, entry: { scope: 'site' } });
    expect(runs.find((r) => r.id === 'site.clearCache')).toMatchObject({ here: true, label: 'Clear cache', title: 'Clear cache on local.shop.com', input: { domain: 'local.shop.com' } });
    expect(runs.filter((r) => r.here).every((r) => r.site === 'local.shop.com')).toBe(true);
  });

  it('offers git only where the site has a repository at its root', () => {
    const pulls = paletteRuns(sites, null).filter((r) => r.id === 'git.pull').map((r) => r.site);
    expect(pulls).toEqual(['local.acme.com']);
  });

  it('keeps Apache-level actions with the domain and passes the path for WordPress ones', () => {
    const runs = paletteRuns(sites, null);
    expect(runs.filter((r) => r.id === 'cert.reissue').map((r) => r.input)).toEqual([{ domain: 'local.acme.com' }, { domain: 'local.shop.com' }]);
    expect(runs.find((r) => r.id === 'site.clearCache' && r.site === 'local.acme.com/learn')?.input).toEqual({ domain: 'local.acme.com', path: '/learn' });
  });

  it('runs machine actions with their fixed input', () => {
    const mysql = paletteRuns([], null).find((r) => r.label === 'Restart MySQL');
    expect(mysql).toMatchObject({ id: 'service.restart', input: { service: 'mysql' } });
    expect(mysql?.entry.confirm).toBeTruthy();
  });

  it('offers a move to the other web server only to a site that can move there as it is', () => {
    const movable = { move: { ignored: [] } };
    const list = [
      site('local.acme.com', { server: 'apache', ...movable }),
      site('local.shop.com', { server: 'nginx', ...movable }),
      site('local.blog.com', { server: 'apache', move: { refusal: 'Set nginx up first', ignored: [] } }),
      site('local.forum.com', { server: 'apache', move: { ignored: ['RewriteRule ^old/ /new/ [R=301]'] } }),
      site('local.acme.com', { path: '/learn', server: 'apache', ...movable }),
    ];
    const moves = paletteRuns(list, null).filter((r) => r.id === 'site.setServer').map((r) => [r.label, r.input]);
    expect(moves).toEqual([
      ['Move to nginx on local.acme.com', { domain: 'local.acme.com', server: 'nginx' }],
      ['Move to Apache on local.shop.com', { domain: 'local.shop.com', server: 'apache' }],
    ]);
  });
});

import type { Site } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { currentSite, paletteRuns } from '../src/lib/palette.js';

const site = (domain: string, extra: { [K in keyof Site]?: Site[K] | undefined } = {}): Site => ({ domain, aliases: [], docroot: `/var/www/${domain}`, constants: [], health: 'ok', issues: [], ...extra }) as Site;
const git = { branch: 'main', remote: 'git@github.com:wandworks/site.git' } as unknown as Site['git'];

describe('currentSite', () => {
  it('reads a site and a site under a path from the page address', () => {
    expect(currentSite('/sites/local.wandworks.example')).toEqual({ domain: 'local.wandworks.example' });
    expect(currentSite('/sites/local.wandworks.example/learn')).toEqual({ domain: 'local.wandworks.example', path: '/learn' });
  });

  it('is no site on the new site wizard or other pages', () => {
    expect(currentSite('/sites/new')).toBeNull();
    expect(currentSite('/sites/new/abc/repo')).toBeNull();
    expect(currentSite('/services/mysql')).toBeNull();
  });
});

describe('paletteRuns', () => {
  const sites = [site('local.wandworks.example', { git }), site('local.shop.com'), site('local.wandworks.example', { path: '/learn' })];

  it('puts the open site first, labelled without its name', () => {
    const runs = paletteRuns(sites, { domain: 'local.shop.com' });
    expect(runs[0]).toMatchObject({ here: true, entry: { scope: 'site' } });
    expect(runs.find((r) => r.id === 'site.clearCache')).toMatchObject({ here: true, label: 'Clear cache', title: 'Clear cache on local.shop.com', input: { domain: 'local.shop.com' } });
    expect(runs.filter((r) => r.here).every((r) => r.site === 'local.shop.com')).toBe(true);
  });

  it('offers git only where the site has a repository at its root', () => {
    const pulls = paletteRuns(sites, null).filter((r) => r.id === 'git.pull').map((r) => r.site);
    expect(pulls).toEqual(['local.wandworks.example']);
  });

  it('keeps Apache-level actions with the domain and passes the path for WordPress ones', () => {
    const runs = paletteRuns(sites, null);
    expect(runs.filter((r) => r.id === 'cert.reissue').map((r) => r.input)).toEqual([{ domain: 'local.wandworks.example' }, { domain: 'local.shop.com' }]);
    expect(runs.find((r) => r.id === 'site.clearCache' && r.site === 'local.wandworks.example/learn')?.input).toEqual({ domain: 'local.wandworks.example', path: '/learn' });
  });

  it('runs machine actions with their fixed input', () => {
    const mysql = paletteRuns([], null).find((r) => r.label === 'Restart MySQL');
    expect(mysql).toMatchObject({ id: 'service.restart', input: { service: 'mysql' } });
    expect(mysql?.entry.confirm).toBeTruthy();
  });

  it('offers a move to another web server only to a site that can move there as it is', () => {
    const front = { apachePaths: [], staticRules: [] };
    const movable = { move: { refusals: {}, ignored: [], front } };
    const list = [
      site('local.wandworks.example', { server: 'apache', ...movable }),
      site('local.shop.com', { server: 'nginx', ...movable }),
      site('local.blog.com', { server: 'apache', move: { refusals: { nginx: 'Set nginx up first', 'nginx-apache': 'Set nginx up first' }, ignored: [], front } }),
      site('local.forum.com', { server: 'apache', move: { refusals: {}, ignored: ['RewriteRule ^old/ /new/ [R=301]'], front } }),
      site('local.wandworks.example', { path: '/learn', server: 'apache', ...movable }),
    ];
    const moves = paletteRuns(list, null).filter((r) => r.id === 'site.setServer').map((r) => [r.label, r.input]);
    expect(moves).toEqual([
      ['Move to nginx on local.wandworks.example', { domain: 'local.wandworks.example', server: 'nginx' }],
      ['Put nginx in front of Apache on local.wandworks.example', { domain: 'local.wandworks.example', server: 'nginx-apache' }],
      ['Put nginx in front of Apache on local.shop.com', { domain: 'local.shop.com', server: 'nginx-apache' }],
      ['Put nginx in front of Apache on local.forum.com', { domain: 'local.forum.com', server: 'nginx-apache' }],
      ['Move to Apache on local.shop.com', { domain: 'local.shop.com', server: 'apache' }],
    ]);
  });
});

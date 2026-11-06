import { describe, expect, it } from 'vitest';
import { actions, isActionId, isLocalName, mountFolder } from '../src/actions.js';

// Same cases as scripts/tests/dmp-root.bats, so the UI and dmp-root agree.
describe('isLocalName', () => {
  it.each(['local.site.com', 'www.local.site.com', 'shop.test', 'app.localhost', 'local.northwind.co.jp'])('accepts %s', (name) => {
    expect(isLocalName(name)).toBe(true);
  });

  it.each(['example.com', 'google.com', 'LOCAL.Upper.com', 'local.a b.com', '../etc', 'local', 'local.-x.com', 'local.x.com;rm'])(
    'rejects %s',
    (name) => {
      expect(isLocalName(name)).toBe(false);
    },
  );
});

describe('actions registry', () => {
  it('knows its ids and nothing else', () => {
    expect(isActionId('hosts.add')).toBe(true);
    expect(isActionId('toString')).toBe(false);
    expect(isActionId('shell.run')).toBe(false);
  });

  it('defaults hosts.add aliases to an empty list', () => {
    expect(actions['hosts.add'].input.parse({ domain: 'local.a.com' })).toEqual({ domain: 'local.a.com', aliases: [] });
  });
});

describe('site.create input', () => {
  const base = { source: 'wordpress', domain: 'local.shop.com', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'dev', email: 'dev@example.com' } };
  const parse = (v: object) => actions['site.create'].input.safeParse(v);

  it('accepts a fresh WordPress site and an empty site', () => {
    expect(parse(base).success).toBe(true);
    expect(parse({ source: 'empty', domain: 'local.plain.com' }).success).toBe(true);
  });

  it('needs a repo for repo installs and a core and admin for WordPress', () => {
    expect(parse({ ...base, source: 'repo' }).success).toBe(false);
    expect(parse({ source: 'wordpress', domain: 'local.shop.com' }).success).toBe(false);
  });

  it.each(['--upload-pack=touch /tmp/x', 'ext::sh -c id', 'file:///etc', 'git@github.com:a/b.git; id', 'https://x.com/a b'])('refuses the git URL %s', (url) => {
    expect(parse({ ...base, source: 'repo', repo: { url, branch: 'master', layout: 'site-root' } }).success).toBe(false);
  });

  it.each([
    'git@github.com:AcmeCo/marketing-northwind.git',
    'https://github.com/DailyMedia/dailypost.git',
    'ssh://git@github.com:22/AcmeCo/NewsNow.git',
    'git@gitlab.com:acme/web/shops/site.git',
    'ssh://git@git.acme.test:2222/acme/web/site.git',
    'https://gitlab.acme.test:8443/acme/site.git',
    'git@bitbucket.org:acme/site.git',
    'git@codeberg.org:acme/site.git',
  ])('accepts %s', (url) => {
    expect(parse({ ...base, source: 'repo', repo: { url, branch: 'feature/translation-export', layout: 'site-root' } }).success).toBe(true);
  });

  it.each(['-x', '../../etc', 'a..b', 'feature/', 'a b'])('refuses the branch %s', (branch) => {
    expect(parse({ ...base, source: 'repo', repo: { url: 'git@github.com:a/b.git', branch, layout: 'site-root' } }).success).toBe(false);
  });

  it('only replaces towards local domains', () => {
    expect(parse({ ...base, replace: [{ from: 'www.shop.com', to: 'local.shop.com' }] }).success).toBe(true);
    expect(parse({ ...base, replace: [{ from: 'local.shop.com', to: 'www.shop.com' }] }).success).toBe(false);
  });
});

describe('mountFolder', () => {
  it('names the folder of a site under a path like a local domain', () => {
    expect(mountFolder('local.northwind.com', '/learn')).toBe('local.learn.northwind.com');
    expect(mountFolder('www.local.shop.com', '/blog')).toBe('local.blog.shop.com');
    expect(mountFolder('shop.test', '/blog/en')).toBe('blog-en.shop.test');
    expect(mountFolder('shop.localhost', '/Docs_V2')).toBe('docs-v2.shop.localhost');
    expect(mountFolder('local.shop.com', '/---')).toBeNull();
  });

  it('lets site.create take a path only for a WordPress site without aliases', () => {
    const base = { source: 'wordpress', domain: 'local.shop.com', path: '/learn', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'admin', email: 'admin@local.shop.com' } };
    expect(actions['site.create'].input.safeParse(base).success).toBe(true);
    expect(actions['site.create'].input.safeParse({ ...base, aliases: ['local.x.com'] }).success).toBe(false);
    expect(actions['site.create'].input.safeParse({ ...base, source: 'empty' }).success).toBe(false);
    expect(actions['site.create'].input.safeParse({ ...base, path: '/../etc' }).success).toBe(false);
  });
});

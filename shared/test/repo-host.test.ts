import { describe, expect, it } from 'vitest';
import { repoFolder, repoFullName, actions } from '../src/actions.js';
import { siteRepoLabel, siteRepos } from '../src/sites.js';
import { coveringGroups, gitlabHost, gitlabHostsWith, gitlabPath, isShared, namespaceLabel, namespaceRefOf, namespaceShortLabel, parseNamespaceRef } from '../src/repo-host.js';

describe('namespace refs', () => {
  it('keep a GitHub organization as its bare name and put the host before a GitLab group', () => {
    expect(parseNamespaceRef('acme')).toEqual({ provider: 'github', host: 'github.com', path: 'acme' });
    expect(parseNamespaceRef('gitlab.com/acme/web')).toEqual({ provider: 'gitlab', host: 'gitlab.com', path: 'acme/web' });
    expect(parseNamespaceRef('git.acme.test/acme')).toEqual({ provider: 'gitlab', host: 'git.acme.test', path: 'acme' });
    expect(namespaceRefOf({ provider: 'gitlab', host: 'gitlab.com', path: 'acme/web' })).toBe('gitlab.com/acme/web');
    expect(namespaceRefOf({ provider: 'github', host: 'github.com', path: 'acme' })).toBe('acme');
    expect([namespaceLabel('acme'), namespaceLabel('gitlab.com/acme/web')]).toEqual(['acme (GitHub)', 'acme/web (gitlab.com)']);
  });

  it('name the repos shared with you on each host with a ~, which no real name has', () => {
    expect(parseNamespaceRef('~shared')).toEqual({ provider: 'github', host: 'github.com', path: '~shared' });
    expect(parseNamespaceRef('gitlab.com/~shared')).toEqual({ provider: 'gitlab', host: 'gitlab.com', path: '~shared' });
    expect(isShared({ path: '~shared' })).toBe(true);
    expect([namespaceLabel('~shared'), namespaceLabel('git.acme.test/~shared'), namespaceShortLabel('gitlab.com/~shared')]).toEqual(['Shared with you (GitHub)', 'Shared with you (git.acme.test)', 'Shared with you']);
    for (const bad of ['~other', 'gitlab.com/~shared/x', 'gitlab.com/acme/~shared']) expect(parseNamespaceRef(bad)).toBeNull();
  });

  it.each(['', 'acme/web', '-acme', 'gitlab.com', 'gitlab.com/', 'gitlab.com/../x', 'gitlab.com/acme/site.git', 'gitlab.com/acme.', 'github.com/acme', 'localhost/acme', 'gitlab.com/a b'])('refuses %j', (ref) => {
    expect(parseNamespaceRef(ref)).toBeNull();
  });

  it('allow 20 levels of groups and a project, no deeper', () => {
    const deep = Array.from({ length: 21 }, (_, i) => `g${i}`).join('/');
    expect(gitlabPath.safeParse(deep).success).toBe(true);
    expect(gitlabPath.safeParse(`${deep}/x`).success).toBe(false);
  });
});

describe('GitLab hosts', () => {
  it('are bare lower-case hostnames, never github.com', () => {
    expect(gitlabHost.parse(' Git.Acme.Test ')).toBe('git.acme.test');
    for (const bad of ['https://git.acme.test', 'git.acme.test:8443', 'git.acme.test/x', 'localhost', 'github.com']) expect(gitlabHost.safeParse(bad).success).toBe(false);
    expect(gitlabHostsWith(['git.acme.test', 'gitlab.com'])).toEqual(['gitlab.com', 'git.acme.test']);
  });
});

describe('coveringGroups', () => {
  it('keeps a group and drops its subgroups, and keeps a subgroup whose parent you do not belong to', () => {
    expect(coveringGroups(['acme/web', 'acme', 'acme/web/shops', 'partners/acme-team', 'Acme/Apps'])).toEqual(['acme', 'partners/acme-team']);
    expect(coveringGroups(['acme-labs', 'acme'])).toEqual(['acme', 'acme-labs']);
  });
});

describe('repos in subgroups', () => {
  it('pass as a full path and as the organization of an install', () => {
    expect(repoFullName.safeParse('acme/web/shop').success).toBe(true);
    expect(repoFullName.safeParse('acme/../shop').success).toBe(false);
    expect(repoFullName.safeParse('shop').success).toBe(false);
    const create = actions['site.create'].input;
    const base = { source: 'repo', domain: 'local.shop.com', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'dev', email: 'dev@example.com' }, repo: { url: 'git@gitlab.com:acme/web/shop.git', branch: 'main', layout: 'site-root' } };
    expect(create.safeParse({ ...base, organization: 'gitlab.com/acme/web' }).success).toBe(true);
    expect(create.safeParse({ ...base, organization: 'gitlab.com/../x' }).success).toBe(false);
  });
});

describe('repos inside a site', () => {
  const git = (branch: string) => ({ branch, upstream: null, dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: 'abc1234', subject: 'x', author: 'Alex Morgan', date: '2026-10-01T00:00:00Z' } });

  it.each(['wp-content', 'wp-content/themes/acme', 'wp-content/plugins/acme-blocks', 'wp-content/mu-plugins/acme.tools'])('take %s', (folder) => {
    expect(repoFolder.safeParse(folder).success).toBe(true);
  });

  it.each(['', '.', 'wp-content/', 'wp-content/themes', 'wp-content/uploads/x', 'wp-content/themes/..', 'wp-content/themes/a/b', '../wp-content', '/var/www/x', 'wp-content/themes/a b'])('refuse %j', (folder) => {
    expect(repoFolder.safeParse(folder).success).toBe(false);
  });

  it('come in the Git card after the site\'s own and before mounted folders, labelled by kind, through the site\'s path', () => {
    const repos = [
      { folder: 'wp-content', kind: 'wp-content' as const, name: 'wp-content', git: git('main') },
      { folder: 'wp-content/themes/acme', kind: 'theme' as const, name: 'acme', git: git('develop') },
    ];
    expect(siteRepos({ git: git('master'), repos, mounts: [{ path: '/docs', docroot: '/x', git: git('gh-pages') }] }).map((r) => [r.label, r.repo, r.mount])).toEqual([
      ['Site', undefined, undefined],
      ['wp-content', 'wp-content', undefined],
      ['Theme: acme', 'wp-content/themes/acme', undefined],
      ['/docs', undefined, '/docs'],
    ]);
    expect(siteRepos({ path: '/learn', repos: [repos[1] as (typeof repos)[number]] })).toMatchObject([{ label: 'Theme: acme', repo: 'wp-content/themes/acme', mount: '/learn' }]);
    expect([siteRepoLabel({ kind: 'plugin', name: 'acme-blocks' }), siteRepoLabel({ kind: 'mu-plugin', name: 'tools' })]).toEqual(['Plugin: acme-blocks', 'Must-use plugin: tools']);
  });
});

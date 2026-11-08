import { describe, expect, it } from 'vitest';
import { repoFolder, repoFullName, actions } from '../src/actions.js';
import { siteRepoLabel, siteRepos } from '../src/sites.js';
import { coveringGroups, gitlabHost, gitlabHostsWith, gitlabPath, isShared, namespaceLabel, namespaceRefOf, namespaceShortLabel, parseNamespaceRef } from '../src/repo-host.js';

describe('namespace refs', () => {
  it('keep a GitHub organization as its bare name and put the host before a GitLab group', () => {
    expect(parseNamespaceRef('wandworks')).toEqual({ provider: 'github', host: 'github.com', path: 'wandworks' });
    expect(parseNamespaceRef('gitlab.com/wandworks/web')).toEqual({ provider: 'gitlab', host: 'gitlab.com', path: 'wandworks/web' });
    expect(parseNamespaceRef('git.wandworks.test/wandworks')).toEqual({ provider: 'gitlab', host: 'git.wandworks.test', path: 'wandworks' });
    expect(namespaceRefOf({ provider: 'gitlab', host: 'gitlab.com', path: 'wandworks/web' })).toBe('gitlab.com/wandworks/web');
    expect(namespaceRefOf({ provider: 'github', host: 'github.com', path: 'wandworks' })).toBe('wandworks');
    expect([namespaceLabel('wandworks'), namespaceLabel('gitlab.com/wandworks/web')]).toEqual(['wandworks (GitHub)', 'wandworks/web (gitlab.com)']);
  });

  it('name the repos shared with you on each host with a ~, which no real name has', () => {
    expect(parseNamespaceRef('~shared')).toEqual({ provider: 'github', host: 'github.com', path: '~shared' });
    expect(parseNamespaceRef('gitlab.com/~shared')).toEqual({ provider: 'gitlab', host: 'gitlab.com', path: '~shared' });
    expect(isShared({ path: '~shared' })).toBe(true);
    expect([namespaceLabel('~shared'), namespaceLabel('git.wandworks.test/~shared'), namespaceShortLabel('gitlab.com/~shared')]).toEqual(['Shared with you (GitHub)', 'Shared with you (git.wandworks.test)', 'Shared with you']);
    for (const bad of ['~other', 'gitlab.com/~shared/x', 'gitlab.com/wandworks/~shared']) expect(parseNamespaceRef(bad)).toBeNull();
  });

  it.each(['', 'wandworks/web', '-wandworks', 'gitlab.com', 'gitlab.com/', 'gitlab.com/../x', 'gitlab.com/wandworks/site.git', 'gitlab.com/wandworks.', 'github.com/wandworks', 'localhost/wandworks', 'gitlab.com/a b'])('refuses %j', (ref) => {
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
    expect(gitlabHost.parse(' Git.Wandworks.Test ')).toBe('git.wandworks.test');
    for (const bad of ['https://git.wandworks.test', 'git.wandworks.test:8443', 'git.wandworks.test/x', 'localhost', 'github.com']) expect(gitlabHost.safeParse(bad).success).toBe(false);
    expect(gitlabHostsWith(['git.wandworks.test', 'gitlab.com'])).toEqual(['gitlab.com', 'git.wandworks.test']);
  });
});

describe('coveringGroups', () => {
  it('keeps a group and drops its subgroups, and keeps a subgroup whose parent you do not belong to', () => {
    expect(coveringGroups(['wandworks/web', 'wandworks', 'wandworks/web/shops', 'partners/wandworks-team', 'Wandworks/Apps'])).toEqual(['partners/wandworks-team', 'wandworks']);
    expect(coveringGroups(['wandworks-labs', 'wandworks'])).toEqual(['wandworks', 'wandworks-labs']);
  });
});

describe('repos in subgroups', () => {
  it('pass as a full path and as the organization of an install', () => {
    expect(repoFullName.safeParse('wandworks/web/shop').success).toBe(true);
    expect(repoFullName.safeParse('wandworks/../shop').success).toBe(false);
    expect(repoFullName.safeParse('shop').success).toBe(false);
    const create = actions['site.create'].input;
    const base = { source: 'repo', domain: 'local.shop.com', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'dev', email: 'dev@example.com' }, repo: { url: 'git@gitlab.com:wandworks/web/shop.git', branch: 'main', layout: 'site-root' } };
    expect(create.safeParse({ ...base, organization: 'gitlab.com/wandworks/web' }).success).toBe(true);
    expect(create.safeParse({ ...base, organization: 'gitlab.com/../x' }).success).toBe(false);
  });
});

describe('repos inside a site', () => {
  const git = (branch: string) => ({ branch, upstream: null, dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: 'abc1234', subject: 'x', author: 'Alex Morgan', date: '2026-10-01T00:00:00Z' } });

  it.each(['wp-content', 'wp-content/themes/wandworks', 'wp-content/plugins/wandworks-blocks', 'wp-content/mu-plugins/wandworks.tools'])('take %s', (folder) => {
    expect(repoFolder.safeParse(folder).success).toBe(true);
  });

  it.each(['', '.', 'wp-content/', 'wp-content/themes', 'wp-content/uploads/x', 'wp-content/themes/..', 'wp-content/themes/a/b', '../wp-content', '/var/www/x', 'wp-content/themes/a b'])('refuse %j', (folder) => {
    expect(repoFolder.safeParse(folder).success).toBe(false);
  });

  it('come in the Git card after the site\'s own and before mounted folders, labelled by kind, through the site\'s path', () => {
    const repos = [
      { folder: 'wp-content', kind: 'wp-content' as const, name: 'wp-content', git: git('main') },
      { folder: 'wp-content/themes/wandworks', kind: 'theme' as const, name: 'wandworks', git: git('develop') },
    ];
    expect(siteRepos({ git: git('master'), repos, mounts: [{ path: '/docs', docroot: '/x', git: git('gh-pages') }] }).map((r) => [r.label, r.repo, r.mount])).toEqual([
      ['Site', undefined, undefined],
      ['wp-content', 'wp-content', undefined],
      ['Theme: wandworks', 'wp-content/themes/wandworks', undefined],
      ['/docs', undefined, '/docs'],
    ]);
    expect(siteRepos({ path: '/learn', repos: [repos[1] as (typeof repos)[number]] })).toMatchObject([{ label: 'Theme: wandworks', repo: 'wp-content/themes/wandworks', mount: '/learn' }]);
    expect([siteRepoLabel({ kind: 'plugin', name: 'wandworks-blocks' }), siteRepoLabel({ kind: 'mu-plugin', name: 'tools' })]).toEqual(['Plugin: wandworks-blocks', 'Must-use plugin: tools']);
  });
});

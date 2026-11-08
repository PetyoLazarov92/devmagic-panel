import { describe, expect, it } from 'vitest';
import { branchWebUrl, commitWebUrl, fuzzyMatch, providerOfHost, registerGitHosts, registerGitlabHosts, registerHostAliases, remoteEndpoint, repoWeb, sameRepo, subjectLinks } from '../src/git.js';

describe('repoWeb', () => {
  it.each([
    ['git@github.com:WandworksCo/marketing-spellbook.git', 'https://github.com/WandworksCo/marketing-spellbook', 'GitHub', 'GitHub'],
    ['https://github.com/DailyMedia/dailypost.git', 'https://github.com/DailyMedia/dailypost', 'GitHub', 'GitHub'],
    ['ssh://git@github.com:22/WandworksCo/NewsNow.git', 'https://github.com/WandworksCo/NewsNow', 'GitHub', 'GitHub'],
    ['git@gitlab.com:group/sub/project.git', 'https://gitlab.com/group/sub/project', 'GitLab', 'GitLab'],
    ['ssh://git@gitlab.wandworks.test:2222/wandworks/web/shop.git', 'https://gitlab.wandworks.test/wandworks/web/shop', 'GitLab', 'gitlab.wandworks.test'],
    ['https://gitlab.wandworks.test:8443/wandworks/shop.git', 'https://gitlab.wandworks.test:8443/wandworks/shop', 'GitLab', 'gitlab.wandworks.test'],
    ['https://bitbucket.org/team/site', 'https://bitbucket.org/team/site', 'Bitbucket', 'Bitbucket'],
    ['git@codeberg.org:wandworks/site.git', 'https://codeberg.org/wandworks/site', 'Gitea', 'Codeberg'],
    ['git@gitea.wandworks.test:wandworks/site.git', 'https://gitea.wandworks.test/wandworks/site', 'Gitea', 'gitea.wandworks.test'],
    ['git@git.example.com:team/site.git', 'https://git.example.com/team/site', 'Git', 'git.example.com'],
  ])('%s', (remote, repoUrl, provider, name) => {
    expect(repoWeb(remote)).toEqual({ repoUrl, provider, name });
  });

  it('knows your own GitLab host once it is registered, whatever its name', () => {
    expect(repoWeb('git@git.wandworks.test:wandworks/web/shop.git')?.provider).toBe('Git');
    registerGitlabHosts(['Git.Wandworks.Test']);
    try {
      expect(repoWeb('git@git.wandworks.test:wandworks/web/shop.git')).toEqual({ provider: 'GitLab', name: 'git.wandworks.test', repoUrl: 'https://git.wandworks.test/wandworks/web/shop' });
      expect(branchWebUrl('git@git.wandworks.test:wandworks/web/shop.git', 'main')).toBe('https://git.wandworks.test/wandworks/web/shop/-/tree/main');
    } finally {
      registerGitlabHosts([]);
    }
    expect(repoWeb('git@git.wandworks.test:wandworks/shop.git')?.provider).toBe('Git');
  });

  it('follows an SSH alias to its real host, so an alias and the real URL are one repo', () => {
    registerHostAliases({ 'gitlab-work': 'gitlab.com' });
    try {
      expect(repoWeb('git@gitlab-work:wandworks/web/site.git')).toEqual({ provider: 'GitLab', name: 'GitLab', repoUrl: 'https://gitlab.com/wandworks/web/site' });
      expect(sameRepo('git@gitlab-work:wandworks/web/site.git', 'https://gitlab.com/wandworks/web/site.git')).toBe(true);
    } finally {
      registerHostAliases({});
    }
  });

  it('keeps hosts by source, so the detected ones never replace your settings, and can leave one source out', () => {
    registerGitlabHosts(['git.wandworks.test']);
    registerGitHosts('detected', { 'code.wandworks.test': 'Gitea' });
    try {
      expect([providerOfHost('git.wandworks.test'), providerOfHost('code.wandworks.test')]).toEqual(['GitLab', 'Gitea']);
      expect(providerOfHost('code.wandworks.test', 'detected')).toBe('Git');
      expect(providerOfHost('git.wandworks.test', 'detected')).toBe('GitLab');
    } finally {
      registerGitlabHosts([]);
      registerGitHosts('detected', {});
    }
  });

  it('does not take a host that only contains gitlab inside a word', () => {
    expect(repoWeb('git@notgitlabby.wandworks.test:a/b.git')?.provider).toBe('Git');
  });

  it.each(['', '/var/www/local.site.com', 'file:///srv/repo.git', 'javascript:alert(1)', 'git@github.com:'])('rejects %s', (remote) => {
    expect(repoWeb(remote)).toBeNull();
  });
});

describe('remoteEndpoint', () => {
  it('says how ssh reaches a remote: host as written, user and port', () => {
    expect(remoteEndpoint('git@gitlab-work:wandworks/site.git')).toEqual({ host: 'gitlab-work', user: 'git', ssh: true });
    expect(remoteEndpoint('ssh://forge@Code.Wandworks.Test:2222/wandworks/shop.git')).toEqual({ host: 'code.wandworks.test', user: 'forge', port: 2222, ssh: true });
    expect(remoteEndpoint('https://git.wandworks.test/wandworks/blog.git')).toEqual({ host: 'git.wandworks.test', user: 'git', ssh: false });
    expect(remoteEndpoint('/srv/repo.git')).toBeNull();
  });
});

describe('branchWebUrl', () => {
  it('keeps slashes in branch names and encodes the rest', () => {
    expect(branchWebUrl('git@github.com:WandworksCo/marketing-spellbook.git', 'feature/translation-export')).toBe(
      'https://github.com/WandworksCo/marketing-spellbook/tree/feature/translation-export',
    );
    expect(branchWebUrl('git@github.com:a/b.git', 'fix/#12 space')).toBe('https://github.com/a/b/tree/fix/%2312%20space');
  });

  it('uses each provider\'s path', () => {
    expect(branchWebUrl('git@gitlab.com:g/p.git', 'main')).toBe('https://gitlab.com/g/p/-/tree/main');
    expect(branchWebUrl('git@bitbucket.org:t/s.git', 'main')).toBe('https://bitbucket.org/t/s/src/main');
    expect(branchWebUrl('git@codeberg.org:t/s.git', 'feature/x')).toBe('https://codeberg.org/t/s/src/branch/feature/x');
    expect(commitWebUrl('git@codeberg.org:t/s.git', 'a41c9e2')).toBe('https://codeberg.org/t/s/commit/a41c9e2');
  });
});

describe('commitWebUrl', () => {
  it('links a commit and refuses anything that is not a hash', () => {
    expect(commitWebUrl('git@github.com:a/b.git', 'a41c9e2')).toBe('https://github.com/a/b/commit/a41c9e2');
    expect(commitWebUrl('git@github.com:a/b.git', '../x')).toBeNull();
  });
});

describe('sameRepo', () => {
  it('matches SSH, HTTPS and case differences of one repo', () => {
    expect(sameRepo('git@github.com:WandworksCo/marketing-spellbook.git', 'https://github.com/wandworksco/marketing-spellbook')).toBe(true);
    expect(sameRepo('ssh://git@github.com:22/WandworksCo/NewsNow.git', 'git@github.com:WandworksCo/NewsNow.git')).toBe(true);
  });

  it('tells different repos and unparsable remotes apart', () => {
    expect(sameRepo('git@github.com:WandworksCo/learn-spellbook.git', 'git@github.com:WandworksCo/marketing-spellbook.git')).toBe(false);
    expect(sameRepo('git@gitlab.com:WandworksCo/site.git', 'git@github.com:WandworksCo/site.git')).toBe(false);
    expect(sameRepo('/local/path', '/local/path')).toBe(false);
  });
});

describe('fuzzyMatch', () => {
  it('matches characters in order anywhere, ignoring case', () => {
    expect(fuzzyMatch('tsedit', 'feature/ts-editor')?.positions).toEqual([8, 9, 11, 12, 13, 14]);
    expect(fuzzyMatch('FEAT', 'feature/cart')).not.toBeNull();
    expect(fuzzyMatch('cart', 'feature/tracking')).toBeNull();
    expect(fuzzyMatch('', 'master')).toEqual({ score: 0, positions: [] });
  });

  it('ranks whole words and word starts above scattered hits', () => {
    const names = ['bugfix/newsletter-invalid-url', 'feature/cart', 'fix/carousel-autoplay', 'release/candidate-art'];
    const ranked = names
      .map((n) => ({ n, m: fuzzyMatch('cart', n) }))
      .filter((x) => x.m)
      .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
      .map((x) => x.n);
    expect(ranked[0]).toBe('feature/cart');
    expect(ranked).toContain('fix/carousel-autoplay');
    expect(ranked).not.toContain('bugfix/newsletter-invalid-url');
  });
});

describe('subjectLinks', () => {
  it('links pull requests on GitHub and Bitbucket and merge requests on GitLab', () => {
    expect(subjectLinks('git@github.com:WandworksCo/shop.git', 'Merge pull request #239 from WandworksCo/feature/x')).toEqual([
      { text: 'Merge pull request ' },
      { text: '#239', href: 'https://github.com/WandworksCo/shop/pull/239' },
      { text: ' from WandworksCo/feature/x' },
    ]);
    expect(subjectLinks('https://bitbucket.org/team/shop.git', 'Merged in fix (pull request #12)')[1]).toEqual({ text: '#12', href: 'https://bitbucket.org/team/shop/pull-requests/12' });
    expect(subjectLinks('git@gitlab.com:team/shop.git', 'See merge request team/shop!7 for #3').filter((p) => p.href)).toEqual([
      { text: '!7', href: 'https://gitlab.com/team/shop/-/merge_requests/7' },
      { text: '#3', href: 'https://gitlab.com/team/shop/-/issues/3' },
    ]);
    expect(subjectLinks('git@gitlab.com:wandworks/web/shop.git', 'See merge request wandworks/web/shop!7').filter((p) => p.href)).toEqual([
      { text: '!7', href: 'https://gitlab.com/wandworks/web/shop/-/merge_requests/7' },
    ]);
    expect(subjectLinks('git@codeberg.org:wandworks/shop.git', 'Fix cart (#21)').filter((p) => p.href)).toEqual([{ text: '#21', href: 'https://codeberg.org/wandworks/shop/issues/21' }]);
  });

  it('leaves colors, anchors, other hosts and missing remotes alone', () => {
    expect(subjectLinks('git@github.com:a/b.git', 'Use #fff and page#3 and &#39;')).toEqual([{ text: 'Use #fff and page#3 and &#39;' }]);
    expect(subjectLinks('git@git.example.org:a/b.git', 'Fix #4')).toEqual([{ text: 'Fix #4' }]);
    expect(subjectLinks(undefined, 'Fix #4')).toEqual([{ text: 'Fix #4' }]);
    expect(subjectLinks('git@github.com:a/b.git', '#5 at the start')[0]).toEqual({ text: '#5', href: 'https://github.com/a/b/pull/5' });
  });
});

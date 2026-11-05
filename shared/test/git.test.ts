import { describe, expect, it } from 'vitest';
import { branchWebUrl, commitWebUrl, fuzzyMatch, repoWeb, sameRepo, subjectLinks } from '../src/git.js';

describe('repoWeb', () => {
  it.each([
    ['git@github.com:AcmeCo/marketing-northwind.git', 'https://github.com/AcmeCo/marketing-northwind', 'GitHub'],
    ['https://github.com/DailyMedia/dailypost.git', 'https://github.com/DailyMedia/dailypost', 'GitHub'],
    ['ssh://git@github.com:22/AcmeCo/NewsNow.git', 'https://github.com/AcmeCo/NewsNow', 'GitHub'],
    ['git@gitlab.com:group/sub/project.git', 'https://gitlab.com/group/sub/project', 'GitLab'],
    ['https://bitbucket.org/team/site', 'https://bitbucket.org/team/site', 'Bitbucket'],
    ['git@git.example.com:team/site.git', 'https://git.example.com/team/site', 'Git'],
  ])('%s', (remote, repoUrl, provider) => {
    expect(repoWeb(remote)).toEqual({ repoUrl, provider });
  });

  it.each(['', '/var/www/local.site.com', 'file:///srv/repo.git', 'javascript:alert(1)', 'git@github.com:'])('rejects %s', (remote) => {
    expect(repoWeb(remote)).toBeNull();
  });
});

describe('branchWebUrl', () => {
  it('keeps slashes in branch names and encodes the rest', () => {
    expect(branchWebUrl('git@github.com:AcmeCo/marketing-northwind.git', 'feature/translation-export')).toBe(
      'https://github.com/AcmeCo/marketing-northwind/tree/feature/translation-export',
    );
    expect(branchWebUrl('git@github.com:a/b.git', 'fix/#12 space')).toBe('https://github.com/a/b/tree/fix/%2312%20space');
  });

  it('uses each provider\'s path', () => {
    expect(branchWebUrl('git@gitlab.com:g/p.git', 'main')).toBe('https://gitlab.com/g/p/-/tree/main');
    expect(branchWebUrl('git@bitbucket.org:t/s.git', 'main')).toBe('https://bitbucket.org/t/s/src/main');
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
    expect(sameRepo('git@github.com:AcmeCo/marketing-northwind.git', 'https://github.com/acmeco/marketing-northwind')).toBe(true);
    expect(sameRepo('ssh://git@github.com:22/AcmeCo/NewsNow.git', 'git@github.com:AcmeCo/NewsNow.git')).toBe(true);
  });

  it('tells different repos and unparsable remotes apart', () => {
    expect(sameRepo('git@github.com:AcmeCo/learn-northwind.git', 'git@github.com:AcmeCo/marketing-northwind.git')).toBe(false);
    expect(sameRepo('git@gitlab.com:AcmeCo/site.git', 'git@github.com:AcmeCo/site.git')).toBe(false);
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
    expect(subjectLinks('git@github.com:AcmeCo/shop.git', 'Merge pull request #239 from AcmeCo/feature/x')).toEqual([
      { text: 'Merge pull request ' },
      { text: '#239', href: 'https://github.com/AcmeCo/shop/pull/239' },
      { text: ' from AcmeCo/feature/x' },
    ]);
    expect(subjectLinks('https://bitbucket.org/team/shop.git', 'Merged in fix (pull request #12)')[1]).toEqual({ text: '#12', href: 'https://bitbucket.org/team/shop/pull-requests/12' });
    expect(subjectLinks('git@gitlab.com:team/shop.git', 'See merge request team/shop!7 for #3').filter((p) => p.href)).toEqual([
      { text: '!7', href: 'https://gitlab.com/team/shop/-/merge_requests/7' },
      { text: '#3', href: 'https://gitlab.com/team/shop/-/issues/3' },
    ]);
  });

  it('leaves colors, anchors, other hosts and missing remotes alone', () => {
    expect(subjectLinks('git@github.com:a/b.git', 'Use #fff and page#3 and &#39;')).toEqual([{ text: 'Use #fff and page#3 and &#39;' }]);
    expect(subjectLinks('git@git.example.org:a/b.git', 'Fix #4')).toEqual([{ text: 'Fix #4' }]);
    expect(subjectLinks(undefined, 'Fix #4')).toEqual([{ text: 'Fix #4' }]);
    expect(subjectLinks('git@github.com:a/b.git', '#5 at the start')[0]).toEqual({ text: '#5', href: 'https://github.com/a/b/pull/5' });
  });
});

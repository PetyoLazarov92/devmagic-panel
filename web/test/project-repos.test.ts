import type { OrgRepo } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { allRows, isPicked, makeMain, pickRepo, placementOf, planLines, rowPlacement, rowsProblem, unpickRepo } from '../src/lib/project-repos.js';
import type { WizardState } from '../src/pages/new-site.js';

const repo = (fullName: string, kind: OrgRepo['kind'] = 'site'): OrgRepo => ({
  org: 'wandworks', name: fullName.split('/').pop() as string, fullName, sshUrl: `git@github.com:${fullName}.git`, url: `https://github.com/${fullName}`, archived: false, kind, defaultBranch: 'main',
});
const blank = {
  source: 'repo', repoUrl: '', branch: '', branches: null, placement: null, helpers: null, buildPicks: {}, inspection: { status: 'idle' }, extra: [], trust: {}, passed: {},
  org: { name: 'wandworks', repo: null, read: { status: 'idle' }, access: { status: 'idle' }, useClaude: false },
} as unknown as WizardState;

describe('picking the repos of a site', () => {
  it('makes the first pick the main repo and adds later ones, each once', () => {
    let s = pickRepo(blank, repo('wandworks/site'));
    expect(s).toMatchObject({ repoUrl: 'git@github.com:wandworks/site.git', branch: 'main', org: { repo: { fullName: 'wandworks/site' } } });
    s = pickRepo(s, repo('wandworks/blocks', 'plugin'));
    s = pickRepo(s, repo('wandworks/blocks', 'plugin'));
    expect(s.extra.map((r) => r.url)).toEqual(['git@github.com:wandworks/blocks.git']);
    expect(isPicked(s, 'https://github.com/wandworks/blocks')).toBe(true);
    expect(allRows(s).map((r) => r.fullName)).toEqual(['wandworks/site', 'wandworks/blocks']);
  });

  it('puts an added repo where its kind goes, never at the site root, and the main one at the root', () => {
    const s = pickRepo(pickRepo(blank, repo('wandworks/site')), repo('wandworks/blocks', 'plugin'));
    expect(placementOf(s)).toEqual({ dir: '', folder: '' });
    expect(rowPlacement(s.extra[0] as (typeof s.extra)[number])).toEqual({ dir: 'wp-content/plugins', folder: 'blocks' });
    const theme = pickRepo(s, repo('wandworks/wandworks', 'theme'));
    expect(rowPlacement(theme.extra[1] as (typeof s.extra)[number])).toEqual({ dir: 'wp-content/themes', folder: 'wandworks' });
    const other = pickRepo(s, repo('wandworks/second-site', 'site'));
    expect(rowPlacement(other.extra[1] as (typeof s.extra)[number])).toEqual({ dir: 'wp-content/plugins', folder: 'second-site' });
  });

  it('leaves a repo out, and the next one becomes main when the main one goes', () => {
    const s = pickRepo(pickRepo(blank, repo('wandworks/site')), repo('wandworks/blocks', 'plugin'));
    expect(unpickRepo(s, 'git@github.com:wandworks/blocks.git').extra).toEqual([]);
    const promoted = unpickRepo(s, 'git@github.com:wandworks/site.git');
    expect(promoted).toMatchObject({ repoUrl: 'git@github.com:wandworks/blocks.git', extra: [], org: { repo: { fullName: 'wandworks/blocks' } } });
    const none = unpickRepo(pickRepo(blank, repo('wandworks/site')), 'git@github.com:wandworks/site.git');
    expect(none).toMatchObject({ repoUrl: '', extra: [], org: { repo: null } });
  });

  it('swaps the main repo with an added one, which keeps where it went', () => {
    const s = pickRepo(pickRepo(blank, repo('wandworks/blocks', 'plugin')), repo('wandworks/site'));
    const swapped = makeMain({ ...s, helpers: { key: 'k', kind: 'plugin' } }, 'git@github.com:wandworks/site.git');
    expect(swapped.repoUrl).toBe('git@github.com:wandworks/site.git');
    expect(swapped.extra).toMatchObject([{ url: 'git@github.com:wandworks/blocks.git', placement: { dir: 'wp-content/plugins', folder: 'blocks' } }]);
  });

  it('finds two repos at one path, and draws the plan shallow first', () => {
    expect(rowsProblem([{ placement: { dir: '', folder: '' } }, { placement: { dir: '', folder: '' } }])).toBe('Only one repo can be the site root');
    const lines = planLines([
      { url: 'git@github.com:wandworks/site.git', branch: 'main', placement: { dir: '', folder: '' }, fullName: 'wandworks/site' },
      { url: 'git@github.com:wandworks/blocks.git', branch: 'develop', placement: { dir: 'wp-content/plugins', folder: 'blocks' } },
    ]);
    expect(lines.map((l) => [l.path, l.depth, l.label, l.main])).toEqual([
      ['', 0, 'wandworks/site', true],
      ['wp-content/plugins/blocks', 3, 'wandworks/blocks', false],
    ]);
  });
});

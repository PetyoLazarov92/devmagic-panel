import type { OrgRepo } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { allRows, isPicked, makeMain, pickRepo, repoKindLabel, shownOrder, placementOf, planLines, rowPlacement, rowsProblem, unpickRepo } from '../src/lib/project-repos.js';
import type { WizardState } from '../src/features/new-site/wizard-shared.js';

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

  it('moves only the main role: every repo stays where it shows in the list', () => {
    const names = (st: WizardState) => shownOrder(allRows(st), st.mainAt).map((r) => r.url.replace(/^.*\/|\.git$/g, ''));
    const s = [repo('wandworks/site'), repo('wandworks/theme', 'theme'), repo('wandworks/blocks', 'plugin'), repo('wandworks/forms', 'plugin')].reduce(pickRepo, blank);
    expect(names(s)).toEqual(['site', 'theme', 'blocks', 'forms']);
    // The third one becomes main: the order is as it was, and the main is that row.
    const third = makeMain(s, 'git@github.com:wandworks/blocks.git');
    expect(names(third)).toEqual(['site', 'theme', 'blocks', 'forms']);
    expect(allRows(third)[0]?.url).toBe('git@github.com:wandworks/blocks.git');
    // And on to the last, then back to the first: still the same order.
    const last = makeMain(third, 'git@github.com:wandworks/forms.git');
    expect(names(last)).toEqual(['site', 'theme', 'blocks', 'forms']);
    const first = makeMain(last, 'git@github.com:wandworks/site.git');
    expect(names(first)).toEqual(['site', 'theme', 'blocks', 'forms']);
    expect(first.mainAt).toBe(0);
    // A place past the end, after repos were left out, still shows every repo.
    expect(shownOrder(['a', 'b'], 9)).toEqual(['b', 'a']);
    expect(shownOrder([], 2)).toEqual([]);
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

describe('what a picked repo is, on its badge', () => {
  it('names a theme or plugin by its header, then by what it holds, then by where it goes', () => {
    expect(repoKindLabel({ key: 'k', header: { kind: 'plugin', name: 'Wandworks Blocks', version: '1.4.0' } }, 'other', null)).toBe('Plugin: Wandworks Blocks 1.4.0');
    expect(repoKindLabel({ key: 'k', header: { kind: 'theme', name: 'Spellbook Child', parent: 'wandworks' } }, undefined, null)).toBe('Child theme of wandworks: Spellbook Child');
    expect(repoKindLabel({ key: 'k', header: { kind: 'plugin', name: 'Wandworks Forms', folder: 'plugin' } }, undefined, null)).toBe("Plugin: Wandworks Forms, in the repo's plugin folder");
    expect(repoKindLabel({ key: 'k', kind: 'theme', themeIn: 'theme' }, undefined, null)).toBe("Theme, in the repo's theme folder");
    expect(repoKindLabel(null, 'plugin', null)).toBe('Plugin');
    expect(repoKindLabel({ key: 'k', kind: 'other' }, 'other', { dir: 'wp-content/themes', folder: 'wandworks' })).toBe('No theme header: goes in themes');
    expect(repoKindLabel({ key: 'k', kind: 'other' }, 'other', { dir: 'wp-content/plugins', folder: 'wandworks-tools' })).toBe('No plugin header: goes in plugins');
    expect(repoKindLabel({ key: 'k', kind: 'other' }, 'other', { dir: 'wp-content/mu-plugins', folder: 'x' })).toBe('Goes in mu-plugins');
    expect(repoKindLabel({ key: 'k', kind: 'other' }, 'other', { dir: '', folder: 'tools' })).toBe('Not a theme or plugin');
    expect(repoKindLabel(null, undefined, null)).toBeNull();
  });
});

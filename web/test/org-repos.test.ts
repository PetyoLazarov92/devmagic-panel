import type { OrgRepo, UploadResult } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { asideUploads, KEPT_REPOS, switchOrg, switchRepo } from '../src/lib/org-repos.js';
import type { WizardState } from '../src/pages/new-site.js';

const repo = (name: string): OrgRepo => ({ org: 'wandworks', name, fullName: `wandworks/${name}`, sshUrl: `git@github.com:wandworks/${name}.git`, url: `https://github.com/wandworks/${name}`, archived: false, kind: 'site', defaultBranch: 'main' });
const blank = { source: 'repo', repoUrl: '', branch: '', upload: null, domains: [{ prod: '', local: '' }], adminPassword: null, passed: {}, org: null } as unknown as WizardState;
const upload = (id: string) => ({ id, name: `${id}.sql` }) as unknown as UploadResult;

/** An install that reached the domains step with the storefront repo: read, links checked, a dump in. */
const reached = {
  ...blank,
  repoUrl: 'git@github.com:wandworks/storefront.git',
  branch: 'develop',
  upload: upload('dump-a'),
  domains: [{ prod: 'wandworks.example', local: 'local.wandworks.example' }],
  adminPassword: 'typed',
  passed: { start: 's1', org: 'o1', read: 'r1', access: 'a1' },
  org: {
    name: 'wandworks',
    repo: repo('storefront'),
    read: { status: 'done', facts: { asanaLinks: ['https://app.asana.com/0/1/2'] }, files: ['README.md'], costUsd: 0.03 },
    access: { status: 'done', report: { links: [], facts: [], dumps: [] }, costUsd: 0.06 },
    prefill: { repoUrl: 'git@github.com:wandworks/storefront.git' },
    run: { model: 'haiku', effort: 'low', budgetUsd: 0.2 },
  },
} as unknown as WizardState;

describe('switching repos in an organization install', () => {
  it('changes nothing when you pick the repo you have', () => {
    expect(switchRepo(reached, repo('storefront'), blank)).toBe(reached);
  });

  it('starts another repo fresh, without the dump, but keeps the start and the Claude Code settings', () => {
    const next = switchRepo(reached, repo('blog'), blank, 10);
    expect(next).toMatchObject({ repoUrl: 'git@github.com:wandworks/blog.git', branch: 'main', upload: null, passed: { start: 's1' } });
    expect(next.passed).toEqual({ start: 's1' });
    expect(next.org).toMatchObject({ repo: { fullName: 'wandworks/blog' }, read: { status: 'idle' }, access: { status: 'idle' }, run: reached.org?.run });
    expect(next.org?.prefill).toBeUndefined();
    expect(asideUploads(next.org)).toEqual(['dump-a']);
  });

  it('brings a repo back as you left it: what was read, the links, the dump, the answers and the steps reached', () => {
    const back = switchRepo(switchRepo(reached, repo('blog'), blank, 10), repo('storefront'), blank, 20);
    expect(back).toMatchObject({ branch: 'develop', upload: { id: 'dump-a' }, domains: reached.domains, passed: reached.passed });
    expect(back.org).toMatchObject({ read: reached.org?.read, access: reached.org?.access, prefill: reached.org?.prefill });
    // Never the password, which is only sent with the install.
    expect(back.adminPassword).toBeNull();
    // The blog repo is the one put aside now.
    expect(Object.keys(back.org?.earlier ?? {})).toEqual(['wandworks/blog']);
  });

  it('keeps the newest few repos aside', () => {
    let s = reached;
    for (const [i, name] of ['a', 'b', 'c', 'd', 'e'].entries()) s = switchRepo(s, repo(name), blank, 100 + i);
    expect(Object.keys(s.org?.earlier ?? {})).toHaveLength(KEPT_REPOS);
    expect(Object.keys(s.org?.earlier ?? {})).toEqual(['wandworks/d', 'wandworks/c', 'wandworks/b']);
  });

  it('puts the repo aside when you pick another organization, and brings it back from there', () => {
    const other = switchOrg(reached, 'spellbook', 10);
    expect(other.org).toMatchObject({ name: 'spellbook', repo: null });
    expect(switchRepo(other, repo('storefront'), blank, 20)).toMatchObject({ upload: { id: 'dump-a' }, passed: reached.passed });
  });
});

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerGitlabHosts } from '@devmagic-panel/shared';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { findSiteRepos, MAX_SITE_REPOS } from '../src/sites/discover.js';
import { gitFolder, parseBranches, parseChanges, readGitDetails, readPullRequests } from '../src/sites/git.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

function setup(responses: Parameters<typeof fakeExec>[0] = {}) {
  const t = wpSiteTree();
  mkdirSync(join(t.docroot, '.git'));
  const learn = join(t.config.WEB_DIR, 'local.learn.shop.com');
  mkdirSync(join(learn, '.git'), { recursive: true });
  const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
  writeFileSync(vhost, readFileSync(vhost, 'utf8').replace('</VirtualHost>', ` Alias /learn ${learn}\n</VirtualHost>`));
  const fake = fakeExec(responses);
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
  };
  return { ...t, learn, ctx, calls: fake.calls };
}

const lines = (calls: ReturnType<typeof setup>['calls']) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('gitFolder', () => {
  it('finds the site repo or a mounted repo from the vhost, never from the request', () => {
    const s = setup();
    expect(gitFolder(s.config, 'local.shop.com')).toBe(s.docroot);
    expect(gitFolder(s.config, 'local.shop.com', '/learn')).toBe(s.learn);
    expect(() => gitFolder(s.config, 'local.shop.com', '/other')).toThrow(/serves nothing under \/other/);
    expect(() => gitFolder(s.config, 'local.nope.com')).toThrow(/no site/);
  });
});

describe('git details', () => {
  it('lists local branches first, then branches only on origin', () => {
    const refs = ['refs/heads/feature/cart\x1f*', 'refs/remotes/origin/HEAD\x1f ', 'refs/remotes/origin/feature/cart\x1f ', 'refs/heads/master\x1f ', 'refs/remotes/origin/hotfix/x\x1f '].join('\n');
    expect(parseBranches(refs)).toEqual([
      { name: 'feature/cart', current: true, remoteOnly: false },
      { name: 'master', current: false, remoteOnly: false },
      { name: 'hotfix/x', current: false, remoteOnly: true },
    ]);
  });

  it('reads porcelain codes and paths, renames included', () => {
    expect(parseChanges(' M a.php\n?? new dir/b.txt\nR  old.php -> new.php\n')).toEqual([
      { code: ' M', path: 'a.php' },
      { code: '??', path: 'new dir/b.txt' },
      { code: 'R ', path: 'old.php -> new.php' },
    ]);
  });

  it('reads commits and changes of a repo', async () => {
    const s = setup();
    const { exec } = fakeExec({
      [`git -C ${s.docroot} for-each-ref`]: { stdout: 'refs/heads/master\x1f*\n' },
      [`git -C ${s.docroot} log -15`]: { stdout: 'abc1234\x1fAdd cart\x1fDev\x1f2026-10-24T08:00:00+00:00\n' },
      [`git -C ${s.docroot} status --porcelain`]: { stdout: ' M a.php\n' },
    });
    expect(await readGitDetails(exec, s.docroot)).toEqual({
      branches: [{ name: 'master', current: true, remoteOnly: false }],
      commits: [{ hash: 'abc1234', subject: 'Add cart', author: 'Dev', date: '2026-10-24T08:00:00+00:00' }],
      changes: [{ code: ' M', path: 'a.php' }],
    });
  });
});

describe('open pull requests', () => {
  const pulls = JSON.stringify([
    { number: 41, title: 'Cart drawer', url: 'https://github.com/wandworks/site/pull/41', headRefName: 'feature/cart', isDraft: false, isCrossRepository: false },
    { number: 42, title: 'Search paging', url: 'https://github.com/wandworks/site/pull/42', headRefName: 'bugfix/search', isDraft: true, isCrossRepository: false },
    { number: 43, title: 'From a fork', url: 'https://github.com/wandworks/site/pull/43', headRefName: 'master', isDraft: false, isCrossRepository: true },
  ]);

  it('lists the open pull requests from the repo\'s own branches through gh, never a shell', async () => {
    const s = setup();
    const fake = fakeExec({
      [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'git@github.com:wandworks/site.git\n' },
      'gh pr list': { stdout: pulls },
    });
    expect(await readPullRequests(fake.exec, s.docroot)).toEqual([
      { kind: 'pull', number: 41, title: 'Cart drawer', url: 'https://github.com/wandworks/site/pull/41', branch: 'feature/cart', draft: false },
      { kind: 'pull', number: 42, title: 'Search paging', url: 'https://github.com/wandworks/site/pull/42', branch: 'bugfix/search', draft: true },
    ]);
    const gh = fake.calls.find((c) => c.file === 'gh');
    expect(gh?.args).toEqual(['pr', 'list', '--repo=wandworks/site', '--state=open', '--limit=200', '--json=number,title,url,headRefName,isDraft,isCrossRepository']);
    expect(gh?.env).toMatchObject({ GH_PROMPT_DISABLED: '1' });
  });

  it('shows none when gh is missing or not signed in', async () => {
    const s = setup();
    const remote = { [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'git@github.com:wandworks/site.git\n' } };
    expect(await readPullRequests(fakeExec(remote).exec, s.docroot)).toEqual([]);
    const signedOut = fakeExec({ ...remote, 'gh pr list': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' } });
    expect(await readPullRequests(signedOut.exec, s.docroot)).toEqual([]);
  });

  it('skips gh when origin is not on GitHub, and every CLI when there is no origin or the host is unknown', async () => {
    const s = setup();
    const other = fakeExec({ [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'git@git.wandworks.test:wandworks/site.git\n' } });
    expect(await readPullRequests(other.exec, s.docroot)).toEqual([]);
    expect(other.calls.some((c) => c.file === 'gh' || c.file === 'glab')).toBe(false);
    const none = fakeExec({ [`git -C ${s.docroot} remote get-url origin`]: { code: 2, stderr: "error: No such remote 'origin'\n" } });
    expect(await readPullRequests(none.exec, s.docroot)).toEqual([]);
    expect(none.calls.some((c) => c.file === 'gh' || c.file === 'glab')).toBe(false);
  });

  const merges = (host: string, path: string) =>
    JSON.stringify([
      { iid: 7, title: 'Cart drawer', web_url: `https://${host}/${path}/-/merge_requests/7`, source_branch: 'feature/cart', draft: false, source_project_id: 3, target_project_id: 3 },
      { iid: 8, title: 'Old server', web_url: `https://${host}/${path}/-/merge_requests/8`, source_branch: 'bugfix/search', work_in_progress: true, source_project_id: 3, target_project_id: 3 },
      { iid: 9, title: 'From a fork', web_url: `https://${host}/${path}/-/merge_requests/9`, source_branch: 'master', draft: false, source_project_id: 4, target_project_id: 3 },
      { iid: 10, title: 'Elsewhere', web_url: `https://${host}/other/-/merge_requests/10`, source_branch: 'x', draft: false, source_project_id: 3, target_project_id: 3 },
    ]);

  it('lists GitLab merge requests in a subgroup through glab api, with --hostname and no prompts', async () => {
    const s = setup();
    const fake = fakeExec({
      [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'git@gitlab.com:wandworks/web/shop.git\n' },
      glab: { stdout: merges('gitlab.com', 'wandworks/web/shop') },
    });
    expect(await readPullRequests(fake.exec, s.docroot)).toEqual([
      { kind: 'merge', number: 7, title: 'Cart drawer', url: 'https://gitlab.com/wandworks/web/shop/-/merge_requests/7', branch: 'feature/cart', draft: false },
      { kind: 'merge', number: 8, title: 'Old server', url: 'https://gitlab.com/wandworks/web/shop/-/merge_requests/8', branch: 'bugfix/search', draft: true },
    ]);
    const glab = fake.calls.find((c) => c.file === 'glab');
    expect(glab?.args).toEqual(['api', '--hostname', 'gitlab.com', 'projects/wandworks%2Fweb%2Fshop/merge_requests?state=opened&per_page=100']);
    expect(glab?.env).toMatchObject({ GLAB_NO_PROMPT: 'true', NO_PROMPT: 'true', GLAB_SEND_TELEMETRY: 'false' });
    expect(fake.calls.some((c) => c.file === 'gh')).toBe(false);
  });

  it('asks your own GitLab host once it is registered, and shows none when glab is missing or signed out', async () => {
    const s = setup();
    const remote = { [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'ssh://git@git.wandworks.test:2222/wandworks/shop.git\n' } };
    registerGitlabHosts(['git.wandworks.test']);
    try {
      const fake = fakeExec({ ...remote, glab: { stdout: merges('git.wandworks.test', 'wandworks/shop') } });
      expect((await readPullRequests(fake.exec, s.docroot)).map((p) => p.number)).toEqual([7, 8]);
      expect(fake.calls.find((c) => c.file === 'glab')?.args.slice(0, 3)).toEqual(['api', '--hostname', 'git.wandworks.test']);
      expect(await readPullRequests(fakeExec(remote).exec, s.docroot)).toEqual([]);
      const signedOut = fakeExec({ ...remote, glab: { code: 1, stderr: 'GET https://git.wandworks.test/api/v4/...: 401 Unauthorized' } });
      expect(await readPullRequests(signedOut.exec, s.docroot)).toEqual([]);
    } finally {
      registerGitlabHosts([]);
    }
  });

  it('drops an answer that is not a pull request list, or links off GitHub', async () => {
    const s = setup();
    const odd = fakeExec({
      [`git -C ${s.docroot} remote get-url origin`]: { stdout: 'https://github.com/wandworks/site.git\n' },
      'gh pr list': { stdout: JSON.stringify([{ number: 1, title: 'x', url: 'javascript:alert(1)', headRefName: 'a', isDraft: false, isCrossRepository: false }]) },
    });
    expect(await readPullRequests(odd.exec, s.docroot)).toEqual([]);
  });
});

describe('repos inside a site', () => {
  /** A site with wp-content, a theme, a plugin and a must-use plugin as repos, and a theme that is only a folder. */
  function withRepos() {
    const s = setup();
    for (const dir of ['wp-content', 'wp-content/themes/wandworks', 'wp-content/plugins/wandworks-blocks', 'wp-content/mu-plugins/wandworks-tools']) mkdirSync(join(s.docroot, dir, '.git'), { recursive: true });
    mkdirSync(join(s.docroot, 'wp-content/themes/twentytwentyfive'), { recursive: true });
    return s;
  }

  it('are found in wp-content, its themes, plugins and must-use plugins, in that order', () => {
    const s = withRepos();
    expect(findSiteRepos(s.docroot)).toEqual([
      { folder: 'wp-content', kind: 'wp-content', name: 'wp-content' },
      { folder: 'wp-content/themes/wandworks', kind: 'theme', name: 'wandworks' },
      { folder: 'wp-content/plugins/wandworks-blocks', kind: 'plugin', name: 'wandworks-blocks' },
      { folder: 'wp-content/mu-plugins/wandworks-tools', kind: 'mu-plugin', name: 'wandworks-tools' },
    ]);
  });

  it('leave out a folder reached through a link, and stop at the limit', () => {
    const s = setup();
    const elsewhere = join(s.root, 'elsewhere/shared-theme');
    mkdirSync(join(elsewhere, '.git'), { recursive: true });
    mkdirSync(join(s.docroot, 'wp-content/themes'), { recursive: true });
    symlinkSync(elsewhere, join(s.docroot, 'wp-content/themes/shared-theme'));
    expect(findSiteRepos(s.docroot)).toEqual([]);
    for (let i = 0; i < MAX_SITE_REPOS + 5; i++) mkdirSync(join(s.docroot, `wp-content/plugins/p${String(i).padStart(2, '0')}/.git`), { recursive: true });
    expect(findSiteRepos(s.docroot)).toHaveLength(MAX_SITE_REPOS);
  });

  it('are reached by gitFolder only as a real folder of the site, never through a link or another path', () => {
    const s = withRepos();
    expect(gitFolder(s.config, 'local.shop.com', undefined, 'wp-content/themes/wandworks')).toBe(join(s.docroot, 'wp-content/themes/wandworks'));
    expect(gitFolder(s.config, 'local.shop.com', undefined, 'wp-content')).toBe(join(s.docroot, 'wp-content'));
    expect(() => gitFolder(s.config, 'local.shop.com', undefined, 'wp-content/themes/twentytwentyfive')).toThrow('not a git repository');
    expect(() => gitFolder(s.config, 'local.shop.com', undefined, 'wp-content/../../etc')).toThrow('not a repo folder');
    expect(() => gitFolder(s.config, 'local.shop.com', undefined, 'wp-content/uploads/x')).toThrow('not a repo folder');
    const elsewhere = join(s.root, 'elsewhere/linked');
    mkdirSync(join(elsewhere, '.git'), { recursive: true });
    symlinkSync(elsewhere, join(s.docroot, 'wp-content/plugins/linked'));
    expect(() => gitFolder(s.config, 'local.shop.com', undefined, 'wp-content/plugins/linked')).toThrow('reached through a link');
  });

  it('run git actions in that folder, and refuse a repo folder the schema does not take before any command', async () => {
    const s = withRepos();
    const git = `git -C ${join(s.docroot, 'wp-content/themes/wandworks')}`;
    const fake = fakeExec({ [`${git} fetch --prune origin`]: { stdout: '' }, [`${git} status --porcelain --untracked-files=no`]: { stdout: '' }, [`${git} rev-parse --abbrev-ref HEAD`]: { stdout: 'main\n' }, [`${git} switch develop`]: { stdout: '' } });
    s.ctx.exec = fake.exec;
    expect((await runAction(s.ctx, 'git.fetch', { domain: 'local.shop.com', repo: 'wp-content/themes/wandworks' })).ok).toBe(true);
    expect((await runAction(s.ctx, 'git.switch', { domain: 'local.shop.com', repo: 'wp-content/themes/wandworks', branch: 'develop' })).ok).toBe(true);
    expect(lines(fake.calls)).toEqual([`${git} fetch --prune origin`, `${git} status --porcelain --untracked-files=no`, `${git} rev-parse --abbrev-ref HEAD`, `${git} switch develop`]);
    await expect(runAction(s.ctx, 'git.fetch', { domain: 'local.shop.com', repo: '../local.other.com' })).rejects.toThrow(ActionInputError);
    expect(fake.calls).toHaveLength(4);
  });
});

describe('git actions', () => {
  it('fetch and pull run without prompts, pull only fast-forwards', async () => {
    const s = setup();
    const git = `git -C ${s.learn}`;
    const fake = fakeExec({
      [`${git} fetch --prune origin`]: { stderr: 'From github.com:x/y\n' },
      [`${git} rev-parse --abbrev-ref @{upstream}`]: { stdout: 'origin/master\n' },
      [`${git} pull --ff-only`]: { stdout: 'Fast-forward\n' },
    });
    s.ctx.exec = fake.exec;
    expect((await runAction(s.ctx, 'git.fetch', { domain: 'local.shop.com', mount: '/learn' })).ok).toBe(true);
    expect((await runAction(s.ctx, 'git.pull', { domain: 'local.shop.com', mount: '/learn' })).ok).toBe(true);
    expect(lines(fake.calls)).toEqual([`${git} fetch --prune origin`, `${git} rev-parse --abbrev-ref @{upstream}`, `${git} pull --ff-only`]);
    expect(fake.calls[0]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: expect.stringContaining('BatchMode=yes') });
    expect(fake.calls[2]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
  });

  it('refuses to pull a branch with no upstream', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'git.pull', { domain: 'local.shop.com' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no remote branch');
  });

  it('switches a clean repo and refuses one with uncommitted changes', async () => {
    const s = setup();
    const git = `git -C ${s.docroot}`;
    let dirty = '';
    const fake = fakeExec({
      [`${git} status --porcelain --untracked-files=no`]: () => ({ stdout: dirty }),
      [`${git} rev-parse --abbrev-ref HEAD`]: { stdout: 'master\n' },
      [`${git} switch`]: { stderr: "Switched to a new branch 'feature/cart'\n" },
    });
    s.ctx.exec = fake.exec;
    expect((await runAction(s.ctx, 'git.switch', { domain: 'local.shop.com', branch: 'feature/cart' })).ok).toBe(true);
    expect(lines(fake.calls).at(-1)).toBe(`${git} switch feature/cart`);

    dirty = ' M a.php\n M b.php\n';
    const refused = await runAction(s.ctx, 'git.switch', { domain: 'local.shop.com', branch: 'develop' });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain('2 uncommitted changes');
    expect(lines(fake.calls).filter((l) => l.includes(' switch '))).toHaveLength(1);
  });

  it('rejects branch names git could read as options, and odd mount paths', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'git.switch', { domain: 'local.shop.com', branch: '--orphan' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'git.pull', { domain: 'local.shop.com', mount: '/../etc' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'git.pull', { domain: 'local.shop.com', mount: '/nope' })).rejects.toBeInstanceOf(ActionInputError);
    expect(s.calls).toHaveLength(0);
  });
});

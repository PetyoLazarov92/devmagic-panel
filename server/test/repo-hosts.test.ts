import type { Site } from '@devmagic-panel/shared';
import { branchWebUrl, registerGitHosts, registerHostAliases, repoWeb } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { OrgScanner } from '../src/org/scan.js';
import { GitHostDetector } from '../src/repo-hosts/detect.js';
import { RunStore } from '../src/store.js';
import { glabNamespaces, glabProjectPage, glabStatus, glabTooOld, glabTopNames, glabVersion } from '../src/repo-hosts/gitlab.js';
import { gitlabHostsInUse, glabOverview, listNamespaces } from '../src/repo-hosts/index.js';
import { fakeExec } from './helpers.js';

const user = (username: string) => ({ stdout: JSON.stringify({ username }) });
const noSleep = async () => undefined;

/** glab as the fake answers it, by host and the start of the API path. */
function glabFake(answers: Record<string, { stdout?: string; code?: number; stderr?: string }>, more: Parameters<typeof fakeExec>[0] = {}) {
  return fakeExec({
    ...more,
    glab: (call) => {
      const at = `${call.args[2]} ${call.args[3]}`;
      const key = Object.keys(answers).filter((k) => at.startsWith(k)).sort((a, b) => b.length - a.length)[0];
      return key ? (answers[key] as { stdout?: string }) : { code: 127, stderr: `not faked: ${at}` };
    },
  });
}

describe('the GitLab CLI', () => {
  it('says whether it is installed and signed in on a host, through glab api only', async () => {
    expect(await glabStatus(fakeExec({}).exec, 'gitlab.com')).toMatchObject({ installed: false, signedIn: false });
    const signedOut = fakeExec({ 'glab api --hostname git.acme.test user': { code: 1, stderr: 'GET https://git.acme.test/api/v4/user: 401 {message: 401 Unauthorized}' } });
    expect(await glabStatus(signedOut.exec, 'git.acme.test')).toEqual({ installed: true, signedIn: false, problem: 'not signed in to git.acme.test: run glab auth login --hostname git.acme.test' });
    const fake = fakeExec({ 'glab api --hostname gitlab.com user': user('alex') });
    expect(await glabStatus(fake.exec, 'gitlab.com')).toEqual({ installed: true, signedIn: true, user: 'alex' });
    expect(fake.calls[0]?.env).toMatchObject({ GLAB_NO_PROMPT: 'true', NO_PROMPT: 'true', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false', NO_COLOR: '1' });
  });

  it('reads its version in the old and new forms, and knows 1.36 as the oldest', async () => {
    expect(await glabVersion(fakeExec({ 'glab --version': { stdout: 'glab version 1.36.0 (2024-01-10)\n' } }).exec)).toBe('1.36.0');
    expect(await glabVersion(fakeExec({ 'glab --version': { stdout: 'glab 1.53.0 (abc123)\n' } }).exec)).toBe('1.53.0');
    expect(await glabVersion(fakeExec({}).exec)).toBeUndefined();
    expect([glabTooOld('1.35.9'), glabTooOld('1.36.0'), glabTooOld('2.0.0'), glabTooOld('0.9.1')]).toEqual([true, false, false, true]);
  });

  it('lists the groups you can clone from, a subgroup only when its parent is not there, and your own account', async () => {
    const groups = [{ full_path: 'acme' }, { full_path: 'acme/web' }, { full_path: 'acme/web/shops' }, { full_path: 'partners/acme-team' }];
    const fake = glabFake({ 'gitlab.com groups': { stdout: JSON.stringify(groups) }, 'gitlab.com user': user('alex') });
    expect(await glabNamespaces(fake.exec, 'gitlab.com')).toEqual(['gitlab.com/acme', 'gitlab.com/partners/acme-team', 'gitlab.com/alex', 'gitlab.com/~shared']);
    expect(fake.calls[0]?.args).toEqual(['api', '--hostname', 'gitlab.com', 'groups?min_access_level=20&per_page=100&page=1']);
    await expect(glabNamespaces(fakeExec({ glab: { code: 1, stderr: '403 Forbidden' } }).exec, 'gitlab.com')).rejects.toThrow('the GitLab CLI cannot list your groups on gitlab.com: 403 Forbidden');
  });

  it('tries a busy or rate limited GitLab again, but not a refusal, and takes what an older server leaves out', async () => {
    let tries = 0;
    const flaky = fakeExec({ glab: () => (++tries < 3 ? { code: 1, stderr: 'GET ...: 429 Too Many Requests' } : { stdout: JSON.stringify([{ name: 'shop', path_with_namespace: 'acme/web/shop', ssh_url_to_repo: 'git@git.acme.test:acme/web/shop.git', web_url: 'https://git.acme.test/acme/web/shop' }]) }) });
    expect(await glabProjectPage(flaky.exec, { provider: 'gitlab', host: 'git.acme.test', path: 'acme' }, false, 1, noSleep)).toEqual([
      { name: 'shop', path: 'acme/web/shop', archived: false, sshUrl: 'git@git.acme.test:acme/web/shop.git', url: 'https://git.acme.test/acme/web/shop' },
    ]);
    expect(tries).toBe(3);
    tries = 0;
    const refused = fakeExec({ glab: () => (++tries, { code: 1, stderr: '404 Group Not Found' }) });
    await expect(glabProjectPage(refused.exec, { provider: 'gitlab', host: 'gitlab.com', path: 'acme' }, false, 1, noSleep)).rejects.toThrow('404 Group Not Found');
    expect(tries).toBe(1);
    const odd = fakeExec({ glab: { stdout: '{"message":"x"}' } });
    await expect(glabProjectPage(odd.exec, { provider: 'gitlab', host: 'gitlab.com', path: 'acme' }, false, 1, noSleep)).rejects.toThrow('not a project list');
  });

  it('reads a project tree: none for an empty one, null when GitLab did not answer', async () => {
    expect(await glabTopNames(fakeExec({ glab: { stdout: JSON.stringify([{ name: 'wp-content' }, { name: 'index.php' }]) } }).exec, 'gitlab.com', 'acme/site')).toEqual(['wp-content', 'index.php']);
    expect(await glabTopNames(fakeExec({ glab: { code: 1, stderr: '404 Tree Not Found' } }).exec, 'gitlab.com', 'acme/site')).toEqual([]);
    expect(await glabTopNames(fakeExec({ glab: { code: 1, stderr: 'HTTP 502' } }).exec, 'gitlab.com', 'acme/site')).toBeNull();
  });

  it('reports each host, and nothing more when glab is missing', async () => {
    expect(await glabOverview(fakeExec({}).exec, ['gitlab.com'])).toEqual({ installed: false, hosts: [{ host: 'gitlab.com', installed: false, signedIn: false, problem: 'the GitLab CLI (glab) is not installed' }] });
    const fake = fakeExec({ 'glab --version': { stdout: 'glab version 1.36.0\n' }, 'glab api --hostname gitlab.com user': user('alex'), 'glab api --hostname git.acme.test user': { code: 1, stderr: '401 Unauthorized' } });
    const overview = await glabOverview(fake.exec, ['gitlab.com', 'git.acme.test']);
    expect(overview).toMatchObject({ installed: true, version: '1.36.0', hosts: [{ host: 'gitlab.com', signedIn: true, user: 'alex' }, { host: 'git.acme.test', signedIn: false }] });
  });
});

describe('organizations and groups to scan', () => {
  it('come from every signed-in CLI, and a host that fails says why while the rest still list', async () => {
    const fake = glabFake(
      {
        'gitlab.com user': user('alex'),
        'gitlab.com groups': { stdout: JSON.stringify([{ full_path: 'acme/web' }]) },
        'git.acme.test user': user('alex'),
        'git.acme.test groups': { code: 1, stderr: '500 Internal Server Error' },
      },
      { 'gh api user/orgs': { stdout: 'acme\n' }, 'gh api user': { stdout: 'alex\n' } },
    );
    const found = await listNamespaces(fake.exec, ['git.acme.test']);
    expect(found.namespaces.map((n) => [n.ref, n.label])).toEqual([
      ['acme', 'acme (GitHub)'],
      ['alex', 'alex (GitHub)'],
      ['~shared', 'Shared with you (GitHub)'],
      ['gitlab.com/acme/web', 'acme/web (gitlab.com)'],
      ['gitlab.com/alex', 'alex (gitlab.com)'],
      ['gitlab.com/~shared', 'Shared with you (gitlab.com)'],
    ]);
    expect(found.problems).toEqual(['the GitLab CLI cannot list your groups on git.acme.test: 500 Internal Server Error']);
  });
});

describe('GitLab hosts in use', () => {
  const site = (remote: string | undefined, mounts: string[] = []) =>
    ({ domain: 'local.acme.com', ...(remote ? { git: { remote } } : {}), mounts: mounts.map((m) => ({ path: '/learn', git: { remote: m } })) }) as unknown as Site;

  it('are none without GitLab anywhere, so the machine checks show nothing about it', () => {
    expect(gitlabHostsInUse({ selected: ['acme'], gitlabHosts: [] }, [site('git@github.com:acme/site.git'), site(undefined)])).toEqual([]);
  });

  it('come from the settings, the selected groups and the remotes of sites made by hand, gitlab.com first', () => {
    expect(gitlabHostsInUse({ selected: ['acme'], gitlabHosts: ['git.acme.test'] }, [])).toEqual(['git.acme.test']);
    expect(gitlabHostsInUse({ selected: ['gitlab.acme.test/acme'], gitlabHosts: [] }, [site(undefined, ['https://gitlab.com/acme/learn.git'])])).toEqual(['gitlab.com', 'gitlab.acme.test']);
  });
});

describe('git hosts found over SSH', () => {
  const sshG = (host: string, real: string) => ({ [`ssh -G ${host}`]: { stdout: `user git\nhostname ${real}\nport 22\n` } });

  it('asks an unknown host once with ssh -T, keeps the answer a week, and registers GitLab and Gitea hosts for links', async () => {
    const store = new RunStore(':memory:');
    let now = Date.parse('2026-11-06T09:00:00Z');
    const fake = fakeExec({
      ...sshG('git.acme.test', 'git.acme.test'),
      ...sshG('code.acme.test', 'code.acme.test'),
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@git.acme.test': { code: 0, stdout: 'Welcome to GitLab, @alex!\n' },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 -p 2222 forge@code.acme.test': { code: 1, stderr: "Hi there, alex! You've successfully authenticated with the key named work, but Forgejo does not provide shell access.\n" },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@plain.acme.test': { code: 255, stderr: 'Permission denied (publickey).\n' },
    });
    const detector = new GitHostDetector(fake.exec, store, () => now);
    const remotes = ['git@git.acme.test:acme/web/site.git', 'ssh://forge@code.acme.test:2222/acme/shop.git', 'https://plain.acme.test/acme/blog.git', 'git@github.com:acme/site.git', 'git@gitlab.com:acme/x.git'];
    try {
      await detector.refresh(remotes);
      expect(repoWeb('git@git.acme.test:acme/web/site.git')?.provider).toBe('GitLab');
      expect(branchWebUrl('ssh://forge@code.acme.test:2222/acme/shop.git', 'main')).toBe('https://code.acme.test/acme/shop/src/branch/main');
      expect(repoWeb('https://plain.acme.test/acme/blog.git')?.provider).toBe('Git');
      // Public hosts are never asked; an HTTPS remote is not resolved as an alias.
      expect(fake.calls.some((c) => c.args.some((a) => /github\.com|gitlab\.com/.test(a)))).toBe(false);
      expect(fake.calls.some((c) => c.args[0] === '-G' && c.args[1] === 'plain.acme.test')).toBe(false);
      // No host key is ever accepted for you here.
      expect(fake.calls.every((c) => !c.args.join(' ').includes('StrictHostKeyChecking'))).toBe(true);
      const asked = fake.calls.length;
      now += 3 * 24 * 3_600_000;
      await detector.refresh(remotes);
      expect(fake.calls.length).toBe(asked);
      now += 5 * 24 * 3_600_000;
      await detector.refresh(remotes);
      expect(fake.calls.length).toBe(asked * 2);
    } finally {
      registerGitHosts('detected', {});
    }
  });

  it('resolves an SSH alias to its real host, so links and merge requests go there, and keeps it after a restart', async () => {
    const store = new RunStore(':memory:');
    const fake = fakeExec({ ...sshG('gitlab-work', 'gitlab.com'), ...sshG('company', 'git.acme.test'), 'ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@company': { stdout: 'Welcome to GitLab, @alex!' } });
    try {
      await new GitHostDetector(fake.exec, store).refresh(['git@gitlab-work:acme/web/site.git', 'git@company:acme/shop.git']);
      expect(repoWeb('git@gitlab-work:acme/web/site.git')).toEqual({ provider: 'GitLab', name: 'GitLab', repoUrl: 'https://gitlab.com/acme/web/site' });
      expect(repoWeb('git@company:acme/shop.git')).toEqual({ provider: 'GitLab', name: 'git.acme.test', repoUrl: 'https://git.acme.test/acme/shop' });
      // gitlab.com behind the alias is known by name: only the alias was resolved, no hello sent.
      expect(fake.calls.filter((c) => c.args[0] === '-T').map((c) => c.args.at(-1))).toEqual(['git@company']);
      registerHostAliases({});
      registerGitHosts('detected', {});
      new GitHostDetector(fakeExec({}).exec, store).apply();
      expect(repoWeb('git@company:acme/shop.git')?.repoUrl).toBe('https://git.acme.test/acme/shop');
      expect(new GitHostDetector(fakeExec({}).exec, store).known()).toEqual({ hosts: { 'git.acme.test': 'GitLab' }, aliases: { 'gitlab-work': 'gitlab.com', company: 'git.acme.test' } });
    } finally {
      registerHostAliases({});
      registerGitHosts('detected', {});
    }
  });
});

describe('repos shared with you', () => {
  it('on GitHub are the repos you collaborate on, with their owners in the path', async () => {
    const fake = fakeExec({
      'gh api user': { stdout: 'alex\n' },
      'gh api user/repos?affiliation=collaborator&per_page=100&sort=pushed&direction=desc&page=1': {
        stdout: JSON.stringify([{ name: 'site', archived: false, pushed_at: '2026-10-01T00:00:00Z', default_branch: 'main', ssh_url: 'git@github.com:north/site.git', html_url: 'https://github.com/north/site', full_name: 'north/site' }, { name: 'site', archived: false, pushed_at: '2026-09-01T00:00:00Z', default_branch: 'main', ssh_url: 'git@github.com:south/site.git', html_url: 'https://github.com/south/site', full_name: 'south/site' }]),
      },
      'gh api repos/north/site/contents': { stdout: 'wp-content\n' },
      'gh api repos/south/site/contents': { stdout: 'style.css\nfunctions.php\n' },
    });
    const store = new RunStore(':memory:');
    const { repos } = await new OrgScanner(fake.exec, store).repos('~shared', { sites: [], installs: new Map(), trash: [], drafts: [] }, 'auto');
    expect(repos.map((r) => [r.org, r.fullName, r.kind])).toEqual([['~shared', 'north/site', 'site'], ['~shared', 'south/site', 'theme']]);
    expect(store.orgRepos('~shared')).toHaveLength(2);
  });

  it('on GitLab are the projects you were added to outside your groups and your own account', async () => {
    const project = (path: string) => ({ name: path.split('/').at(-1), path_with_namespace: path, archived: false, last_activity_at: '2026-10-01T00:00:00Z', default_branch: 'main', ssh_url_to_repo: `git@gitlab.com:${path}.git`, web_url: `https://gitlab.com/${path}` });
    const fake = glabFake({
      'gitlab.com user': user('alex'),
      'gitlab.com groups': { stdout: JSON.stringify([{ full_path: 'acme' }]) },
      'gitlab.com projects?membership=true': { stdout: JSON.stringify([project('acme/web/site'), project('alex/notes'), project('partner/client-site'), project('acmeco/site')]) },
      'gitlab.com projects/': { stdout: JSON.stringify([{ name: 'wp-content' }]) },
    });
    const { repos } = await new OrgScanner(fake.exec, new RunStore(':memory:')).repos('gitlab.com/~shared', { sites: [], installs: new Map(), trash: [], drafts: [] }, 'auto');
    expect(repos.map((r) => r.fullName)).toEqual(['partner/client-site', 'acmeco/site']);
    expect(fake.calls.find((c) => (c.args[3] as string).startsWith('projects?'))?.args[3]).toBe('projects?membership=true&min_access_level=20&order_by=last_activity_at&sort=desc&per_page=100&page=1');
  });
});

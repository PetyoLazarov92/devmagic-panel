import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/exec.js';
import { runCommand } from '../src/exec.js';
import { findReleases, ghSource, gitSource, httpsSource, type ReleaseSource, SourceRefused } from '../src/release-source.js';

const answering = (status: number) => (async () => new Response('{"message":"x"}', { status })) as unknown as typeof fetch;

describe('httpsSource', () => {
  it('says why the public way cannot read the releases', async () => {
    await expect(httpsSource('me/panel', answering(404)).releases()).rejects.toThrow('me/panel is not public');
    await expect(httpsSource('me/panel', answering(403)).releases()).rejects.toThrow('too many requests');
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    await expect(httpsSource('me/panel', offline).releases()).rejects.toBeInstanceOf(SourceRefused);
  });

  it('never reads a file that is not a release file', async () => {
    await expect(httpsSource('me/panel', answering(200)).text('v0.7.0', '../secrets.json')).rejects.toThrow('not a release file');
    await expect(httpsSource('me/panel', answering(200)).text('main', 'x.json')).rejects.toThrow('not a release');
  });
});

describe('ghSource', () => {
  const list = JSON.stringify([
    { tag_name: 'v0.6.0', body: '* old', assets: [] },
    { tag_name: 'v0.7.0', body: '* new', published_at: '2026-10-27T10:00:00Z', assets: [{ name: 'devmagic-panel-v0.7.0.tar.gz', size: 42 }] },
    { tag_name: 'v0.8.0', draft: true },
  ]);

  it('reads the releases with the CLI, newest first, and downloads with argument lists only', async () => {
    const calls: string[][] = [];
    const exec: Executor = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'api') return { code: 0, stdout: list, stderr: '' };
      if (args.includes('-O') && args[args.indexOf('-O') + 1] === '-') return { code: 0, stdout: 'abc  devmagic-panel-v0.7.0.tar.gz\n', stderr: '' };
      writeFileSync(args[args.indexOf('-O') + 1] as string, 'package');
      return { code: 0, stdout: '', stderr: '' };
    };
    const gh = ghSource(exec, 'me/panel');
    expect(await gh.releases()).toEqual([
      { tag: 'v0.7.0', notes: '* new', date: '2026-10-27T10:00:00Z', sizes: { 'devmagic-panel-v0.7.0.tar.gz': 42 } },
      { tag: 'v0.6.0', notes: '* old', sizes: {} },
    ]);
    expect(await gh.text('v0.7.0', 'devmagic-panel-v0.7.0.tar.gz.sha256')).toContain('abc');
    const dest = join(mkdtempSync(join(tmpdir(), 'dmp-gh-')), 'pkg.tar.gz');
    await gh.download('v0.7.0', 'devmagic-panel-v0.7.0.tar.gz', dest);
    expect(readFileSync(dest, 'utf8')).toBe('package');
    expect(calls).toEqual([
      ['gh', 'api', '-H', 'Accept: application/vnd.github+json', 'repos/me/panel/releases?per_page=30'],
      ['gh', 'release', 'download', 'v0.7.0', '-R', 'me/panel', '-p', 'devmagic-panel-v0.7.0.tar.gz.sha256', '-O', '-'],
      ['gh', 'release', 'download', 'v0.7.0', '-R', 'me/panel', '-p', 'devmagic-panel-v0.7.0.tar.gz', '-O', dest, '--clobber'],
    ]);
  });

  it('says when the CLI is missing, signed out or cannot read the repository', async () => {
    const failing = (code: number, stderr: string): Executor => async () => ({ code, stdout: '', stderr });
    await expect(ghSource(failing(127, ''), 'me/panel').releases()).rejects.toThrow('the GitHub CLI (gh) is not installed');
    await expect(ghSource(failing(4, 'To get started with GitHub CLI, please run:  gh auth login'), 'me/panel').releases()).rejects.toThrow('not signed in');
    await expect(ghSource(failing(1, 'gh: Not Found (HTTP 404)'), 'me/panel').releases()).rejects.toThrow('cannot read me/panel');
  });
});

/**
 * A repository with two package tags, the way the release workflow pushes
 * them: annotated tags on commits with no history, holding the files, their
 * messages the notes. Served over file:// so --filter works as on GitHub.
 */
function packageRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-git-'));
  const repo = join(root, 'origin');
  // Never signed, whatever the global git config says: signing would need a passphrase.
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Alex Morgan', '-c', 'user.email=alex@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8' });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const [tag, body] of [['v0.6.0', 'old'], ['v0.7.0', 'new']] as const) {
    git('checkout', '-q', '--orphan', `build-${tag}`);
    git('rm', '-rqf', '--ignore-unmatch', '.');
    writeFileSync(join(repo, `devmagic-panel-${tag}.json`), JSON.stringify({ name: tag }));
    writeFileSync(join(repo, `devmagic-panel-${tag}.tar.gz`), `package ${tag}`);
    git('add', '-A');
    git('commit', '-q', '-m', `${tag} package`);
    git('tag', '-a', `pkg/${tag}`, '-m', `* **Panel:** ${body}`);
  }
  return { root, url: `file://${repo}` };
}

describe('gitSource', () => {
  it('reads the package tags without their files, then fetches a file only when it is read', async () => {
    const { root, url } = packageRepo();
    const cache = join(root, 'data', 'updates.git');
    const source = gitSource(runCommand, url, cache);
    const releases = await source.releases();
    expect(releases.map((r) => [r.tag, r.notes])).toEqual([
      ['v0.7.0', '* **Panel:** new'],
      ['v0.6.0', '* **Panel:** old'],
    ]);
    expect(releases[0]?.sizes).toBeUndefined();
    // The tags came without the packages.
    const missing = execFileSync('git', ['-C', cache, 'rev-list', '--objects', '--missing=print', '--all'], { encoding: 'utf8' });
    expect(missing.split('\n').filter((l) => l.startsWith('?'))).toHaveLength(4);

    expect(JSON.parse(await source.text('v0.7.0', 'devmagic-panel-v0.7.0.json'))).toEqual({ name: 'v0.7.0' });
    const dest = join(root, 'data', 'devmagic-panel-v0.7.0.tar.gz');
    await source.download('v0.7.0', 'devmagic-panel-v0.7.0.tar.gz', dest);
    expect(readFileSync(dest, 'utf8')).toBe('package v0.7.0');
    expect(existsSync(join(root, 'data', '.git-v0.7.0'))).toBe(false);
  });

  it('says why when git cannot read the repository, and refuses a remote that is no remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmp-git-'));
    await expect(gitSource(runCommand, `file://${join(root, 'nothing')}`, join(root, 'cache.git')).releases()).rejects.toThrow(/^git cannot read file:/);
    expect(() => gitSource(runCommand, '--upload-pack=touch /tmp/x', join(root, 'c.git'))).toThrow('not a git remote');
  });
});

describe('findReleases', () => {
  const source = (way: ReleaseSource['way'], works: boolean, seen: string[]): ReleaseSource => ({
    way,
    releases: async () => {
      seen.push(way);
      if (!works) throw new Error(`${way} refused`);
      return [];
    },
    text: async () => '',
    download: async () => undefined,
  });

  it('tries the way that worked last first, then the others in order', async () => {
    const seen: string[] = [];
    const found = await findReleases([source('https', false, seen), source('gh', true, seen), source('git', true, seen)], 'git');
    expect('source' in found && found.source.way).toBe('git');
    expect(seen).toEqual(['git']);
    const second: string[] = [];
    expect(await findReleases([source('https', false, second), source('gh', true, second)])).toMatchObject({ problems: [{ way: 'https', problem: 'https refused' }] });
    expect(second).toEqual(['https', 'gh']);

    const none: string[] = [];
    expect(await findReleases([source('https', false, none), source('gh', false, none), source('git', false, none)], 'gh')).toEqual({
      problems: [
        { way: 'https', problem: 'https refused' },
        { way: 'gh', problem: 'gh refused' },
        { way: 'git', problem: 'git refused' },
      ],
    });
    expect(none).toEqual(['gh', 'https', 'git']);
  });
});

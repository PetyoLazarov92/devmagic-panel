import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/exec.js';
import { runCommand } from '../src/exec.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { httpsSource, type ReleaseSource } from '../src/release-source.js';
import { RunStore } from '../src/store.js';
import { checkUpdate, compareVersions, installedReleases, notesItems, parseChangelog, planSwitch, planUpdate, type ReleaseInfo, type UpdateContext } from '../src/update.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A release folder as install.sh leaves it: release.json and a built server. */
function releaseFolder(dir: string, info: ReleaseInfo, at?: Date): string {
  mkdirSync(join(dir, 'server', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'server', 'dist', 'index.js'), `// ${info.name}\n`);
  writeFileSync(join(dir, 'release.json'), JSON.stringify(info, null, 2));
  if (at) utimesSync(dir, at, at);
  return dir;
}

/**
 * GitHub as the public way sees it: releases v0.7.0 and v0.6.0 with their
 * notes, and v0.7.0's package, checksum and release.json behind the download
 * addresses. A private repository answers 404.
 */
function fakeGitHub(opts: { tarball: Buffer; sum: string; releaseJson: string; assets?: boolean; isPublic?: boolean }) {
  const calls: string[] = [];
  const tag = 'v0.7.0';
  const files: Record<string, Buffer> = {
    [`devmagic-panel-${tag}.tar.gz`]: opts.tarball,
    [`devmagic-panel-${tag}.tar.gz.sha256`]: Buffer.from(`${opts.sum}  devmagic-panel-${tag}.tar.gz\n`),
    [`devmagic-panel-${tag}.json`]: Buffer.from(opts.releaseJson),
  };
  const asset = (name: string) => ({ name, size: (files[name] as Buffer).length, browser_download_url: `https://objects.example.com/${name}` });
  const list = [
    { tag_name: tag, body: '* **Panel:** what v0.7.0 brings\n* **Sites:** and more', published_at: '2026-10-27T10:00:00Z', assets: opts.assets === false ? [] : Object.keys(files).map(asset) },
    { tag_name: 'v0.6.1-rc.1', body: 'a test', prerelease: true },
    { tag_name: 'v0.6.0', body: '* **Panel:** what v0.6.0 brought', published_at: '2026-10-25T10:00:00Z', assets: [] },
  ];
  const get = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if ((init?.headers as Record<string, string> | undefined)?.authorization) throw new Error('no token is ever sent');
    if (opts.isPublic === false) return new Response('{"message":"Not Found"}', { status: 404 });
    if (url === 'https://api.github.com/repos/me/panel/releases?per_page=30') return new Response(JSON.stringify(list), { status: 200 });
    const file = /^https:\/\/objects\.example\.com\/(.+)$/.exec(url);
    if (file && files[file[1] as string]) return new Response(new Uint8Array(files[file[1] as string] as Buffer), { status: 200 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
  return { get, calls };
}

/** tar for real, in the temp folder; systemd-run is recorded and pretends to work. */
function mixedExec() {
  const calls: string[] = [];
  const exec: Executor = async (file, args, options) => {
    if (file === 'tar') return runCommand(file, args, options);
    calls.push([file, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/**
 * The panel installed from release v0.6.0: releases/v0.6.0 with current
 * pointing at it, the root scripts it installed, and GitHub with v0.7.0,
 * which changes the root scripts or the installer when asked to.
 */
function machine(opts: { newScripts?: boolean; newInstaller?: boolean; badSum?: boolean; isPublic?: boolean; assets?: boolean; sources?: ReleaseSource[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dmp-update-'));
  const data = join(root, 'data');
  const prefix = join(root, 'lib');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(prefix, 'lib'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'dmp-root'), 'root v1\n');
  writeFileSync(join(prefix, 'lib', 'cert.sh'), 'cert v1\n');
  const scripts = { 'bin/dmp-root': sha('root v1\n'), 'lib/cert.sh': sha('cert v1\n') };
  const appDir = releaseFolder(join(data, 'releases', 'v0.6.0'), { name: 'v0.6.0', version: '0.6.0', commit: 'aaa', installer: sha('installer v1'), scripts }, new Date(Date.now() - 86_400_000));
  symlinkSync(join('releases', 'v0.6.0'), join(data, 'current'));

  const next: ReleaseInfo = {
    name: 'v0.7.0',
    version: '0.7.0',
    commit: 'bbb',
    installer: sha(opts.newInstaller ? 'installer v2' : 'installer v1'),
    scripts: opts.newScripts ? { ...scripts, 'bin/dmp-root': sha('root v2\n') } : scripts,
  };
  const pkg = join(root, 'pkg');
  releaseFolder(join(pkg, 'devmagic-panel-v0.7.0'), next);
  const tarballFile = join(root, 'devmagic-panel-v0.7.0.tar.gz');
  execFileSync('tar', ['-czf', tarballFile, '-C', pkg, 'devmagic-panel-v0.7.0']);
  const tarball = readFileSync(tarballFile);
  const github = fakeGitHub({ tarball, sum: opts.badSum ? sha('something else') : sha(tarball), releaseJson: JSON.stringify(next), ...(opts.isPublic === false ? { isPublic: false } : {}), ...(opts.assets === false ? { assets: false } : {}) });
  const { exec, calls } = mixedExec();
  const ctx: UpdateContext = {
    exec,
    appDir,
    dataDir: data,
    version: '0.6.0',
    logsDir: join(root, 'logs'),
    dmpRoot: join(prefix, 'bin', 'dmp-root'),
    sources: opts.sources ?? [httpsSource('me/panel', github.get)],
    memory: {},
  };
  return { root, data, ctx, calls, github, scripts, tarball, next };
}

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 1000; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('job did not settle');
}

const current = (data: string) => readlinkSync(join(data, 'current'));

describe('release versions and notes', () => {
  it('compares versions by number and reads the items of release notes', () => {
    expect(compareVersions('v0.10.0', '0.9.2')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('nope', 'v0.0.1')).toBeLessThan(0);
    expect(notesItems('* **Panel:** one\n- **Sites:** two\n')).toEqual(['**Panel:** one', '**Sites:** two']);
    expect(notesItems('## Notes\n\nA plain line.\n')).toEqual(['A plain line.']);
  });
});

describe('the changelog of installed releases', () => {
  const changelog = [
    '# Changelog', '', '### v0.7.0 (2026-10-07)', '* **Panel:** seven', '### v0.6.1 (2026-10-05)', '* **Sites:** six one', '- **Mail:** six one too',
    '### v0.6.0 (2026-10-03)', '* **Panel:** six', '### v0.5.1', '* **Panel:** five one', '### v0.5.0 (2026-09-30)', '* **Panel:** five', '',
  ].join('\n');

  it('reads each version with its date and items, newest first', () => {
    expect(parseChangelog(changelog).slice(0, 2)).toEqual([
      { version: 'v0.7.0', date: '2026-10-07', items: ['**Panel:** seven'] },
      { version: 'v0.6.1', date: '2026-10-05', items: ['**Sites:** six one', '**Mail:** six one too'] },
    ]);
    expect(parseChangelog(changelog).find((c) => c.version === 'v0.5.1')).toEqual({ version: 'v0.5.1', items: ['**Panel:** five one'] });
  });

  it("says what switching to each release adds or removes, from the newest one's changelog", () => {
    const data = mkdtempSync(join(tmpdir(), 'dmp-releases-'));
    const info = (version: string): ReleaseInfo => ({ name: `v${version}`, version, commit: 'c', installer: 'i', scripts: {} });
    for (const v of ['0.5.0', '0.6.0', '0.7.0']) releaseFolder(join(data, 'releases', `v${v}`), info(v));
    writeFileSync(join(data, 'releases', 'v0.7.0', 'CHANGELOG.md'), changelog);
    symlinkSync(join('releases', 'v0.6.0'), join(data, 'current'));
    const byName = new Map(installedReleases({ dataDir: data, dmpRoot: join(data, 'lib', 'bin', 'dmp-root') }).map((r) => [r.name, r.changes]));
    const versions = (name: string) => ({ kind: byName.get(name)?.kind, versions: byName.get(name)?.sections.map((s) => s.version) });
    expect(versions('v0.7.0')).toEqual({ kind: 'adds', versions: ['v0.7.0', 'v0.6.1'] });
    expect(versions('v0.6.0')).toEqual({ kind: 'running', versions: ['v0.6.0'] });
    expect(versions('v0.5.0')).toEqual({ kind: 'removes', versions: ['v0.6.0', 'v0.5.1'] });
  });
});

describe('checkUpdate', () => {
  it('offers a newer release that keeps the root scripts as an update from the panel, with its release notes', async () => {
    const m = machine();
    const status = await checkUpdate(m.ctx);
    expect(status).toMatchObject({ current: '0.6.0', release: 'v0.6.0', latest: 'v0.7.0', available: true, mode: 'panel', source: 'https' });
    expect(status.installerChanged).toBeUndefined();
    // Only the versions newer than the running one, from their release notes; a pre-release is left out.
    expect(status.changelog).toEqual([{ version: 'v0.7.0', date: '2026-10-27', items: ['**Panel:** what v0.7.0 brings', '**Sites:** and more'] }]);
    expect(status.packageBytes).toBe(m.tarball.length);
    expect(status.releases).toEqual([expect.objectContaining({ name: 'v0.6.0', current: true, mode: 'panel' })]);
    expect(m.ctx.memory?.way).toBe('https');
  });

  it('lists the release notes newest first, whatever order the releases come in', async () => {
    const m = machine();
    const source: ReleaseSource = {
      way: 'git',
      releases: async () => [
        { tag: 'v0.6.2', notes: '* two' },
        { tag: 'v0.7.0', notes: '* three' },
        { tag: 'v0.5.9', notes: '* older than the running one' },
        { tag: 'v0.6.1', notes: '* one' },
      ],
      text: async (_tag, name) => (name.endsWith('.json') ? JSON.stringify(m.next) : ''),
      download: async () => undefined,
    };
    const status = await checkUpdate({ ...m.ctx, sources: [source] });
    expect(status.changelog.map((c) => c.version)).toEqual(['v0.7.0', 'v0.6.2', 'v0.6.1']);
  });

  it('updates from the panel when only the installer changed, and says to run it afterwards', async () => {
    const m = machine({ newInstaller: true });
    expect(await checkUpdate(m.ctx)).toMatchObject({ mode: 'panel', installerChanged: true, command: join(m.data, 'current', 'install.sh') });
  });

  it('sends a release that changes root scripts to its installer in a terminal', async () => {
    const m = machine({ newScripts: true });
    const status = await checkUpdate(m.ctx);
    expect(status).toMatchObject({ available: true, mode: 'terminal', command: join(m.data, 'releases', 'v0.7.0', 'install.sh') });
    expect(status.reason).toContain('changes the root scripts (bin/dmp-root)');
  });

  it('tries the next way when one cannot read the repository, and lists why each failed when none can', async () => {
    const hidden = machine({ isPublic: false });
    const working: ReleaseSource = {
      way: 'git',
      releases: async () => [{ tag: 'v0.7.0', notes: '* **Panel:** from the tag' }],
      text: async (_tag, name) => (name.endsWith('.json') ? JSON.stringify(hidden.next) : ''),
      download: async () => undefined,
    };
    const refused = (way: 'gh' | 'git', problem: string): ReleaseSource => ({ way, releases: async () => { throw new Error(problem); }, text: async () => '', download: async () => undefined });
    const ctx = { ...hidden.ctx, sources: [hidden.ctx.sources[0] as ReleaseSource, refused('gh', 'the GitHub CLI (gh) is not installed'), working] };
    const status = await checkUpdate(ctx);
    expect(status).toMatchObject({ available: true, mode: 'panel', source: 'git', changelog: [{ version: 'v0.7.0', items: ['**Panel:** from the tag'] }] });
    expect(status.packageBytes).toBeUndefined();
    // Why the ways before it failed, for the Updates page.
    expect(status.access).toEqual([{ way: 'https', problem: 'me/panel is not public' }, { way: 'gh', problem: 'the GitHub CLI (gh) is not installed' }]);
    // The way that worked is tried first next time.
    expect(ctx.memory?.way).toBe('git');

    const none = await checkUpdate({ ...hidden.ctx, memory: {}, sources: [hidden.ctx.sources[0] as ReleaseSource, refused('gh', 'the GitHub CLI is not signed in: run gh auth login'), refused('git', 'git cannot read git@github.com:me/panel.git: Permission denied')] });
    expect(none).toMatchObject({ available: false, mode: 'blocked', error: expect.stringContaining('No way could read the releases') });
    expect(none.access).toEqual([
      { way: 'https', problem: 'me/panel is not public' },
      { way: 'gh', problem: 'the GitHub CLI is not signed in: run gh auth login' },
      { way: 'git', problem: 'git cannot read git@github.com:me/panel.git: Permission denied' },
    ]);
  });

  it('says when it is up to date, when the package is not published yet, and when it runs from a checkout', async () => {
    const m = machine();
    expect(await checkUpdate({ ...m.ctx, version: '0.7.0' })).toMatchObject({ latest: 'v0.7.0', available: false, reason: 'You have the latest version.' });

    const early = machine({ assets: false });
    expect(await checkUpdate(early.ctx)).toMatchObject({ available: true, mode: 'blocked', reason: expect.stringContaining('release workflow may still be running') });

    const checkout = mkdtempSync(join(tmpdir(), 'dmp-checkout-'));
    expect(await checkUpdate({ ...m.ctx, appDir: checkout })).toMatchObject({ mode: 'blocked', reason: expect.stringContaining('runs from a checkout') });
  });

  it('shows the one-time note about the deleted GitHub token', async () => {
    const m = machine();
    expect(await checkUpdate({ ...m.ctx, notice: () => 'revoke it' })).toMatchObject({ notice: 'revoke it' });
  });
});

describe('planUpdate', () => {
  it('downloads, checks, unpacks and switches to the release, restarts, and keeps the newest releases', async () => {
    const m = machine();
    // Two older releases: with v0.7.0 and v0.6.0 only the newer of them stays.
    releaseFolder(join(m.data, 'releases', 'v0.5.0'), { name: 'v0.5.0', version: '0.5.0', commit: 'x', installer: 'x', scripts: m.scripts }, new Date(Date.now() - 3 * 86_400_000));
    releaseFolder(join(m.data, 'releases', 'v0.5.1'), { name: 'v0.5.1', version: '0.5.1', commit: 'y', installer: 'y', scripts: m.scripts }, new Date(Date.now() - 2 * 86_400_000));
    const jobs = new Jobs(new RunStore(':memory:'));
    const view = await settle(jobs, jobs.start(planUpdate(m.ctx, 'v0.7.0', 'panel'), { runId: 1, title: 'Update', kind: 'panel.update' }).id);
    expect(view.status).toBe('done');
    expect(view.steps.map((s) => s.id)).toEqual(['download', 'verify', 'unpack', 'switch', 'restart']);
    expect(current(m.data)).toBe(join('releases', 'v0.7.0'));
    expect(readdirSync(join(m.data, 'releases')).sort()).toEqual(['v0.5.1', 'v0.6.0', 'v0.7.0']);
    expect(m.calls).toEqual(['systemd-run --user --on-active=3 --timer-property=AccuracySec=100ms systemctl --user restart devmagic-panel.service']);
    expect(installedReleases(m.ctx)[0]).toMatchObject({ name: 'v0.7.0', current: true });
    expect(m.github.calls).toContain('https://objects.example.com/devmagic-panel-v0.7.0.tar.gz');
    expect(view.steps[0]?.output).toContain('through public GitHub releases');
    const [log] = readdirSync(m.ctx.logsDir);
    expect(readFileSync(join(m.ctx.logsDir, log as string), 'utf8')).toContain('==> Switch the panel to v0.7.0');

    // Undo points current back and restarts again.
    jobs.undo(view.id);
    await settle(jobs, view.id);
    expect(current(m.data)).toBe(join('releases', 'v0.6.0'));
    expect(m.calls).toHaveLength(2);
  });

  it('never unpacks a package that does not match its checksum', async () => {
    const m = machine({ badSum: true });
    const jobs = new Jobs(new RunStore(':memory:'));
    const view = await settle(jobs, jobs.start(planUpdate(m.ctx, 'v0.7.0', 'panel'), { runId: 1, title: 'Update' }).id);
    expect(view.steps.find((s) => s.id === 'verify')).toMatchObject({ status: 'failed', output: expect.stringContaining('checksum mismatch') });
    expect(current(m.data)).toBe(join('releases', 'v0.6.0'));
    expect(readdirSync(join(m.data, 'releases'))).toEqual(['v0.6.0']);
    expect(m.calls).toEqual([]);
  });

  it('for a terminal install, unpacks the release and leaves the switch to its installer', async () => {
    const m = machine({ newScripts: true });
    const jobs = new Jobs(new RunStore(':memory:'));
    const view = await settle(jobs, jobs.start(planUpdate(m.ctx, 'v0.7.0', 'terminal'), { runId: 1, title: 'Download' }).id);
    expect(view.status).toBe('done');
    expect(view.steps.map((s) => s.id)).toEqual(['download', 'verify', 'unpack', 'handover']);
    expect(view.steps.at(-1)?.output).toContain(`Run ${join(m.data, 'releases', 'v0.7.0', 'install.sh')} in a terminal`);
    expect(current(m.data)).toBe(join('releases', 'v0.6.0'));
    expect(existsSync(join(m.data, 'releases', 'v0.7.0', 'release.json'))).toBe(true);
    expect(installedReleases(m.ctx).find((r) => r.name === 'v0.7.0')).toMatchObject({ current: false, mode: 'terminal', command: join(m.data, 'releases', 'v0.7.0', 'install.sh') });
    expect(m.calls).toEqual([]);
  });
});

describe('planSwitch', () => {
  it('switches to an installed release and restarts', async () => {
    const m = machine();
    releaseFolder(join(m.data, 'releases', 'v0.5.0'), { name: 'v0.5.0', version: '0.5.0', commit: 'x', installer: 'x', scripts: m.scripts });
    const jobs = new Jobs(new RunStore(':memory:'));
    const view = await settle(jobs, jobs.start(planSwitch(m.ctx, 'v0.5.0'), { runId: 1, title: 'Switch', kind: 'panel.switchRelease' }).id);
    expect(view.status).toBe('done');
    expect(current(m.data)).toBe(join('releases', 'v0.5.0'));
    expect(m.calls).toHaveLength(1);

    const missing = await settle(jobs, jobs.start(planSwitch(m.ctx, 'v0.4.0'), { runId: 2, title: 'Switch' }).id);
    expect(missing.steps[0]).toMatchObject({ status: 'failed', output: expect.stringContaining('v0.4.0 is not in') });
  });
});

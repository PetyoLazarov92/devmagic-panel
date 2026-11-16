import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOOLS, toolText } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { Jobs, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { otherCopy, panelLink, planInstallTool, resolveTool, toolBin, toolDir, toolLink, type ToolPlaces } from '../src/tools.js';
import { fakeExec } from './helpers.js';

const ARCHIVE = Buffer.from('pretend this is gh_9.9.9_linux_amd64.tar.gz');
const SHA = createHash('sha256').update(ARCHIVE).digest('hex');
const PIN = { name: 'GitHub CLI', version: '9.9.9', url: TOOLS.gh.url, member: TOOLS.gh.member, sha256: { amd64: SHA, arm64: SHA } };

async function run(steps: ReturnType<typeof planInstallTool>): Promise<{ view: JobView; jobs: Jobs }> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const view = jobs.start(steps, { runId: store.start('tools.install', { tool: 'gh' }), title: 'Install the GitHub CLI' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    if (v.status !== 'running') return { view: v, jobs };
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-tools-'));
  const places: ToolPlaces = { dataDir: join(root, 'data'), home: join(root, 'home'), searchPath: join(root, 'path') };
  mkdirSync(places.searchPath as string, { recursive: true });
  const bin = toolBin(places, 'gh', '9.9.9');
  const fake = fakeExec({
    // The fake tar "unpacks" the program where the real one would.
    'tar -xzf': () => (writeFileSync(bin, '#!/bin/sh\n'), { stdout: '' }),
    [`${bin} --version`]: { stdout: 'gh version 9.9.9 (2026-11-12)\n' },
  });
  const urls: string[] = [];
  const download = async (url: string, file: string, onProgress: (d: number, t: number) => void) => {
    urls.push(url);
    writeFileSync(file, ARCHIVE);
    onProgress(ARCHIVE.length, ARCHIVE.length);
  };
  const installed: Array<string | null> = [];
  return { root, places, bin, fake, urls, download, installed, ctx: { exec: fake.exec, places, download, onInstalled: (b: string | null) => installed.push(b) } };
}

describe('pinned tools', () => {
  it('pins gh with a checksum for each processor, from its own project on GitHub', () => {
    expect(TOOLS.gh.sha256.amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(TOOLS.gh.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(toolText(TOOLS.gh.url, TOOLS.gh, 'arm64')).toBe(`https://github.com/cli/cli/releases/download/v${TOOLS.gh.version}/gh_${TOOLS.gh.version}_linux_arm64.tar.gz`);
    expect(toolText(TOOLS.gh.member, TOOLS.gh, 'amd64')).toBe(`gh_${TOOLS.gh.version}_linux_amd64/bin/gh`);
  });
});

describe('the pinned GitLab CLI', () => {
  it('pins glab from its own project on GitLab, with a checksum for each processor', () => {
    expect(TOOLS.glab.sha256.amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(TOOLS.glab.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(toolText(TOOLS.glab.url, TOOLS.glab, 'amd64')).toBe(`https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${TOOLS.glab.version}/glab_${TOOLS.glab.version}_linux_amd64.tar.gz`);
    expect(TOOLS.glab.member).toBe('bin/glab');
  });
});

describe('the pinned rclone', () => {
  it('pins rclone from its own project on GitHub, a zip with a checksum for each processor', () => {
    expect(TOOLS.rclone.sha256.amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(TOOLS.rclone.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(TOOLS.rclone.archive).toBe('zip');
    expect(toolText(TOOLS.rclone.url, TOOLS.rclone, 'arm64')).toBe(`https://github.com/rclone/rclone/releases/download/v${TOOLS.rclone.version}/rclone-v${TOOLS.rclone.version}-linux-arm64.zip`);
    expect(toolText(TOOLS.rclone.member, TOOLS.rclone, 'amd64')).toBe(`rclone-v${TOOLS.rclone.version}-linux-amd64/rclone`);
  });

  it('unpacks only its program from the zip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmp-rclone-'));
    const places: ToolPlaces = { dataDir: join(root, 'data'), home: join(root, 'home'), searchPath: join(root, 'path') };
    mkdirSync(places.searchPath as string, { recursive: true });
    const bin = toolBin(places, 'rclone', '9.9.9');
    const fake = fakeExec({ 'unzip -j': () => (writeFileSync(bin, '#!/bin/sh\n'), { stdout: '' }), [`${bin} --version`]: { stdout: 'rclone v9.9.9\n' } });
    const pin = { ...TOOLS.rclone, version: '9.9.9', sha256: { amd64: SHA, arm64: SHA } };
    const { view } = await run(planInstallTool({ exec: fake.exec, places, download: async (_u: string, file: string) => writeFileSync(file, ARCHIVE) }, 'rclone', 'amd64', pin));
    expect(view.status).toBe('done');
    const dir = toolDir(places, 'rclone', '9.9.9');
    expect([fake.calls[0]?.file, ...(fake.calls[0]?.args ?? [])].join(' ')).toBe(`unzip -j -o -q ${join(dir, 'release.zip')} rclone-v9.9.9-linux-amd64/rclone -d ${dir}`);
  });
});

describe('installing a tool', () => {
  it('downloads the pin, checks it, keeps only the program and links it into ~/.local/bin', async () => {
    const s = setup();
    const { view } = await run(planInstallTool(s.ctx, 'gh', 'amd64', PIN));
    expect(view.status).toBe('done');
    expect(s.urls).toEqual(['https://github.com/cli/cli/releases/download/v9.9.9/gh_9.9.9_linux_amd64.tar.gz']);
    const dir = toolDir(s.places, 'gh', '9.9.9');
    expect(s.fake.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([
      `tar -xzf ${join(dir, 'release.tar.gz')} -C ${dir} --no-same-owner --strip-components=2 gh_9.9.9_linux_amd64/bin/gh`,
      `${s.bin} --version`,
    ]);
    expect(existsSync(join(dir, 'release.tar.gz'))).toBe(false);
    expect(readlinkSync(toolLink(s.places, 'gh'))).toBe(s.bin);
    expect(panelLink(s.places, 'gh')).toBe(true);
    expect(s.installed).toEqual([s.bin]);
  });

  it('deletes a download whose checksum does not match and unpacks nothing', async () => {
    const s = setup();
    const { view } = await run(planInstallTool(s.ctx, 'gh', 'amd64', { ...PIN, sha256: { amd64: 'a'.repeat(64), arm64: SHA } }));
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.output).toMatch(/checksum mismatch/);
    expect(s.fake.calls).toHaveLength(0);
    expect(existsSync(join(toolDir(s.places, 'gh', '9.9.9'), 'release.tar.gz'))).toBe(false);
    expect(s.installed).toEqual([]);
  });

  it('never installs over a copy of yours, and uses that one', () => {
    const s = setup();
    const yours = join(s.places.searchPath as string, 'gh');
    writeFileSync(yours, '#!/bin/sh\n');
    chmodSync(yours, 0o755);
    expect(otherCopy(s.places, 'gh')).toBe(yours);
    expect(() => planInstallTool(s.ctx, 'gh', 'amd64', PIN)).toThrow(`installed already at ${yours}`);
    expect(resolveTool(s.places, 'gh')).toBe('gh');
  });

  it("leaves a file of yours in ~/.local/bin alone and runs its own copy", async () => {
    const s = setup();
    const link = toolLink(s.places, 'gh');
    mkdirSync(join(s.places.home, '.local', 'bin'), { recursive: true });
    symlinkSync('/nowhere/gh', link);
    const { view } = await run(planInstallTool(s.ctx, 'gh', 'amd64', PIN));
    expect(view.status).toBe('done');
    expect(view.steps.at(-1)?.output).toContain('not the panel');
    expect(readlinkSync(link)).toBe('/nowhere/gh');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('runs its own copy once it has one, and counts its own link as no copy of yours', async () => {
    const s = setup();
    await run(planInstallTool(s.ctx, 'gh', 'amd64', PIN));
    expect(otherCopy(s.places, 'gh')).toBeNull();
    // The pinned version's copy, as the panel finds it at its start.
    const current = toolBin(s.places, 'gh');
    mkdirSync(dirname(current), { recursive: true });
    writeFileSync(current, '#!/bin/sh\n');
    chmodSync(current, 0o755);
    expect(resolveTool(s.places, 'gh')).toBe(current);
  });

  it('refuses a processor without a build', () => {
    const s = setup();
    expect(() => planInstallTool(s.ctx, 'gh', null, PIN)).toThrow('no GitHub CLI build');
  });
});

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_DOWNLOADS, claudePlatform, manifestEntry, planInstallClaude } from '../src/claude-install.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { fakeExec } from './helpers.js';

const BINARY = Buffer.from('pretend this is claude for linux-x64');
const SHA = createHash('sha256').update(BINARY).digest('hex');
const manifest = (checksum = SHA, size = BINARY.length) => JSON.stringify({ version: '9.9.9', platforms: { 'linux-x64': { binary: 'claude', checksum, size }, 'linux-arm64': { binary: 'claude', checksum: 'b'.repeat(64), size: 9 } } });

async function run(steps: ReturnType<typeof planInstallClaude>): Promise<JobView> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const view = jobs.start(steps, { runId: store.start('claude.install', {}), title: 'Install Claude Code' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    if (v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(answer: { latest?: string; manifest?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dmp-claude-'));
  const home = join(root, 'home');
  const tmpDir = join(root, 'tmp');
  const read: string[] = [];
  const fetchText = async (url: string) => {
    read.push(url);
    return url.endsWith('/latest') ? (answer.latest ?? '9.9.9') : (answer.manifest ?? manifest());
  };
  const downloads: Array<{ url: string; max?: number }> = [];
  const download = async (url: string, file: string, _p: (d: number, t: number) => void, max?: number) => {
    downloads.push({ url, ...(max !== undefined ? { max } : {}) });
    writeFileSync(file, BINARY);
  };
  const fake = fakeExec({ [join(home, '.local/bin/claude --version')]: { stdout: '9.9.9 (Claude Code)\n' } });
  const exec: typeof fake.exec = async (file, args, options) => (args[0] === 'install' ? (fake.calls.push({ file, args: [...args] }), { code: 0, stdout: 'Claude Code installed\n', stderr: '' }) : fake.exec(file, args, options));
  return { home, tmpDir, read, downloads, fake, ctx: { exec, home, tmpDir, fetchText, download } };
}

describe('installing Claude Code as its own installer does', () => {
  it('names the build for this machine as the manifest does', () => {
    expect(claudePlatform('x64', false)).toBe('linux-x64');
    expect(claudePlatform('arm64', true)).toBe('linux-arm64-musl');
    expect(claudePlatform('ia32', false)).toBeNull();
  });

  it("reads a platform's checksum and size from the manifest, nothing else", () => {
    expect(manifestEntry(manifest(), 'linux-x64')).toEqual({ checksum: SHA, size: BINARY.length });
    expect(manifestEntry(manifest('not-a-sum'), 'linux-x64')).toBeNull();
    expect(manifestEntry(manifest(), 'linux-x64-musl')).toBeNull();
    expect(manifestEntry('<html>', 'linux-x64')).toBeNull();
  });

  it('downloads the newest build, checks it against the manifest, runs its claude install and removes the download', async () => {
    const s = setup();
    const view = await run(planInstallClaude(s.ctx, 'linux-x64'));
    expect(view.status).toBe('done');
    expect(s.read).toEqual([`${CLAUDE_DOWNLOADS}/latest`, `${CLAUDE_DOWNLOADS}/9.9.9/manifest.json`]);
    // No more than the manifest says, give or take a megabyte.
    expect(s.downloads).toEqual([{ url: `${CLAUDE_DOWNLOADS}/9.9.9/linux-x64/claude`, max: BINARY.length + 1024 * 1024 }]);
    expect(s.fake.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([`${join(s.tmpDir, 'claude-9.9.9-linux-x64')} install`, `${join(s.home, '.local/bin/claude')} --version`]);
    expect(readdirSync(s.tmpDir)).toEqual([]);
  });

  it('runs nothing it could not check', async () => {
    const s = setup({ manifest: manifest('c'.repeat(64)) });
    const view = await run(planInstallClaude(s.ctx, 'linux-x64'));
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.output).toMatch(/checksum mismatch/);
    expect(s.fake.calls).toHaveLength(0);
    expect(existsSync(join(s.tmpDir, 'claude-9.9.9-linux-x64'))).toBe(false);
  });

  it('stops when downloads.claude.ai answers with no version', async () => {
    const s = setup({ latest: '<html>blocked</html>' });
    const view = await run(planInstallClaude(s.ctx, 'linux-x64'));
    expect(view.status).toBe('failed');
    expect(view.steps[0]?.output).toContain('did not answer with a version');
    expect(s.downloads).toEqual([]);
  });
});

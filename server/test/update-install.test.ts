import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_EXCLUDED_ACTIONS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { type ActionContext, runAction } from '../src/actions.js';
import { Jobs, type JobRuntime, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { type InstallContext, installStillNews, planInstallRelease, readInstallStatus, settleInstall, statusFile } from '../src/update-install.js';
import { installedReleases, type UpdateContext } from '../src/update.js';
import { type FakeCall, fakeExec, tempTree } from './helpers.js';

const PASSWORD = 'pa$$ word "x"';
const job: JobRuntime = { onUndo: () => undefined, progress: () => undefined };

/** install.sh's status file, as --from-panel writes it. */
function status(dataDir: string, fields: Record<string, unknown>) {
  writeFileSync(statusFile(dataDir), JSON.stringify({ release: 'v9.9.9', previous: 'v9.9.8', state: 'running', step: 'system', message: '', rolledBack: false, started: 's', finished: '', log: '/logs/install.log', ...fields }));
}

function setup(responses: Parameters<typeof fakeExec>[0] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dmp-install-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'dmp-runtime-'));
  const store = new RunStore(':memory:');
  const handed: Array<{ fifo: string; text: string }> = [];
  const fake = fakeExec({ mkfifo: {}, 'systemd-run': {}, 'systemctl --user is-active': {}, 'systemctl --user stop': {}, ...responses });
  const ctx: InstallContext = {
    exec: fake.exec, dataDir, store, runtimeDir,
    handOver: async (fifo, text) => void handed.push({ fifo, text }),
    poll: { delayMs: 1, maxMs: 2000 },
    now: () => new Date('2026-10-31T12:00:00Z'),
  };
  return { ...fake, ctx, dataDir, runtimeDir, store, handed };
}

const release = { name: 'v9.9.9', dir: '/data/releases/v9.9.9' };

describe('panel.installRelease', () => {
  it('starts install.sh --from-panel in a unit of its own, its stdin a FIFO the password goes into, never a command line', async () => {
    const s = setup();
    status(s.dataDir, { state: 'done' });
    const [start] = planInstallRelease(s.ctx, release, PASSWORD, 7);
    expect(await start?.run(job)).toMatchObject({ code: 0, stdout: 'install.sh --from-panel runs as devmagic-panel-install-20261031120000' });
    const run = s.calls.find((c) => c.file === 'systemd-run') as FakeCall;
    const fifo = s.handed[0]?.fifo as string;
    expect(run.args).toEqual([
      '--user', '--quiet', '--collect', '--unit=devmagic-panel-install-20261031120000',
      `--property=StandardInput=file:${fifo}`,
      '--property=StandardOutput=null', '--property=StandardError=null',
      '--', '/data/releases/v9.9.9/install.sh', '--from-panel',
    ]);
    expect(s.calls.find((c) => c.file === 'mkfifo')?.args).toEqual(['-m', '600', fifo]);
    expect(fifo.startsWith(s.runtimeDir)).toBe(true);
    expect(s.handed).toEqual([{ fifo, text: `${PASSWORD}\n` }]);
    // Nothing of the password anywhere else, and its FIFO gone.
    expect(JSON.stringify(s.calls)).not.toContain(PASSWORD);
    expect(existsSync(fifo)).toBe(false);
    // The last install's status goes, and the next panel learns which run and unit this is.
    expect(existsSync(statusFile(s.dataDir))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.dataDir, 'update-run.json'), 'utf8'))).toEqual({ runId: 7, unit: 'devmagic-panel-install-20261031120000', release: 'v9.9.9' });
    expect(readFileSync(join(s.dataDir, 'update-run.json'), 'utf8')).not.toContain(PASSWORD);
  });

  it('drops the password once handed over: a retry of the start asks for a new install instead', async () => {
    const s = setup();
    const [start] = planInstallRelease(s.ctx, release, PASSWORD, 7);
    await start?.run(job);
    expect(await start?.run(job)).toMatchObject({ code: 1, stderr: expect.stringContaining('the password was used once and is gone') });
    expect(s.handed).toHaveLength(1);
  });

  it('stops the unit when the installer never reads its password, and forgets the run', async () => {
    const s = setup();
    s.ctx.handOver = async () => {
      throw new Error('the installer did not start reading its input');
    };
    const [start] = planInstallRelease(s.ctx, release, PASSWORD, 7);
    expect(await start?.run(job)).toMatchObject({ code: 1, stderr: expect.stringContaining('could not give the installer your password') });
    expect(s.calls.at(-1)?.args).toEqual(['--user', 'stop', 'devmagic-panel-install-20261031120000']);
    expect(existsSync(join(s.dataDir, 'update-run.json'))).toBe(false);
  });

  it('follows the status file: a failure that was put back fails the job with what happened', async () => {
    const s = setup();
    const [start, install] = planInstallRelease(s.ctx, release, PASSWORD, 7);
    await start?.run(job);
    status(s.dataDir, { state: 'failed', step: 'system', message: 'the update stopped at system', rolledBack: true });
    const r = await install?.run(job);
    expect(r).toMatchObject({ code: 1, stderr: expect.stringContaining('the update stopped at system. Everything was put back: v9.9.8 runs as before. Log: /logs/install.log') });
    expect(existsSync(join(s.dataDir, 'update-run.json'))).toBe(false);
  });

  it('fails when the installer ends without saying it finished', async () => {
    const s = setup({ 'systemctl --user is-active': { code: 3 } });
    const [start, install] = planInstallRelease(s.ctx, release, PASSWORD, 7);
    await start?.run(job);
    status(s.dataDir, { state: 'running', step: 'scripts' });
    expect(await install?.run(job)).toMatchObject({ code: 1, stderr: expect.stringContaining('the installer stopped without finishing (at scripts)') });
  });

  it('is never offered to the assistant, and run history hides the password', async () => {
    expect(ASSISTANT_EXCLUDED_ACTIONS).toContain('panel.installRelease');
    const t = tempTree();
    const dataDir = mkdtempSync(join(tmpdir(), 'dmp-install-'));
    mkdirSync(join(dataDir, 'releases', 'v9.9.9'), { recursive: true });
    writeFileSync(join(dataDir, 'releases', 'v9.9.9', 'install.sh'), '#!/bin/sh\ncase "$1" in\n  --from-panel) ;;\nesac\n');
    // An older release, whose installer only runs in a terminal.
    mkdirSync(join(dataDir, 'releases', 'v0.24.0'), { recursive: true });
    writeFileSync(join(dataDir, 'releases', 'v0.24.0', 'install.sh'), '#!/bin/sh\n');
    writeFileSync(join(dataDir, 'releases', 'v0.24.0', 'release.json'), JSON.stringify({ name: 'v0.24.0', version: '0.24.0', commit: 'abc', installer: 'x', scripts: {} }));
    writeFileSync(join(dataDir, 'releases', 'v9.9.9', 'release.json'), JSON.stringify({ name: 'v9.9.9', version: '9.9.9', commit: 'abc', installer: 'x', scripts: {} }));
    const store = new RunStore(':memory:');
    const fake = fakeExec({ 'systemctl --user is-active': { code: 3 }, mkfifo: {}, 'systemd-run': { code: 1, stderr: 'Failed to start transient service unit' } });
    const update = { exec: fake.exec, appDir: '/app', dataDir, version: '9.9.8', logsDir: join(dataDir, 'logs'), dmpRoot: join(t.root, 'bin', 'dmp-root'), sources: [] } as UpdateContext;
    const jobs = new Jobs(store);
    const ctx = { config: t.config, exec: fake.exec, store, dmpRoot: '/x/dmp-root', wpcoreBin: '/x/wpcore', wpcoreConf: '/x/wpcore.conf', home: t.root, jobs, uploadsDir: join(dataDir, 'uploads'), secrets: null, update } as ActionContext;
    const result = await runAction(ctx, 'panel.installRelease', { release: 'v9.9.9', password: PASSWORD });
    const view = await settled(jobs, (result as { data?: { jobId?: string } }).data?.jobId as string);
    expect(view.status).toBe('failed');
    const recorded = JSON.stringify(store.page(1, 5));
    expect(recorded).toContain('(hidden)');
    expect(recorded).not.toContain(PASSWORD);
    expect(await runAction(ctx, 'panel.installRelease', { release: 'v1.2.3', password: PASSWORD })).toMatchObject({ ok: false, output: expect.stringContaining('v1.2.3 is not installed') });
    expect(await runAction(ctx, 'panel.installRelease', { release: 'v0.24.0', password: PASSWORD })).toMatchObject({ ok: false, output: expect.stringContaining("v0.24.0's install.sh cannot install from the panel (that came in v0.25.0)") });
    expect(installedReleases(update).map((r) => [r.name, r.fromPanel ?? false]).sort()).toEqual([['v0.24.0', false], ['v9.9.9', true]]);
  });
});

async function settled(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const view = jobs.get(id);
    if (view && !['running', 'queued'].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle');
}

describe('after the restart', () => {
  it('finishes the run of an install that ended while no job followed it', async () => {
    const s = setup({ 'systemctl --user is-active': { code: 3 } });
    const runId = s.store.start('panel.installRelease', { release: 'v9.9.9', password: '(hidden)' });
    writeFileSync(join(s.dataDir, 'update-run.json'), JSON.stringify({ runId, unit: 'devmagic-panel-install-1', release: 'v9.9.9' }));
    status(s.dataDir, { state: 'done', step: 'finish' });
    expect(await settleInstall(s.ctx)).toMatchObject({ state: 'done', release: 'v9.9.9' });
    expect(JSON.stringify(s.store.page(1, 5))).toContain('v9.9.9 installed, replacing v9.9.8');
    expect(existsSync(join(s.dataDir, 'update-run.json'))).toBe(false);
  });

  it('says an install whose unit is gone while its status says running was interrupted, and finishes its run as failed', async () => {
    const s = setup({ 'systemctl --user is-active': { code: 3 } });
    const runId = s.store.start('panel.installRelease', {});
    writeFileSync(join(s.dataDir, 'update-run.json'), JSON.stringify({ runId, unit: 'devmagic-panel-install-1', release: 'v9.9.9' }));
    status(s.dataDir, { state: 'running', step: 'system' });
    expect(await settleInstall(s.ctx)).toMatchObject({ state: 'running', interrupted: true });
    expect(JSON.stringify(s.store.page(1, 5))).toContain('was interrupted at system; run it again');
  });

  it('leaves an install alone while its unit still runs, or while a job of this panel follows it', async () => {
    const s = setup();
    const runId = s.store.start('panel.installRelease', {});
    writeFileSync(join(s.dataDir, 'update-run.json'), JSON.stringify({ runId, unit: 'devmagic-panel-install-1', release: 'v9.9.9' }));
    status(s.dataDir, { state: 'running', step: 'restart' });
    expect(await settleInstall(s.ctx)).toMatchObject({ state: 'running' });
    expect((await settleInstall(s.ctx))?.interrupted).toBeUndefined();
    status(s.dataDir, { state: 'done' });
    await settleInstall(s.ctx, () => true);
    expect(existsSync(join(s.dataDir, 'update-run.json'))).toBe(true);
  });

  it('reads no status from a file that is not one', () => {
    const s = setup();
    writeFileSync(statusFile(s.dataDir), '{"state":"weird"}');
    expect(readInstallStatus(s.dataDir)).toBeUndefined();
  });
});

describe('the last install on the Updates page', () => {
  const release = (name: string, installedAt: string, current = false) => ({ name, installedAt, current });
  const done = { release: 'v1.2.0', state: 'done' as const, finished: '2026-11-06T10:00:30Z' };

  it('shows while the release it put in runs, the folder written a moment before it ended', () => {
    expect(installStillNews(done, [release('v1.2.0', '2026-11-06T10:00:10Z', true), release('v1.1.0', '2026-11-01T09:00:00Z')])).toBe(done);
  });

  it('goes once an update from the panel put in a newer release, or a switch moved off it', () => {
    expect(installStillNews(done, [release('v1.3.0', '2026-11-06T10:12:00Z', true), release('v1.2.0', '2026-11-06T10:00:10Z')])).toBeUndefined();
    expect(installStillNews(done, [release('v1.2.0', '2026-11-06T10:00:10Z'), release('v1.1.0', '2026-11-01T09:00:00Z', true)])).toBeUndefined();
  });

  it('keeps a failure while the release before runs, until a later install', () => {
    const failed = { release: 'v1.2.0', state: 'failed' as const, finished: '2026-11-06T10:00:30Z' };
    expect(installStillNews(failed, [release('v1.1.0', '2026-11-01T09:00:00Z', true)])).toBe(failed);
    expect(installStillNews(failed, [release('v1.3.0', '2026-11-06T11:00:00Z', true), release('v1.1.0', '2026-11-01T09:00:00Z')])).toBeUndefined();
  });

  it('always shows an install under way, and anything when no release is known', () => {
    const running = { release: 'v1.3.0', state: 'running' as const, finished: '' };
    expect(installStillNews(running, [release('v1.2.0', '2026-11-06T10:00:10Z', true)])).toBe(running);
    expect(installStillNews(done, [])).toBe(done);
    expect(installStillNews(undefined, [])).toBeUndefined();
  });
});

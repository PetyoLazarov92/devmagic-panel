import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Chores } from '../src/chores.js';
import { panelStorage, pruneAutoSnapshots } from '../src/panel-storage.js';
import { FINISHED_KEPT, inJob, inTask, notableLine, programName, RunningPrograms } from '../src/running.js';
import type { FinishedProgram } from '@devmagic-panel/shared';
import { hashPassword, readSecrets, writeSecrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, healthyResponses, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';

describe('the programs the panel has running', () => {
  it('names a program by its file, and dmp-root by its command, never by its arguments', () => {
    expect(programName('/usr/bin/ssh', ['-o', 'BatchMode=yes', '--', 'alex@www.spellbook.example', 'true'])).toBe('ssh');
    expect(programName('sudo', ['-n', DMP, 'vhost-write', 'local.spellbook.example'])).toBe('dmp-root vhost-write');
    expect(programName('sudo', ['-n', '-S', '-v'])).toBe('sudo');
  });

  it('lists a program while it runs, with the job it runs for, and drops it when it ends, failed or not', async () => {
    const programs = new RunningPrograms();
    let finish: () => void = () => undefined;
    const exec = programs.track(() => new Promise((resolve) => (finish = () => resolve({ code: 1, stdout: '', stderr: 'no' }))));
    const running = inJob({ id: 'job-1', title: 'Create site' }, () => exec('wp', ['--path=/var/www/local.spellbook.example', 'db', 'export']));
    expect(programs.list()).toEqual([{ program: 'wp', startedAt: expect.any(String), job: { id: 'job-1', title: 'Create site' } }]);
    finish();
    await running;
    expect(programs.list()).toEqual([]);
    expect(JSON.stringify(programs.list())).not.toContain('spellbook');
  });
});

describe('the programs that ended lately', () => {
  it('keeps the last 50 worth a look with how long each took and how it ended, counts the page reads that went well, and never keeps arguments', async () => {
    let clock = 1_000_000;
    const programs = new RunningPrograms(() => undefined, () => clock);
    const exec = programs.track(async (file, args) => {
      if (!args.includes('quick')) clock += 1500;
      if (args.includes('fail')) return { code: 2, stdout: '', stderr: 'no' };
      if (args.includes('slow')) return { code: 1, stdout: '', stderr: 'stopped: it took longer than 30 s' };
      return { code: 0, stdout: 'secret-output', stderr: '' };
    });
    await exec('/usr/bin/wp', ['--path=/var/www/local.spellbook.example', 'option', 'get', 'home']);
    await inJob({ id: 'j1', title: 'Create site' }, () => exec('wp', ['core', 'install']));
    await exec('ssh', ['spellbook-prod', 'fail']);
    await exec('mysql', ['slow']);
    // A page's read that went well is counted, not listed; a job's is listed, and so is a read that failed or ran out of time.
    expect(programs.finished()).toEqual([
      { program: 'mysql', startedAt: expect.any(String), durationMs: 1500, ended: 'timeout' },
      { program: 'ssh', startedAt: expect.any(String), durationMs: 1500, ended: 'failed', code: 2 },
      { program: 'wp', startedAt: expect.any(String), durationMs: 1500, ended: 'ok', job: { id: 'j1', title: 'Create site' } },
    ]);
    expect(programs.pageReads()).toEqual([{ program: 'wp', count: 1, totalMs: 1500 }]);
    expect(JSON.stringify(programs.finished())).not.toMatch(/spellbook|secret-output|home/);
    // A page that starts seven reads at once adds seven to the count and nothing to the list.
    await Promise.all(Array.from({ length: 7 }, () => exec('wp', ['plugin', 'list', 'quick'])));
    expect(programs.pageReads()[0]).toEqual({ program: 'wp', count: 8, totalMs: 1500 });
    expect(programs.finished()).toHaveLength(3);
    for (let i = 0; i < FINISHED_KEPT + 10; i += 1) await inTask({ id: 't', title: 'Trim Run history' }, () => exec('true', []));
    expect(programs.finished()).toHaveLength(FINISHED_KEPT);
  });

  it('logs a slow program and a failed one a job or task ran, by name only; a failed page read is not logged', async () => {
    let clock = 0;
    const logged: FinishedProgram[] = [];
    const programs = new RunningPrograms((p) => logged.push(p), () => clock);
    const exec = programs.track(async (_file, args) => {
      clock += args.includes('slow') ? 42_000 : 100;
      return { code: args.includes('fail') ? 1 : 0, stdout: '', stderr: '' };
    });
    await exec('ssh', ['spellbook-prod', 'true', 'fail']);
    await inJob({ id: 'j1', title: 'Refresh the database from production' }, () => exec('wp', ['db', 'export', 'fail']));
    await inTask({ id: 'kept', title: 'Drop expired kept databases' }, () => exec('mysql', ['fail']));
    await exec('gzip', ['slow']);
    expect(logged.map(notableLine)).toEqual([
      'wp ran 0 s for "Refresh the database from production" and ended with exit 1',
      'mysql ran 0 s for the background task "Drop expired kept databases" and ended with exit 1',
      'gzip ran 42 s and ended well',
    ]);
  });
});

describe('the work the panel does on its own', () => {
  afterEach(() => vi.useRealTimers());

  it('runs each chore on its timer and keeps what its last run did, or why it failed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T08:00:00Z') });
    const errors: string[] = [];
    const chores = new Chores((id, message) => errors.push(`${id}: ${message}`));
    let n = 0;
    chores.every('tidy', 'Downloads', 'Removes old dumps.', 60_000, () => `removed ${++n} dumps`);
    chores.every('check', 'Update check', 'Looks for a release.', 60_000, () => {
      throw new Error('offline');
    }, 30_000);
    expect(chores.list().find((t) => t.id === 'check')).toMatchObject({ running: false, nextRunAt: '2026-11-13T08:00:30.000Z' });
    await vi.advanceTimersByTimeAsync(1);
    expect(chores.list().find((t) => t.id === 'tidy')).toMatchObject({ lastOk: true, lastNote: 'removed 1 dumps', nextRunAt: '2026-11-13T08:01:00.000Z' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chores.list().find((t) => t.id === 'tidy')?.lastNote).toBe('removed 2 dumps');
    expect(chores.list().find((t) => t.id === 'check')).toMatchObject({ lastOk: false, lastNote: 'offline' });
    expect(errors).toContain('check: offline');
    chores.stop();
  });

  it('keeps the newest 20 runs of each task in the panel database, newest first', async () => {
    const store = new RunStore(':memory:');
    const chores = new Chores(() => undefined, Date.now, store);
    let n = 0;
    chores.every('tidy', 'Downloads', 'Removes old dumps.', 3_600_000, () => (++n === 3 ? Promise.reject(new Error('disk full')) : `removed ${n} dumps`), 3_600_000);
    for (let i = 0; i < 25; i += 1) await chores.run('tidy');
    const runs = store.choreRuns('tidy');
    expect(runs).toHaveLength(20);
    expect(runs[0]).toMatchObject({ ok: true, note: 'removed 25 dumps', durationMs: expect.any(Number) });
    expect(runs.at(-1)?.note).toBe('removed 6 dumps');
    chores.stop();
    const failed = new RunStore(':memory:');
    const once = new Chores(() => undefined, Date.now, failed);
    once.every('check', 'Update check', 'Looks for a release.', 3_600_000, () => Promise.reject(new Error('offline')), 3_600_000);
    await once.run('check');
    expect(failed.choreRuns('check')).toEqual([{ startedAt: expect.any(String), durationMs: expect.any(Number), ok: false, note: 'offline' }]);
    once.stop();
  });
});

describe('the panel status route', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('says since when the panel runs, how the last run ended, its programs and its timed work', async () => {
    const t = tempTree();
    const file = join(t.root, 'config', 'secrets.json');
    writeSecrets(file, { panelPasswordHash: await hashPassword('correct horse') });
    const store = new RunStore(':memory:');
    // The run before started and never wrote its stop.
    store.setMeta('panel-started-at', '2026-11-12T20:00:00.000Z');
    const programs = new RunningPrograms();
    const fake = fakeExec({ ...healthyResponses(), sudo: { stdout: '' } });
    app = await buildApp({ config: t.config, exec: programs.track(fake.exec), programs, store, secrets: () => readSecrets(file), secretsFile: file, hostPaths: t.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(t.root, 'uploads'), production: true, housekeeping: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    const cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
    const status = (await app.inject({ method: 'GET', url: '/api/panel/status', headers: { host: HOST, cookie } })).json();
    expect(status).toMatchObject({ version: '9.9.9', before: { startedAt: '2026-11-12T20:00:00.000Z', ended: 'unexpectedly' }, programs: [], finished: expect.any(Array), jobs: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/panel/tasks/runs/runs', headers: { host: HOST, cookie } })).json()).toEqual(expect.any(Array));
    expect(status.tasks.map((t: { id: string }) => t.id)).toEqual(['drafts', 'runs', 'downloads', 'file-trash', 'mysql-backups', 'snapshots', 'kept', 'trash']);
    const ran = await app.inject({ method: 'POST', url: '/api/panel/tasks/runs/run', headers: { host: HOST, origin: ORIGIN, cookie } });
    expect(ran.json()).toMatchObject({ id: 'runs', lastOk: true });
    expect((await app.inject({ method: 'POST', url: '/api/panel/tasks/nope/run', headers: { host: HOST, origin: ORIGIN, cookie } })).statusCode).toBe(404);
    await app.close();
    expect(store.getMeta('panel-stopped-at')).toBeDefined();
  });
});

describe('what the panel keeps on disk', () => {
  it('measures each kind with one du over its own folders, the deleted sites from their archives, and the rest of the backups as Undo', async () => {
    const t = tempTree();
    const dataDir = join(t.root, 'data');
    const backup = t.config.BACKUP_DIR;
    for (const dir of [join(backup, 'snapshots'), join(backup, 'clean'), join(dataDir, 'uploads'), join(dataDir, 'releases')]) mkdirSync(dir, { recursive: true });
    const fake = fakeExec({
      du: (call) => ({
        code: 1,
        stdout: call.args.filter((a) => a.startsWith('/')).map((p) => `${p === backup ? 5000 : p.endsWith('snapshots') ? 3000 : p.endsWith('clean') ? 500 : p.endsWith('releases') ? 9000 : 0}\t${p}`).join('\n'),
      }),
    });
    const storage = await panelStorage({ config: t.config, exec: fake.exec, dataDir, uploadsDir: join(dataDir, 'uploads'), logsDir: join(t.root, 'logs'), trashBytes: async () => 7000, keptDatabases: () => ({ count: 2, note: '2 kept, the oldest goes on 16 Nov', items: [] }) });
    const row = (id: string) => storage.rows.find((r) => r.id === id);
    expect(row('snapshots')?.bytes).toBe(3000);
    expect(row('clean')?.bytes).toBe(500);
    expect(row('undo')?.bytes).toBe(1500);
    expect(row('releases')?.bytes).toBe(9000);
    expect(row('trash')).toMatchObject({ bytes: 7000, manage: { href: '/sites?show=removed' } });
    expect(row('kept')?.clean?.kind).toBe('kept');
    expect(row('kept')).toMatchObject({ bytes: null, count: 2, kept: '7 days (the oldest goes on 16 Nov)' });
    expect(storage.totalBytes).toBe(3000 + 500 + 1500 + 9000 + 7000);
    // One du, only over folders that are there, counting a folder inside another in full.
    const du = fake.calls.filter((c) => c.file === 'du');
    expect(du).toHaveLength(1);
    expect(du[0]?.args.slice(0, 4)).toEqual(['-s', '-l', '-B1', '--']);
    expect(du[0]?.args.every((a) => a.startsWith('-') || existsSync(a))).toBe(true);
  });

  it('removes only the snapshots the panel took before a change, keeping the newest three per site and the last 30 days', () => {
    const t = tempTree();
    const dir = join(t.config.BACKUP_DIR, 'snapshots', 'local.spellbook.example');
    mkdirSync(dir, { recursive: true });
    const now = new Date('2026-11-13T08:00:00Z').getTime();
    const day = 86_400_000;
    const make = (name: string, daysOld: number) => {
      writeFileSync(join(dir, name), 'x');
      const at = new Date(now - daysOld * day);
      utimesSync(join(dir, name), at, at);
    };
    make('20260101-100000-before-import.sql.gz', 300);
    make('20260201-100000-before-import.sql.gz', 280);
    make('20260301-100000-before-updates.sql.gz', 250);
    make('20260401-100000-before-replace.sql.gz', 220);
    make('20261101-100000-before-import.sql.gz', 12);
    make('20260101-090000.sql.gz', 300);
    make('20260101-080000-launch.sql.gz', 300);
    const removed = pruneAutoSnapshots(t.config.BACKUP_DIR, now).map((p) => p.split('/').at(-1));
    // The newest three automatic ones stay (one of them is recent), the two older go; yours stay whatever their age.
    expect(removed.sort()).toEqual(['20260101-100000-before-import.sql.gz', '20260201-100000-before-import.sql.gz']);
    for (const kept of ['20260301-100000-before-updates.sql.gz', '20260401-100000-before-replace.sql.gz', '20261101-100000-before-import.sql.gz', '20260101-090000.sql.gz', '20260101-080000-launch.sql.gz']) expect(existsSync(join(dir, kept))).toBe(true);
  });
});

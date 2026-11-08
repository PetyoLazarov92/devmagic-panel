import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRON_OUTPUT_KEPT, runCronTask, runnerPath } from '../src/cron-run.js';
import { taskArgs } from '../src/cron.js';
import { RunStore } from '../src/store.js';
import { fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

function setup(responses: Record<string, FakeResponse> = {}, options: Parameters<typeof wpSiteTree>[0] = {}) {
  const t = wpSiteTree(options);
  const fake = fakeExec(responses);
  const store = new RunStore(':memory:');
  let clock = 1_790_000_000_000;
  const deps = { config: t.config, exec: fake.exec, store, lockDir: join(t.root, 'data', 'cron'), home: t.hostPaths.home, now: () => (clock += 1500) };
  return { ...t, deps, store, calls: fake.calls };
}

const args = (task: Parameters<typeof taskArgs>[0]['task'], timeoutMinutes = 10) => taskArgs({ id: 'k3f9q2', timeoutMinutes, task });
const lines = (calls: ReturnType<typeof setup>['calls']) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('cron-run', () => {
  it("runs a site's due WP-Cron events and records the run", async () => {
    const s = setup({ wp: { stdout: "Executed the cron event 'wp_version_check' in 0.4s.\nSuccess: Executed a total of 1 cron event.\n" } });
    const run = await runCronTask(s.deps, args({ kind: 'wp-cron', domain: 'local.shop.com' }), 'cron');
    expect(run.status).toBe('ok');
    expect(lines(s.calls)).toEqual([`wp --path=${s.docroot} --url=https://local.shop.com/ cron event run --due-now`]);
    expect(s.store.cronRuns('k3f9q2')).toMatchObject([{ trigger: 'cron', status: 'ok', exitCode: 0, durationMs: 1500 }]);
    expect(s.store.cronRun(run.runId)?.output).toContain('Executed a total of 1 cron event');
    // The lock goes once the run ends.
    expect(existsSync(join(s.deps.lockDir, 'k3f9q2.lock'))).toBe(false);
  });

  it('runs WP-Cron for each site of a network', async () => {
    const s = setup(
      {
        wp: (call) => (call.args.includes('site') ? { stdout: 'https://local.shop.com/\nhttps://local.shop.com/de/\n' } : { stdout: 'Success: Executed a total of 0 cron events.\n' }),
      },
      { multisite: true },
    );
    await runCronTask(s.deps, args({ kind: 'wp-cron', domain: 'local.shop.com' }), 'cron');
    expect(lines(s.calls).slice(1)).toEqual([
      `wp --path=${s.docroot} --url=https://local.shop.com/ cron event run --due-now`,
      `wp --path=${s.docroot} --url=https://local.shop.com/de/ cron event run --due-now`,
    ]);
  });

  it("checks a site's own WP-CLI command each time, then runs it as words", async () => {
    let has = true;
    const s = setup({ wp: (call) => (call.args.includes('has-command') ? { code: has ? 0 : 1 } : { stdout: 'synced\n' }) });
    await runCronTask(s.deps, args({ kind: 'wp-cli', domain: 'local.shop.com', command: ['wandworks', 'sync', '--limit=50'] }), 'cron');
    expect(lines(s.calls)).toEqual([
      `wp --path=${s.docroot} --url=https://local.shop.com/ cli has-command wandworks`,
      `wp --path=${s.docroot} --url=https://local.shop.com/ wandworks sync --limit=50`,
    ]);
    has = false;
    const run = await runCronTask(s.deps, args({ kind: 'wp-cli', domain: 'local.shop.com', command: ['wandworks', 'sync'] }), 'cron');
    expect(run).toMatchObject({ status: 'failed', output: 'local.shop.com has no WP-CLI command wandworks: is its plugin active?' });
  });

  it('runs a PHP file of the site with the CLI, and never one a link takes outside it', async () => {
    const s = setup({ php: { stdout: 'done\n' } });
    mkdirSync(join(s.docroot, 'wp-content', 'cron'), { recursive: true });
    writeFileSync(join(s.docroot, 'wp-content', 'cron', 'sync.php'), '<?php echo "done";');
    expect((await runCronTask(s.deps, args({ kind: 'php-script', domain: 'local.shop.com', file: 'wp-content/cron/sync.php' }), 'cron')).status).toBe('ok');
    expect(s.calls[0]).toMatchObject({ file: 'php', args: [join(s.docroot, 'wp-content', 'cron', 'sync.php')] });

    writeFileSync(join(s.root, 'outside.php'), '<?php');
    symlinkSync(join(s.root, 'outside.php'), join(s.docroot, 'wp-content', 'cron', 'away.php'));
    const away = await runCronTask(s.deps, args({ kind: 'php-script', domain: 'local.shop.com', file: 'wp-content/cron/away.php' }), 'cron');
    expect(away).toMatchObject({ status: 'failed', output: 'wp-content/cron/away.php is not a file inside local.shop.com' });
    expect(s.calls).toHaveLength(1);
  });

  it('fetches a local URL with curl, and runs a program with its arguments as they are', async () => {
    const s = setup({ curl: { stdout: 'ok' } });
    const program = join(s.root, 'sync.sh');
    writeFileSync(program, '#!/bin/sh\n');
    chmodSync(program, 0o755);
    await runCronTask(s.deps, args({ kind: 'url', url: 'https://local.shop.com/wp-cron.php?doing_wp_cron=1&x=y' }, 2), 'cron');
    expect(s.calls[0]?.args).toEqual(['--silent', '--show-error', '--fail', '--location', '--max-time', '120', 'https://local.shop.com/wp-cron.php?doing_wp_cron=1&x=y']);
    const r = await runCronTask(s.deps, args({ kind: 'program', program, args: ["it's $HOME; rm -rf /", 'two words'] }), 'manual');
    expect(r.status).toBe('failed');
    expect(s.calls[1]).toMatchObject({ file: program, args: ["it's $HOME; rm -rf /", 'two words'] });
    expect(s.store.cronRuns('k3f9q2')[0]?.trigger).toBe('manual');
  });

  it('skips a run while the last one of the task is still alive, and takes over a lock left by a dead one', async () => {
    const s = setup({ wp: {} });
    mkdirSync(s.deps.lockDir, { recursive: true });
    writeFileSync(join(s.deps.lockDir, 'k3f9q2.lock'), '424242');
    const busy = await runCronTask({ ...s.deps, alive: () => true }, args({ kind: 'wp-cron', domain: 'local.shop.com' }), 'cron');
    expect(busy.status).toBe('skipped');
    expect(s.calls).toEqual([]);
    const after = await runCronTask({ ...s.deps, alive: () => false }, args({ kind: 'wp-cron', domain: 'local.shop.com' }), 'cron');
    expect(after.status).toBe('ok');
  });

  it('records a line it cannot read, or a site that is gone, as a failed run', async () => {
    const s = setup();
    const bad = await runCronTask(s.deps, ['--id=k3f9q2', 'wp-cli', '--site=local.shop.com', '--', 'eval', 'x'], 'cron');
    expect(bad).toMatchObject({ status: 'failed' });
    expect(bad.output).toContain("The task's line cannot run");
    const gone = await runCronTask(s.deps, args({ kind: 'wp-cron', domain: 'local.gone.com' }), 'cron');
    expect(gone).toMatchObject({ status: 'failed', output: 'no site called local.gone.com' });
    expect(s.calls).toEqual([]);
  });

  it('keeps only the end of a long output', async () => {
    const s = setup({ wp: (call) => ({ stdout: `${'x'.repeat(CRON_OUTPUT_KEPT)}\nthe end`, code: call.args.includes('--due-now') ? 0 : 1 }) });
    const run = await runCronTask(s.deps, args({ kind: 'wp-cron', domain: 'local.shop.com' }, 3), 'cron');
    expect(run.output.startsWith('(only the last 64 KB are kept)')).toBe(true);
    expect(run.output.endsWith('the end')).toBe(true);
  });

  it("gives cron's short PATH the folders WP-CLI and Composer live in", () => {
    const path = runnerPath('/home/alex', '/usr/bin:/bin').split(':');
    expect(path.slice(0, 4)).toEqual(['/home/alex/.local/bin', '/home/alex/.config/composer/vendor/bin', '/usr/local/sbin', '/usr/local/bin']);
    expect(new Set(path).size).toBe(path.length);
  });
});

describe('run history', () => {
  it('keeps 100 runs per task and failed ones for 14 days, and runs of removed tasks for 14 days', () => {
    const store = new RunStore(':memory:');
    const day = 24 * 3600 * 1000;
    const now = Date.UTC(2026, 10, 6);
    const old = new Date(now - 20 * day).toISOString();
    const recent = new Date(now - 2 * day).toISOString();
    store.addCronRun('aaaaaa', 'cron', 'failed', 'old failure', old);
    store.addCronRun('aaaaaa', 'cron', 'failed', 'recent failure', recent);
    for (let i = 0; i < 100; i++) store.addCronRun('aaaaaa', 'cron', 'ok', '', recent);
    store.addCronRun('gone00', 'cron', 'ok', '', old);
    store.pruneCronRuns(now, ['aaaaaa']);
    const runs = store.cronRuns('aaaaaa', 500);
    expect(runs).toHaveLength(101);
    expect(runs.at(-1)?.status).toBe('failed');
    expect(store.cronRuns('gone00')).toEqual([]);
    expect(store.lastCronRuns().get('aaaaaa')?.status).toBe('ok');
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { readAura } from '../src/aura.js';
import { CRON_BEGIN, CRON_END, parseCrontab, tasksOf } from '../src/cron.js';
import { Jobs } from '../src/jobs.js';
import { parseEvents, readWpCron } from '../src/sites/wp-cron.js';
import { siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

const COMMAND = { node: '/usr/bin/node', cli: '/opt/devmagic-panel/cli.js' };
const NOW = 1_790_000_000;
const SIG = '40cd750bba9870f18aada2478b24840a';
const EVENTS = [
  { hook: 'wandworks_sync_orders', time: NOW - 3600, schedule: 'hourly', interval: 3600, args: [], sig: SIG },
  { hook: 'wp_version_check', time: NOW + 600, schedule: 'twicedaily', interval: 43200, args: [], sig: 'b'.repeat(32) },
  { hook: 'wandworks_send_receipt', time: NOW + 60, schedule: false, interval: '', args: [42, 'alex@example.com'], sig: 'c'.repeat(32) },
];

function setup(responses: Record<string, FakeResponse> = {}, crontab = '') {
  const t = wpSiteTree();
  let tab = crontab;
  const fake = fakeExec({
    'crontab -l': () => ({ stdout: tab }),
    'crontab -': (call) => {
      tab = call.input ?? '';
      return {};
    },
    wp: (call) => {
      if (call.args.includes('event') && call.args.includes('list')) return { stdout: `PHP Notice: a plugin said something\n${JSON.stringify(EVENTS)}\n` };
      if (call.args.includes('schedule')) return { stdout: JSON.stringify([{ name: 'hourly', display: 'Once Hourly', interval: 3600 }, { name: 'wandworks_5min', display: 'Every 5 minutes', interval: 300 }]) };
      return { code: 1, stderr: 'not faked' };
    },
    git: { code: 1 },
    ...responses,
  });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/usr/local/lib/devmagic-panel/bin/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'data', 'uploads'), secrets: null, cron: { command: COMMAND },
  };
  const cron = { config: t.config, exec: fake.exec, store, command: COMMAND, now: () => new Date(NOW * 1000) };
  return { ...t, ctx, cron, store, calls: fake.calls, crontab: () => tab };
}

describe("a site's WP-Cron", () => {
  it('lists events in time order with the overdue ones counted, and the intervals', async () => {
    const s = setup();
    const report = await readWpCron(s.cron, siteFor(s.config, 'local.shop.com'));
    expect(report.events.map((e) => [e.hook, e.overdue, e.core])).toEqual([
      ['wandworks_sync_orders', true, false],
      ['wandworks_send_receipt', false, false],
      ['wp_version_check', false, true],
    ]);
    expect(report.events[1]).toMatchObject({ recurrence: '', interval: null, args: [42, 'alex@example.com'] });
    expect(report.overdue).toBe(1);
    expect(report.schedules.map((x) => x.name)).toEqual(['wandworks_5min', 'hourly']);
    expect(report).toMatchObject({ disabled: false, alternate: false, configTracked: false, tasks: [] });
    // The events are read with plugins and themes off.
    expect(s.calls.find((c) => c.args.includes('list') && c.args.includes('event'))?.args).toContain('--skip-plugins');
  });

  it('reads events a plugin keyed by name as a list', () => {
    expect(parseEvents([{ hook: 'x', time: 1, sig: SIG, args: { id: 7 } }], 0)[0]?.args).toEqual([7]);
  });

  it('runs one hook now, for a network site when asked', async () => {
    const runs: string[] = [];
    const s2 = setup({ wp: (call) => (runs.push(call.args.join(' ')), { stdout: 'Success\n' }) });
    expect((await runAction(s2.ctx, 'wpcron.run', { domain: 'local.shop.com', hook: 'wandworks_sync_orders', url: 'https://local.shop.com/de/' })).ok).toBe(true);
    expect(runs).toEqual([`--path=${s2.docroot} --url=https://local.shop.com/de/ cron event run wandworks_sync_orders`]);
    await expect(runAction(s2.ctx, 'wpcron.run', { domain: 'local.shop.com', hook: '--due-now' })).rejects.toThrow(ActionInputError);
  });

  it('deletes exactly one event with fixed PHP, saves it, and Undo puts it back', async () => {
    const saved = Buffer.from('a:2:{s:8:"schedule";s:6:"hourly";s:4:"args";a:0:{}}').toString('base64');
    const s = setup({
      wp: (call) => (call.input?.includes('unset( $dmp_cron') ? { stdout: `${saved}\n` } : call.input?.includes('DMP_WPCRON_EVENT') ? { stdout: 'put back\n' } : { code: 1 }),
    });
    const del = await runAction(s.ctx, 'wpcron.delete', { domain: 'local.shop.com', hook: 'wandworks_sync_orders', time: NOW - 3600, sig: SIG });
    expect(del.ok).toBe(true);
    const call = s.calls[0];
    // The event's time, hook and sig only ever arrive in $args; the PHP is the panel's own.
    expect(call?.args.slice(2)).toEqual(['eval-file', '-', String(NOW - 3600), 'wandworks_sync_orders', SIG, '--skip-plugins', '--skip-themes']);
    expect(del.data?.backup).toMatch(/^wp-cron-local\.shop\.com-\d{8}-\d{6}-\d{3}\.json$/);
    const file = JSON.parse(readFileSync(join(s.config.BACKUP_DIR, del.data?.backup as string), 'utf8'));
    expect(file).toMatchObject({ domain: 'local.shop.com', hook: 'wandworks_sync_orders', sig: SIG, event: saved });

    const undo = await runAction(s.ctx, 'wpcron.undo', { domain: 'local.shop.com', backup: del.data?.backup as string });
    expect(undo).toMatchObject({ ok: true, output: 'wandworks_sync_orders: put back' });
    // The saved event goes in the environment, not on the command line.
    expect(s.calls[1]?.env?.DMP_WPCRON_EVENT).toBe(saved);
    expect(s.calls[1]?.args.join(' ')).not.toContain(saved);
    await expect(runAction(s.ctx, 'wpcron.undo', { domain: 'local.other.test', backup: del.data?.backup as string })).rejects.toThrow();
  });

  it('says so when the event is gone already', async () => {
    const s = setup({ wp: { code: 1, stderr: 'Error: this event is not scheduled any more: it may have run or been changed\n' } });
    const r = await runAction(s.ctx, 'wpcron.delete', { domain: 'local.shop.com', hook: 'wandworks_sync_orders', time: NOW, sig: SIG });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('not scheduled any more');
  });
});

describe('Run WP-Cron from cron', () => {
  it('adds the task and sets DISABLE_WP_CRON, and off takes both away', async () => {
    const set: string[] = [];
    const s = setup({ wp: (call) => (set.push(call.args.slice(2).join(' ')), { stdout: 'Success\n' }) });
    const on = await runAction(s.ctx, 'cron.setSiteWpCron', { domain: 'local.shop.com', fromCron: true });
    expect(on.ok).toBe(true);
    expect(tasksOf(parseCrontab(s.crontab()))).toMatchObject([{ title: 'WP-Cron for local.shop.com', schedule: '*/5 * * * *', task: { kind: 'wp-cron', domain: 'local.shop.com' } }]);
    expect(set).toEqual(['config set DISABLE_WP_CRON true --raw --type=constant']);
    expect(on.data?.backup).toMatch(/^crontab-/);

    writeFileSync(join(s.docroot, 'wp-config.php'), `${readFileSync(join(s.docroot, 'wp-config.php'), 'utf8')}define('DISABLE_WP_CRON', true);\n`);
    const again = await runAction(s.ctx, 'cron.setSiteWpCron', { domain: 'local.shop.com', fromCron: true, schedule: '*/10 * * * *' });
    expect(again.output).toContain('has DISABLE_WP_CRON true already');
    expect(tasksOf(parseCrontab(s.crontab()))).toHaveLength(1);
    expect(tasksOf(parseCrontab(s.crontab()))[0]?.schedule).toBe('*/10 * * * *');

    await runAction(s.ctx, 'cron.setSiteWpCron', { domain: 'local.shop.com', fromCron: false });
    expect(tasksOf(parseCrontab(s.crontab()))).toEqual([]);
    expect(set.at(-1)).toBe('config delete DISABLE_WP_CRON --type=constant');
  });

  it('shows the task on the site, and Aura flags DISABLE_WP_CRON without one', async () => {
    const line = `*/5 * * * * /usr/bin/node --disable-warning=ExperimentalWarning /opt/devmagic-panel/cli.js cron-run --id=k3f9q2 --timeout=10 wp-cron --site=local.shop.com`;
    const s = setup({}, `${CRON_BEGIN}\n# task k3f9q2: WP-Cron\n${line}\n${CRON_END}\n`);
    const report = await readWpCron(s.cron, siteFor(s.config, 'local.shop.com'));
    expect(report.task).toMatchObject({ id: 'k3f9q2', describe: 'Every 5 minutes' });

    const site = { domain: 'local.shop.com', constants: [{ name: 'DISABLE_WP_CRON', value: true }], issues: [] };
    const other = { domain: 'local.other.test', constants: [{ name: 'DISABLE_WP_CRON', value: true }], issues: [] };
    const aura = await readAura({ config: s.config, exec: s.ctx.exec, wpCronTasks: async () => new Set(['local.shop.com']) }, [site, other] as never);
    expect(aura.items.filter((i) => i.id === 'wpcron.notRunning').map((i) => [i.domain, i.fix?.action])).toEqual([['local.other.test', 'cron.setSiteWpCron']]);
  });
});

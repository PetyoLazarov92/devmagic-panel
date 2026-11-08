import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { CRON_BEGIN, CRON_END, cronCommand, cronReport, decodeTaskArgs, parseCrontab, renderCrontab, taskArgs, tasksOf } from '../src/cron.js';
import { Jobs } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

const COMMAND = { node: '/usr/bin/node', cli: '/home/alex/.local/share/devmagic-panel/current/server/dist/cli.js' };
const RUN = `${COMMAND.node} --disable-warning=ExperimentalWarning ${COMMAND.cli} cron-run`;
const HAND = 'MAILTO=alex@example.com\n# my backups\n0 4 * * * /home/alex/bin/backup.sh > /tmp/backup.log 2>&1\n';

/** A crontab the fake crontab command keeps, as the real one does. */
function setup(start: string | null = HAND, more: Record<string, FakeResponse> = {}) {
  const t = wpSiteTree();
  let crontab = start;
  const fake = fakeExec({
    'crontab -l': () => (crontab === null ? { code: 1, stderr: 'no crontab for alex\n' } : { stdout: crontab }),
    'crontab -': (call) => {
      crontab = call.input ?? '';
      return {};
    },
    ...more,
  });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/usr/local/lib/devmagic-panel/bin/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'data', 'uploads'), secrets: null, cron: { command: COMMAND, etcDir: join(t.root, 'etc') },
  };
  return { ...t, ctx, store, calls: fake.calls, crontab: () => crontab, setCrontab: (text: string) => { crontab = text; } };
}

const add = (s: ReturnType<typeof setup>, input: Record<string, unknown> = {}) =>
  runAction(s.ctx, 'cron.add', { title: 'WP-Cron for local.shop.com', schedule: '*/5 * * * *', task: { kind: 'wp-cron', domain: 'local.shop.com' }, ...input });

describe('the crontab block', () => {
  it('adds the block after the lines made by hand and keeps them byte for byte', async () => {
    const s = setup();
    const r = await add(s);
    expect(r.ok).toBe(true);
    const text = s.crontab() as string;
    expect(text.startsWith(HAND)).toBe(true);
    const id = /--id=([a-z0-9]{6})/.exec(text)?.[1] as string;
    expect(text.slice(HAND.length)).toBe(
      `\n${CRON_BEGIN}\n# task ${id}: WP-Cron for local.shop.com\n*/5 * * * * ${RUN} --id=${id} --timeout=10 wp-cron --site=local.shop.com\n${CRON_END}\n`,
    );
    // The crontab as it was is saved for Undo, readable by you alone.
    expect(r.data?.backup).toMatch(/^crontab-\d{8}-\d{6}-\d{3}\.txt$/);
    const saved = join(s.config.BACKUP_DIR, r.data?.backup as string);
    expect(readFileSync(saved, 'utf8')).toBe(HAND);
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    // Written through crontab's stdin, never a shell.
    expect(s.calls.filter((c) => c.file === 'crontab').map((c) => c.args.join(' '))).toEqual(['-l', '-l', '-']);
  });

  it('makes a crontab for an account that has none', async () => {
    const s = setup(null);
    expect((await add(s)).ok).toBe(true);
    expect((s.crontab() as string).startsWith(`${CRON_BEGIN}\n# task `)).toBe(true);
  });

  it('turns a task off as a commented line, changes it, and removes it with its block', async () => {
    const s = setup();
    await add(s);
    const id = tasksOf(parseCrontab(s.crontab() as string))[0]?.id as string;
    expect((await runAction(s.ctx, 'cron.setEnabled', { id, enabled: false })).ok).toBe(true);
    expect(s.crontab()).toContain(`\n#off */5 * * * * ${RUN} --id=${id} `);
    await runAction(s.ctx, 'cron.update', { id, title: 'Hourly', schedule: '0 * * * *', task: { kind: 'wp-cli', domain: 'local.shop.com', command: ['transient', 'delete', '--expired'] }, enabled: true, timeoutMinutes: 5 });
    expect(s.crontab()).toContain(`# task ${id}: Hourly\n0 * * * * ${RUN} --id=${id} --timeout=5 wp-cli --site=local.shop.com -- transient delete --expired\n`);
    expect((await runAction(s.ctx, 'cron.remove', { id })).ok).toBe(true);
    expect(s.crontab()).toBe(`${HAND}\n`);
  });

  it('keeps lines in the block it cannot read, and refuses two blocks', async () => {
    const s = setup(`${HAND}${CRON_BEGIN}\n* * * * * echo edited by hand\n${CRON_END}\n`);
    await add(s);
    expect(s.crontab()).toContain('* * * * * echo edited by hand\n# END devmagic-panel\n');
    const report = await cronReport({ config: s.config, exec: s.ctx.exec, store: s.store, command: COMMAND, etcDir: join(s.root, 'etc') });
    expect(report.unreadable).toEqual(['* * * * * echo edited by hand']);

    s.setCrontab(`${CRON_BEGIN}\n${CRON_END}\n${CRON_BEGIN}\n${CRON_END}\n`);
    await expect(add(s)).rejects.toThrow(/two devmagic-panel blocks/);
    s.setCrontab(`${CRON_BEGIN}\n* * * * * x\n`);
    await expect(add(s)).rejects.toThrow(/BEGIN line without its END/);
  });

  it('refuses when the crontab changed while it was writing', async () => {
    let reads = 0;
    const s = setup(HAND, { 'crontab -l': () => ({ stdout: reads++ === 0 ? HAND : `${HAND}* * * * * echo new\n` }) });
    await expect(add(s)).rejects.toThrow(/changed while the panel was changing it/);
    expect(s.calls.some((c) => c.file === 'crontab' && c.args[0] === '-')).toBe(false);
  });

  it('puts the block back on Undo, keeping a line written by hand since', async () => {
    const s = setup();
    const first = await add(s);
    const before = s.crontab() as string;
    const id = tasksOf(parseCrontab(before))[0]?.id as string;
    const removed = await runAction(s.ctx, 'cron.remove', { id });
    s.setCrontab(`${s.crontab()}30 1 * * * /home/alex/bin/new.sh\n`);
    const undo = await runAction(s.ctx, 'cron.undo', { backup: removed.data?.backup as string });
    expect(undo.ok).toBe(true);
    const after = parseCrontab(s.crontab() as string);
    expect(tasksOf(after).map((t) => t.id)).toEqual([id]);
    expect(after.after.concat(after.before)).toContain('30 1 * * * /home/alex/bin/new.sh');
    // Undo of the first change takes the block away again.
    await runAction(s.ctx, 'cron.undo', { backup: first.data?.backup as string });
    expect(tasksOf(parseCrontab(s.crontab() as string))).toEqual([]);
    expect(s.crontab()).toContain('/home/alex/bin/new.sh');
  });

  it('refuses bad input before any command, and a site that is not here', async () => {
    const s = setup();
    await expect(add(s, { schedule: '* * * *' })).rejects.toThrow(ActionInputError);
    await expect(add(s, { task: { kind: 'wp-cli', domain: 'local.shop.com', command: ['eval', 'x'] } })).rejects.toThrow(ActionInputError);
    expect(s.calls).toEqual([]);
    await expect(add(s, { task: { kind: 'wp-cron', domain: 'local.gone.com' } })).rejects.toThrow(/no site called local.gone.com/);
    await expect(add(s, { task: { kind: 'php-script', domain: 'local.shop.com', file: 'wp-content/cron/missing.php' } })).rejects.toThrow(/not in local.shop.com/);
    await expect(add(s, { task: { kind: 'program', program: '/nonexistent/sync.sh' } })).rejects.toThrow(/missing or not executable/);
    expect(s.calls.filter((c) => c.file === 'crontab')).toEqual([]);
  });

  it("checks that the site has its own WP-CLI command before it saves the task", async () => {
    const t = setup(HAND, {
      wp: (call) => (call.args.includes('has-command') && call.args.at(-1) === 'wandworks' ? {} : { code: 1 }),
    });
    expect((await add(t, { task: { kind: 'wp-cli', domain: 'local.shop.com', command: ['wandworks', 'sync'] } })).ok).toBe(true);
    await expect(add(t, { task: { kind: 'wp-cli', domain: 'local.shop.com', command: ['other', 'sync'] } })).rejects.toThrow(/has no WP-CLI command other/);
  });

  it('records the run history, and clears it', async () => {
    const s = setup();
    const run = s.store.startCronRun('k3f9q2', 'cron');
    s.store.finishCronRun(run, 'failed', 1, 1200, 'Error: no database');
    expect(s.store.cronRuns('k3f9q2')).toMatchObject([{ status: 'failed', exitCode: 1, durationMs: 1200 }]);
    expect(s.store.cronRun(run)?.output).toBe('Error: no database');
    expect((await runAction(s.ctx, 'cron.clearRuns', { id: 'k3f9q2' })).output).toBe('deleted 1 runs of the task k3f9q2');
  });
});

describe('task lines', () => {
  it('reads back every kind it writes', () => {
    const tasks = [
      { kind: 'wp-cron', domain: 'local.shop.com', path: '/learn' },
      { kind: 'wp-cli', domain: 'local.shop.com', command: ['cron', 'event', 'run', 'wandworks_sync'] },
      { kind: 'php-script', domain: 'local.shop.com', file: 'wp-content/cron/sync.php' },
      { kind: 'url', url: 'https://local.shop.com/wp-cron.php?doing_wp_cron=1&a=%20' },
      { kind: 'program', program: '/home/alex/bin/sync.sh', args: ['two words', "it's $HOME; rm -rf / %"] },
      { kind: 'program', program: '/usr/bin/true', args: [] },
    ] as const;
    for (const task of tasks) {
      const args = taskArgs({ id: 'k3f9q2', timeoutMinutes: 7, task: task as never });
      // Every word is safe to hand to /bin/sh as it is.
      for (const word of args) expect(word).toMatch(/^[A-Za-z0-9._/:=@,+-]+$/);
      expect(decodeTaskArgs(args)).toEqual({ id: 'k3f9q2', timeoutMinutes: 7, task });
    }
  });

  it('refuses arguments edited into something else', () => {
    expect(decodeTaskArgs(['--id=k3f9q2', 'wp-cli', '--site=local.shop.com', '--', 'eval', 'x'])).toMatch(/not one a task may run/);
    expect(decodeTaskArgs(['--id=k3f9q2', 'wp-cron', '--site=example.com'])).toMatch(/local name/);
    expect(decodeTaskArgs(['wp-cron', '--site=local.shop.com'])).toBe('no task id');
    expect(decodeTaskArgs(['--id=k3f9q2', 'rm'])).toBe('unknown kind rm');
  });

  it('refuses a path of its own that the shell would read', () => {
    const parsed = parseCrontab('');
    const task = { id: 'k3f9q2', title: 'x', schedule: '* * * * *', enabled: true, timeoutMinutes: 10, task: { kind: 'wp-cron' as const, domain: 'local.shop.com' } };
    expect(() => renderCrontab(parsed, [task], { node: '/home/alex smith/node', cli: '/x/cli.js' })).toThrow(/cannot go on a crontab line/);
  });

  it('calls the stable node link when the panel runs its own Node', () => {
    expect(cronCommand('/home/alex/.local/share/devmagic-panel/node/v22.13.0/bin/node', '/home/alex/.local/share/devmagic-panel', '/c.js').node).toBe('/home/alex/.local/share/devmagic-panel/node/current/bin/node');
    expect(cronCommand('/usr/bin/node', '/home/alex/.local/share/devmagic-panel', '/c.js').node).toBe('/usr/bin/node');
  });
});

describe('cronReport', () => {
  it('lists the panel\'s tasks, the lines made by hand and system cron read only', async () => {
    const s = setup();
    await add(s);
    const etc = join(s.root, 'etc');
    mkdirSync(join(etc, 'cron.d'), { recursive: true });
    mkdirSync(join(etc, 'cron.daily'), { recursive: true });
    writeFileSync(join(etc, 'crontab'), 'SHELL=/bin/sh\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n');
    writeFileSync(join(etc, 'cron.d', 'php'), '09,39 * * * * root [ -x /usr/lib/php/sessionclean ] && /usr/lib/php/sessionclean\n');
    writeFileSync(join(etc, 'cron.daily', 'logrotate'), '');
    writeFileSync(join(etc, 'cron.daily', '.placeholder'), '');
    const report = await cronReport({ config: s.config, exec: s.ctx.exec, store: s.store, command: COMMAND, etcDir: etc, now: () => new Date(2026, 10, 6, 10, 2) });
    expect(report.allowed).toBe(true);
    expect(report.tasks).toMatchObject([{ title: 'WP-Cron for local.shop.com', describe: 'Every 5 minutes', enabled: true, site: { domain: 'local.shop.com' } }]);
    expect(report.tasks[0]?.next).toHaveLength(3);
    expect(report.tasks[0]?.problem).toBeUndefined();
    expect(report.hand).toMatchObject([{ schedule: '0 4 * * *', describe: 'Every day at 04:00', command: '/home/alex/bin/backup.sh > /tmp/backup.log 2>&1' }]);
    expect(report.system.files.map((f) => [f.file.slice(etc.length), f.lines.map((l) => l.user)])).toEqual([['/crontab', ['root']], ['/cron.d/php', ['root']]]);
    expect(report.system.folders).toEqual([{ folder: join(etc, 'cron.daily'), scripts: ['logrotate'] }]);
  });

  it('says why an account may not have a crontab', async () => {
    const s = setup(HAND, { 'crontab -l': { code: 1, stderr: 'You (alex) are not allowed to use this program (crontab)\n' } });
    const report = await cronReport({ config: s.config, exec: s.ctx.exec, store: s.store, command: COMMAND });
    expect(report.allowed).toBe(false);
    expect(report.problems[0]).toContain('/etc/cron.allow');
  });

  it('marks a task whose site is gone', async () => {
    const s = setup(`${CRON_BEGIN}\n# task k3f9q2: Old\n* * * * * ${RUN} --id=k3f9q2 --timeout=10 wp-cron --site=local.gone.com\n${CRON_END}\n`);
    const report = await cronReport({ config: s.config, exec: s.ctx.exec, store: s.store, command: COMMAND });
    expect(report.tasks[0]?.problem).toContain('no site called local.gone.com');
  });
});

describe('a removed site', () => {
  it('takes its tasks out of the crontab first and keeps them for a restore', async () => {
    const s = setup();
    await add(s);
    await add(s, { title: 'Other', task: { kind: 'url', url: 'https://local.other.test/' } });
    const ctx = { ...s.ctx, secrets: { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } } };
    const result = await runAction(ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    const step = () => ctx.jobs.get(result.data?.jobId as string)?.steps[0];
    for (let i = 0; i < 100 && step()?.status !== 'done' && step()?.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(step()).toMatchObject({ id: 'cron', status: 'done' });
    expect(tasksOf(parseCrontab(s.crontab() as string)).map((t) => t.title)).toEqual(['Other']);
    expect(JSON.parse(s.store.getMeta('cron-removed:local.shop.com') as string)).toMatchObject([{ title: 'WP-Cron for local.shop.com' }]);
  });
});

describe('backups folder', () => {
  it('is made private when the panel makes it', async () => {
    const s = setup();
    expect(existsSync(s.config.BACKUP_DIR)).toBe(false);
    await add(s);
    expect(statSync(s.config.BACKUP_DIR).mode & 0o777).toBe(0o700);
    expect(readdirSync(s.config.BACKUP_DIR)).toHaveLength(1);
    chmodSync(s.config.BACKUP_DIR, 0o700);
  });
});

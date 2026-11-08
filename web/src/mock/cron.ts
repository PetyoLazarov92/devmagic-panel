import type { ActionRunResult, CronReport, CronRunView, CronTask, CronTaskView, WpCronEvent, WpCronReport } from '@devmagic-panel/shared';
import { describeSchedule, nextRuns, WP_CORE_HOOKS } from '@devmagic-panel/shared';

/** The mockup's crontab: the panel's tasks and their runs, changed in place by the cron actions. */

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

interface MockTask {
  id: string;
  title: string;
  schedule: string;
  enabled: boolean;
  timeoutMinutes: number;
  task: CronTask;
}

let tasks: MockTask[] = [
  { id: 'k3f9q2', title: 'WP-Cron for local.spellbook.example', schedule: '*/5 * * * *', enabled: true, timeoutMinutes: 10, task: { kind: 'wp-cron', domain: 'local.spellbook.example' } },
  { id: 'p7w1zz', title: 'Action Scheduler for local.biketours.example', schedule: '*/10 * * * *', enabled: false, timeoutMinutes: 10, task: { kind: 'wp-cli', domain: 'local.biketours.example', command: ['action-scheduler', 'run', '--batch-size=25'] } },
  { id: 'm2c8re', title: 'Sync orders to the ERP', schedule: '0 3 * * *', enabled: true, timeoutMinutes: 30, task: { kind: 'php-script', domain: 'local.biketours.example', file: 'wp-content/cron/sync-orders.php' } },
  { id: 'b4ckup', title: 'Back up my notes', schedule: '30 18 * * 1-5', enabled: true, timeoutMinutes: 5, task: { kind: 'program', program: '/home/alex/bin/notes-backup.sh', args: ['--to', '/home/alex/Backups'] } },
];

let nextRunId = 900;
const runs: Array<CronRunView & { output: string }> = [
  { id: 801, task: 'k3f9q2', trigger: 'cron', status: 'ok', startedAt: minutes(-3), durationMs: 2100, exitCode: 0, output: "Executed the cron event 'wp_version_check' in 0.412s.\nExecuted the cron event 'wandworks_digest' in 1.102s.\nSuccess: Executed a total of 2 cron events." },
  { id: 800, task: 'k3f9q2', trigger: 'cron', status: 'ok', startedAt: minutes(-8), durationMs: 900, exitCode: 0, output: 'Success: Executed a total of 0 cron events.' },
  { id: 790, task: 'm2c8re', trigger: 'cron', status: 'failed', startedAt: minutes(-60 * 7), durationMs: 14_200, exitCode: 255, output: 'PHP Fatal error:  Uncaught Exception: The ERP sandbox refused the login in /var/www/local.biketours.example/wp-content/cron/sync-orders.php:42' },
  { id: 760, task: 'b4ckup', trigger: 'manual', status: 'ok', startedAt: minutes(-60 * 26), durationMs: 3400, exitCode: 0, output: 'copied 14 files' },
];

const view = (t: MockTask): CronTaskView => {
  const last = runs.filter((r) => r.task === t.id).sort((a, b) => b.id - a.id)[0];
  const site = 'domain' in t.task ? { domain: t.task.domain, ...(t.task.path ? { path: t.task.path } : {}) } : undefined;
  return {
    ...t,
    describe: describeSchedule(t.schedule),
    ...(site ? { site } : {}),
    next: t.enabled ? nextRuns(t.schedule, new Date(), 3).map((d) => d.toISOString()) : [],
    ...(last ? { last: (({ output: _output, ...run }) => run)(last) } : {}),
  };
};

export function mockCron(): CronReport {
  return {
    checkedAt: new Date().toISOString(),
    daemon: 'running',
    timeZone: 'Europe/Sofia',
    allowed: true,
    tasks: tasks.map(view),
    hand: [
      { line: 2, schedule: '0 4 * * *', describe: 'Every day at 04:00', command: '/home/alex/bin/backup.sh > /tmp/backup.log 2>&1', next: nextRuns('0 4 * * *', new Date(), 3).map((d) => d.toISOString()) },
    ],
    unreadable: [],
    problems: [],
    system: {
      files: [
        { file: '/etc/crontab', lines: [{ schedule: '17 * * * *', describe: 'Every hour at :17', user: 'root', command: 'cd / && run-parts --report /etc/cron.hourly' }] },
        { file: '/etc/cron.d/php', lines: [{ schedule: '09,39 * * * *', describe: 'Custom: 09,39 * * * *', user: 'root', command: '[ -x /usr/lib/php/sessionclean ] && if [ ! -d /run/systemd/system ]; then /usr/lib/php/sessionclean; fi' }] },
        { file: '/etc/cron.d/e2scrub_all', lines: [{ schedule: '30 3 * * 0', describe: 'Every Sunday at 03:30', user: 'root', command: 'test -e /run/systemd/system || SERVICE_MODE=1 /usr/lib/x86_64-linux-gnu/e2fsprogs/e2scrub_all_cron' }] },
      ],
      folders: [
        { folder: '/etc/cron.daily', scripts: ['apport', 'apt-compat', 'dpkg', 'logrotate', 'man-db'] },
        { folder: '/etc/cron.weekly', scripts: ['man-db'] },
      ],
      timers: [
        { unit: 'apt-daily.timer', activates: 'apt-daily.service', next: minutes(240), last: minutes(-600) },
        { unit: 'logrotate.timer', activates: 'logrotate.service', next: minutes(700), last: minutes(-740) },
        { unit: 'fstrim.timer', activates: 'fstrim.service', next: minutes(60 * 50) },
      ],
    },
  };
}

export const mockCronRuns = (id: string): CronRunView[] => runs.filter((r) => r.task === id).sort((a, b) => b.id - a.id).map(({ output: _output, ...r }) => r);
export const mockCronRun = (id: number): CronRunView | undefined => runs.find((r) => r.id === id);

const NOW = () => Math.floor(Date.now() / 1000);
const wpEvents = new Map<string, WpCronEvent[]>();
function eventsOf(key: string): WpCronEvent[] {
  if (!wpEvents.has(key)) {
    const now = NOW();
    const list: Array<Omit<WpCronEvent, 'overdue' | 'core'>> = [
      { hook: 'wandworks_sync_orders', time: now - 2 * 3600, recurrence: 'hourly', interval: 3600, args: [], sig: 'a'.repeat(32) },
      { hook: 'wp_version_check', time: now + 25 * 60, recurrence: 'twicedaily', interval: 43200, args: [], sig: 'b'.repeat(32) },
      { hook: 'wp_update_plugins', time: now + 25 * 60, recurrence: 'twicedaily', interval: 43200, args: [], sig: 'c'.repeat(32) },
      { hook: 'wandworks_send_receipt', time: now + 90, recurrence: '', interval: null, args: [4127, 'alex@example.com'], sig: 'd'.repeat(32) },
      { hook: 'woocommerce_cleanup_sessions', time: now + 3 * 3600, recurrence: 'twicedaily', interval: 43200, args: [], sig: 'e'.repeat(32) },
      { hook: 'wp_scheduled_delete', time: now + 9 * 3600, recurrence: 'daily', interval: 86400, args: [], sig: 'f'.repeat(32) },
      { hook: 'action_scheduler_run_queue', time: now - 40 * 60, recurrence: 'every_minute', interval: 60, args: ['WP Cron'], sig: '0'.repeat(32) },
    ];
    wpEvents.set(key, list.map((e) => ({ ...e, overdue: e.time < now - 600, core: (WP_CORE_HOOKS as readonly string[]).includes(e.hook) })).sort((a, b) => a.time - b.time));
  }
  return wpEvents.get(key) as WpCronEvent[];
}

export function mockWpCron(domain: string, path?: string, url?: string, disabled = false): WpCronReport {
  const key = `${domain}${path ?? ''}${url ?? ''}`;
  const events = eventsOf(key);
  const mine = tasks.filter((t) => 'domain' in t.task && t.task.domain === domain && (t.task.path ?? undefined) === path).map(view);
  const task = mine.find((t) => t.task.kind === 'wp-cron');
  return {
    events: structuredClone(events),
    schedules: [
      { name: 'every_minute', display: 'Every minute', interval: 60 },
      { name: 'hourly', display: 'Once Hourly', interval: 3600 },
      { name: 'twicedaily', display: 'Twice Daily', interval: 43200 },
      { name: 'daily', display: 'Once Daily', interval: 86400 },
      { name: 'weekly', display: 'Once Weekly', interval: 604800 },
    ],
    disabled: disabled || Boolean(task),
    alternate: false,
    ...(task ? { task } : {}),
    tasks: mine.filter((t) => t !== task),
    overdue: events.filter((e) => e.overdue).length,
    configTracked: domain === 'local.biketours.example',
    ...(url ? { url } : {}),
  };
}

const ok = (output: string, backup?: string): ActionRunResult => ({ runId: 42, ok: true, exitCode: 0, output, ...(backup ? { data: { backup } } : {}) });
const saved = new Map<string, MockTask[]>();
const keep = () => {
  const name = `crontab-${Date.now()}.txt`;
  saved.set(name, structuredClone(tasks));
  return name;
};
const deletedEvents = new Map<string, { key: string; event: WpCronEvent }>();

/** The cron and WP-Cron actions in the mockup; null for any other action. */
export function mockCronAction(id: string, input: Record<string, unknown>): ActionRunResult | null {
  const find = () => tasks.find((t) => t.id === input.id);
  switch (id) {
    case 'cron.add': {
      const backup = keep();
      tasks.push({ id: Math.random().toString(36).slice(2, 8).padEnd(6, '0'), title: String(input.title), schedule: String(input.schedule), enabled: input.enabled !== false, timeoutMinutes: Number(input.timeoutMinutes ?? 10), task: input.task as CronTask });
      return ok(`added the task ${String(input.title)}`, backup);
    }
    case 'cron.update': {
      const backup = keep();
      tasks = tasks.map((t) => (t.id === input.id ? { id: t.id, title: String(input.title), schedule: String(input.schedule), enabled: input.enabled !== false, timeoutMinutes: Number(input.timeoutMinutes ?? 10), task: input.task as CronTask } : t));
      return ok(`changed the task ${String(input.title)}`, backup);
    }
    case 'cron.setEnabled': {
      const backup = keep();
      const t = find();
      if (t) t.enabled = input.enabled === true;
      return ok(`turned ${input.enabled ? 'on' : 'off'} the task ${String(input.id)}`, backup);
    }
    case 'cron.remove': {
      const backup = keep();
      tasks = tasks.filter((t) => t.id !== input.id);
      return ok(`removed the task ${String(input.id)}; its runs are kept 14 days`, backup);
    }
    case 'cron.undo': {
      const back = saved.get(String(input.backup));
      if (!back) return { runId: 42, ok: false, exitCode: 2, output: 'that saved copy is gone' };
      const backup = keep();
      tasks = structuredClone(back);
      return ok('put the panel\'s tasks back', backup);
    }
    case 'cron.clearRuns': {
      const before = runs.length;
      for (let i = runs.length - 1; i >= 0; i--) if (runs[i]?.task === input.id) runs.splice(i, 1);
      return ok(`deleted ${before - runs.length} runs of the task ${String(input.id)}`);
    }
    case 'cron.setSiteWpCron': {
      const backup = keep();
      const domain = String(input.domain);
      const path = typeof input.path === 'string' ? input.path : undefined;
      tasks = tasks.filter((t) => !(t.task.kind === 'wp-cron' && t.task.domain === domain && (t.task.path ?? undefined) === path));
      if (input.fromCron) {
        tasks.push({ id: Math.random().toString(36).slice(2, 8).padEnd(6, '0'), title: `WP-Cron for ${domain}${path ?? ''}`, schedule: String(input.schedule ?? '*/5 * * * *'), enabled: true, timeoutMinutes: 10, task: { kind: 'wp-cron', domain, ...(path ? { path } : {}) } });
      }
      return ok(input.fromCron ? `cron runs the WP-Cron of ${domain}\nSuccess: Added the constant 'DISABLE_WP_CRON' to the 'wp-config.php' file with the raw value 'true'.` : `cron no longer runs the WP-Cron of ${domain}\nSuccess: Deleted the 'DISABLE_WP_CRON' constant.`, backup);
    }
    case 'wpcron.run':
      return ok(`Executed the cron event '${String(input.hook)}' in 0.218s.\nSuccess: Executed a total of 1 cron event.`);
    case 'wpcron.delete': {
      const key = `${String(input.domain)}${typeof input.path === 'string' ? input.path : ''}${typeof input.url === 'string' ? input.url : ''}`;
      const list = eventsOf(key);
      const at = list.findIndex((e) => e.sig === input.sig && e.time === input.time && e.hook === input.hook);
      if (at < 0) return { runId: 42, ok: false, exitCode: 1, output: 'Error: this event is not scheduled any more: it may have run or been changed' };
      const [event] = list.splice(at, 1);
      const backup = `wp-cron-${String(input.domain)}-${Date.now()}.json`;
      deletedEvents.set(backup, { key, event: event as WpCronEvent });
      return ok(`deleted the event ${String(input.hook)}`, backup);
    }
    case 'wpcron.undo': {
      const back = deletedEvents.get(String(input.backup));
      if (!back) return { runId: 42, ok: false, exitCode: 2, output: 'that saved copy is gone' };
      const list = eventsOf(back.key);
      list.push(back.event);
      list.sort((a, b) => a.time - b.time);
      return ok(`${back.event.hook}: put back`);
    }
    default:
      return null;
  }
}

/** Run now in the mockup: a run of a few seconds that ends well. */
export function mockCronRunNow(id: string): string {
  const task = tasks.find((t) => t.id === id);
  runs.push({ id: ++nextRunId, task: id, trigger: 'manual', status: 'ok', startedAt: new Date().toISOString(), durationMs: 1800, exitCode: 0, output: task?.task.kind === 'wp-cron' ? 'Success: Executed a total of 3 cron events.' : 'done' });
  return task?.title ?? id;
}

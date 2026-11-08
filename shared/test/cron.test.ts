import { describe, expect, it } from 'vitest';
import { actions, cronTask, wpCliCommandProblem } from '../src/actions.js';
import { cronSchedule, describeSchedule, nextRuns, parseSchedule } from '../src/cron.js';

const ok = (s: string) => cronSchedule.safeParse(s).success;
const why = (s: string) => {
  const r = cronSchedule.safeParse(s);
  return r.success ? '' : r.error.issues[0]?.message;
};

describe('cronSchedule', () => {
  it.each(['* * * * *', '*/5 * * * *', '0 3 * * *', '0,30 8-18 * * mon-fri', '15 2 1 jan,jul *', '0 0 * * 7', '0 0 1-15/2 * *', '@daily', '@reboot', '@HOURLY', '  0   3 * * *  '])('accepts %s', (s) => {
    expect(ok(s)).toBe(true);
  });

  it.each([
    ['* * * *', 'five fields'],
    ['* * * * * *', 'five fields'],
    ['60 * * * *', 'outside 0-59'],
    ['* 24 * * *', 'outside 0-23'],
    ['* * 0 * *', 'outside 1-31'],
    ['* * * 13 *', 'outside 1-12'],
    ['* * * * 8', 'outside 0-7'],
    ['5/10 * * * *', 'a step needs'],
    ['*/0 * * * *', 'step must be 1'],
    ['30-10 * * * *', 'goes backwards'],
    ['* * * * * %', 'cannot hold %'],
    ['@sometimes', 'not one of'],
    ['* * * * foo', 'not a number'],
    ['*;rm * * * *', 'not a valid entry'],
  ])('refuses %s', (s, message) => {
    expect(why(s)).toContain(message);
  });

  it('reads 7 as Sunday and names as numbers', () => {
    const s = parseSchedule('0 0 * feb sun,7');
    expect(typeof s).toBe('object');
    if (typeof s === 'string') return;
    expect([...s.weekdays]).toEqual([0]);
    expect([...s.months]).toEqual([2]);
  });
});

describe('describeSchedule', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['5 * * * *', 'Every hour at :05'],
    ['0 */2 * * *', 'Every 2 hours at :00'],
    ['0 3 * * *', 'Every day at 03:00'],
    ['30 7 * * 1-5', 'Every weekday at 07:30'],
    ['0 3 * * 1', 'Every Monday at 03:00'],
    ['0 4 15 * *', 'On day 15 of every month at 04:00'],
    ['0 0 25 12 *', 'Every year on 25 December at 00:00'],
    ['@daily', 'Every day at 00:00'],
    ['@reboot', 'When the computer starts'],
    ['0,30 8-18 * * mon-fri', 'Custom: 0,30 8-18 * * mon-fri'],
  ])('%s is "%s"', (s, words) => {
    expect(describeSchedule(s)).toBe(words);
  });
});

describe('nextRuns', () => {
  const from = new Date(2026, 10, 6, 10, 2, 30);
  const at = (d: Date) => `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  it('steps through minutes and hours', () => {
    expect(nextRuns('*/5 * * * *', from, 3).map(at)).toEqual(['11-6 10:05', '11-6 10:10', '11-6 10:15']);
    expect(nextRuns('0 3 * * *', from, 2).map(at)).toEqual(['11-7 3:00', '11-8 3:00']);
  });

  it('goes over month ends and years', () => {
    expect(nextRuns('0 0 31 * *', from, 2).map(at)).toEqual(['12-31 0:00', '1-31 0:00']);
    expect(nextRuns('0 12 29 2 *', from, 1).map((d) => d.getFullYear())).toEqual([2028]);
  });

  it('matches either day field when both are set, as cron does', () => {
    // The 1st of the month or any Monday: Monday 9 November comes before 1 December.
    expect(nextRuns('0 9 1 * 1', from, 2).map(at)).toEqual(['11-9 9:00', '11-16 9:00']);
    // Only the day of week set: Mondays only.
    expect(nextRuns('0 9 * * 1', from, 1).map(at)).toEqual(['11-9 9:00']);
  });

  it('has none for @reboot or a day that never comes', () => {
    expect(nextRuns('@reboot', from, 3)).toEqual([]);
    expect(nextRuns('0 0 31 2 *', from, 1)).toEqual([]);
  });
});

describe('cronTask', () => {
  const parse = (task: unknown) => cronTask.safeParse(task);
  const message = (task: unknown) => {
    const r = parse(task);
    return r.success ? '' : r.error.issues.map((i) => i.message).join('; ');
  };

  it('takes each kind with what it needs', () => {
    expect(parse({ kind: 'wp-cron', domain: 'local.wandworks.example' }).success).toBe(true);
    expect(parse({ kind: 'wp-cron', domain: 'local.wandworks.example', path: '/learn' }).success).toBe(true);
    expect(parse({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['action-scheduler', 'run', '--batch-size=25'] }).success).toBe(true);
    expect(parse({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['wandworks', 'sync', '--limit=50'] }).success).toBe(true);
    expect(parse({ kind: 'php-script', domain: 'local.wandworks.example', file: 'wp-content/cron/sync.php' }).success).toBe(true);
    expect(parse({ kind: 'url', url: 'https://local.wandworks.example/wp-cron.php?doing_wp_cron=1&x=%20' }).success).toBe(true);
    expect(parse({ kind: 'program', program: '/home/alex/bin/sync.sh', args: ['--to', 'a b', "it's 100%", '$HOME;rm -rf /'] }).success).toBe(true);
  });

  it('refuses sites that are not local, and real domains in a URL', () => {
    expect(parse({ kind: 'wp-cron', domain: 'example.com' }).success).toBe(false);
    expect(message({ kind: 'url', url: 'https://example.com/wp-cron.php' })).toContain('local name');
    expect(message({ kind: 'url', url: 'https://alex:secret@local.wandworks.example/' })).toContain('local name');
    expect(message({ kind: 'url', url: 'file:///etc/passwd' })).toContain('local name');
  });

  it('keeps WP-CLI to the scheduled commands and a site\'s own', () => {
    expect(message({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['eval', 'echo 1;'] })).not.toBe('');
    expect(message({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['db', 'drop', '--yes'] })).toContain('not one a task may run');
    expect(message({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['plugin', 'install', 'wandworks'] })).toContain('not one a task may run');
    expect(message({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['cron', 'event', 'run'] })).toContain('needs the hook');
    expect(message({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['wandworks', 'sync', '--exec=system("id");'] })).not.toBe('');
    expect(wpCliCommandProblem(['wandworks', 'sync', '--require=/tmp/x.php'])).toContain('--require');
    expect(wpCliCommandProblem(['--url=https://example.com/', 'cache', 'flush'])).toContain('--url');
    expect(wpCliCommandProblem(['cron', 'event', 'run', 'wandworks_sync'])).toBeNull();
    expect(wpCliCommandProblem(['transient', 'delete', '--expired'])).toBeNull();
  });

  it('allows no shell syntax in a word that goes on the crontab line', () => {
    for (const word of ['a b', 'x;id', '$(id)', '`id`', 'a|b', 'a>b', '%', "'", '"', '#x', 'a&b', '*']) {
      expect(parse({ kind: 'wp-cli', domain: 'local.wandworks.example', command: ['wandworks', word] }).success).toBe(false);
    }
  });

  it('keeps a PHP file inside the site and a program at a full path', () => {
    for (const file of ['../wp-config.php', '/etc/passwd.php', 'wp-content/../../x.php', 'wp-content//x.php', 'run.sh', './x.php']) {
      expect(parse({ kind: 'php-script', domain: 'local.wandworks.example', file }).success).toBe(false);
    }
    for (const program of ['bin/sync.sh', '/home/alex/../root/x', '/home/alex/my script', '/home/alex/x;id']) {
      expect(parse({ kind: 'program', program }).success).toBe(false);
    }
    expect(parse({ kind: 'program', program: '/usr/bin/true', args: ['two\nlines'] }).success).toBe(false);
  });

  it('keeps titles to one line and ids to six letters', () => {
    const add = actions['cron.add'].input;
    const base = { schedule: '*/5 * * * *', task: { kind: 'wp-cron', domain: 'local.wandworks.example' } };
    expect(add.safeParse({ ...base, title: 'WP-Cron for local.wandworks.example' }).success).toBe(true);
    expect(add.safeParse({ ...base, title: 'two\nlines' }).success).toBe(false);
    expect(add.safeParse({ ...base, title: '' }).success).toBe(false);
    expect(add.safeParse({ ...base, title: 'x', timeoutMinutes: 61 }).success).toBe(false);
    expect(actions['cron.remove'].input.safeParse({ id: 'K3F9Q2' }).success).toBe(false);
    expect(actions['cron.remove'].input.safeParse({ id: 'k3f9q2' }).success).toBe(true);
  });

  it('takes WP-Cron hooks and saved copies by their shape only', () => {
    const del = actions['wpcron.delete'].input;
    const base = { domain: 'local.wandworks.example', time: 1790000000, sig: '40cd750bba9870f18aada2478b24840a' };
    expect(del.safeParse({ ...base, hook: 'wandworks_sync_orders' }).success).toBe(true);
    expect(del.safeParse({ ...base, hook: 'Wandworks\\Sync::run' }).success).toBe(true);
    expect(del.safeParse({ ...base, hook: '--help' }).success).toBe(false);
    expect(del.safeParse({ ...base, hook: 'x', sig: 'nope' }).success).toBe(false);
    expect(actions['cron.undo'].input.safeParse({ backup: 'crontab-20261106-101500-123.txt' }).success).toBe(true);
    expect(actions['cron.undo'].input.safeParse({ backup: '../secrets.json' }).success).toBe(false);
    expect(actions['wpcron.undo'].input.safeParse({ domain: 'local.wandworks.example', backup: 'wp-cron-local.wandworks.example-learn-20261106-101500-123.json' }).success).toBe(true);
  });
});

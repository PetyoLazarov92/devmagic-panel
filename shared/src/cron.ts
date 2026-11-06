import { z } from 'zod';
import type { CronTask } from './actions.js';

/**
 * Cron schedules, read and described the way Debian's cron reads them:
 * five fields (minute, hour, day of month, month, day of week) or a macro.
 * Pure functions, shared by the server, the runner and the page.
 */

export const CRON_MACROS = {
  '@reboot': 'When the computer starts',
  '@yearly': 'Every year on 1 January at 00:00',
  '@annually': 'Every year on 1 January at 00:00',
  '@monthly': 'On the 1st of every month at 00:00',
  '@weekly': 'Every Sunday at 00:00',
  '@daily': 'Every day at 00:00',
  '@midnight': 'Every day at 00:00',
  '@hourly': 'Every hour at :00',
} as const;
type Macro = keyof typeof CRON_MACROS;

/** What each macro means as five fields; @reboot has none. */
const MACRO_FIELDS: Record<Exclude<Macro, '@reboot'>, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** The first name's number: 1 for months, 0 for days. */
  namesFrom?: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  // 7 is Sunday too, as in cron.
  { name: 'day of week', min: 0, max: 7, names: DAYS, namesFrom: 0 },
];

export interface ParsedSchedule {
  /** The schedule as written. */
  text: string;
  /** Only for @reboot: it runs when cron starts, not at a time. */
  reboot: boolean;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day fields were * (cron matches either day field when both are restricted). */
  anyDay: boolean;
  anyWeekday: boolean;
}

function fieldValue(raw: string, spec: FieldSpec): number | string {
  const lower = raw.toLowerCase();
  if (spec.names && spec.names.includes(lower)) return spec.names.indexOf(lower) + (spec.namesFrom ?? 0);
  if (!/^\d{1,2}$/.test(raw)) return `${spec.name}: "${raw}" is not a number${spec.names ? ' or a name' : ''}`;
  const n = Number(raw);
  if (n < spec.min || n > spec.max) return `${spec.name}: ${n} is outside ${spec.min}-${spec.max}`;
  return n;
}

/** One field: *, a number or name, a range, each with an optional step, as a comma list. */
function parseField(text: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!m) return `${spec.name}: "${item}" is not a valid entry`;
    const [, range, stepText] = m as unknown as [string, string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return `${spec.name}: a step must be 1 or more`;
    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec.name === 'day of week' ? 6 : spec.max;
    } else {
      const [a, b] = range.split('-') as [string, string | undefined];
      const start = fieldValue(a, spec);
      if (typeof start === 'string') return start;
      from = start;
      if (b === undefined) {
        // A single value with a step is not something Debian's cron reads.
        if (stepText !== undefined) return `${spec.name}: a step needs * or a range, like */${stepText} or 0-30/${stepText}`;
        to = start;
      } else {
        const end = fieldValue(b, spec);
        if (typeof end === 'string') return end;
        to = end;
        if (to < from) return `${spec.name}: the range ${range} goes backwards`;
      }
    }
    for (let v = from; v <= to; v += step) values.add(spec.name === 'day of week' && v === 7 ? 0 : v);
  }
  return values;
}

/** A schedule read into the times it matches, or why it cannot be. */
export function parseSchedule(text: string): ParsedSchedule | string {
  const trimmed = text.trim();
  if (trimmed.includes('%')) return 'A schedule cannot hold %';
  if (trimmed.startsWith('@')) {
    const macro = trimmed.toLowerCase() as Macro;
    if (!(macro in CRON_MACROS)) return `${trimmed} is not one of ${Object.keys(CRON_MACROS).join(', ')}`;
    if (macro === '@reboot') {
      return { text: trimmed, reboot: true, minutes: new Set(), hours: new Set(), days: new Set(), months: new Set(), weekdays: new Set(), anyDay: true, anyWeekday: true };
    }
    const parsed = parseSchedule(MACRO_FIELDS[macro]) as ParsedSchedule;
    return { ...parsed, text: trimmed };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return `A schedule has five fields (minute hour day month weekday), this one has ${parts.length}`;
  const sets: Array<Set<number>> = [];
  for (const [i, part] of parts.entries()) {
    const set = parseField(part, FIELDS[i] as FieldSpec);
    if (typeof set === 'string') return set;
    sets.push(set);
  }
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { text: parts.join(' '), reboot: false, minutes, hours, days, months, weekdays, anyDay: parts[2]?.startsWith('*') ?? true, anyWeekday: parts[4]?.startsWith('*') ?? true };
}

/** A schedule cron can read; normalSchedule writes it with single spaces. */
export const cronSchedule = z
  .string()
  .max(120)
  .superRefine((s, ctx) => {
    const parsed = parseSchedule(s);
    if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: parsed });
  });

export const normalSchedule = (text: string) => text.trim().split(/\s+/).join(' ');

function dayMatches(s: ParsedSchedule, date: Date): boolean {
  const dom = s.days.has(date.getDate());
  const dow = s.weekdays.has(date.getDay());
  // cron's rule: when both day fields are restricted, either one matching is enough.
  if (!s.anyDay && !s.anyWeekday) return dom || dow;
  return dom && dow;
}

/**
 * The next times a schedule runs after from, in the time zone this process
 * runs in (cron's own). None for @reboot or a schedule that never matches.
 */
export function nextRuns(text: string, from: Date, count: number): Date[] {
  const s = parseSchedule(text);
  if (typeof s === 'string' || s.reboot) return [];
  const runs: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  // Four years and a day covers 29 February.
  const end = from.getTime() + 4 * 366 * 24 * 3600 * 1000;
  while (runs.length < count && t.getTime() <= end) {
    if (!s.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    runs.push(new Date(t.getTime()));
    t.setMinutes(t.getMinutes() + 1, 0, 0);
  }
  return runs;
}

const two = (n: number) => String(n).padStart(2, '0');
const only = (set: Set<number>) => (set.size === 1 ? ([...set][0] as number) : undefined);
const fieldsOf = (text: string) => text.split(' ');

/** The schedule in words, for the page: "Every 5 minutes", "Every day at 03:00". */
export function describeSchedule(text: string): string {
  const s = parseSchedule(text);
  if (typeof s === 'string') return 'Not a valid schedule';
  const macro = text.trim().toLowerCase();
  if (macro in CRON_MACROS) return CRON_MACROS[macro as Macro];
  const [min, hour, dom, mon, dow] = fieldsOf(s.text) as [string, string, string, string, string];
  const everyDay = dom === '*' && mon === '*' && dow === '*';
  const m = only(s.minutes);
  const h = only(s.hours);
  if (everyDay && hour === '*') {
    if (min === '*') return 'Every minute';
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) return step[1] === '1' ? 'Every minute' : `Every ${step[1]} minutes`;
    if (m !== undefined) return `Every hour at :${two(m)}`;
  }
  if (everyDay && m !== undefined) {
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step) return `Every ${step[1]} hours at :${two(m)}`;
    if (h !== undefined) return `Every day at ${two(h)}:${two(m)}`;
  }
  if (m !== undefined && h !== undefined && mon === '*') {
    const at = `${two(h)}:${two(m)}`;
    if (dom === '*' && s.weekdays.size > 0) {
      const days = [...s.weekdays].sort((a, b) => a - b);
      if (days.join() === '1,2,3,4,5') return `Every weekday at ${at}`;
      return `Every ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${at}`;
    }
    const day = only(s.days);
    if (dow === '*' && day !== undefined) return `On day ${day} of every month at ${at}`;
  }
  if (m !== undefined && h !== undefined && only(s.months) !== undefined && only(s.days) !== undefined && dow === '*') {
    return `Every year on ${only(s.days)} ${MONTH_NAMES[(only(s.months) as number) - 1]} at ${two(h)}:${two(m)}`;
  }
  return `Custom: ${s.text}`;
}

/** Schedules the form offers before a custom one. */
export const CRON_PRESETS = [
  { label: 'Every minute', schedule: '* * * * *' },
  { label: 'Every 5 minutes', schedule: '*/5 * * * *' },
  { label: 'Every 15 minutes', schedule: '*/15 * * * *' },
  { label: 'Every hour', schedule: '0 * * * *' },
  { label: 'Every day at 03:00', schedule: '0 3 * * *' },
  { label: 'Every Monday at 03:00', schedule: '0 3 * * 1' },
] as const;

// ── what the pages read ─────────────────────────────────────

export type CronRunStatus = 'running' | 'ok' | 'failed' | 'skipped';

export interface CronRunView {
  id: number;
  task: string;
  trigger: 'cron' | 'manual';
  status: CronRunStatus;
  startedAt: string;
  durationMs: number | null;
  exitCode: number | null;
  /** Only when a single run is asked for. */
  output?: string;
}

/** A task of the panel, read from its line in the crontab. */
export interface CronTaskView {
  id: string;
  title: string;
  schedule: string;
  /** The schedule in words. */
  describe: string;
  enabled: boolean;
  timeoutMinutes: number;
  task: CronTask;
  /** The site it runs for, by domain and path. */
  site?: { domain: string; path?: string };
  /** ISO times, in the order they come; none while off or for @reboot. */
  next: string[];
  last?: CronRunView;
  /** Why the line cannot run as it is, like a site that is gone. */
  problem?: string;
}

/** A line of the user's crontab the panel did not write. */
export interface CronHandLine {
  line: number;
  schedule: string;
  describe: string;
  command: string;
  next: string[];
}

export interface CronSystemFile {
  file: string;
  lines: Array<{ schedule: string; describe: string; user: string; command: string }>;
}

export interface CronTimer {
  unit: string;
  activates: string;
  next?: string;
  last?: string;
}

export interface CronReport {
  checkedAt: string;
  /** The cron service. */
  daemon: 'running' | 'stopped' | 'missing';
  /** The time zone the schedules run in, like Europe/Sofia. */
  timeZone: string;
  /** Whether this account may have a crontab at all, and why not. */
  allowed: boolean;
  tasks: CronTaskView[];
  hand: CronHandLine[];
  /** Lines inside the panel's block it cannot read; kept as they are. */
  unreadable: string[];
  /** Problems that stop every change, like two blocks; with what to do. */
  problems: string[];
  system: { files: CronSystemFile[]; folders: Array<{ folder: string; scripts: string[] }>; timers: CronTimer[] };
}

/** One scheduled WP-Cron event of a site. */
export interface WpCronEvent {
  hook: string;
  /** Unix time of its next run. */
  time: number;
  /** A schedule's name, or empty for a single event. */
  recurrence: string;
  interval: number | null;
  args: unknown[];
  sig: string;
  overdue: boolean;
  /** WordPress's own hook, like wp_version_check. */
  core: boolean;
}

export interface WpCronReport {
  events: WpCronEvent[];
  schedules: Array<{ name: string; display: string; interval: number }>;
  /** DISABLE_WP_CRON is true: page loads do not run WP-Cron. */
  disabled: boolean;
  /** ALTERNATE_WP_CRON is true. */
  alternate: boolean;
  /** The panel's wp-cron task for this site, when it has one. */
  task?: CronTaskView;
  /** Every other task of the panel for this site. */
  tasks: CronTaskView[];
  overdue: number;
  /** wp-config.php is tracked by git: a constant set shows in git status. */
  configTracked: boolean;
  /** For a network: the site the events are of. */
  url?: string;
}

/** Hooks WordPress itself schedules. */
export const WP_CORE_HOOKS = [
  'wp_version_check', 'wp_update_plugins', 'wp_update_themes', 'wp_scheduled_delete', 'wp_scheduled_auto_draft_delete', 'delete_expired_transients',
  'wp_privacy_delete_old_export_files', 'wp_site_health_scheduled_check', 'recovery_mode_clean_expired_keys', 'wp_https_detection', 'wp_update_user_counts',
  'wp_delete_temp_updater_backups', 'wp_maybe_auto_update', 'wp_split_shared_term_batch', 'upgrader_scheduled_cleanup', 'importer_scheduled_cleanup', 'do_pings',
  'publish_future_post', 'wp_update_comment_type_batch', 'wp_cron_test',
] as const;

/** Overdue: the next run is this far in the past. */
export const WP_CRON_LATE_SECONDS = 10 * 60;

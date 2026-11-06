import { randomBytes } from 'node:crypto';
import { accessSync, constants, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CronHandLine, CronReport, CronSystemFile, CronTask, CronTaskView, CronTimer } from '@devmagic-panel/shared';
import { CRON_WORD, cronTask, describeSchedule, nextRuns, normalSchedule, parseSchedule } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import { unitState } from './services.js';
import { siteFor } from './sites/site-actions.js';
import type { RunStore } from './store.js';

/**
 * The user's crontab, the way the hosts file is kept: the panel's tasks live
 * in one marked block, and every other line, written by hand, stays exactly
 * as it is. Each task line says everything about the task (schedule, id,
 * what it runs), so the crontab is the source of truth; the panel's
 * database only keeps the runs.
 *
 *   # BEGIN devmagic-panel (managed by the panel, edit tasks there)
 *   # task k3f9q2: WP-Cron for local.acme.com
 *   0 * * * * /usr/bin/node /home/alex/.local/share/devmagic-panel/current/server/dist/cli.js cron-run --id=k3f9q2 --timeout=10 wp-cron --site=local.acme.com
 *   # END devmagic-panel
 *
 * No text from a person goes on the command part: titles go on the comment
 * line, and every word of a command is checked against CRON_WORD, so the
 * /bin/sh cron hands the line to finds nothing to read as syntax.
 */

export const CRON_BEGIN = '# BEGIN devmagic-panel (managed by the panel, edit tasks there)';
export const CRON_END = '# END devmagic-panel';
const OFF = '#off ';
const NODE_QUIET = '--disable-warning=ExperimentalWarning';

/** What the panel's lines run: the panel's node and its cli.js, through links that stay put across updates. */
export interface CronCommand {
  node: string;
  cli: string;
}

export interface PanelTask {
  id: string;
  title: string;
  schedule: string;
  enabled: boolean;
  timeoutMinutes: number;
  task: CronTask;
}

type BlockEntry = { kind: 'task'; task: PanelTask } | { kind: 'other'; text: string };

export interface ParsedCrontab {
  before: string[];
  /** Null when the crontab has no block yet. */
  block: BlockEntry[] | null;
  after: string[];
  /** What stops every change, with what to do. */
  problems: string[];
}

export class CronRefused extends Error {}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url').toString('utf8');

/** The runner's arguments for a task: cli.js cron-run <these>. */
export function taskArgs(t: Pick<PanelTask, 'id' | 'timeoutMinutes' | 'task'>): string[] {
  const head = [`--id=${t.id}`, `--timeout=${t.timeoutMinutes}`, t.task.kind];
  const task = t.task;
  const site = 'domain' in task ? [`--site=${task.domain}`, ...(task.path ? [`--at=${task.path}`] : [])] : [];
  switch (task.kind) {
    case 'wp-cron':
      return [...head, ...site];
    case 'wp-cli':
      return [...head, ...site, '--', ...task.command];
    case 'php-script':
      return [...head, ...site, `--file=${task.file}`];
    case 'url':
      return [...head, `--b64=${b64(task.url)}`];
    case 'program':
      return [...head, `--program=${task.program}`, ...(task.args.length ? [`--b64=${b64(JSON.stringify(task.args))}`] : [])];
  }
}

export interface DecodedArgs {
  id: string;
  timeoutMinutes: number;
  task: CronTask;
}

/** The runner's arguments read back, checked with the registry's schema; a string says why not. */
export function decodeTaskArgs(args: readonly string[]): DecodedArgs | string {
  const options = new Map<string, string>();
  let kind: string | undefined;
  let words: string[] | undefined;
  for (const [i, arg] of args.entries()) {
    if (arg === '--') {
      words = args.slice(i + 1);
      break;
    }
    const m = /^--([a-z0-9]+)=(.*)$/.exec(arg);
    if (m) options.set(m[1] as string, m[2] as string);
    else if (!kind) kind = arg;
    else return `unexpected argument ${arg}`;
  }
  const id = options.get('id') ?? '';
  if (!/^[a-z0-9]{6}$/.test(id)) return 'no task id';
  const timeoutMinutes = Number(options.get('timeout') ?? '10');
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) return 'the timeout must be 1 to 60 minutes';
  const site = options.has('site') ? { domain: options.get('site'), ...(options.has('at') ? { path: options.get('at') } : {}) } : {};
  let raw: unknown;
  try {
    if (kind === 'wp-cron') raw = { kind, ...site };
    else if (kind === 'wp-cli') raw = { kind, ...site, command: words ?? [] };
    else if (kind === 'php-script') raw = { kind, ...site, file: options.get('file') };
    else if (kind === 'url') raw = { kind, url: unb64(options.get('b64') ?? '') };
    else if (kind === 'program') raw = { kind, program: options.get('program'), args: options.has('b64') ? JSON.parse(unb64(options.get('b64') as string)) : [] };
    else return `unknown kind ${kind ?? '(none)'}`;
  } catch {
    return 'the arguments cannot be read';
  }
  const parsed = cronTask.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => i.message).join('; ');
  return { id, timeoutMinutes, task: parsed.data };
}

/** A task's line in the block, with its name on the comment line above. */
export function renderTask(command: CronCommand, t: PanelTask): string[] {
  // node:sqlite still warns on stderr, and cron mails whatever a line prints.
  const words = [command.node, NODE_QUIET, command.cli, 'cron-run', ...taskArgs(t)];
  const bad = words.find((w) => !CRON_WORD.test(w) || w.length > 500);
  // A path of the panel's own with a space or a quote cannot go on a crontab line safely.
  if (bad !== undefined) throw new CronRefused(`"${bad}" cannot go on a crontab line: it holds characters cron would hand to the shell`);
  const title = t.title.replace(/[\x00-\x1f\x7f]/g, ' ');
  return [`# task ${t.id}: ${title}`, `${t.enabled ? '' : OFF}${normalSchedule(t.schedule)} ${words.join(' ')}`];
}

/** Splits a schedule off the front of a crontab entry: five fields, or a macro. */
export function splitEntry(text: string, fields = 5): { schedule: string; rest: string } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('@')) {
    const m = /^(@\w+)\s+(.*)$/.exec(trimmed);
    if (!m || typeof parseSchedule(m[1] as string) === 'string') return null;
    return { schedule: m[1] as string, rest: m[2] as string };
  }
  const re = new RegExp(`^((?:\\S+\\s+){${fields - 1}}\\S+)\\s+(.*)$`);
  const m = re.exec(trimmed);
  if (!m) return null;
  const schedule = (m[1] as string).split(/\s+/).join(' ');
  if (typeof parseSchedule(schedule) === 'string') return null;
  return { schedule, rest: m[2] as string };
}

/** A task line of the block read back, or null when it is not one the panel can read. */
export function readTaskLine(text: string, titles: Map<string, string>): PanelTask | null {
  const enabled = !text.startsWith(OFF);
  const entry = splitEntry(enabled ? text : text.slice(OFF.length));
  if (!entry) return null;
  const words = entry.rest.split(/\s+/);
  // node, its options, cli.js, cron-run: the paths may have changed since, the arguments say what the task is.
  const at = words.indexOf('cron-run');
  if (at < 2 || at > 4) return null;
  const decoded = decodeTaskArgs(words.slice(at + 1));
  if (typeof decoded === 'string') return null;
  return { id: decoded.id, title: titles.get(decoded.id) ?? decoded.id, schedule: entry.schedule, enabled, timeoutMinutes: decoded.timeoutMinutes, task: decoded.task };
}

export function parseCrontab(text: string): ParsedCrontab {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const before: string[] = [];
  const after: string[] = [];
  const raw: string[] = [];
  const problems: string[] = [];
  let state: 'before' | 'block' | 'after' = 'before';
  let found = false;
  for (const line of lines) {
    if (state === 'before') {
      if (line === CRON_BEGIN) {
        state = 'block';
        found = true;
      } else before.push(line);
    } else if (state === 'block') {
      if (line === CRON_END) state = 'after';
      else raw.push(line);
    } else {
      if (line === CRON_BEGIN) problems.push('Your crontab has two devmagic-panel blocks: run crontab -e and keep one');
      after.push(line);
    }
  }
  if (state === 'block') problems.push('Your crontab has the devmagic-panel BEGIN line without its END line: run crontab -e and fix it');
  if (!found) return { before, block: null, after, problems };

  const titles = new Map<string, string>();
  for (const line of raw) {
    const m = /^# task ([a-z0-9]{6}): (.*)$/.exec(line);
    if (m) titles.set(m[1] as string, m[2] as string);
  }
  const block: BlockEntry[] = [];
  const ids = new Set<string>();
  for (const line of raw) {
    if (/^# task [a-z0-9]{6}: /.test(line) || line.trim() === '') continue;
    const task = readTaskLine(line, titles);
    if (task && !ids.has(task.id)) {
      ids.add(task.id);
      block.push({ kind: 'task', task });
    } else block.push({ kind: 'other', text: line });
  }
  return { before, block, after, problems };
}

export const tasksOf = (parsed: ParsedCrontab): PanelTask[] => (parsed.block ?? []).flatMap((e) => (e.kind === 'task' ? [e.task] : []));
/** Lines in the block the panel cannot read: kept, never rewritten. */
export const unreadableOf = (parsed: ParsedCrontab): string[] => (parsed.block ?? []).flatMap((e) => (e.kind === 'other' ? [e.text] : []));

/**
 * The crontab with the block made of these tasks, in this order; lines in
 * the block the panel cannot read stay. Everything outside the block is
 * kept line for line. An empty block goes.
 */
export function renderCrontab(parsed: ParsedCrontab, tasks: PanelTask[], command: CronCommand): string {
  const others = unreadableOf(parsed);
  const body = [...tasks.flatMap((t) => renderTask(command, t)), ...others];
  const out = [...parsed.before];
  if (body.length > 0) {
    // A new block goes at the end, after one blank line.
    if (parsed.block === null && out.length > 0 && out.at(-1) !== '') out.push('');
    out.push(CRON_BEGIN, ...body, CRON_END);
  }
  out.push(...parsed.after);
  // crontab wants the last line to end with a newline.
  return out.length ? `${out.join('\n')}\n` : '';
}

// ── reading and writing the crontab ──────────────────────────

/** The user's crontab; empty when there is none yet. */
export async function readCrontab(exec: Executor): Promise<string> {
  const r = await exec('crontab', ['-l']);
  if (r.code === 0) return r.stdout;
  if (/no crontab for/i.test(r.stderr)) return '';
  throw new CronRefused(cronError(r));
}

const cronError = (r: ExecResult) => {
  const text = (r.stderr || r.stdout).trim();
  if (/not allowed/i.test(text)) return `cron does not let this account have a crontab (/etc/cron.allow or /etc/cron.deny): ${text}`;
  if (r.code === 127) return 'crontab is not installed: install it with sudo apt install cron';
  return text || `crontab exited with ${r.code}`;
};

/** A stamp for saved copies: date, time and milliseconds, so two changes in a second do not meet. */
export function backupStamp(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
}

/**
 * Saves text into the panel's backups folder, readable by you alone, as
 * <prefix>-<stamp>.<ext>; two in the same millisecond get the next one.
 * Answers with its name.
 */
export function saveBackup(config: SystemConfig, prefix: string, ext: 'txt' | 'json', text: string, now = new Date()): string {
  mkdirSync(config.BACKUP_DIR, { recursive: true, mode: 0o700 });
  for (let ms = 0; ; ms++) {
    const name = `${prefix}-${backupStamp(new Date(now.getTime() + ms))}.${ext}`;
    const file = join(config.BACKUP_DIR, name);
    try {
      writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && ms < 1000) continue;
      throw error;
    }
    chmodSync(file, 0o600);
    return name;
  }
}

export function readBackup(config: SystemConfig, name: string): string {
  const file = join(config.BACKUP_DIR, basename(name));
  if (!existsSync(file)) throw new CronRefused(`the saved copy ${name} is gone: copies are kept 14 days`);
  return readFileSync(file, 'utf8');
}

export interface CronContext {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  command: CronCommand;
  /** /etc, or a temp tree in tests. */
  etcDir?: string;
  now?: () => Date;
}

export interface CronChange {
  results: ExecResult[];
  /** The saved copy of the crontab from before the change, for Undo. */
  backup: string;
}

/**
 * Reads the crontab, changes the panel's tasks, saves what was there and
 * writes the new crontab, unless it changed in the meantime.
 */
export async function changeCrontab(ctx: CronContext, change: (tasks: PanelTask[], parsed: ParsedCrontab) => PanelTask[] | { parsed: ParsedCrontab; tasks: PanelTask[] }, say: string): Promise<CronChange> {
  const text = await readCrontab(ctx.exec);
  const parsed = parseCrontab(text);
  if (parsed.problems.length) throw new CronRefused(parsed.problems.join('; '));
  const outcome = change(tasksOf(parsed), parsed);
  const next = Array.isArray(outcome) ? { parsed, tasks: outcome } : outcome;
  const written = renderCrontab(next.parsed, next.tasks, ctx.command);
  const backup = saveBackup(ctx.config, 'crontab', 'txt', text, ctx.now?.() ?? new Date());
  // Someone may have run crontab -e meanwhile: their change wins, the panel asks you to check again.
  if ((await readCrontab(ctx.exec)) !== text) throw new CronRefused('Your crontab changed while the panel was changing it: check again and repeat');
  const r = await ctx.exec('crontab', ['-'], { input: written });
  if (r.code !== 0) return { results: [{ ...r, stderr: cronError(r) }], backup };
  return { results: [{ code: 0, stdout: say, stderr: '' }], backup };
}

/** A new task id, unlike the ones in use. */
export function newTaskId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = [...randomBytes(6)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    if (!used.has(id)) return id;
  }
}

/** The task with this id, or why not. */
export function findTask(tasks: PanelTask[], id: string): PanelTask {
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new CronRefused(`your crontab has no task ${id} of the panel; check again`);
  return task;
}

/** Puts the block back from a saved copy; lines outside it stay as they are now. */
export async function undoCrontab(ctx: CronContext, backup: string): Promise<CronChange> {
  const saved = parseCrontab(readBackup(ctx.config, backup));
  return changeCrontab(ctx, (_tasks, current) => ({ parsed: { ...current, block: (saved.block ?? []).filter((e) => e.kind === 'other') }, tasks: tasksOf(saved) }), `put the panel's tasks back as they were before ${backup}`);
}

// ── the report the page reads ────────────────────────────────

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

/** The site a task runs for. */
export const taskSite = (task: CronTask) => ('domain' in task ? { domain: task.domain, ...(task.path ? { path: task.path } : {}) } : undefined);

/** Why a task cannot run as it is, read without running it. */
export function taskProblem(config: SystemConfig, task: CronTask): string | undefined {
  try {
    if ('domain' in task) {
      const site = siteFor(config, task.domain, task.path);
      if (task.kind === 'php-script' && !existsSync(join(site.docroot, task.file))) return `${task.file} is not in ${site.host}`;
    }
    if (task.kind === 'program') {
      accessSync(task.program, constants.X_OK);
      if (!statSync(task.program).isFile()) return `${task.program} is not a file`;
    }
  } catch (error) {
    return task.kind === 'program' ? `${task.program} is missing or not executable` : (error as Error).message;
  }
  return undefined;
}

export function taskView(ctx: Pick<CronContext, 'config' | 'store' | 'now'>, t: PanelTask, last = ctx.store.lastCronRuns()): CronTaskView {
  const now = ctx.now?.() ?? new Date();
  const site = taskSite(t.task);
  const problem = taskProblem(ctx.config, t.task);
  const run = last.get(t.id);
  return {
    id: t.id,
    title: t.title,
    schedule: t.schedule,
    describe: describeSchedule(t.schedule),
    enabled: t.enabled,
    timeoutMinutes: t.timeoutMinutes,
    task: t.task,
    ...(site ? { site } : {}),
    next: t.enabled ? iso(nextRuns(t.schedule, now, 3)) : [],
    ...(run ? { last: run } : {}),
    ...(problem ? { problem } : {}),
  };
}

const isEnvLine = (line: string) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line);
const isCommentOrBlank = (line: string) => line.trim() === '' || line.trim().startsWith('#');

/** Lines of the user's crontab outside the block: entries only, with their schedule. */
export function handLines(parsed: ParsedCrontab, now: Date): CronHandLine[] {
  const lines: CronHandLine[] = [];
  const all: Array<[string, number]> = [...parsed.before.map((l, i) => [l, i + 1] as [string, number])];
  const offset = parsed.before.length + (parsed.block ? (parsed.block.length + 2) : 0);
  all.push(...parsed.after.map((l, i) => [l, offset + i + 1] as [string, number]));
  for (const [text, line] of all) {
    if (isCommentOrBlank(text) || isEnvLine(text)) continue;
    const entry = splitEntry(text);
    if (!entry) continue;
    lines.push({ line, schedule: entry.schedule, describe: describeSchedule(entry.schedule), command: entry.rest, next: iso(nextRuns(entry.schedule, now, 3)) });
  }
  return lines;
}

/** /etc/crontab and /etc/cron.d: entries with a user field. */
export function systemCron(etc: string): CronReport['system'] {
  const files: CronSystemFile[] = [];
  const read = (file: string) => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').flatMap((l) => {
      if (isCommentOrBlank(l) || isEnvLine(l)) return [];
      const entry = splitEntry(l);
      if (!entry) return [];
      const m = /^(\S+)\s+(.*)$/.exec(entry.rest);
      return m ? [{ schedule: entry.schedule, describe: describeSchedule(entry.schedule), user: m[1] as string, command: m[2] as string }] : [];
    });
    files.push({ file, lines });
  };
  read(join(etc, 'crontab'));
  const d = join(etc, 'cron.d');
  if (existsSync(d)) for (const name of readdirSync(d).sort()) if (!name.startsWith('.') && !name.includes('~')) read(join(d, name));
  const folders = ['hourly', 'daily', 'weekly', 'monthly'].flatMap((every) => {
    const dir = join(etc, `cron.${every}`);
    if (!existsSync(dir)) return [];
    return [{ folder: dir, scripts: readdirSync(dir).filter((n) => !n.startsWith('.')).sort() }];
  });
  return { files, folders, timers: [] };
}

const usecIso = (usec: unknown) => (typeof usec === 'number' && usec > 0 ? new Date(usec / 1000).toISOString() : undefined);

/** The machine's systemd timers, from systemctl's JSON; none where it has no JSON output. */
export async function systemTimers(exec: Executor): Promise<CronTimer[]> {
  const r = await exec('systemctl', ['list-timers', '--all', '--output=json']);
  if (r.code !== 0) return [];
  try {
    const list = JSON.parse(r.stdout) as Array<{ unit?: string; activates?: string; next?: number; last?: number }>;
    return list
      .filter((t) => typeof t.unit === 'string')
      .map((t) => {
        const next = usecIso(t.next);
        const last = usecIso(t.last);
        return { unit: t.unit as string, activates: t.activates ?? '', ...(next ? { next } : {}), ...(last ? { last } : {}) };
      });
  } catch {
    return [];
  }
}

export async function cronReport(ctx: CronContext): Promise<CronReport> {
  const now = ctx.now?.() ?? new Date();
  const [daemon, timers] = await Promise.all([unitState(ctx.exec, 'cron'), systemTimers(ctx.exec)]);
  const system = { ...systemCron(ctx.etcDir ?? '/etc'), timers };
  const base = { checkedAt: now.toISOString(), daemon, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, system };
  let text: string;
  try {
    text = await readCrontab(ctx.exec);
  } catch (error) {
    return { ...base, allowed: false, tasks: [], hand: [], unreadable: [], problems: [(error as Error).message] };
  }
  const parsed = parseCrontab(text);
  const last = ctx.store.lastCronRuns();
  const tasks = tasksOf(parsed);
  ctx.store.pruneCronRuns(now.getTime(), tasks.map((t) => t.id));
  return { ...base, allowed: true, tasks: tasks.map((t) => taskView(ctx, t, last)), hand: handLines(parsed, now), unreadable: unreadableOf(parsed), problems: parsed.problems };
}

/** The node and cli.js the panel's lines call: the stable links, so an update or a new Node keeps every line working. */
export function cronCommand(execPath: string, dataDir: string, cli: string): CronCommand {
  const own = join(dataDir, 'node');
  const node = execPath.startsWith(`${own}/`) ? join(own, 'current', 'bin', 'node') : execPath;
  return { node, cli };
}

/** Where the runner keeps one lock file per task while it runs. */
export const cronLockDir = (dataDir: string) => join(dataDir, 'cron');
/** The runner's own failures, which cron would otherwise mail. */
export const cronLogFile = (dataDir: string) => join(dataDir, 'cron.log');

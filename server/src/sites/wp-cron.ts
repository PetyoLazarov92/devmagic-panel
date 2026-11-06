import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CronTask, WpCronEvent, WpCronReport } from '@devmagic-panel/shared';
import { WP_CORE_HOOKS, WP_CRON_LATE_SECONDS } from '@devmagic-panel/shared';
import { type CronChange, type CronContext, changeCrontab, CronRefused, newTaskId, readBackup, readCrontab, parseCrontab, saveBackup, taskView, tasksOf } from '../cron.js';
import type { ExecResult, Executor } from '../exec.js';
import { wpCommand } from '../php/pools.js';
import { SiteActionRefused, type SiteRef } from './site-actions.js';

/**
 * A site's WP-Cron, read and changed through WP-CLI, so nothing goes into
 * the site. Deleting one event and putting it back run fixed PHP through
 * `wp eval-file -` on stdin; the event's time, hook and signature arrive in
 * $args, the saved event in an environment variable, never in the code.
 */

/** Removes exactly one event and prints it, serialized and in base64, for Undo. */
const DELETE_PHP = `<?php
$dmp_cron = _get_cron_array();
$dmp_time = (int) ( $args[0] ?? 0 );
$dmp_hook = (string) ( $args[1] ?? '' );
$dmp_sig  = (string) ( $args[2] ?? '' );
if ( ! is_array( $dmp_cron ) || ! isset( $dmp_cron[ $dmp_time ][ $dmp_hook ][ $dmp_sig ] ) ) {
	WP_CLI::error( 'this event is not scheduled any more: it may have run or been changed' );
}
$dmp_event = $dmp_cron[ $dmp_time ][ $dmp_hook ][ $dmp_sig ];
unset( $dmp_cron[ $dmp_time ][ $dmp_hook ][ $dmp_sig ] );
if ( empty( $dmp_cron[ $dmp_time ][ $dmp_hook ] ) ) {
	unset( $dmp_cron[ $dmp_time ][ $dmp_hook ] );
}
if ( empty( $dmp_cron[ $dmp_time ] ) ) {
	unset( $dmp_cron[ $dmp_time ] );
}
_set_cron_array( $dmp_cron );
echo base64_encode( serialize( $dmp_event ) );
`;

/** Puts one saved event back, next to the events there now. */
const RESTORE_PHP = `<?php
$dmp_cron = _get_cron_array();
if ( ! is_array( $dmp_cron ) ) {
	$dmp_cron = array();
}
$dmp_time  = (int) ( $args[0] ?? 0 );
$dmp_hook  = (string) ( $args[1] ?? '' );
$dmp_sig   = (string) ( $args[2] ?? '' );
$dmp_event = unserialize( base64_decode( (string) getenv( 'DMP_WPCRON_EVENT' ) ) );
if ( ! is_array( $dmp_event ) ) {
	WP_CLI::error( 'the saved event cannot be read' );
}
if ( isset( $dmp_cron[ $dmp_time ][ $dmp_hook ][ $dmp_sig ] ) ) {
	echo 'already there';
	return;
}
$dmp_cron[ $dmp_time ][ $dmp_hook ][ $dmp_sig ] = $dmp_event;
ksort( $dmp_cron );
_set_cron_array( $dmp_cron );
echo 'put back';
`;

/** --url for the site, or for a network site you picked. */
const urlOf = (site: SiteRef, url?: string) => url ?? `https://${site.host}/`;

function wp(exec: Executor, site: SiteRef, args: string[], options: { url?: string; input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ExecResult> {
  const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=${urlOf(site, options.url)}`, ...args]);
  return exec(cmd.file, cmd.args, {
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(cmd.env || options.env ? { env: { ...cmd.env, ...options.env } } : {}),
  });
}

/** The last line of what WP-CLI said, for a short reason. */
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';

/** JSON on the last line of WP-CLI's output: a plugin's notice may come before it. */
function lastJson<T>(r: ExecResult): T | null {
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

interface RawEvent {
  hook?: unknown;
  time?: unknown;
  schedule?: unknown;
  interval?: unknown;
  args?: unknown;
  sig?: unknown;
}

export function parseEvents(rows: RawEvent[], now: number): WpCronEvent[] {
  return rows
    .filter((e) => typeof e.hook === 'string' && typeof e.sig === 'string')
    .map((e) => {
      const time = Number(e.time) || 0;
      const hook = e.hook as string;
      return {
        hook,
        time,
        recurrence: typeof e.schedule === 'string' ? e.schedule : '',
        interval: typeof e.interval === 'number' && e.interval > 0 ? e.interval : null,
        args: Array.isArray(e.args) ? e.args : e.args && typeof e.args === 'object' ? Object.values(e.args) : [],
        sig: e.sig as string,
        overdue: time > 0 && time < now / 1000 - WP_CRON_LATE_SECONDS,
        core: (WP_CORE_HOOKS as readonly string[]).includes(hook),
      };
    })
    .sort((a, b) => a.time - b.time);
}

const siteMatches = (task: CronTask, site: SiteRef) => 'domain' in task && task.domain === site.domain && (task.path ?? undefined) === (site.path ?? undefined);

/** Whether git tracks wp-config.php, so a constant set shows in git status. */
async function configTracked(exec: Executor, site: SiteRef): Promise<boolean> {
  if (!existsSync(join(site.docroot, 'wp-config.php'))) return false;
  const r = await exec('git', ['-C', site.docroot, 'ls-files', '--error-unmatch', '--', 'wp-config.php']);
  return r.code === 0;
}

const constantIs = (site: SiteRef, name: string) => site.wp.constants.some((c) => c.name === name && c.value === true);

/** Everything the site's Cron tab shows. */
export async function readWpCron(ctx: CronContext, site: SiteRef, url?: string): Promise<WpCronReport> {
  const now = ctx.now?.() ?? new Date();
  // Plugins stay off for the events: they are read from the option as stored. The intervals need them, plugins add those.
  const [events, schedules, tracked] = await Promise.all([
    wp(ctx.exec, site, ['cron', 'event', 'list', '--fields=hook,time,schedule,interval,args,sig', '--format=json', '--skip-plugins', '--skip-themes'], { ...(url ? { url } : {}) }),
    wp(ctx.exec, site, ['cron', 'schedule', 'list', '--fields=name,display,interval', '--format=json'], { ...(url ? { url } : {}) }),
    configTracked(ctx.exec, site),
  ]);
  if (events.code !== 0) throw new SiteActionRefused(`WP-CLI could not list the WP-Cron events: ${lastLine(events)}`);
  const list = parseEvents(lastJson<RawEvent[]>(events) ?? [], now.getTime());
  const raw = lastJson<Array<{ name?: unknown; display?: unknown; interval?: unknown }>>(schedules) ?? [];
  let tasks: WpCronReport['tasks'] = [];
  try {
    const last = ctx.store.lastCronRuns();
    tasks = tasksOf(parseCrontab(await readCrontab(ctx.exec))).filter((t) => siteMatches(t.task, site)).map((t) => taskView(ctx, t, last));
  } catch {
    // No crontab for this account: the tab still shows the events.
  }
  const task = tasks.find((t) => t.task.kind === 'wp-cron');
  return {
    events: list,
    schedules: raw
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({ name: s.name as string, display: typeof s.display === 'string' ? s.display : (s.name as string), interval: Number(s.interval) || 0 }))
      .sort((a, b) => a.interval - b.interval),
    disabled: constantIs(site, 'DISABLE_WP_CRON'),
    alternate: constantIs(site, 'ALTERNATE_WP_CRON'),
    ...(task ? { task } : {}),
    tasks: tasks.filter((t) => t !== task),
    overdue: list.filter((e) => e.overdue).length,
    configTracked: tracked,
    ...(url ? { url } : {}),
  };
}

/** wp cron test: whether WordPress can start WP-Cron by itself, through its loopback request. */
export async function testWpCron(exec: Executor, site: SiteRef, url?: string): Promise<{ ok: boolean; output: string }> {
  const r = await wp(exec, site, ['cron', 'test'], { ...(url ? { url } : {}), timeoutMs: 60_000 });
  return { ok: r.code === 0, output: [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n') };
}

export async function runWpCronHook(exec: Executor, site: SiteRef, hook: string, url?: string): Promise<ExecResult[]> {
  return [await wp(exec, site, ['cron', 'event', 'run', hook], { ...(url ? { url } : {}), timeoutMs: 10 * 60_000 })];
}

/** The name a site's saved WP-Cron event goes under in the backups folder. */
const backupLabel = (site: SiteRef) => `wp-cron-${`${site.domain}${site.path ? `-${site.path.slice(1)}` : ''}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`;

interface SavedEvent {
  domain: string;
  path?: string;
  url?: string;
  time: number;
  hook: string;
  sig: string;
  /** The event as WordPress keeps it, serialized, in base64. */
  event: string;
}

export async function deleteWpCronEvent(ctx: CronContext, site: SiteRef, input: { hook: string; time: number; sig: string; url?: string }): Promise<{ results: ExecResult[]; backup?: string }> {
  const r = await wp(ctx.exec, site, ['eval-file', '-', String(input.time), input.hook, input.sig, '--skip-plugins', '--skip-themes'], { input: DELETE_PHP, ...(input.url ? { url: input.url } : {}) });
  if (r.code !== 0) return { results: [{ ...r, stderr: lastLine(r) }] };
  const event = r.stdout.trim().split('\n').at(-1) ?? '';
  if (!/^[A-Za-z0-9+/=]+$/.test(event)) return { results: [{ code: 1, stdout: '', stderr: 'WP-CLI did not say what it removed' }] };
  const saved: SavedEvent = { domain: site.domain, ...(site.path ? { path: site.path } : {}), ...(input.url ? { url: input.url } : {}), time: input.time, hook: input.hook, sig: input.sig, event };
  const backup = saveBackup(ctx.config, backupLabel(site), 'json', JSON.stringify(saved), ctx.now?.() ?? new Date());
  return { results: [{ code: 0, stdout: `deleted the event ${input.hook} of ${new Date(input.time * 1000).toISOString()}`, stderr: '' }], backup };
}

export async function restoreWpCronEvent(ctx: CronContext, site: SiteRef, backup: string, url?: string): Promise<ExecResult[]> {
  let saved: SavedEvent;
  try {
    saved = JSON.parse(readBackup(ctx.config, backup)) as SavedEvent;
  } catch (error) {
    throw error instanceof CronRefused ? error : new CronRefused(`the saved copy ${backup} cannot be read`);
  }
  if (saved.domain !== site.domain || (saved.path ?? undefined) !== (site.path ?? undefined)) throw new CronRefused(`${backup} is an event of another site`);
  const r = await wp(ctx.exec, site, ['eval-file', '-', String(saved.time), saved.hook, saved.sig, '--skip-plugins', '--skip-themes'], {
    input: RESTORE_PHP,
    env: { DMP_WPCRON_EVENT: saved.event },
    ...((url ?? saved.url) ? { url: (url ?? saved.url) as string } : {}),
  });
  return [r.code === 0 ? { code: 0, stdout: `${saved.hook}: ${lastLine(r)}`, stderr: '' } : { ...r, stderr: lastLine(r) }];
}

/**
 * Runs the site's WP-Cron from cron (on), or from page loads again (off):
 * the wp-cron task and DISABLE_WP_CRON change together.
 */
export async function setSiteWpCron(ctx: CronContext, site: SiteRef, fromCron: boolean, schedule: string): Promise<{ results: ExecResult[]; backup: string }> {
  const change: CronChange = await changeCrontab(
    ctx,
    (tasks) => {
      const others = tasks.filter((t) => !(t.task.kind === 'wp-cron' && siteMatches(t.task, site)));
      if (!fromCron) return others;
      const had = tasks.find((t) => t.task.kind === 'wp-cron' && siteMatches(t.task, site));
      const task: CronTask = { kind: 'wp-cron', domain: site.domain, ...(site.path ? { path: site.path } : {}) };
      return [...others, { id: had?.id ?? newTaskId(tasks.map((t) => t.id)), title: had?.title ?? `WP-Cron for ${site.host}`, schedule, enabled: true, timeoutMinutes: had?.timeoutMinutes ?? 10, task }];
    },
    fromCron ? `cron runs the WP-Cron of ${site.host}: ${schedule}` : `cron no longer runs the WP-Cron of ${site.host}`,
  );
  if (change.results.some((r) => r.code !== 0)) return { results: change.results, backup: change.backup };
  const has = constantIs(site, 'DISABLE_WP_CRON');
  const defined = site.wp.constants.some((c) => c.name === 'DISABLE_WP_CRON');
  let constant: ExecResult;
  if (fromCron) {
    constant = has ? { code: 0, stdout: 'wp-config.php has DISABLE_WP_CRON true already', stderr: '' } : await wp(ctx.exec, site, ['config', 'set', 'DISABLE_WP_CRON', 'true', '--raw', '--type=constant']);
  } else {
    constant = defined ? await wp(ctx.exec, site, ['config', 'delete', 'DISABLE_WP_CRON', '--type=constant']) : { code: 0, stdout: 'wp-config.php has no DISABLE_WP_CRON', stderr: '' };
  }
  return { results: [...change.results, constant], backup: change.backup };
}

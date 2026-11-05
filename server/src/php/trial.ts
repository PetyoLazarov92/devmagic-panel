import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogLine } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { debugLogPath, findVhost } from '../sites/discover.js';
import { parseApacheErrorLog, parseDebugLog } from '../sites/logs.js';
import { loginLink, type SiteRef } from '../sites/site-actions.js';

/**
 * The trial run after a site's PHP switch: what a scan cannot see (code that
 * only runs at run time, a missing module) shows in the error logs. The sizes
 * of the site's Apache error log and debug.log are noted before the switch;
 * afterwards the home page and wp-admin (signed in) are opened and only the
 * lines written since are read.
 */

/** A log and how big it was before the switch. */
export interface LogMark {
  kind: 'apache' | 'debug';
  file: string;
  size: number;
  /** For a log other sites write to as well: the lines that are this site's. */
  keep?: (line: string) => boolean;
}

const sizeOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** The site's Apache error log (filtered when it is shared) and its debug.log, as they are now. */
export function markLogs(config: SystemConfig, site: SiteRef): LogMark[] {
  const marks: LogMark[] = [];
  const vhost = findVhost(config, site.domain);
  const apache = vhost?.errorLog ?? join(config.APACHE_LOG_DIR, 'error.log');
  const shared = site.path !== undefined || !site.names.some((n) => apache.includes(n));
  marks.push({
    kind: 'apache',
    file: apache,
    size: sizeOf(apache),
    ...(shared ? { keep: (line: string) => line.includes(site.docroot) || (site.path === undefined && site.names.some((n) => line.includes(n))) } : {}),
  });
  const debug = debugLogPath(site.docroot, site.wp);
  marks.push({ kind: 'debug', file: debug, size: sizeOf(debug) });
  return marks;
}

/** At most this much of what a log got since the mark is read. */
const READ_LIMIT = 2 * 1024 * 1024;

/** What a log got since its mark; from the start when it was rotated (it is smaller now). */
function since(mark: LogMark): string {
  if (!existsSync(mark.file)) return '';
  const fd = openSync(mark.file, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = size < mark.size ? 0 : mark.size;
    const length = Math.min(size - from, READ_LIMIT);
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, from);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** The lines the site's logs got since the marks, oldest first. */
export function newLogLines(marks: LogMark[]): LogLine[] {
  return marks.flatMap((m) => (m.kind === 'apache' ? parseApacheErrorLog(since(m), m.keep, 2000) : parseDebugLog(since(m), 2000)).reverse());
}

export interface TrialContext {
  config: SystemConfig;
  exec: Executor;
}

/** One page as a browser would load it: through Apache on this machine, with the panel's CA. */
async function visit(ctx: TrialContext, site: SiteRef, url: string, jar?: string): Promise<{ status: number; error?: string }> {
  const r = await ctx.exec('curl', [
    '-sS', '--max-time', '60', '--noproxy', '*', '--cacert', join(ctx.config.CA_DIR, 'ca.pem'),
    '--resolve', `${site.domain}:443:127.0.0.1`,
    ...(jar ? ['-L', '--max-redirs', '5', '-c', jar, '-b', jar] : []),
    '-o', '/dev/null', '-w', '%{http_code}', url,
  ], { timeoutMs: 70_000 });
  const status = Number(r.stdout.trim().split('\n').at(-1));
  if (r.code !== 0 || !status) return { status: 0, error: (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '' };
  return { status };
}

const LEVELS = ['fatal', 'warning', 'deprecated', 'notice'] as const;
type Level = (typeof LEVELS)[number];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The PHP messages in log lines, by what PHP calls them: PHP-FPM's reach
 * Apache's log as errors whatever they are, several in one line, so the level
 * comes from the message. Lines that are not PHP's (an SSL warning) are left out.
 */
export function phpMessages(lines: LogLine[]): Array<{ level: Level; message: string }> {
  const found: Array<{ level: Level; message: string }> = [];
  for (const line of lines) {
    for (const part of line.message.split('\n')) {
      const m = /^PHP (Fatal error|Parse error|Recoverable fatal error|Warning|Deprecated|Notice):/.exec(part.trim());
      // WP-CLI's own code (its phar) logs to the site's debug.log too: not the site's.
      if (!m || / in phar:\/\//.test(part)) continue;
      const kind = m[1] as string;
      const level: Level = kind === 'Warning' ? 'warning' : kind === 'Deprecated' ? 'deprecated' : kind === 'Notice' ? 'notice' : 'fatal';
      found.push({ level, message: part.trim() });
    }
  }
  return found;
}

/** The distinct messages, the most frequent first, with how often each came. */
function distinct(messages: Array<{ message: string }>): string[] {
  const counts = new Map<string, number>();
  for (const { message } of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m));
}

/**
 * Opens the home page, wp-login.php and wp-admin signed in (through the
 * one-time login helper), then reads what the logs got since the marks.
 * `pool` is the version of the site's pool after the switch, when it has one. A new
 * PHP fatal error or a page answering 500 fails the step; warnings and
 * deprecations are listed and the switch stays.
 */
export async function trialRun(ctx: TrialContext, site: SiteRef, version: string, marks: LogMark[], pool?: string): Promise<ExecResult> {
  const base = `https://${site.host}/`;
  const pages: string[] = [];
  const broken: string[] = [];
  const note = (name: string, r: { status: number; error?: string }) => {
    pages.push(`${name} ${r.status || 'no answer'}`);
    if (!r.status || r.status >= 500) broken.push(`${name} answered ${r.status || `nothing (${r.error})`}`);
  };
  note('home page', await visit(ctx, site, base));
  note('wp-login.php', await visit(ctx, site, `${base}wp-login.php`));
  // WP-CLI makes the login on the PHP the site runs now (its pool's, else the command line's), so what it logs is that version's.
  const { php: _old, ...rest } = site;
  const { link } = await loginLink(ctx, pool ? { ...rest, php: pool } : rest);
  if (link) {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-trial-'));
    try {
      note('wp-admin', await visit(ctx, site, link, join(dir, 'cookies')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    pages.push('wp-admin skipped (no one-time login: WP-CLI could not make one)');
  }

  const messages = phpMessages(newLogLines(marks));
  const of = (level: Level) => messages.filter((m) => m.level === level);
  const by = { fatal: of('fatal'), warning: of('warning'), deprecated: of('deprecated'), notice: of('notice') };
  const counts = LEVELS.filter((l) => by[l].length).map((l) => plural(by[l].length, l === 'fatal' ? 'fatal error' : l === 'deprecated' ? 'deprecation' : l));
  const summary = `Opened ${pages.join(', ')}. ${counts.length ? `New in the logs: ${counts.join(', ')}.` : 'No new PHP errors in the logs.'}`;
  const listed = [...distinct(by.warning), ...distinct(by.deprecated), ...distinct(by.notice)].slice(0, 8).map((m) => `  ${m}`);

  if (by.fatal.length || broken.length) {
    const fatals = distinct(by.fatal).slice(0, 5).map((m) => `  ${m}`);
    return {
      code: 1,
      stdout: [summary, ...listed].join('\n'),
      stderr: `${[...broken, ...(fatals.length ? [`PHP ${version} fatal errors:`, ...fatals] : [])].join('\n')}\nThe site stays on PHP ${version} so you can look; Undo puts it back.\n`,
    };
  }
  return { code: 0, stdout: [summary, ...listed].join('\n'), stderr: '' };
}

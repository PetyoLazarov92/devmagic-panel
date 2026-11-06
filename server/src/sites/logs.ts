import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import type { LogLine } from '@devmagic-panel/shared';

/** Reads at most the last `maxBytes` of a file, starting at a line boundary. */
export function tailFile(file: string, maxBytes = 256 * 1024): string {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function levelOf(message: string): LogLine['level'] {
  if (/PHP (Fatal|Parse) error|Uncaught/i.test(message)) return 'fatal';
  if (/PHP (Recoverable fatal )?error|WordPress database error|\berror\b/i.test(message)) return 'error';
  if (/PHP Warning|\bwarn\b/i.test(message)) return 'warning';
  if (/PHP Notice|\bnotice\b/i.test(message)) return 'notice';
  if (/PHP Deprecated/i.test(message)) return 'deprecated';
  return 'info';
}

const NGINX_LEVELS: Record<string, LogLine['level']> = { emerg: 'fatal', alert: 'fatal', crit: 'fatal', error: 'error', warn: 'warning', notice: 'notice', info: 'info', debug: 'info' };

/**
 * Parses nginx's error log, newest entry first: "2026/11/06 10:21:04 [error]
 * 1234#1234: *5 message", in the machine's local time. PHP's errors arrive as
 * "FastCGI sent in stderr", so their own level wins over nginx's.
 */
export function parseNginxErrorLog(text: string, limit = 500): LogLine[] {
  const entries: LogLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[([a-z]+)\] (?:\d+#\d+: )?(?:\*\d+ )?(.*)$/.exec(line);
    if (!m) {
      const last = entries.at(-1);
      if (last) last.message += `\n${line}`;
      continue;
    }
    const [, y, mo, d, h, mi, sec, level, message] = m as unknown as string[];
    const time = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)).toISOString();
    const php = /PHP message: PHP /.test(message as string) ? levelOf(message as string) : null;
    entries.push({ time, level: php ?? NGINX_LEVELS[level as string] ?? 'info', message: message as string });
  }
  return entries.reverse().slice(0, limit);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "23-Oct-2026 23:08:28 UTC" to ISO. */
function phpTime(stamp: string): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(stamp);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] as string);
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
}

/**
 * Parses debug.log, newest entry first. PHP writes stack traces as separate
 * timestamped lines ("PHP Stack trace:", "PHP   1. ..."); those are folded
 * into the entry above them.
 */
export function parseDebugLog(text: string, limit = 500): LogLine[] {
  const entries: LogLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\[([^\]]+)\] (.*)$/.exec(line);
    const time = m ? phpTime(m[1] as string) : null;
    const message = m && time ? (m[2] as string) : line;
    const last = entries.at(-1);
    const continuation = !time || /^PHP (Stack trace:|\s+\d+\.)/.test(message) || /^(#\d+ |\s+thrown in )/.test(message);
    if (continuation && last) {
      last.message += `\n${message}`;
      continue;
    }
    entries.push({ time: time ?? new Date(0).toISOString(), level: levelOf(message), message });
  }
  return entries.reverse().slice(0, limit);
}

/** "[Sat Oct 24 02:08:51.160447 2026] [php:error] ..." */
/**
 * A PHP-FPM error as Apache logs it, `AH01071: Got error 'PHP message: PHP Fatal error: ...'`,
 * as mod_php would have logged it: the PHP messages only, one per line.
 */
export function fromFpm(message: string): string {
  const inner = /^AH01071: Got error '(.*)'$/s.exec(message)?.[1];
  if (inner === undefined) return message;
  return inner.replace(/^PHP message: /, '').replace(/\\nPHP message: /g, '\n').replace(/\\n/g, '\n');
}

export function parseApacheErrorLog(text: string, filter?: (line: string) => boolean, limit = 500): LogLine[] {
  const entries: LogLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || (filter && !filter(line))) continue;
    const m = /^\[\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? (\d{4})\] \[([\w]+):(\w+)\](?: \[pid \d+(?::tid \d+)?\])?(?: \[client [^\]]+\])? ?(.*)$/.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[1] as string);
    // Apache writes local time without a zone; read it as local time.
    const time = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).toISOString();
    const severity = m[8] as string;
    const message = fromFpm((m[9] ?? '').replace(/, referer: \S+$/, ''));
    const level: LogLine['level'] = /PHP (Fatal|Parse)/.test(message)
      ? 'fatal'
      : ['emerg', 'alert', 'crit', 'error'].includes(severity)
        ? 'error'
        : severity === 'warn'
          ? 'warning'
          : severity === 'notice'
            ? 'notice'
            : levelOf(message);
    entries.push({ time, level, message, source: m[7] as string });
  }
  return entries.reverse().slice(0, limit);
}

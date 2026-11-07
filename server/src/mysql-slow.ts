import { createHash } from 'node:crypto';
import type { SlowQuery, SlowQueryReport } from '@devmagic-panel/shared';
import type { ExecResult } from './exec.js';
import { type BrowseContext, checkDatabase, flavor, parseJson, read } from './mysql-browse.js';
import { adminSql } from './mysql-cleanup.js';
import type { RowsContext } from './mysql-rows.js';
import { BrowseError, textLiteral } from './mysql-sql.js';

/**
 * Which queries cost the most time, per database. MySQL 8 counts every
 * statement by its shape in performance_schema, on by default, so nothing
 * needs switching on. Where that is off (MariaDB by default), the slow log
 * is read from its table, mysql.slow_log, and grouped here: the panel writes
 * log_output = FILE,TABLE with the slow log (dmp-root mysql-config-write).
 * Read only, through the admin account; samples hold real values, so they
 * go to the browser only.
 */

const TOP = 50;
/** The slow log rows read to group, newest first. */
const SLOW_LOG_ROWS = 5000;
const TEXT_MAX = 2000;
const SAMPLE_MAX = 4000;

/** Statements a site runs: what the list is about. SET, SHOW, BEGIN and the like are left out. */
const SITE_STATEMENT = /^\s*(?:\/\*.*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/is;
/** The panel's own reads (JSON_ARRAY rows, its connection mark) and MySQL's own schemas. */
const NOT_A_SITE = /JSON_ARRAY|dmp-connection|information_schema|performance_schema|`mysql`\s*\.|\bmysql\.slow_log\b/i;

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : 0) || 0;
const text = (v: unknown, max: number) => (typeof v === 'string' && v !== '' ? (v.length > max ? `${v.slice(0, max)}...` : v) : undefined);
const round = (ms: number) => Math.round(ms * 100) / 100;

/** MySQL's DATETIME, 2026-11-07 10:00:00.000000, as ISO; local time, as the server keeps it. */
function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * A query with its values as ?, the way MySQL's digest shows one, so the
 * same query with other values is counted once: strings, numbers and hex
 * become ?, a list in IN (...) and the rows of VALUES become one.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*.*?\*\//gs, ' ')
    .replace(/(?:--|#)[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '?')
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/(?<![\w$.`])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![\w$`])/gi, '?')
    .replace(/\s+/g, ' ')
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (...)')
    .replace(/\bVALUES\s*(\([^()]*\))(?:\s*,\s*\([^()]*\))*/gi, 'VALUES $1')
    .trim();
}

interface Vars {
  performanceSchema: boolean;
  slowLog: boolean;
  toTable: boolean;
  aboveSeconds: number;
}

async function variables(ctx: BrowseContext): Promise<Vars> {
  const [line] = await read(ctx, 'SELECT JSON_ARRAY(@@performance_schema, @@slow_query_log, @@log_output, @@long_query_time);\n');
  const [ps, slow, output, above] = parseJson(line ?? '[]');
  return { performanceSchema: num(ps) === 1, slowLog: num(slow) === 1, toTable: /TABLE/i.test(String(output ?? '')), aboveSeconds: num(above) };
}

const digestSql = (database: string | undefined, sample: boolean) => `SELECT JSON_ARRAY(SCHEMA_NAME, DIGEST, DIGEST_TEXT, ${sample ? 'QUERY_SAMPLE_TEXT' : 'NULL'}, COUNT_STAR, SUM_TIMER_WAIT / 1000000000, MAX_TIMER_WAIT / 1000000000, SUM_ROWS_EXAMINED, SUM_ROWS_SENT, SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED, LAST_SEEN, FIRST_SEEN)
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST IS NOT NULL AND SCHEMA_NAME IS NOT NULL AND SCHEMA_NAME NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')${database ? ` AND SCHEMA_NAME = ${textLiteral(database)}` : ''}
  AND DIGEST_TEXT REGEXP '^(SELECT|INSERT|UPDATE|DELETE|REPLACE)' AND DIGEST_TEXT NOT LIKE '%JSON_ARRAY%' AND DIGEST_TEXT NOT LIKE '%information_schema%' AND DIGEST_TEXT NOT LIKE '%performance_schema%'
ORDER BY SUM_TIMER_WAIT DESC LIMIT ${TOP};\n`;

async function fromStatements(ctx: BrowseContext, database: string | undefined): Promise<{ queries: SlowQuery[]; since?: string }> {
  let lines: string[];
  try {
    lines = await read(ctx, digestSql(database, true));
  } catch (error) {
    // QUERY_SAMPLE_TEXT is MySQL 8.0.3 and later.
    if (!(error instanceof BrowseError) || !/QUERY_SAMPLE_TEXT|Unknown column/i.test(error.message)) throw error;
    lines = await read(ctx, digestSql(database, false));
  }
  let since: string | undefined;
  const queries = lines.map((line): SlowQuery => {
    const [schema, digest, digestText, sample, count, totalMs, maxMs, examined, sent, noIndex, last, first] = parseJson(line);
    const firstSeen = iso(first);
    if (firstSeen && (!since || firstSeen < since)) since = firstSeen;
    const c = num(count);
    return {
      id: String(digest ?? ''),
      ...(typeof schema === 'string' ? { database: schema } : {}),
      text: text(digestText, TEXT_MAX) ?? '',
      ...(text(sample, SAMPLE_MAX) ? { sample: text(sample, SAMPLE_MAX) as string } : {}),
      count: c,
      totalMs: round(num(totalMs)),
      avgMs: round(num(totalMs) / Math.max(c, 1)),
      maxMs: round(num(maxMs)),
      rowsExamined: num(examined),
      rowsSent: num(sent),
      noIndex: num(noIndex),
      ...(iso(last) ? { lastSeen: iso(last) as string } : {}),
    };
  });
  return { queries, ...(since ? { since } : {}) };
}

/** The slow log's newest rows, grouped by their shape, the heaviest first. */
export function groupSlowLog(rows: unknown[][]): { queries: SlowQuery[]; since?: string } {
  const groups = new Map<string, SlowQuery>();
  let since: string | undefined;
  for (const [db, sqlText, seconds, examined, sent, start] of rows) {
    const sql = typeof sqlText === 'string' ? sqlText : '';
    if (!SITE_STATEMENT.test(sql) || NOT_A_SITE.test(sql)) continue;
    const shape = normalizeSql(sql);
    const database = typeof db === 'string' && db !== '' ? db : undefined;
    const id = createHash('sha1').update(`${database ?? ''}\n${shape}`).digest('hex').slice(0, 16);
    const ms = num(seconds) * 1000;
    const at = iso(start);
    if (at && (!since || at < since)) since = at;
    const g = groups.get(id);
    if (g) {
      g.count += 1;
      g.totalMs += ms;
      g.maxMs = Math.max(g.maxMs, ms);
      g.rowsExamined += num(examined);
      g.rowsSent += num(sent);
      if (at && (!g.lastSeen || at > g.lastSeen)) g.lastSeen = at;
    } else {
      groups.set(id, {
        id,
        ...(database ? { database } : {}),
        text: text(shape, TEXT_MAX) ?? '',
        ...(text(sql, SAMPLE_MAX) ? { sample: text(sql, SAMPLE_MAX) as string } : {}),
        count: 1,
        totalMs: ms,
        avgMs: 0,
        maxMs: ms,
        rowsExamined: num(examined),
        rowsSent: num(sent),
        ...(at ? { lastSeen: at } : {}),
      });
    }
  }
  const queries = [...groups.values()]
    .map((q) => ({ ...q, totalMs: round(q.totalMs), maxMs: round(q.maxMs), avgMs: round(q.totalMs / q.count) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, TOP);
  return { queries, ...(since ? { since } : {}) };
}

async function fromSlowLog(ctx: BrowseContext, database: string | undefined): Promise<{ queries: SlowQuery[]; since?: string }> {
  const lines = await read(
    ctx,
    `SELECT JSON_ARRAY(db, CONVERT(sql_text USING utf8mb4), HOUR(query_time) * 3600 + MINUTE(query_time) * 60 + SECOND(query_time) + MICROSECOND(query_time) / 1000000, rows_examined, rows_sent, start_time)
FROM mysql.slow_log${database ? ` WHERE db = ${textLiteral(database)}` : ''} ORDER BY start_time DESC LIMIT ${SLOW_LOG_ROWS};\n`,
  );
  return groupSlowLog(lines.map(parseJson));
}

/** The heaviest queries of one database, or of every site's when none is given. */
export async function slowQueries(ctx: BrowseContext, database?: string): Promise<SlowQueryReport> {
  if (database !== undefined) checkDatabase(database);
  const vars = await variables(ctx);
  const slowLog = { on: vars.slowLog, toTable: vars.toTable, aboveSeconds: vars.aboveSeconds };
  if (vars.performanceSchema && (await flavor(ctx)) === 'mysql') {
    return { source: 'statements', slowLog, ...(await fromStatements(ctx, database)) };
  }
  if (vars.slowLog && vars.toTable) {
    return { source: 'slowLog', slowLog, ...(await fromSlowLog(ctx, database)), note: `Only queries slower than ${vars.aboveSeconds} s are in the slow log.` };
  }
  return {
    source: 'none',
    slowLog,
    queries: [],
    note: vars.slowLog
      ? 'The slow log goes to a file only. Switch it off and on again on Services, MySQL so the panel writes it to its table too.'
      : 'MySQL keeps no statement statistics here. Switch on the slow log on Services, MySQL to count the slow queries.',
  };
}

/** Starts counting again: empties MySQL's statement statistics and the slow log table, the ones there are. */
export async function resetSlowQueries(ctx: RowsContext): Promise<ExecResult> {
  const vars = await variables(ctx);
  const done: string[] = [];
  if (vars.performanceSchema) {
    await adminSql(ctx, 'information_schema', 'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest;\n');
    done.push("MySQL's statement statistics");
  }
  if (vars.toTable) {
    await adminSql(ctx, 'information_schema', 'TRUNCATE TABLE mysql.slow_log;\n');
    done.push('the slow log table');
  }
  if (!done.length) return { code: 0, stdout: 'Nothing to empty: MySQL keeps no statement statistics and no slow log table here\n', stderr: '' };
  return { code: 0, stdout: `Emptied ${done.join(' and ')}: the counts start again now\n`, stderr: '' };
}

import type { DbQueryResult } from '@devmagic-panel/shared';
import { dbQuery } from '@devmagic-panel/shared';
import { READ_ONLY_MYSQL_USER } from './mysql-admin.js';
import { type BrowseContext, checkDatabase, flavor } from './mysql-browse.js';
import { BrowseError, textLiteral } from './mysql-sql.js';

/**
 * The SQL runner: one statement of yours, read only. Three locks, any one of
 * which would hold: the statement must be a kind that reads (SELECT, SHOW,
 * EXPLAIN...), it runs as devmagic_panel_ro, which MySQL lets do nothing but
 * SELECT and SHOW VIEW, and inside a read-only transaction. mysql runs with
 * --binary-mode, so a line like \! or source in the text is SQL, never a
 * client command. Rows stop at 1,000 and the output at 4 MB; a query over
 * the time limit is stopped on the server too.
 */

/** Statement kinds that only read. */
const READING = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'TABLE', 'VALUES']);
/** Kinds EXPLAIN takes. */
const EXPLAINABLE = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES']);

export const QUERY_ROWS = 1000;
const QUERY_LIMIT_MS = 30_000;
const QUERY_MAX_BYTES = 4 * 1024 * 1024;

export interface Statement {
  /** The statement without comments around it or a final semicolon. */
  text: string;
  /** Its first word, upper case, like SELECT. */
  kind: string;
  /** The statement with every string emptied and every comment a space: what MySQL reads as names and keywords. */
  code: string;
}

/**
 * Finds the one statement in the text: quotes, backticks and comments are
 * read the way MySQL reads them, so a semicolon inside a string does not
 * count. Refuses a second statement, a /*! comment MySQL would run, and a
 * backslash outside a string (the mysql client's own commands).
 */
export function oneStatement(sql: string, reading = true): Statement {
  let i = 0;
  let end = -1;
  let code = '';
  const n = sql.length;
  const at = (k: number) => sql[k] ?? '';
  while (i < n) {
    const c = at(i);
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (at(i) === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        if (at(i) === quote) {
          if (at(i + 1) === quote) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= n) throw new BrowseError(`A ${quote === '`' ? 'backtick' : 'quote'} is not closed`);
      i++;
      // A backticked name stays a name; a string's words are data, not names.
      if (end < 0) code += quote === '`' ? sql.slice(start, i) : "''";
      continue;
    }
    if (c === '#' || (c === '-' && at(i + 1) === '-' && (i + 2 >= n || /\s/.test(at(i + 2))))) {
      while (i < n && at(i) !== '\n') i++;
      if (end < 0) code += ' ';
      continue;
    }
    if (c === '/' && at(i + 1) === '*') {
      if (at(i + 2) === '!') throw new BrowseError('A /*! comment is code MySQL runs: write it as plain SQL');
      const close = sql.indexOf('*/', i + 2);
      if (close < 0) throw new BrowseError('A /* comment is not closed');
      i = close + 2;
      if (end < 0) code += ' ';
      continue;
    }
    if (c === '\\') throw new BrowseError('A backslash outside a string is a command of the mysql client, not SQL');
    if (c === ';') {
      if (end >= 0) throw new BrowseError('One statement at a time');
      end = i;
      i++;
      continue;
    }
    if (end >= 0 && !/\s/.test(c)) throw new BrowseError('One statement at a time');
    if (end < 0) code += c;
    i++;
  }
  const text = (end >= 0 ? sql.slice(0, end) : sql).trim();
  const words = stripLeading(text);
  const kind = (/^[A-Za-z]+/.exec(words)?.[0] ?? '').toUpperCase();
  if (!text || !kind) throw new BrowseError('Write a statement, like SELECT * FROM wp_options LIMIT 10');
  if (reading && !READING.has(kind)) throw new BrowseError(`${kind} changes or does not read: the SQL runner runs SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE and VALUES`);
  return { text, kind, code: code.trim() };
}

/** The text after leading comments, spaces and opening parentheses, where the first word is. */
function stripLeading(text: string): string {
  let rest = text;
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, '').replace(/^\(+/, '');
    if (rest.startsWith('#') || /^--(\s|$)/.test(rest)) rest = rest.slice(rest.indexOf('\n') < 0 ? rest.length : rest.indexOf('\n'));
    if (rest.startsWith('/*')) rest = rest.slice(rest.indexOf('*/') + 2);
    if (rest === before) return rest;
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });

/**
 * The result sets mysql --xml printed. NULL is xsi:nil, so it never reads as
 * the text NULL; fields come in order, so two columns of one name both stay.
 */
export function parseMysqlXml(xml: string): Array<{ columns: string[]; rows: Array<Array<string | null>> }> {
  const sets: Array<{ columns: string[]; rows: Array<Array<string | null>> }> = [];
  for (const set of xml.matchAll(/<resultset\b[^>]*?(?:\/>|>([\s\S]*?)<\/resultset>)/g)) {
    const body = set[1] ?? '';
    const columns: string[] = [];
    const rows: Array<Array<string | null>> = [];
    for (const row of body.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
      const fields = [...(row[1] ?? '').matchAll(/<field name="([^"]*)"(\s+xsi:nil="true"\s*\/>|\s*\/>|>([\s\S]*?)<\/field>)/g)];
      if (rows.length === 0) for (const f of fields) columns.push(decode(f[1] ?? ''));
      rows.push(fields.map((f) => ((f[2] ?? '').includes('xsi:nil') ? null : decode(f[3] ?? ''))));
    }
    sets.push({ columns, rows });
  }
  return sets;
}

/** Stops the read-only account's queries that ran past the limit, with the admin account; mysql exiting does not stop them on the server. */
async function stopLeftovers(ctx: BrowseContext, seconds: number): Promise<void> {
  const admin = ctx.mysql;
  if (!admin) return;
  const env = { MYSQL_PWD: admin.password };
  const base = ['--batch', '--skip-column-names', '--user', admin.user, '--host', admin.host];
  const list = await ctx.exec('mysql', base, {
    env,
    input: `SELECT ID FROM information_schema.PROCESSLIST WHERE USER = ${textLiteral(READ_ONLY_MYSQL_USER)} AND COMMAND = 'Query' AND TIME >= ${Math.max(1, seconds - 2)};\n`,
    timeoutMs: 10_000,
  });
  const ids = list.stdout.split('\n').filter((id) => /^\d+$/.test(id));
  if (ids.length) await ctx.exec('mysql', base, { env, input: ids.map((id) => `KILL QUERY ${id};`).join('\n'), timeoutMs: 10_000 });
}

/** MySQL's own words for an error, without the line number of the panel's preamble. */
const mysqlError = (stderr: string) => (stderr.trim().split('\n').find((l) => l.startsWith('ERROR')) ?? stderr.trim().split('\n')[0] ?? 'MySQL refused the query').replace(/ at line \d+/, '');

export async function runQuery(ctx: BrowseContext, database: string, body: unknown, now = () => Date.now()): Promise<DbQueryResult> {
  const parsed = dbQuery.safeParse(body ?? {});
  if (!parsed.success) throw new BrowseError(parsed.error.issues[0]?.message ?? 'Invalid request');
  const db = checkDatabase(database);
  const account = ctx.readOnly;
  if (!account) throw new BrowseError('The SQL runner reads with its own read-only MySQL account, which is not made yet', 409);
  const statement = oneStatement(parsed.data.sql);
  if (parsed.data.explain && !EXPLAINABLE.has(statement.kind)) throw new BrowseError('Explain works on SELECT, WITH, TABLE and VALUES');
  const text = parsed.data.explain ? `EXPLAIN ${statement.text}` : statement.text;
  const limit = (await flavor(ctx)) === 'mariadb' ? `SET SESSION max_statement_time = ${QUERY_LIMIT_MS / 1000};` : `SET SESSION max_execution_time = ${QUERY_LIMIT_MS};`;
  // The semicolon on a line of its own: a statement that ends in a -- comment would hide it.
  const input = `SET SESSION TRANSACTION READ ONLY;\n${limit}\nSET SESSION sql_select_limit = ${QUERY_ROWS + 1};\n${text}\n;\n`;

  const started = now();
  const r = await ctx.exec('mysql', ['--xml', '--binary-mode', '--default-character-set=utf8mb4', '--user', account.user, '--host', account.host, `--database=${db}`], {
    env: { MYSQL_PWD: account.password },
    input,
    timeoutMs: QUERY_LIMIT_MS + 5_000,
    maxBufferBytes: QUERY_MAX_BYTES,
  });
  const ms = now() - started;
  if (r.code !== 0) {
    if (r.stdout.length >= QUERY_MAX_BYTES * 0.9) throw new BrowseError('The result is over 4 MB: pick fewer columns or rows, or cut long values with LEFT()', 413);
    if (ms >= QUERY_LIMIT_MS || /maximum statement execution time|max_statement_time|interrupted/i.test(r.stderr)) {
      await stopLeftovers(ctx, QUERY_LIMIT_MS / 1000);
      throw new BrowseError(`The query ran past ${QUERY_LIMIT_MS / 1000} seconds and was stopped`, 504);
    }
    throw new BrowseError(mysqlError(r.stderr), 400);
  }
  const set = parseMysqlXml(r.stdout).at(-1) ?? { columns: [], rows: [] };
  return {
    statement: statement.kind,
    explain: Boolean(parsed.data.explain),
    columns: set.columns,
    rows: set.rows.slice(0, QUERY_ROWS),
    hasMore: set.rows.length > QUERY_ROWS,
    ms,
  };
}

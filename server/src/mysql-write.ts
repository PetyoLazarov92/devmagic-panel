import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionInput, MysqlProcess, WriteCheck } from '@devmagic-panel/shared';
import { dbWrite, isSystemDatabase } from '@devmagic-panel/shared';
import type { ExecResult } from './exec.js';
import type { JobStep } from './jobs.js';
import { type BrowseContext, num, read } from './mysql-browse.js';
import { adminSql, cleanupsDir, dumpPart, pruneCleanups, type SavedCleanup, undoCleanup } from './mysql-cleanup.js';
import { oneStatement, type Statement } from './mysql-query.js';
import type { RowsContext } from './mysql-rows.js';
import { MysqlRefused, siteDatabases } from './mysql-server.js';
import { BrowseError } from './mysql-sql.js';
import { formatBytes } from './sites/db.js';
import { freeSpace } from './sites/space.js';

/**
 * SQL that writes, run from the SQL runner as a job: one statement that
 * changes rows (INSERT, UPDATE, DELETE, REPLACE) or a table (ALTER, CREATE,
 * DROP, RENAME, TRUNCATE of a table, an index or a view). It names its
 * tables, so those tables (and any a foreign key cascades into) are saved
 * whole first; Undo puts them back as they were and deletes what the
 * statement made. Nothing on another database, MySQL's own or a kept one;
 * never accounts, rights, databases, routines or files.
 */
const ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const STRUCTURE: Record<string, RegExp> = {
  ALTER: /^ALTER\s+(?:ONLINE\s+|IGNORE\s+)?TABLE\b/i,
  CREATE: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX|VIEW)\b/i,
  DROP: /^DROP\s+(?:TABLE|INDEX|VIEW)\b/i,
  RENAME: /^RENAME\s+TABLE\b/i,
  TRUNCATE: /^TRUNCATE\b/i,
};

interface TableInfo {
  name: string;
  view: boolean;
  engine: string;
  bytes: number;
}

export interface WritePlanned {
  statement: Statement;
  /** Changes rows, so it runs in a transaction and can be tried first. */
  rows: boolean;
  tables: TableInfo[];
  all: TableInfo[];
  bytes: number;
  freeBytes: number;
}

const browse = (ctx: RowsContext): BrowseContext => ({ config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept });

/** The names MySQL would read in the statement: every word and backticked name outside strings and comments. */
function namesIn(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/`((?:[^`]|``)+)`|([A-Za-z0-9_$]+)/g)) out.add(m[1] !== undefined ? m[1].replaceAll('``', '`') : (m[2] as string));
  return out;
}

/** The databases a statement names before a dot: db.table or `db`.`table`. */
function qualifiers(code: string): string[] {
  return [...code.matchAll(/(`(?:[^`]|``)+`|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*[`A-Za-z_$*]/g)].map((m) => (m[1] as string).replace(/^`|`$/g, '').replaceAll('``', '`'));
}

/** Reads what a statement would change, and refuses what the runner never runs. Throws MysqlRefused. */
export async function planned(ctx: RowsContext, database: string, sql: string): Promise<WritePlanned> {
  if (isSystemDatabase(database)) throw new MysqlRefused(`${database} is MySQL's own: the panel only reads it`);
  if (ctx.kept().some((k) => k.name === database)) throw new MysqlRefused(`${database} is kept for a site to put back: the panel only reads it`);
  let statement: Statement;
  try {
    statement = oneStatement(sql, false);
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
  const head = statement.code.replace(/^\(+\s*/, '');
  const rows = ROWS.has(statement.kind);
  const structure = STRUCTURE[statement.kind];
  if (!rows && !(structure && structure.test(head))) {
    throw new MysqlRefused(
      `The SQL runner writes with INSERT, UPDATE, DELETE and REPLACE, and changes tables, indexes and views with ALTER, CREATE, DROP, RENAME and TRUNCATE; not ${head.split(/\s+/).slice(0, 2).join(' ')}`,
    );
  }
  let lines: string[];
  try {
    lines = await read(
      browse(ctx),
      `SELECT JSON_ARRAY('t', TABLE_NAME, TABLE_TYPE, COALESCE(ENGINE, ''), COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();\n` +
        `SELECT JSON_ARRAY('d', SCHEMA_NAME) FROM information_schema.SCHEMATA;\n` +
        `SELECT JSON_ARRAY('f', TABLE_NAME, REFERENCED_TABLE_NAME) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE();\n`,
      { database },
    );
  } catch (error) {
    throw new MysqlRefused((error as Error).message);
  }
  const rowsOf = (tag: string) => lines.map((l) => JSON.parse(l) as unknown[]).filter((r) => r[0] === tag);
  const all: TableInfo[] = rowsOf('t').map(([, name, type, engine, bytes]) => ({ name: String(name), view: type === 'VIEW', engine: String(engine), bytes: num(bytes) }));
  const databases = rowsOf('d').map(([, n]) => String(n));
  const other = qualifiers(statement.code).find((q) => q !== database && databases.some((d) => d === q || d.toLowerCase() === q.toLowerCase()));
  if (other) throw new MysqlRefused(`The statement names the database ${other}: run it on that database's SQL view`);

  const names = namesIn(statement.code);
  const lower = new Set([...names].map((n) => n.toLowerCase()));
  const named = new Set(all.filter((t) => names.has(t.name) || lower.has(t.name.toLowerCase())).map((t) => t.name));
  // A foreign key's ON DELETE or ON UPDATE changes the rows of the tables that point at a changed one.
  const keys = rowsOf('f').map(([, child, parent]) => [String(child), String(parent)] as const);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [child, parent] of keys) if (named.has(parent) && !named.has(child)) (named.add(child), (grew = true));
  }
  const tables = all.filter((t) => named.has(t.name));
  if (rows && tables.length === 0) throw new MysqlRefused(`The statement names no table of ${database}`);
  const bytes = tables.reduce((n, t) => n + t.bytes, 0);
  const freeBytes = freeSpace(existingFolder(cleanupsDir(ctx.config))).bytes;
  // The copy is gzipped, so the tables' size on disk is more than it needs.
  if (bytes > freeBytes) throw new MysqlRefused(`Saving ${tables.map((t) => t.name).join(', ')} first needs up to ${formatBytes(bytes)}, and the disk has ${formatBytes(freeBytes)} free`);
  return { statement, rows, tables, all, bytes, freeBytes };
}

/** The nearest folder that exists, for free space before the backups folder is made. */
function existingFolder(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/**
 * What a statement would do, before it runs: its tables, their size and the
 * disk's room for the copy, and for a change of rows on InnoDB tables how
 * many rows it changes, tried in a transaction that is rolled back.
 */
export async function checkWrite(ctx: RowsContext, database: string, body: unknown): Promise<WriteCheck> {
  const parsed = dbWrite.safeParse(body ?? {});
  if (!parsed.success) throw new BrowseError(parsed.error.issues[0]?.message ?? 'Invalid request');
  let plan: WritePlanned;
  try {
    plan = await planned(ctx, database, parsed.data.sql);
  } catch (error) {
    throw new BrowseError((error as Error).message);
  }
  let rows: number | null = null;
  let why: string | undefined;
  if (!plan.rows) why = 'A change to a table, an index or a view cannot be tried first: MySQL commits it at once.';
  else if (plan.tables.some((t) => !t.view && t.engine.toLowerCase() !== 'innodb')) why = `${plan.tables.filter((t) => t.engine.toLowerCase() !== 'innodb').map((t) => `${t.name} (${t.engine})`).join(', ')} cannot roll back, so it is not tried first.`;
  else {
    try {
      const lines = await adminSql(ctx, database, `SET SESSION innodb_lock_wait_timeout = 10;\nSTART TRANSACTION;\n${plan.statement.text}\n;\nSELECT ROW_COUNT();\nROLLBACK;\n`, 60_000);
      rows = num(lines.at(-1));
    } catch (error) {
      throw new BrowseError((error as Error).message.replace(/^MySQL refused it: /, ''));
    }
  }
  return {
    statement: plan.statement.kind,
    rows,
    ...(why ? { why } : {}),
    tables: plan.tables.map((t) => ({ name: t.name, bytes: t.bytes, ...(t.view ? { view: true } : {}) })),
    bytes: plan.bytes,
    freeBytes: plan.freeBytes,
  };
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** A job's title that names what changes, never the SQL itself (it can hold data, and run history keeps titles). */
export const writeTitle = (plan: Pick<WritePlanned, 'statement' | 'tables'>) =>
  `${plan.statement.kind} on ${plan.tables.length ? plan.tables.slice(0, 3).map((t) => t.name).join(', ') + (plan.tables.length > 3 ? ` and ${plan.tables.length - 3} more` : '') : 'a new table'}`;

/** The job: check again, save the tables it names, run it, note what it made; Undo puts the tables back. */
export async function planWrite(ctx: RowsContext, { database, sql }: ActionInput<'mysql.runSql'>): Promise<{ title: string; steps: JobStep[] }> {
  const site = siteDatabases(ctx.config).find((s) => s.db === database);
  if (site && ctx.siteBusy(`${site.domain}${site.path ?? ''}`)) throw new MysqlRefused(`${site.domain}${site.path ?? ''} is busy with a job: wait until it finishes`);
  const plan = await planned(ctx, database, sql);
  const title = writeTitle(plan);
  const now = ctx.now?.() ?? new Date();
  const id = `${stamp(now)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  const dir = join(cleanupsDir(ctx.config), id);
  const parts = plan.tables.map((t, i) => ({ table: t.name, how: 'replace' as const, rows: 0, file: `${String(i + 1).padStart(2, '0')}-${t.name}.sql.gz` }));
  const steps: JobStep[] = [
    {
      id: 'save',
      label: plan.tables.length ? `Save ${plan.tables.map((t) => t.name).join(', ')} for Undo` : 'Note the tables there are, for Undo',
      weight: 3,
      run: async (job) => {
        mkdirSync(cleanupsDir(ctx.config), { recursive: true, mode: 0o700 });
        pruneCleanups(cleanupsDir(ctx.config), now.getTime());
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const [i, p] of parts.entries()) {
          await dumpPart(ctx, database, { table: p.table, how: 'replace' }, undefined, join(dir, p.file), (bytes) => job.progress(i / Math.max(1, parts.length), `${p.table}: ${formatBytes(bytes)} of SQL`));
        }
        return { code: 0, stdout: parts.length ? `saved ${parts.map((p) => p.table).join(', ')}, kept 14 days` : 'it names no table that is there yet: Undo deletes what it makes', stderr: '' };
      },
    },
    {
      id: 'run',
      label: `Run the ${plan.statement.kind}`,
      weight: 2,
      run: async (job): Promise<ExecResult> => {
        let lines: string[];
        try {
          lines = await adminSql(
            ctx,
            database,
            plan.rows ? `SET SESSION innodb_lock_wait_timeout = 30;\nSTART TRANSACTION;\n${plan.statement.text}\n;\nSELECT ROW_COUNT();\nCOMMIT;\n` : `${plan.statement.text}\n;\n`,
            30 * 60_000,
          );
        } catch (error) {
          // A change of rows that failed was rolled back; nothing to undo, so no copy is kept.
          rmSync(dir, { recursive: true, force: true });
          return { code: 1, stdout: '', stderr: (error as Error).message };
        }
        const after = await adminSql(ctx, database, "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();\n");
        const before = new Set(plan.all.map((t) => t.name));
        const created = after.map((l) => l.split('\t')).filter(([name]) => name && !before.has(name)).map(([name, type]) => ({ name: name as string, view: type === 'VIEW' }));
        const saved: SavedCleanup = { title, kind: 'sql', database, ...(site ? { site: `${site.domain}${site.path ?? ''}` } : {}), parts, ...(created.length ? { created } : {}), savedAt: now.toISOString() };
        writeFileSync(join(dir, 'cleanup.json'), JSON.stringify(saved), { mode: 0o600 });
        job.onUndo(`Put ${plan.tables.length ? plan.tables.map((t) => t.name).join(', ') : 'the tables'} back as before`, () => undoCleanup(ctx, { database, cleanup: id }));
        const count = num(lines.at(-1));
        const changed = plan.rows ? `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'} changed` : 'done';
        const undo = parts.length ? 'Undo puts the tables back as they were before it' : 'Undo deletes what it made';
        return { code: 0, stdout: `${changed}${created.length ? `; made ${created.map((c) => c.name).join(', ')}` : ''}. ${undo}, for 14 days`, stderr: '' };
      },
    },
  ];
  return { title, steps };
}

// ── processes ────────────────────────────────────────────────

/** What MySQL is running now, without the panel's own connection; a statement's text cut at 300 characters. */
export async function mysqlProcesses(ctx: BrowseContext): Promise<MysqlProcess[]> {
  const lines = await read(ctx, `SELECT JSON_ARRAY(ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 300)) FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY TIME DESC;\n`);
  return lines.map((l) => {
    const [id, user, host, db, command, time, state, info] = JSON.parse(l) as unknown[];
    return {
      id: num(id),
      user: String(user ?? ''),
      host: String(host ?? ''),
      ...(db ? { db: String(db) } : {}),
      command: String(command ?? ''),
      seconds: num(time),
      ...(state ? { state: String(state) } : {}),
      ...(info ? { info: String(info) } : {}),
    };
  });
}

/** Stops one statement MySQL is running (KILL QUERY): its connection stays. Never MySQL's own threads. */
export async function killQuery(ctx: RowsContext, { id }: ActionInput<'mysql.killQuery'>): Promise<ExecResult> {
  const lines = await adminSql(ctx, 'information_schema', `SELECT USER, COMMAND FROM information_schema.PROCESSLIST WHERE ID = ${id};\n`);
  const [user, command] = (lines[0] ?? '').split('\t');
  if (!user) throw new MysqlRefused(`MySQL runs nothing with id ${id} now`);
  if (user === 'system user' || user === 'event_scheduler' || command === 'Daemon' || command === 'Binlog Dump') throw new MysqlRefused(`${id} is MySQL's own (${user}): it is left running`);
  if (command === 'Sleep') throw new MysqlRefused(`${id} runs no statement now`);
  await adminSql(ctx, 'information_schema', `KILL QUERY ${id};\n`);
  return { code: 0, stdout: `stopped the statement ${id} ran for ${user}`, stderr: '' };
}


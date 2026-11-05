import { existsSync } from 'node:fs';
import type { ExecResult } from '../exec.js';
import type { JobRuntime } from '../jobs.js';
import type { LimitsTarget } from '../mysql-limits.js';
import { freeSpace, importRoom } from './space.js';

/**
 * An import into a site's database that leaves the site as it is until the
 * dump is in: it goes into a side database, then one RENAME TABLE moves the
 * dump's tables in and the ones they replace out to a database of their own,
 * all at once. Until the job ends, Undo puts the tables from before back the
 * same way; once it ends well, they go. Tables the dump does not have stay
 * where they are, as with a plain import.
 */

/** Database names the side databases can be made from: their names fit MySQL's 64 characters and need no quoting care. */
const SWAPPABLE = /^[A-Za-z0-9_$]{1,56}$/;

export const sideName = (db: string) => `${db}__import`;
/** A kept database of a site's tables from before a swap, by when it was made, to the second: shop_com__keep261028143012. */
export const keepName = (db: string, at = new Date()) => `${db}__keep${at.toISOString().replace(/\D/g, '').slice(2, 14)}`;
/** Days a kept database stays before housekeeping drops it. */
export const KEEP_DAYS = 7;
export const prevName = (db: string) => `${db}__prev`;
export const canSwap = (db: string | undefined): db is string => db !== undefined && SWAPPABLE.test(db);
/** A kept database's name, 18 characters longer than the site's, still fits MySQL's 64. */
export const canKeep = (db: string | undefined): db is string => canSwap(db) && db.length <= 46;

/** The Undo a swap registers, by its label, so the end of the job can take it back. */
export const SWAP_UNDO = 'Put the database from before the import back';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const formatGb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Statements run with the admin account, stopping at the first that fails. */
export function sql(target: LimitsTarget, statements: string[]): Promise<ExecResult> {
  const { user, host, password } = target.mysql;
  return target.exec('mysql', ['--user', user, '--host', host], { env: { MYSQL_PWD: password }, input: `${statements.join('\n')}\n`, timeoutMs: 30 * 60_000 });
}

async function query(target: LimitsTarget, text: string): Promise<{ rows: string[][]; result: ExecResult }> {
  const { user, host, password } = target.mysql;
  const result = await target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', text], { env: { MYSQL_PWD: password } });
  return { rows: result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')), result };
}

const firstLine = (r: ExecResult) => r.stderr.trim().split('\n')[0] ?? 'MySQL refused';

/** How a swap import goes, shared by its steps. */
export interface SwapState {
  db: string;
  /** side: through the side database; direct: straight into the site's database, after a snapshot when it has tables. */
  mode?: 'side' | 'direct';
}

export interface ModeChoice {
  mode: 'side' | 'direct';
  /** Why it goes straight in. */
  why?: string;
  /** The site's database has tables, so a direct import needs a snapshot first. */
  hasTables: boolean;
}

/**
 * Side or direct, from the site's database as it is now: an empty one needs
 * nothing kept; tables with triggers, or views, cannot move to another
 * database; and the side copy needs room next to the current one.
 */
export async function chooseMode(target: LimitsTarget, db: string, dumpFile: string, free: (path: string) => { bytes: number } = freeSpace): Promise<ModeChoice> {
  const { rows, result } = await query(
    target,
    `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}'), (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'VIEW'), (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${db}'), @@datadir`,
  );
  if (result.code !== 0) return { mode: 'direct', why: `the MySQL admin account cannot read it (${firstLine(result)})`, hasTables: true };
  const [tables = '0', views = '0', triggers = '0', datadir = ''] = rows[0] ?? [];
  const hasTables = Number(tables) > 0;
  if (!hasTables) return { mode: 'direct', why: `${db} is empty, so there is nothing to keep`, hasTables };
  if (Number(views) > 0) return { mode: 'direct', why: `${db} has views, which cannot move to another database`, hasTables };
  if (Number(triggers) > 0) return { mode: 'direct', why: `${db} has triggers, which cannot move to another database`, hasTables };
  const dir = datadir.trim();
  if (dir && existsSync(dir)) {
    const need = importRoom(dumpFile);
    const room = free(dir).bytes;
    if (room < need) return { mode: 'direct', why: `a second copy needs about ${formatGb(need)} and MySQL's disk has ${formatGb(room)} free`, hasTables };
  }
  return { mode: 'side', hasTables };
}

/** A fresh side database, made like the site's: the same character set and collation. */
export async function makeSide(target: LimitsTarget, db: string): Promise<ExecResult> {
  const { rows } = await query(target, `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${db}'`);
  const [charset, collation] = rows[0] ?? [];
  const as = charset && collation && /^\w+$/.test(charset) && /^\w+$/.test(collation) ? ` CHARACTER SET ${charset} COLLATE ${collation}` : '';
  // A side database left by an import that stopped is the panel's own and goes first.
  return sql(target, [`DROP DATABASE IF EXISTS \`${sideName(db)}\`;`, `CREATE DATABASE \`${sideName(db)}\`${as};`]);
}

export const dropSide = (target: LimitsTarget, db: string) => sql(target, [`DROP DATABASE IF EXISTS \`${sideName(db)}\`;`]);

/** A database's tables, views marked. */
export const tablesOf = async (target: LimitsTarget, db: string) => {
  const { rows, result } = await query(target, `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}'`);
  return { result, tables: rows.map(([name = '', type = '']) => ({ name, view: type === 'VIEW' })) };
};

/** Moves tables between databases in one RENAME TABLE: all of them or none. */
export const renames = (moves: Array<[string, string, string]>) => `RENAME TABLE ${moves.map(([from, to, table]) => `\`${from}\`.\`${table}\` TO \`${to}\`.\`${table}\``).join(', ')};`;

/** Where a swap puts the tables it replaces, and what Undo does after moving them back. */
export interface SwapOptions {
  /** The database for the tables the dump replaces: the previous database by default, or a kept one. */
  out?: string;
  /** How long out stays, for the step's output: "for 7 days". */
  keptFor?: string;
  /** Runs once the tables it replaced are in out, like noting a kept database; before: the site's tables before the swap. */
  onKept?: (before: string[]) => void;
  /** Runs once Undo moved the tables back, like forgetting a kept database. */
  afterUndo?: () => void;
}

/**
 * The swap: the side database's tables in, the site's tables of the same
 * names out to another database, in one statement. Registers the Undo that
 * moves them back. With nothing to replace, no other database is made.
 */
export async function swapIn(target: LimitsTarget, db: string, job?: JobRuntime, options: SwapOptions = {}): Promise<ExecResult> {
  const out = options.out ?? prevName(db);
  const side = await tablesOf(target, sideName(db));
  if (side.result.code !== 0) return side.result;
  if (side.tables.some((t) => t.view)) return { code: 1, stdout: '', stderr: `the dump made views in ${sideName(db)}, which cannot move to ${db}; import it again with Undo first` };
  const incoming = side.tables.map((t) => t.name).filter((name) => /^[\w$]+$/.test(name));
  if (incoming.length === 0) return { code: 1, stdout: '', stderr: `the dump made no tables in ${sideName(db)}` };
  const current = await tablesOf(target, db);
  if (current.result.code !== 0) return current.result;
  const replaced = incoming.filter((name) => current.tables.some((t) => t.name === name));
  const moves: Array<[string, string, string]> = [...replaced.map((t): [string, string, string] => [db, out, t]), ...incoming.map((t): [string, string, string] => [sideName(db), db, t])];
  const makeOut = replaced.length > 0 ? [`DROP DATABASE IF EXISTS \`${out}\`;`, `CREATE DATABASE \`${out}\`;`] : [];
  const r = await sql(target, [...makeOut, renames(moves), `DROP DATABASE \`${sideName(db)}\`;`]);
  if (r.code !== 0) {
    // RENAME TABLE moved nothing: the database it was to fill is still empty.
    if (makeOut.length > 0) await sql(target, [`DROP DATABASE IF EXISTS \`${out}\`;`]);
    return r;
  }
  if (makeOut.length > 0) options.onKept?.(current.tables.map((t) => t.name));
  job?.onUndo(SWAP_UNDO, async () => {
    const back = await swapBack(target, db, incoming, replaced, out);
    if (back.code === 0) options.afterUndo?.();
    return back;
  });
  const kept = current.tables.length - replaced.length;
  const where = out === prevName(db) ? `wait in ${out} until the job ends, and Undo puts them back` : `are kept in ${out}${options.keptFor ? ` ${options.keptFor}` : ''}`;
  return ok(
    `swapped ${incoming.length} table${incoming.length === 1 ? '' : 's'} into ${db} at once` +
      (replaced.length > 0 ? `; the ${replaced.length} ${replaced.length === 1 ? 'one' : 'ones'} they replace ${where}` : '') +
      (kept > 0 ? `; ${kept} table${kept === 1 ? '' : 's'} the dump does not have stayed` : ''),
  );
}

/** Undo: the imported tables out, the ones from before back, in one statement; then the side database and out go. */
export async function swapBack(target: LimitsTarget, db: string, incoming: readonly string[], replaced: readonly string[], out = prevName(db)): Promise<ExecResult> {
  const moves: Array<[string, string, string]> = [...incoming.map((t): [string, string, string] => [db, sideName(db), t]), ...replaced.map((t): [string, string, string] => [out, db, t])];
  const r = await sql(target, [`DROP DATABASE IF EXISTS \`${sideName(db)}\`;`, `CREATE DATABASE \`${sideName(db)}\`;`, renames(moves), `DROP DATABASE \`${sideName(db)}\`;`, `DROP DATABASE IF EXISTS \`${out}\`;`]);
  return r.code === 0 ? ok(`${db} has its tables from before the import again`) : r;
}

/** The end of a job that went well: the tables from before go, and with them the Undo that needed them. */
export async function dropPrevious(target: LimitsTarget, db: string, job?: JobRuntime): Promise<ExecResult> {
  const r = await sql(target, [`DROP DATABASE IF EXISTS \`${prevName(db)}\`;`]);
  if (r.code !== 0) return r;
  job?.dropUndo?.(SWAP_UNDO);
  return ok(`removed ${prevName(db)}, the tables from before the import`);
}

import { totalmem } from 'node:os';
import type { ExecResult, Executor } from './exec.js';
import type { Secrets } from './secrets.js';

/**
 * MySQL's limits raised while an import or a search-replace runs, and put
 * back after: a bigger buffer pool and redo log and a 1 GB packet limit. Only
 * SET GLOBAL with the admin account: nothing is written to MySQL's config,
 * nothing restarts, and MySQL forgets the values at its next restart anyway.
 * What was there before is kept in the panel's database until it is put
 * back, so a panel stopped in the middle puts it back when it starts again.
 */

export type MysqlAccount = NonNullable<Secrets['mysql']>;

/** Where the values from before are kept: the panel database's meta table. */
export interface LimitsMemo {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
}

export interface LimitsTarget {
  exec: Executor;
  mysql: MysqlAccount;
  memo?: LimitsMemo | undefined;
}

interface Raised {
  name: string;
  was: number;
  /** What MySQL took, which may be rounded (the buffer pool goes in whole chunks). */
  now: number;
}

const MEMO_KEY = 'mysql-limits-raised';
const GB = 1024 ** 3;
/** How long the raised limits stay after the last job let go of them, so one job's steps share them. */
export const LINGER_MS = 60_000;

/** A quarter of the RAM at most, and never more than 8 GB: the browser, the editor and PHP need the rest. */
export function bufferPoolFor(ram: number): number {
  // totalmem() reports a little under the size on the box: 32 GB shows as about 31 GiB.
  if (ram >= 30 * GB) return 8 * GB;
  if (ram >= 15 * GB) return 4 * GB;
  if (ram >= 7 * GB) return 2 * GB;
  return GB;
}

/**
 * The buffer pool the sites' InnoDB data wants: room for the data with a
 * quarter to spare, never more than half the memory or 64 GB, in steps of
 * 128 MB. The Environment check and the MySQL page's suggestion both use it.
 */
export function bufferPoolTarget(dataBytes: number, ram: number): number {
  const step = 128 * 1024 ** 2;
  return Math.min(64 * GB, Math.max(step, Math.ceil(Math.min(dataBytes * 1.25, ram / 2) / step) * step));
}

/** The InnoDB data of every database but MySQL's own, for bufferPoolTarget. */
export const INNODB_DATA_SQL =
  "SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE ENGINE = 'InnoDB' AND TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')";

const sizeLabel = (n: number) => (n >= GB ? `${Number((n / GB).toFixed(1))} GB` : `${Math.round(n / 1024 ** 2)} MB`);

function query(target: LimitsTarget, sql: string): Promise<ExecResult> {
  const { user, host, password } = target.mysql;
  return target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', sql], { env: { MYSQL_PWD: password } });
}

async function readVariables(target: LimitsTarget, names: string[]): Promise<Map<string, string>> {
  const r = await query(target, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names.map((n) => `'${n}'`).join(', ')})`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'cannot read MySQL variables');
  return new Map(
    r.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols): cols is [string, string] => cols.length === 2)
      .map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
}

/**
 * The limits worth raising on this server, from its variables: the redo log
 * is innodb_redo_log_capacity on MySQL 8.0.30+, innodb_log_file_size on
 * MariaDB 10.9+ (both resize while running), and left alone on older ones.
 */
export function limitTargets(variables: ReadonlyMap<string, string>, ram: number): Array<{ name: string; to: number }> {
  const targets = [
    { name: 'innodb_buffer_pool_size', to: bufferPoolFor(ram) },
    { name: 'max_allowed_packet', to: GB },
  ];
  if (variables.has('innodb_redo_log_capacity')) targets.push({ name: 'innodb_redo_log_capacity', to: 2 * GB });
  else {
    const maria = /^(\d+)\.(\d+)\.\d+-MariaDB/i.exec(variables.get('version') ?? '');
    if (maria && (Number(maria[1]) > 10 || (Number(maria[1]) === 10 && Number(maria[2]) >= 9))) targets.push({ name: 'innodb_log_file_size', to: 2 * GB });
  }
  return targets.filter((t) => {
    const current = Number(variables.get(t.name));
    return Number.isFinite(current) && current < t.to;
  });
}

const VARIABLES = ['version', 'innodb_buffer_pool_size', 'max_allowed_packet', 'innodb_redo_log_capacity', 'innodb_log_file_size'];

async function raise(target: LimitsTarget, note: (line: string) => void, ram: number): Promise<Raised[]> {
  const variables = await readVariables(target, VARIABLES);
  const raised: Raised[] = [];
  for (const { name, to } of limitTargets(variables, ram)) {
    const was = Number(variables.get(name));
    // Kept before it changes, so a panel stopped right after still puts it back.
    target.memo?.setMeta(MEMO_KEY, JSON.stringify([...raised, { name, was, now: to }]));
    const r = await query(target, `SET GLOBAL ${name} = ${to}`);
    if (r.code !== 0) {
      note(`left ${name} at ${sizeLabel(was)}: ${r.stderr.trim().split('\n')[0] ?? 'MySQL refused'}`);
      continue;
    }
    const now = Number((await readVariables(target, [name])).get(name)) || to;
    raised.push({ name, was, now });
    target.memo?.setMeta(MEMO_KEY, JSON.stringify(raised));
    note(`raised ${name} from ${sizeLabel(was)} to ${sizeLabel(now)} while this runs`);
  }
  if (raised.length === 0) target.memo?.deleteMeta(MEMO_KEY);
  return raised;
}

/** Each value back to what it was, unless someone changed it since. */
async function putBack(target: LimitsTarget, raised: readonly Raised[]): Promise<void> {
  if (raised.length > 0) {
    const current = await readVariables(target, raised.map((r) => r.name));
    for (const r of raised) if (Number(current.get(r.name)) === r.now) await query(target, `SET GLOBAL ${r.name} = ${r.was}`);
  }
  target.memo?.deleteMeta(MEMO_KEY);
}

// One set of raised limits for the whole panel, shared by the jobs running at once.
let holders = 0;
let raised: Raised[] = [];
let linger: NodeJS.Timeout | undefined;
let lingerTarget: LimitsTarget | undefined;
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

/**
 * Runs fn with the limits raised. Never fails because of them: a server or
 * account that refuses gets a note and the job runs as it would have.
 */
export async function withRaisedLimits<T>(target: LimitsTarget | null, note: (line: string) => void, fn: () => Promise<T>, ram = totalmem()): Promise<T> {
  if (!target) return fn();
  await serial(async () => {
    holders++;
    clearTimeout(linger);
    if (holders > 1 || raised.length > 0) return;
    try {
      raised = await raise(target, note, ram);
      lingerTarget = target;
    } catch (error) {
      note(`left MySQL's limits as they are: ${(error as Error).message.split('\n')[0]}`);
    }
  });
  try {
    return await fn();
  } finally {
    await serial(async () => {
      holders--;
      if (holders > 0 || raised.length === 0) return;
      lingerTarget = target;
      linger = setTimeout(() => void serial(putBackNow), LINGER_MS);
      linger.unref();
    });
  }
}

async function putBackNow(): Promise<void> {
  if (holders > 0 || raised.length === 0 || !lingerTarget) return;
  const target = lingerTarget;
  const was = raised;
  raised = [];
  await putBack(target, was).catch(() => undefined);
}

/** What an import holds raised right now, with the value from before, for the MySQL page to say so. */
export function raisedNow(memo: LimitsMemo | undefined): Array<{ name: string; was: number; now: number }> {
  try {
    const list = JSON.parse(memo?.getMeta(MEMO_KEY) ?? '[]') as Raised[];
    return Array.isArray(list) ? list.filter((r) => typeof r.name === 'string' && Number.isFinite(r.was) && Number.isFinite(r.now)) : [];
  } catch {
    return [];
  }
}

/** Puts back what a panel stopped in the middle of a job left raised; run when the panel starts. */
export async function putBackLeftRaised(target: LimitsTarget): Promise<void> {
  const kept = target.memo?.getMeta(MEMO_KEY);
  if (!kept) return;
  let list: Raised[] = [];
  try {
    list = (JSON.parse(kept) as Raised[]).filter((r) => typeof r.name === 'string' && /^[a-z_]+$/.test(r.name) && Number.isFinite(r.was) && Number.isFinite(r.now));
  } catch {
    // Unreadable: nothing to put back.
  }
  await putBack(target, list);
}

/** Puts the limits back as the panel stops: the jobs that held them stop with it. */
export function putBackBeforeExit(): Promise<void> {
  clearTimeout(linger);
  holders = 0;
  return serial(putBackNow);
}

/** For tests: forget the shared state and put nothing back. */
export function resetLimitsForTests(): void {
  clearTimeout(linger);
  holders = 0;
  raised = [];
  lingerTarget = undefined;
  queue = Promise.resolve();
}

/** For tests: put the limits back now instead of after LINGER_MS. */
export const putBackNowForTests = () => serial(putBackNow);

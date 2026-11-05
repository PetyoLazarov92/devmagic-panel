import { randomBytes } from 'node:crypto';
import { availableParallelism, freemem } from 'node:os';
import type { AddressPass } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobRuntime } from '../jobs.js';
import type { WpRunner } from './db.js';
import { ANY_HOST } from './dump.js';

/**
 * Search and replace passes run by WP-CLI on groups of tables at once. Each
 * group runs every pass, in order, on its own tables, so each table ends up
 * as one run over all tables would leave it. After an import, a table the
 * dump scan shows has none of the addresses the passes look for is left
 * out, and a longer host that starts like a replaced one (acme.com.au next
 * to acme.com) is set aside while the passes run and put back after.
 */

export type TableFlag = '--all-tables' | '--all-tables-with-prefix';

export interface TableSize {
  name: string;
  bytes: number;
}

const GB = 1024 ** 3;
const MAX_GROUPS = 4;

/** At most 4, half the cores, and one per 2 GB of free memory: each group is a PHP process and a MySQL thread. */
export function groupCount(cores = availableParallelism(), free = freemem()): number {
  return Math.max(1, Math.min(MAX_GROUPS, Math.floor(cores / 2), Math.floor(free / (2 * GB))));
}

/** The tables in up to n groups of about the same size, biggest first; no table is in two groups. */
export function splitTables(tables: readonly TableSize[], n: number): TableSize[][] {
  const groups = Array.from({ length: Math.max(1, n) }, () => ({ bytes: 0, tables: [] as TableSize[] }));
  for (const table of [...tables].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))) {
    // The smallest group, and of equal ones the one with fewer tables, so tables of unknown size spread too.
    const smallest = groups.reduce((min, g) => (g.bytes < min.bytes || (g.bytes === min.bytes && g.tables.length < min.tables.length) ? g : min));
    smallest.tables.push(table);
    smallest.bytes += table.bytes;
  }
  return groups.map((g) => g.tables).filter((g) => g.length > 0);
}

/** A pass's search as written in a page: escaped slashes undone, the // or http:// in front dropped. */
export function searchedAddress(search: string): string | undefined {
  const plain = search.replaceAll('\\/', '/');
  return /^(?:https?:)?\/\/(.+)$/.exec(plain)?.[1];
}

/** The host a pass looks for, lower case and without a port or path; undefined for a search that is not an address. */
export function searchedHost(search: string): string | undefined {
  return searchedAddress(search)
    ?.split(/[/:]/)[0]
    ?.toLowerCase();
}

/**
 * The tables a pass could change: every table the dump did not create (or
 * all of them without the scan's word), and the ones it created that have a
 * host starting with one the passes look for. A table left out is never
 * changed, so no later pass could find anything in it either.
 */
export function tablesToSearch(tables: readonly TableSize[], passes: readonly AddressPass[], tableHosts: Readonly<Record<string, readonly string[]>> | undefined): TableSize[] {
  const needles = passes.map(([search]) => searchedHost(search));
  if (!tableHosts || needles.some((n) => n === undefined)) return [...tables];
  return tables.filter((t) => {
    const hosts = tableHosts[t.name];
    if (!hosts) return true;
    return hosts.some((h) => h === ANY_HOST || needles.some((n) => h.toLowerCase().startsWith(n as string)));
  });
}

/**
 * Hosts in the dump that a pass would change only because they start like
 * the address it looks for: //acme.com also matches //acme.com.au. Case is
 * kept, as WP-CLI's search is. Longest first, so a longer one is set aside
 * before one it starts with.
 */
export function longerHosts(passes: readonly AddressPass[], tableHosts: Readonly<Record<string, readonly string[]>>): string[] {
  const searched = passes.map(([search]) => searchedAddress(search)).filter((a): a is string => a !== undefined);
  const looked = new Set(searched);
  const seen = new Set(Object.values(tableHosts).flat().filter((h) => h !== ANY_HOST));
  return [...seen].filter((h) => !looked.has(h) && searched.some((a) => h !== a && h.startsWith(a))).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** The tables WP-CLI's search and replace picks with flag, and their size; null when they cannot be read. */
export async function listTables(wp: WpRunner, flag: TableFlag): Promise<TableSize[] | null> {
  const names = await wp(['db', 'tables', flag], 120_000);
  if (names.code !== 0) return null;
  const sizes = await wp(['db', 'query', 'SELECT TABLE_NAME, COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()', '--skip-column-names'], 120_000);
  const bytes = new Map<string, number>();
  if (sizes.code === 0) {
    for (const line of sizes.stdout.split('\n')) {
      const [name, size] = line.split('\t');
      if (name) bytes.set(name.trim(), Number(size) || 0);
    }
  }
  const list = names.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  return list.length > 0 ? list.map((name) => ({ name, bytes: bytes.get(name) ?? 0 })) : null;
}

/**
 * An hour, and half an hour more for each GB the pass reads. Generous on
 * purpose: a pass stopped midway leaves a table half done.
 */
export const passTimeout = (bytes: number) => 60 * 60_000 + Math.ceil(bytes / GB) * 30 * 60_000;

/** Columns no pass touches, as --skip-columns tells WP-CLI. */
const SKIP_COLUMNS = ['guid'];
/** Tables this big get the SQL replace first; below it, WP-CLI's own way is quick enough. */
export const SQL_FIRST_BYTES = 256 * 1024 ** 2;
const IDENT = /^[\w$]+$/;
const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);
/** Rows of primary key values per UPDATE, at most 400 UPDATEs a pass, 20 sent to MySQL at once. */
const CHUNK_KEYS = 50_000;
const MAX_CHUNKS = 400;
const BATCH = 20;

/**
 * A big table's columns WP-CLI would go through a row at a time: once a
 * column holds one serialized value, WP-CLI reads, replaces and writes back
 * every row that matches, each its own commit, which takes hours on a table
 * of millions of rows. Only for a table with one whole-number primary key.
 */
export interface SqlFirstPlan {
  table: string;
  key: string;
  columns: string[];
  min: number;
  max: number;
}

const ident = (name: string) => `\`${name}\``;
/** A column in one charset, so a UNION over tables of mixed collations runs. */
const utf8 = (column: string) => `CONVERT(${column} USING utf8mb4)`;
/** A string as a MySQL literal. */
const literal = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** The plan for a table, or null when WP-CLI's own way is as good: no serialized values, no single whole-number key, or the table cannot be read. */
export async function sqlFirstPlan(wp: WpRunner, table: string): Promise<SqlFirstPlan | null> {
  if (!IDENT.test(table)) return null;
  const described = await wp(
    ['db', 'query', `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`, '--skip-column-names'],
    120_000,
  );
  if (described.code !== 0) return null;
  const columns = described.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const keys = columns.filter((c) => c[2] === 'PRI');
  const key = keys[0];
  if (keys.length !== 1 || !key || !IDENT.test(key[0] ?? '') || !INT_TYPES.has((key[1] ?? '').toLowerCase())) return null;
  // The columns WP-CLI searches: text and varchar, less the skipped ones; a generated column (not a DEFAULT_GENERATED one) cannot be written.
  const text = columns
    .filter(([name = '', type = '', , extra = '']) => IDENT.test(name) && /text|varchar/i.test(type) && !SKIP_COLUMNS.includes(name) && !/(VIRTUAL|STORED) GENERATED/i.test(extra))
    .map(([name]) => name as string);
  if (text.length === 0) return null;
  // The same test WP-CLI makes to pick its way per column.
  const probe = await wp(
    ['db', 'query', `SELECT MIN(${ident(key[0] as string)}), MAX(${ident(key[0] as string)}), ${text.map((c) => `EXISTS(SELECT 1 FROM ${ident(table)} WHERE ${ident(c)} REGEXP '^[aiO]:[1-9]')`).join(', ')} FROM ${ident(table)}`, '--skip-column-names'],
    passTimeout(0),
  );
  if (probe.code !== 0) return null;
  const [min, max, ...serialized] = (probe.stdout.trim().split('\n')[0] ?? '').split('\t');
  const lo = Number(min);
  const hi = Number(max);
  if (!/^-?\d+$/.test(min ?? '') || !/^-?\d+$/.test(max ?? '') || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return null;
  const php = text.filter((_, i) => serialized[i] === '1');
  return php.length > 0 ? { table, key: key[0] as string, columns: php, min: lo, max: hi } : null;
}

/**
 * One pass's search and replace in plain SQL, a range of keys per UPDATE, on
 * every value that is not serialized data: for those, WP-CLI does exactly
 * this (PHP's str_replace, case sensitive like MySQL's REPLACE). A value
 * shaped like serialized data (a letter and a colon, or N;) is left for
 * WP-CLI's pass right after, which then only goes through those rows.
 */
export async function replaceWithSql(wp: WpRunner, plan: SqlFirstPlan, search: string, replace: string, timeoutMs: number): Promise<ExecResult> {
  const set = plan.columns
    .map((c) => `${ident(c)} = IF(SUBSTRING(${ident(c)}, 2, 1) = ':' OR LEFT(${ident(c)}, 2) = 'N;', ${ident(c)}, REPLACE(${ident(c)}, ${literal(search)}, ${literal(replace)}))`)
    .join(', ');
  const step = Math.max(CHUNK_KEYS, Math.ceil((plan.max - plan.min + 1) / MAX_CHUNKS));
  const statements: string[] = [];
  for (let lo = plan.min; lo <= plan.max; lo += step) {
    statements.push(`UPDATE ${ident(plan.table)} SET ${set} WHERE ${ident(plan.key)} BETWEEN ${lo} AND ${Math.min(plan.max, lo + step - 1)}; SELECT ROW_COUNT();`);
  }
  let changed = 0;
  for (let i = 0; i < statements.length; i += BATCH) {
    const r = await wp(['db', 'query', '--skip-column-names'], timeoutMs, statements.slice(i, i + BATCH).join('\n'));
    if (r.code !== 0) return r;
    for (const line of r.stdout.split('\n')) changed += Number(line.trim()) || 0;
  }
  const s = changed === 1 ? '' : 's';
  return { code: 0, stdout: changed > 0 ? `${plan.table}: ${changed.toLocaleString('en-US')} row${s} changed with SQL, serialized values left to WP-CLI` : '', stderr: '' };
}

const UNLOADED = /^Warning: Skipping an uninitialized class "([^"]+)", replacements might not be complete\.\n?/gm;

/** WP-CLI's warning for each serialized object of a plugin class it did not load, as one line. */
export function collapseWarnings(r: ExecResult): ExecResult {
  const classes = new Map<string, number>();
  const strip = (text: string) =>
    text.replace(UNLOADED, (_, name: string) => {
      classes.set(name, (classes.get(name) ?? 0) + 1);
      return '';
    });
  const stdout = strip(r.stdout);
  const stderr = strip(r.stderr);
  if (classes.size === 0) return r;
  const total = [...classes.values()].reduce((a, b) => a + b, 0);
  const names = [...classes.keys()].slice(0, 4).join(', ') + (classes.size > 4 ? ` and ${classes.size - 4} more` : '');
  const line = `Warning: ${total} serialized object${total === 1 ? '' : 's'} of plugin classes not loaded during the replace (${names}) left as they are; addresses inside them did not change.`;
  return { ...r, stdout, stderr: [stderr.trim(), line].filter(Boolean).join('\n') };
}

const sizeOf = (tables: readonly TableSize[]) => tables.reduce((sum, t) => sum + t.bytes, 0);

export interface RunPassesOptions {
  flag: TableFlag;
  /** From the dump scan after an import: which hosts each table it created has. */
  tableHosts?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * Passes an earlier step of the same job ran: the tables they changed may
   * now hold what these passes look for (http://local.acme.com after
   * //acme.com became //local.acme.com), so their hosts count too.
   */
  earlier?: readonly AddressPass[];
  /** Extra WP-CLI options for every pass, like --dry-run. */
  extra?: readonly string[];
  job?: JobRuntime | undefined;
  /** For tests: how many groups run at once. */
  groups?: number;
}

/**
 * Runs the passes on the tables that could hold what they look for, in
 * groups at once. A group that fails stops there; the others finish what
 * they are doing, as a pass stopped midway leaves a table half done.
 */
export async function runPasses(wp: WpRunner, passes: readonly AddressPass[], options: RunPassesOptions): Promise<ExecResult[]> {
  const { flag, job } = options;
  const common = [flag, `--skip-columns=${SKIP_COLUMNS.join(',')}`, '--report-changed-only', ...(options.extra ?? [])];
  if (passes.length === 0) return [];
  const tables = await listTables(wp, flag);
  if (!tables) {
    // The table list cannot be read: every pass on every table, one after the other, as before.
    const results: ExecResult[] = [];
    for (const [i, [a, b]] of passes.entries()) {
      job?.progress(i / passes.length, `pass ${i + 1} of ${passes.length}`);
      const r = collapseWarnings(await wp(['search-replace', a, b, ...common], 3 * 60 * 60_000));
      results.push(r);
      if (r.code !== 0) break;
    }
    return results;
  }

  const searched = tablesToSearch(tables, [...(options.earlier ?? []), ...passes], options.tableHosts);
  if (searched.length < tables.length) job?.activity?.(`left out ${tables.length - searched.length} of ${tables.length} tables: the dump has none of these addresses in them`);
  const results: ExecResult[] = [];
  if (searched.length === 0) return [{ code: 0, stdout: 'no table has these addresses: nothing to replace', stderr: '' }];

  // Hosts that only start like a replaced one go aside first and come back last, in the tables that have them.
  const aside = options.tableHosts ? longerHosts(passes, options.tableHosts) : [];
  const tag = randomBytes(4).toString('hex');
  const steps: Array<{ search: string; replace: string; only?: ReadonlySet<string> }> = [];
  const back: typeof steps = [];
  for (const [i, host] of aside.entries()) {
    const token = `dmp-keep-${tag}-${String(i).padStart(4, '0')}`;
    // The tables the scan saw it in, and the ones it cannot speak for: not the dump's, or with too many hosts to list.
    const only = new Set(
      searched
        .filter((t) => {
          const hosts = options.tableHosts?.[t.name];
          return !hosts || hosts.includes(host) || hosts.includes(ANY_HOST);
        })
        .map((t) => t.name),
    );
    for (const [from, to] of [[`//${host}`, `//${token}`], [`\\/\\/${host}`, `\\/\\/${token}`]] as const) {
      steps.push({ search: from, replace: to, only });
      back.push({ search: to, replace: from, only });
    }
  }
  if (aside.length > 0) results.push({ code: 0, stdout: `kept as they are: ${aside.join(', ')} (they start like a replaced host)`, stderr: '' });
  steps.push(...passes.map(([search, replace]) => ({ search, replace })), ...back);

  const groups = splitTables(searched, options.groups ?? groupCount());
  if (groups.length > 1) job?.activity?.(`${searched.length} tables in ${groups.length} groups at once`);
  const total = groups.length * steps.length;
  let done = 0;
  const runGroup = async (group: TableSize[]) => {
    const out: ExecResult[] = [];
    // Big tables WP-CLI would go through a row at a time get each pass in SQL first; never with options like --dry-run.
    const plans = new Map<string, SqlFirstPlan>();
    if (!options.extra?.length) {
      for (const table of group.filter((t) => t.bytes >= SQL_FIRST_BYTES)) {
        const plan = await sqlFirstPlan(wp, table.name);
        if (!plan) continue;
        plans.set(table.name, plan);
        job?.activity?.(`${table.name}: plain values in ${plan.columns.join(', ')} replaced with SQL, WP-CLI only goes through the serialized ones`);
      }
    }
    for (const step of steps) {
      const mine = step.only ? group.filter((t) => step.only?.has(t.name)) : group;
      if (mine.length > 0) {
        for (const table of mine) {
          const plan = plans.get(table.name);
          if (!plan) continue;
          const r = await replaceWithSql(wp, plan, step.search, step.replace, passTimeout(table.bytes));
          if (r.code !== 0 || r.stdout) out.push(r);
          if (r.code !== 0) return out;
        }
        const r = collapseWarnings(await wp(['search-replace', step.search, step.replace, ...mine.map((t) => t.name), ...common], passTimeout(sizeOf(mine))));
        out.push(r);
        if (r.code !== 0) return out;
      }
      done++;
      job?.progress(done / total, `${done} of ${total} passes${groups.length > 1 ? `, ${groups.length} table groups at once` : ''}`);
    }
    return out;
  };
  for (const out of await Promise.all(groups.map(runGroup))) results.push(...out);
  return results;
}

/**
 * After the replace: each site's home and siteurl, and a network's sites in
 * its blogs table, must have left the production hosts. Only small tables are
 * read, so it takes seconds whatever the size of the database.
 */
export async function checkAddresses(wp: WpRunner, options: { prefix: string; multisite: boolean; from: readonly string[] }): Promise<ExecResult> {
  const { prefix } = options;
  const from = new Set(options.from.map((h) => h.toLowerCase()));
  const fromNames = new Set([...from].map((h) => h.split(':')[0] as string));
  const query = (sql: string) => wp(['db', 'query', sql, '--skip-column-names'], 120_000);
  const rows = (text: string) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
  const left: string[] = [];
  let ids = [1];
  if (options.multisite) {
    const blogs = await query(`SELECT blog_id, domain, path FROM \`${prefix}blogs\` ORDER BY blog_id LIMIT 1000`);
    if (blogs.code !== 0) return blogs;
    ids = [];
    for (const [id, domain = '', path = ''] of rows(blogs.stdout)) {
      if (!/^\d+$/.test(id ?? '')) continue;
      ids.push(Number(id));
      if (from.has(domain.toLowerCase()) || fromNames.has(domain.toLowerCase())) left.push(`site ${id} is still at ${domain}${path} in ${prefix}blogs`);
    }
  }
  const table = (id: number) => (id === 1 ? `${prefix}options` : `${prefix}${id}_options`);
  const values = await query(ids.map((id) => `SELECT ${id}, ${utf8('option_name')}, ${utf8('option_value')} FROM \`${table(id)}\` WHERE option_name IN ('home', 'siteurl')`).join(' UNION ALL '));
  if (values.code !== 0) return values;
  for (const [id, name, value = ''] of rows(values.stdout)) {
    let host = '';
    try {
      host = new URL(value).host.toLowerCase();
    } catch {
      continue;
    }
    if (from.has(host) || fromNames.has(host)) left.push(`${options.multisite ? `site ${id} ` : ''}${name} is still ${value}`);
  }
  if (left.length > 0) return { code: 1, stdout: '', stderr: `still on a production address: ${left.join('; ')}` };
  const sites = options.multisite ? `${ids.length} site${ids.length === 1 ? '' : 's'}` : 'the site';
  return { code: 0, stdout: `home and siteurl of ${sites} no longer use ${options.from.join(', ')}`, stderr: '' };
}

import type { MysqlProcess, WriteCheck, CleanupInfo, DbSchema, ActionRunResult, RowChangeInfo, DbQuery, DbQueryResult, DbCell, DbCellValue, DbColumnHead, DbFilter, DbOverview, DbRow, DbRowsPage, DbRowsQuery, DbStructure, DbTable, MysqlDatabaseKind, WpDbReport } from '@devmagic-panel/shared';
import { DB_CELL_HEAD, isSystemDatabase, WP_AUTOLOAD_LIMIT } from '@devmagic-panel/shared';
import { sites } from './fixtures';

/** The mockup's database browser: WordPress tables with made-up rows, filtered, sorted and paged in the browser. */
interface MockColumn extends DbColumnHead {
  key?: 'PRI' | 'UNI' | 'MUL';
  nullable?: boolean;
  default?: string | null;
  extra?: string;
}

interface MockTable {
  columns: MockColumn[];
  rows: Array<Array<string | null>>;
  engine?: string;
  collation?: string;
  view?: boolean;
  /** MySQL's estimate, for tables too big to make rows for. */
  estimate?: number;
}

const text = (name: string, type = 'varchar(191)', extra: Partial<MockColumn> = {}): MockColumn => ({ name, type, binary: false, numeric: false, ...extra });
const num = (name: string, type = 'bigint unsigned', extra: Partial<MockColumn> = {}): MockColumn => ({ name, type, binary: false, numeric: true, ...extra });

const serializedWidgets = 'a:3:{i:2;a:3:{s:5:"title";s:6:"Search";s:5:"count";b:0;s:8:"settings";a:2:{s:4:"mode";s:4:"full";s:5:"limit";i:10;}}s:12:"_multiwidget";i:1;s:7:"enabled";b:1;}';
const longHtml = `<!-- wp:paragraph --><p>${'Acme ships bikes to every town on the coast. '.repeat(40)}</p><!-- /wp:paragraph -->`;

function options(domain: string): MockTable {
  const rows: Array<Array<string | null>> = [
    ['1', 'siteurl', `https://${domain}`, 'on'],
    ['2', 'home', `https://${domain}`, 'on'],
    ['3', 'blogname', 'Acme Bikes', 'on'],
    ['4', 'admin_email', 'alex.morgan@acme.com', 'on'],
    ['5', 'widget_search', serializedWidgets, 'on'],
    ['6', 'acme_settings', '{"theme":"dark","features":{"shop":true,"blog":false},"limits":[10,25,50]}', 'on'],
    ['7', 'acme_cache_blob', longHtml, 'off'],
    ['8', 'acme_note', 'NULL', 'off'],
    ['9', 'acme_empty', null, 'off'],
    ['10', 'cron', 'a:2:{i:1767225600;a:1:{s:16:"wp_version_check";a:0:{}}s:7:"version";i:2;}', 'on'],
    // An object with protected and private properties: PHP keeps NUL bytes around their names.
    ['133', 'acme_task_schedule', 'O:18:"Acme_Task_Schedule":3:{s:9:"\0*\0recurs";i:86400;s:25:"\0Acme_Task_Schedule\0start";i:1780000000;s:4:"name";s:5:"daily";}', 'off'],
  ];
  for (let i = 11; i <= 132; i++) rows.push([String(i), i % 3 ? `_transient_acme_feed_${i}` : `_transient_timeout_acme_feed_${i}`, i % 3 ? `a:1:{s:4:"item";s:${String(i).length}:"${i}";}` : String(1_767_225_600 + i), 'off']);
  return {
    columns: [num('option_id', 'bigint unsigned', { key: 'PRI', nullable: false, extra: 'auto_increment' }), text('option_name', 'varchar(191)', { key: 'UNI', nullable: false, default: '' }), text('option_value', 'longtext', { nullable: false }), text('autoload', 'varchar(20)', { key: 'MUL', nullable: false, default: 'yes' })],
    rows,
  };
}

function posts(): MockTable {
  const rows = Array.from({ length: 64 }, (_, i) => {
    const id = String(i + 1);
    const type = i % 5 === 0 ? 'page' : i % 7 === 0 ? 'revision' : 'post';
    return [id, '1', `2026-0${(i % 9) + 1}-1${i % 10} 09:${String(i % 60).padStart(2, '0')}:00`, i % 4 ? longHtml.slice(0, 600 + i * 10) : '', `${type === 'page' ? 'Page' : 'Ride report'} ${id}`, i % 6 === 0 ? 'draft' : 'publish', `ride-report-${id}`, type];
  });
  return {
    columns: [num('ID', 'bigint unsigned', { key: 'PRI', nullable: false, extra: 'auto_increment' }), num('post_author', 'bigint unsigned', { key: 'MUL', nullable: false, default: '0' }), text('post_date', 'datetime', { nullable: false, default: '0000-00-00 00:00:00' }), text('post_content', 'longtext', { nullable: false }), text('post_title', 'text', { nullable: false }), text('post_status', 'varchar(20)', { nullable: false, default: 'publish' }), text('post_name', 'varchar(200)', { key: 'MUL', nullable: false, default: '' }), text('post_type', 'varchar(20)', { key: 'MUL', nullable: false, default: 'post' })],
    rows,
  };
}

function users(): MockTable {
  return {
    columns: [num('ID', 'bigint unsigned', { key: 'PRI', nullable: false, extra: 'auto_increment' }), text('user_login', 'varchar(60)', { key: 'MUL', nullable: false }), text('user_pass', 'varchar(255)', { nullable: false }), text('user_email', 'varchar(100)', { key: 'MUL', nullable: false }), text('user_registered', 'datetime', { nullable: false })],
    rows: [
      ['1', 'alex', '$wp$2y$10$abcdefghijklmnopqrstuv', 'alex.morgan@acme.com', '2024-03-02 10:15:00'],
      ['2', 'sam', '$wp$2y$10$zyxwvutsrqponmlkjihgfe', 'sam.lee@acme.com', '2025-07-19 16:40:00'],
      ['3', 'editor', '$P$Bqwertyuiopasdfghjklzx', 'editor@acme.com', '2026-01-05 08:00:00'],
    ],
  };
}

function sessions(): MockTable {
  return {
    columns: [text('session_key', 'char(32)', { nullable: false }), text('session_value', 'longtext', { nullable: false }), num('session_expiry', 'bigint unsigned', { nullable: false }), { name: 'session_hash', type: 'varbinary(16)', binary: true, numeric: false }],
    rows: [
      ['a1b2c3', 'a:1:{s:4:"cart";a:0:{}}', '1767225600', '0f1e2d3c4b5a69788796a5b4c3d2e1f0'],
      ['d4e5f6', 'a:1:{s:4:"cart";a:1:{i:0;i:42;}}', '1767229200', null],
    ],
    engine: 'MyISAM',
    collation: 'latin1_swedish_ci',
  };
}

/** Each database's tables are made once, so row changes in the mockup stay. */
const made = new Map<string, Map<string, MockTable>>();
function tablesFor(database: string, domain: string): Map<string, MockTable> {
  const known = made.get(database);
  if (known) return known;
  const tables = makeTables(database, domain);
  made.set(database, tables);
  return tables;
}

function makeTables(database: string, domain: string): Map<string, MockTable> {
  const p = 'wp_';
  const big = (estimate: number, cols = 4): MockTable => ({ columns: [num('meta_id', 'bigint unsigned', { key: 'PRI' }), num('post_id', 'bigint unsigned', { key: 'MUL' }), text('meta_key', 'varchar(255)', { key: 'MUL' }), text('meta_value', 'longtext')].slice(0, cols), rows: [], estimate });
  return new Map<string, MockTable>([
    [`${p}commentmeta`, big(1_200)],
    [`${p}comments`, big(3_400)],
    [`${p}options`, options(domain)],
    [`${p}postmeta`, big(2_480_000)],
    [`${p}posts`, posts()],
    [`${p}recent_posts`, { ...posts(), view: true }],
    [`${p}term_relationships`, big(9_800, 2)],
    [`${p}terms`, big(420)],
    [`${p}usermeta`, big(260)],
    [`${p}users`, users()],
    [`acme_sessions`, sessions()],
    ...(database.endsWith('db') ? [[`old_${p}options`, { ...options(domain), estimate: 380 }] as [string, MockTable]] : []),
  ]);
}

function rowCount(t: MockTable): number {
  return t.rows.length || t.estimate || 0;
}

function tableInfo(name: string, t: MockTable): DbTable {
  const rows = rowCount(t);
  const dataBytes = t.view ? 0 : Math.max(16_384, rows * (t.columns.length * 180));
  return {
    name,
    view: Boolean(t.view),
    ...(t.view ? {} : { engine: t.engine ?? 'InnoDB', collation: t.collation ?? 'utf8mb4_unicode_520_ci' }),
    rows: t.view ? 0 : rows,
    dataBytes,
    indexBytes: t.view ? 0 : Math.round(dataBytes * 0.3),
    freeBytes: name.endsWith('postmeta') ? 48 * 1024 ** 2 : 0,
    ...(t.view ? {} : { updatedAt: new Date(Date.now() - (name.length % 7) * 3_600_000).toISOString() }),
  };
}

function siteOf(database: string) {
  return sites.find((s) => s.db?.name === database);
}

function kindOf(database: string): MysqlDatabaseKind {
  if (isSystemDatabase(database)) return 'system';
  if (siteOf(database)) return 'site';
  return database.includes('_kept') ? 'kept' : 'unused';
}

function find(database: string, table: string): MockTable {
  const t = tablesFor(database, siteOf(database)?.domain ?? 'local.acme.com').get(table);
  if (!t) throw new Error(`No table called ${table} in ${database}`);
  return t;
}

export function mockDbOverview(database: string): DbOverview {
  const site = siteOf(database);
  const tables = [...tablesFor(database, site?.domain ?? 'local.acme.com')].map(([name, t]) => tableInfo(name, t));
  return {
    database,
    kind: kindOf(database),
    sites: site ? [{ domain: site.domain, ...(site.path ? { path: site.path } : {}), prefix: 'wp_' }] : [],
    tables,
    totalBytes: tables.reduce((n, t) => n + t.dataBytes + t.indexBytes, 0),
    phpMyAdmin: `https://${site && site.server !== 'nginx' ? site.domain : 'local.acme.com'}/phpmyadmin/`,
    checkedAt: new Date().toISOString(),
  };
}

export function mockDbStructure(database: string, table: string): DbStructure {
  const t = find(database, table);
  const info = tableInfo(table, t);
  const pk = t.columns.filter((c) => c.key === 'PRI').map((c) => c.name);
  const indexes = t.columns.filter((c) => c.key).map((c) => ({ name: c.key === 'PRI' ? 'PRIMARY' : c.name, columns: [c.name], unique: c.key !== 'MUL', type: 'BTREE', cardinality: c.key === 'MUL' ? 12 : rowCount(t) }));
  const warnings = [
    ...(t.view || pk.length ? [] : ['No primary key: a row cannot be found again for its full values, and replication and many tools need one.']),
    ...(info.engine === 'MyISAM' ? ['MyISAM: no transactions and no crash recovery. InnoDB has been the default since MySQL 5.5.'] : []),
    ...(info.collation?.startsWith('latin1') ? ['Character set latin1: emoji and some scripts cannot be stored. WordPress uses utf8mb4.'] : []),
    ...(info.freeBytes > 10 * 1024 ** 2 ? ['Free space inside the table: Optimize on the MySQL page gives it back to the disk.'] : []),
  ];
  const createSql = t.view
    ? `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW \`${table}\` AS select * from \`wp_posts\` where (\`post_status\` = 'publish')`
    : [
        `CREATE TABLE \`${table}\` (`,
        ...t.columns.map((c, i) => `  \`${c.name}\` ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.default !== undefined && c.default !== null ? ` DEFAULT '${c.default}'` : ''}${c.extra ? ` ${c.extra.toUpperCase()}` : ''}${i < t.columns.length - 1 || indexes.length ? ',' : ''}`),
        ...indexes.map((x, i) => `  ${x.name === 'PRIMARY' ? 'PRIMARY KEY' : x.unique ? `UNIQUE KEY \`${x.name}\`` : `KEY \`${x.name}\``} (\`${x.columns.join('`,`')}\`)${i < indexes.length - 1 ? ',' : ''}`),
        `) ENGINE=${info.engine} DEFAULT CHARSET=${info.collation?.split('_')[0]} COLLATE=${info.collation}`,
      ].join('\n');
  return {
    database,
    table: info,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable ?? true, default: c.default ?? null, key: c.key ?? '', extra: c.extra ?? '', ...(c.numeric || c.binary ? {} : { collation: info.collation ?? 'utf8mb4_unicode_520_ci' }) })),
    indexes,
    primaryKey: pk,
    createSql,
    warnings,
  };
}

function matches(value: string | null, f: DbFilter, numeric: boolean): boolean {
  if (f.op === 'isNull') return value === null;
  if (f.op === 'notNull') return value !== null;
  if (value === null) return false;
  const v = f.value ?? '';
  if (numeric && ['eq', 'ne', 'gt', 'lt'].includes(f.op) && !/^-?\d+(\.\d+)?$/.test(v.trim())) throw new Error(`${f.column} holds numbers: "${v}" is not one`);
  const a = numeric ? Number(value) : value.toLowerCase();
  const b = numeric ? Number(v) : v.toLowerCase();
  switch (f.op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'gt': return a > b;
    case 'lt': return a < b;
    case 'contains': return value.toLowerCase().includes(v.toLowerCase());
    case 'startsWith': return value.toLowerCase().startsWith(v.toLowerCase());
  }
}

function toCell(value: string | null, binary: boolean): DbCell {
  if (value === null) return null;
  if (binary) return { head: value.slice(0, DB_CELL_HEAD), length: value.length / 2, binary: true };
  const chars = Array.from(value);
  return chars.length > DB_CELL_HEAD ? { head: chars.slice(0, DB_CELL_HEAD).join(''), length: chars.length } : value;
}

export function mockDbRows(database: string, table: string, query: DbRowsQuery): DbRowsPage {
  const t = find(database, table);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const filters = query.filters ?? [];
  const index = (name: string) => {
    const i = t.columns.findIndex((c) => c.name === name);
    if (i < 0) throw new Error(`No column called ${name} in this table`);
    return i;
  };
  const test = (r: Array<string | null>, f: DbFilter) => matches(r[index(f.column)] ?? null, f, Boolean(t.columns[index(f.column)]?.numeric));
  let rows = t.rows.filter((r) => !filters.length || (query.match === 'any' ? filters.some((f) => test(r, f)) : filters.every((f) => test(r, f))));
  if (query.sort) {
    const i = index(query.sort.column);
    const numeric = t.columns[i]?.numeric;
    const dir = query.sort.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = a[i] ?? null;
      const y = b[i] ?? null;
      if (x === y) return 0;
      if (x === null) return -dir;
      if (y === null) return dir;
      return (numeric ? Number(x) - Number(y) : x.localeCompare(y)) * dir;
    });
  }
  const pk = t.view ? [] : t.columns.flatMap((c, i) => (c.key === 'PRI' ? [i] : []));
  const slice = rows.slice((page - 1) * pageSize, page * pageSize + 1);
  const out: DbRow[] = slice.slice(0, pageSize).map((r) => {
    const cells = r.map((v, i) => toCell(v, Boolean(t.columns[i]?.binary)));
    return pk.length ? { cells, key: pk.map((i) => r[i] ?? '') } : { cells };
  });
  const estimate = !t.rows.length && t.estimate;
  return {
    database,
    table,
    columns: t.columns.map(({ name, type, binary, numeric, nullable, extra }) => ({ name, type, binary, numeric, ...(nullable !== false ? { nullable: true } : {}), ...(extra?.includes('auto_increment') ? { autoIncrement: true } : {}) })),
    primaryKey: pk.map((i) => t.columns[i]?.name ?? ''),
    rows: out,
    page,
    pageSize,
    total: estimate && !filters.length ? t.estimate ?? 0 : rows.length,
    totalExact: !(estimate && !filters.length),
    hasMore: slice.length > pageSize,
  };
}

export function mockDbCell(database: string, table: string, column: string, key: string[]): DbCellValue {
  const t = find(database, table);
  const pk = t.columns.findIndex((c) => c.key === 'PRI');
  const row = t.rows.find((r) => r[pk] === key[0]);
  const i = t.columns.findIndex((c) => c.name === column);
  if (!row || i < 0) throw new Error('That row is not there any more: it changed or went since the page was read');
  const value = row[i] ?? null;
  return { value: value === null ? null : t.columns[i]?.binary ? { head: value, length: value.length / 2, binary: true } : value, cut: false };
}

/** A site's database as WordPress sees it, in the mockup: one site over Site Health's autoload limit, a network with three sites. */
export function mockWordpressDb(domain: string, path: string | undefined, blog = 1): WpDbReport {
  const site = sites.find((s) => s.domain === domain && s.path === path);
  if (!site?.db) throw new Error(`${domain}${path ?? ''} has no database on this computer's MySQL server`);
  const heavy = site.db.sizeBytes > 1_000_000_000;
  const network = site.network
    ? [
        { id: 1, domain, path: '/', prefix: 'wp_' },
        { id: 2, domain, path: '/outlet/', prefix: 'wp_2_' },
        { id: 3, domain, path: '/old/', prefix: 'wp_3_', inactive: true },
      ]
    : undefined;
  if (blog !== 1 && !network?.some((b) => b.id === blog)) throw new Error(`This network has no site ${blog}`);
  const blogPrefix = blog === 1 ? 'wp_' : `wp_${blog}_`;
  const scale = blog === 1 ? 1 : 0.3;
  const n = (v: number) => Math.round(v * scale);
  return {
    database: site.db.name,
    prefix: 'wp_',
    blog,
    blogPrefix,
    ...(network ? { network } : {}),
    missingTables: heavy ? [] : [`${blogPrefix}termmeta`],
    autoload: {
      count: n(heavy ? 1_240 : 412),
      bytes: n(heavy ? 1_930_000 : 212_000),
      limitBytes: WP_AUTOLOAD_LIMIT,
      top: [
        { name: 'acme_slider_cache', bytes: n(heavy ? 880_000 : 61_000) },
        { name: 'rewrite_rules', bytes: n(94_000) },
        { name: 'acme_builder_css', bytes: n(heavy ? 310_000 : 22_000) },
        { name: 'cron', bytes: n(18_400) },
        { name: 'wp_user_roles', bytes: 6_100 },
        { name: 'widget_block', bytes: 4_200 },
        { name: 'active_plugins', bytes: 2_900 },
      ].sort((a, b) => b.bytes - a.bytes),
    },
    transients: { count: n(heavy ? 3_120 : 64), bytes: n(heavy ? 41_000_000 : 380_000), expired: n(heavy ? 2_870 : 9), site: { count: 12, bytes: 210_000, expired: 4 } },
    content: { revisions: n(heavy ? 18_400 : 620), autoDrafts: n(14), trashedPosts: n(37), spamComments: n(heavy ? 9_800 : 0), trashedComments: n(12) },
    orphans: { postmeta: n(heavy ? 4_210 : 0), commentmeta: n(heavy ? 1_300 : 0), termmeta: 0, termRelationships: n(26), ...(blog === 1 ? { usermeta: 3 } : {}) },
    metaKeys: [
      { key: '_acme_builder_data', count: n(2_400), bytes: n(heavy ? 640_000_000 : 18_000_000) },
      { key: '_wp_attachment_metadata', count: n(9_800), bytes: n(42_000_000) },
      { key: '_edit_lock', count: n(3_100), bytes: n(68_000) },
      { key: '_thumbnail_id', count: n(2_900), bytes: n(14_000) },
    ],
    users: {
      count: 3,
      list: [
        { id: '1', login: 'alex', email: 'alex.morgan@acme.com', registered: '2024-03-02 10:15:00', roles: ['administrator'] },
        { id: '2', login: 'sam', email: 'sam.lee@acme.com', registered: '2025-07-19 16:40:00', roles: blog === 1 ? ['editor'] : [] },
        { id: '3', login: 'shopkeeper', email: 'shop@acme.com', registered: '2026-01-05 08:00:00', roles: ['shop_manager', 'customer'] },
      ],
    },
    errors: {},
    checkedAt: new Date().toISOString(),
  };
}

/** The mockup's SQL runner: SELECT * FROM a mock table (with LIMIT), SHOW TABLES and EXPLAIN; anything that changes is refused as the server would. */
export function mockDbQuery(database: string, query: DbQuery): DbQueryResult {
  const sql = query.sql.trim().replace(/;\s*$/, '');
  const kind = (/^[\s(]*([A-Za-z]+)/.exec(sql)?.[1] ?? '').toUpperCase();
  if (!['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'TABLE', 'VALUES'].includes(kind)) {
    throw new Error(`${kind || 'That'} changes or does not read: the SQL runner runs SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, TABLE and VALUES`);
  }
  if (sql.includes(';')) throw new Error('One statement at a time');
  const ms = 4 + Math.round(Math.random() * 30);
  if (query.explain) {
    return { statement: kind, explain: true, columns: ['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'rows', 'Extra'], rows: [['1', 'SIMPLE', 'wp_options', 'ref', 'autoload', 'autoload', '412', 'Using where']], hasMore: false, ms };
  }
  if (kind === 'SHOW') {
    const tables = mockDbOverview(database).tables.map((t) => [t.name]);
    return { statement: kind, explain: false, columns: [`Tables_in_${database}`], rows: tables, hasMore: false, ms };
  }
  const from = /\bfrom\s+`?([A-Za-z0-9_]+)`?/i.exec(sql)?.[1];
  if (!from) return { statement: kind, explain: false, columns: ['1'], rows: [['1']], hasMore: false, ms };
  const t = find(database, from);
  const limit = Number(/\blimit\s+(\d+)/i.exec(sql)?.[1] ?? 1000);
  const rows = t.rows.slice(0, Math.min(limit, 1000));
  return { statement: kind, explain: false, columns: rows.length ? t.columns.map((c) => c.name) : [], rows, hasMore: t.rows.length > 1000 && limit > 1000, ms };
}

interface MockChange extends RowChangeInfo {
  database: string;
  undo: () => string;
}
const changes: MockChange[] = [];
let changeNo = 0;

/** The mockup's row changes: they change the rows above, and Undo puts them back, as the panel does. */
export function mockRowAction(id: string, input: Record<string, unknown>): ActionRunResult | null {
  if (!['mysql.updateRow', 'mysql.insertRow', 'mysql.deleteRows', 'mysql.undoRowChange'].includes(id)) return null;
  const database = String(input.database);
  const table = String(input.table);
  const t = find(database, table);
  const pk = t.columns.findIndex((c) => c.key === 'PRI');
  const index = (name: string) => t.columns.findIndex((c) => c.name === name);
  const done = (output: string, kind?: MockChange['kind'], rows = 1, undo?: () => string): ActionRunResult => {
    if (!kind || !undo) return { runId: 42, ok: true, exitCode: 0, output };
    const now = new Date();
    const change = `20261107-${String(101500 + changeNo).padStart(6, '0')}-mock${String(changeNo++).padStart(2, '0')}`;
    changes.unshift({ id: change, kind, table, rows, savedAt: now.toISOString(), purgeAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(), database, undo });
    return { runId: 42, ok: true, exitCode: 0, output, data: { backup: change } };
  };
  const fail = (why: string): ActionRunResult => ({ runId: 42, ok: false, exitCode: 1, output: why });
  if (id === 'mysql.undoRowChange') {
    const at = changes.findIndex((c) => c.id === input.change);
    if (at < 0) return fail('That change is not saved any more: copies go after 14 days, and after their Undo');
    const [change] = changes.splice(at, 1);
    return done(change?.undo() ?? '');
  }
  if (id === 'mysql.updateRow') {
    const row = t.rows.find((r) => r[pk] === (input.rowKey as string[])[0]);
    const values = input.rowValues as Record<string, string | null>;
    const was = input.rowWas as Record<string, string | null>;
    if (!row || Object.keys(values).some((k) => row[index(k)] !== was[k])) return fail('The row changed since you opened it, or is gone: nothing was changed. Open it again to see it as it is now');
    const before = [...row];
    for (const [k, v] of Object.entries(values)) row[index(k)] = v;
    return done(`changed ${Object.keys(values).length} columns of a row of ${table}; Undo puts it back`, 'update', 1, () => {
      row.splice(0, row.length, ...before);
      return `put a row of ${table} back as it was`;
    });
  }
  if (id === 'mysql.insertRow') {
    const values = input.rowValues as Record<string, string | null>;
    const next = String(Math.max(0, ...t.rows.map((r) => Number(r[pk]) || 0)) + 1);
    const row = t.columns.map((c, i) => (i === pk ? next : c.name in values ? values[c.name] ?? null : c.default ?? (c.nullable === false ? '' : null)));
    t.rows.push(row);
    return done(`added a row to ${table}; Undo deletes it`, 'insert', 1, () => {
      t.rows.splice(t.rows.indexOf(row), 1);
      return `deleted the row added to ${table}`;
    });
  }
  const keys = new Set((input.rowKeys as string[][]).map((k) => k[0]));
  const gone = t.rows.filter((r) => keys.has(r[pk] ?? ''));
  if (!gone.length) return fail('Those rows are gone already: nothing was deleted');
  t.rows = t.rows.filter((r) => !keys.has(r[pk] ?? ''));
  return done(`deleted ${gone.length} rows of ${table}; Undo puts them back`, 'delete', gone.length, () => {
    t.rows.push(...gone);
    t.rows.sort((a, b) => Number(a[pk]) - Number(b[pk]));
    return `put back ${gone.length} rows of ${table}`;
  });
}

export function mockRowChanges(database: string, table: string): RowChangeInfo[] {
  return changes.filter((c) => c.database === database && c.table === table).map(({ id, kind, table: t, rows, savedAt, purgeAt }) => ({ id, kind, table: t, rows, savedAt, purgeAt }));
}

export function mockDbSchema(database: string): DbSchema {
  const tables = tablesFor(database, siteOf(database)?.domain ?? 'local.acme.com');
  return { database, tables: Object.fromEntries([...tables].map(([name, t]) => [name, t.columns.map((c) => c.name)])) };
}

interface MockCleanup extends CleanupInfo {
  database: string;
  site?: string;
}
const cleanups: MockCleanup[] = [];

/** A clean-up job of the mockup leaves its saved copy in the list, as the panel would once its job is done. */
export function mockCleanupStarted(id: string, input: Record<string, unknown>): void {
  const kinds: Record<string, CleanupInfo['kind']> = { 'db.cleanTransients': 'transients', 'db.cleanContent': 'content', 'db.cleanOrphans': 'orphans', 'mysql.emptyTable': 'empty', 'mysql.dropTable': 'drop', 'mysql.runSql': 'sql' };
  const kind = kinds[id];
  if (!kind) return;
  const site = input.domain ? `${String(input.domain)}${input.path ? String(input.path) : ''}` : undefined;
  const database = site ? sites.find((s) => `${s.domain}${s.path ?? ''}` === site)?.db?.name ?? '' : String(input.database);
  const prefix = Number(input.blog ?? 1) > 1 ? `wp_${String(input.blog)}_` : 'wp_';
  const written = kind === 'sql' ? mockCheckWrite(String(input.database), String(input.sql)) : null;
  const title = { transients: input.scope === 'all' ? 'Delete every transient' : 'Delete expired transients', content: 'Delete revisions, drafts, trash and spam', orphans: 'Delete what was left behind', empty: `Empty ${String(input.table)}`, drop: `Delete table ${String(input.table)}`, sql: `${written?.statement ?? 'SQL'} on ${written?.tables.map((t) => t.name).join(', ') || 'a new table'}` }[kind];
  const tables = written ? written.tables.map((t) => ({ table: t.name, rows: 0 })) : kind === 'transients' ? [{ table: `${prefix}options`, rows: 2870 }] : kind === 'content' ? [{ table: `${prefix}postmeta`, rows: 940 }, { table: `${prefix}posts`, rows: 18_451 }] : kind === 'orphans' ? [{ table: `${prefix}postmeta`, rows: 4210 }, { table: `${prefix}commentmeta`, rows: 1300 }] : [{ table: String(input.table), rows: 0 }];
  const now = new Date();
  cleanups.unshift({ id: `20261107-${String(103000 + cleanups.length).padStart(6, '0')}-mockcl`, title, kind, tables, bytes: 3_400_000, savedAt: now.toISOString(), purgeAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(), database, ...(site ? { site } : {}) });
}

export function mockCleanups(database: string, site?: string): CleanupInfo[] {
  return cleanups.filter((c) => c.database === database && (site === undefined || c.site === site)).map(({ database: _d, site: _s, ...info }) => info);
}

export function mockUndoCleanup(id: string, input: Record<string, unknown>): ActionRunResult | null {
  if (id !== 'mysql.undoCleanup') return null;
  const at = cleanups.findIndex((c) => c.id === input.cleanup);
  if (at < 0) return { runId: 42, ok: false, exitCode: 1, output: 'That clean-up is not saved any more: copies go after 14 days, and after their Undo' };
  const [c] = cleanups.splice(at, 1);
  return { runId: 42, ok: true, exitCode: 0, output: `undid "${c?.title}": put back ${c?.tables.reduce((n, t) => n + t.rows, 0).toLocaleString('en-US')} rows` };
}

/** The mockup's check of SQL that writes: the tables of the mock database it names, and a count for a change of rows. */
export function mockCheckWrite(database: string, sql: string): WriteCheck {
  const text = sql.trim().replace(/;\s*$/, '');
  const kind = (/^[\s(]*([A-Za-z]+)/.exec(text)?.[1] ?? '').toUpperCase();
  const rows = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(kind);
  const structure = /^(ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|UNIQUE|VIEW)|DROP\s+(TABLE|INDEX|VIEW)|RENAME\s+TABLE|TRUNCATE)\b/i.test(text);
  if (!rows && !structure) throw new Error(`The SQL runner writes with INSERT, UPDATE, DELETE and REPLACE, and changes tables, indexes and views with ALTER, CREATE, DROP, RENAME and TRUNCATE; not ${text.split(/\s+/).slice(0, 2).join(' ')}`);
  if (text.includes(';')) throw new Error('One statement at a time');
  const tables = mockDbOverview(database).tables.filter((t) => new RegExp(`\\b${t.name}\\b`).test(text));
  if (rows && tables.length === 0) throw new Error(`The statement names no table of ${database}`);
  const myisam = tables.filter((t) => t.engine === 'MyISAM');
  return {
    statement: kind,
    rows: rows && !myisam.length ? 3 : null,
    ...(rows ? (myisam.length ? { why: `${myisam.map((t) => `${t.name} (MyISAM)`).join(', ')} cannot roll back, so it is not tried first.` } : {}) : { why: 'A change to a table, an index or a view cannot be tried first: MySQL commits it at once.' }),
    tables: tables.map((t) => ({ name: t.name, bytes: t.dataBytes + t.indexBytes, ...(t.view ? { view: true as const } : {}) })),
    bytes: tables.reduce((n, t) => n + t.dataBytes + t.indexBytes, 0),
    freeBytes: 182_000_000_000,
  };
}

export const killedProcesses = new Set<number>();

export function mockProcesses(): MysqlProcess[] {
  const all: MysqlProcess[] = [
    { id: 318, user: 'northwinddb', host: 'localhost', db: 'northwinddb', command: 'Query', seconds: 42, state: 'Sending data', info: "SELECT p.ID, m.meta_value FROM wp_posts p JOIN wp_postmeta m ON m.post_id = p.ID WHERE m.meta_key = '_acme_builder_data'" },
    { id: 322, user: 'dailypostdb', host: 'localhost', db: 'dailypostdb', command: 'Query', seconds: 3, state: 'executing', info: "UPDATE wp_options SET option_value = '...' WHERE option_name = 'cron'" },
    { id: 290, user: 'northwinddb', host: 'localhost', db: 'northwinddb', command: 'Sleep', seconds: 118 },
    { id: 5, user: 'event_scheduler', host: 'localhost', command: 'Daemon', seconds: 259_200, state: 'Waiting on empty queue' },
  ];
  return all.filter((p) => !killedProcesses.has(p.id));
}

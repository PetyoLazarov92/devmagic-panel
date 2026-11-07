import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BrowseContext, dbCell, dbOverview, dbRows, dbSchema, dbStructure, phpMyAdminUrl, structureWarnings, unescapeBatch } from '../src/mysql-browse.js';
import { BrowseError, type ColumnMeta, cellSql, escapeLike, literalFor, parseRows, rowsSql, textLiteral, toCell, whereSql } from '../src/mysql-sql.js';
import { type FakeCall, fakeExec, tempTree, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };

const col = (name: string, dataType: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name, type: dataType, dataType, nullable: true, default: null, key: '', extra: '', ...extra,
});
const OPTIONS: ColumnMeta[] = [
  col('option_id', 'bigint', { type: 'bigint unsigned', key: 'PRI', nullable: false }),
  col('option_name', 'varchar', { type: 'varchar(191)', charset: 'utf8mb4', collation: 'utf8mb4_unicode_520_ci', key: 'UNI' }),
  col('option_value', 'longtext', { charset: 'utf8mb4', collation: 'utf8mb4_unicode_520_ci' }),
  col('autoload', 'varchar', { type: 'varchar(20)', charset: 'utf8mb4', collation: 'utf8mb4_unicode_520_ci' }),
];
const PK = [OPTIONS[0] as ColumnMeta];

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

describe('the browser SQL', () => {
  it('writes values as hex literals in the column collation, so nothing in them can end the literal', () => {
    expect(textLiteral("it's \\ done")).toBe(`_utf8mb4 X'${hex("it's \\ done")}'`);
    const literal = literalFor(OPTIONS[1] as ColumnMeta, "x' OR '1'='1");
    expect(literal).toBe(`CONVERT(_utf8mb4 X'${hex("x' OR '1'='1")}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci`);
    expect(literal).not.toContain("'1'='1");
  });

  it('takes a number only once it reads as one', () => {
    expect(literalFor(OPTIONS[0] as ColumnMeta, ' 42 ')).toBe('42');
    expect(literalFor(OPTIONS[0] as ColumnMeta, '-1.5e3')).toBe('-1.5e3');
    expect(() => literalFor(OPTIONS[0] as ColumnMeta, '1 OR 1=1')).toThrow(/holds numbers/);
    expect(() => literalFor(OPTIONS[0] as ColumnMeta, '0x41')).toThrow(BrowseError);
  });

  it('leaves out a collation it cannot name safely', () => {
    expect(literalFor(col('c', 'varchar', { charset: 'utf8mb4', collation: 'x;DROP' }), 'a')).toBe(`_utf8mb4 X'${hex('a')}'`);
  });

  it('escapes LIKE wildcards in what is searched for', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(whereSql(OPTIONS, [{ column: 'option_name', op: 'contains', value: '_transient' }])).toBe(
      ` WHERE \`option_name\` LIKE CONVERT(_utf8mb4 X'${hex('%\\_transient%')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci`,
    );
  });

  it('casts numbers to text to search in them, and compares binary columns as bytes', () => {
    expect(whereSql(OPTIONS, [{ column: 'option_id', op: 'startsWith', value: '12' }])).toBe(` WHERE CAST(\`option_id\` AS CHAR) LIKE _utf8mb4 X'${hex('12%')}'`);
    expect(whereSql([col('data', 'blob')], [{ column: 'data', op: 'eq', value: 'ab' }])).toBe(` WHERE \`data\` = X'${hex('ab')}'`);
    expect(whereSql(OPTIONS, [{ column: 'autoload', op: 'isNull' }, { column: 'autoload', op: 'notNull' }])).toBe(' WHERE (`autoload` IS NULL) AND (`autoload` IS NOT NULL)');
    expect(whereSql(OPTIONS, [{ column: 'autoload', op: 'isNull' }, { column: 'option_id', op: 'gt', value: '9' }], 'any')).toBe(' WHERE (`autoload` IS NULL) OR (`option_id` > 9)');
  });

  it('refuses a column the table does not have', () => {
    expect(() => whereSql(OPTIONS, [{ column: 'option_id`; DROP TABLE x; --', op: 'eq', value: '1' }])).toThrow(/No column called/);
    expect(() => rowsSql('shop_com', 'wp_options', OPTIONS, PK, { page: 1, pageSize: 25, filters: [], match: 'all', sort: { column: 'nope', dir: 'asc' } })).toThrow(/No column called nope/);
  });

  it('reads one more row than the page, sorted, with the primary key breaking ties', () => {
    const sql = rowsSql('shop_com', 'wp_options', OPTIONS, PK, { page: 3, pageSize: 50, filters: [], match: 'all', sort: { column: 'option_name', dir: 'desc' } });
    expect(sql.rows).toContain('FROM `shop_com`.`wp_options` ORDER BY `option_name` DESC, `option_id` ASC LIMIT 51 OFFSET 100;');
    expect(sql.rows).toContain('LEFT(CAST(`option_value` AS CHAR), 300), CHAR_LENGTH(CAST(`option_value` AS CHAR))');
    expect(sql.rows).toMatch(/CAST\(`option_id` AS CHAR\)\) FROM/);
    expect(sql.count).toBe('SELECT COUNT(*) FROM `shop_com`.`wp_options`;\n');
  });

  it('doubles a backtick in a name MySQL listed', () => {
    const odd = [col('a`b', 'int')];
    expect(rowsSql('shop_com', 'odd`table', odd, [], { page: 1, pageSize: 25, filters: [], match: 'all' }).rows).toContain('FROM `shop_com`.`odd``table` LIMIT 26 OFFSET 0;');
  });

  it('finds one value by its primary key, and refuses without one', () => {
    expect(cellSql('shop_com', 'wp_options', OPTIONS[2] as ColumnMeta, PK, ['7'])).toBe(
      'SELECT JSON_ARRAY(LEFT(CAST(`option_value` AS CHAR), 1000000), CHAR_LENGTH(CAST(`option_value` AS CHAR))) FROM `shop_com`.`wp_options` WHERE `option_id` = 7 LIMIT 1;\n',
    );
    expect(() => cellSql('shop_com', 'wp_options', OPTIONS[2] as ColumnMeta, [], ['7'])).toThrow(/no primary key/);
    expect(() => cellSql('shop_com', 'wp_options', OPTIONS[2] as ColumnMeta, PK, ['7', '8'])).toThrow(/has 1 columns/);
    const binaryKey = [col('id', 'binary')];
    expect(cellSql('shop_com', 't', OPTIONS[2] as ColumnMeta, binaryKey, ['0AFF'])).toContain("WHERE `id` = X'0AFF'");
    expect(() => cellSql('shop_com', 't', OPTIONS[2] as ColumnMeta, binaryKey, ["0A' OR 1"])).toThrow(/comes as hex/);
  });

  it('reads rows, cutting long values and keeping NULL apart from the text NULL', () => {
    const lines = [JSON.stringify(['1', 1, 'siteurl', 7, 'NULL', 4, null, null, '1']), JSON.stringify(['2', 1, 'big', 3, 'x'.repeat(300), 5000, 'on', 2, '2'])];
    const rows = parseRows(lines, OPTIONS, PK);
    expect(rows[0]).toEqual({ cells: ['1', 'siteurl', 'NULL', null], key: ['1'] });
    expect(rows[1]?.cells[2]).toEqual({ head: 'x'.repeat(300), length: 5000 });
    expect(() => parseRows(['["1"]'], OPTIONS, PK)).toThrow(/another shape/);
    expect(() => parseRows(['not json'], OPTIONS, PK)).toThrow(/cannot read/);
  });

  it('counts characters, not UTF-16 units, to tell whether a value was cut', () => {
    expect(toCell('😀😀', 2, false)).toBe('😀😀');
    expect(toCell('😀😀', 3, false)).toEqual({ head: '😀😀', length: 3 });
    expect(toCell('0AFF', 2, true)).toEqual({ head: '0aff', length: 2, binary: true });
  });
});

/** Answers the browser's reads like MySQL: stdin holds the statements, JSON_ARRAY lines come back. */
function fakeMysql(answer: (sql: string, call: FakeCall) => Partial<{ code: number; stdout: string; stderr: string }>, version = '8.0.43-0ubuntu0.24.04.1') {
  return fakeExec({
    mysql: (call) => {
      const e = call.args.indexOf('-e');
      if (e >= 0) {
        const sql = call.args[e + 1] as string;
        if (sql === 'SELECT VERSION()') return { stdout: `${version}\n` };
        if (sql.startsWith('SHOW VARIABLES')) return { stdout: 'information_schema_stats_expiry\t86400\n' };
        return { code: 1, stderr: `unexpected: ${sql}` };
      }
      return answer(call.input ?? '', call);
    },
  });
}

const json = (...rows: unknown[][]) => ({ stdout: rows.map((r) => JSON.stringify(r)).join('\n') });

/** wp_options as information_schema describes it, plus one row. */
function optionsMeta(sql: string): Partial<{ code: number; stdout: string; stderr: string }> | undefined {
  if (!sql.includes("SELECT JSON_ARRAY('t'")) return undefined;
  return json(
    ['t', 'wp_options', 'BASE TABLE', 'InnoDB', 420, 1_572_864, 98_304, 0, 'utf8mb4_unicode_520_ci', '2026-11-06 10:00:00.000000'],
    ['c', 'option_id', 'bigint unsigned', 'bigint', 'NO', null, 'PRI', 'auto_increment', null, null, ''],
    ['c', 'option_name', 'varchar(191)', 'varchar', 'NO', '', 'UNI', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''],
    ['c', 'option_value', 'longtext', 'longtext', 'NO', null, '', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''],
    ['c', 'autoload', 'varchar(20)', 'varchar', 'NO', 'yes', 'MUL', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''],
    ['i', 'PRIMARY', 0, 1, 'option_id', 'BTREE', 420],
    ['i', 'autoload', 1, 1, 'autoload', 'BTREE', 2],
    ['i', 'option_name', 0, 1, 'option_name', 'BTREE', 420],
  );
}

const ctxFor = (fake: ReturnType<typeof fakeExec>, config = tempTree().config, kept: BrowseContext['kept'] = () => []): BrowseContext => ({ config, exec: fake.exec, mysql, kept });

describe('the database browser', () => {
  it('lists a site database with its tables, sizes and the site with its prefix', async () => {
    const tree = wpSiteTree();
    const fake = fakeMysql((sql) => {
      if (sql.includes('information_schema.SCHEMATA')) {
        return { stdout: ['1', JSON.stringify(['wp_options', 'BASE TABLE', 'InnoDB', 420, 1000, 200, 0, 'utf8mb4_unicode_520_ci', null]), JSON.stringify(['wp_recent', 'VIEW', null, null, null, null, null, null, null])].join('\n') };
      }
      return { code: 1, stderr: 'unexpected' };
    });
    const overview = await dbOverview(ctxFor(fake, tree.config), 'shop_com', () => Date.parse('2026-11-06T10:00:00Z'));
    expect(overview).toMatchObject({
      database: 'shop_com',
      kind: 'site',
      sites: [{ domain: 'local.shop.com', prefix: 'wp_' }],
      totalBytes: 1200,
      tables: [{ name: 'wp_options', view: false, engine: 'InnoDB', rows: 420 }, { name: 'wp_recent', view: true, rows: 0 }],
      checkedAt: '2026-11-06T10:00:00.000Z',
    });
    // Read only and time limited, every time, with the password in the environment and the SQL on stdin.
    const read = fake.calls.find((c) => c.input?.includes('information_schema.SCHEMATA')) as FakeCall;
    expect(read.input).toMatch(/^SET SESSION TRANSACTION READ ONLY;\nSET SESSION max_execution_time = 15000;\nSET SESSION information_schema_stats_expiry = 0; SELECT COUNT/);
    expect(read.input).toContain(`SCHEMA_NAME = _utf8mb4 X'${hex('shop_com')}'`);
    expect(read.env).toEqual({ MYSQL_PWD: 'adminpw' });
    expect(read.args).not.toContain('-e');
    expect(fake.calls.flatMap((c) => c.args).join(' ')).not.toContain('adminpw');
  });

  it('says what a database is to the panel', async () => {
    const fake = fakeMysql(() => ({ stdout: '1\n' }));
    expect((await dbOverview(ctxFor(fake), 'mysql')).kind).toBe('system');
    expect(await dbOverview(ctxFor(fake, tempTree().config, () => [{ name: 'shop_com_kept', site: 'local.shop.com@learn' }]), 'shop_com_kept')).toMatchObject({ kind: 'kept', sites: [{ domain: 'local.shop.com', path: '/learn' }] });
    expect((await dbOverview(ctxFor(fake), 'reports')).kind).toBe('unused');
  });

  it('answers 404 for a database MySQL does not have, 400 for a name it would not take, 503 without an account', async () => {
    const fake = fakeMysql(() => ({ stdout: '0\n' }));
    await expect(dbOverview(ctxFor(fake), 'gone_db')).rejects.toMatchObject({ status: 404, message: 'No database called gone_db on this MySQL server' });
    await expect(dbOverview(ctxFor(fake), 'a;b')).rejects.toMatchObject({ status: 400 });
    await expect(dbOverview({ ...ctxFor(fake), mysql: null }, 'shop_com')).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/no MySQL admin account/) });
  });

  it("uses MariaDB's own time limit", async () => {
    const fake = fakeMysql(() => ({ stdout: '1\n' }), '10.11.8-MariaDB-0ubuntu0.24.04.1');
    await dbOverview(ctxFor(fake), 'reports');
    expect(fake.calls.find((c) => c.input)?.input).toContain('SET SESSION max_statement_time = 15;');
  });

  it('says so when MySQL stopped a read that took too long', async () => {
    const fake = fakeMysql(() => ({ code: 1, stderr: 'ERROR 3024 (HY000) at line 3: Query execution was interrupted, maximum statement execution time exceeded' }));
    await expect(dbOverview(ctxFor(fake), 'reports')).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/stopped the read after 15 seconds/) });
  });

  it('shows a table structure with its keys, indexes, CREATE TABLE and what deserves a look', async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? (sql.includes('SHOW CREATE TABLE `shop_com`.`wp_options`') ? { stdout: 'wp_options\tCREATE TABLE `wp_options` (\\n  `option_id` bigint\\n) ENGINE=InnoDB\n' } : { code: 1 }));
    const s = await dbStructure(ctxFor(fake), 'shop_com', 'wp_options');
    expect(s.primaryKey).toEqual(['option_id']);
    expect(s.columns[1]).toEqual({ name: 'option_name', type: 'varchar(191)', nullable: false, default: '', key: 'UNI', extra: '', collation: 'utf8mb4_unicode_520_ci' });
    expect(s.columns[0]?.default).toBeNull();
    expect(s.indexes.map((i) => [i.name, i.unique, i.columns])).toEqual([['PRIMARY', true, ['option_id']], ['autoload', false, ['autoload']], ['option_name', true, ['option_name']]]);
    expect(s.createSql).toBe('CREATE TABLE `wp_options` (\n  `option_id` bigint\n) ENGINE=InnoDB');
    expect(s.table.updatedAt).toMatch(/^2026-11-0\dT/);
    expect(s.warnings).toEqual([]);
    // The CREATE TABLE read is escaped by --batch, not raw.
    expect(fake.calls.find((c) => c.input?.includes('SHOW CREATE'))?.args).not.toContain('--raw');
  });

  it('refuses a table the database does not have, also when only its case differs', async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? { code: 1 });
    await expect(dbStructure(ctxFor(fake), 'shop_com', 'WP_OPTIONS')).rejects.toMatchObject({ status: 404 });
    const empty = fakeMysql(() => ({ stdout: '' }));
    await expect(dbRows(ctxFor(empty), 'shop_com', 'wp_nope', {})).rejects.toMatchObject({ status: 404, message: 'No table called wp_nope in shop_com' });
    await expect(dbRows(ctxFor(empty), 'shop_com', 'a`b/c', {})).rejects.toMatchObject({ status: 400 });
  });

  it('warns about a missing primary key, MyISAM, an old character set and free space', () => {
    const table = { name: 't', view: false, engine: 'MyISAM', rows: 1, dataBytes: 20 * 1024 ** 2, indexBytes: 0, freeBytes: 50 * 1024 ** 2, collation: 'latin1_swedish_ci' };
    expect(structureWarnings(table, [])).toHaveLength(4);
    expect(structureWarnings({ ...table, view: true }, [])).toEqual([]);
  });

  it('pages rows with a filter that never reaches the command line, and counts them', async () => {
    const fake = fakeMysql((sql) => {
      const meta = optionsMeta(sql);
      if (meta) return meta;
      if (sql.includes('SELECT COUNT(*) FROM `shop_com`.`wp_options`')) return { stdout: '3\n' };
      if (sql.includes('SELECT JSON_ARRAY(LEFT(CAST(`option_id`')) {
        return json(['1', 1, 'a', 1, 'x', 1, 'yes', 3, '1'], ['2', 1, 'b', 1, 'y', 1, 'yes', 3, '2'], ['3', 1, 'c', 1, 'z', 1, 'no', 2, '3']);
      }
      return { code: 1, stderr: 'unexpected' };
    });
    const page = await dbRows(ctxFor(fake), 'shop_com', 'wp_options', { pageSize: 25, filters: [{ column: 'option_name', op: 'contains', value: 'alex.morgan@acme.com' }] });
    expect(page).toMatchObject({ total: 3, totalExact: true, hasMore: false, primaryKey: ['option_id'], page: 1, pageSize: 25 });
    expect(page.columns.map((c) => [c.name, c.numeric, c.binary])).toEqual([['option_id', true, false], ['option_name', false, false], ['option_value', false, false], ['autoload', false, false]]);
    expect(page.rows[2]).toEqual({ cells: ['3', 'c', 'z', 'no'], key: ['3'] });
    const argv = fake.calls.flatMap((c) => c.args).join(' ');
    expect(argv).not.toContain('alex.morgan');
    expect(fake.calls.map((c) => c.input ?? '').join('')).not.toContain('alex.morgan');
    expect(fake.calls.find((c) => c.input?.includes('COUNT(*)'))?.input).toContain('max_execution_time = 5000');
  });

  it('shows one page less than it read, and an estimate for a big table without filters', async () => {
    const big = (sql: string) => {
      const meta = optionsMeta(sql);
      return meta ? { stdout: (meta.stdout as string).replace('"InnoDB",420', '"InnoDB",2500000') } : undefined;
    };
    const fake = fakeMysql((sql) => big(sql) ?? json(...Array.from({ length: 26 }, (_, i) => [String(i), 1, 'n', 1, 'v', 1, 'yes', 3, String(i)])));
    const page = await dbRows(ctxFor(fake), 'shop_com', 'wp_options', { pageSize: 25 });
    expect(page).toMatchObject({ total: 2_500_000, totalExact: false, hasMore: true });
    expect(page.rows).toHaveLength(25);
    expect(fake.calls.some((c) => c.input?.includes('COUNT(*)'))).toBe(false);
  });

  it('gives no count when counting what a filter matches takes too long', async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? (sql.includes('COUNT(*)') ? { code: 1, stderr: 'ERROR 3024 (HY000): maximum statement execution time exceeded' } : { stdout: '' }));
    const page = await dbRows(ctxFor(fake), 'shop_com', 'wp_options', { filters: [{ column: 'autoload', op: 'eq', value: 'yes' }] });
    expect(page).toMatchObject({ total: null, totalExact: false, rows: [] });
  });

  it("narrows to a clean-up's rows by the condition the server built, with the database picked, and refuses one without a resolver", async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? (sql.includes('COUNT(*)') ? { stdout: '2\n' } : { stdout: '' }));
    const asked: string[] = [];
    const cleanup = { domain: 'local.shop.com', kind: 'expiredTransients' as const };
    const page = await dbRows(ctxFor(fake), 'shop_com', 'wp_options', { cleanup, filters: [{ column: 'autoload', op: 'eq', value: 'yes' }] }, async (database, table, view) => {
      asked.push(`${database}.${table}:${view.kind}`);
      return "option_name LIKE '\\_transient\\_timeout\\_%'";
    });
    expect(asked).toEqual(['shop_com.wp_options:expiredTransients']);
    expect(page).toMatchObject({ total: 2, totalExact: true });
    const rows = fake.calls.find((c) => c.input?.includes('SELECT JSON_ARRAY(LEFT('));
    expect(rows?.input).toContain("WHERE (option_name LIKE '\\_transient\\_timeout\\_%') AND (`autoload` = CONVERT(_utf8mb4 X'796573'");
    expect(rows?.args).toContain('--database=shop_com');
    await expect(dbRows(ctxFor(fake), 'shop_com', 'wp_options', { cleanup })).rejects.toMatchObject({ status: 400, message: 'This table cannot show a clean-up' });
  });

  it('refuses a request outside the schema', async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? { stdout: '' });
    await expect(dbRows(ctxFor(fake), 'shop_com', 'wp_options', { pageSize: 1000 })).rejects.toMatchObject({ status: 400 });
    await expect(dbRows(ctxFor(fake), 'shop_com', 'wp_options', { filters: Array.from({ length: 11 }, () => ({ column: 'autoload', op: 'isNull' })) })).rejects.toMatchObject({ status: 400 });
    await expect(dbRows(ctxFor(fake), 'shop_com', 'wp_options', { filters: [{ column: 'option_id', op: 'eq', value: 'one' }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/holds numbers/) });
  });

  it('opens one value in full by its key, and says when the row went', async () => {
    const fake = fakeMysql((sql) => optionsMeta(sql) ?? (sql.includes('`option_id` = 7') ? json(['a long value', 12]) : { stdout: '' }));
    expect(await dbCell(ctxFor(fake), 'shop_com', 'wp_options', { column: 'option_value', key: ['7'] })).toEqual({ value: 'a long value', cut: false });
    await expect(dbCell(ctxFor(fake), 'shop_com', 'wp_options', { column: 'option_value', key: ['8'] })).rejects.toMatchObject({ status: 404 });
    await expect(dbCell(ctxFor(fake), 'shop_com', 'wp_options', { column: 'nope', key: ['7'] })).rejects.toMatchObject({ status: 400 });
  });

  it('lists every table with its columns in order, names only, for the editor', async () => {
    const fake = fakeMysql((sql) => (sql.includes('information_schema.COLUMNS') ? json(['wp_options', 'option_id'], ['wp_options', 'option_name'], ['wp_posts', 'ID']) : { code: 1 }));
    expect(await dbSchema(ctxFor(fake), 'shop_com')).toEqual({ database: 'shop_com', tables: { wp_options: ['option_id', 'option_name'], wp_posts: ['ID'] } });
    expect(fake.calls.find((c) => c.input?.includes('COLUMNS'))?.input).toContain(`TABLE_SCHEMA = _utf8mb4 X'${hex('shop_com')}' ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    await expect(dbSchema(ctxFor(fake), 'a;b')).rejects.toMatchObject({ status: 400 });
  });

  it('unescapes what mysql --batch escaped', () => {
    expect(unescapeBatch('a\\nb\\tc\\\\d\\0')).toBe('a\nb\tc\\d\0');
  });
});

describe('the phpMyAdmin link', () => {
  it('points at a site Apache serves over HTTPS, the database own site first, and only when phpMyAdmin is there', () => {
    const tree = wpSiteTree();
    expect(phpMyAdminUrl(tree.config, 'local.shop.com')).toBeUndefined();
    const conf = join(dirname(tree.config.APACHE_SITES_ENABLED), 'conf-enabled', 'phpmyadmin.conf');
    mkdirSync(dirname(conf), { recursive: true });
    writeFileSync(conf, 'Alias /phpmyadmin /usr/share/phpmyadmin\n');
    expect(existsSync(conf)).toBe(true);
    expect(phpMyAdminUrl(tree.config, 'local.shop.com')).toBe('https://local.shop.com/phpmyadmin/');
    expect(phpMyAdminUrl(tree.config)).toBe('https://local.shop.com/phpmyadmin/');
    const bare = tempTree();
    mkdirSync(join(dirname(bare.config.APACHE_SITES_ENABLED), 'conf-enabled'), { recursive: true });
    writeFileSync(join(dirname(bare.config.APACHE_SITES_ENABLED), 'conf-enabled', 'phpmyadmin.conf'), '');
    expect(phpMyAdminUrl(bare.config)).toBe('http://localhost/phpmyadmin/');
  });
});

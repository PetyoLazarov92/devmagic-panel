import { readsTooMuch } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { RowsContext } from '../src/mysql-rows.js';
import { groupSlowLog, normalizeSql, resetSlowQueries, slowQueries } from '../src/mysql-slow.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const json = (...rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).join('\n');

/** A server that answers the variables read, then whatever `answer` gives for the rest. */
function fakeServer(version: string, vars: unknown[], answer: (sql: string) => string = () => '') {
  return fakeExec({
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: `${version}\n` };
      const sql = call.input ?? '';
      if (sql.includes('@@performance_schema')) return { stdout: json(vars) };
      return { stdout: answer(sql) };
    },
  });
}

const browse = (fake: ReturnType<typeof fakeExec>) => ({ config: wpSiteTree().config, exec: fake.exec, mysql, kept: () => [] });
const rows = (fake: ReturnType<typeof fakeExec>): RowsContext => ({ ...browse(fake), siteBusy: () => false });
const sqlOf = (fake: ReturnType<typeof fakeExec>) => fake.calls.map((c) => c.input ?? '').join('\n');

describe('normalizeSql', () => {
  it('turns values into ? so the same query with other values reads the same', () => {
    expect(normalizeSql("SELECT * FROM wp_postmeta WHERE post_id = 42 AND meta_key = '_price'")).toBe('SELECT * FROM wp_postmeta WHERE post_id = ? AND meta_key = ?');
    expect(normalizeSql("SELECT * FROM wp_postmeta WHERE post_id = 7 AND meta_key = 'it''s \\'x\\''")).toBe('SELECT * FROM wp_postmeta WHERE post_id = ? AND meta_key = ?');
  });

  it('keeps numbers that are part of a name, and folds lists and rows', () => {
    expect(normalizeSql('SELECT ID FROM wp_2_posts WHERE ID IN (1, 2, 3) LIMIT 0, 10')).toBe('SELECT ID FROM wp_2_posts WHERE ID IN (...) LIMIT ?, ?');
    expect(normalizeSql("INSERT INTO wp_options (a, b) VALUES ('x', 1), ('y', 2)")).toBe('INSERT INTO wp_options (a, b) VALUES (?, ?)');
  });

  it('drops comments and folds whitespace', () => {
    expect(normalizeSql('/* wandworks */ SELECT\n  1.5,\t0x1F -- note\nFROM wp_users')).toBe('SELECT ?, ? FROM wp_users');
  });
});

describe('groupSlowLog', () => {
  it('counts the same shape once, the heaviest first, and leaves out what a site does not run', () => {
    const { queries, since } = groupSlowLog([
      ['shop_com', "SELECT * FROM wp_postmeta WHERE meta_key = '_price'", 1.5, 200000, 10, '2026-11-07 10:00:00.000000'],
      ['shop_com', "SELECT * FROM wp_postmeta WHERE meta_key = '_sku'", 2.5, 200000, 30, '2026-11-07 10:05:00.000000'],
      ['shop_com', 'SELECT option_value FROM wp_options WHERE option_name = 1', 0.5, 10, 1, '2026-11-07 09:00:00.000000'],
      ['shop_com', 'SET NAMES utf8mb4', 3, 0, 0, '2026-11-07 09:00:00.000000'],
      ['shop_com', 'SELECT JSON_ARRAY(TABLE_NAME) FROM information_schema.TABLES', 9, 0, 0, '2026-11-07 09:00:00.000000'],
    ]);
    expect(queries.map((q) => [q.text, q.count, q.totalMs, q.avgMs, q.maxMs, q.rowsExamined])).toEqual([
      ['SELECT * FROM wp_postmeta WHERE meta_key = ?', 2, 4000, 2000, 2500, 400000],
      ['SELECT option_value FROM wp_options WHERE option_name = ?', 1, 500, 500, 500, 10],
    ]);
    expect(queries[0]?.sample).toBe("SELECT * FROM wp_postmeta WHERE meta_key = '_price'");
    expect(queries[0]?.lastSeen).toBe(new Date('2026-11-07T10:05:00').toISOString());
    expect(since).toBe(new Date('2026-11-07T09:00:00').toISOString());
    expect(readsTooMuch(queries[0] as (typeof queries)[number])).toBe(true);
    expect(readsTooMuch(queries[1] as (typeof queries)[number])).toBe(false);
  });
});

describe('slowQueries', () => {
  it("reads MySQL 8's statement statistics for one database, and needs no slow log", async () => {
    const fake = fakeServer('8.0.43', [1, 0, 'FILE', 10], (sql) =>
      sql.includes('events_statements_summary_by_digest')
        ? json(['shop_com', 'ab12', 'SELECT * FROM `wp_postmeta` WHERE `meta_key` = ?', "SELECT * FROM wp_postmeta WHERE meta_key = '_price'", 40, 8000, 900, 4000000, 400, 40, '2026-11-07 10:00:00.000000', '2026-11-06 08:00:00.000000'])
        : '',
    );
    const report = await slowQueries(browse(fake), 'shop_com');
    expect(report.source).toBe('statements');
    expect(report.since).toBe(new Date('2026-11-06T08:00:00').toISOString());
    expect(report.queries).toEqual([
      {
        id: 'ab12',
        database: 'shop_com',
        text: 'SELECT * FROM `wp_postmeta` WHERE `meta_key` = ?',
        sample: "SELECT * FROM wp_postmeta WHERE meta_key = '_price'",
        count: 40,
        totalMs: 8000,
        avgMs: 200,
        maxMs: 900,
        rowsExamined: 4000000,
        rowsSent: 400,
        noIndex: 40,
        lastSeen: new Date('2026-11-07T10:00:00').toISOString(),
      },
    ]);
    const sql = sqlOf(fake);
    expect(sql).toContain(`SCHEMA_NAME = _utf8mb4 X'${Buffer.from('shop_com').toString('hex')}'`);
    expect(sql).toContain("DIGEST_TEXT NOT LIKE '%JSON_ARRAY%'");
    expect(sql).toContain('SET SESSION TRANSACTION READ ONLY');
    // The password goes in the environment, never argv.
    expect(fake.calls.every((c) => !c.args.join(' ').includes('adminpw'))).toBe(true);
  });

  it('reads without samples on a MySQL too old to keep them', async () => {
    const fake = fakeExec({
      mysql: (call: FakeCall) => {
        if (call.args.includes('-e')) return { stdout: '8.0.2\n' };
        const sql = call.input ?? '';
        if (sql.includes('@@performance_schema')) return { stdout: json([1, 0, 'FILE', 10]) };
        if (sql.includes('QUERY_SAMPLE_TEXT')) return { code: 1, stdout: '', stderr: "ERROR 1054 (42S22): Unknown column 'QUERY_SAMPLE_TEXT' in 'field list'" };
        if (sql.includes('events_statements_summary_by_digest')) return { stdout: json(['shop_com', 'ab12', 'SELECT ?', null, 1, 5, 5, 1, 1, 0, null, null]) };
        return { stdout: '' };
      },
    });
    const report = await slowQueries(browse(fake));
    expect(report.queries).toHaveLength(1);
    expect(report.queries[0]?.sample).toBeUndefined();
  });

  it("groups MariaDB's slow log table when the slow log goes there", async () => {
    const fake = fakeServer('11.4.2-MariaDB', [0, 1, 'FILE,TABLE', 1], (sql) =>
      sql.includes('mysql.slow_log') ? json(['shop_com', "SELECT * FROM wp_posts WHERE post_type = 'product'", 1.25, 50000, 20, '2026-11-07 10:00:00.000000']) : '',
    );
    const report = await slowQueries(browse(fake), 'shop_com');
    expect(report.source).toBe('slowLog');
    expect(report.queries.map((q) => q.text)).toEqual(['SELECT * FROM wp_posts WHERE post_type = ?']);
    expect(report.note).toContain('slower than 1 s');
    expect(sqlOf(fake)).toContain(`WHERE db = _utf8mb4 X'${Buffer.from('shop_com').toString('hex')}'`);
  });

  it('says how to start counting when there is nothing to read', async () => {
    const off = await slowQueries(browse(fakeServer('11.4.2-MariaDB', [0, 0, 'FILE', 10])));
    expect(off).toMatchObject({ source: 'none', queries: [], slowLog: { on: false, toTable: false, aboveSeconds: 10 } });
    expect(off.note).toContain('Switch on the slow log');
    const fileOnly = await slowQueries(browse(fakeServer('11.4.2-MariaDB', [0, 1, 'FILE', 10])));
    expect(fileOnly.note).toContain('to a file only');
  });

  it('refuses a database name that is not one', async () => {
    await expect(slowQueries(browse(fakeServer('8.0.43', [1, 0, 'FILE', 10])), "x'; DROP TABLE wp_users; --")).rejects.toThrow(/database name/);
  });
});

describe('resetSlowQueries', () => {
  it('empties the statement statistics and the slow log table the server keeps', async () => {
    const fake = fakeServer('8.0.43', [1, 1, 'FILE,TABLE', 1]);
    const r = await resetSlowQueries(rows(fake));
    expect(r.stdout).toContain("MySQL's statement statistics and the slow log table");
    const sql = sqlOf(fake);
    expect(sql).toContain('TRUNCATE TABLE performance_schema.events_statements_summary_by_digest');
    expect(sql).toContain('TRUNCATE TABLE mysql.slow_log');
  });

  it('empties nothing where neither is kept', async () => {
    const fake = fakeServer('11.4.2-MariaDB', [0, 0, 'FILE', 10]);
    expect((await resetSlowQueries(rows(fake))).stdout).toContain('Nothing to empty');
    expect(sqlOf(fake)).not.toContain('TRUNCATE');
  });
});

import { existsSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { withoutPasswords } from '../src/actions.js';
import type { JobRuntime } from '../src/jobs.js';
import { cleanupsDir } from '../src/mysql-cleanup.js';
import type { RowsContext } from '../src/mysql-rows.js';
import { checkWrite, killQuery, mysqlProcesses, planned, planWrite } from '../src/mysql-write.js';
import { type FakeCall, fakeExec, tempTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const TABLES = [
  ['t', 'wp_posts', 'BASE TABLE', 'InnoDB', 4096],
  ['t', 'wp_postmeta', 'BASE TABLE', 'InnoDB', 2048],
  ['t', 'acme_parent', 'BASE TABLE', 'InnoDB', 100],
  ['t', 'acme_child', 'BASE TABLE', 'InnoDB', 100],
  ['t', 'acme_log', 'BASE TABLE', 'MyISAM', 100],
  ['d', 'shop_com'],
  ['d', 'reports'],
  ['d', 'mysql'],
  ['f', 'acme_child', 'acme_parent'],
];

function fakeDb(answer: (sql: string, call: FakeCall) => Partial<{ code: number; stdout: string; stderr: string }> | undefined = () => undefined) {
  return fakeExec({
    mysqldump: () => ({ stdout: 'DROP TABLE IF EXISTS `t`;\n' }),
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? '';
      const special = answer(sql, call);
      if (special) return special;
      if (sql.includes("JSON_ARRAY('t', TABLE_NAME")) return { stdout: TABLES.map((r) => JSON.stringify(r)).join('\n') };
      if (sql.includes('ROW_COUNT()')) return { stdout: '7\n' };
      if (sql.includes('SELECT TABLE_NAME, TABLE_TYPE')) return { stdout: 'wp_posts\tBASE TABLE\nwp_postmeta\tBASE TABLE\nacme_parent\tBASE TABLE\nacme_child\tBASE TABLE\nacme_log\tBASE TABLE\n' };
      return { stdout: '' };
    },
  });
}
const ctxFor = (fake: ReturnType<typeof fakeExec>, extra: Partial<RowsContext> = {}): RowsContext => ({ config: tempTree().config, exec: fake.exec, mysql, kept: () => [], siteBusy: () => false, now: () => new Date('2026-11-07T11:00:00Z'), ...extra });

describe('what SQL that writes would change', () => {
  it('saves the tables a statement names, aliases and all, and the ones a foreign key cascades into', async () => {
    const ctx = ctxFor(fakeDb());
    expect((await planned(ctx, 'shop_com', "UPDATE wp_posts p SET p.post_status = 'publish' WHERE p.ID IN (SELECT post_id FROM `wp_postmeta`)")).tables.map((t) => t.name)).toEqual(['wp_posts', 'wp_postmeta']);
    expect((await planned(ctx, 'shop_com', 'DELETE FROM acme_parent WHERE id = 1')).tables.map((t) => t.name)).toEqual(['acme_parent', 'acme_child']);
    // Words inside a string are data, never a table.
    expect((await planned(ctx, 'shop_com', "UPDATE wp_posts SET post_status = 'wp_postmeta'")).tables.map((t) => t.name)).toEqual(['wp_posts']);
    expect((await planned(ctx, 'shop_com', 'ALTER TABLE wp_posts ADD COLUMN acme_flag int')).rows).toBe(false);
  });

  it('refuses another database, accounts and rights, databases, files and statements that name no table', async () => {
    const ctx = ctxFor(fakeDb());
    const refused = (sql: string, why: RegExp) => expect(planned(ctx, 'shop_com', sql)).rejects.toThrow(why);
    await refused("UPDATE reports.acme SET x = 1", /names the database reports/);
    await refused('DELETE FROM `mysql`.`user`', /names the database mysql/);
    await refused('GRANT ALL ON *.* TO nobody', /not GRANT ALL/);
    await refused('CREATE DATABASE acme', /not CREATE DATABASE/);
    await refused('DROP DATABASE shop_com', /not DROP DATABASE/);
    await refused('CREATE USER acme', /not CREATE USER/);
    await refused("LOAD DATA INFILE '/etc/passwd' INTO TABLE wp_posts", /not LOAD DATA/);
    await refused('CREATE DEFINER = root VIEW v AS SELECT 1', /not CREATE DEFINER/);
    await refused('SET GLOBAL general_log = 1', /not SET GLOBAL/);
    await refused('UPDATE nothing_here SET x = 1', /names no table of shop_com/);
    await refused('DELETE FROM wp_posts; DELETE FROM wp_postmeta', /One statement at a time/);
    await expect(planned(ctx, 'mysql', 'DELETE FROM user')).rejects.toThrow(/MySQL's own/);
    await expect(planned(ctxFor(fakeDb(), { kept: () => [{ name: 'shop_old', site: 'local.shop.com' }] }), 'shop_old', 'DELETE FROM wp_posts')).rejects.toThrow(/kept for a site/);
  });

  it('refuses when the disk has no room for the copy', async () => {
    const huge = fakeDb((sql) => (sql.includes("JSON_ARRAY('t', TABLE_NAME") ? { stdout: [JSON.stringify(['t', 'wp_posts', 'BASE TABLE', 'InnoDB', 2 ** 52])].join('\n') } : undefined));
    await expect(planned(ctxFor(huge), 'shop_com', 'DELETE FROM wp_posts')).rejects.toThrow(/needs up to .* and the disk has .* free/);
  });

  it('tries a change of rows in a transaction it rolls back, but only on tables that can roll back', async () => {
    const fake = fakeDb();
    const ctx = ctxFor(fake);
    expect(await checkWrite(ctx, 'shop_com', { sql: "UPDATE wp_posts SET post_status = 'draft' -- all of them" })).toMatchObject({ statement: 'UPDATE', rows: 7, tables: [{ name: 'wp_posts', bytes: 4096 }], bytes: 4096 });
    const tried = fake.calls.find((c) => c.input?.includes('ROLLBACK')) as FakeCall;
    expect(tried.input).toContain("START TRANSACTION;\nUPDATE wp_posts SET post_status = 'draft' -- all of them\n;\nSELECT ROW_COUNT();\nROLLBACK;\n");
    expect(tried.args).toEqual(expect.arrayContaining(['--binary-mode', '--database=shop_com']));
    expect(tried.input).not.toContain('COMMIT');
    expect(await checkWrite(ctx, 'shop_com', { sql: "UPDATE acme_log SET msg = 'x'" })).toMatchObject({ rows: null, why: expect.stringMatching(/acme_log \(MyISAM\) cannot roll back/) });
    expect(await checkWrite(ctx, 'shop_com', { sql: 'ALTER TABLE wp_posts ADD COLUMN x int' })).toMatchObject({ rows: null, why: expect.stringMatching(/MySQL commits it at once/) });
    await expect(checkWrite(ctx, 'shop_com', { sql: 'GRANT ALL ON *.* TO x' })).rejects.toMatchObject({ status: 400 });
    await expect(checkWrite(ctxFor(fakeDb((sql) => (sql.includes('ROLLBACK') ? { code: 1, stderr: "ERROR 1054 (42S22) at line 4: Unknown column 'nope'" } : undefined))), 'shop_com', { sql: 'UPDATE wp_posts SET nope = 1' })).rejects.toMatchObject({
      status: 400,
      message: "ERROR 1054 (42S22): Unknown column 'nope'",
    });
  });
});

async function run(steps: Awaited<ReturnType<typeof planWrite>>['steps']) {
  const undos: Array<() => Promise<unknown>> = [];
  const job: JobRuntime = { onUndo: (_l, f) => void undos.push(f), progress: () => undefined };
  const out = [];
  for (const s of steps) out.push(await s.run(job));
  return { out, undos };
}

describe('running SQL that writes', () => {
  it('saves its tables whole, runs a change of rows in a transaction, and names it by kind and tables, never its text', async () => {
    const fake = fakeDb();
    const ctx = ctxFor(fake);
    const { title, steps } = await planWrite(ctx, { database: 'shop_com', sql: "UPDATE wp_posts SET post_status = 'alex.morgan@acme.com'", confirm: 'shop_com' });
    expect(title).toBe('UPDATE on wp_posts');
    const { out, undos } = await run(steps);
    expect(out[1]).toMatchObject({ code: 0, stdout: '7 rows changed. Undo puts the tables back as they were before it, for 14 days' });
    const dump = fake.calls.find((c) => c.file === 'mysqldump') as FakeCall;
    expect(dump.args).not.toContain('--insert-ignore');
    expect(dump.args).not.toContain('--no-create-info');
    expect(dump.args.slice(-3)).toEqual(['--', 'shop_com', 'wp_posts']);
    expect(fake.calls.find((c) => c.input?.includes('COMMIT'))?.input).toContain("START TRANSACTION;\nUPDATE wp_posts SET post_status = 'alex.morgan@acme.com'\n;\nSELECT ROW_COUNT();\nCOMMIT;\n");
    expect(undos).toHaveLength(1);
    expect(withoutPasswords({ database: 'shop_com', sql: 'UPDATE ...', confirm: 'shop_com' })).toEqual({ database: 'shop_com', sql: '(hidden)', confirm: 'shop_com' });
  });

  it('keeps no copy when the statement fails, and notes what a statement made so Undo deletes it', async () => {
    const failing = fakeDb((sql) => (sql.includes('COMMIT') ? { code: 1, stderr: "ERROR 1054 (42S22): Unknown column 'nope'" } : undefined));
    const ctx = ctxFor(failing);
    const { out } = await run((await planWrite(ctx, { database: 'shop_com', sql: 'UPDATE wp_posts SET nope = 1', confirm: 'shop_com' })).steps);
    expect(out[1]).toMatchObject({ code: 1 });
    expect(existsSync(cleanupsDir(ctx.config)) ? readdirSync(cleanupsDir(ctx.config)) : []).toEqual([]);

    const creating = fakeDb((sql) => (sql.includes('SELECT TABLE_NAME, TABLE_TYPE') ? { stdout: 'wp_posts\tBASE TABLE\nacme_new\tBASE TABLE\nacme_view\tVIEW\n' } : undefined));
    const made = ctxFor(creating);
    const { title, steps } = await planWrite(made, { database: 'shop_com', sql: 'CREATE TABLE acme_new (id int)', confirm: 'shop_com' });
    expect(title).toBe('CREATE on a new table');
    const { out: done, undos } = await run(steps);
    expect(done[1]).toMatchObject({ stdout: 'done; made acme_new, acme_view. Undo deletes what it made, for 14 days' });
    await undos[0]?.();
    expect(creating.calls.filter((c) => c.input?.includes('DROP ')).map((c) => c.input?.split('\n')[1])).toEqual(['DROP TABLE IF EXISTS `acme_new`;', 'DROP VIEW IF EXISTS `acme_view`;']);
    expect(readdirSync(cleanupsDir(made.config))).toEqual([]);
  });

  it('waits while a job works on the site that uses the database', async () => {
    const { wpSiteTree } = await import('./helpers.js');
    const tree = wpSiteTree();
    await expect(planWrite({ ...ctxFor(fakeDb()), config: tree.config, siteBusy: () => true }, { database: 'shop_com', sql: 'DELETE FROM wp_posts', confirm: 'shop_com' })).rejects.toThrow(/local.shop.com is busy/);
  });
});

describe('processes', () => {
  it('lists what MySQL runs, without the panel connection', async () => {
    const fake = fakeDb((sql) => (sql.includes('PROCESSLIST') ? { stdout: [JSON.stringify([41, 'shop_com', 'localhost', 'shop_com', 'Query', 12, 'Sending data', 'SELECT SLEEP(30)']), JSON.stringify([5, 'event_scheduler', 'localhost', null, 'Daemon', 900, 'Waiting on empty queue', null])].join('\n') } : undefined));
    const list = await mysqlProcesses({ config: tempTree().config, exec: fake.exec, mysql, kept: () => [] });
    expect(list).toEqual([
      { id: 41, user: 'shop_com', host: 'localhost', db: 'shop_com', command: 'Query', seconds: 12, state: 'Sending data', info: 'SELECT SLEEP(30)' },
      { id: 5, user: 'event_scheduler', host: 'localhost', command: 'Daemon', seconds: 900, state: 'Waiting on empty queue' },
    ]);
    expect(fake.calls.find((c) => c.input?.includes('PROCESSLIST'))?.input).toContain('WHERE ID <> CONNECTION_ID()');
  });

  it("stops a statement, never MySQL's own threads or a connection that runs nothing", async () => {
    const answers: Record<number, string> = { 41: 'shop_com\tQuery\n', 5: 'event_scheduler\tDaemon\n', 7: 'shop_com\tSleep\n' };
    const fake = fakeDb((sql) => {
      const id = /WHERE ID = (\d+)/.exec(sql)?.[1];
      return id ? { stdout: answers[Number(id)] ?? '' } : undefined;
    });
    const ctx = ctxFor(fake);
    expect((await killQuery(ctx, { id: 41 })).stdout).toBe('stopped the statement 41 ran for shop_com');
    expect(fake.calls.some((c) => c.input?.includes('KILL QUERY 41;'))).toBe(true);
    await expect(killQuery(ctx, { id: 5 })).rejects.toThrow(/MySQL's own/);
    await expect(killQuery(ctx, { id: 7 })).rejects.toThrow(/runs no statement now/);
    await expect(killQuery(ctx, { id: 99 })).rejects.toThrow(/runs nothing with id 99/);
  });
});

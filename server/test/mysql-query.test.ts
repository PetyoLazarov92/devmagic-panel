import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { checkEnvironment } from '../src/environment.js';
import { Jobs } from '../src/jobs.js';
import { readOnlyAccountSql } from '../src/mysql-admin.js';
import type { BrowseContext } from '../src/mysql-browse.js';
import { oneStatement, parseMysqlXml, runQuery } from '../src/mysql-query.js';
import type { Secrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { type FakeCall, fakeExec, healthyResponses, tempTree } from './helpers.js';

const admin = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const readOnly = { user: 'devmagic_panel_ro', host: 'localhost', password: 'ropw-0123456789abcdef' };

describe('one statement that reads', () => {
  it('finds the statement and its kind past comments, parentheses and a final semicolon', () => {
    expect(oneStatement('  -- the biggest\n/* note */ (SELECT 1) ;  ')).toEqual({ text: '-- the biggest\n/* note */ (SELECT 1)', kind: 'SELECT', code: '(SELECT 1)' });
    // Strings are emptied in code, backticked names kept: what MySQL reads as names.
    expect(oneStatement("UPDATE `shop`.wp_options SET v = 'other_db.x' -- old.y", false).code).toBe("UPDATE `shop`.wp_options SET v = ''");
    expect(oneStatement('with x as (select 1) select * from x').kind).toBe('WITH');
    expect(oneStatement('show tables').kind).toBe('SHOW');
    expect(oneStatement("# hash comment\nDESC wp_options").kind).toBe('DESC');
  });

  it('reads quotes as MySQL does, so a semicolon or a backslash inside one counts for nothing', () => {
    expect(oneStatement("SELECT 'a;b', \"c;d\", `e;f`, 'it''s', 'x\\';y' FROM t").kind).toBe('SELECT');
    expect(oneStatement("SELECT '\\\\! id'").kind).toBe('SELECT');
  });

  it('refuses a second statement, a statement that changes, and what only the client or MySQL would run', () => {
    expect(() => oneStatement('SELECT 1; DROP TABLE wp_options')).toThrow('One statement at a time');
    expect(() => oneStatement('SELECT 1; SELECT 2;')).toThrow('One statement at a time');
    expect(() => oneStatement('DELETE FROM wp_options')).toThrow(/DELETE changes or does not read/);
    expect(() => oneStatement('SET @a = 1')).toThrow(/SET changes/);
    expect(() => oneStatement('delimiter //\nSELECT 1//')).toThrow(/DELIMITER/);
    expect(() => oneStatement('SELECT 1 \\! id')).toThrow(/backslash outside a string/);
    expect(() => oneStatement('/*!50000 DROP TABLE x */ SELECT 1')).toThrow(/\/\*! comment/);
    expect(() => oneStatement("SELECT 'open")).toThrow(/quote is not closed/);
    expect(() => oneStatement('SELECT 1 /* open')).toThrow(/comment is not closed/);
    expect(() => oneStatement('  -- only a comment')).toThrow(/Write a statement/);
  });
});

describe('mysql --xml', () => {
  it('keeps NULL apart from the text NULL, entities decoded and every column in order', () => {
    const xml = `<?xml version="1.0"?>
<resultset statement="SELECT ..." xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="id">1</field>
\t<field name="v" xsi:nil="true" />
\t<field name="v">NULL</field>
\t<field name="t">&lt;b&gt; &amp; &quot;x&quot; &#10;</field>
\t<field name="e"></field>
  </row>
</resultset>
`;
    expect(parseMysqlXml(xml)).toEqual([{ columns: ['id', 'v', 'v', 't', 'e'], rows: [['1', null, 'NULL', '<b> & "x" \n', '']] }]);
    expect(parseMysqlXml('<resultset statement="SELECT 1 WHERE 0" xmlns:xsi="x">\n</resultset>')).toEqual([{ columns: [], rows: [] }]);
  });
});

function fakeRunner(answer: (call: FakeCall) => Partial<{ code: number; stdout: string; stderr: string }>) {
  return fakeExec({
    mysql: (call) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      return answer(call);
    },
  });
}

const ctxFor = (fake: ReturnType<typeof fakeExec>, extra: Partial<BrowseContext> = {}): BrowseContext => ({ config: tempTree().config, exec: fake.exec, mysql: admin, readOnly, kept: () => [], ...extra });
const xmlRows = (n: number) => `<resultset statement="x" xmlns:xsi="x">${Array.from({ length: n }, (_, i) => `<row><field name="n">${i}</field></row>`).join('')}</resultset>`;

describe('the SQL runner', () => {
  it('runs one statement as the read-only account, read only, time and row limited, as SQL only', async () => {
    const fake = fakeRunner(() => ({ stdout: xmlRows(2) }));
    const result = await runQuery(ctxFor(fake), 'shop_com', { sql: 'SELECT option_name FROM wp_options -- the names\n;' });
    expect(result).toMatchObject({ statement: 'SELECT', explain: false, columns: ['n'], rows: [['0'], ['1']], hasMore: false });
    const call = fake.calls.find((c) => c.input?.includes('wp_options')) as FakeCall;
    expect(call.args).toEqual(['--xml', '--binary-mode', '--default-character-set=utf8mb4', '--user', 'devmagic_panel_ro', '--host', 'localhost', '--database=shop_com']);
    expect(call.env).toEqual({ MYSQL_PWD: 'ropw-0123456789abcdef' });
    // The final semicolon on its own line, out of the statement's -- comment.
    expect(call.input).toBe('SET SESSION TRANSACTION READ ONLY;\nSET SESSION max_execution_time = 30000;\nSET SESSION sql_select_limit = 1001;\nSELECT option_name FROM wp_options -- the names\n;\n');
  });

  it('shows 1,000 rows and says when there are more', async () => {
    const result = await runQuery(ctxFor(fakeRunner(() => ({ stdout: xmlRows(1001) }))), 'shop_com', { sql: 'SELECT n FROM t' });
    expect(result.rows).toHaveLength(1000);
    expect(result.hasMore).toBe(true);
  });

  it('explains a SELECT, and refuses to explain anything else', async () => {
    const fake = fakeRunner(() => ({ stdout: xmlRows(1) }));
    expect((await runQuery(ctxFor(fake), 'shop_com', { sql: 'SELECT 1', explain: true })).explain).toBe(true);
    expect(fake.calls.at(-1)?.input).toContain('\nEXPLAIN SELECT 1\n;\n');
    await expect(runQuery(ctxFor(fake), 'shop_com', { sql: 'SHOW TABLES', explain: true })).rejects.toMatchObject({ status: 400 });
  });

  it("says MySQL's own error, without the preamble's line number", async () => {
    const fake = fakeRunner(() => ({ code: 1, stderr: "ERROR 1142 (42000) at line 4: UPDATE command denied to user 'devmagic_panel_ro'@'localhost' for table 'wp_options'\n" }));
    await expect(runQuery(ctxFor(fake), 'shop_com', { sql: 'WITH x AS (SELECT 1) UPDATE wp_options SET autoload = 1' })).rejects.toMatchObject({
      status: 400,
      message: "ERROR 1142 (42000): UPDATE command denied to user 'devmagic_panel_ro'@'localhost' for table 'wp_options'",
    });
  });

  it('stops the query on the server when it runs past the limit', async () => {
    let clock = 0;
    const fake = fakeRunner((call) => {
      if (call.input?.includes('PROCESSLIST')) return { stdout: '41\n77\n' };
      if (call.input?.includes('KILL QUERY')) return {};
      clock = 31_000;
      return { code: 127, stderr: 'stopped: it took longer than 35 s' };
    });
    await expect(runQuery(ctxFor(fake), 'shop_com', { sql: 'SELECT SLEEP(60)' }, () => clock)).rejects.toMatchObject({ status: 504 });
    const list = fake.calls.find((c) => c.input?.includes('PROCESSLIST')) as FakeCall;
    expect(list.input).toContain(`USER = _utf8mb4 X'${Buffer.from('devmagic_panel_ro').toString('hex')}' AND COMMAND = 'Query' AND TIME >= 28`);
    expect(list.args).toContain('devmagic_panel');
    expect(fake.calls.find((c) => c.input?.includes('KILL'))?.input).toBe('KILL QUERY 41;\nKILL QUERY 77;');
  });

  it('says when the result is too big to send', async () => {
    const fake = fakeRunner(() => ({ code: 127, stdout: 'x'.repeat(4 * 1024 * 1024), stderr: '' }));
    await expect(runQuery(ctxFor(fake), 'shop_com', { sql: 'SELECT * FROM wp_postmeta' })).rejects.toMatchObject({ status: 413 });
  });

  it('needs the read-only account, a database name and a statement that reads', async () => {
    const fake = fakeRunner(() => ({ stdout: '' }));
    await expect(runQuery(ctxFor(fake, { readOnly: undefined }), 'shop_com', { sql: 'SELECT 1' })).rejects.toMatchObject({ status: 409 });
    await expect(runQuery(ctxFor(fake), 'shop;com', { sql: 'SELECT 1' })).rejects.toMatchObject({ status: 400 });
    await expect(runQuery(ctxFor(fake), 'shop_com', { sql: 'DROP DATABASE shop_com' })).rejects.toMatchObject({ status: 400 });
    expect(fake.calls.filter((c) => c.input)).toEqual([]);
  });
});

describe('the read-only account', () => {
  it('gets SELECT and SHOW VIEW only, any other right taken back, its password checked for SQL', () => {
    const sql = readOnlyAccountSql('pw-0123456789abcdefgh');
    expect(sql).toContain("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'devmagic_panel_ro'@'localhost';");
    expect(sql).toContain("GRANT SELECT, SHOW VIEW ON *.* TO 'devmagic_panel_ro'@'localhost';");
    expect(() => readOnlyAccountSql("x'; DROP USER root; --")).toThrow(/unsafe password/);
  });

  it('is made with the admin account, its password on stdin, and saved next to it in secrets.json', async () => {
    const tree = tempTree();
    const file = join(tree.root, 'config', 'secrets.json');
    mkdirSync(dirname(file), { recursive: true });
    const secrets: Secrets = { panelPasswordHash: 'x', mysql: admin, anthropic: { apiKey: 'sk-ant-test' } };
    writeFileSync(file, JSON.stringify(secrets));
    const fake = fakeExec({ mysql: () => ({ stdout: '1\n' }) });
    const store = new RunStore(':memory:');
    const ctx: ActionContext = { config: tree.config, exec: fake.exec, store, dmpRoot: '/x', wpcoreBin: '/x', wpcoreConf: '/x', home: tree.root, jobs: new Jobs(store), uploadsDir: join(tree.root, 'uploads'), secrets, secretsFile: file };
    const result = await runAction(ctx, 'mysql.makeReadOnlyAccount', {});
    expect(result.ok).toBe(true);
    const made = fake.calls[0] as FakeCall;
    expect(made.args).toEqual(['--batch', '--skip-column-names', '--user', 'devmagic_panel', '--host', 'localhost']);
    expect(made.input).toMatch(/^CREATE USER IF NOT EXISTS 'devmagic_panel_ro'@'localhost' IDENTIFIED BY '[A-Za-z0-9_-]{32}';/);
    const password = /IDENTIFIED BY '([^']+)'/.exec(made.input ?? '')?.[1] as string;
    expect(fake.calls.flatMap((c) => c.args).join(' ')).not.toContain(password);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Secrets;
    expect(saved).toMatchObject({ mysql: admin, anthropic: { apiKey: 'sk-ant-test' }, mysqlReadOnly: { user: 'devmagic_panel_ro', host: 'localhost', password } });
    expect(store.recent()[0]?.output ?? '').not.toContain(password);
  });

  it('is offered in the machine checks when it is not made or does not sign in', async () => {
    const tree = tempTree();
    const base = healthyResponses();
    const run = (secrets: Secrets) => checkEnvironment({ config: tree.config, exec: fakeExec({ ...base, 'mysql --user': (c) => (c.env?.MYSQL_PWD === 'stale' ? { code: 1, stderr: "ERROR 1045 (28000): Access denied for user 'devmagic_panel_ro'@'localhost'" } : { stdout: '1\n' }) }).exec, secrets, paths: tree.hostPaths, dmpRoot: '/x' });
    const find = async (secrets: Secrets) => (await run(secrets)).checks.find((c) => c.id === 'mysql.readonly');
    expect(await find({ panelPasswordHash: 'x', mysql: admin })).toMatchObject({ status: 'warn', optional: true, fixes: [{ action: 'mysql.makeReadOnlyAccount', label: 'Make it' }] });
    expect(await find({ panelPasswordHash: 'x', mysql: admin, mysqlReadOnly: readOnly })).toMatchObject({ status: 'ok' });
    expect(await find({ panelPasswordHash: 'x', mysql: admin, mysqlReadOnly: { ...readOnly, password: 'stale' } })).toMatchObject({ status: 'warn', fixes: [{ label: 'Make it again' }] });
  });
});

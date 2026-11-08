import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext, withoutPasswords } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { deleteRows, insertRow, listRowChanges, pruneRowChanges, rowChangesDir, type RowsContext, undoRowChange, updateRow } from '../src/mysql-rows.js';
import { RunStore } from '../src/store.js';
import { type FakeCall, fakeExec, tempTree, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

/** wp_options with an auto_increment key, a text value, a float and a binary column, as information_schema describes it. */
const META = [
  ['t', 'wp_options', 'BASE TABLE', 'InnoDB', 3, 16384, 16384, 0, 'utf8mb4_unicode_520_ci', null],
  ['c', 'option_id', 'bigint unsigned', 'bigint', 'NO', null, 'PRI', 'auto_increment', null, null, ''],
  ['c', 'option_name', 'varchar(191)', 'varchar', 'NO', '', 'UNI', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''],
  ['c', 'option_value', 'longtext', 'longtext', 'YES', null, '', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''],
  ['c', 'ratio', 'float', 'float', 'YES', null, '', '', null, null, ''],
  ['c', 'hash', 'varbinary(4)', 'varbinary', 'YES', null, '', '', null, null, ''],
  ['c', 'twice', 'double', 'double', 'YES', null, '', 'VIRTUAL GENERATED', null, null, ''],
  ['i', 'PRIMARY', 0, 1, 'option_id', 'BTREE', 3],
];
const json = (...rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).join('\n');

/** MySQL for the browser's reads and the row writes; write answers what the change read FOR UPDATE. */
function fakeRows(write: (sql: string) => Partial<{ code: number; stdout: string; stderr: string }>, table = META) {
  return fakeExec({
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? '';
      if (sql.includes("SELECT JSON_ARRAY('t'")) return { stdout: json(...table) };
      return write(sql);
    },
  });
}

function ctxFor(fake: ReturnType<typeof fakeExec>, extra: Partial<RowsContext> = {}): RowsContext {
  return { config: tempTree().config, exec: fake.exec, mysql, kept: () => [], siteBusy: () => false, now: () => new Date('2026-11-07T10:15:00Z'), ...extra };
}
const writes = (fake: ReturnType<typeof fakeExec>) => fake.calls.filter((c) => c.input?.includes('START TRANSACTION')).map((c) => c.input as string);
const saved = (ctx: RowsContext, id: string) => JSON.parse(readFileSync(join(rowChangesDir(ctx.config), `${id}.json`), 'utf8')) as Record<string, unknown>;

const BEFORE = ['7', 'blogname', 'Wandworks Bikes', '1.1', '00FF', '2.2'];

describe('changing a row', () => {
  it('changes it only while the changed columns hold what you saw, after saving it as it was', async () => {
    const fake = fakeRows(() => ({ stdout: JSON.stringify(BEFORE) }));
    const ctx = ctxFor(fake);
    const r = await updateRow(ctx, { database: 'shop_com', table: 'wp_options', rowKey: ['7'], rowValues: { option_value: "Wandworks's \"Bikes\"", ratio: '2.5' }, rowWas: { option_value: 'Wandworks Bikes', ratio: '1.1' } });
    expect(r).toMatchObject({ code: 0, change: '20261107-101500-' + (r.change as string).slice(-6), stdout: 'changed 2 columns of a row of wp_options; Undo puts it back' });
    const [sql] = writes(fake);
    const was = "`option_id` <=> 7 AND `option_value` <=> CONVERT(_utf8mb4 X'" + hex('Wandworks Bikes') + "' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci AND CAST(`ratio` AS CHAR) = _utf8mb4 X'" + hex('1.1') + "'";
    expect(sql).toContain(`SELECT JSON_ARRAY(CAST(\`option_id\` AS CHAR), CAST(\`option_name\` AS CHAR), CAST(\`option_value\` AS CHAR), CAST(\`ratio\` AS CHAR), HEX(\`hash\`), CAST(\`twice\` AS CHAR)) FROM \`shop_com\`.\`wp_options\` WHERE ${was} FOR UPDATE;`);
    expect(sql).toContain(`UPDATE \`shop_com\`.\`wp_options\` SET \`option_value\` = CONVERT(_utf8mb4 X'${hex("Wandworks's \"Bikes\"")}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci, \`ratio\` = 2.5 WHERE ${was};`);
    expect(sql).toMatch(/COMMIT;\n$/);
    expect(sql).not.toContain("Wandworks's");
    const call = fake.calls.find((c) => c.input?.includes('START TRANSACTION')) as FakeCall;
    expect(call.args).toContain('--binary-mode');
    expect(call.input).toMatch(/^SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';/);
    const copy = saved(ctx, r.change as string);
    expect(copy).toMatchObject({ kind: 'update', database: 'shop_com', table: 'wp_options', primaryKey: ['option_id'], binary: ['hash'], rows: [{ option_id: '7', option_value: 'Wandworks Bikes', hash: '00FF' }], set: { option_value: "Wandworks's \"Bikes\"", ratio: '2.5' } });
    const file = join(rowChangesDir(ctx.config), `${r.change}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(rowChangesDir(ctx.config)).mode & 0o777).toBe(0o700);
  });

  it('changes nothing when the row changed since, and says so', async () => {
    const ctx = ctxFor(fakeRows(() => ({ stdout: '' })));
    await expect(updateRow(ctx, { database: 'shop_com', table: 'wp_options', rowKey: ['7'], rowValues: { option_value: 'x' }, rowWas: { option_value: 'y' } })).rejects.toThrow(/changed since you opened it/);
    expect(existsSync(rowChangesDir(ctx.config))).toBe(false);
  });

  it('refuses the key, a binary or computed column, a value it was not told, and a number that is none', async () => {
    const ctx = ctxFor(fakeRows(() => ({ stdout: JSON.stringify(BEFORE) })));
    const change = (rowValues: Record<string, string | null>, rowWas: Record<string, string | null> = rowValues) => updateRow(ctx, { database: 'shop_com', table: 'wp_options', rowKey: ['7'], rowValues, rowWas });
    await expect(change({ option_id: '8' })).rejects.toThrow(/primary key/);
    await expect(change({ hash: 'AA' })).rejects.toThrow(/binary/);
    await expect(change({ twice: '1' })).rejects.toThrow(/computed by MySQL/);
    await expect(change({ option_value: 'x' }, { option_name: 'y' })).rejects.toThrow(/value option_value had is missing/);
    await expect(change({ ratio: 'lots' }, { ratio: '1.1' })).rejects.toThrow(/holds numbers/);
    await expect(change({ nope: 'x' })).rejects.toThrow(/No column called nope/);
  });

  it("leaves MySQL's own databases, kept ones, a view, a table without a key and a busy site alone", async () => {
    const fake = fakeRows(() => ({ stdout: '' }));
    const input = { table: 'wp_options', rowKeys: [['7']] };
    await expect(deleteRows(ctxFor(fake), { database: 'mysql', ...input })).rejects.toThrow(/MySQL's own/);
    await expect(deleteRows(ctxFor(fake, { kept: () => [{ name: 'shop_com_old', site: 'local.shop.com' }] }), { database: 'shop_com_old', ...input })).rejects.toThrow(/kept for a site/);
    const view = fakeRows(() => ({ stdout: '' }), [['t', 'wp_options', 'VIEW', null, null, null, null, null, null, null], ...META.slice(1)]);
    await expect(deleteRows(ctxFor(view), { database: 'shop_com', ...input })).rejects.toThrow(/is a view/);
    const keyless = fakeRows(() => ({ stdout: '' }), META.filter((r) => r[0] !== 'i'));
    await expect(deleteRows(ctxFor(keyless), { database: 'shop_com', ...input })).rejects.toThrow(/no primary key/);
    const tree = wpSiteTree();
    await expect(deleteRows({ ...ctxFor(fake), config: tree.config, siteBusy: (s) => s === 'local.shop.com' }, { database: 'shop_com', ...input })).rejects.toThrow(/local.shop.com is busy/);
    expect(writes(fake)).toEqual([]);
  });
});

describe('adding and deleting rows', () => {
  it('adds a row, reading it back by the number MySQL picked', async () => {
    const fake = fakeRows(() => ({ stdout: JSON.stringify(['8', 'wandworks_new', 'v', null, null, null]) }));
    const ctx = ctxFor(fake);
    const r = await insertRow(ctx, { database: 'shop_com', table: 'wp_options', rowValues: { option_name: 'wandworks_new', option_value: 'v', ratio: null } });
    const [sql] = writes(fake);
    expect(sql).toContain(`INSERT INTO \`shop_com\`.\`wp_options\` (\`option_name\`, \`option_value\`, \`ratio\`) VALUES (CONVERT(_utf8mb4 X'${hex('wandworks_new')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci, CONVERT(_utf8mb4 X'${hex('v')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci, NULL);`);
    expect(sql).toContain('WHERE `option_id` = LAST_INSERT_ID();');
    expect(saved(ctx, r.change as string)).toMatchObject({ kind: 'insert', rows: [{ option_id: '8', option_name: 'wandworks_new' }] });
  });

  it('deletes rows by key after saving each, and says which were gone already', async () => {
    const fake = fakeRows(() => ({ stdout: JSON.stringify(BEFORE) }));
    const ctx = ctxFor(fake);
    const r = await deleteRows(ctx, { database: 'shop_com', table: 'wp_options', rowKeys: [['7'], ['9']] });
    expect(r.stdout).toBe('deleted 1 row of wp_options (1 row had gone already); Undo puts them back');
    expect(writes(fake)[0]).toContain('DELETE FROM `shop_com`.`wp_options` WHERE (`option_id` <=> 7) OR (`option_id` <=> 9);');
    expect(saved(ctx, r.change as string)).toMatchObject({ kind: 'delete', rows: [{ option_id: '7' }] });
  });
});

describe('undo', () => {
  it('puts a changed row back only while it holds what the change left, then lets the copy go', async () => {
    let answer = JSON.stringify(BEFORE);
    const fake = fakeRows(() => ({ stdout: answer }));
    const ctx = ctxFor(fake);
    const { change } = await updateRow(ctx, { database: 'shop_com', table: 'wp_options', rowKey: ['7'], rowValues: { option_value: 'New' }, rowWas: { option_value: 'Wandworks Bikes' } });
    answer = '0';
    await expect(undoRowChange(ctx, { database: 'shop_com', table: 'wp_options', change: change as string })).rejects.toThrow(/changed again since/);
    answer = '1';
    const r = await undoRowChange(ctx, { database: 'shop_com', table: 'wp_options', change: change as string });
    expect(r.stdout).toBe('put a row of wp_options back as it was');
    const sql = writes(fake).at(-1) as string;
    expect(sql).toContain(`UPDATE \`shop_com\`.\`wp_options\` SET \`option_value\` = CONVERT(_utf8mb4 X'${hex('Wandworks Bikes')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci WHERE \`option_id\` <=> 7 AND \`option_value\` <=> CONVERT(_utf8mb4 X'${hex('New')}'`);
    expect(listRowChanges(ctx.config, 'shop_com')).toEqual([]);
    await expect(undoRowChange(ctx, { database: 'shop_com', table: 'wp_options', change: change as string })).rejects.toThrow(/not saved any more/);
  });

  it('puts deleted rows back with their binary values and without computed columns', async () => {
    let answer = JSON.stringify(BEFORE);
    const fake = fakeRows(() => ({ stdout: answer }));
    const ctx = ctxFor(fake);
    const { change } = await deleteRows(ctx, { database: 'shop_com', table: 'wp_options', rowKeys: [['7']] });
    answer = '1';
    await undoRowChange(ctx, { database: 'shop_com', table: 'wp_options', change: change as string });
    expect(writes(fake).at(-1)).toContain(`INSERT INTO \`shop_com\`.\`wp_options\` (\`option_id\`, \`option_name\`, \`option_value\`, \`ratio\`, \`hash\`) VALUES (7, CONVERT(_utf8mb4 X'${hex('blogname')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci, CONVERT(_utf8mb4 X'${hex('Wandworks Bikes')}' USING utf8mb4) COLLATE utf8mb4_unicode_520_ci, 1.1, X'00FF');`);
  });

  it('deletes an added row, and refuses a change saved for another table', async () => {
    let answer = JSON.stringify(['8', 'wandworks_new', 'v', null, null, null]);
    const fake = fakeRows(() => ({ stdout: answer }));
    const ctx = ctxFor(fake);
    const { change } = await insertRow(ctx, { database: 'shop_com', table: 'wp_options', rowValues: { option_name: 'wandworks_new' } });
    await expect(undoRowChange(ctx, { database: 'shop_com', table: 'wp_posts', change: change as string })).rejects.toThrow(/was to shop_com.wp_options/);
    answer = '1';
    await undoRowChange(ctx, { database: 'shop_com', table: 'wp_options', change: change as string });
    expect(writes(fake).at(-1)).toContain('DELETE FROM `shop_com`.`wp_options` WHERE `option_id` <=> 8;');
  });

  it('lets copies older than 14 days go', async () => {
    const ctx = ctxFor(fakeRows(() => ({ stdout: JSON.stringify(BEFORE) })));
    const { change } = await deleteRows(ctx, { database: 'shop_com', table: 'wp_options', rowKeys: [['7']] });
    const dir = rowChangesDir(ctx.config);
    const old = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(join(dir, `${change}.json`), old, old);
    expect(pruneRowChanges(dir)).toEqual([`${change}.json`]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('row changes as actions', () => {
  it('answer with the saved copy for Undo, and keep row data out of run history', async () => {
    const tree = tempTree();
    const fake = fakeRows(() => ({ stdout: JSON.stringify(BEFORE) }));
    const store = new RunStore(':memory:');
    const ctx: ActionContext = { config: tree.config, exec: fake.exec, store, dmpRoot: '/x', wpcoreBin: '/x', wpcoreConf: '/x', home: tree.root, jobs: new Jobs(store), uploadsDir: join(tree.root, 'uploads'), secrets: { panelPasswordHash: 'x', mysql } };
    const result = await runAction(ctx, 'mysql.updateRow', { database: 'shop_com', table: 'wp_options', rowKey: ['7'], rowValues: { option_value: 'alex.morgan@wandworks.example' }, rowWas: { option_value: 'Wandworks Bikes' } });
    expect(result).toMatchObject({ ok: true, data: { backup: expect.stringMatching(/^\d{8}-\d{6}-[a-z0-9]{6}$/) } });
    const run = store.recent()[0];
    expect(JSON.stringify(run)).not.toContain('alex.morgan');
    expect(JSON.stringify(run)).not.toContain('Wandworks Bikes');
    expect(withoutPasswords({ rowKeys: [['1']], nested: { password: 'p' } })).toEqual({ rowKeys: '(hidden)', nested: { password: '(hidden)' } });
    await expect(runAction(ctx, 'mysql.deleteRows', { database: 'mysql', table: 'user', rowKeys: [['1']] })).rejects.toThrow(/MySQL's own/);
  });
});

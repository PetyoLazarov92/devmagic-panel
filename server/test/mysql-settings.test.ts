import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actions } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { JobRuntime } from '../src/jobs.js';
import { planSetSettings, readSettings, type SettingsContext } from '../src/mysql-settings.js';
import { type FakeCall, fakeExec, tempTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const MB = 1024 * 1024;
const GB = 1024 * MB;
const DMP = '/usr/local/lib/devmagic-panel/bin/dmp-root';

const VARIABLES = {
  version: '8.0.43-0ubuntu0.24.04.1',
  innodb_buffer_pool_size: String(128 * MB),
  max_allowed_packet: String(GB),
  innodb_redo_log_capacity: String(100 * MB),
  max_connections: '151',
  tmp_table_size: String(16 * MB),
  max_heap_table_size: String(16 * MB),
  innodb_flush_log_at_trx_commit: '1',
  slow_query_log: 'OFF',
  long_query_time: '10.000000',
};

/** MySQL 8 with 6 GB of InnoDB data, and the panel's file keeping max_connections. */
function setup({ folder = 'mysql.conf.d', kept = 'max_connections = 300\n' } = {}) {
  const tree = tempTree();
  if (folder) {
    mkdirSync(join(tree.config.MYSQL_CONF_DIR, folder), { recursive: true });
    if (kept) writeFileSync(join(tree.config.MYSQL_CONF_DIR, folder, 'zz-devmagic-panel.cnf'), `# Managed by devmagic-panel\n[mysqld]\n${kept}`);
  }
  const fake = fakeExec({
    mysql: (call: FakeCall) => {
      const sql = call.args.at(-1) ?? '';
      if (sql.startsWith('SHOW GLOBAL VARIABLES')) return { stdout: Object.entries(VARIABLES).map(([k, v]) => `${k}\t${v}`).join('\n') };
      if (sql.includes('information_schema.TABLES')) return { stdout: `${6 * GB}\n` };
      return { stdout: '' };
    },
    sudo: { stdout: 'ok\n' },
  });
  const memo = new Map<string, string>();
  const ctx: SettingsContext = {
    config: tree.config,
    exec: fake.exec,
    mysql,
    dmpRoot: DMP,
    memo: { getMeta: (k) => memo.get(k), setMeta: (k, v) => void memo.set(k, v), deleteMeta: (k) => void memo.delete(k) },
    totalMemory: 16 * GB,
  };
  return { tree, fake, ctx, memo };
}

describe("MySQL's settings", () => {
  it('reads what runs now, what the panel keeps, what an import holds raised, and suggests for the sites\' data', async () => {
    const { ctx, memo } = setup();
    memo.set('mysql-limits-raised', JSON.stringify([{ name: 'max_allowed_packet', was: 64 * MB, now: GB }]));
    const r = await readSettings(ctx);
    expect(r.product).toBe('MySQL');
    expect(r.file).toMatch(/mysql\/mysql\.conf\.d\/zz-devmagic-panel\.cnf$/);
    const by = Object.fromEntries(r.settings.map((s) => [s.name, s]));
    expect(r.settings.map((s) => s.name)).toEqual(['innodb_buffer_pool_size', 'max_allowed_packet', 'innodb_redo_log_capacity', 'max_connections', 'tmp_table_size', 'innodb_flush_log_at_trx_commit', 'slow_query_log', 'long_query_time']);
    expect(by.innodb_buffer_pool_size).toMatchObject({ value: 128 * MB, suggested: 7680 * MB });
    expect(by.max_allowed_packet).toMatchObject({ value: GB, raisedFrom: 64 * MB, suggested: 256 * MB });
    expect(by.max_connections).toMatchObject({ value: 151, kept: 300 });
    expect(by.slow_query_log).toMatchObject({ value: 0 });
    expect(by.long_query_time).toMatchObject({ value: 10 });
    expect(by.innodb_flush_log_at_trx_commit).toMatchObject({ suggested: 2 });
  });

  it('says changes last until a restart when MySQL has no config folder', async () => {
    const { ctx } = setup({ folder: '' });
    const r = await readSettings(ctx);
    expect(r.file).toBeNull();
    expect(r.fileNote).toMatch(/apply until MySQL restarts/);
  });

  it('applies a change now, keeps it with what the file had, takes one out with null, and Undo puts both back', async () => {
    const { ctx, fake } = setup();
    const { title, steps } = await planSetSettings(ctx, { values: { innodb_buffer_pool_size: 4 * GB, tmp_table_size: 64 * MB, max_connections: null } });
    expect(title).toBe("Change MySQL's 3 settings");
    const undos: Array<() => Promise<unknown>> = [];
    const job: JobRuntime = { onUndo: (_l, undo) => void undos.push(undo), progress: () => undefined };
    for (const step of steps) await step.run(job);
    const set = fake.calls.find((c) => c.args.at(-1)?.startsWith('SET GLOBAL'));
    expect(set?.args.at(-1)).toBe(`SET GLOBAL innodb_buffer_pool_size = ${4 * GB}; SET GLOBAL tmp_table_size = ${64 * MB}; SET GLOBAL max_heap_table_size = ${64 * MB};`);
    expect(set?.env).toEqual({ MYSQL_PWD: 'adminpw' });
    const write = fake.calls.find((c) => c.file === 'sudo');
    expect(write?.args).toEqual(['-n', DMP, 'mysql-config-write', `innodb_buffer_pool_size=${4 * GB}`, `tmp_table_size=${64 * MB}`, `max_heap_table_size=${64 * MB}`]);
    expect(undos).toHaveLength(1);
    await undos[0]?.();
    expect(fake.calls.filter((c) => c.args.at(-1)?.startsWith('SET GLOBAL')).at(-1)?.args.at(-1)).toBe(`SET GLOBAL innodb_buffer_pool_size = ${128 * MB}; SET GLOBAL tmp_table_size = ${16 * MB}; SET GLOBAL max_connections = 151; SET GLOBAL max_heap_table_size = ${16 * MB};`);
    expect(fake.calls.filter((c) => c.file === 'sudo').at(-1)?.args).toEqual(['-n', DMP, 'mysql-config-write', 'max_connections=300']);
  });

  it("refuses a setting this server does not have, and the action's schema refuses values out of bounds", async () => {
    const { ctx } = setup();
    await expect(planSetSettings(ctx, { values: { innodb_log_file_size: GB } })).rejects.toThrow('This MySQL has no innodb_log_file_size');
    const schema = actions['mysql.setSettings'].input;
    expect(schema.safeParse({ values: { innodb_buffer_pool_size: 4 * GB } }).success).toBe(true);
    for (const values of [{}, { innodb_buffer_pool_size: MB }, { max_connections: 99_999 }, { long_query_time: 0.0001 }, { innodb_flush_log_at_trx_commit: 0 }, { init_file: 1 }]) {
      expect(schema.safeParse({ values }).success).toBe(false);
    }
  });
});

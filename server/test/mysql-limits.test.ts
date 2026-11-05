import { afterEach, describe, expect, it } from 'vitest';
import { bufferPoolFor, limitTargets, putBackLeftRaised, putBackNowForTests, resetLimitsForTests, withRaisedLimits } from '../src/mysql-limits.js';
import { RunStore } from '../src/store.js';
import { fakeExec } from './helpers.js';

const GB = 1024 ** 3;
const SHOW = 'mysql --batch --skip-column-names --user root --host localhost -e SHOW GLOBAL VARIABLES';
const SET = 'mysql --batch --skip-column-names --user root --host localhost -e SET GLOBAL';

/** A MySQL server whose global variables the fake keeps, as SET GLOBAL changes them. */
function server(start: Record<string, string>, refuse: string[] = []) {
  const vars = new Map(Object.entries(start));
  const fake = fakeExec({
    [SHOW]: (call) => {
      const names = [...(call.args.at(-1) ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
      return { stdout: names.filter((n) => vars.has(n)).map((n) => `${n}\t${vars.get(n)}\n`).join('') };
    },
    [SET]: (call) => {
      const [, name, value] = /^SET GLOBAL (\w+) = (\d+)$/.exec(call.args.at(-1) ?? '') ?? [];
      if (!name || refuse.includes(name)) return { code: 1, stderr: 'ERROR 1227 (42000): Access denied; you need the SYSTEM_VARIABLES_ADMIN privilege' };
      // The buffer pool goes in whole chunks of 128 MB per instance (3 here): MySQL rounds it up.
      const chunks = 3 * 128 * 1024 ** 2;
      vars.set(name, name === 'innodb_buffer_pool_size' ? String(Math.ceil(Number(value) / chunks) * chunks) : (value as string));
      return { stdout: '' };
    },
  });
  return { vars, ...fake };
}

const MYSQL8 = { version: '8.0.46-0ubuntu0.24.04.4', innodb_buffer_pool_size: String(6 * 384 * 1024 ** 2), max_allowed_packet: String(64 * 1024 ** 2), innodb_redo_log_capacity: String(100 * 1024 ** 2) };
const account = { user: 'root', host: 'localhost', password: 'adminpw' };

afterEach(() => resetLimitsForTests());

describe("MySQL's limits while an import runs", () => {
  it('gives the buffer pool a quarter of the RAM at most, and never more than 8 GB', () => {
    expect([64, 31, 16, 15.5, 8, 7.6, 4].map((g) => bufferPoolFor(g * GB) / GB)).toEqual([8, 8, 4, 4, 2, 2, 1]);
  });

  it('raises only what is below the target, and the redo log by the variable this server has', () => {
    const mysql8 = new Map(Object.entries(MYSQL8));
    expect(limitTargets(mysql8, 16 * GB)).toEqual([
      { name: 'innodb_buffer_pool_size', to: 4 * GB },
      { name: 'max_allowed_packet', to: GB },
      { name: 'innodb_redo_log_capacity', to: 2 * GB },
    ]);
    expect(limitTargets(new Map([...mysql8, ['innodb_buffer_pool_size', String(12 * GB)]]), 16 * GB).map((t) => t.name)).not.toContain('innodb_buffer_pool_size');
    const maria = (version: string) => limitTargets(new Map([['version', version], ['innodb_log_file_size', String(96 * 1024 ** 2)]]), 8 * GB).map((t) => t.name);
    expect(maria('10.11.6-MariaDB-0+deb12u1')).toContain('innodb_log_file_size');
    expect(maria('10.6.18-MariaDB-0ubuntu0.22.04.1')).not.toContain('innodb_log_file_size');
    // An older MySQL without a resizable redo log: left alone.
    expect(limitTargets(new Map([['version', '8.0.28'], ['innodb_log_file_size', '50331648']]), 8 * GB).map((t) => t.name)).not.toContain('innodb_log_file_size');
  });

  it('raises them for the job, notes what was there in the panel database, and puts them back after', async () => {
    const s = server(MYSQL8);
    const store = new RunStore(':memory:');
    const notes: string[] = [];
    const result = await withRaisedLimits({ exec: s.exec, mysql: account, memo: store }, (l) => notes.push(l), async () => {
      expect(s.vars.get('innodb_buffer_pool_size')).toBe(String(11 * 384 * 1024 ** 2));
      expect(s.vars.get('max_allowed_packet')).toBe(String(GB));
      expect(s.vars.get('innodb_redo_log_capacity')).toBe(String(2 * GB));
      expect(JSON.parse(store.getMeta('mysql-limits-raised') ?? '[]')).toHaveLength(3);
      return 'imported';
    }, 16 * GB);
    expect(result).toBe('imported');
    expect(notes[0]).toBe('raised innodb_buffer_pool_size from 2.3 GB to 4.1 GB while this runs');
    await putBackNowForTests();
    expect(Object.fromEntries(s.vars)).toEqual(MYSQL8);
    expect(store.getMeta('mysql-limits-raised')).toBeUndefined();
    // The password only ever goes in the environment.
    expect(s.calls.every((c) => !c.args.includes('adminpw') && c.env?.MYSQL_PWD === 'adminpw')).toBe(true);
  });

  it('shares them between jobs at once and puts them back after the last one', async () => {
    const s = server(MYSQL8);
    let release: () => void = () => undefined;
    const first = withRaisedLimits({ exec: s.exec, mysql: account }, () => undefined, () => new Promise<void>((r) => (release = r)), 16 * GB);
    await new Promise((r) => setTimeout(r, 5));
    await withRaisedLimits({ exec: s.exec, mysql: account }, () => undefined, async () => undefined, 16 * GB);
    await putBackNowForTests();
    expect(s.vars.get('max_allowed_packet')).toBe(String(GB));
    release();
    await first;
    await putBackNowForTests();
    expect(s.vars.get('max_allowed_packet')).toBe(MYSQL8.max_allowed_packet);
    expect(s.calls.filter((c) => c.args.at(-1)?.startsWith('SET GLOBAL max_allowed_packet'))).toHaveLength(2);
  });

  it('runs the job anyway when MySQL refuses, and leaves a value someone changed since', async () => {
    const s = server(MYSQL8, ['innodb_buffer_pool_size']);
    const notes: string[] = [];
    await withRaisedLimits({ exec: s.exec, mysql: account }, (l) => notes.push(l), async () => {
      s.vars.set('max_allowed_packet', String(512 * 1024 ** 2));
    }, 16 * GB);
    await putBackNowForTests();
    expect(notes[0]).toMatch(/^left innodb_buffer_pool_size at 2.3 GB: ERROR 1227/);
    expect(s.vars.get('max_allowed_packet')).toBe(String(512 * 1024 ** 2));
    expect(s.vars.get('innodb_redo_log_capacity')).toBe(MYSQL8.innodb_redo_log_capacity);

    const unreachable = fakeExec({});
    const later: string[] = [];
    expect(await withRaisedLimits({ exec: unreachable.exec, mysql: account }, (l) => later.push(l), async () => 'ran')).toBe('ran');
    expect(later[0]).toMatch(/^left MySQL's limits as they are/);
  });

  it('puts back what a panel stopped in the middle left raised, when it starts again', async () => {
    const s = server({ ...MYSQL8, max_allowed_packet: String(GB) });
    const store = new RunStore(':memory:');
    store.setMeta('mysql-limits-raised', JSON.stringify([{ name: 'max_allowed_packet', was: 64 * 1024 ** 2, now: GB }]));
    await putBackLeftRaised({ exec: s.exec, mysql: account, memo: store });
    expect(s.vars.get('max_allowed_packet')).toBe(String(64 * 1024 ** 2));
    expect(store.getMeta('mysql-limits-raised')).toBeUndefined();
  });

  it('asks nothing of MySQL without the admin account', async () => {
    expect(await withRaisedLimits(null, () => undefined, async () => 'ran')).toBe('ran');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { ActionInput, MysqlSetting, MysqlSettingName, MysqlSettings } from '@devmagic-panel/shared';
import { MYSQL_SETTING_NAMES, MYSQL_SETTINGS } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import { type ExecResult, type Executor, runRoot } from './exec.js';
import type { JobStep } from './jobs.js';
import { bufferPoolTarget, INNODB_DATA_SQL, type LimitsMemo, type MysqlAccount, raisedNow } from './mysql-limits.js';
import { MysqlRefused } from './mysql-server.js';

/**
 * The MySQL settings the MySQL page shows and changes. A change applies at
 * once with SET GLOBAL (each of them changes while MySQL runs) and is kept
 * for the next start in the panel's own file, which only dmp-root's
 * mysql-config-write writes, with allow-listed names and numbers in bounds.
 */

export interface SettingsContext {
  config: SystemConfig;
  exec: Executor;
  mysql: MysqlAccount | undefined;
  dmpRoot: string;
  /** Where an import notes the limits it raised. */
  memo?: LimitsMemo;
  totalMemory?: number;
}

export const MYSQL_CNF_NAME = 'zz-devmagic-panel.cnf';
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The folder MySQL reads last, as dmp-root picks it: MariaDB's when there is one. */
export function mysqlConfFolder(config: SystemConfig): string | null {
  for (const dir of ['mariadb.conf.d', 'mysql.conf.d']) if (existsSync(join(config.MYSQL_CONF_DIR, dir))) return join(config.MYSQL_CONF_DIR, dir);
  return null;
}

/** The panel's file as name to value: only the names it keeps, only numbers. */
export function keptSettings(file: string | null): Partial<Record<MysqlSettingName, number>> {
  const kept: Partial<Record<MysqlSettingName, number>> = {};
  if (!file || !existsSync(file)) return kept;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([a-z_]+) = ([0-9.]+)$/.exec(line.trim());
    if (m && (MYSQL_SETTING_NAMES as readonly string[]).includes(m[1] as string)) kept[m[1] as MysqlSettingName] = Number(m[2]);
  }
  return kept;
}

function account(ctx: SettingsContext): MysqlAccount {
  if (!ctx.mysql) throw new MysqlRefused('The panel has no MySQL admin account: set one up on the Environment page');
  return ctx.mysql;
}

function query(ctx: SettingsContext, sql: string): Promise<ExecResult> {
  const { user, host, password } = account(ctx);
  return ctx.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', sql], { env: { MYSQL_PWD: password }, timeoutMs: 30_000 });
}

async function variables(ctx: SettingsContext): Promise<Map<string, string>> {
  const names = ['version', ...MYSQL_SETTING_NAMES].map((n) => `'${n}'`).join(', ');
  const r = await query(ctx, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names})`);
  if (r.code !== 0) throw new MysqlRefused(r.stderr.trim().split('\n')[0] || 'MySQL did not answer');
  return new Map(
    r.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols): cols is [string, string] => cols.length === 2)
      .map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
}

/** A value MySQL prints for a setting, as a number: ON and OFF as 1 and 0. */
function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (/^on$/i.test(value)) return 1;
  if (/^off$/i.test(value)) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** What the panel suggests for a local machine, only where the value is lower. */
function suggestion(name: MysqlSettingName, value: number, pool: number | undefined): Pick<MysqlSetting, 'suggested' | 'why'> {
  if (name === 'innodb_buffer_pool_size' && pool && value < pool) return { suggested: pool, why: "Room for your sites' InnoDB data, up to half the memory" };
  if (name === 'max_allowed_packet' && value < 256 * MB) return { suggested: 256 * MB, why: 'Dumps with big rows import' };
  if ((name === 'innodb_redo_log_capacity' || name === 'innodb_log_file_size') && value < GB) return { suggested: GB, why: 'Big imports go faster' };
  if (name === 'innodb_flush_log_at_trx_commit' && value === 1) return { suggested: 2, why: 'Much faster imports on a computer for local work' };
  return {};
}

export async function readSettings(ctx: SettingsContext): Promise<MysqlSettings> {
  const vars = await variables(ctx);
  const folder = mysqlConfFolder(ctx.config);
  const file = folder ? join(folder, MYSQL_CNF_NAME) : null;
  const kept = keptSettings(file);
  const raised = new Map(raisedNow(ctx.memo).map((r) => [r.name, r]));
  const ram = ctx.totalMemory ?? totalmem();
  const data = await query(ctx, INNODB_DATA_SQL);
  const dataBytes = Number(data.stdout.trim());
  const pool = data.code === 0 && Number.isFinite(dataBytes) ? bufferPoolTarget(dataBytes, ram) : undefined;
  const settings: MysqlSetting[] = [];
  for (const s of MYSQL_SETTINGS) {
    const value = numberOf(vars.get(s.name));
    if (value === undefined) continue;
    const r = raised.get(s.name);
    settings.push({
      name: s.name,
      value,
      ...(kept[s.name] !== undefined ? { kept: kept[s.name] } : {}),
      ...(r && r.now === value ? { raisedFrom: r.was } : {}),
      ...suggestion(s.name, r && r.now === value ? r.was : value, pool),
    });
  }
  return {
    product: /mariadb/i.test(vars.get('version') ?? '') ? 'MariaDB' : 'MySQL',
    settings,
    file,
    ...(folder ? {} : { fileNote: `There is no mysql.conf.d or mariadb.conf.d in ${ctx.config.MYSQL_CONF_DIR}: changes apply until MySQL restarts.` }),
  };
}

const pairs = (values: Partial<Record<MysqlSettingName, number>>) => MYSQL_SETTING_NAMES.filter((n) => values[n] !== undefined).map((n) => `${n}=${values[n]}`);

/** The values a change asks for, the temp tables' two settings together. */
function expand(values: ActionInput<'mysql.setSettings'>['values']): Partial<Record<MysqlSettingName, number | null>> {
  const out: Partial<Record<MysqlSettingName, number | null>> = { ...values };
  if (values.tmp_table_size !== undefined) out.max_heap_table_size = values.tmp_table_size;
  return out;
}

export async function planSetSettings(ctx: SettingsContext, input: ActionInput<'mysql.setSettings'>): Promise<{ title: string; steps: JobStep[] }> {
  const vars = await variables(ctx);
  const changes = expand(input.values);
  const names = Object.keys(changes) as MysqlSettingName[];
  const missing = names.filter((n) => !vars.has(n));
  if (missing.length) throw new MysqlRefused(`This ${/mariadb/i.test(vars.get('version') ?? '') ? 'MariaDB' : 'MySQL'} has no ${missing.join(', ')}`);
  const folder = mysqlConfFolder(ctx.config);
  const file = folder ? join(folder, MYSQL_CNF_NAME) : null;
  const before = Object.fromEntries(names.map((n) => [n, numberOf(vars.get(n)) as number])) as Partial<Record<MysqlSettingName, number>>;
  const keptBefore = keptSettings(file);
  const keptAfter: Partial<Record<MysqlSettingName, number>> = { ...keptBefore };
  for (const n of names) {
    const v = changes[n];
    if (v === null || v === undefined) delete keptAfter[n];
    else keptAfter[n] = v;
  }
  const label = (n: MysqlSettingName) => MYSQL_SETTINGS.find((s) => s.name === n)?.label ?? n;
  const shown = [...new Set(names.filter((n) => n !== 'max_heap_table_size').map(label))];
  const title = `Change MySQL's ${shown.length === 1 ? shown[0]?.toLowerCase() : `${shown.length} settings`}`;
  const setGlobal = async (values: Partial<Record<MysqlSettingName, number | null | undefined>>): Promise<ExecResult> => {
    const sets = (Object.entries(values) as Array<[MysqlSettingName, number | null | undefined]>).filter(([, v]) => typeof v === 'number').map(([n, v]) => `SET GLOBAL ${n} = ${Number(v)};`);
    // The slow log goes to its table too, where the panel reads it (mysql-slow.ts); dmp-root keeps the same line with it.
    if (values.slow_query_log === 1) sets.push("SET GLOBAL log_output = 'FILE,TABLE';");
    if (!sets.length) return { code: 0, stdout: 'Nothing to apply now: MySQL\'s own value applies from its next start\n', stderr: '' };
    const r = await query(ctx, sets.join(' '));
    return r.code === 0 ? { ...r, stdout: `Applied now: ${sets.map((s) => s.slice('SET GLOBAL '.length, -1)).join(', ')}\n` } : r;
  };
  const steps: JobStep[] = [
    {
      id: 'apply',
      label: 'Apply them now',
      run: async (job) => {
        const r = await setGlobal(changes);
        if (r.code === 0) {
          job.onUndo('Put the settings back as they were', async () => {
            const back = await setGlobal(before);
            if (back.code !== 0 || !file) return back;
            return runRoot(ctx.exec, ctx.dmpRoot, ['mysql-config-write', ...pairs(keptBefore)]);
          });
        }
        return r;
      },
    },
  ];
  if (file) steps.push({ id: 'keep', label: 'Keep them for the next start', run: () => runRoot(ctx.exec, ctx.dmpRoot, ['mysql-config-write', ...pairs(keptAfter)]) });
  return { title, steps };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { mysqlBackupsDir, mysqlReport, pruneMysqlBackups } from '../src/mysql-server.js';
import { freshStatsSql } from '../src/mysql-stats.js';
import type { Secrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { type FakeCall, fakeExec, type FakeResponse, tempTree, wpSiteTree } from './helpers.js';

const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' } };
const Q = 'mysql --batch --skip-column-names --user devmagic_panel --host localhost -e';
const RUN = 'mysql --batch --skip-column-names --user devmagic_panel --host localhost';

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

/** A server with local.shop.com's database and user, one left behind, one of another project, and MySQL's own. */
const SERVER = {
  databases: [
    ['information_schema', '0', '79'],
    ['mysql', '2600000', '38'],
    ['oldclient_com', '342000000', '58'],
    ['reports', '18000', '9'],
    ['shop_com', '120000000', '61'],
  ],
  users: [
    ['debian-sys-maint', 'localhost'],
    ['devmagic_panel', 'localhost'],
    ['oldshop_com', 'localhost'],
    ['reports', '%'],
    ['root', 'localhost'],
    ['shop_com', 'localhost'],
  ],
  grants: [
    ['oldshop_com', 'localhost', 'oldshop\\_com'],
    ['reports', '%', 'reports'],
    ['shop_com', 'localhost', 'shop_com'],
  ],
  globals: ["'root'@'localhost'", "'devmagic_panel'@'localhost'", "'debian-sys-maint'@'localhost'"],
};

const rows = (list: string[][]) => ({ stdout: list.map((r) => r.join('\t')).join('\n') });

/** Answers the queries the MySQL tab and its actions send, from SERVER. */
function query(call: FakeCall): Partial<{ code: number; stdout: string; stderr: string }> {
  const sql = call.args.at(-1) as string;
  if (sql.startsWith("SHOW VARIABLES LIKE 'information_schema_stats_expiry'")) return { stdout: 'information_schema_stats_expiry\t86400\n' };
  if (sql.startsWith("SHOW VARIABLES LIKE 'print_identified_with_as_hex'")) return { stdout: 'print_identified_with_as_hex\tOFF\n' };
  if (sql === 'SELECT VERSION(), @@datadir') return { stdout: '8.0.43-0ubuntu0.24.04.1\t/var/lib/mysql/\n' };
  if (sql.includes('FROM information_schema.SCHEMATA s LEFT JOIN')) return rows(SERVER.databases);
  if (sql === 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA') return rows(SERVER.databases.map(([n]) => [n as string]));
  if (sql.startsWith("SELECT User, Host FROM mysql.user")) return rows(SERVER.users);
  if (sql.startsWith('SELECT Host FROM mysql.user')) return rows(SERVER.users.filter(([u]) => sql.includes(`'${u}'`)).map(([, h]) => [h as string]));
  if (sql === 'SELECT User, Host, Db FROM mysql.db') return rows(SERVER.grants);
  if (sql.includes('information_schema.USER_PRIVILEGES')) return rows(SERVER.globals.map((g) => [g]));
  if (sql.includes("TABLE_TYPE = 'BASE TABLE'")) return rows([['wp_options'], ['wp_posts']]);
  if (sql.includes('SUM(DATA_LENGTH + INDEX_LENGTH)')) return { stdout: '342000000\n' };
  return { code: 1, stderr: `not faked: ${sql}` };
}

function setup(extra: Record<string, FakeResponse> = {}) {
  const t = wpSiteTree();
  writeFileSync(join(t.docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\ndefine('DB_USER', 'shop_com');\ndefine('DB_PASSWORD', 'old-secret');\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n");
  const fake = fakeExec({ [Q]: query, [RUN]: { stdout: '' }, ...extra });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const uploadsDir = join(t.root, 'data', 'uploads');
  const ctx: ActionContext = { config: t.config, exec: fake.exec, store, dmpRoot: '/x/dmp-root', wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir, secrets };
  const mysqlCtx = { config: t.config, exec: fake.exec, mysql: secrets.mysql, kept: () => store.keptDatabases(), backupsDir: mysqlBackupsDir(uploadsDir) };
  return { ...t, ctx, mysqlCtx, store, jobs, calls: fake.calls, backups: mysqlBackupsDir(uploadsDir) };
}

const statements = (calls: FakeCall[]) => calls.filter((c) => c.input !== undefined).map((c) => c.input as string);

describe('mysqlReport', () => {
  it('says what each database and account is to the panel, with fresh sizes', async () => {
    const s = setup();
    const r = await mysqlReport(s.mysqlCtx, () => Date.parse('2026-10-29T10:00:00Z'));
    expect(r.server).toEqual({ product: 'MySQL', version: '8.0.43-0ubuntu0.24.04.1', account: 'devmagic_panel@localhost', datadir: '/var/lib/mysql/', totalBytes: 464618000 });
    expect(Object.fromEntries(r.databases.map((d) => [d.name, d.kind]))).toEqual({ information_schema: 'system', mysql: 'system', oldclient_com: 'unused', reports: 'unused', shop_com: 'site' });
    expect(r.databases.find((d) => d.name === 'shop_com')?.sites).toEqual([{ domain: 'local.shop.com' }]);
    expect(Object.fromEntries(r.users.map((u) => [`${u.user}@${u.host}`, u.kind]))).toEqual({
      'debian-sys-maint@localhost': 'system',
      'devmagic_panel@localhost': 'panel',
      'oldshop_com@localhost': 'leftover',
      'reports@%': 'other',
      'root@localhost': 'system',
      'shop_com@localhost': 'site',
    });
    // An escaped _ in a grant is the name as it was; the database it names is gone.
    expect(r.users.find((u) => u.user === 'oldshop_com')).toMatchObject({ databases: [], missing: ['oldshop_com'], global: false });
    expect(r.users.find((u) => u.user === 'shop_com')).toMatchObject({ databases: ['shop_com'], sites: [{ domain: 'local.shop.com' }] });
    const sizes = s.calls.find((c) => (c.args.at(-1) as string).includes('SCHEMATA s LEFT JOIN'))?.args.at(-1);
    expect(sizes).toMatch(/^SET SESSION information_schema_stats_expiry = 0; SELECT/);
    // The password goes in the environment, never on a command line.
    expect(s.calls.every((c) => !c.args.join(' ').includes('adminpw'))).toBe(true);
  });

  it('marks a database the panel keeps for a site, and works without an admin account', async () => {
    const s = setup();
    s.store.addKeptDatabase({ name: 'oldclient_com', site: 'local.shop.com@learn', db: 'shop_com', reason: 'import', createdAt: '2026-10-28T10:00:00Z' });
    const r = await mysqlReport(s.mysqlCtx);
    expect(r.databases.find((d) => d.name === 'oldclient_com')).toMatchObject({ kind: 'kept', sites: [{ domain: 'local.shop.com', path: '/learn' }] });
    const none = await mysqlReport({ ...s.mysqlCtx, mysql: null });
    expect(none).toMatchObject({ server: null, databases: [], users: [] });
    expect(none.error).toMatch(/no MySQL admin account/);
  });

  it('reports a refused sign-in instead of failing', async () => {
    const s = setup({ [Q]: (call) => ((call.args.at(-1) as string).startsWith('SHOW VARIABLES') ? { stdout: '' } : { code: 1, stderr: "ERROR 1045 (28000): Access denied for user 'devmagic_panel'@'localhost'" }) });
    const r = await mysqlReport(s.mysqlCtx);
    expect(r.server).toBeNull();
    expect(r.error).toContain('ERROR 1045');
  });
});

describe('freshStatsSql', () => {
  it('asks MySQL once per executor, and nothing on MariaDB', async () => {
    const mysql8 = fakeExec({ 'mysql --batch': { stdout: 'information_schema_stats_expiry\t86400\n' } });
    expect(await freshStatsSql(mysql8.exec, secrets.mysql as NonNullable<Secrets['mysql']>)).toBe('SET SESSION information_schema_stats_expiry = 0; ');
    await freshStatsSql(mysql8.exec, secrets.mysql as NonNullable<Secrets['mysql']>);
    expect(mysql8.calls).toHaveLength(1);
    const maria = fakeExec({ 'mysql --batch': { stdout: '' } });
    expect(await freshStatsSql(maria.exec, secrets.mysql as NonNullable<Secrets['mysql']>)).toBe('');
  });
});

describe('mysql actions', () => {
  it('analyzes the tables of a database, and refuses MySQL\'s own and bad names before any command', async () => {
    const s = setup();
    const r = await runAction(s.ctx, 'mysql.analyze', { database: 'oldclient_com' });
    expect(r.ok).toBe(true);
    expect(statements(s.calls)).toEqual(['ANALYZE TABLE `oldclient_com`.`wp_options`, `oldclient_com`.`wp_posts`;\n']);
    await expect(runAction(s.ctx, 'mysql.analyze', { database: 'mysql' })).rejects.toThrow("MySQL's own");
    const before = s.calls.length;
    await expect(runAction(s.ctx, 'mysql.analyze', { database: 'x`; DROP DATABASE y' })).rejects.toThrow('database');
    expect(s.calls).toHaveLength(before);
  });

  it('deletes a database no site uses after exporting it, and Undo imports it back', async () => {
    const s = setup({
      mysqldump: { stdout: 'CREATE DATABASE `oldclient_com`;\nCREATE TABLE wp_options (x int);\n' },
      'mysql --user devmagic_panel --host localhost': { stdout: '' },
    });
    const result = await runAction(s.ctx, 'mysql.dropDatabase', { database: 'oldclient_com' });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    const dump = s.calls.find((c) => c.file === 'mysqldump');
    expect(dump?.args).toEqual(['--user', 'devmagic_panel', '--host', 'localhost', '--single-transaction', '--quick', '--no-tablespaces', '--routines', '--events', '--max-allowed-packet=1G', '--databases', 'oldclient_com']);
    const [file] = readdirSync(s.backups);
    expect(file).toMatch(/^oldclient_com-\d{8}-\d{6}\.sql\.gz$/);
    expect(statSync(join(s.backups, file as string)).mode & 0o777).toBe(0o600);
    expect(statements(s.calls)).toContain('DROP DATABASE `oldclient_com`;\n');

    // Undo runs once the database is gone from the server.
    SERVER.databases = SERVER.databases.filter(([n]) => n !== 'oldclient_com');
    try {
      s.jobs.undo(view.id);
      const undone = await settle(s.jobs, view.id);
      expect(undone.status).toBe('undone');
      expect(s.calls.find((c) => c.file === 'mysql' && c.inputText !== undefined)?.inputText).toContain('CREATE DATABASE `oldclient_com`');
    } finally {
      SERVER.databases.splice(2, 0, ['oldclient_com', '342000000', '58']);
    }
  });

  it("refuses to delete a site's database, a kept one or MySQL's own", async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'mysql.dropDatabase', { database: 'shop_com' })).rejects.toThrow('local.shop.com uses shop_com');
    await expect(runAction(s.ctx, 'mysql.dropDatabase', { database: 'mysql' })).rejects.toThrow("MySQL's own");
    s.store.addKeptDatabase({ name: 'oldclient_com', site: 'local.shop.com', db: 'shop_com', reason: 'import', createdAt: '2026-10-28T10:00:00Z' });
    await expect(runAction(s.ctx, 'mysql.dropDatabase', { database: 'oldclient_com' })).rejects.toThrow("Database tab");
    await expect(runAction(s.ctx, 'mysql.dropDatabase', { database: 'nothere' })).rejects.toThrow('no database called nothere');
    expect(s.calls.some((c) => c.file === 'mysqldump')).toBe(false);
  });

  it('saves accounts before deleting them, and Undo makes them again', async () => {
    const s = setup({
      'mysql --batch --skip-column-names --raw': (call) => ({
        stdout: (call.args.at(-1) as string).includes("'oldshop_com'@'localhost'")
          ? "CREATE USER `oldshop_com`@`localhost` IDENTIFIED WITH 'caching_sha2_password' AS 0x2441243030350A REQUIRE NONE\nGRANT USAGE ON *.* TO `oldshop_com`@`localhost`\nGRANT ALL PRIVILEGES ON `oldshop\\_com`.* TO `oldshop_com`@`localhost`\n"
          : '',
      }),
    });
    const result = await runAction(s.ctx, 'mysql.dropUsers', { accounts: [{ user: 'oldshop_com', host: 'localhost' }] });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    const [file] = readdirSync(s.backups);
    const saved = readFileSync(join(s.backups, file as string), 'utf8');
    expect(saved).toContain('CREATE USER IF NOT EXISTS `oldshop_com`@`localhost` IDENTIFIED WITH');
    expect(saved).toContain('GRANT ALL PRIVILEGES ON `oldshop\\_com`.* TO `oldshop_com`@`localhost`;');
    expect(statSync(join(s.backups, file as string)).mode & 0o777).toBe(0o600);
    expect(statements(s.calls)).toContain("DROP USER 'oldshop_com'@'localhost';\n");
    s.jobs.undo(view.id);
    expect((await settle(s.jobs, view.id)).status).toBe('undone');
    expect(statements(s.calls).at(-1)).toBe(saved);
  });

  it("refuses the panel's account, MySQL's own and a site's user", async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'mysql.dropUsers', { accounts: [{ user: 'devmagic_panel', host: 'localhost' }] })).rejects.toThrow('the panel signs in with');
    await expect(runAction(s.ctx, 'mysql.dropUsers', { accounts: [{ user: 'root', host: 'localhost' }] })).rejects.toThrow("MySQL's own");
    await expect(runAction(s.ctx, 'mysql.dropUsers', { accounts: [{ user: 'oldshop_com', host: 'localhost' }, { user: 'shop_com', host: 'localhost' }] })).rejects.toThrow('local.shop.com uses shop_com');
    await expect(runAction(s.ctx, 'mysql.dropUsers', { accounts: [{ user: 'ghost', host: 'localhost' }] })).rejects.toThrow('no account ghost@localhost');
    expect(statements(s.calls)).toEqual([]);
  });

  it("gives a site's user a new password, in wp-config.php and through stdin only", async () => {
    const s = setup();
    const r = await runAction(s.ctx, 'mysql.resetSiteUser', { domain: 'local.shop.com' });
    expect(r.ok).toBe(true);
    const password = /define\( 'DB_PASSWORD', '([^']+)' \)/.exec(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8'))?.[1] ?? '';
    expect(password).toMatch(/^[\w-]{24}$/);
    const sql = statements(s.calls).join('');
    expect(sql).toContain(`ALTER USER 'shop_com'@'localhost' IDENTIFIED BY '${password}';`);
    expect(sql).toContain("GRANT ALL PRIVILEGES ON `shop_com`.* TO 'shop_com'@'localhost';");
    expect(s.calls.some((c) => c.args.join(' ').includes(password))).toBe(false);
    expect(r.output).not.toContain(password);
    expect(JSON.stringify(s.store.recent())).not.toContain(password);
  });

  it('puts the old password back in wp-config.php when MySQL refuses the new one', async () => {
    const s = setup({ [RUN]: { code: 1, stderr: 'ERROR 1227 (42000): Access denied; you need the CREATE USER privilege' } });
    const r = await runAction(s.ctx, 'mysql.resetSiteUser', { domain: 'local.shop.com' });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8')).toContain("define('DB_PASSWORD', 'old-secret');");
  });

  it('refuses a user other sites share, or the panel\'s own account', async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\ndefine('DB_USER', 'devmagic_panel');\n$table_prefix = 'wp_';\n");
    await expect(runAction(s.ctx, 'mysql.resetSiteUser', { domain: 'local.shop.com' })).rejects.toThrow("panel's own account");
    expect(statements(s.calls)).toEqual([]);
  });
});

describe('saved copies', () => {
  it('lists what deleted databases and users left, newest first, and deletes one on request', async () => {
    const s = setup();
    mkdirSync(s.backups, { recursive: true });
    writeFileSync(join(s.backups, 'oldclient_com-20261020-101500.sql.gz'), 'x'.repeat(10));
    writeFileSync(join(s.backups, 'users-20261028-120000.sql'), "CREATE USER IF NOT EXISTS `oldshop_com`@`localhost` IDENTIFIED WITH 'caching_sha2_password' AS 0x24;\nCREATE USER IF NOT EXISTS `reports`@`%` IDENTIFIED BY PASSWORD '*AB';\n");
    writeFileSync(join(s.backups, 'reports-20261029-080000.sql.gz.part'), '');
    const old = new Date('2026-10-20T10:15:00Z');
    utimesSync(join(s.backups, 'oldclient_com-20261020-101500.sql.gz'), old, old);
    const r = await mysqlReport(s.mysqlCtx);
    expect(r.backupsDir).toBe(s.backups);
    expect(r.backups.map(({ name, kind, subject, sizeBytes }) => ({ name, kind, subject, sizeBytes }))).toEqual([
      { name: 'users-20261028-120000.sql', kind: 'users', subject: 'oldshop_com@localhost, reports@%', sizeBytes: expect.any(Number) },
      { name: 'oldclient_com-20261020-101500.sql.gz', kind: 'database', subject: 'oldclient_com', sizeBytes: 10 },
    ]);
    expect(r.backups[1]).toMatchObject({ savedAt: '2026-10-20T10:15:00.000Z', purgeAt: '2026-11-03T10:15:00.000Z' });
    // Listed even when MySQL cannot be read.
    expect((await mysqlReport({ ...s.mysqlCtx, mysql: null })).backups).toHaveLength(2);

    expect((await runAction(s.ctx, 'mysql.deleteBackup', { name: 'oldclient_com-20261020-101500.sql.gz' })).ok).toBe(true);
    expect(existsSync(join(s.backups, 'oldclient_com-20261020-101500.sql.gz'))).toBe(false);
    await expect(runAction(s.ctx, 'mysql.deleteBackup', { name: 'oldclient_com-20261020-101500.sql.gz' })).rejects.toThrow('not in the MySQL backups');
    for (const name of ['../secrets.json', 'reports-20261029-080000.sql.gz.part', 'users-20261028-120000.sql/../x']) {
      await expect(runAction(s.ctx, 'mysql.deleteBackup', { name })).rejects.toThrow();
    }
    expect(existsSync(join(s.backups, 'users-20261028-120000.sql'))).toBe(true);
  });
});

describe('pruneMysqlBackups', () => {
  it('removes what was saved more than 14 days ago', () => {
    const s = setup();
    const dir = s.backups;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.sql.gz'), '');
    writeFileSync(join(dir, 'new.sql.gz'), '');
    const old = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(join(dir, 'old.sql.gz'), old, old);
    expect(pruneMysqlBackups(dir)).toEqual(['old.sql.gz']);
    expect(existsSync(join(dir, 'new.sql.gz'))).toBe(true);
  });
});

describe('optimizing some tables', () => {
  it('rebuilds only the tables asked for that the database has, and refuses when it has none of them', async () => {
    const { planOptimize } = await import('../src/mysql-server.js');
    const fake = fakeExec({
      mysql: (call: FakeCall) => {
        const text = [...call.args, call.input ?? ''].join(' ');
        if (/SCHEMATA|SHOW DATABASES/.test(text)) return { stdout: 'shop_com\n' };
        if (text.includes("TABLE_TYPE = 'BASE TABLE'")) return { stdout: 'wp_options\nwp_postmeta\nwp_posts\n' };
        if (text.includes('SUM(DATA_LENGTH')) return { stdout: '1000\n' };
        return { stdout: '' };
      },
    });
    const ctx = { config: tempTree().config, exec: fake.exec, mysql: { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' }, kept: () => [], backupsDir: tempTree().root };
    const [step] = await planOptimize(ctx, { database: 'shop_com', tables: ['wp_postmeta', 'wp_wandworks_gone'] }, () => false);
    expect(step?.label).toBe('Optimize wp_postmeta of shop_com');
    await step?.run({ onUndo: () => undefined, progress: () => undefined });
    const optimized = fake.calls.map((c) => [...c.args, c.input ?? ''].join(' ')).filter((t) => t.includes('OPTIMIZE TABLE'));
    expect(optimized).toEqual([expect.stringContaining('OPTIMIZE TABLE `shop_com`.`wp_postmeta`;')]);
    await expect(planOptimize(ctx, { database: 'shop_com', tables: ['wp_wandworks_gone'] }, () => false)).rejects.toThrow('shop_com has none of those tables');
  });
});

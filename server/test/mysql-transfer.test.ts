import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { JobRuntime } from '../src/jobs.js';
import { exportDatabase, OwnDatabaseOnly, planImportDump, type TransferContext } from '../src/mysql-transfer.js';
import { type FakeCall, fakeExec, tempTree, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };

async function filtered(chunks: string[]): Promise<{ text: string; dropped: number }> {
  const filter = new OwnDatabaseOnly();
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')))
      .pipe(filter)
      .on('data', (b: Buffer) => out.push(b))
      .on('end', resolve)
      .on('error', reject);
  });
  return { text: Buffer.concat(out).toString('utf8'), dropped: filter.dropped };
}

describe("a dump's database lines", () => {
  it('drops CREATE DATABASE, DROP DATABASE and USE at the start of a line, and keeps everything else as it is', async () => {
    const dump = [
      '-- Current Database: `shop_com`\n',
      'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop_com` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n',
      'USE `shop_com`;\n',
      'drop database if exists other;\n',
      "INSERT INTO `wp_options` VALUES (1,'USE other; CREATE DATABASE x','😀 café');\n",
      '  use shop_com;\n',
      'CREATE TABLE `wp_posts` (`ID` int);\n',
    ].join('');
    const { text, dropped } = await filtered([dump]);
    expect(dropped).toBe(4);
    expect(text).toBe("-- Current Database: `shop_com`\nINSERT INTO `wp_options` VALUES (1,'USE other; CREATE DATABASE x','😀 café');\nCREATE TABLE `wp_posts` (`ID` int);\n");
  });

  it('reads a line split anywhere across chunks, and a long line without its end in one chunk', async () => {
    const dump = "USE `shop_com`;\nINSERT INTO t VALUES ('" + 'x'.repeat(5000) + "');\nCREATE DATA" + 'BASE `x`;\nSELECT 1;';
    const pieces: string[] = [];
    for (let i = 0; i < dump.length; i += 7) pieces.push(dump.slice(i, i + 7));
    const { text, dropped } = await filtered(pieces);
    expect(dropped).toBe(2);
    expect(text).toBe("INSERT INTO t VALUES ('" + 'x'.repeat(5000) + "');\nSELECT 1;");
  });
});

function fakeDb(answer: (sql: string, call: FakeCall) => Partial<{ code: number; stdout: string; stderr: string }> | undefined = () => undefined) {
  return fakeExec({
    mysqldump: () => ({ stdout: 'CREATE TABLE `wp_posts` (`ID` int);\n' }),
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? call.inputText ?? '';
      const special = answer(sql, call);
      if (special) return special;
      if (sql.includes('SELECT TABLE_NAME FROM information_schema.TABLES')) return { stdout: 'wp_options\nwp_posts\n' };
      if (sql.includes('information_schema.SCHEMATA')) return { stdout: '0\n' };
      if (sql.includes('SELECT COUNT(*) FROM information_schema.TABLES')) return { stdout: '2\n' };
      return { stdout: '' };
    },
  });
}

describe('export', () => {
  it('streams a whole database with its routines and events, without CREATE DATABASE or USE', async () => {
    const fake = fakeDb();
    const { filename, stream } = await exportDatabase({ config: tempTree().config, exec: fake.exec, mysql, kept: () => [] }, 'shop_com', [], () => new Date('2026-11-07T12:00:00Z'));
    expect(filename).toBe('shop_com-20261107-120000.sql.gz');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(gunzipSync(Buffer.concat(chunks)).toString()).toBe('CREATE TABLE `wp_posts` (`ID` int);\n');
    const dump = fake.calls.find((c) => c.file === 'mysqldump') as FakeCall;
    expect(dump.args).toEqual(expect.arrayContaining(['--single-transaction', '--routines', '--events', '--hex-blob']));
    expect(dump.args).not.toContain('--databases');
    expect(dump.args.slice(-2)).toEqual(['--', 'shop_com']);
    expect(dump.env).toEqual({ MYSQL_PWD: 'adminpw' });
  });

  it('takes the tables named once the database has them, and refuses one it has not', async () => {
    const fake = fakeDb();
    const ctx = { config: tempTree().config, exec: fake.exec, mysql, kept: () => [] };
    const one = await exportDatabase(ctx, 'shop_com', ['wp_posts'], () => new Date('2026-11-07T12:00:00Z'));
    expect(one.filename).toBe('shop_com-wp_posts-20261107-120000.sql.gz');
    expect((fake.calls.find((c) => c.file === 'mysqldump') as FakeCall).args.slice(-3)).toEqual(['--', 'shop_com', 'wp_posts']);
    await expect(exportDatabase(ctx, 'shop_com', ['wp_nope'])).rejects.toMatchObject({ status: 404 });
    await expect(exportDatabase(ctx, 'information_schema')).rejects.toMatchObject({ status: 400 });
  });

  it('breaks the download off when mysqldump fails, so it never looks finished', async () => {
    const fake = fakeExec({ mysqldump: () => ({ code: 2, stderr: 'mysqldump: Got error: 1044: Access denied' }), mysql: () => ({ stdout: 'wp_posts\n' }) });
    const { stream } = await exportDatabase({ config: tempTree().config, exec: fake.exec, mysql, kept: () => [] }, 'shop_com');
    await expect((async () => {
      for await (const _ of stream) void _;
    })()).rejects.toThrow(/mysqldump stopped: mysqldump: Got error: 1044/);
  });
});

const UPLOAD = '11111111-1111-1111-1111-111111111111';

function withUpload(root: string): string {
  const uploads = join(root, 'uploads');
  mkdirSync(join(uploads, UPLOAD), { recursive: true });
  const file = join(uploads, UPLOAD, 'wandworks.sql');
  writeFileSync(file, 'USE `shop_com`;\nCREATE TABLE t (x int);\nINSERT INTO t VALUES (1);\n');
  writeFileSync(join(uploads, UPLOAD, 'meta.json'), JSON.stringify({ id: UPLOAD, name: 'wandworks.sql', size: 60, facts: {}, file }));
  return uploads;
}

async function run(steps: Awaited<ReturnType<typeof planImportDump>>) {
  const undos: Array<() => Promise<unknown>> = [];
  const job: JobRuntime = { onUndo: (_l, f) => void undos.push(f), progress: () => undefined };
  const out = [];
  for (const s of steps) out.push(await s.run(job));
  return { out, undos };
}

describe('import', () => {
  it('makes a new database and imports into it as SQL only, without the dump database lines', async () => {
    const tree = tempTree();
    const fake = fakeDb();
    const ctx: TransferContext = { config: tree.config, exec: fake.exec, mysql, kept: () => [], uploadsDir: withUpload(tree.root), backupsDir: join(tree.root, 'mysql-backups') };
    const steps = await planImportDump(ctx, { database: 'wandworks_copy', uploadId: UPLOAD, mode: 'new' });
    expect(steps.map((s) => s.label)).toEqual(['Make database wandworks_copy', 'Import wandworks.sql']);
    const { out, undos } = await run(steps);
    expect(out.map((r) => (Array.isArray(r) ? r[0] : r)?.stdout)).toEqual(['made wandworks_copy', "imported wandworks.sql into wandworks_copy: 2 tables; left out 1 line that would change another database (USE, CREATE DATABASE)"]);
    expect(fake.calls.some((c) => c.input === 'CREATE DATABASE `wandworks_copy`;\n')).toBe(true);
    const imported = fake.calls.find((c) => c.inputText?.includes('CREATE TABLE t')) as FakeCall;
    expect(imported.args).toEqual(expect.arrayContaining(['--binary-mode', '--database=wandworks_copy']));
    expect(imported.inputText).not.toContain('USE `shop_com`');
    await undos[0]?.();
    expect(fake.calls.some((c) => c.input === 'DROP DATABASE IF EXISTS `wandworks_copy`;\n')).toBe(true);
  });

  it('saves a database no site uses before replacing it, and Undo puts it back from that copy', async () => {
    const tree = tempTree();
    const fake = fakeDb((sql) => (sql.includes('information_schema.SCHEMATA') ? { stdout: '1\n' } : undefined));
    const ctx: TransferContext = { config: tree.config, exec: fake.exec, mysql, kept: () => [], uploadsDir: withUpload(tree.root), backupsDir: join(tree.root, 'mysql-backups') };
    const steps = await planImportDump(ctx, { database: 'reports', uploadId: UPLOAD, mode: 'replace', confirm: 'reports' });
    expect(steps.map((s) => s.label)).toEqual(['Save reports to the MySQL backups', 'Empty reports', 'Import wandworks.sql']);
    const { undos } = await run(steps);
    const saved = fake.calls.find((c) => c.file === 'mysqldump') as FakeCall;
    expect(saved.args.slice(-2)).toEqual(['--databases', 'reports']);
    expect(fake.calls.some((c) => c.input === 'DROP DATABASE `reports`;\nCREATE DATABASE `reports`;\n')).toBe(true);
    await undos[0]?.();
    const back = fake.calls.filter((c) => c.inputText?.includes('CREATE TABLE `wp_posts`')).at(-1) as FakeCall;
    expect(back.args).not.toContain('--database=reports');
  });

  it("refuses a site's database, MySQL's own, a kept one, a name taken or missing, and an upload that is gone", async () => {
    const tree = wpSiteTree();
    const there = fakeDb((sql) => (sql.includes('information_schema.SCHEMATA') ? { stdout: '1\n' } : undefined));
    const ctx = (fake = there, kept: TransferContext['kept'] = () => []): TransferContext => ({ config: tree.config, exec: fake.exec, mysql, kept, uploadsDir: withUpload(tree.root), backupsDir: join(tree.root, 'b') });
    await expect(planImportDump(ctx(), { database: 'shop_com', uploadId: UPLOAD, mode: 'replace', confirm: 'shop_com' })).rejects.toThrow(/local.shop.com uses shop_com/);
    await expect(planImportDump(ctx(), { database: 'mysql', uploadId: UPLOAD, mode: 'replace', confirm: 'mysql' })).rejects.toThrow(/MySQL's own/);
    await expect(planImportDump(ctx(there, () => [{ name: 'shop_old', site: 'local.shop.com' }]), { database: 'shop_old', uploadId: UPLOAD, mode: 'replace', confirm: 'shop_old' })).rejects.toThrow(/kept for a site/);
    await expect(planImportDump(ctx(), { database: 'reports', uploadId: UPLOAD, mode: 'new' })).rejects.toThrow(/there already/);
    await expect(planImportDump(ctx(fakeDb()), { database: 'reports', uploadId: UPLOAD, mode: 'replace', confirm: 'reports' })).rejects.toThrow(/No database called reports/);
    await expect(planImportDump(ctx(), { database: 'reports', uploadId: '22222222-2222-2222-2222-222222222222', mode: 'new' })).rejects.toThrow(/upload is gone/);
  });
});

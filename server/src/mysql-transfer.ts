import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput } from '@devmagic-panel/shared';
import { isSystemDatabase } from '@devmagic-panel/shared';
import type { ExecResult } from './exec.js';
import type { JobStep } from './jobs.js';
import { type BrowseContext, checkDatabase, read } from './mysql-browse.js';
import type { MysqlAccount } from './mysql-limits.js';
import { MYSQL_BACKUP_DAYS, MysqlRefused, siteDatabases } from './mysql-server.js';
import { BrowseError, ident, textLiteral } from './mysql-sql.js';
import { formatBytes, progressNote } from './sites/db.js';
import { sqlFileFor } from './sites/dump.js';
import { dumpStream } from './sites/sql-stream.js';
import { readUpload } from './sites/uploads.js';

/**
 * Moving a database in and out of MySQL from the panel: a download of a
 * whole database or chosen tables as .sql.gz, streamed so nothing is left on
 * disk, and an import of an uploaded dump into a new database or one no site
 * uses (saved first for Undo). An import keeps to the database it was given:
 * a dump's own CREATE DATABASE, DROP DATABASE and USE lines are dropped, and
 * mysql runs it with --binary-mode, so nothing in it runs as a command of the
 * mysql client.
 */
const NOT_DUMPABLE = new Set(['information_schema', 'performance_schema']);

const base = (mysql: MysqlAccount) => ['--user', mysql.user, '--host', mysql.host];
const firstError = (r: ExecResult) => (r.stderr.trim().split('\n').find((l) => l.startsWith('ERROR') || l.startsWith('mysqldump:')) ?? r.stderr.trim().split('\n')[0] ?? `exit ${r.code}`).replace(/ at line \d+/, '');
const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

function account(mysql: MysqlAccount | null | undefined): MysqlAccount {
  if (!mysql) throw new MysqlRefused('The panel has no MySQL admin account: add one on the Environment page');
  return mysql;
}

// ── export ───────────────────────────────────────────────────

/**
 * A database, or the tables named, as a gzipped dump to download: no CREATE
 * DATABASE or USE, so it imports into any database. A whole database takes
 * its routines and events too. The stream errors when mysqldump fails, so a
 * download that broke off never looks finished.
 */
export async function exportDatabase(ctx: BrowseContext, database: string, tables: string[] = [], now = () => new Date()): Promise<{ filename: string; stream: Readable }> {
  const db = checkDatabase(database);
  if (NOT_DUMPABLE.has(db.toLowerCase())) throw new BrowseError(`${db} is MySQL's own view of the server, not a database to export`);
  const mysql = account(ctx.mysql);
  const names = new Set(await read(ctx, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(db)};\n`, { raw: false }));
  const unknown = tables.find((t) => !names.has(t));
  if (unknown !== undefined) throw new BrowseError(`No table called ${unknown} in ${db}`, 404);
  const whole = tables.length === 0;
  const out = new PassThrough();
  const gzip = out.pipe(createGzip({ level: 6 }));
  void ctx
    .exec(
      'mysqldump',
      [
        ...base(mysql),
        '--single-transaction', '--quick', '--skip-lock-tables', '--no-tablespaces', '--hex-blob', '--default-character-set=utf8mb4', '--max-allowed-packet=1G',
        ...(whole ? ['--routines', '--events'] : []),
        '--', db, ...tables,
      ],
      { env: { MYSQL_PWD: mysql.password }, stdoutTo: out, timeoutMs: 6 * 60 * 60_000 },
    )
    .then((r) => {
      if (r.code !== 0) gzip.destroy(new Error(`mysqldump stopped: ${firstError(r)}`));
    });
  const what = whole ? '' : tables.length === 1 ? `-${tables[0]}` : `-${tables.length}-tables`;
  return { filename: `${db}${what}-${stamp(now())}.sql.gz`, stream: gzip };
}

// ── import ───────────────────────────────────────────────────

/**
 * Drops the lines of a dump that would leave the database it is imported
 * into: CREATE DATABASE, DROP DATABASE and USE (mysqldump writes each on a
 * line of its own, at its start). Only the start of each line is looked at,
 * so a long INSERT line streams through as it is.
 */
export class OwnDatabaseOnly extends Transform {
  private head = '';
  /** At the start of a line, still reading its first bytes. */
  private start = true;
  private dropping = false;
  /** How many lines were dropped, for the job's output. */
  dropped = 0;

  private static readonly AWAY = /^\s*(?:USE\s|CREATE\s+(?:DATABASE|SCHEMA)\b|DROP\s+(?:DATABASE|SCHEMA)\b)/i;
  private static readonly ENOUGH = 32;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let text = chunk.toString('latin1');
    let out = '';
    while (text.length) {
      if (this.dropping) {
        const nl = text.indexOf('\n');
        if (nl < 0) return done(null, Buffer.from(out, 'latin1'));
        text = text.slice(nl + 1);
        this.dropping = false;
        this.start = true;
        continue;
      }
      if (this.start) {
        const nl = text.indexOf('\n');
        const piece = nl < 0 ? text : text.slice(0, nl + 1);
        this.head += piece;
        text = nl < 0 ? '' : text.slice(nl + 1);
        if (nl < 0 && this.head.length < OwnDatabaseOnly.ENOUGH) continue;
        if (OwnDatabaseOnly.AWAY.test(this.head)) {
          this.dropped++;
          this.dropping = nl < 0;
          if (nl >= 0) this.start = true;
        } else {
          out += this.head;
          this.start = nl >= 0;
        }
        this.head = '';
        continue;
      }
      const nl = text.indexOf('\n');
      if (nl < 0) {
        out += text;
        text = '';
      } else {
        out += text.slice(0, nl + 1);
        text = text.slice(nl + 1);
        this.start = true;
      }
    }
    done(null, Buffer.from(out, 'latin1'));
  }

  override _flush(done: TransformCallback): void {
    if (this.head && !OwnDatabaseOnly.AWAY.test(this.head)) return done(null, Buffer.from(this.head, 'latin1'));
    if (this.head) this.dropped++;
    done();
  }
}

export interface TransferContext {
  config: BrowseContext['config'];
  exec: BrowseContext['exec'];
  mysql: MysqlAccount | null | undefined;
  kept: () => Array<{ name: string; site: string }>;
  uploadsDir: string;
  /** Where a replaced database is saved first: the panel's MySQL backups. */
  backupsDir: string;
}

const browse = (ctx: TransferContext): BrowseContext => ({ config: ctx.config, exec: ctx.exec, mysql: ctx.mysql, kept: ctx.kept });

async function admin(ctx: TransferContext, statements: string): Promise<string[]> {
  const mysql = account(ctx.mysql);
  const r = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--binary-mode', ...base(mysql)], { env: { MYSQL_PWD: mysql.password }, input: statements, timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new MysqlRefused(`MySQL refused it: ${firstError(r)}`);
  return r.stdout.split('\n').filter(Boolean);
}

const exists = async (ctx: TransferContext, database: string) => (await admin(ctx, `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${textLiteral(database)};\n`))[0] === '1';

/** Streams a database to a gzipped file of the MySQL backups, CREATE DATABASE included, so Undo makes it again. */
async function saveDatabase(ctx: TransferContext, database: string, file: string, note: (line: string) => void): Promise<void> {
  const mysql = account(ctx.mysql);
  mkdirSync(ctx.backupsDir, { recursive: true, mode: 0o700 });
  const part = `${file}.part`;
  const out = new PassThrough();
  let bytes = 0;
  out.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    note(`${formatBytes(bytes)} of SQL`);
  });
  const written = pipeline(out, createGzip({ level: 6 }), createWriteStream(part, { mode: 0o600 }));
  const r = await ctx.exec('mysqldump', [...base(mysql), '--single-transaction', '--quick', '--no-tablespaces', '--routines', '--events', '--max-allowed-packet=1G', '--databases', database], {
    env: { MYSQL_PWD: mysql.password },
    stdoutTo: out,
    timeoutMs: 6 * 60 * 60_000,
  });
  if (r.code !== 0) out.destroy();
  const failed = await written.then(() => null, (error: Error) => error);
  if (r.code !== 0 || failed) {
    rmSync(part, { force: true });
    throw new MysqlRefused(r.code !== 0 ? `could not save ${database}: ${firstError(r)}` : `could not write ${file}: ${failed?.message}`);
  }
  renameSync(part, file);
}

/** Streams a saved or uploaded dump into a database, with --binary-mode and, for an upload, its database lines dropped. */
async function importInto(ctx: TransferContext, database: string | null, file: string, onRead: (read: number, total: number) => void, filter?: OwnDatabaseOnly): Promise<ExecResult> {
  const mysql = account(ctx.mysql);
  const wrap = { before: "SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\n", after: '\nCOMMIT;\n' };
  const source = dumpStream(file, wrap, onRead);
  return ctx.exec('mysql', ['--binary-mode', '--default-character-set=utf8mb4', '--max-allowed-packet=1G', ...base(mysql), ...(database ? [`--database=${database}`] : [])], {
    env: { MYSQL_PWD: mysql.password },
    inputStream: filter ? source.pipe(filter) : source,
    timeoutMs: 24 * 60 * 60_000,
    inputStallMs: 15 * 60_000,
  });
}

/**
 * An uploaded dump into a database: a new one, or one no site uses, which is
 * saved to the MySQL backups first (14 days) and made empty again. Undo
 * deletes what the import made and, for a replaced one, puts it back.
 */
export async function planImportDump(ctx: TransferContext, { database, uploadId, mode }: ActionInput<'mysql.importDump'>): Promise<JobStep[]> {
  const upload = readUpload(ctx.uploadsDir, uploadId);
  if (!upload || !existsSync(upload.file)) throw new MysqlRefused('That upload is gone: choose the dump again');
  if (isSystemDatabase(database)) throw new MysqlRefused(`${database} is MySQL's own: the panel never imports into it`);
  if (ctx.kept().some((k) => k.name === database)) throw new MysqlRefused(`${database} is kept for a site to put back: import into another database`);
  const using = siteDatabases(ctx.config).filter((s) => s.db === database);
  if (using.length) throw new MysqlRefused(`${using.map((s) => `${s.domain}${s.path ?? ''}`).join(', ')} uses ${database}: import into a site on its Database tab, Backups and tools`);
  const there = await exists(ctx, database);
  if (mode === 'new' && there) throw new MysqlRefused(`A database called ${database} is there already: pick Replace, or another name`);
  if (mode === 'replace' && !there) throw new MysqlRefused(`No database called ${database}: pick New`);
  const backup = join(ctx.backupsDir, `${database}-${stamp()}.sql.gz`);
  const steps: JobStep[] = [];
  if (mode === 'replace') {
    steps.push({
      id: 'save',
      label: `Save ${database} to the MySQL backups`,
      weight: 3,
      run: async (job) => {
        await saveDatabase(ctx, database, backup, (line) => job.progress(0, line));
        return { code: 0, stdout: `saved ${backup} (${formatBytes(statSync(backup).size)} gzipped), kept ${MYSQL_BACKUP_DAYS} days`, stderr: '' };
      },
    });
  }
  steps.push({
    id: 'make',
    label: mode === 'replace' ? `Empty ${database}` : `Make database ${database}`,
    run: async (job) => {
      // The server's default character set; an empty database again when replacing.
      await admin(ctx, `${mode === 'replace' ? `DROP DATABASE ${ident(database)};\n` : ''}CREATE DATABASE ${ident(database)};\n`);
      job.onUndo(mode === 'replace' ? `Put ${database} back from ${backup}` : `Delete database ${database}`, async () => {
        await admin(ctx, `DROP DATABASE IF EXISTS ${ident(database)};\n`);
        if (mode === 'new') return { code: 0, stdout: `deleted ${database}`, stderr: '' };
        if (!existsSync(backup)) return { code: 1, stdout: '', stderr: `${backup} is gone` };
        const back = await importInto(ctx, null, backup, () => undefined);
        return back.code === 0 ? { code: 0, stdout: `put ${database} back from ${backup}`, stderr: '' } : back;
      });
      return { code: 0, stdout: mode === 'replace' ? `${database} is empty` : `made ${database}`, stderr: '' };
    },
  });
  steps.push({
    id: 'import',
    label: `Import ${upload.name}`,
    weight: 6,
    run: async (job) => {
      const sql = upload.file.endsWith('.zip') ? await sqlFileFor(ctx.exec, upload.file, upload.dir) : upload.file;
      const filter = new OwnDatabaseOnly();
      const started = Date.now();
      const r = await importInto(ctx, database, sql, (done, total) => job.progress(total ? done / total : 1, progressNote(done, total, started)), filter);
      if (r.code !== 0) return { ...r, stderr: firstError(r) };
      const skipped = filter.dropped ? `; left out ${filter.dropped} line${filter.dropped === 1 ? '' : 's'} that would change another database (USE, CREATE DATABASE)` : '';
      const count = await read(browse(ctx), `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)};\n`, { raw: false });
      return { code: 0, stdout: `imported ${upload.name} into ${database}: ${count[0] ?? 0} tables${skipped}`, stderr: '' };
    },
  });
  return steps;
}

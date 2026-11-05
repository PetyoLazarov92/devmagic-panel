import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ActionInput, CleanCopyInfo, LeftoverEmails } from '@devmagic-panel/shared';
import { cleanCopyName, isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { freshStatsSql } from '../mysql-stats.js';
import { type DbContext, DbRefused, formatBytes, isLocalDbHost, limitsTarget, progressNote } from './db.js';
import { siteFor } from './site-actions.js';

/**
 * A site's database exported as a gzipped dump to share with the team: the
 * dump streams through a check for email addresses, then gzip, into the
 * site's clean copies folder, with no file written on the way. The check only
 * reports, so something private a cleanup missed (a plugin's own table)
 * shows before the file is shared.
 */

// A row statement at the start of a line, where a dump's statements begin.
const ROW_STATEMENT = /^(?:INSERT|REPLACE)\b[^\n(]*?\bINTO\s+[`"]?([\w$]+)[`"]?/gim;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,24}))\b/g;
/** What looks like an address but is a file: logo@2x.png. */
const FILE_ENDINGS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'css', 'js', 'php', 'html', 'json', 'woff', 'woff2']);
/** Domains for examples and documentation (RFC 2606), which hold nobody's address. */
const EXAMPLE_DOMAIN = /(^|\.)example\.(com|net|org)$/i;
const CARRY = 400;
const MAX_TABLES = 10;
const SAMPLES = 3;

/** An address worth reporting: not a local name, not .invalid or .example, not an example domain, not a file. */
export function personalAddress(domain: string, ending: string): boolean {
  const d = domain.toLowerCase();
  return !isLocalName(d) && !FILE_ENDINGS.has(ending.toLowerCase()) && !/\.(invalid|example|test|localhost|local)$/.test(d) && !EXAMPLE_DOMAIN.test(d);
}

/** jane@acme.com as j***@acme.com: enough to find it, not the address. */
const mask = (address: string) => {
  const at = address.indexOf('@');
  return `${address.slice(0, 1)}***${address.slice(at)}`;
};

/** Passes a dump through untouched and counts the email addresses in each table's rows. */
export class LeftoverCheck extends Transform {
  private readonly tables = new Map<string, { count: number; samples: string[] }>();
  private table = '(outside rows)';
  private carry = '';
  private carryAtLineStart = true;
  private total = 0;
  /** Bytes passed through, for progress. */
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    this.scan(chunk.toString('utf8'), false);
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    this.scan('', true);
    done();
  }

  private scan(chunk: string, last: boolean): void {
    const text = this.carry + chunk;
    const cut = last ? text.length : Math.max(0, text.length - CARRY);
    let from = 0;
    ROW_STATEMENT.lastIndex = 0;
    for (const m of text.matchAll(ROW_STATEMENT)) {
      if (m.index >= cut) break;
      if (m.index === 0 ? !this.carryAtLineStart : text[m.index - 1] !== '\n') continue;
      this.count(text, from, m.index);
      this.table = m[1] as string;
      from = m.index;
    }
    this.count(text, from, cut);
    this.carry = text.slice(cut);
    this.carryAtLineStart = cut === 0 ? this.carryAtLineStart : text[cut - 1] === '\n';
  }

  /** The addresses in text[from..] that start before end, as the current table's. */
  private count(text: string, from: number, end: number): void {
    if (from >= end || !text.includes('@', from)) return;
    EMAIL.lastIndex = from;
    for (let m = EMAIL.exec(text); m && m.index < end; m = EMAIL.exec(text)) {
      if (!personalAddress(m[1] as string, m[2] as string)) continue;
      const seen = this.tables.get(this.table) ?? { count: 0, samples: [] };
      seen.count++;
      const sample = mask(m[0]);
      if (seen.samples.length < SAMPLES && !seen.samples.includes(sample)) seen.samples.push(sample);
      this.tables.set(this.table, seen);
      this.total++;
    }
  }

  result(): LeftoverEmails {
    const tables = [...this.tables]
      .map(([table, { count, samples }]) => ({ table, count, samples }))
      .sort((a, b) => b.count - a.count || a.table.localeCompare(b.table))
      .slice(0, MAX_TABLES);
    return { total: this.total, tables };
  }
}

/** The leftover check as lines for a step's output. */
export function leftoverReport(found: LeftoverEmails): string {
  if (found.total === 0) return 'no email addresses left in it, apart from local and example ones';
  const lines = found.tables.map((t) => `  ${t.table}: ${t.count.toLocaleString('en-US')} (${t.samples.join(', ')})`);
  return [`${found.total.toLocaleString('en-US')} email address${found.total === 1 ? '' : 'es'} left in it; check these before sharing it:`, ...lines].join('\n');
}

/** A site's clean copies folder, by its key. */
export const cleanDir = (config: SystemConfig, key: string) => join(config.BACKUP_DIR, 'clean', key);

/** acme.com-local-clean-2026.10.28.sql.gz from local.acme.com (local.acme.com@learn gives acme.com-learn), -2 and up when that day has one. */
export function cleanCopyFileName(key: string, taken: (name: string) => boolean, at = new Date()): string {
  const base = key.replace(/^(www\.)?local\./, '').replaceAll('@', '-');
  const day = `${at.getFullYear()}.${String(at.getMonth() + 1).padStart(2, '0')}.${String(at.getDate()).padStart(2, '0')}`;
  for (let n = 1; ; n++) {
    const name = `${base}-local-clean-${day}${n > 1 ? `-${n}` : ''}.sql.gz`;
    if (!taken(name)) return name;
  }
}

export function listCleanCopies(config: SystemConfig, key: string): CleanCopyInfo[] {
  const dir = cleanDir(config, key);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => cleanCopyName.safeParse(name).success)
    .map((name) => {
      const st = statSync(join(dir, name));
      let leftover: LeftoverEmails | undefined;
      try {
        leftover = (JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { leftoverEmails?: LeftoverEmails }).leftoverEmails;
      } catch {
        // No check kept for it.
      }
      return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), ...(leftover ? { leftoverEmails: leftover } : {}) };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteCleanCopy(config: SystemConfig, { domain, path, name }: ActionInput<'db.deleteCleanCopy'>): ExecResult {
  const site = siteFor(config, domain, path);
  const file = join(cleanDir(config, site.key), name);
  if (!existsSync(file)) throw new DbRefused(`no clean copy called ${name}`);
  rmSync(file);
  rmSync(`${file}.json`, { force: true });
  return { code: 0, stdout: `deleted ${file}`, stderr: '' };
}

/**
 * The export: mysqldump with the admin account when the database is on this
 * machine (one consistent read, a row at a time), else wp db export, its
 * output streamed through the check and gzip into a .part file that becomes
 * the clean copy once all of it is written.
 */
export function planExportClean(ctx: DbContext, { domain, path }: ActionInput<'db.exportClean'>): JobStep[] {
  const site = siteFor(ctx.config, domain, path);
  const db = site.wp.dbName;
  if (!db) throw new DbRefused(`${site.host} has no DB_NAME in wp-config.php`);
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  return [
    {
      id: 'export',
      label: `Export ${db} as a clean copy`,
      weight: 5,
      run: async (job) => {
        const dir = cleanDir(ctx.config, site.key);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = cleanCopyFileName(site.key, (n) => existsSync(join(dir, n)));
        const file = join(dir, name);
        const part = join(dir, `.${name}.part`);
        // How much SQL to expect, roughly: the tables' data, for the progress bar.
        let expected = 0;
        if (target) {
          const { user, host, password } = target.mysql;
          const size = await ctx.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', `${await freshStatsSql(ctx.exec, target.mysql)}SELECT COALESCE(SUM(DATA_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db.replace(/'/g, '')}'`], {
            env: { MYSQL_PWD: password },
          });
          expected = Number(size.stdout.trim()) || 0;
        }
        const check = new LeftoverCheck();
        const started = Date.now();
        let shown = 0;
        check.on('data', () => {
          if (check.bytes - shown < 16 * 1024 ** 2) return;
          shown = check.bytes;
          job.progress(expected ? Math.min(0.99, check.bytes / expected) : 0, expected ? progressNote(check.bytes, Math.max(expected, check.bytes), started) : `${formatBytes(check.bytes)} of SQL`);
        });
        const written = pipeline(check, createGzip({ level: 6 }), createWriteStream(part, { mode: 0o600 }));
        const streamed = { stdoutTo: check, timeoutMs: 6 * 60 * 60_000 };
        let r: ExecResult;
        if (target) {
          const { user, host, password } = target.mysql;
          r = await ctx.exec(
            'mysqldump',
            ['--user', user, '--host', host, '--single-transaction', '--quick', '--no-tablespaces', `--default-character-set=${site.wp.dbCharset ?? 'utf8mb4'}`, '--max-allowed-packet=1G', db],
            { ...streamed, env: { MYSQL_PWD: password } },
          );
        } else {
          r = await ctx.exec('wp', [`--path=${site.docroot}`, `--url=https://${site.host}/`, 'db', 'export', '-', '--skip-plugins', '--skip-themes'], streamed);
        }
        if (r.code !== 0) check.destroy();
        const wrote = await written.then(
          () => null,
          (error: Error) => error,
        );
        if (r.code !== 0 || wrote) {
          rmSync(part, { force: true });
          return r.code !== 0 ? r : { code: 1, stdout: '', stderr: `could not write ${file}: ${wrote?.message}` };
        }
        renameSync(part, file);
        const found = check.result();
        writeFileSync(`${file}.json`, JSON.stringify({ leftoverEmails: found }), { mode: 0o600 });
        return [
          { code: 0, stdout: `saved ${file} (${formatBytes(statSync(file).size)} gzipped, ${formatBytes(check.bytes)} of SQL)`, stderr: '' },
          { code: 0, stdout: leftoverReport(found), stderr: '' },
        ];
      },
    },
  ];
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { runCommand } from '../src/exec.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { cleanCopyFileName, cleanDir, LeftoverCheck, listCleanCopies, personalAddress } from '../src/sites/export.js';
import { RunStore } from '../src/store.js';
import type { FakeResponse } from './helpers.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

async function through(text: string, size = text.length || 1) {
  const check = new LeftoverCheck();
  const out: Buffer[] = [];
  const bytes = Buffer.from(text);
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  for await (const chunk of Readable.from(chunks).pipe(check)) out.push(chunk as Buffer);
  return { passed: Buffer.concat(out).toString(), found: check.result() };
}

const DUMP = [
  '-- MySQL dump 10.13',
  'CREATE TABLE `wp_options` (`option_value` longtext);',
  "INSERT INTO `wp_options` VALUES (1,'admin_email','admin@local.shop.com'),(2,'logo','logo@2x.png'),(3,'docs','you@example.com');",
  "INSERT INTO `wp_postmeta` VALUES (1,5,'_field_email','jane.doe@customer.net'),(2,6,'_field_email','JOHN@Customer.net'),(3,7,'x','a:1:{s:5:\\\"email\\\";s:15:\\\"ann@company.org\\\";}');",
  "INSERT INTO `wp_comments` VALUES (1,'commenter-1@local.invalid','someone@supplier.net');",
  '',
].join('\n');

describe('the leftover check', () => {
  it('counts the addresses left per table, a few masked as samples, and passes the dump through untouched', async () => {
    const { passed, found } = await through(DUMP);
    expect(passed).toBe(DUMP);
    expect(found).toEqual({
      total: 4,
      tables: [
        { table: 'wp_postmeta', count: 3, samples: ['j***@customer.net', 'J***@Customer.net', 'a***@company.org'] },
        { table: 'wp_comments', count: 1, samples: ['s***@supplier.net'] },
      ],
    });
  });

  it('gives the same count however the dump is cut into chunks', async () => {
    const whole = (await through(DUMP)).found;
    for (const size of [1, 7, 64, 399, 400, 401, 4096]) expect((await through(DUMP, size)).found, `chunks of ${size}`).toEqual(whole);
  });

  it('leaves out local, example and invalid addresses, and files that look like one', () => {
    expect(personalAddress('customer.net', 'net')).toBe(true);
    for (const [domain, ending] of [['local.shop.com', 'com'], ['shop.test', 'test'], ['local.invalid', 'invalid'], ['mail.example.org', 'org'], ['2x.png', 'png']] as const) {
      expect(personalAddress(domain, ending), domain).toBe(false);
    }
  });
});

describe('a clean copy file', () => {
  it('is named after the site and the day, with -2 and up for another that day', () => {
    const at = new Date(2026, 9, 28, 14, 30);
    expect(cleanCopyFileName('local.wandworks.example', () => false, at)).toBe('wandworks.example-local-clean-2026.10.28.sql.gz');
    expect(cleanCopyFileName('local.wandworks.example@learn', () => false, at)).toBe('wandworks.example-learn-local-clean-2026.10.28.sql.gz');
    const taken = new Set(['wandworks.test-local-clean-2026.10.28.sql.gz', 'wandworks.test-local-clean-2026.10.28-2.sql.gz']);
    expect(cleanCopyFileName('wandworks.test', (n) => taken.has(n), at)).toBe('wandworks.test-local-clean-2026.10.28-3.sql.gz');
  });
});

describe('a program whose output streams', () => {
  it('writes all of it to the stream and keeps none of it in the result', async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _e, done) => (chunks.push(chunk), done()) });
    const r = await runCommand('seq', ['1', '200000'], { stdoutTo: sink });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    const text = Buffer.concat(chunks).toString();
    expect(text.startsWith('1\n2\n')).toBe(true);
    expect(text.endsWith('199999\n200000\n')).toBe(true);
  });

  it('is stopped when the stream cannot be written, and says why', async () => {
    const full = new Writable({ write: (_chunk, _e, done) => done(new Error('ENOSPC: no space left on device')) });
    const r = await runCommand('seq', ['1', '10000000'], { stdoutTo: full, timeoutMs: 10_000 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not write the output: ENOSPC: no space left on device');
  });

  it('says so when the program is not there', async () => {
    const r = await runCommand('no-such-program-wandworks', [], { stdoutTo: new PassThrough() });
    expect(r.code).toBe(127);
  });
});

describe('a program that ends on a signal', () => {
  it('says it took too long when the timeout stopped it', async () => {
    const r = await runCommand('sleep', ['5'], { timeoutMs: 1000 });
    expect(r.code).toBe(127);
    expect(r.stderr).toBe('stopped: it took longer than 1 s');
  });
});

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id);
    if (view && !['running', 'queued'].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

function setup(responses: Record<string, FakeResponse>, admin = true) {
  const t = wpSiteTree();
  const fake = fakeExec(responses);
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir: join(t.root, 'uploads'),
    secrets: admin ? { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } } : { panelPasswordHash: 'x' },
  };
  const exportOnce = async () => settle(jobs, (await runAction(ctx, 'db.exportClean', { domain: 'local.shop.com' })).data?.jobId as string);
  return { ctx, calls: fake.calls, exportOnce, docroot: t.docroot };
}

describe('exporting a clean copy', () => {
  it('streams mysqldump through the check and gzip into the clean copies folder, and keeps what the check found', async () => {
    const s = setup({ mysqldump: { stdout: DUMP }, 'mysql --batch': { stdout: '1048576\n' } });
    const view = await s.exportOnce();
    expect(view.status).toBe('done');
    const dump = s.calls.find((c) => c.file === 'mysqldump');
    expect(dump?.args).toEqual(['--user', 'root', '--host', 'localhost', '--single-transaction', '--quick', '--no-tablespaces', '--default-character-set=utf8mb4', '--max-allowed-packet=1G', 'shop_com']);
    expect(dump?.env).toEqual({ MYSQL_PWD: 'adminpw' });
    const dir = cleanDir(s.ctx.config, 'local.shop.com');
    const [copy] = listCleanCopies(s.ctx.config, 'local.shop.com');
    expect(copy?.name).toMatch(/^shop\.com-local-clean-\d{4}\.\d{2}\.\d{2}\.sql\.gz$/);
    expect(gunzipSync(readFileSync(join(dir, copy?.name as string))).toString()).toBe(DUMP);
    expect(copy?.leftoverEmails?.total).toBe(4);
    // Nothing half written is left behind.
    expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(view.steps[0]?.output).toContain('4 email addresses left in it; check these before sharing it:\n  wp_postmeta: 3 (j***@customer.net');

    await runAction(s.ctx, 'db.deleteCleanCopy', { domain: 'local.shop.com', name: copy?.name as string });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('exports through WP-CLI without the admin account', async () => {
    const s = setup({ wp: { stdout: '-- dump\n' } }, false);
    const view = await s.exportOnce();
    expect(view.status).toBe('done');
    expect(s.calls.find((c) => c.file === 'wp')?.args.slice(2)).toEqual(['db', 'export', '-', '--skip-plugins', '--skip-themes']);
    expect(view.steps[0]?.output).toContain('no email addresses left in it');
  });

  it('removes the half-written file when the dump fails', async () => {
    const s = setup({ mysqldump: { code: 2, stderr: "mysqldump: Got error: 1045: Access denied for user 'root'@'localhost'" }, 'mysql --batch': { stdout: '0\n' } });
    const view = await s.exportOnce();
    expect(view.status).toBe('failed');
    expect(view.steps[0]?.output).toContain('Access denied');
    const dir = cleanDir(s.ctx.config, 'local.shop.com');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

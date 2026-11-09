import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { actions } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { JobStep } from '../src/jobs.js';
import { planLocalDump, planServerDump, serverTables, SSH_OPTIONS } from '../src/sites/more-dumps.js';
import { readUpload } from '../src/sites/uploads.js';
import { DMP, fakeExec, type FakeCall, wpSiteTree } from './helpers.js';

const SQL = "-- MySQL dump\nCREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.spellbook.example','yes');\n";
const job = () => ({ progress: () => undefined, onUndo: () => undefined }) as unknown as Parameters<JobStep['run']>[0];
const run = async (steps: JobStep[]) => (await (steps[0] as JobStep).run(job())) as { code: number; stdout: string; stderr: string };
const uploadOf = (out: string) => /upload ([0-9a-f-]{36})/.exec(out)?.[1] ?? '';

describe('a dump from a server over SSH', () => {
  const parse = (input: Record<string, unknown>) => actions['dump.fromServer'].input.safeParse(input);

  it('takes an ssh alias or user@host and a plain absolute path, nothing a shell could read', () => {
    expect(parse({ host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook/public' }).success).toBe(true);
    expect(parse({ host: 'alex@www.spellbook.example', mode: 'file', path: '/home/alex/backups/spellbook.sql.gz' }).success).toBe(true);
    for (const bad of [
      { host: '-oProxyCommand=x', mode: 'export', path: '/var/www' },
      { host: 'staging', mode: 'export', path: '/var/www; rm -rf ~' },
      { host: 'staging', mode: 'export', path: '/var/www/$(id)' },
      { host: 'staging', mode: 'export', path: 'relative/path' },
      { host: 'staging', mode: 'export', path: '/var/www/../etc' },
      { host: 'staging', mode: 'file', path: '/home/alex/notes.txt' },
      { host: 'staging host', mode: 'file', path: '/a.sql' },
    ]) {
      expect(parse(bad).success).toBe(false);
    }
  });

  it('copies a dump file with sftp, commands on stdin, never asking for a password or trusting a new host', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const fake = fakeExec({
      sftp: (call: FakeCall) => {
        const [, , local] = (call.input ?? '').trim().split(' ');
        writeFileSync(local as string, SQL);
        return { stdout: '' };
      },
    });
    let id = '';
    const r = await run(planServerDump({ config: t.config, exec: fake.exec, uploadsDir, dmpRoot: DMP }, { host: 'staging-spellbook', mode: 'file', path: '/home/alex/backups/spellbook.sql', excludeRows: [] }, (u) => (id = u)));
    expect(r.code).toBe(0);
    expect(fake.calls[0]?.args).toEqual(['-q', '-b', '-', ...SSH_OPTIONS, '--', 'staging-spellbook']);
    expect(SSH_OPTIONS).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes']));
    expect(fake.calls[0]?.input).toMatch(/^get \/home\/alex\/backups\/spellbook\.sql \S+\.more-[0-9a-f-]+-spellbook\.sql\n$/);
    expect(readUpload(uploadsDir, id)?.name).toBe('spellbook.sql');
    expect(readdirSync(uploadsDir)).toEqual([id]);
  });

  const DONE = `${SQL}-- Dump completed on 2026-11-09 10:00:00\n`;
  const exportArgs = ['--path=/var/www/spellbook', 'db', 'export', '-', '--single-transaction', '--quick', '--no-tablespaces', '--skip-plugins', '--skip-themes'];
  const serverCtx = (exec: ReturnType<typeof fakeExec>['exec'], uploadsDir: string, config: ReturnType<typeof wpSiteTree>['config']) => ({ config, exec, uploadsDir, dmpRoot: DMP });

  it('exports with WP-CLI on the server, compressed on the way and into a gzip here, and says plainly when the host key is unknown', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const fake = fakeExec({ ssh: { stdout: DONE } });
    const r = await run(planServerDump(serverCtx(fake.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined));
    expect(r.code).toBe(0);
    expect(fake.calls[0]?.args).toEqual([...SSH_OPTIONS, '--', 'staging-spellbook', 'wp', ...exportArgs]);
    expect(SSH_OPTIONS).toEqual(expect.arrayContaining(['Compression=yes']));
    const info = readUpload(uploadsDir, uploadOf(r.stdout));
    expect(info?.name).toMatch(/^staging-spellbook-\d{4}-\d{2}-\d{2}\.sql\.gz$/);
    expect(gunzipSync(readFileSync(info?.file as string)).toString()).toBe(DONE);

    const unknown = fakeExec({ ssh: { code: 255, stderr: 'No ED25519 host key is known for staging-spellbook and you have requested strict checking.\nHost key verification failed.' } });
    const refused = await run(planServerDump(serverCtx(unknown.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined));
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('not in your known_hosts') });
    expect(readdirSync(uploadsDir).filter((n) => n.startsWith('.more-'))).toEqual([]);
  });

  it('runs WP-CLI again through php with exec allowed, once, when the host disables it and it dies without a word', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const fake = fakeExec({
      ssh: (call: FakeCall) => {
        if (call.args.includes('command')) return { stdout: '/usr/local/bin/wp\n' };
        if (call.args.includes('php')) return { stdout: DONE };
        return { code: 255 };
      },
    });
    const r = await run(planServerDump(serverCtx(fake.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined)) as unknown as Array<{ code: number; stdout: string }>;
    const all = Array.isArray(r) ? r : [r];
    expect(all.every((x) => x.code === 0)).toBe(true);
    expect(all.map((x) => x.stdout).join('\n')).toContain('for that one run only, nothing changed on the server');
    expect(fake.calls.map((c) => c.args.slice(SSH_OPTIONS.length + 2, SSH_OPTIONS.length + 9).join(' '))).toEqual([
      'wp --path=/var/www/spellbook db export - --single-transaction --quick',
      'command -v wp',
      'php -d disable_functions= -d display_errors=stderr /usr/local/bin/wp --path=/var/www/spellbook',
    ]);

    // No wp to find: the exit code and what to try, never a bare "ssh stopped".
    const quiet = fakeExec({ ssh: { code: 255, stderr: '' } });
    const silent = await run(planServerDump(serverCtx(quiet.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined));
    expect(silent.stderr).toMatch(/^staging-spellbook ended with exit 255 and printed nothing: WP-CLI on the server stopped without a word/);
    const empty = fakeExec({ ssh: { stdout: '' } });
    expect((await run(planServerDump(serverCtx(empty.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined))).stderr).toMatch(/sent no SQL/);
  });

  it('refuses a dump cut off on the way, and leaves nothing behind', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const cut = fakeExec({ ssh: { stdout: SQL } });
    const r = await run(planServerDump(serverCtx(cut.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined));
    expect(r).toMatchObject({ code: 1, stderr: expect.stringContaining('stopped before its end') });
    expect(existsSync(uploadsDir) ? readdirSync(uploadsDir) : []).toEqual([]);
  });

  it('leaves out the rows of the tables asked for and brings their structure, in one file', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const STRUCTURE = 'CREATE TABLE `wp_actionscheduler_logs` (x int);\n-- Dump completed on 2026-11-09 10:00:01\n';
    const fake = fakeExec({ ssh: (call: FakeCall) => ({ stdout: call.args.includes('--no-data') ? STRUCTURE : DONE }) });
    const r = await run(planServerDump(serverCtx(fake.exec, uploadsDir, t.config), { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: ['wp_actionscheduler_logs', 'wp_wfhits'] }, () => undefined)) as unknown as Array<{ stdout: string }>;
    const all = Array.isArray(r) ? r : [r];
    expect(fake.calls[0]?.args.at(-1)).toBe('--exclude_tables=wp_actionscheduler_logs,wp_wfhits');
    expect(fake.calls[1]?.args.slice(-2)).toEqual(['--tables=wp_actionscheduler_logs,wp_wfhits', '--no-data']);
    const info = readUpload(uploadsDir, uploadOf(all.map((x) => x.stdout).join('\n')));
    expect(gunzipSync(readFileSync(info?.file as string)).toString()).toBe(DONE + STRUCTURE);
    expect(actions['dump.fromServer'].input.safeParse({ host: 'h', mode: 'export', path: '/a', excludeRows: ['wp_x; DROP'] }).success).toBe(false);
  });

  it("lists the server's tables biggest first, names checked", async () => {
    const fake = fakeExec({ ssh: { stdout: JSON.stringify([{ Name: 'wp_options', Size: '1048576' }, { Name: 'wp_actionscheduler_logs', Size: '734003200' }, { Name: 'bad name', Size: '1' }]) } });
    expect(await serverTables(fake.exec, 'staging-spellbook', '/var/www/spellbook')).toEqual([{ name: 'wp_actionscheduler_logs', bytes: 734003200 }, { name: 'wp_options', bytes: 1048576 }]);
  });
});

describe('a dump from this machine', () => {
  it("exports another site's database, takes one of its snapshots, or copies a deleted site's dump through dmp-root", async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const ctx = (exec: ReturnType<typeof fakeExec>['exec']) => ({ config: t.config, exec, uploadsDir, dmpRoot: DMP });

    const wp = fakeExec({ wp: (call: FakeCall) => (writeFileSync(call.args.find((a) => a.includes('.more-')) as string, SQL), { stdout: 'Success: Exported' }) });
    const site = await run(planLocalDump(ctx(wp.exec), { kind: 'site', domain: 'local.shop.com', excludeRows: [] }, () => undefined));
    expect(site.code).toBe(0);
    expect(wp.calls[0]?.args.slice(0, 4)).toEqual([`--path=${t.docroot}`, '--url=https://local.shop.com/', 'db', 'export']);

    const snapshots = join(t.config.BACKUP_DIR, 'snapshots', 'local.shop.com');
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, '20261101-090000-before-update.sql.gz'), gzipSync(SQL));
    const snap = await run(planLocalDump(ctx(fakeExec().exec), { kind: 'snapshot', domain: 'local.shop.com', snapshot: '20261101-090000-before-update.sql.gz' }, () => undefined));
    expect(snap.code).toBe(0);
    expect(readdirSync(snapshots)).toEqual(['20261101-090000-before-update.sql.gz']);
    expect(() => planLocalDump(ctx(fakeExec().exec), { kind: 'snapshot', domain: 'local.shop.com', snapshot: '20261102-090000.sql.gz' }, () => undefined)).toThrow(/has no snapshot/);

    const copy = join(t.config.BACKUP_DIR, 'sites', 'copy-local.old.test-20261101-090000.sql.gz');
    const root = fakeExec({
      [`sudo -n ${DMP} trash-dump local.old.test-20261101-090000`]: () => {
        mkdirSync(join(t.config.BACKUP_DIR, 'sites'), { recursive: true });
        writeFileSync(copy, gzipSync(SQL));
        return { stdout: `DUMP=${copy}\nok` };
      },
    });
    const archived = await run(planLocalDump(ctx(root.exec), { kind: 'archive', id: 'local.old.test-20261101-090000' }, () => undefined));
    expect(archived.code).toBe(0);
    expect(readUpload(uploadsDir, uploadOf(archived.stdout))?.name).toBe('local.old.test-20261101-090000.sql.gz');
    expect(existsSync(copy)).toBe(false);

    // A path dmp-root names outside the panel's sites folder is never taken.
    const odd = fakeExec({ [`sudo -n ${DMP} trash-dump local.old.test-20261101-090000`]: { stdout: 'DUMP=/etc/shadow\n' } });
    expect(await run(planLocalDump(ctx(odd.exec), { kind: 'archive', id: 'local.old.test-20261101-090000' }, () => undefined))).toMatchObject({ code: 1, stderr: expect.stringContaining('gave no dump') });
  });
});

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { actions } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { JobStep } from '../src/jobs.js';
import { planLocalDump, planServerDump, SSH_OPTIONS } from '../src/sites/more-dumps.js';
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
    const r = await run(planServerDump({ config: t.config, exec: fake.exec, uploadsDir, dmpRoot: DMP }, { host: 'staging-spellbook', mode: 'file', path: '/home/alex/backups/spellbook.sql' }, (u) => (id = u)));
    expect(r.code).toBe(0);
    expect(fake.calls[0]?.args).toEqual(['-q', '-b', '-', ...SSH_OPTIONS, '--', 'staging-spellbook']);
    expect(SSH_OPTIONS).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes']));
    expect(fake.calls[0]?.input).toMatch(/^get \/home\/alex\/backups\/spellbook\.sql \S+\.more-[0-9a-f-]+-spellbook\.sql\n$/);
    expect(readUpload(uploadsDir, id)?.name).toBe('spellbook.sql');
    expect(readdirSync(uploadsDir)).toEqual([id]);
  });

  it('exports with WP-CLI on the server into a gzip here, and says plainly when the host key is unknown', async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const fake = fakeExec({ ssh: { stdout: SQL } });
    const r = await run(planServerDump({ config: t.config, exec: fake.exec, uploadsDir, dmpRoot: DMP }, { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook' }, () => undefined));
    expect(r.code).toBe(0);
    expect(fake.calls[0]?.args).toEqual([...SSH_OPTIONS, '--', 'staging-spellbook', 'wp', '--path=/var/www/spellbook', 'db', 'export', '-', '--single-transaction', '--quick', '--skip-plugins', '--skip-themes']);
    const info = readUpload(uploadsDir, uploadOf(r.stdout));
    expect(info?.name).toMatch(/^staging-spellbook-\d{4}-\d{2}-\d{2}\.sql\.gz$/);
    expect(gunzipSync(readFileSync(info?.file as string)).toString()).toBe(SQL);

    const unknown = fakeExec({ ssh: { code: 255, stderr: 'No ED25519 host key is known for staging-spellbook and you have requested strict checking.\nHost key verification failed.' } });
    const refused = await run(planServerDump({ config: t.config, exec: unknown.exec, uploadsDir, dmpRoot: DMP }, { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook' }, () => undefined));
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('not in your known_hosts') });
    expect(readdirSync(uploadsDir).filter((n) => n.startsWith('.more-'))).toEqual([]);
  });
});

describe('a dump from this machine', () => {
  it("exports another site's database, takes one of its snapshots, or copies a deleted site's dump through dmp-root", async () => {
    const t = wpSiteTree();
    const uploadsDir = join(t.root, 'uploads');
    const ctx = (exec: ReturnType<typeof fakeExec>['exec']) => ({ config: t.config, exec, uploadsDir, dmpRoot: DMP });

    const wp = fakeExec({ wp: (call: FakeCall) => (writeFileSync(call.args.find((a) => a.includes('.more-')) as string, SQL), { stdout: 'Success: Exported' }) });
    const site = await run(planLocalDump(ctx(wp.exec), { kind: 'site', domain: 'local.shop.com' }, () => undefined));
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

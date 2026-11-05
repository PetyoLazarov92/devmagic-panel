import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jobs, type JobView } from '../src/jobs.js';
import { clearMail, listMail, mailpitArch, mailpitPaths, MAILPIT_RELEASE, type MailpitFetch, planInstallMailpit, readMail, unreadMail } from '../src/mailpit.js';
import { RunStore } from '../src/store.js';
import { fakeExec } from './helpers.js';

const ARCHIVE = Buffer.from('pretend this is mailpit-linux-amd64.tar.gz');
const SHA = createHash('sha256').update(ARCHIVE).digest('hex');

async function run(steps: ReturnType<typeof planInstallMailpit>): Promise<JobView> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const view = jobs.start(steps, { runId: store.start('mailpit.install', {}), title: 'Install Mailpit' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    if (v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-mailpit-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const paths = mailpitPaths(dataDir, home);
  const fake = fakeExec({
    // The fake tar "unpacks" the binary where the real one would.
    'tar -xzf': () => (writeFileSync(paths.bin, '#!/bin/sh\n'), { stdout: '' }),
    'systemctl --user': { stdout: '' },
  });
  const urls: string[] = [];
  const download = async (url: string, file: string, onProgress: (d: number, t: number) => void) => {
    urls.push(url);
    writeFileSync(file, ARCHIVE);
    onProgress(ARCHIVE.length, ARCHIVE.length);
  };
  return { dataDir, home, paths, fake, urls, download };
}

describe('Mailpit install', () => {
  it('pins a release with a checksum for each processor it supports', () => {
    expect(MAILPIT_RELEASE.sha256.amd64).toMatch(/^[0-9a-f]{64}$/);
    expect(MAILPIT_RELEASE.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
    expect(mailpitArch('x64')).toBe('amd64');
    expect(mailpitArch('ia32')).toBeNull();
  });

  it('downloads the pinned release, checks it, unpacks only the binary and starts a user service on 127.0.0.1', async () => {
    const s = setup();
    const view = await run(planInstallMailpit({ exec: s.fake.exec, dataDir: s.dataDir, home: s.home, download: s.download }, 'amd64', { version: '9.9.9', sha256: { amd64: SHA, arm64: SHA } }));
    expect(view.status).toBe('done');
    expect(s.urls).toEqual(['https://github.com/axllent/mailpit/releases/download/v9.9.9/mailpit-linux-amd64.tar.gz']);
    const lines = s.fake.calls.map((c) => [c.file, ...c.args].join(' '));
    expect(lines[0]).toBe(`tar -xzf ${join(s.paths.dir, 'mailpit-linux-amd64.tar.gz')} -C ${s.paths.dir} --no-same-owner mailpit`);
    expect(lines.slice(1)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now devmagic-panel-mailpit.service']);
    const unit = readFileSync(s.paths.unitFile, 'utf8');
    expect(unit).toContain(`ExecStart=${s.paths.bin} --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 --database ${s.paths.database}`);
    expect(existsSync(join(s.paths.dir, 'mailpit-linux-amd64.tar.gz'))).toBe(false);
  });

  it('deletes a download whose checksum does not match and unpacks nothing', async () => {
    const s = setup();
    const view = await run(planInstallMailpit({ exec: s.fake.exec, dataDir: s.dataDir, home: s.home, download: s.download }, 'amd64', { version: '9.9.9', sha256: { amd64: 'a'.repeat(64), arm64: SHA } }));
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.output).toMatch(/checksum mismatch/);
    expect(s.fake.calls).toHaveLength(0);
    expect(existsSync(join(s.paths.dir, 'mailpit-linux-amd64.tar.gz'))).toBe(false);
  });
});

describe('reading mail', () => {
  const api = (answers: Record<string, unknown>, seen: string[] = []): MailpitFetch => async (path, init) => {
    seen.push(`${init?.method ?? 'GET'} ${path}`);
    const key = Object.keys(answers).find((k) => path.startsWith(k));
    return { ok: key !== undefined, status: key ? 200 : 404, json: async () => (key ? answers[key] : {}) };
  };

  it("lists a site's mail through the tag Local mode adds", async () => {
    const seen: string[] = [];
    const page = await listMail(
      api({ '/search': { messages_count: 1, messages: [{ ID: 'a1', From: { Name: 'Shop', Address: 'shop@local.shop.com' }, To: [{ Address: 'me@x.com' }], Subject: 'Order #1', Created: '2026-10-24T10:00:00Z', Snippet: 'Thanks', Tags: ['local.shop.com'], Read: false }] } }, seen),
      'local.shop.com',
    );
    expect(seen).toEqual([`GET /search?query=${encodeURIComponent('tag:"local.shop.com"')}&start=0&limit=50`]);
    expect(page).toEqual({ total: 1, messages: [{ id: 'a1', from: 'Shop <shop@local.shop.com>', to: ['me@x.com'], subject: 'Order #1', date: '2026-10-24T10:00:00Z', snippet: 'Thanks', site: 'local.shop.com', read: false }] });
  });

  it("counts the messages nobody opened, from Mailpit's own count, asking for one message only", async () => {
    const seen: string[] = [];
    expect(await unreadMail(api({ '/messages': { unread: 3, messages_count: 9, messages: [{ ID: 'a1' }] } }, seen))).toBe(3);
    expect(seen).toEqual(['GET /messages?start=0&limit=1']);
    expect(await unreadMail(api({ '/messages': {} }))).toBe(0);
    await expect(unreadMail(api({}))).rejects.toThrow('Mailpit answered 404');
  });

  it('reads one message and clears a site or everything', async () => {
    const seen: string[] = [];
    const get = api({ '/message/a1': { ID: 'a1', Subject: 'Order #1', HTML: '<p>Hi</p>', Text: 'Hi', To: [] }, '/search': {}, '/messages': {} }, seen);
    expect(await readMail(get, 'a1')).toMatchObject({ subject: 'Order #1', html: '<p>Hi</p>', text: 'Hi' });
    expect(await readMail(get, 'nope')).toBeNull();
    expect((await clearMail(get, 'local.shop.com')).code).toBe(0);
    expect((await clearMail(get)).code).toBe(0);
    expect(seen.slice(-2)).toEqual([`DELETE /search?query=${encodeURIComponent('tag:"local.shop.com"')}`, 'DELETE /messages']);
  });
});

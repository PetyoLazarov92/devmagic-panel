import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { withoutPasswords } from '../src/actions.js';
import { driveIdOf, listRemote, planFetch, rcloneRemotes } from '../src/org/dumps.js';
import { repoTrust } from '../src/repo-trust.js';
import { parseZipList, sqlEntry, sqlFileFor } from '../src/sites/dump.js';
import { checkDumpFile, sniffDump } from '../src/sites/dump-type.js';
import { fetchDump, type Getter, isPublicAddress, nameForType, nameFrom, shownUrl, urlProblem } from '../src/sites/fetch-dump.js';
import { saveUpload } from '../src/sites/uploads.js';
import { RunStore } from '../src/store.js';
import { fakeExec, tempTree } from './helpers.js';

const SQL = "-- MySQL dump\nCREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.spellbook.example','yes');\n";

describe('the type of a dump, by its first bytes', () => {
  it('knows SQL, gzip and zip, and nothing else', () => {
    expect(sniffDump(Buffer.from(SQL))).toBe('sql');
    expect(sniffDump(Buffer.from('﻿\n\n/*!40101 SET NAMES utf8 */;'))).toBe('sql');
    expect(sniffDump(gzipSync(SQL))).toBe('gzip');
    expect(sniffDump(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('zip');
    expect(sniffDump(Buffer.from('<!DOCTYPE html><html>Sign in</html>'))).toBeNull();
    expect(sniffDump(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffDump(Buffer.from('SELECT 1\0'))).toBeNull();
    expect(sniffDump(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a page saved as a dump, and a name that says another type', () => {
    const t = tempTree();
    const page = join(t.root, 'dump.sql');
    writeFileSync(page, '<html><body>Please sign in</body></html>');
    expect(() => checkDumpFile(page)).toThrow(/is not a database dump/);
    const zipped = join(t.root, 'dump.sql.gz');
    writeFileSync(zipped, SQL);
    expect(() => checkDumpFile(zipped)).toThrow(/named like \.sql\.gz but holds plain SQL/);
    writeFileSync(page, SQL);
    expect(checkDumpFile(page)).toBe('sql');
  });

  it('refuses an upload that is not a dump and keeps nothing of it', async () => {
    const t = tempTree();
    const dir = join(t.root, 'uploads');
    await expect(saveUpload(fakeExec().exec, dir, 'spellbook.sql', Readable.from(['<html>not a dump</html>']))).rejects.toThrow(/not a database dump/);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe('a zip', () => {
  const LIST = `Archive:  dump.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  2026-11-09 10:00   __MACOSX/
      120  2026-11-09 10:00   __MACOSX/._spellbook.sql
  5242880  2026-11-09 10:00   backup/spellbook.sql
---------                     -------
  5243000                     3 files
`;
  it('lists its entries and takes the first .sql outside __MACOSX, with a name unzip reads as it is', () => {
    const entries = parseZipList(LIST);
    expect(entries).toEqual([{ size: 0, name: '__MACOSX/' }, { size: 120, name: '__MACOSX/._spellbook.sql' }, { size: 5242880, name: 'backup/spellbook.sql' }]);
    expect(sqlEntry(entries)).toEqual({ size: 5242880, name: 'backup/spellbook.sql' });
    expect(sqlEntry([{ size: 1, name: 'dump[1].sql' }, { size: 1, name: '-x.sql' }])).toBeNull();
  });

  it('unpacks only that file, flat, after checking its size against the free space', async () => {
    const t = tempTree();
    const work = join(t.root, 'up');
    mkdirSync(work);
    const fake = fakeExec({
      'unzip -l': { stdout: LIST },
      'unzip -o -q -j': (call) => {
        const dir = call.args.at(-1) as string;
        writeFileSync(join(dir, 'spellbook.sql'), SQL);
        return { stdout: '' };
      },
    });
    expect(await sqlFileFor(fake.exec, join(work, 'dump.zip'), work, () => ({ bytes: 10 * 1024 ** 3 }))).toBe(join(work, 'unzipped', 'spellbook.sql'));
    expect(fake.calls.find((c) => c.args.includes('-j'))?.args).toEqual(['-o', '-q', '-j', join(work, 'dump.zip'), 'backup/spellbook.sql', '-d', join(work, 'unzipped')]);
    const other = join(t.root, 'up2');
    mkdirSync(other);
    await expect(sqlFileFor(fake.exec, join(other, 'dump.zip'), other, () => ({ bytes: 1024 }))).rejects.toThrow(/not enough free disk space/);
  });
});

describe('downloading a dump from a URL', () => {
  it('reaches only public addresses over https, with no password in the address', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPublicAddress(a)).toBe(true);
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', 'not-an-ip']) expect(isPublicAddress(a)).toBe(false);
    expect(urlProblem('https://files.spellbook.example/dump.sql.gz')).toBeNull();
    expect(urlProblem('http://files.spellbook.example/dump.sql')).toMatch(/Only https/);
    expect(urlProblem('https://alex:secret@files.spellbook.example/dump.sql')).toMatch(/No user name/);
    expect(urlProblem('https://127.0.0.1/dump.sql')).toMatch(/private network/);
    expect(urlProblem('https://[::1]/dump.sql')).toMatch(/private network/);
    expect(urlProblem('https://localhost/dump.sql')).toMatch(/this computer/);
    expect(urlProblem('https://local.spellbook.test/dump.sql')).toMatch(/this computer/);
    expect(urlProblem('ftp://files.spellbook.example/dump.sql')).toMatch(/Only https/);
  });

  it('never shows or keeps the query, where signed links carry their token', () => {
    expect(shownUrl('https://files.spellbook.example/b/dump.sql.gz?X-Amz-Signature=abc&token=xyz')).toBe('https://files.spellbook.example/b/dump.sql.gz?(hidden)');
    expect(shownUrl('https://files.spellbook.example/dump.sql')).toBe('https://files.spellbook.example/dump.sql');
    expect(withoutPasswords({ url: 'https://x.spellbook.example/d.sql?sig=1', repos: [{ url: 'git@github.com:wandworks/site.git' }] })).toEqual({ url: 'https://x.spellbook.example/d.sql?(hidden)', repos: [{ url: 'git@github.com:wandworks/site.git' }] });
  });

  it('names the file after the server or the address, with the extension its bytes call for', () => {
    expect(nameFrom(new URL('https://x.example/a/spellbook.sql.gz?dl=1'), undefined)).toBe('spellbook.sql.gz');
    expect(nameFrom(new URL('https://x.example/get'), 'attachment; filename="wandworks.sql"')).toBe('wandworks.sql');
    expect(nameFrom(new URL('https://x.example/get'), "attachment; filename*=UTF-8''..%2F..%2Fevil.sql")).toBe('evil.sql');
    expect(nameForType('get', 'gzip')).toBe('get.sql.gz');
    expect(nameForType('backup.sql', 'zip')).toBe('backup.zip');
    expect(nameForType('backup.sql.gz', 'gzip')).toBe('backup.sql.gz');
  });

  const answer = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => ({ status, headers, body: Readable.from([typeof body === 'string' ? Buffer.from(body) : body]) });

  it('follows redirects, checks each, and writes the dump', async () => {
    const t = tempTree();
    const seen: string[] = [];
    const get: Getter = async (url) => {
      seen.push(url.href);
      if (url.pathname === '/share') return answer(302, '', { location: '/files/spellbook.sql.gz?sig=1' });
      return answer(200, gzipSync(SQL), { 'content-length': String(gzipSync(SQL).length) });
    };
    const file = join(t.root, 'part');
    const got = await fetchDump('https://files.spellbook.example/share', file, { maxBytes: 1024 ** 3, get });
    expect(got).toMatchObject({ name: 'spellbook.sql.gz', type: 'gzip' });
    expect(seen).toEqual(['https://files.spellbook.example/share', 'https://files.spellbook.example/files/spellbook.sql.gz?sig=1']);
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it('refuses a redirect to this computer, too many redirects, a sign-in page and a file over the limit', async () => {
    const t = tempTree();
    const file = join(t.root, 'part');
    const toLocal: Getter = async () => answer(301, '', { location: 'https://127.0.0.1/admin' });
    await expect(fetchDump('https://files.spellbook.example/a', file, { maxBytes: 1024, get: toLocal })).rejects.toThrow(/private network/);
    const loop: Getter = async (url) => answer(302, '', { location: `${url.pathname}x` });
    await expect(fetchDump('https://files.spellbook.example/a', file, { maxBytes: 1024, get: loop })).rejects.toThrow(/more than five redirects/);
    const page: Getter = async () => answer(200, `<!DOCTYPE html>${'x'.repeat(5000)}`);
    await expect(fetchDump('https://files.spellbook.example/a.sql', file, { maxBytes: 1024 ** 2, get: page })).rejects.toThrow(/not a database dump/);
    const big: Getter = async () => answer(200, SQL, { 'content-length': String(50 * 1024 ** 3) });
    await expect(fetchDump('https://files.spellbook.example/a.sql', file, { maxBytes: 1024 ** 3, get: big })).rejects.toThrow(/more than the 1 GB/);
    const lies: Getter = async () => answer(200, `${SQL}${'x'.repeat(4096)}`);
    await expect(fetchDump('https://files.spellbook.example/a.sql', file, { maxBytes: 1000, get: lies })).rejects.toThrow(/larger than/);
    const denied: Getter = async () => answer(403, 'no');
    await expect(fetchDump('https://files.spellbook.example/a.sql', file, { maxBytes: 1000, get: denied })).rejects.toThrow(/answered 403: it is not public/);
  });

  it('runs as a job that leaves the dump in the uploads and nothing else, saying the address without its query', async () => {
    const t = tempTree();
    const uploadsDir = join(t.root, 'uploads');
    const get: Getter = async () => answer(200, SQL, { 'content-length': String(SQL.length) });
    let id = '';
    const [step] = planFetch({ exec: fakeExec().exec, uploadsDir, home: t.root }, { url: 'https://files.spellbook.example/spellbook.sql?token=secret' }, (u) => (id = u), get);
    const job = { progress: () => undefined, onUndo: () => undefined } as unknown as Parameters<NonNullable<typeof step>['run']>[0];
    const r = (await step?.run(job)) as { code: number; stdout: string };
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('https://files.spellbook.example/spellbook.sql?(hidden)');
    expect(r.stdout).not.toContain('secret');
    expect(readdirSync(uploadsDir)).toEqual([id]);
  });
});

describe('Google Drive and other rclone remotes', () => {
  it('takes the file id from a Drive link', () => {
    expect(driveIdOf('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing')).toBe('1AbCdEfGhIjKlMnOp');
    expect(driveIdOf('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(driveIdOf('https://drive.google.com.example/file/d/1AbCdEfGhIjKlMnOp/view')).toBeNull();
    expect(driveIdOf('http://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')).toBeNull();
  });

  it('lists every remote with its type, and one folder with only its folders and dumps', async () => {
    const fake = fakeExec({
      'rclone listremotes --long': { stdout: 'gdrive:   drive\nbox files: dropbox\nbackups:  s3\n' },
      'rclone lsjson': {
        stdout: JSON.stringify([
          { Name: 'old', IsDir: true, Size: -1, ModTime: '2026-01-01T00:00:00Z' },
          { Name: 'spellbook-2026-11-01.sql.gz', IsDir: false, Size: 4096, ModTime: '2026-11-01T00:00:00Z' },
          { Name: 'notes.txt', IsDir: false, Size: 10, ModTime: '2026-11-02T00:00:00Z' },
          { Name: 'spellbook-2026-11-08.sql.gz', IsDir: false, Size: 8192, ModTime: '2026-11-08T00:00:00Z' },
        ]),
      },
    });
    expect(await rcloneRemotes(fake.exec)).toEqual({ installed: true, remotes: [{ name: 'gdrive', type: 'drive' }, { name: 'box files', type: 'dropbox' }, { name: 'backups', type: 's3' }] });
    const entries = await listRemote(fake.exec, 'backups', 'sites/spellbook');
    expect(entries.map((e) => e.path)).toEqual(['sites/spellbook/old', 'sites/spellbook/spellbook-2026-11-08.sql.gz', 'sites/spellbook/spellbook-2026-11-01.sql.gz']);
    expect(fake.calls.find((c) => c.args[0] === 'lsjson')?.args).toEqual(['lsjson', '--max-depth', '1', '--no-mimetype', '--', 'backups:sites/spellbook']);
    await expect(listRemote(fake.exec, 'nope', '')).rejects.toThrow(/no remote called nope/);
  });
});

describe('whose repos may run here', () => {
  it('your organizations and groups, owners you trusted, and repos your CLI listed', () => {
    const store = new RunStore(':memory:');
    const ns = ['wandworks', 'gitlab.wandworks.test/clients'];
    expect(repoTrust('git@github.com:wandworks/site.git', store, ns)).toMatchObject({ trusted: true, why: 'namespace' });
    expect(repoTrust('git@gitlab.wandworks.test:clients/spellbook/site.git', store, ns)).toMatchObject({ trusted: true, why: 'namespace' });
    expect(repoTrust('git@github.com:someone-else/plugin.git', store, ns)).toEqual({ owner: { host: 'github.com', owner: 'someone-else' }, trusted: false });
    store.trustOwner('github.com', 'someone-else');
    expect(repoTrust('https://github.com/someone-else/plugin.git', store, ns)).toMatchObject({ trusted: true, why: 'trusted' });
    // A trusted owner covers its subgroups, never a look-alike name.
    expect(repoTrust('git@github.com:someone-else-too/plugin.git', store, ns).trusted).toBe(false);
    // Shared with you: listed by your signed-in CLI, so it may run.
    expect(repoTrust('git@github.com:sam-lee/tool.git', store, ns).trusted).toBe(false);
    store.saveOrgScan('~shared', [{ name: 'tool', sshUrl: 'git@github.com:sam-lee/tool.git', url: 'https://github.com/sam-lee/tool' }], true, '2026-11-09T10:00:00.000Z');
    expect(repoTrust('git@github.com:sam-lee/tool.git', store, ns)).toMatchObject({ trusted: true, why: 'listed' });
  });
});

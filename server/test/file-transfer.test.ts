import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/secrets.js';
import { archiveKind, checkTar, checkZip, compressEntries, extractArchive, freeName, placeUploads, pruneStaged, stagedDir, STAGED_KEEP_MS, stageUpload, zipForDownload } from '../src/sites/file-transfer.js';
import { FileRefused, type FilesContext } from '../src/sites/files.js';
import { RunStore } from '../src/store.js';
import { DMP, type FakeCall, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';
const SITE = 'local.shop.com';
const THEMES = 'wp-content/themes';

function siteTree() {
  const tree = tempTree();
  const root = join(tree.config.WEB_DIR, SITE);
  mkdirSync(join(root, THEMES, 'wandworks/inc'), { recursive: true });
  writeFileSync(join(root, THEMES, 'wandworks/style.css'), '/* Theme Name: Wandworks */\n');
  writeFileSync(join(root, THEMES, 'wandworks/inc/setup.php'), '<?php // setup\n');
  writeFileSync(join(root, THEMES, 'wandworks-child.zip'), 'PK');
  writeFileSync(join(root, THEMES, 'export.tar.gz'), 'gz');
  writeFileSync(join(tree.root, 'secret.txt'), 'not the site');
  symlinkSync(tree.root, join(root, 'out'));
  const ctx: FilesContext = { root, readRoots: [] };
  return { ...tree, siteRoot: root, ctx, staged: stagedDir(join(tree.root, 'data')) };
}

/** zip that writes its target, and unzip and tar that list what they are told and unpack a file and a link. */
const tools = (listing: { names?: string; totals?: string; tar?: string } = {}) =>
  fakeExec({
    'zip -r -q -y': (call: FakeCall) => {
      writeFileSync(call.args[3] as string, `zip of ${call.args.slice(5).join(',')}`);
      return {};
    },
    'unzip -Z1': { stdout: listing.names ?? 'wandworks-child/\nwandworks-child/style.css\n' },
    'unzip -Zs': { stdout: listing.totals ?? '2 files, 1200 bytes uncompressed, 600 bytes compressed:  50.0%\n' },
    'unzip -q -o': (call: FakeCall) => {
      const into = call.args[4] as string;
      mkdirSync(join(into, 'wandworks-child'));
      writeFileSync(join(into, 'wandworks-child/style.css'), '/* child */');
      symlinkSync('/etc/passwd', join(into, 'wandworks-child/passwd'));
      return {};
    },
    'tar --numeric-owner -tvf': { stdout: listing.tar ?? 'drwxr-xr-x 1000/1000 0 2026-11-01 10:00 export/\n-rw-r--r-- 1000/1000 12 2026-11-01 10:00 export/a.txt\n' },
    'tar -xf': (call: FakeCall) => {
      writeFileSync(join(call.args[3] as string, 'a.txt'), 'a');
      return {};
    },
  });

describe('an upload of the Files tab', () => {
  it('waits in the panel folder and lands in the folder under its name, readable by the web server', async () => {
    const { ctx, siteRoot, staged } = siteTree();
    const { id, sizeBytes } = await stageUpload(staged, Readable.from([Buffer.from('<?php // '), Buffer.from('new')]));
    expect(sizeBytes).toBe(12);
    expect(statSync(join(staged, id)).mode & 0o777).toBe(0o600);
    const out = await placeUploads(ctx, staged, `${THEMES}/wandworks`, [{ id, name: 'functions.php' }]);
    expect(out).toEqual({ placed: [`${THEMES}/wandworks/functions.php`], taken: [] });
    expect(readFileSync(join(siteRoot, THEMES, 'wandworks/functions.php'), 'utf8')).toBe('<?php // new');
    expect(statSync(join(siteRoot, THEMES, 'wandworks/functions.php')).mode & 0o777).toBe(0o644);
    expect(readdirSync(staged)).toEqual([]);
  });

  it('never writes over a name that is there: the file stays and the upload is dropped', async () => {
    const { ctx, siteRoot, staged } = siteTree();
    const a = await stageUpload(staged, Readable.from([Buffer.from('other')]));
    const b = await stageUpload(staged, Readable.from([Buffer.from('fresh')]));
    const out = await placeUploads(ctx, staged, `${THEMES}/wandworks`, [{ id: a.id, name: 'style.css' }, { id: b.id, name: 'new.css' }]);
    expect(out).toEqual({ placed: [`${THEMES}/wandworks/new.css`], taken: ['style.css'] });
    expect(readFileSync(join(siteRoot, THEMES, 'wandworks/style.css'), 'utf8')).toContain('Wandworks');
    expect(readdirSync(staged)).toEqual([]);
  });

  it('refuses a file over the limit and leaves nothing behind', async () => {
    const { staged } = siteTree();
    await expect(stageUpload(staged, Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10)).rejects.toThrow(FileRefused);
    expect(readdirSync(staged)).toEqual([]);
  });

  it('refuses an id or a name that is not one, a folder out of the site, and an upload that is gone', async () => {
    const { ctx, staged } = siteTree();
    const { id } = await stageUpload(staged, Readable.from([Buffer.from('x')]));
    await expect(placeUploads(ctx, staged, '', [{ id: '../secret.txt', name: 'a.txt' }])).rejects.toThrow(FileRefused);
    await expect(placeUploads(ctx, staged, '', [{ id, name: '../a.txt' }])).rejects.toThrow(FileRefused);
    await expect(placeUploads(ctx, staged, 'out', [{ id, name: 'a.txt' }])).rejects.toThrow(FileRefused);
    await expect(placeUploads(ctx, staged, '', [{ id: '00000000-0000-4000-8000-000000000000', name: 'a.txt' }])).rejects.toThrow(/gone/);
  });

  it('is removed after a day when it never reached a folder', async () => {
    const { staged } = siteTree();
    const old = await stageUpload(staged, Readable.from([Buffer.from('x')]));
    const fresh = await stageUpload(staged, Readable.from([Buffer.from('y')]));
    const then = new Date(Date.now() - STAGED_KEEP_MS - 1000);
    utimesSync(join(staged, old.id), then, then);
    expect(pruneStaged(staged)).toBe(1);
    expect(readdirSync(staged)).toEqual([fresh.id]);
    expect(pruneStaged(join(staged, 'nope'))).toBe(0);
  });
});

describe('a zip of the Files tab', () => {
  it('packs names of one folder, from that folder, with links kept as links', async () => {
    const { ctx, siteRoot } = siteTree();
    const fake = tools();
    const made = await compressEntries(fake.exec, ctx, [`${THEMES}/wandworks`]);
    expect(made).toBe(`${THEMES}/wandworks.zip`);
    expect(readFileSync(join(siteRoot, made), 'utf8')).toBe('zip of wandworks');
    const call = fake.calls[0] as FakeCall;
    expect(call.args.slice(0, 3)).toEqual(['-r', '-q', '-y']);
    expect(call.args.slice(4)).toEqual(['--', 'wandworks']);
    expect(readdirSync(join(siteRoot, THEMES)).filter((n) => n.includes('dmp-tmp'))).toEqual([]);
  });

  it('takes a free name and the folder name for several', async () => {
    const { ctx, siteRoot } = siteTree();
    const fake = tools();
    expect(await compressEntries(fake.exec, ctx, [`${THEMES}/wandworks-child.zip`, `${THEMES}/export.tar.gz`])).toBe(`${THEMES}/themes.zip`);
    expect(await compressEntries(fake.exec, ctx, [`${THEMES}/wandworks-child.zip`, `${THEMES}/export.tar.gz`])).toBe(`${THEMES}/themes 2.zip`);
    expect(existsSync(join(siteRoot, THEMES, 'themes 2.zip'))).toBe(true);
  });

  it('refuses files of two folders, one that is not there, and says when zip is missing', async () => {
    const { ctx } = siteTree();
    const fake = tools();
    await expect(compressEntries(fake.exec, ctx, [`${THEMES}/wandworks`, 'wp-content/themes'])).rejects.toThrow(/one folder/);
    await expect(compressEntries(fake.exec, ctx, [`${THEMES}/nope`])).rejects.toThrow(FileRefused);
    await expect(compressEntries(fake.exec, ctx, ['out/secret.txt'])).rejects.toThrow(FileRefused);
    expect(fake.calls).toEqual([]);
    await expect(compressEntries(fakeExec().exec, ctx, [`${THEMES}/wandworks`])).rejects.toThrow(/sudo apt install zip/);
  });

  it('for a download is made in the panel folder, not in the site', async () => {
    const { ctx, root, siteRoot } = siteTree();
    const before = readdirSync(join(siteRoot, THEMES));
    const zip = await zipForDownload(tools().exec, ctx, join(root, 'data', 'file-zips'), [`${THEMES}/wandworks`]);
    expect(zip.name).toBe('wandworks.zip');
    expect(zip.file.startsWith(join(root, 'data', 'file-zips'))).toBe(true);
    expect(readdirSync(join(siteRoot, THEMES))).toEqual(before);
  });
});

describe('an archive listing', () => {
  it('knows the archives by their ending', () => {
    expect(archiveKind('wandworks.zip')).toEqual({ stem: 'wandworks', kind: 'zip' });
    expect(archiveKind('export.tar.gz')).toEqual({ stem: 'export', kind: 'tar' });
    expect(archiveKind('export.TGZ')).toEqual({ stem: 'export', kind: 'tar' });
    expect(archiveKind('style.css')).toBeNull();
    expect(archiveKind('.zip')).toBeNull();
  });

  it('of a zip refuses a name that leaves the folder, an empty one and more than the cap', () => {
    const totals = '2 files, 1200 bytes uncompressed, 600 bytes compressed:  50.0%';
    expect(checkZip('a/\na/b.txt\n', totals)).toBeNull();
    expect(checkZip('a/b.txt\n../../etc/cron.d/x\n', totals)).toMatch(/leaves the folder/);
    expect(checkZip('/etc/passwd\n', totals)).toMatch(/leaves the folder/);
    expect(checkZip('', totals)).toMatch(/empty/);
    expect(checkZip('a\n', '1 file, 5000 bytes uncompressed, 10 bytes compressed:  99.8%', 1000)).toMatch(/1 GB/);
    expect(checkZip('a\n', 'garbage')).toMatch(/cannot read/);
    const link = 'lrwxrwxrwx  3.0 unx        4 bx stor 26-Nov-10 10:20 a/lnk';
    expect(checkZip('a/lnk\na/b.txt\n', `${link}\n${totals}`)).toBeNull();
    expect(checkZip('a/lnk\na/lnk/cron.d/job\n', `${link}\n${totals}`)).toMatch(/under a link/);
  });

  it('of a tar refuses a hard link, a name that leaves, an entry under a link and more than the cap', () => {
    const line = (type: string, size: number, name: string) => `${type}rw-r--r-- 1000/1000 ${size} 2026-11-01 10:00 ${name}`;
    expect(checkTar([line('d', 0, 'a/'), line('-', 12, 'a/b.txt'), line('l', 0, 'a/link -> ../b')].join('\n'))).toBeNull();
    expect(checkTar(line('h', 0, 'a/b link to a/c'))).toMatch(/hard link/);
    expect(checkTar(line('-', 1, '../x'))).toMatch(/leaves the folder/);
    expect(checkTar(line('-', 1, '/etc/x'))).toMatch(/leaves the folder/);
    expect(checkTar([line('l', 0, 'a -> /etc'), line('-', 1, 'a/cron.d/x')].join('\n'))).toMatch(/under a link/);
    expect(checkTar(line('-', 5000, 'big'), 1000)).toMatch(/1 GB/);
    expect(checkTar('what is this')).toMatch(/cannot read/);
    expect(checkTar('')).toMatch(/empty/);
  });
});

describe('extractArchive', () => {
  it('unpacks a zip into a new folder named after it and drops the links in it', async () => {
    const { ctx, siteRoot } = siteTree();
    const fake = tools();
    const out = await extractArchive(fake.exec, ctx, `${THEMES}/wandworks-child.zip`);
    expect(out).toEqual({ folder: `${THEMES}/wandworks-child`, dropped: 1 });
    expect(readFileSync(join(siteRoot, THEMES, 'wandworks-child/wandworks-child/style.css'), 'utf8')).toBe('/* child */');
    expect(existsSync(join(siteRoot, THEMES, 'wandworks-child/wandworks-child/passwd'))).toBe(false);
    expect(readdirSync(join(siteRoot, THEMES)).filter((n) => n.includes('dmp-tmp'))).toEqual([]);
    expect(existsSync(join(siteRoot, THEMES, 'wandworks-child.zip'))).toBe(true);
  });

  it('never unpacks over a folder: the next free name', async () => {
    const { ctx, siteRoot } = siteTree();
    mkdirSync(join(siteRoot, THEMES, 'export'));
    const out = await extractArchive(tools().exec, ctx, `${THEMES}/export.tar.gz`);
    expect(out.folder).toBe(`${THEMES}/export 2`);
    expect(readdirSync(join(siteRoot, THEMES, 'export'))).toEqual([]);
    expect(readFileSync(join(siteRoot, THEMES, 'export 2/a.txt'), 'utf8')).toBe('a');
  });

  it('unpacks nothing when the listing leaves the folder', async () => {
    const { ctx, siteRoot } = siteTree();
    const fake = tools({ names: 'ok.txt\n../../../etc/cron.d/job\n' });
    await expect(extractArchive(fake.exec, ctx, `${THEMES}/wandworks-child.zip`)).rejects.toThrow(/leaves the folder/);
    expect(fake.calls.some((c) => c.args[0] === '-q')).toBe(false);
    expect(existsSync(join(siteRoot, THEMES, 'wandworks-child'))).toBe(false);
    const tar = tools({ tar: 'hrw-r--r-- 0/0 0 2026-11-01 10:00 a link to /etc/shadow\n' });
    await expect(extractArchive(tar.exec, ctx, `${THEMES}/export.tar.gz`)).rejects.toThrow(/hard link/);
    expect(tar.calls.some((c) => c.args[0] === '-xf')).toBe(false);
  });

  it('refuses a file that is no archive and says when the program is missing', async () => {
    const { ctx, siteRoot } = siteTree();
    await expect(extractArchive(tools().exec, ctx, `${THEMES}/wandworks/style.css`)).rejects.toThrow(/unpacks zip/);
    await expect(extractArchive(fakeExec().exec, ctx, `${THEMES}/wandworks-child.zip`)).rejects.toThrow(/sudo apt install unzip/);
    expect(readdirSync(join(siteRoot, THEMES)).sort()).toEqual(['export.tar.gz', 'wandworks', 'wandworks-child.zip']);
  });

  it('leaves no half folder when unpacking fails', async () => {
    const { ctx, siteRoot } = siteTree();
    const fake = fakeExec({ 'unzip -Z1': { stdout: 'a.txt\n' }, 'unzip -Zs': { stdout: '1 file, 5 bytes uncompressed, 5 bytes compressed:  0.0%' }, 'unzip -q -o': { code: 3, stderr: 'error: invalid compressed data to inflate' } });
    await expect(extractArchive(fake.exec, ctx, `${THEMES}/wandworks-child.zip`)).rejects.toThrow(/invalid compressed data/);
    expect(readdirSync(join(siteRoot, THEMES)).sort()).toEqual(['export.tar.gz', 'wandworks', 'wandworks-child.zip']);
  });
});

describe('freeName', () => {
  it('counts up from the name', () => {
    const { siteRoot } = siteTree();
    expect(freeName(join(siteRoot, THEMES), 'wandworks')).toBe('wandworks 2');
    expect(freeName(join(siteRoot, THEMES), 'fresh', '.zip')).toBe('fresh.zip');
  });
});

describe('the Files routes for uploads and zips', () => {
  let app: FastifyInstance;
  let cookie: string;
  let tree: ReturnType<typeof siteTree>;
  let fake: ReturnType<typeof fakeExec>;

  beforeEach(async () => {
    tree = siteTree();
    fake = tools();
    const { config } = tree;
    writeFileSync(join(config.APACHE_SITES_AVAILABLE, `${SITE}-ssl.conf`), `<VirtualHost *:443>\n ServerName ${SITE}\n DocumentRoot ${tree.siteRoot}\n</VirtualHost>\n`);
    symlinkSync(join(config.APACHE_SITES_AVAILABLE, `${SITE}-ssl.conf`), join(config.APACHE_SITES_ENABLED, `${SITE}-ssl.conf`));
    const hash = await hashPassword('correct horse');
    const store = new RunStore(':memory:');
    app = await buildApp({ config: tree.config, exec: fake.exec, store, secrets: () => ({ panelPasswordHash: hash }), hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'data', 'uploads'), production: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
  });
  afterEach(async () => {
    await app.close();
  });

  const run = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/actions/${id}`, headers: { host: HOST, origin: ORIGIN, cookie }, payload: { domain: SITE, ...payload } });
  const send = (body: string) => app.inject({ method: 'POST', url: '/api/files/uploads', headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from(body) });

  it('takes a file, then file.upload puts it in the folder and history keeps no content', async () => {
    const staged = await send('body { color: red }');
    expect(staged.statusCode).toBe(200);
    const { id, sizeBytes } = staged.json<{ id: string; sizeBytes: number }>();
    expect(sizeBytes).toBe(19);
    const res = await run('file.upload', { dir: `${THEMES}/wandworks`, uploads: [{ id, name: 'extra.css' }] });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(tree.siteRoot, THEMES, 'wandworks/extra.css'), 'utf8')).toBe('body { color: red }');
  });

  it('answers 400 when every name is taken, and 401 without a session', async () => {
    const { id } = (await send('x')).json<{ id: string }>();
    const res = await run('file.upload', { dir: `${THEMES}/wandworks`, uploads: [{ id, name: 'style.css' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/already in this folder/);
    expect((await app.inject({ method: 'POST', url: '/api/files/uploads', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })).statusCode).toBe(401);
  });

  it('sends a zip as a download and leaves no file behind', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sites/${SITE}/files/zip?file=${encodeURIComponent(`${THEMES}/wandworks`)}&file=${encodeURIComponent(`${THEMES}/export.tar.gz`)}`, headers: { host: HOST, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''themes.zip");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe('zip of wandworks,export.tar.gz');
    expect(readdirSync(join(tree.root, 'data', 'file-zips'))).toEqual([]);
  });

  it('refuses a zip of a path out of the site or of nothing', async () => {
    const get = (query: string) => app.inject({ method: 'GET', url: `/api/sites/${SITE}/files/zip${query}`, headers: { host: HOST, cookie } });
    expect((await get('')).statusCode).toBe(400);
    expect((await get('?file=../x')).statusCode).toBe(400);
    expect((await get('?file=out/secret.txt')).statusCode).toBe(400);
    expect((await get(`?file=${THEMES}/nope`)).statusCode).toBe(400);
  });

  it('packs and unpacks through their actions', async () => {
    const packed = await run('file.compress', { files: [`${THEMES}/wandworks`] });
    expect(packed.statusCode).toBe(200);
    expect(existsSync(join(tree.siteRoot, THEMES, 'wandworks.zip'))).toBe(true);
    const unpacked = await run('file.extract', { file: `${THEMES}/wandworks-child.zip` });
    expect(unpacked.statusCode).toBe(200);
    expect(existsSync(join(tree.siteRoot, THEMES, 'wandworks-child/wandworks-child/style.css'))).toBe(true);
  });

  it('takes a file of the Files tab at its largest through file.write', async () => {
    const content = `<?php\n${'// a line of the theme\n'.repeat(70_000)}`;
    expect(content.length).toBeGreaterThan(1024 * 1024);
    const res = await run('file.create', { dir: `${THEMES}/wandworks`, name: 'big.php', kind: 'file' });
    expect(res.statusCode).toBe(200);
    const saved = await run('file.write', { file: `${THEMES}/wandworks/big.php`, content, force: true });
    expect(saved.statusCode).toBe(200);
    expect(statSync(join(tree.siteRoot, THEMES, 'wandworks/big.php')).size).toBe(content.length);
  });
});

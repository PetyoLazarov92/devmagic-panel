import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_CHANGED, isFileName } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/secrets.js';
import { copyEntries, copyName, createEntry, deleteEntries, fileTrashDir, listFileTrash, moveEntries, pruneFileTrash, renameEntry, restoreEntries, writeFile } from '../src/sites/file-changes.js';
import { FileRefused, type FilesContext, hashOf } from '../src/sites/files.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';
const SITE = 'local.shop.com';

/** A site with a theme, a shared core behind a link, and links that leave the site. */
function siteTree() {
  const tree = tempTree();
  const root = join(tree.config.WEB_DIR, SITE);
  const cores = join(tree.root, 'wp-cores');
  mkdirSync(join(cores, '7.1.4/wp-admin'), { recursive: true });
  writeFileSync(join(cores, '7.1.4/wp-admin/index.php'), '<?php // admin');
  mkdirSync(join(root, 'wp-content/themes/wandworks/inc'), { recursive: true });
  mkdirSync(join(root, 'wp-content/uploads'), { recursive: true });
  writeFileSync(join(root, 'wp-config.php'), "<?php define('DB_NAME', 'shop_com');\n");
  writeFileSync(join(root, 'wp-content/themes/wandworks/style.css'), '/* Theme Name: Wandworks */\r\nbody { margin: 0 }\r\n');
  writeFileSync(join(root, 'wp-content/themes/wandworks/inc/setup.php'), '<?php // setup\n');
  writeFileSync(join(root, 'wp-content/uploads/archive.bin'), Buffer.from([1, 2, 0, 3]));
  symlinkSync(join(cores, '7.1.4/wp-admin'), join(root, 'wp-admin'));
  writeFileSync(join(tree.root, 'secret.txt'), 'not the site');
  symlinkSync(join(tree.root, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(tree.root, join(root, 'out'));
  writeFileSync(join(tree.root, 'wpcore.conf'), `CORES_DIR="${cores}"\n`);
  chmodSync(join(root, 'wp-config.php'), 0o640);
  const ctx: FilesContext = { root, readRoots: [cores] };
  return { ...tree, siteRoot: root, cores, ctx, trash: fileTrashDir(join(tree.root, 'data')) };
}

const STYLE = 'wp-content/themes/wandworks/style.css';

describe('a name of the Files tab', () => {
  it('is one name: no slash, no dot folder that climbs, no spaces around it', () => {
    for (const ok of ['style.css', '.htaccess', 'a b.txt', 'wandworks-child']) expect(isFileName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', ' a', 'a ', 'a\nb', 'x'.repeat(256), 7]) expect(isFileName(bad), String(bad)).toBe(false);
  });
});

describe('writeFile', () => {
  it('saves the text with the mode the file had and answers the new hash', () => {
    const { ctx, siteRoot } = siteTree();
    const before = hashOf(readFileSync(join(siteRoot, 'wp-config.php')));
    const { hash } = writeFile(ctx, { file: 'wp-config.php', content: "<?php define('DB_NAME', 'shop');\n", hash: before });
    expect(readFileSync(join(siteRoot, 'wp-config.php'), 'utf8')).toBe("<?php define('DB_NAME', 'shop');\n");
    expect(hash).toBe(hashOf("<?php define('DB_NAME', 'shop');\n"));
    expect(statSync(join(siteRoot, 'wp-config.php')).mode & 0o777).toBe(0o640);
    expect(readdirSync(siteRoot).filter((n) => n.includes('dmp-tmp'))).toEqual([]);
  });

  it('keeps the line endings the file had', () => {
    const { ctx, siteRoot } = siteTree();
    writeFile(ctx, { file: STYLE, content: 'a {}\nb {}\n', eol: 'crlf' });
    expect(readFileSync(join(siteRoot, STYLE), 'utf8')).toBe('a {}\r\nb {}\r\n');
    writeFile(ctx, { file: STYLE, content: 'a {}\r\nb {}\r\n', eol: 'lf' });
    expect(readFileSync(join(siteRoot, STYLE), 'utf8')).toBe('a {}\nb {}\n');
  });

  it('refuses a file that changed on disk since it was opened, unless told to save anyway', () => {
    const { ctx, siteRoot } = siteTree();
    const opened = hashOf(readFileSync(join(siteRoot, STYLE)));
    writeFileSync(join(siteRoot, STYLE), 'changed by an editor');
    expect(() => writeFile(ctx, { file: STYLE, content: 'mine', hash: opened })).toThrow(FILE_CHANGED);
    expect(readFileSync(join(siteRoot, STYLE), 'utf8')).toBe('changed by an editor');
    writeFile(ctx, { file: STYLE, content: 'mine', hash: opened, force: true });
    expect(readFileSync(join(siteRoot, STYLE), 'utf8')).toBe('mine');
  });

  it('never writes through a link that leaves the site, into a shared core, a folder or a binary file', () => {
    const { ctx, root, cores } = siteTree();
    expect(() => writeFile(ctx, { file: 'leak.txt', content: 'x' })).toThrow(/leaves the site/);
    expect(() => writeFile(ctx, { file: 'out/secret.txt', content: 'x' })).toThrow(/leaves the site/);
    expect(readFileSync(join(root, 'secret.txt'), 'utf8')).toBe('not the site');
    expect(() => writeFile(ctx, { file: 'wp-admin/index.php', content: 'x' })).toThrow(/read only/);
    expect(readFileSync(join(cores, '7.1.4/wp-admin/index.php'), 'utf8')).toBe('<?php // admin');
    expect(() => writeFile(ctx, { file: 'wp-content', content: 'x' })).toThrow(/not a file/);
    expect(() => writeFile(ctx, { file: 'wp-content/uploads/archive.bin', content: 'x' })).toThrow(/not text/);
    expect(() => writeFile(ctx, { file: 'nope.php', content: 'x' })).toThrow(/not there/);
  });
});

describe('createEntry and renameEntry', () => {
  it('make an empty file and a folder, and refuse a name that is there or is not a name', () => {
    const { ctx, siteRoot } = siteTree();
    expect(createEntry(ctx, 'wp-content/themes/wandworks', 'notes.txt', 'file')).toBe('wp-content/themes/wandworks/notes.txt');
    expect(readFileSync(join(siteRoot, 'wp-content/themes/wandworks/notes.txt'), 'utf8')).toBe('');
    expect(createEntry(ctx, '', 'tools', 'dir')).toBe('tools');
    expect(statSync(join(siteRoot, 'tools')).isDirectory()).toBe(true);
    expect(() => createEntry(ctx, '', 'tools', 'file')).toThrow(/already there/);
    expect(() => createEntry(ctx, '', '../up', 'file')).toThrow(/without slashes/);
    expect(() => createEntry(ctx, 'wp-admin', 'x.php', 'file')).toThrow(/read only/);
    expect(() => createEntry(ctx, 'out', 'x.php', 'file')).toThrow(/leaves the site/);
  });

  it('rename in the same folder, a link as the link it is', () => {
    const { ctx, siteRoot, root } = siteTree();
    expect(renameEntry(ctx, STYLE, 'main.css')).toBe('wp-content/themes/wandworks/main.css');
    expect(existsSync(join(siteRoot, STYLE))).toBe(false);
    expect(() => renameEntry(ctx, 'wp-content/themes/wandworks/main.css', 'inc')).toThrow(/already there/);
    expect(renameEntry(ctx, 'leak.txt', 'leak-old.txt')).toBe('leak-old.txt');
    expect(lstatSync(join(siteRoot, 'leak-old.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'secret.txt'), 'utf8')).toBe('not the site');
    expect(() => renameEntry(ctx, 'wp-admin/index.php', 'x.php')).toThrow(/read only/);
    expect(() => renameEntry(ctx, 'nope', 'x')).toThrow(/not there/);
  });
});

describe('moveEntries and copyEntries', () => {
  it('move into another folder, checked before anything moves', () => {
    const { ctx, siteRoot } = siteTree();
    expect(moveEntries(ctx, [STYLE], 'wp-content/uploads')).toEqual(['wp-content/uploads/style.css']);
    expect(existsSync(join(siteRoot, 'wp-content/uploads/style.css'))).toBe(true);
    writeFileSync(join(siteRoot, 'style.css'), 'top');
    expect(() => moveEntries(ctx, ['wp-config.php', 'style.css'], 'wp-content/uploads')).toThrow(/already there/);
    expect(existsSync(join(siteRoot, 'wp-config.php'))).toBe(true);
    expect(() => moveEntries(ctx, ['wp-content'], 'wp-content/themes')).toThrow(/into itself/);
    expect(() => moveEntries(ctx, ['wp-config.php'], 'wp-admin')).toThrow(/read only/);
    expect(() => moveEntries(ctx, ['wp-config.php'], 'out')).toThrow(/leaves the site/);
  });

  it('copy a folder, and name a copy next to its original', async () => {
    const { ctx, siteRoot } = siteTree();
    expect(await copyEntries(ctx, ['wp-content/themes/wandworks'], 'wp-content/themes')).toEqual(['wp-content/themes/wandworks copy']);
    expect(readFileSync(join(siteRoot, 'wp-content/themes/wandworks copy/inc/setup.php'), 'utf8')).toBe('<?php // setup\n');
    expect(await copyEntries(ctx, [STYLE], 'wp-content/themes/wandworks')).toEqual(['wp-content/themes/wandworks/style copy.css']);
    expect(copyName(join(siteRoot, 'wp-content/themes/wandworks'), 'style.css')).toBe('style copy 2.css');
    expect(copyName(siteRoot, '.htaccess')).toBe('.htaccess copy');
  });

  it('copy a link as a link, never what it points at', async () => {
    const { ctx, siteRoot } = siteTree();
    await copyEntries(ctx, ['leak.txt'], 'wp-content');
    expect(lstatSync(join(siteRoot, 'wp-content/leak.txt')).isSymbolicLink()).toBe(true);
  });
});

describe('the file trash', () => {
  it('keeps what a delete removed and puts it back', async () => {
    const { ctx, siteRoot, trash } = siteTree();
    const entry = await deleteEntries(ctx, trash, SITE, ['wp-content/themes/wandworks', STYLE, 'wp-config.php'], undefined, new Date('2026-11-10T09:15:00Z'));
    expect(entry.id).toMatch(/^20261110-091500-[a-f0-9]{6}$/);
    // The folder took its file along.
    expect(entry.items).toEqual(['wp-content/themes/wandworks', 'wp-config.php']);
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(siteRoot, 'wp-content/themes/wandworks'))).toBe(false);
    expect(listFileTrash(trash, SITE)).toEqual([entry]);
    expect(listFileTrash(trash, 'local.other.com')).toEqual([]);
    await expect(restoreEntries(ctx, trash, 'local.other.com', entry.id)).rejects.toThrow(/not kept/);
    expect(await restoreEntries(ctx, trash, SITE, entry.id)).toEqual(['wp-content/themes/wandworks', 'wp-config.php']);
    expect(readFileSync(join(siteRoot, STYLE), 'utf8')).toContain('Wandworks');
    expect(statSync(join(siteRoot, 'wp-config.php')).mode & 0o777).toBe(0o640);
    expect(listFileTrash(trash, SITE)).toEqual([]);
  });

  it('deletes a link as the link, and nothing of a shared core', async () => {
    const { ctx, siteRoot, root, cores, trash } = siteTree();
    await deleteEntries(ctx, trash, SITE, ['leak.txt', 'wp-admin']);
    expect(existsSync(join(siteRoot, 'leak.txt'))).toBe(false);
    expect(readFileSync(join(root, 'secret.txt'), 'utf8')).toBe('not the site');
    expect(existsSync(join(cores, '7.1.4/wp-admin/index.php'))).toBe(true);
    await expect(deleteEntries(ctx, trash, SITE, ['wp-admin/index.php'])).rejects.toThrow(/not there|read only/);
    await expect(deleteEntries(ctx, trash, SITE, ['out/secret.txt'])).rejects.toThrow(/leaves the site/);
    await expect(deleteEntries(ctx, trash, SITE, ['nope.php'])).rejects.toThrow(/not there/);
  });

  it('leaves a file that is there again alone and keeps the deleted one', async () => {
    const { ctx, siteRoot, trash } = siteTree();
    const entry = await deleteEntries(ctx, trash, SITE, [STYLE, 'wp-config.php']);
    writeFileSync(join(siteRoot, 'wp-config.php'), 'a new one');
    await expect(restoreEntries(ctx, trash, SITE, entry.id)).rejects.toThrow(/wp-config.php is there again.*Put back: wp-content\/themes\/wandworks\/style.css/);
    expect(readFileSync(join(siteRoot, 'wp-config.php'), 'utf8')).toBe('a new one');
    expect(existsSync(join(siteRoot, STYLE))).toBe(true);
    expect(listFileTrash(trash, SITE)).toHaveLength(1);
  });

  it('makes the folder again when it is gone, and never restores through a link that leaves the site', async () => {
    const { ctx, siteRoot, root, trash } = siteTree();
    const first = await deleteEntries(ctx, trash, SITE, ['wp-content/themes/wandworks/inc/setup.php']);
    const second = await deleteEntries(ctx, trash, SITE, ['wp-content/themes/wandworks']);
    expect(await restoreEntries(ctx, trash, SITE, first.id)).toEqual(['wp-content/themes/wandworks/inc/setup.php']);
    expect(existsSync(join(siteRoot, 'wp-content/themes/wandworks/inc/setup.php'))).toBe(true);
    const third = await deleteEntries(ctx, trash, SITE, ['wp-content/uploads/archive.bin']);
    // The folder it was in became a link out of the site in the meantime.
    await deleteEntries(ctx, trash, SITE, ['wp-content/uploads']);
    symlinkSync(root, join(siteRoot, 'wp-content/uploads'));
    await expect(restoreEntries(ctx, trash, SITE, third.id)).rejects.toThrow(/outside the site/);
    expect(existsSync(join(root, 'archive.bin'))).toBe(false);
    expect(second.items).toEqual(['wp-content/themes/wandworks']);
  });

  it('is emptied of deletes older than 14 days', async () => {
    const { ctx, trash } = siteTree();
    const old = await deleteEntries(ctx, trash, SITE, [STYLE], undefined, new Date('2026-10-20T09:00:00Z'));
    const recent = await deleteEntries(ctx, trash, SITE, ['wp-config.php'], undefined, new Date('2026-11-05T09:00:00Z'));
    utimesSync(join(trash, old.id), new Date('2026-10-20T09:00:00Z'), new Date('2026-10-20T09:00:00Z'));
    expect(pruneFileTrash(trash, Date.parse('2026-11-10T09:00:00Z'))).toEqual([old.id]);
    expect(listFileTrash(trash, SITE).map((e) => e.id)).toEqual([recent.id]);
    expect(pruneFileTrash(join(trash, 'nowhere'))).toEqual([]);
  });
});

describe('the Files actions', () => {
  let app: FastifyInstance;
  let store: RunStore;
  let cookie: string;
  let siteRoot: string;
  let calls: ReturnType<typeof fakeExec>['calls'];

  beforeEach(async () => {
    const tree = siteTree();
    const { config } = tree;
    siteRoot = tree.siteRoot;
    writeFileSync(join(config.APACHE_SITES_AVAILABLE, `${SITE}-ssl.conf`), `<VirtualHost *:443>\n ServerName ${SITE}\n DocumentRoot ${tree.siteRoot}\n</VirtualHost>\n`);
    symlinkSync(join(config.APACHE_SITES_AVAILABLE, `${SITE}-ssl.conf`), join(config.APACHE_SITES_ENABLED, `${SITE}-ssl.conf`));
    store = new RunStore(':memory:');
    const fake = fakeExec();
    calls = fake.calls;
    const hash = await hashPassword('correct horse');
    app = await buildApp({ config, exec: fake.exec, store, secrets: () => ({ panelPasswordHash: hash }), hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'data', 'uploads'), production: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const run = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/actions/${id}`, headers: { host: HOST, origin: ORIGIN, cookie }, payload: { domain: SITE, ...payload } });

  it('save a file without a command, and run history never keeps its text', async () => {
    const before = calls.length;
    const res = await run('file.write', { file: 'wp-config.php', content: "<?php // a secret salt\n" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { hash: hashOf("<?php // a secret salt\n") } });
    expect(readFileSync(join(siteRoot, 'wp-config.php'), 'utf8')).toBe("<?php // a secret salt\n");
    expect(calls.length).toBe(before);
    const kept = store.recent()[0];
    expect(kept).toMatchObject({ action: 'file.write', exitCode: 0 });
    expect(JSON.stringify(kept)).not.toContain('secret salt');
    expect(JSON.stringify(kept)).toContain('(hidden)');
  });

  it('answer 400 for a file that changed on disk, a path that climbs and a site that is not there', async () => {
    const stale = await run('file.write', { file: 'wp-config.php', content: 'x', hash: 'a'.repeat(64) });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toContain(FILE_CHANGED);
    expect((await run('file.write', { file: '../secret.txt', content: 'x' })).statusCode).toBe(400);
    expect((await run('file.delete', { files: ['/etc/passwd'] })).statusCode).toBe(400);
    expect((await run('file.rename', { file: 'wp-config.php', name: 'a/b' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/actions/file.delete', headers: { host: HOST, origin: ORIGIN, cookie }, payload: { domain: 'local.nope.com', files: ['a'] } })).statusCode).toBe(400);
    expect(readFileSync(join(siteRoot, 'wp-config.php'), 'utf8')).toContain('shop_com');
  });

  it('make, rename, copy, move, delete and put back, listing what can be put back', async () => {
    expect((await run('file.create', { dir: '', name: 'tools', kind: 'dir' })).json()).toMatchObject({ ok: true });
    expect((await run('file.create', { dir: 'tools', name: 'notes.txt', kind: 'file' })).json()).toMatchObject({ ok: true });
    expect((await run('file.rename', { file: 'tools/notes.txt', name: 'readme.txt' })).json()).toMatchObject({ ok: true });
    expect((await run('file.copy', { files: ['tools/readme.txt'], to: 'tools' })).json()).toMatchObject({ ok: true });
    expect((await run('file.move', { files: ['tools/readme copy.txt'], to: '' })).json()).toMatchObject({ ok: true });
    expect(existsSync(join(siteRoot, 'readme copy.txt'))).toBe(true);
    const gone = await run('file.delete', { files: ['tools'] });
    expect(gone.json()).toMatchObject({ ok: true });
    const id = gone.json().data.trashId as string;
    expect(existsSync(join(siteRoot, 'tools'))).toBe(false);
    const listed = await app.inject({ method: 'GET', url: `/api/sites/${SITE}/files/trash`, headers: { host: HOST, cookie } });
    expect(listed.json()).toMatchObject([{ id, items: ['tools'] }]);
    expect((await run('file.restore', { id })).json()).toMatchObject({ ok: true });
    expect(existsSync(join(siteRoot, 'tools/readme.txt'))).toBe(true);
    expect((await run('file.restore', { id })).statusCode).toBe(400);
    expect((await run('file.restore', { id: '../x' })).statusCode).toBe(400);
  });
});

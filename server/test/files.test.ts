import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_TEXT_MAX, isSitePath } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/secrets.js';
import { FileRefused, type FilesContext, listFolder, locate, rawFile, readFile, repoFolders, shortcuts } from '../src/sites/files.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A site with a theme repo, the panel's mu-plugin, a shared core behind links, and a link that leaves the site. */
function siteTree() {
  const tree = tempTree();
  const root = join(tree.config.WEB_DIR, 'local.shop.com');
  const cores = join(tree.root, 'wp-cores');
  mkdirSync(join(cores, '7.1.4/wp-admin'), { recursive: true });
  writeFileSync(join(cores, '7.1.4/wp-admin/index.php'), '<?php // admin');
  mkdirSync(join(root, 'wp-content/themes/wandworks/.git'), { recursive: true });
  mkdirSync(join(root, 'wp-content/mu-plugins'), { recursive: true });
  mkdirSync(join(root, 'wp-content/uploads'), { recursive: true });
  writeFileSync(join(root, 'wp-config.php'), "<?php define('DB_NAME', 'shop_com');\n");
  writeFileSync(join(root, 'wp-content/themes/wandworks/style.css'), '/* Theme Name: Wandworks */\r\nbody { margin: 0 }\r\n');
  writeFileSync(join(root, 'wp-content/mu-plugins/devmagic-panel-login.php'), '<?php // the login helper');
  writeFileSync(join(root, 'wp-content/uploads/logo.png'), PNG);
  writeFileSync(join(root, 'wp-content/uploads/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(root, 'wp-content/uploads/archive.bin'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, 'wp-content/debug.log'), 'a line\n');
  symlinkSync(join(cores, '7.1.4/wp-admin'), join(root, 'wp-admin'));
  // Something of the machine's, outside the site and outside the cores.
  writeFileSync(join(tree.root, 'secret.txt'), 'not the site');
  symlinkSync(join(tree.root, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(tree.root, join(root, 'out'));
  symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
  writeFileSync(join(tree.root, 'wpcore.conf'), `CORES_DIR="${cores}"\n`);
  // The same modes whatever the umask of the machine the tests run on.
  for (const file of ['wp-config.php', 'wp-content/themes/wandworks/style.css']) chmodSync(join(root, file), 0o644);
  const ctx: FilesContext = { root, readRoots: [cores] };
  return { ...tree, siteRoot: root, cores, ctx };
}

describe('a path of the Files tab', () => {
  it('is relative, without dot folders, backslashes or control characters', () => {
    for (const ok of ['', 'wp-content', 'wp-content/themes/wandworks/style.css', '.htaccess', 'a b/c..d']) expect(isSitePath(ok), ok).toBe(true);
    for (const bad of ['/etc/passwd', '..', 'a/../b', 'a/./b', 'a//b', 'a/', 'a\\b', 'a\nb', 'a\u0000b', 7, undefined, 'x'.repeat(5000)]) expect(isSitePath(bad), String(bad)).toBe(false);
  });
});

describe('locate', () => {
  it('finds what is in the site, and reads through a link into the shared cores only', () => {
    const { ctx } = siteTree();
    expect(locate(ctx, 'wp-content/themes').inside).toBe(true);
    expect(locate(ctx, 'wp-admin/index.php').inside).toBe(false);
  });

  it('refuses a path that climbs, a link that leaves the site, and what is not there', () => {
    const { ctx } = siteTree();
    expect(() => locate(ctx, '../secret.txt')).toThrow(FileRefused);
    expect(() => locate(ctx, 'leak.txt')).toThrow(/leaves the site/);
    expect(() => locate(ctx, 'out/secret.txt')).toThrow(/leaves the site/);
    expect(() => locate(ctx, 'nope.php')).toThrow(/not there/);
    expect(() => locate(ctx, 'broken')).toThrow(/not there/);
  });
});

describe('listFolder', () => {
  it('lists folders first with size, mode and what each entry is', () => {
    const { ctx, siteRoot } = siteTree();
    const top = listFolder(ctx, '');
    expect(top.root).toBe(siteRoot);
    expect(top.writable).toBe(true);
    expect(top.entries.map((e) => e.name)).toEqual(['wp-content', 'broken', 'leak.txt', 'out', 'wp-admin', 'wp-config.php']);
    expect(top.entries.find((e) => e.name === 'wp-config.php')).toMatchObject({ kind: 'file', sizeBytes: 37, mode: '644', writable: true });
    expect(top.entries.find((e) => e.name === 'wp-admin')).toMatchObject({ kind: 'link', targetKind: 'dir', outside: true, writable: false });
    expect(top.entries.find((e) => e.name === 'broken')).toMatchObject({ kind: 'link', targetKind: 'missing' });
    expect(listFolder(ctx, 'wp-content/themes').entries[0]).toMatchObject({ name: 'wandworks', kind: 'dir', note: 'repo' });
    expect(listFolder(ctx, 'wp-content/mu-plugins').entries[0]).toMatchObject({ name: 'devmagic-panel-login.php', note: 'panel' });
  });

  it('shows a shared core read only, and cuts a very long folder', () => {
    const { ctx } = siteTree();
    const core = listFolder(ctx, 'wp-admin');
    expect(core.readOnly).toMatch(/shared WordPress core/);
    expect(core.writable).toBe(false);
    expect(core.entries[0]).toMatchObject({ name: 'index.php', writable: false });
    const cut = listFolder(ctx, 'wp-content/uploads', 2);
    expect(cut.entries).toHaveLength(2);
    expect(cut.more).toBe(1);
  });

  it('refuses a file, and a folder outside the site', () => {
    const { ctx } = siteTree();
    expect(() => listFolder(ctx, 'wp-config.php')).toThrow(/not a folder/);
    expect(() => listFolder(ctx, 'out')).toThrow(/leaves the site/);
  });

  it('names the places worth one click, the ones that are there', () => {
    const { siteRoot } = siteTree();
    expect(repoFolders(siteRoot)).toEqual(['wp-content/themes/wandworks']);
    expect(shortcuts(siteRoot).map((s) => s.label)).toEqual(['wp-content', 'Themes', 'Uploads', 'Repo: wandworks', 'wp-config.php', 'debug.log']);
  });
});

describe('readFile', () => {
  it('gives text with its hash and line endings', () => {
    const { ctx } = siteTree();
    const css = readFile(ctx, 'wp-content/themes/wandworks/style.css');
    expect(css).toMatchObject({ kind: 'text', eol: 'crlf', writable: true, mode: '644' });
    expect(css.text).toContain('Theme Name: Wandworks');
    expect(css.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFile(ctx, 'wp-config.php').eol).toBe('lf');
  });

  it('tells an image, a binary file and a large one apart without their bytes, and SVG is text', () => {
    const { ctx, siteRoot } = siteTree();
    expect(readFile(ctx, 'wp-content/uploads/logo.png')).toMatchObject({ kind: 'image' });
    expect(readFile(ctx, 'wp-content/uploads/logo.png').text).toBeUndefined();
    expect(readFile(ctx, 'wp-content/uploads/archive.bin').kind).toBe('binary');
    expect(readFile(ctx, 'wp-content/uploads/icon.svg').kind).toBe('text');
    writeFileSync(join(siteRoot, 'big.sql'), Buffer.alloc(FILE_TEXT_MAX + 1, 'a'));
    expect(readFile(ctx, 'big.sql')).toMatchObject({ kind: 'large', sizeBytes: FILE_TEXT_MAX + 1 });
  });

  it("marks the panel's file, a shared core's file and one you may not write", () => {
    const { ctx, siteRoot } = siteTree();
    expect(readFile(ctx, 'wp-content/mu-plugins/devmagic-panel-login.php').note).toBe('panel');
    expect(readFile(ctx, 'wp-admin/index.php')).toMatchObject({ writable: false, readOnly: expect.stringMatching(/shared WordPress core/) });
    chmodSync(join(siteRoot, 'wp-config.php'), 0o444);
    expect(readFile(ctx, 'wp-config.php')).toMatchObject({ writable: false, mode: '444' });
  });

  it('refuses a folder and a link that leaves the site', () => {
    const { ctx } = siteTree();
    expect(() => readFile(ctx, 'wp-content')).toThrow(/not a file/);
    expect(() => readFile(ctx, 'leak.txt')).toThrow(/leaves the site/);
    expect(() => rawFile(ctx, 'leak.txt')).toThrow(/leaves the site/);
  });
});

describe('the Files routes', () => {
  let app: FastifyInstance;
  let store: RunStore;
  let cookie: string;

  beforeEach(async () => {
    const tree = siteTree();
    const { config } = tree;
    const learn = join(config.WEB_DIR, 'local.learn.shop.com');
    mkdirSync(learn, { recursive: true });
    writeFileSync(join(learn, 'index.php'), '<?php // learn');
    writeFileSync(
      join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'),
      `<VirtualHost *:443>\n ServerName local.shop.com\n DocumentRoot ${tree.siteRoot}\n Alias /learn ${learn}\n</VirtualHost>\n`,
    );
    symlinkSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), join(config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
    store = new RunStore(':memory:');
    const hash = await hashPassword('correct horse');
    app = await buildApp({ config, exec: fakeExec().exec, store, secrets: () => ({ panelPasswordHash: hash }), hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const get = (url: string, withCookie = true) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(withCookie ? { cookie } : {}) } });

  it('list a folder of a site and of a site under a path, after a login only', async () => {
    expect((await get('/api/sites/local.shop.com/files', false)).statusCode).toBe(401);
    const top = await get('/api/sites/local.shop.com/files');
    expect(top.json().entries.map((e: { name: string }) => e.name)).toContain('wp-content');
    expect((await get('/api/sites/local.shop.com/files?dir=wp-content/themes')).json().entries[0].name).toBe('wandworks');
    expect((await get('/api/sites/local.shop.com/files?path=/learn')).json().entries.map((e: { name: string }) => e.name)).toEqual(['index.php']);
    expect((await get('/api/sites/local.shop.com/files?dir=wp-admin')).json().readOnly).toMatch(/shared WordPress core/);
  });

  it('answer 404 for a site that is not there and 400 for a path that is not the site', async () => {
    expect((await get('/api/sites/local.other.com/files')).statusCode).toBe(404);
    expect((await get('/api/sites/local.shop.com/files?path=/nope')).statusCode).toBe(404);
    expect((await get('/api/sites/local.shop.com/files?path=learn')).statusCode).toBe(400);
    for (const dir of ['..', '%2Fetc', 'out', 'wp-content/../..']) expect((await get(`/api/sites/local.shop.com/files?dir=${dir}`)).statusCode, dir).toBe(400);
    const leak = await get('/api/sites/local.shop.com/files/view?file=leak.txt');
    expect(leak.statusCode).toBe(400);
    expect(leak.body).not.toContain('not the site');
    expect((await get('/api/sites/local.shop.com/files/raw?file=leak.txt')).statusCode).toBe(400);
  });

  it('open a text file', async () => {
    const view = (await get('/api/sites/local.shop.com/files/view?file=wp-config.php')).json();
    expect(view).toMatchObject({ kind: 'text', path: 'wp-config.php' });
    expect(view.text).toContain('DB_NAME');
  });

  it('send a file as a download, and only an image as it is', async () => {
    const svg = await get('/api/sites/local.shop.com/files/raw?file=wp-content/uploads/icon.svg&show=1');
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toBe('application/octet-stream');
    expect(svg.headers['content-disposition']).toBe("attachment; filename*=UTF-8''icon.svg");
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(svg.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const png = await get('/api/sites/local.shop.com/files/raw?file=wp-content/uploads/logo.png&show=1');
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^inline/);
    expect(png.rawPayload.equals(PNG)).toBe(true);
    expect((await get('/api/sites/local.shop.com/files/raw?file=wp-content/uploads/logo.png')).headers['content-disposition']).toMatch(/^attachment/);
  });
});

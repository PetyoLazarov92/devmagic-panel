import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/secrets.js';
import { diffWithDisk, findByName, findInFiles, findQuery, gitDiff, gitStatus, phpSyntax, repoOf } from '../src/sites/file-find.js';
import { FileRefused, type FilesContext } from '../src/sites/files.js';
import { RunStore } from '../src/store.js';
import { DMP, type FakeResponse, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';

/** A site with a theme repo, a folder a search skips, and a link that leaves the site. */
function siteTree() {
  const tree = tempTree();
  const root = join(tree.config.WEB_DIR, 'local.shop.com');
  const theme = join(root, 'wp-content/themes/wandworks');
  mkdirSync(join(theme, '.git'), { recursive: true });
  mkdirSync(join(theme, 'inc'), { recursive: true });
  mkdirSync(join(theme, 'node_modules/wand'), { recursive: true });
  writeFileSync(join(root, 'wp-config.php'), "<?php define('DB_NAME', 'shop_com');\n");
  writeFileSync(join(theme, 'functions.php'), '<?php // Wand setup\n');
  writeFileSync(join(theme, 'inc/wand-helpers.php'), '<?php\n');
  writeFileSync(join(theme, 'node_modules/wand/wand.js'), '');
  writeFileSync(join(theme, '.git/wand-ref'), '');
  writeFileSync(join(tree.root, 'secret.txt'), 'not the site');
  symlinkSync(join(tree.root, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(tree.root, join(root, 'wand-out'));
  const ctx: FilesContext = { root, readRoots: [] };
  return { ...tree, siteRoot: root, theme, ctx };
}

describe('findQuery', () => {
  it('takes 2 to 200 plain characters', () => {
    expect(findQuery('  wand ')).toBe('wand');
    for (const bad of ['', 'a', ' a ', 'x'.repeat(201), 'a\nb', 'a\u0000b', 7, undefined]) expect(() => findQuery(bad), String(bad)).toThrow(FileRefused);
  });
});

describe('findByName', () => {
  it('finds files and folders under a folder, the nearest first, whatever the case', () => {
    const { ctx } = siteTree();
    expect(findByName(ctx, '', 'WAND')).toEqual({
      more: false,
      matches: [
        // A link is named, never followed.
        { path: 'wand-out', kind: 'file' },
        { path: 'wp-content/themes/wandworks', kind: 'dir' },
        { path: 'wp-content/themes/wandworks/inc/wand-helpers.php', kind: 'file' },
      ],
    });
    expect(findByName(ctx, 'wp-content/themes/wandworks/inc', 'helpers').matches).toEqual([{ path: 'wp-content/themes/wandworks/inc/wand-helpers.php', kind: 'file' }]);
  });

  it('names node_modules and .git and does not go into them', () => {
    const { ctx } = siteTree();
    expect(findByName(ctx, '', 'node_mod').matches).toEqual([{ path: 'wp-content/themes/wandworks/node_modules', kind: 'dir' }]);
    expect(findByName(ctx, '', 'wand.js').matches).toEqual([]);
    expect(findByName(ctx, '', 'wand-ref').matches).toEqual([]);
  });

  it('stops at the most it lists and at the most it visits, and says there is more', () => {
    const { ctx } = siteTree();
    expect(findByName(ctx, '', 'wand', 1)).toMatchObject({ more: true, matches: [{ path: 'wand-out' }] });
    expect(findByName(ctx, '', 'helpers', 200, 3)).toEqual({ matches: [], more: true });
  });

  it('refuses a folder outside the site, a file, and a text too short', () => {
    const { ctx } = siteTree();
    expect(() => findByName(ctx, 'wand-out', 'secret')).toThrow(/leaves the site/);
    expect(() => findByName(ctx, '..', 'secret')).toThrow(FileRefused);
    expect(() => findByName(ctx, 'wp-config.php', 'wp')).toThrow(/not a folder/);
    expect(() => findByName(ctx, '', 'w')).toThrow(/2 to 200/);
  });
});

describe('findInFiles', () => {
  it('asks grep for fixed text in the folder, and reads each line it found', async () => {
    const { ctx, theme } = siteTree();
    const { exec, calls } = fakeExec({ grep: { stdout: `./functions.php\u000012:  add_action( 'init', 'wand_setup' );\n./inc/a:b.php\u00003:${'x'.repeat(300)}\n` } });
    const found = await findInFiles(exec, ctx, 'wp-content/themes/wandworks', "-e 'init'; rm");
    expect(found.more).toBe(false);
    expect(found.matches[0]).toEqual({ path: 'wp-content/themes/wandworks/functions.php', kind: 'file', line: 12, text: "add_action( 'init', 'wand_setup' );" });
    expect(found.matches[1]).toMatchObject({ path: 'wp-content/themes/wandworks/inc/a:b.php', line: 3 });
    expect(found.matches[1]?.text).toHaveLength(243);
    // The text is one argument after -e, as fixed characters: never a pattern or an option.
    const { args } = calls[0] as { args: string[] };
    expect(args).toEqual(['-rInZ', '-F', '-i', '-m', '5', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude=*.min.js', '--exclude=*.min.css', '--exclude=*.map', '-e', "-e 'init'; rm", '--', '.']);
    expect(theme).toContain('wandworks');
  });

  it('answers nothing when grep found nothing, and keeps what it found when a file could not be read', async () => {
    const { ctx } = siteTree();
    expect(await findInFiles(fakeExec({ grep: { code: 1 } }).exec, ctx, '', 'wand')).toEqual({ matches: [], more: false });
    expect(await findInFiles(fakeExec({ grep: { code: 2, stderr: 'grep: x: Permission denied' } }).exec, ctx, '', 'wand')).toEqual({ matches: [], more: false });
    const some = await findInFiles(fakeExec({ grep: { code: 2, stdout: './a.php\u00001:wand\n', stderr: 'grep: x: Permission denied' } }).exec, ctx, '', 'wand');
    expect(some).toEqual({ matches: [{ path: 'a.php', kind: 'file', line: 1, text: 'wand' }], more: false });
  });

  it('stops at the most it lists, drops a line that was cut, and says when grep is not there', async () => {
    const { ctx } = siteTree();
    const lines = `${Array.from({ length: 5 }, (_, i) => `./a.php\u0000${i + 1}:wand`).join('\n')}\n`;
    expect(await findInFiles(fakeExec({ grep: { stdout: lines } }).exec, ctx, '', 'wand', 3)).toMatchObject({ more: true, matches: [{ line: 1 }, { line: 2 }, { line: 3 }] });
    // The output ran over what is kept: the last line may be half of one.
    const cut = await findInFiles(fakeExec({ grep: { code: 127, stdout: './a.php\u00001:wand\n./b.php\u00002:wa' } }).exec, ctx, '', 'wand');
    expect(cut).toEqual({ matches: [{ path: 'a.php', kind: 'file', line: 1, text: 'wand' }], more: true });
    await expect(findInFiles(fakeExec().exec, ctx, '', 'wand')).rejects.toThrow(/did not run/);
  });

  it('refuses a folder outside the site before grep runs', async () => {
    const { ctx } = siteTree();
    const { exec, calls } = fakeExec({ grep: {} });
    await expect(findInFiles(exec, ctx, 'wand-out', 'secret')).rejects.toThrow(/leaves the site/);
    await expect(findInFiles(exec, ctx, '', 'a\nb')).rejects.toThrow(FileRefused);
    expect(calls).toEqual([]);
  });
});

describe('repoOf', () => {
  it('finds the nearest repo of a folder or a file, up to the site folder and no further', () => {
    const { ctx, theme, root } = siteTree();
    // A repo above the site is not the site's.
    mkdirSync(join(root, '.git'));
    expect(repoOf(ctx, 'wp-content/themes/wandworks/inc')).toEqual({ repo: 'wp-content/themes/wandworks', dir: theme, within: 'inc' });
    expect(repoOf(ctx, 'wp-content/themes/wandworks/functions.php')).toMatchObject({ repo: 'wp-content/themes/wandworks', within: 'functions.php' });
    expect(repoOf(ctx, 'wp-content/themes/wandworks')).toMatchObject({ within: '' });
    expect(repoOf(ctx, 'wp-content')).toBeUndefined();
    expect(repoOf(ctx, '')).toBeUndefined();
  });
});

describe('gitStatus', () => {
  const porcelain = (...parts: string[]) => `${parts.join('\0')}\0`;

  it('names each changed entry of the folder, and a folder when something in it changed', async () => {
    const { ctx, theme } = siteTree();
    const { exec, calls } = fakeExec({
      git: { stdout: porcelain('## main...origin/main [ahead 1]', ' M functions.php', '?? notes.txt', '?? drafts/', 'A  added.php', 'R  new-name.php', 'old-name.php', 'UU both.php', ' D gone.php', ' M inc/wand-helpers.php', '?? inc/new.php') },
    });
    expect(await gitStatus(exec, ctx, 'wp-content/themes/wandworks')).toEqual({
      repo: 'wp-content/themes/wandworks',
      branch: 'main',
      entries: { 'functions.php': 'modified', 'notes.txt': 'new', drafts: 'new', 'added.php': 'added', 'new-name.php': 'renamed', 'both.php': 'conflict', 'gone.php': 'deleted', inc: 'modified' },
    });
    const call = calls[0] as { args: string[]; env?: Record<string, string | undefined> };
    expect(call.args).toEqual(['-C', theme, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal', '--', '.']);
    expect(call.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  });

  it('lists a folder inside the repo by the names in that folder', async () => {
    const { ctx } = siteTree();
    const { exec, calls } = fakeExec({ git: { stdout: porcelain('## HEAD (no branch)', ' M inc/wand-helpers.php', '?? inc/parts/') } });
    expect(await gitStatus(exec, ctx, 'wp-content/themes/wandworks/inc')).toEqual({ repo: 'wp-content/themes/wandworks', entries: { 'wand-helpers.php': 'modified', parts: 'new' } });
    expect(calls[0]?.args.at(-1)).toBe('inc');
  });

  it('answers nothing outside a repo, without running git, and when git fails', async () => {
    const { ctx } = siteTree();
    const { exec, calls } = fakeExec({ git: { code: 128, stderr: 'fatal: not a git repository' } });
    expect(await gitStatus(exec, ctx, 'wp-content')).toEqual({ entries: {} });
    expect(calls).toEqual([]);
    expect(await gitStatus(exec, ctx, 'wp-content/themes/wandworks')).toEqual({ entries: {} });
    await expect(gitStatus(exec, ctx, 'wand-out')).rejects.toThrow(/leaves the site/);
  });
});

describe('gitDiff', () => {
  it("gives a file's changes since the last commit, with no program of the repo's config", async () => {
    const { ctx, theme } = siteTree();
    const diff = '--- a/functions.php\n+++ b/functions.php\n@@ -1 +1 @@\n-<?php\n+<?php // Wand setup\n';
    const { exec, calls } = fakeExec({ git: { stdout: diff } });
    expect(await gitDiff(exec, ctx, 'wp-content/themes/wandworks/functions.php')).toEqual({ diff, cut: false });
    expect(calls[0]?.args).toEqual(['-C', theme, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', 'functions.php']);
  });

  it('cuts a long diff at a line', async () => {
    const { ctx } = siteTree();
    const long = `${'+a line of a long change\n'.repeat(20_000)}`;
    const got = await gitDiff(fakeExec({ git: { stdout: long } }).exec, ctx, 'wp-content/themes/wandworks/functions.php');
    expect(got.cut).toBe(true);
    expect(got.diff.length).toBeLessThanOrEqual(400_000);
    expect(got.diff.endsWith('change\n')).toBe(true);
  });

  it('refuses a file outside a repo, a folder, a link out of the site, and a repo with no commit', async () => {
    const { ctx } = siteTree();
    const { exec, calls } = fakeExec({ git: { code: 128, stderr: "fatal: bad revision 'HEAD'" } });
    await expect(gitDiff(exec, ctx, 'wp-config.php')).rejects.toThrow(/not in a git repo/);
    await expect(gitDiff(exec, ctx, 'wp-content/themes/wandworks/inc')).rejects.toThrow(/not a file/);
    await expect(gitDiff(exec, ctx, 'leak.txt')).rejects.toThrow(/leaves the site/);
    expect(calls).toEqual([]);
    await expect(gitDiff(exec, ctx, 'wp-content/themes/wandworks/functions.php')).rejects.toThrow(/no commit yet/);
  });
});

describe('diffWithDisk', () => {
  it('sends what was typed to diff on stdin, with the line endings the file has', async () => {
    const { ctx, siteRoot } = siteTree();
    const diff = '--- on disk\n+++ what you typed\n@@ -1 +1,2 @@\n <?php\n+// typed\n';
    const { exec, calls } = fakeExec({ diff: { code: 1, stdout: diff } });
    expect(await diffWithDisk(exec, ctx, 'wp-config.php', '<?php\n// typed\n', 'crlf')).toEqual({ diff, cut: false });
    expect(calls[0]).toMatchObject({ args: ['-u', '--label', 'on disk', '--label', 'what you typed', '--', join(siteRoot, 'wp-config.php'), '-'], input: '<?php\r\n// typed\r\n' });
    // What was typed is in no argument.
    expect(calls[0]?.args.join(' ')).not.toContain('typed\n');
    expect(await diffWithDisk(fakeExec({ diff: {} }).exec, ctx, 'wp-config.php', 'same')).toEqual({ diff: '', cut: false });
  });

  it('refuses a file outside the site, and says when diff could not compare', async () => {
    const { ctx } = siteTree();
    const { exec, calls } = fakeExec({ diff: { code: 2, stderr: 'diff: x: No such file or directory' } });
    await expect(diffWithDisk(exec, ctx, 'leak.txt', 'x')).rejects.toThrow(/leaves the site/);
    await expect(diffWithDisk(exec, ctx, 'wp-content', 'x')).rejects.toThrow(/not a file/);
    expect(calls).toEqual([]);
    await expect(diffWithDisk(exec, ctx, 'wp-config.php', 'x')).rejects.toThrow(/could not be compared/);
  });
});

describe('phpSyntax', () => {
  it('asks PHP to parse a PHP file only, without php.ini, and says what it said', async () => {
    const { ctx, siteRoot } = siteTree();
    const bad = { code: 255, stdout: `PHP Parse error:  syntax error, unexpected token "}" in ${join(siteRoot, 'wp-config.php')} on line 7\nErrors parsing ${join(siteRoot, 'wp-config.php')}\n` };
    const { exec, calls } = fakeExec({ php: bad });
    expect(await phpSyntax(exec, ctx, 'wp-config.php')).toBe('syntax error, unexpected token "}", on line 7');
    expect(calls[0]).toMatchObject({ file: 'php', args: ['-n', '-l', '--', join(siteRoot, 'wp-config.php')] });
    writeFileSync(join(siteRoot, 'notes.txt'), '<?php if (');
    expect(await phpSyntax(exec, ctx, 'notes.txt')).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('says nothing when the file parses, PHP is not there, or the file is not one of the site', async () => {
    const { ctx } = siteTree();
    expect(await phpSyntax(fakeExec({ php: { stdout: 'No syntax errors detected' } }).exec, ctx, 'wp-config.php')).toBeUndefined();
    expect(await phpSyntax(fakeExec().exec, ctx, 'wp-config.php')).toBeUndefined();
    const { exec, calls } = fakeExec({ php: { code: 255, stdout: 'PHP Parse error:  x in y on line 1' } });
    expect(await phpSyntax(exec, ctx, 'gone.php')).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('the find, git and compare routes', () => {
  let app: FastifyInstance;
  let store: RunStore;
  let cookie: string;
  let calls: ReturnType<typeof fakeExec>['calls'];
  const responses: Record<string, FakeResponse> = {
    grep: { stdout: './wp-config.php\u00001:<?php define(\'DB_NAME\', \'shop_com\');\n' },
    'git -C': (call) => (call.args.includes('status') ? { stdout: '## main\0 M functions.php\0' } : { stdout: '@@ -1 +1 @@\n-<?php\n+<?php // Wand setup\n' }),
    diff: { code: 1, stdout: '--- on disk\n+++ what you typed\n@@ -1 +1 @@\n-old\n+new\n' },
  };

  beforeEach(async () => {
    const tree = siteTree();
    const { config } = tree;
    writeFileSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), `<VirtualHost *:443>\n ServerName local.shop.com\n DocumentRoot ${tree.siteRoot}\n</VirtualHost>\n`);
    symlinkSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), join(config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
    store = new RunStore(':memory:');
    const hash = await hashPassword('correct horse');
    const fake = fakeExec(responses);
    calls = fake.calls;
    app = await buildApp({ config, exec: fake.exec, store, secrets: () => ({ panelPasswordHash: hash }), hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const get = (url: string, withCookie = true) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(withCookie ? { cookie } : {}) } });
  const compare = (payload: unknown, withCookie = true) =>
    app.inject({ method: 'POST', url: '/api/sites/local.shop.com/files/compare', headers: { host: HOST, origin: ORIGIN, ...(withCookie ? { cookie } : {}) }, payload: payload as object });

  it('find by name and by text, after a login only', async () => {
    expect((await get('/api/sites/local.shop.com/files/find?q=wand', false)).statusCode).toBe(401);
    const names = (await get('/api/sites/local.shop.com/files/find?q=helpers')).json();
    expect(names.matches).toEqual([{ path: 'wp-content/themes/wandworks/inc/wand-helpers.php', kind: 'file' }]);
    const text = (await get('/api/sites/local.shop.com/files/find?q=DB_NAME&in=text')).json();
    expect(text.matches[0]).toMatchObject({ path: 'wp-config.php', line: 1 });
  });

  it('answer 400 for a text too short and a folder that is not the site, 404 for a site that is not there', async () => {
    expect((await get('/api/sites/local.shop.com/files/find?q=w')).statusCode).toBe(400);
    expect((await get('/api/sites/local.shop.com/files/find')).statusCode).toBe(400);
    for (const dir of ['..', 'wand-out', '%2Fetc']) {
      expect((await get(`/api/sites/local.shop.com/files/find?q=secret&dir=${dir}`)).statusCode, dir).toBe(400);
      expect((await get(`/api/sites/local.shop.com/files/find?q=secret&in=text&dir=${dir}`)).statusCode, dir).toBe(400);
      expect((await get(`/api/sites/local.shop.com/files/git?dir=${dir}`)).statusCode, dir).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await get('/api/sites/local.other.com/files/find?q=wand')).statusCode).toBe(404);
    expect((await get('/api/sites/local.other.com/files/git')).statusCode).toBe(404);
  });

  it('say what git changed in a folder, and show one file\'s changes', async () => {
    expect((await get('/api/sites/local.shop.com/files/git?dir=wp-content/themes/wandworks', false)).statusCode).toBe(401);
    expect((await get('/api/sites/local.shop.com/files/git?dir=wp-content/themes/wandworks')).json()).toEqual({ repo: 'wp-content/themes/wandworks', branch: 'main', entries: { 'functions.php': 'modified' } });
    expect((await get('/api/sites/local.shop.com/files/git')).json()).toEqual({ entries: {} });
    const diff = await get('/api/sites/local.shop.com/files/diff?file=wp-content/themes/wandworks/functions.php');
    expect(diff.json()).toMatchObject({ cut: false });
    expect(diff.json().diff).toContain('+<?php // Wand setup');
    expect((await get('/api/sites/local.shop.com/files/diff?file=wp-config.php')).statusCode).toBe(400);
    expect((await get('/api/sites/local.shop.com/files/diff?file=leak.txt')).statusCode).toBe(400);
  });

  it('compare a file with what was typed, writing nothing', async () => {
    expect((await compare({ file: 'wp-config.php', content: 'new' }, false)).statusCode).toBe(401);
    const res = await compare({ file: 'wp-config.php', content: 'new\n' });
    expect(res.json().diff).toContain('+new');
    expect(calls.at(-1)).toMatchObject({ file: 'diff', input: 'new\n' });
    for (const bad of [{ file: '../secret.txt', content: 'x' }, { file: 'wp-config.php' }, { file: 'leak.txt', content: 'x' }, { file: 'wp-config.php', content: 'x', eol: 'cr' }, { file: 'wp-config.php', content: 'x', path: 'learn' }]) {
      expect((await compare(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // What was typed is compared and never kept: no run is recorded.
    expect(store.recent()).toEqual([]);
  });
});

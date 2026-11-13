import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { presetFromCreate, repoKey } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { findSiteRepo, inspectRepo, parseDefaultBranch, repoLookup } from '../src/sites/repo.js';
import { RunStore } from '../src/store.js';
import { fakeExec, wpSiteTree } from './helpers.js';

describe('findSiteRepo', () => {
  it('finds the repo in the site root, wp-content, or a theme', () => {
    const s = wpSiteTree();
    expect(findSiteRepo(s.docroot)).toBeNull();
    mkdirSync(join(s.docroot, 'wp-content/themes/shop/.git'), { recursive: true });
    expect(findSiteRepo(s.docroot)).toEqual({ root: join(s.docroot, 'wp-content/themes/shop'), layout: 'theme' });
    mkdirSync(join(s.docroot, 'wp-content/.git'));
    expect(findSiteRepo(s.docroot)?.layout).toBe('wp-content');
    mkdirSync(join(s.docroot, '.git'));
    expect(findSiteRepo(s.docroot)).toEqual({ root: s.docroot, layout: 'site-root' });
  });
});

describe('inspectRepo', () => {
  const URL = 'git@github.com:WandworksCo/shop.git';

  it('reads the default branch and every branch with one ls-remote, and never looks for a file in the repo', async () => {
    const s = wpSiteTree();
    const sha = (n: number) => String(n).repeat(40);
    const out = `ref: refs/heads/develop\tHEAD\n${sha(1)}\tHEAD\n${sha(2)}\trefs/heads/master\n${sha(1)}\trefs/heads/develop\n${sha(3)}\trefs/heads/feature/cart\n`;
    const fake = fakeExec({ [`git ls-remote --symref -- ${URL} HEAD refs/heads/*`]: { stdout: out } });
    expect(await inspectRepo(fake.exec, join(s.root, 'tmp'), URL)).toEqual({ defaultBranch: 'develop', branch: 'develop', branches: ['develop', 'feature/cart', 'master'] });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('reads docs for the assistant from a blob-less clone, then cleans up', async () => {
    const s = wpSiteTree();
    const work = join(s.root, 'tmp');
    const fake = fakeExec({
      'git ls-remote': { stdout: 'ref: refs/heads/master\tHEAD\n' },
      'git clone --depth=1 --filter=blob:none --no-checkout --single-branch --branch feature/cart': { stdout: '' },
      'git -C': (call) => (call.args.at(-1) === 'HEAD:README.md' ? { stdout: '# Shop' } : { code: 128, stderr: 'fatal: path does not exist' }),
    });
    expect(await inspectRepo(fake.exec, work, URL, 'feature/cart', ['README.md', 'CLAUDE.md'])).toEqual({ defaultBranch: 'master', branch: 'feature/cart', branches: [], docs: { 'README.md': '# Shop' } });
    expect(readdirSync(work)).toEqual([]);
  });

  it('finds the local helpers by folder or composer.json, plans the builds, and reads the few files it needs in one fetch', async () => {
    const s = wpSiteTree();
    const work = join(s.root, 'tmp');
    const blob = (n: number) => n.toString(16).padStart(40, '0');
    const tree = [
      ['wp-content/plugins/query-monitor/query-monitor.php', 1],
      ['plugins/user-switching/user-switching.php', 2],
      ['themes/wp-crontrol/style.css', 3],
      ['wp-content/plugins/be-media-from-production/plugin.php', 4],
      ['composer.json', 5],
      ['wp-content/themes/wandworks/package.json', 6],
      ['wp-content/themes/wandworks/package-lock.json', 7],
      ['wp-content/themes/wandworks/.gitignore', 8],
      ['wp-content/plugins/wandworks-blocks/vendor/x/package.json', 9],
      ['.gitignore', 10],
    ] as const;
    const files: Record<string, string> = {
      [blob(5)]: JSON.stringify({ require: { php: '>=8.1' }, 'require-dev': { 'wpackagist-plugin/wp-crontrol': '^1.16' } }),
      [blob(6)]: JSON.stringify({ scripts: { build: 'wp-scripts build', start: 'wp-scripts start', lint: 'eslint .' } }),
      [blob(8)]: 'node_modules/\n/build/\n',
      [blob(10)]: '/vendor/\n',
    };
    const fake = fakeExec({
      'git clone --depth=1 --filter=blob:none --no-checkout --single-branch --branch develop': { stdout: '' },
      'git -C': (call) =>
        call.args.includes('ls-tree')
          ? { stdout: tree.map(([path, n]) => `100644 blob ${blob(n)}\t${path}`).join('\n') }
          : call.args.includes('cat-file')
            ? { stdout: files[call.args.at(-1) as string] ?? '' }
            : { stdout: '' },
      'npm --version': { stdout: '10.9.0' },
      'composer --version': { stdout: 'Composer version 2.8.4' },
    });
    expect(await repoLookup(fake.exec, work, URL, 'develop', work)).toEqual({
      helpers: ['query-monitor', 'wp-crontrol', 'user-switching'],
      mediaPlugin: true,
      builds: [
        // The root composer.json brings WP Crontrol in from WordPress Packagist: it needs composer install.
        { dir: '', tool: 'composer', scripts: [], needed: true, why: 'vendor/ is ignored by git' },
        { dir: 'wp-content/themes/wandworks', tool: 'npm', scripts: ['build'], script: 'build', needed: true, why: 'build/ is ignored by git' },
      ],
      kind: 'site',
      // Each plugin folder the repo holds, wherever its plugins folder is, for the missing plugins.
      plugins: ['wp-content/plugins/query-monitor', 'plugins/user-switching', 'wp-content/plugins/be-media-from-production', 'wp-content/plugins/wandworks-blocks'],
      themes: ['themes/wp-crontrol', 'wp-content/themes/wandworks'],
    });
    // A big repo's file list fits: far more than the usual 8 MB.
    expect(fake.calls.find((c) => c.args.includes('ls-tree'))?.maxBufferBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    // One fetch for the manifests and ignore rules, never for files under vendor/.
    const fetches = fake.calls.filter((c) => c.args.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.input?.trim().split('\n')).toEqual([blob(5), blob(6), blob(8), blob(10)]);
    expect(readdirSync(work)).toEqual([]);
  });

  it('tells a plugin with no readme.txt and a block theme in a folder by the headers WordPress reads', async () => {
    const lookup = async (tree: Array<[string, string]>) => {
      const work = join(wpSiteTree().root, 'tmp');
      const blob = (n: number) => n.toString(16).padStart(40, '0');
      const fake = fakeExec({
        'git clone --depth=1 --filter=blob:none --no-checkout --single-branch --branch develop': { stdout: '' },
        'git -C': (call) =>
          call.args.includes('ls-tree')
            ? { stdout: tree.map(([path], i) => `100644 blob ${blob(i + 1)}\t${path}`).join('\n') }
            : call.args.includes('cat-file')
              ? { stdout: tree[parseInt(call.args.at(-1) as string, 16) - 1]?.[1] ?? '' }
              : { stdout: '' },
        'npm --version': { stdout: '10.9.0' },
        'composer --version': { stdout: 'Composer version 2.8.4' },
      });
      return repoLookup(fake.exec, work, URL, 'develop', work);
    };
    expect(await lookup([['wandworks-blocks.php', '<?php\n/*\n * Plugin Name: Wandworks Blocks\n * Version: 1.4.0\n */'], ['src/index.js', '']])).toMatchObject({ kind: 'plugin', header: { kind: 'plugin', name: 'Wandworks Blocks', version: '1.4.0' } });
    const theme = await lookup([['package.json', '{}'], ['theme/style.css', '/*\nTheme Name: Wandworks\n*/'], ['theme/theme.json', '{}'], ['theme/templates/index.html', '']]);
    expect(theme).toMatchObject({ kind: 'theme', themeIn: 'theme', header: { kind: 'theme', name: 'Wandworks', folder: 'theme' } });
    const plugin = await lookup([['package.json', '{}'], ['plugin/wandworks-forms.php', '<?php /* Plugin Name: Wandworks Forms */']]);
    expect(plugin).toMatchObject({ kind: 'other', pluginIn: 'plugin', header: { name: 'Wandworks Forms' } });
    const none = await lookup([['README.md', '# Tools'], ['src/index.ts', '']]);
    expect(none.kind).toBe('other');
    expect(none.header).toBeUndefined();
  });

  it('says the repo has too many files when even the larger file list overflows', async () => {
    const work = join(wpSiteTree().root, 'tmp');
    const fake = fakeExec({
      'git clone --depth=1 --filter=blob:none --no-checkout --single-branch --branch develop': { stdout: '' },
      'git -C': { code: 127, stderr: 'stdout maxBuffer length exceeded' },
    });
    await expect(repoLookup(fake.exec, work, URL, 'develop', work)).rejects.toThrow('the repo has too many files to list');
    expect(readdirSync(work)).toEqual([]);
  });

  it("passes git's reason on when the repo cannot be read", async () => {
    const s = wpSiteTree();
    const fake = fakeExec({ 'git ls-remote': { code: 128, stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' } });
    await expect(inspectRepo(fake.exec, join(s.root, 'tmp'), URL)).rejects.toThrow('fatal: Could not read from remote repository.');
    expect(existsSync(join(s.root, 'tmp'))).toBe(false);
  });

  it('parses the symref line', () => {
    expect(parseDefaultBranch('ref: refs/heads/main\tHEAD\n1234\tHEAD')).toBe('main');
    expect(parseDefaultBranch('1234\tHEAD')).toBeUndefined();
  });
});

describe('repo presets', () => {
  it('pairs each local name with its production host, keeps where each repo went and leaves the main branch out', () => {
    expect(
      presetFromCreate({
        source: 'repo', domain: 'local.shop.com', aliases: ['local.shop.de'],
        repos: [
          { url: 'git@github.com:x/y.git', branch: 'feature/x', dir: 'wp-content/themes', folder: 'y' },
          { url: 'git@github.com:x/blocks.git', branch: 'main', dir: 'wp-content/plugins', folder: 'blocks' },
        ],
        replace: [{ from: 'www.shop.com', to: 'local.shop.com' }], core: { mode: 'wpcore', version: '7.1.3' }, deactivate: ['wp-rocket'],
        uploadsFrom: 'www.shop.com', uploadsVia: 'plugin', build: { composer: false, npm: true }, activate: ['query-monitor'], installPlugins: [], installThemes: [], replaceExisting: false, remember: true, server: 'apache',
      }),
    ).toEqual({
      domains: [{ production: 'www.shop.com', local: 'local.shop.com' }, { local: 'local.shop.de' }],
      placement: { dir: 'wp-content/themes', folder: 'y' },
      extra: [{ url: 'git@github.com:x/blocks.git', branch: 'main', dir: 'wp-content/plugins', folder: 'blocks' }],
      core: { mode: 'wpcore', version: '7.1.3' },
      deactivate: ['wp-rocket'],
      activate: ['query-monitor'],
      uploadsFrom: 'www.shop.com',
      uploadsVia: 'plugin',
      build: { composer: false, npm: true },
    });
  });

  it('are stored by one key for the SSH and HTTPS forms of a repo', () => {
    const store = new RunStore(':memory:');
    expect(repoKey('git@github.com:WandworksCo/Shop.git')).toBe(repoKey('https://github.com/wandworksco/shop'));
    store.savePreset(repoKey('git@github.com:WandworksCo/Shop.git') as string, { layout: 'theme' });
    store.savePreset(repoKey('https://github.com/WandworksCo/shop.git') as string, { layout: 'site-root' });
    expect(store.preset(repoKey('git@github.com:wandworksco/shop.git') as string)).toEqual({ layout: 'site-root' });
    expect(store.preset('https://github.com/wandworksco/other')).toBeUndefined();
  });
});

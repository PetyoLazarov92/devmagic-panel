import type { DumpPlugin } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { askWporg, defaultPick, missingPlugins, onServer, pluginChoices, pluginItem, pluginSitePath, pluginSlug, repoPluginPaths } from '../src/lib/missing-plugins.js';

const dump: DumpPlugin[] = [
  { file: 'woocommerce/woocommerce.php', active: true, version: '9.4.1', slug: 'woocommerce' },
  { file: 'wandworks-blocks/blocks.php', active: true },
  { file: 'wandworks-pro-forms/loader.php', active: true, version: '3.2.0' },
  { file: 'redirection/redirection.php', active: true, version: '5.5.1' },
  { file: 'duplicate-post/duplicate-post.php', active: false, version: '4.5' },
  { file: 'hello.php', active: false, slug: 'hello-dolly' },
];

describe('missing plugins of an install', () => {
  it('knows what the repos bring, wherever each repo goes', () => {
    const present = repoPluginPaths([
      { placement: { dir: '', folder: 'wp-content' }, plugins: ['plugins/woocommerce', 'plugins/hello.php'] },
      { placement: { dir: 'wp-content/plugins', folder: 'wandworks-blocks' } },
    ]);
    expect([...present].sort()).toEqual(['wp-content/plugins/hello.php', 'wp-content/plugins/wandworks-blocks', 'wp-content/plugins/woocommerce']);
    expect(missingPlugins(dump, present).map((p) => p.file)).toEqual(['wandworks-pro-forms/loader.php', 'redirection/redirection.php', 'duplicate-post/duplicate-post.php']);
    expect(pluginSitePath('hello.php')).toBe('wp-content/plugins/hello.php');
    expect(pluginSlug({ file: 'hello.php', slug: 'hello-dolly' })).toBe('hello-dolly');
  });

  it('installs active ones on WordPress.org at production\'s version, turns off what you said, and skips the rest', () => {
    const missing = dump.slice(2, 5);
    const wporg = { redirection: { name: 'Redirection', version: '5.5.2' }, 'duplicate-post': { name: 'Yoast Duplicate Post', version: '4.5' }, 'wandworks-pro-forms': null };
    expect(defaultPick(missing[0] as DumpPlugin, null)).toBe('leave');
    expect(defaultPick(missing[2] as DumpPlugin, wporg['duplicate-post'])).toBe('leave');
    expect(defaultPick(missing[2] as DumpPlugin, wporg['duplicate-post'], ['duplicate-post'])).toBe('install');
    expect(pluginChoices(missing, {}, wporg)).toEqual({ install: [{ slug: 'redirection', version: '5.5.1' }], off: [], copy: [] });
    expect(pluginChoices(missing, { 'wandworks-pro-forms/loader.php': 'off', 'duplicate-post/duplicate-post.php': 'install', 'redirection/redirection.php': 'leave' }, wporg)).toEqual({
      install: [{ slug: 'duplicate-post', version: '4.5' }],
      off: ['wandworks-pro-forms'],
      copy: [],
    });
  });
});

describe('asking WordPress.org', () => {
  const found = { name: 'Redirection', version: '5.5.2' };

  it('answers a name WordPress.org could not have as not there, so one odd folder never stops the rest', async () => {
    const asked: string[][] = [];
    const out = await askWporg(['redirection', 'Wandworks.Pro', 'wandworks forms', 'redirection'], async (slugs) => {
      asked.push(slugs);
      return { redirection: found };
    });
    expect(asked).toEqual([['redirection']]);
    expect(out).toEqual({ answers: { redirection: found, 'Wandworks.Pro': null, 'wandworks forms': null }, failed: false });
  });

  it('asks about a long list in parts of 100', async () => {
    const sizes: number[] = [];
    const slugs = Array.from({ length: 230 }, (_, i) => `plugin-${i}`);
    const out = await askWporg(slugs, async (part) => {
      sizes.push(part.length);
      return Object.fromEntries(part.map((slug) => [slug, null]));
    });
    expect(sizes).toEqual([100, 100, 30]);
    expect(Object.keys(out.answers)).toHaveLength(230);
    expect(out.failed).toBe(false);
  });

  it('says so when a request fails or leaves a plugin out, and keeps what it got', async () => {
    const down = await askWporg(['redirection'], async () => {
      throw new Error('offline');
    });
    expect(down).toEqual({ answers: {}, failed: true });
    const partly = await askWporg(['redirection', 'akismet'], async () => ({ redirection: found }));
    expect(partly).toEqual({ answers: { redirection: found }, failed: true });
  });
});

describe('plugins WordPress.org does not have', () => {
  const server = { plugins: [{ name: 'wandworks-pro-forms', version: '3.2.0' }, { name: 'hello' }], themes: [] };
  const pro = { file: 'wandworks-pro-forms/loader.php', active: true };
  it('finds a plugin on the server by its folder, or a single file by its name', () => {
    expect(onServer(pro, server)?.version).toBe('3.2.0');
    expect(onServer({ file: 'hello.php' }, server)?.name).toBe('hello');
    expect(pluginItem('hello.php')).toBe('hello.php');
    expect(onServer({ file: 'gone/gone.php' }, server)).toBeUndefined();
    expect(onServer(pro, null)).toBeUndefined();
  });
  it('copies an active one from the server by default, only when the server has it and WordPress.org does not', () => {
    expect(defaultPick(pro, null, [], server)).toBe('server');
    expect(defaultPick(pro, null, [], null)).toBe('leave');
    expect(defaultPick(pro, undefined, [], server)).toBe('leave');
    expect(defaultPick({ ...pro, active: false }, null, [], server)).toBe('leave');
    expect(defaultPick(pro, { name: 'Forms', version: '4.0' }, [], server)).toBe('install');
  });
  it('lists what to copy by folder, once, and never a name that is not plain', () => {
    const missing = [pro, { file: 'wandworks-pro-forms/extra.php', active: true }, { file: 'hello.php', active: false }];
    expect(pluginChoices(missing, { 'hello.php': 'server' }, { 'wandworks-pro-forms': null, hello: null }, [], server).copy).toEqual(['wandworks-pro-forms', 'hello.php']);
    expect(pluginChoices(missing, {}, { 'wandworks-pro-forms': null, hello: null }, [], null).copy).toEqual([]);
    expect(pluginChoices([{ file: 'a b/x.php', active: true }], { 'a b/x.php': 'server' }, {}, [], { plugins: [{ name: 'a b' }], themes: [] }).copy).toEqual([]);
  });
});

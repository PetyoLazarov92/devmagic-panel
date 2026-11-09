import type { DumpPlugin } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { defaultPick, missingPlugins, pluginChoices, pluginSitePath, pluginSlug, repoPluginPaths } from '../src/lib/missing-plugins.js';

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
    expect(pluginChoices(missing, {}, wporg)).toEqual({ install: [{ slug: 'redirection', version: '5.5.1' }], off: [] });
    expect(pluginChoices(missing, { 'wandworks-pro-forms/loader.php': 'off', 'duplicate-post/duplicate-post.php': 'install', 'redirection/redirection.php': 'leave' }, wporg)).toEqual({
      install: [{ slug: 'duplicate-post', version: '4.5' }],
      off: ['wandworks-pro-forms'],
    });
  });
});

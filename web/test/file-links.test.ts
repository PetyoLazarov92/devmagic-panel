import { describe, expect, it } from 'vitest';
import { fileMentions, filesHref, pluginFolderHref, themeFolderHref } from '../src/lib/file-links.js';

const root = '/var/www/local.spellbook.example';

describe('filesHref', () => {
  it('names the folder, or the file and its line', () => {
    expect(filesHref({ domain: 'local.spellbook.example' })).toBe('/sites/local.spellbook.example?tab=files');
    expect(filesHref({ domain: 'local.spellbook.example', path: '/learn' }, { dir: 'wp-content/themes' })).toBe('/sites/local.spellbook.example/learn?tab=files&dir=wp-content%2Fthemes');
    expect(filesHref({ domain: 'local.spellbook.example' }, { file: 'wp-content/a b.php', line: 12 })).toBe('/sites/local.spellbook.example?tab=files&file=wp-content%2Fa%20b.php&line=12');
  });
});

describe('fileMentions', () => {
  it('finds a file and its line the way PHP and stack traces write them', () => {
    const php = `PHP Warning:  Undefined array key "school" in ${root}/wp-content/themes/wandworks/functions.php on line 28`;
    expect(fileMentions(php, root)).toEqual([{ start: php.indexOf('/var'), end: php.length, file: 'wp-content/themes/wandworks/functions.php', line: 28 }]);
    expect(fileMentions(`#0 ${root}/wp-includes/plugin.php(205): do_action()`, root)[0]).toMatchObject({ file: 'wp-includes/plugin.php', line: 205 });
    expect(fileMentions(`thrown in ${root}/index.php:17`, root)[0]).toMatchObject({ file: 'index.php', line: 17 });
    expect(fileMentions(`read ${root}/wp-config.php, then stopped`, root)[0]).toEqual({ start: 5, end: 5 + root.length + 14, file: 'wp-config.php' });
  });

  it('leaves files of other sites, paths that climb and plain text alone', () => {
    expect(fileMentions('in /var/www/local.shop.com/index.php on line 3', root)).toEqual([]);
    expect(fileMentions(`in ${root}.old/index.php on line 3`, root)).toEqual([]);
    expect(fileMentions(`in ${root}/../secret/a.php on line 3`, root)).toEqual([]);
    expect(fileMentions('Nothing to see', root)).toEqual([]);
    expect(fileMentions(`in ${root}/index.php`, '')).toEqual([]);
  });
});

describe('themeFolderHref and pluginFolderHref', () => {
  const site = { domain: 'local.spellbook.example' };
  it('opens a theme at the folder it has, from the site folder, without adding the themes folder again', () => {
    expect(themeFolderHref(site, { folder: 'wp-content/themes/wandworks' })).toBe('/sites/local.spellbook.example?tab=files&dir=wp-content%2Fthemes%2Fwandworks');
    expect(themeFolderHref(site, { folder: 'wp-content/repos/theme-kit/wandworks' })).toBe('/sites/local.spellbook.example?tab=files&dir=wp-content%2Frepos%2Ftheme-kit%2Fwandworks');
  });
  it('opens a plugin at its folder, or at its file when it is one file', () => {
    expect(pluginFolderHref(site, { path: 'wp-content/plugins/wandworks-blocks' })).toBe('/sites/local.spellbook.example?tab=files&dir=wp-content%2Fplugins%2Fwandworks-blocks');
    expect(pluginFolderHref(site, { path: 'wp-content/plugins/hello-wands.php', oneFile: true })).toBe('/sites/local.spellbook.example?tab=files&file=wp-content%2Fplugins%2Fhello-wands.php');
  });
});

describe('takeoverHref', () => {
  it("opens the site's Overview with the takeover dialog, from the site or one under its path", async () => {
    const { takeoverHref } = await import('../src/lib/site-ref.js');
    expect(takeoverHref({ domain: 'local.spellbook.example' })).toBe('/sites/local.spellbook.example?tab=overview&takeover=1');
    // A site under a path shares its domain's vhost: the takeover is the domain's.
    expect(takeoverHref({ domain: 'local.spellbook.example', path: '/learn' })).toBe('/sites/local.spellbook.example?tab=overview&takeover=1');
  });
});

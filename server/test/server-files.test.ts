import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actions } from '@devmagic-panel/shared';
import { checkListing, copyFromServer, dropLinks, removeCopied, serverItems } from '../src/sites/server-files.js';
import { fakeExec, type FakeCall, wpSiteTree } from './helpers.js';

const src = { host: 'deploy@www.spellbook.example', folder: '/srv/www/spellbook' };
const entry = (type: string, name: string) => `${type}rw-r--r-- 1000/1000      1200 2026-10-01 10:00 ${name}`;
const listing = (item: string) => [entry('d', `${item}/`), entry('-', `${item}/${item}.php`), entry('-', `${item}/inc/forms.php`)].join('\n');

/** A server that answers WP-CLI and tar, and a local tar that unpacks what the test says. */
function server(_t: { docroot: string }, options: { listing?: (item: string) => string; unpack?: (into: string, item: string) => void; tar?: Partial<{ code: number; stderr: string }> } = {}) {
  const item = (call: FakeCall) => call.args.at(-1) as string;
  let last = '';
  return fakeExec({
    ssh: (call) => {
      const words = call.args.join(' ');
      if (words.includes(' plugin path')) return { stdout: '/srv/www/spellbook/wp-content/plugins\n' };
      if (words.includes(' theme path')) return { stdout: '/srv/www/spellbook/wp-content/themes\n' };
      if (words.includes(' plugin list')) return { stdout: JSON.stringify([{ name: 'wandworks-pro-forms', version: '3.2.0', status: 'active' }, { name: 'bad name', version: '1' }, { name: 'hello', version: '1.7.2', status: 'inactive' }]) };
      if (words.includes(' tar ')) {
        last = item(call);
        return { stdout: 'tar bytes', ...options.tar };
      }
      return { code: 1, stderr: 'not faked' };
    },
    'tar --numeric-owner -tvf': () => ({ stdout: (options.listing ?? listing)(last) }),
    'tar -xf': (call) => {
      const into = call.args[3] as string;
      if (options.unpack) options.unpack(into, last);
      else {
        mkdirSync(join(into, last, 'inc'), { recursive: true });
        writeFileSync(join(into, last, `${last}.php`), '<?php // the plugin');
        writeFileSync(join(into, last, 'inc/forms.php'), '<?php');
      }
      return {};
    },
    git: { code: 128, stderr: 'not a git repository' },
  });
}

describe('what a server may send', () => {
  it('takes files and folders inside the one folder asked for, and counts its links', () => {
    expect(checkListing(listing('wandworks-pro-forms'), 'wandworks-pro-forms')).toEqual({ links: 0, entries: 3 });
    expect(checkListing([listing('wandworks-pro-forms'), `${entry('l', 'wandworks-pro-forms/vendor/bin/tool')} -> ../tool/bin`].join('\n'), 'wandworks-pro-forms')).toEqual({ links: 1, entries: 4 });
    expect(checkListing(entry('-', 'hello.php'), 'hello.php')).toEqual({ links: 0, entries: 1 });
  });

  it('refuses an entry outside the folder, a hard link, an entry under a link, and a listing it cannot read', () => {
    const item = 'wandworks-pro-forms';
    expect(checkListing([listing(item), entry('-', 'other-plugin/evil.php')].join('\n'), item)).toEqual({ error: 'the archive holds other-plugin/evil.php, which is outside wandworks-pro-forms' });
    expect(checkListing(entry('-', `${item}/../../wp-config.php`), item)).toMatchObject({ error: expect.stringContaining('which leaves wandworks-pro-forms') });
    expect(checkListing(entry('-', '/etc/passwd'), item)).toMatchObject({ error: expect.stringContaining('outside') });
    expect(checkListing(`${entry('h', `${item}/key`)} link to /home/alex/.ssh/id_ed25519`, item)).toMatchObject({ error: expect.stringContaining('hard link') });
    expect(checkListing([`${entry('l', `${item}/out`)} -> /home/alex`, entry('-', `${item}/out/authorized_keys`)].join('\n'), item)).toMatchObject({ error: expect.stringContaining('under a link') });
    expect(checkListing('something else', item)).toMatchObject({ error: expect.stringContaining('cannot read') });
    expect(checkListing('', item)).toEqual({ error: 'the archive is empty' });
  });

  it('drops links from what was unpacked, and keeps files and folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-server-files-'));
    mkdirSync(join(dir, 'p/inc'), { recursive: true });
    writeFileSync(join(dir, 'p/inc/a.php'), '<?php');
    symlinkSync('/etc/passwd', join(dir, 'p/inc/passwd'));
    symlinkSync('/etc', join(dir, 'p/etc'));
    expect(dropLinks(join(dir, 'p'))).toBe(2);
    expect(existsSync(join(dir, 'p/inc/a.php'))).toBe(true);
    expect(existsSync(join(dir, 'p/etc'))).toBe(false);
  });
});

describe('copying plugins from the server', () => {
  it('reads the folder with WP-CLI, streams one folder with tar, checks it and moves it into place', async () => {
    const t = wpSiteTree();
    const plugins = join(t.docroot, 'wp-content/plugins');
    mkdirSync(plugins, { recursive: true });
    const fake = server(t);
    const out = await copyFromServer(fake.exec, t.docroot, src, { plugins: ['wandworks-pro-forms'], themes: [] }, join(t.root, 'scratch'));
    expect(out.failed).toEqual([]);
    expect(out.made).toEqual([join(plugins, 'wandworks-pro-forms')]);
    expect(readFileSync(join(plugins, 'wandworks-pro-forms/wandworks-pro-forms.php'), 'utf8')).toContain('the plugin');
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(text).toContain('wandworks-pro-forms: copied from deploy@www.spellbook.example into wp-content/plugins');
    expect(text).toContain('nothing was written there');
    // Only reads on the server: WP-CLI's path, and tar to stdout, with fixed words.
    const ssh = fake.calls.filter((c) => c.file === 'ssh').map((c) => c.args.slice(c.args.indexOf('deploy@www.spellbook.example') + 1).join(' '));
    expect(ssh).toEqual(['wp --path=/srv/www/spellbook plugin path --skip-plugins --skip-themes', 'tar --hard-dereference -cf - -C /srv/www/spellbook/wp-content/plugins -- wandworks-pro-forms']);
    // Nothing of the panel's is left in the site or the scratch folder.
    expect(existsSync(join(t.root, 'scratch')) ? readdirSync(join(t.root, 'scratch')) : []).toEqual([]);
    expect(readdirSync(plugins)).toEqual(['wandworks-pro-forms']);
    expect(removeCopied(out.made).code).toBe(0);
    expect(existsSync(join(plugins, 'wandworks-pro-forms'))).toBe(false);
  });

  it('leaves a folder that exists, notes one that fails and goes on with the rest', async () => {
    const t = wpSiteTree();
    const plugins = join(t.docroot, 'wp-content/plugins');
    mkdirSync(join(plugins, 'here-already'), { recursive: true });
    const fake = server(t, { listing: (item) => (item === 'sneaky' ? [listing(item), entry('-', 'wp-config.php')].join('\n') : listing(item)) });
    const out = await copyFromServer(fake.exec, t.docroot, src, { plugins: ['here-already', 'sneaky', 'wandworks-pro-forms'], themes: [] }, join(t.root, 'scratch'));
    expect(out.failed).toEqual(['sneaky']);
    expect(out.made).toEqual([join(plugins, 'wandworks-pro-forms')]);
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(text).toContain('here-already: wp-content/plugins/here-already is there already; left as it is');
    expect(text).toContain('warn: sneaky was not copied: the archive holds wp-config.php, which is outside sneaky');
    expect(text).toContain('copied 2 of 3 from deploy@www.spellbook.example; not copied: sneaky');
    expect(existsSync(join(plugins, 'sneaky'))).toBe(false);
    // A refused archive is never unpacked.
    expect(fake.calls.filter((c) => c.file === 'tar' && c.args[0] === '-xf')).toHaveLength(1);
    expect(out.results.every((r) => r.code === 0)).toBe(true);
  });

  it('says what the server lacks, and copies nothing through a link or with a name that is not plain', async () => {
    const t = wpSiteTree();
    mkdirSync(join(t.docroot, 'wp-content/plugins'), { recursive: true });
    const gone = server(t, { tar: { code: 2, stderr: 'tar: gone-plugin: Cannot stat: No such file or directory' } });
    const out = await copyFromServer(gone.exec, t.docroot, src, { plugins: ['gone-plugin', '../wp-config.php', 'a b'], themes: [] }, join(t.root, 'scratch'));
    expect(out.results.map((r) => r.stdout).join('\n')).toContain('warn: gone-plugin was not copied: deploy@www.spellbook.example has no gone-plugin in /srv/www/spellbook/wp-content/plugins');
    expect(gone.calls.filter((c) => c.args.includes('tar')).map((c) => c.args.at(-1))).toEqual(['gone-plugin']);
    // wp-content/themes is a link here: nothing lands behind it.
    symlinkSync(join(t.root), join(t.docroot, 'wp-content/themes'));
    const linked = server(t);
    const themes = await copyFromServer(linked.exec, t.docroot, src, { plugins: [], themes: ['wandworks'] }, join(t.root, 'scratch'));
    expect(themes.failed).toEqual(['wandworks']);
    expect(themes.results[0]?.stdout).toContain('wp-content/themes is not a folder of this site');
    expect(linked.calls).toEqual([]);
  });

  it('lists what the server has, without names that are not plain', async () => {
    const t = wpSiteTree();
    const fake = server(t);
    expect(await serverItems(fake.exec, src, 'plugin')).toEqual([{ name: 'wandworks-pro-forms', version: '3.2.0', status: 'active' }, { name: 'hello', version: '1.7.2', status: 'inactive' }]);
  });

  it('takes only plain names in the action, and at least one', () => {
    const input = actions['site.copyFromServer'].input;
    const base = { domain: 'local.spellbook.test', host: 'deploy@www.spellbook.example', folder: '/srv/www/spellbook' };
    expect(input.safeParse({ ...base, plugins: ['wandworks-pro-forms', 'hello.php'] }).success).toBe(true);
    expect(input.safeParse({ ...base, plugins: [] }).success).toBe(false);
    expect(input.safeParse({ ...base, plugins: ['../wp-config.php'] }).success).toBe(false);
    expect(input.safeParse({ ...base, plugins: ['a; rm -rf x'] }).success).toBe(false);
    expect(input.safeParse({ ...base, folder: '/srv/www/$(id)', plugins: ['a'] }).success).toBe(false);
  });
});

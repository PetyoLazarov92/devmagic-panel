import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installPlugins, installThemes, pluginPresent, removeInstalled, slugOf } from '../src/sites/install-plugins.js';
import { readThemes } from '../src/sites/plugins.js';
import { siteFor } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { wporgPlugins } from '../src/wporg-plugins.js';
import { fakeExec, type FakeCall, wpSiteTree } from './helpers.js';

const base = (docroot: string) => `wp --path=${docroot} --url=https://local.shop.com/`;

describe('installing missing plugins from WordPress.org', () => {
  it('tries every plugin: one that fails is noted and the rest go on, as wp-cli-plugin-install-missing did not', async () => {
    const t = wpSiteTree();
    const plugins = join(t.docroot, 'wp-content', 'plugins');
    const install = (call: FakeCall) => {
      const slug = call.args[4] as string;
      if (slug === 'wandworks-pro') return { code: 1, stderr: 'Warning: wandworks-pro: Plugin not found.\nError: No plugins installed.' };
      mkdirSync(join(plugins, slug), { recursive: true });
      // A deprecation notice on stderr is not a failure: the exit code says.
      return { stdout: `Success: Installed 1 of 1 plugins.`, stderr: 'PHP Deprecated:  something in wp-cli' };
    };
    const fake = fakeExec({
      [`${base(t.docroot)} plugin install`]: install,
      [`${base(t.docroot)} plugin verify-checksums`]: { stdout: 'Success: Verified 1 of 1 plugins.' },
    });
    const out = await installPlugins(fake.exec, t.docroot, 'local.shop.com', [{ slug: 'wandworks-pro' }, { slug: 'redirection', version: '5.5.1' }, { slug: 'duplicate-post' }]);
    expect(out.failed).toEqual(['wandworks-pro']);
    expect(out.installed).toEqual([join(plugins, 'redirection'), join(plugins, 'duplicate-post')]);
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(text).toContain('warn: wandworks-pro was not installed: Plugin not found.');
    expect(text).toContain('redirection: installed 5.5.1 from WordPress.org, checksums match');
    expect(text).toContain('installed 2 of 3; not installed: wandworks-pro');
    expect(out.results.every((r) => r.code === 0)).toBe(true);
    // Nothing of the site runs during an install.
    expect(fake.calls.filter((c) => c.args.includes('install')).every((c) => c.args.includes('--skip-plugins') && c.args.includes('--skip-themes'))).toBe(true);
    expect(fake.calls.find((c) => c.args[4] === 'redirection')?.args).toContain('--version=5.5.1');
    expect(removeInstalled(out.installed).code).toBe(0);
    expect(existsSync(join(plugins, 'redirection'))).toBe(false);
  });

  it("takes the latest when production's version is gone, removes one that fails its checksums, and leaves a folder that is there", async () => {
    const t = wpSiteTree();
    const plugins = join(t.docroot, 'wp-content', 'plugins');
    mkdirSync(join(plugins, 'akismet'), { recursive: true });
    const fake = fakeExec({
      [`${base(t.docroot)} plugin install`]: (call: FakeCall) => {
        const slug = call.args[4] as string;
        if (call.args.some((a) => a.startsWith('--version='))) return { code: 1, stderr: 'Error: Download failed. Not Found' };
        mkdirSync(join(plugins, slug), { recursive: true });
        return { stdout: 'Success' };
      },
      [`${base(t.docroot)} plugin verify-checksums tampered`]: { code: 1, stderr: "Warning: File doesn't verify against checksum: tampered.php\nError: No plugins verified." },
      [`${base(t.docroot)} plugin verify-checksums old-slider`]: { code: 1, stderr: 'Warning: Could not retrieve the checksums for version 1.0 of plugin old-slider, skipping.' },
    });
    const out = await installPlugins(fake.exec, t.docroot, 'local.shop.com', [{ slug: 'old-slider', version: '1.0' }, { slug: 'tampered' }, { slug: 'akismet' }]);
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(text).toContain("old-slider: 1.0, production's version, is not on WordPress.org");
    expect(text).toContain('old-slider: installed the latest version from WordPress.org, WordPress.org has no checksums for it');
    expect(text).toContain("warn: tampered did not match WordPress.org's checksums, so it was removed again");
    expect(existsSync(join(plugins, 'tampered'))).toBe(false);
    expect(text).toContain('akismet: wp-content/plugins/akismet is there already; left as it is');
    expect(out.installed).toEqual([join(plugins, 'old-slider')]);
  });

  it('moves an upgrade folder the web server made aside for the run and puts it back, and says why WordPress installed nothing', async () => {
    const t = wpSiteTree();
    const content = join(t.docroot, 'wp-content');
    const upgrade = join(content, 'upgrade');
    mkdirSync(upgrade, { recursive: true });
    writeFileSync(join(upgrade, 'index.php'), '<?php // Silence is golden.');
    chmodSync(upgrade, 0o555);
    const fake = fakeExec({
      [`${base(t.docroot)} plugin install`]: (call: FakeCall) => {
        const slug = call.args[4] as string;
        // WordPress unpacks here first: the folder has to be one you can write in.
        try {
          mkdirSync(join(upgrade, slug), { recursive: true });
        } catch {
          return { code: 1, stderr: `Warning: ${slug}: Could not create directory. "${upgrade}/${slug}"\nError: No plugins installed.` };
        }
        if (slug === 'wandworks-pro') return { code: 1, stderr: 'Warning: wandworks-pro: Plugin not found.\nError: No plugins installed.' };
        mkdirSync(join(content, 'plugins', slug), { recursive: true });
        return { stdout: 'Success: Installed 1 of 1 plugins.' };
      },
      [`${base(t.docroot)} plugin verify-checksums`]: { stdout: 'Success: Verified 1 of 1 plugins.' },
    });
    const out = await installPlugins(fake.exec, t.docroot, 'local.shop.com', [{ slug: 'redirection' }, { slug: 'wandworks-pro' }]);
    chmodSync(upgrade, 0o755);
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(out.failed).toEqual(['wandworks-pro']);
    expect(text).toContain('wp-content/upgrade was made by the web server and you cannot write in it: moved aside for this run and put back after');
    expect(text).toContain('redirection: installed the latest version from WordPress.org');
    expect(text).toContain('warn: wandworks-pro was not installed: Plugin not found.');
    // Back as it was, with nothing of the run in it.
    expect(readFileSync(join(upgrade, 'index.php'), 'utf8')).toContain('Silence is golden');
    expect(existsSync(join(upgrade, 'redirection'))).toBe(false);
    expect(existsSync(join(content, 'upgrade.devmagic-panel-aside'))).toBe(false);
  });

  it('reads a plugin\'s slug and whether it is on disk', () => {
    const t = wpSiteTree();
    mkdirSync(join(t.docroot, 'wp-content/plugins'), { recursive: true });
    expect(slugOf({ file: 'hello.php', slug: 'hello-dolly' })).toBe('hello-dolly');
    expect(slugOf({ file: 'redirection/redirection.php' })).toBe('redirection');
    writeFileSync(join(t.docroot, 'wp-content/plugins/hello.php'), '<?php');
    expect(pluginPresent(t.docroot, 'hello.php')).toBe(true);
    expect(pluginPresent(t.docroot, '../wp-config.php')).toBe(false);
  });

  it('asks WordPress.org once a day per slug, and keeps no answer from a failed request', async () => {
    const store = new RunStore(':memory:');
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      const slug = /request\[slug\]=([^&]+)/.exec(url)?.[1] as string;
      asked.push(slug);
      if (slug === 'down') throw new Error('timeout');
      if (slug === 'wandworks-pro') return { status: 404, body: null };
      return { status: 200, body: { slug, name: 'Redirection <b>Pro</b>', version: '5.5.2' } };
    };
    const now = Date.parse('2026-11-09T10:00:00Z');
    expect(await wporgPlugins(['redirection', 'wandworks-pro', 'down', 'Bad Slug'], store, fetcher, now)).toEqual({ redirection: { name: 'Redirection Pro', version: '5.5.2' }, 'wandworks-pro': null });
    expect(asked.sort()).toEqual(['down', 'redirection', 'wandworks-pro']);
    await wporgPlugins(['redirection', 'wandworks-pro', 'down'], store, fetcher, now + 3_600_000);
    expect(asked.filter((s) => s === 'redirection')).toHaveLength(1);
    expect(asked.filter((s) => s === 'down')).toHaveLength(2);
  });
});

describe('missing themes', () => {
  it('installs a theme from WordPress.org at production\'s version, notes one that fails, and never activates', async () => {
    const t = wpSiteTree();
    const themes = join(t.docroot, 'wp-content', 'themes');
    mkdirSync(themes, { recursive: true });
    const fake = fakeExec({
      [`${base(t.docroot)} theme install`]: (call: FakeCall) => {
        const slug = call.args[4] as string;
        if (slug === 'wandworks-parent') return { code: 1, stderr: 'Warning: wandworks-parent: Theme not found.\nError: No themes installed.' };
        mkdirSync(join(themes, slug), { recursive: true });
        return { stdout: 'Success: Installed 1 of 1 themes.' };
      },
    });
    const out = await installThemes(fake.exec, t.docroot, 'local.shop.com', [{ slug: 'wandworks-parent' }, { slug: 'twentytwentyfive', version: '1.3' }]);
    expect(out.failed).toEqual(['wandworks-parent']);
    expect(out.installed).toEqual([join(themes, 'twentytwentyfive')]);
    const text = out.results.map((r) => r.stdout).join('\n');
    expect(text).toContain('warn: the theme wandworks-parent was not installed: Theme not found.');
    expect(text).toContain('twentytwentyfive: installed 1.3 of the theme from WordPress.org');
    expect(fake.calls.some((c) => c.args.includes('activate'))).toBe(false);
    expect(fake.calls.find((c) => c.args[4] === 'twentytwentyfive')?.args).toContain('--version=1.3');
  });
});

describe('the themes of a site', () => {
  it('lists what WP-CLI has and the themes in repos under wp-content/repos, with the one that is on first', async () => {
    const t = wpSiteTree();
    const kit = join(t.docroot, 'wp-content/repos/theme-kit/wandworks');
    mkdirSync(kit, { recursive: true });
    for (const f of ['functions.php', 'index.php', 'header.php']) writeFileSync(join(kit, f), '<?php');
    writeFileSync(join(kit, 'style.css'), '/*\nTheme Name: Wandworks\nVersion: 2.1.0\n*/');
    mkdirSync(join(t.docroot, 'wp-content/repos/theme-kit/node_modules/x'), { recursive: true });
    const fake = fakeExec({
      [`${base(t.docroot)} theme list`]: { stdout: JSON.stringify([{ name: 'twentytwentyfive', title: 'Twenty Twenty-Five', status: 'inactive', version: '1.2', update: 'available', update_version: '1.3' }]) },
      [`${base(t.docroot)} option get stylesheet`]: { stdout: 'wandworks\n' },
      [`${base(t.docroot)} option get template`]: { stdout: 'wandworks\n' },
    });
    const site = siteFor(t.config, 'local.shop.com');
    expect(await readThemes(fake.exec, site)).toEqual({
      network: false,
      themes: [
        { name: 'wandworks', title: 'Wandworks', status: 'active', version: '2.1.0', folder: 'wp-content/repos/theme-kit/wandworks', inRepo: true },
        { name: 'twentytwentyfive', title: 'Twenty Twenty-Five', status: 'inactive', version: '1.2', update: '1.3', folder: 'wp-content/themes/twentytwentyfive' },
      ],
    });
    expect(fake.calls.every((c) => c.args.includes('--skip-plugins') && c.args.includes('--skip-themes'))).toBe(true);
  });
});

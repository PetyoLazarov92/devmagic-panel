import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { unwritableByWeb } from '../src/sites/discover.js';
import { readLocalMode } from '../src/sites/local-mode.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { LOGIN_PLUGIN_FILE } from '../src/sites/site-actions.js';
import { Jobs } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const WPCORE = '/usr/local/lib/devmagic-panel/bin/wpcore';

function setup(options: Parameters<typeof wpSiteTree>[0] = {}, overrides: (docroot: string) => Parameters<typeof fakeExec>[0] = () => ({})) {
  const t = wpSiteTree(options);
  const wpBase = `wp --path=${t.docroot}`;
  const fake = fakeExec({
    [`${wpBase} --url=https://local.shop.com/ cache flush`]: { stdout: 'Success: The cache was flushed.\n' },
    [`${wpBase} --url=https://local.shop.com/ transient delete --all`]: { stdout: 'Success: 3 transients deleted.\n' },
    [`sudo -n ${DMP} apache-reload`]: { stdout: 'ok: apache reloaded\n' },
    [`${wpBase} --url=https://local.shop.com/ rewrite flush`]: { stdout: 'Success: Rewrite rules flushed.\n' },
    [`${wpBase} --url=https://local.shop.com/ config set`]: { stdout: 'Success: Updated the constant.\n' },
    [`${wpBase} --url=https://local.shop.com/ config delete`]: { stdout: 'Success: Deleted the constant.\n' },
    [`${wpBase} --url=https://local.shop.com/ config shuffle-salts`]: { stdout: 'Success: Shuffled the salt keys.\n' },
    [`${wpBase} --url=https://local.shop.com/ user list`]: { stdout: 'admin\n' },
    [`${wpBase} --url=https://local.shop.com/ super-admin list`]: { stdout: '[{"user_login":"netadmin"}]' },
    [`${wpBase} --url=https://local.shop.com/ user get`]: { stdout: '7\n' },
    [`${wpBase} --url=https://local.shop.com/ transient set`]: { stdout: 'Success: Transient added.\n' },
    [`${wpBase} --url=https://local.shop.com/de/ super-admin list`]: { stdout: '[{"user_login":"netadmin"}]' },
    [`${wpBase} --url=https://local.shop.com/de/ user get`]: { stdout: '7\n' },
    [`${wpBase} --url=https://local.shop.com/de/ transient set`]: { stdout: 'Success: Transient added.\n' },
    [`git -C ${t.docroot}/wp-content/mu-plugins rev-parse --show-toplevel`]: { stdout: `${t.docroot}\n` },
    [`git -C ${t.docroot} rev-parse --git-path info/exclude`]: { stdout: '.git/info/exclude\n' },
    [`sudo -n ${WPCORE} switch`]: { stdout: 'local.shop.com → WordPress 6.8.3\n' },
    [`${wpBase} --url=https://local.shop.com/ core update-db`]: { stdout: 'Success: WordPress database upgraded.\n' },
    ...overrides(t.docroot),
  });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: WPCORE, wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
  };
  return { ...t, ctx, calls: fake.calls, store };
}

const lines = (calls: ReturnType<typeof setup>['calls']) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('site.clearCache', () => {
  it('flushes the object cache and transients, then reloads Apache for OPcache', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com' });
    expect(result.ok).toBe(true);
    expect(lines(s.calls)).toEqual([
      `wp --path=${s.docroot} --url=https://local.shop.com/ cache flush`,
      `wp --path=${s.docroot} --url=https://local.shop.com/ transient delete --all`,
      `sudo -n ${DMP} apache-reload`,
    ]);
  });

  it('also clears network transients on a multisite', async () => {
    const s = setup({ multisite: true });
    await runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com' });
    expect(lines(s.calls)).toContain(`wp --path=${s.docroot} --url=https://local.shop.com/ transient delete --all --network`);
  });

  it('stops at the first failing step', async () => {
    const s = setup({}, (docroot) => ({ [`wp --path=${docroot} --url=https://local.shop.com/ cache flush`]: { code: 1, stderr: 'Error: no database' } }));
    const result = await runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com' });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(s.calls).toHaveLength(1);
  });

  it('refuses a domain with no site', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.nope.com' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.de' })).rejects.toBeInstanceOf(ActionInputError);
    expect(s.calls).toHaveLength(0);
  });
});

const KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];

describe('site.setDebug and site.clearDebugLog', () => {
  it('sets only the constants that change, and leaves out ones WordPress already defaults to', async () => {
    const s = setup();
    // The sample wp-config.php already has WP_DEBUG true and nothing else.
    await runAction(s.ctx, 'site.setDebug', { domain: 'local.shop.com', constants: { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false, SCRIPT_DEBUG: false } });
    await runAction(s.ctx, 'site.setDebug', { domain: 'local.shop.com', constants: { WP_DEBUG: false } });
    expect(lines(s.calls).map((l) => l.split(' config set ')[1])).toEqual([
      'WP_DEBUG_LOG true --raw --type=constant',
      'WP_DEBUG_DISPLAY false --raw --type=constant',
      'WP_DEBUG false --raw --type=constant',
    ]);
  });

  it('keeps a custom WP_DEBUG_LOG path and refuses empty or unknown constants', async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-config.php'), "<?php\ndefine('WP_DEBUG', true);\ndefine('WP_DEBUG_LOG', '/tmp/shop.log');\n");
    const result = await runAction(s.ctx, 'site.setDebug', { domain: 'local.shop.com', constants: { WP_DEBUG_LOG: true } });
    expect(result.output).toContain('already');
    expect(s.calls).toHaveLength(0);
    await expect(runAction(s.ctx, 'site.setDebug', { domain: 'local.shop.com', constants: {} })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.setDebug', { domain: 'local.shop.com', constants: { WP_CACHE: true } })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('sets, adds and removes one constant through wp config, and refuses the ones the panel does not set', async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-config.php'), "<?php\nif ( ! defined( 'WP_DEBUG' ) ) {\n\tdefine( 'WP_DEBUG', true );\n}\ndefine( 'ACME_FLAG', 'one' );\n");
    await runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', name: 'WP_DEBUG', value: false });
    await runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', name: 'ACME_DEV', value: true });
    await runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', name: 'WP_MEMORY_LIMIT', value: '256M' });
    await runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', name: 'ACME_FLAG', value: null });
    const none = await runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', name: 'ACME_GONE', value: null });
    expect(none.output).toContain('nothing to remove');
    expect(lines(s.calls).map((l) => l.split(' --url=https://local.shop.com/ ')[1])).toEqual([
      'config set WP_DEBUG false --raw --type=constant',
      'config set ACME_DEV true --raw --type=constant',
      'config set WP_MEMORY_LIMIT 256M --type=constant',
      'config delete ACME_FLAG --type=constant',
    ]);
    for (const input of [{ name: 'DB_PASSWORD', value: 'x' }, { name: 'AUTH_KEY', value: 'x' }, { name: 'ACME_API_KEY', value: 'x' }, { name: 'MULTISITE', value: null }, { name: 'bad-name', value: true }, { name: 'ACME', value: '--path=/' }, { name: 'ACME', value: 'two\nlines' }]) {
      await expect(runAction(s.ctx, 'site.setConstant', { domain: 'local.shop.com', ...input })).rejects.toBeInstanceOf(ActionInputError);
    }
    expect(s.calls).toHaveLength(4);
  });

  it('writes only the keys WordPress would not use, or makes all of them new', async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-config.php'), "<?php\ndefine( 'AUTH_KEY', 'a' );\ndefine( 'SECURE_AUTH_KEY', 'put your unique phrase here' );\ndefine( 'LOGGED_IN_KEY', 'a' );\ndefine( 'NONCE_SALT', 'b' );\n");
    await runAction(s.ctx, 'site.shuffleSalts', { domain: 'local.shop.com', only: 'missing' });
    await runAction(s.ctx, 'site.shuffleSalts', { domain: 'local.shop.com', only: 'all' });
    expect(lines(s.calls).map((l) => l.split(' --url=https://local.shop.com/ ')[1])).toEqual([
      'config shuffle-salts AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT --force',
      'config shuffle-salts AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT --force',
    ]);
    writeFileSync(join(s.docroot, 'wp-config.php'), `<?php\n${KEYS.map((k, i) => `define( '${k}', 'value ${i}' );`).join('\n')}\n`);
    const none = await runAction(s.ctx, 'site.shuffleSalts', { domain: 'local.shop.com', only: 'missing' });
    expect(none.output).toContain('has all 8 keys and salts, each its own');
    expect(s.calls).toHaveLength(2);
  });

  it("asks for the keys the site's own wp-config-sample.php lists", async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-config-sample.php'), "<?php\ndefine( 'AUTH_KEY', 'put your unique phrase here' );\ndefine( 'ACME_NEW_SALT',   'put your unique phrase here' );\ndefine( 'DB_NAME', 'database_name_here' );\n");
    writeFileSync(join(s.docroot, 'wp-config.php'), "<?php\ndefine( 'AUTH_KEY', 'a' );\n");
    await runAction(s.ctx, 'site.shuffleSalts', { domain: 'local.shop.com', only: 'missing' });
    expect(lines(s.calls)[0]?.split(' --url=https://local.shop.com/ ')[1]).toBe('config shuffle-salts ACME_NEW_SALT --force');
  });

  it('removes SECRET_KEY and SECRET_SALT only once every current key is usable', async () => {
    const s = setup();
    const legacy = "define( 'SECRET_KEY', 'old' );\ndefine( 'SECRET_SALT', 'older' );\n";
    writeFileSync(join(s.docroot, 'wp-config.php'), `<?php\n${legacy}define( 'AUTH_KEY', 'a' );\n`);
    const refused = await runAction(s.ctx, 'site.removeLegacySalts', { domain: 'local.shop.com' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.output).toContain('fix the keys first');
    writeFileSync(join(s.docroot, 'wp-config.php'), `<?php\n${legacy}${KEYS.map((k, i) => `define( '${k}', 'value ${i}' );`).join('\n')}\n`);
    expect((await runAction(s.ctx, 'site.removeLegacySalts', { domain: 'local.shop.com' })).ok).toBe(true);
    expect(lines(s.calls).map((l) => l.split(' --url=https://local.shop.com/ ')[1])).toEqual(['config delete SECRET_KEY --type=constant', 'config delete SECRET_SALT --type=constant']);
  });

  it('empties debug.log', async () => {
    const s = setup();
    writeFileSync(join(s.docroot, 'wp-content/debug.log'), 'lots of noise\n');
    const result = await runAction(s.ctx, 'site.clearDebugLog', { domain: 'local.shop.com' });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(s.docroot, 'wp-content/debug.log'), 'utf8')).toBe('');
  });

  it('removes a log it cannot empty, like one PHP owns', async () => {
    const s = setup();
    const log = join(s.docroot, 'wp-content/debug.log');
    writeFileSync(log, 'owned by www-data\n');
    chmodSync(log, 0o444);
    const result = await runAction(s.ctx, 'site.clearDebugLog', { domain: 'local.shop.com' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('removed');
    expect(existsSync(log)).toBe(false);
  });
});

describe('site.login', () => {
  it('installs the helper, keeps it out of git, stores a one-time token and returns the link', async () => {
    const s = setup();
    mkdirSync(join(s.docroot, '.git/info'), { recursive: true });
    const result = await runAction(s.ctx, 'site.login', { domain: 'local.shop.com' });
    expect(result.ok).toBe(true);

    expect(existsSync(join(s.docroot, 'wp-content/mu-plugins', LOGIN_PLUGIN_FILE))).toBe(true);
    expect(readFileSync(join(s.docroot, '.git/info/exclude'), 'utf8')).toContain(`/wp-content/mu-plugins/${LOGIN_PLUGIN_FILE}`);

    const token = new URL(result.data?.url ?? '').searchParams.get('dmp_login') ?? '';
    expect(result.data?.url).toMatch(/^https:\/\/local\.shop\.com\/\?dmp_login=[\w-]{32}$/);
    const set = lines(s.calls).find((l) => l.includes('transient set')) ?? '';
    expect(set).toMatch(/transient set dmp_login_[0-9a-f]{40} 7 60$/);
    expect(set).not.toContain(token);
    expect(result.output).not.toContain(token);
    expect(s.store.recent()[0]?.output).not.toContain(token);
  });

  it('does not add the exclude line twice', async () => {
    const s = setup();
    mkdirSync(join(s.docroot, '.git/info'), { recursive: true });
    await runAction(s.ctx, 'site.login', { domain: 'local.shop.com' });
    await runAction(s.ctx, 'site.login', { domain: 'local.shop.com' });
    const exclude = readFileSync(join(s.docroot, '.git/info/exclude'), 'utf8');
    expect(exclude.match(/devmagic-panel-login\.php/g)).toHaveLength(1);
  });

  it('logs in as the first super admin on a network site and can go to Network Admin', async () => {
    const s = setup({ multisite: true });
    const result = await runAction(s.ctx, 'site.login', { domain: 'local.shop.com', siteUrl: 'https://local.shop.com/de', to: 'network' });
    expect(result.data?.url).toMatch(/^https:\/\/local\.shop\.com\/de\/\?dmp_login=[\w-]+&to=network$/);
    expect(lines(s.calls).some((l) => l.includes('--url=https://local.shop.com/de/ user get netadmin'))).toBe(true);
  });

  it('refuses a URL that is not part of the site', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.login', { domain: 'local.shop.com', siteUrl: 'https://evil.example.com/' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.login', { domain: 'local.shop.com', siteUrl: 'https://local.other.com/' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('core.switch', () => {
  it('switches with wpcore, answering its question, then updates the database', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'core.switch', { domain: 'local.shop.com', version: '6.8.3' });
    expect(result.ok).toBe(true);
    expect(s.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', WPCORE, 'switch', 'local.shop.com', '6.8.3'], input: 'n\n' });
    expect(lines(s.calls)[1]).toBe(`wp --path=${s.docroot} --url=https://local.shop.com/ core update-db`);
  });

  it("puts the repo's index.php back after wpcore links the new core's over it", async () => {
    const s = setup({}, (docroot) => ({ [`git -C ${docroot}`]: {} }));
    rmSync(join(s.docroot, 'index.php'), { force: true });
    symlinkSync(join(s.docroot, 'wp-includes', 'version.php'), join(s.docroot, 'index.php'));
    expect((await runAction(s.ctx, 'core.switch', { domain: 'local.shop.com', version: '6.8.3' })).ok).toBe(true);
    expect(lines(s.calls).slice(1)).toEqual([
      `git -C ${s.docroot} ls-files --error-unmatch -- index.php`,
      `git -C ${s.docroot} checkout -- index.php`,
      `wp --path=${s.docroot} --url=https://local.shop.com/ core update-db`,
    ]);
  });

  it('refuses versions that are not installed and sites with their own copy', async () => {
    const s = setup();
    expect((await runAction(s.ctx, 'core.switch', { domain: 'local.shop.com', version: '5.0.1' })).ok).toBe(false);
    const own = setup({ ownCore: true });
    const result = await runAction(own.ctx, 'core.switch', { domain: 'local.shop.com', version: '6.8.3' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('own copy');
    expect(s.calls.concat(own.calls).filter((c) => c.file === 'sudo')).toHaveLength(0);
  });

  it('rejects malformed versions before anything runs', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'core.switch', { domain: 'local.shop.com', version: '7.1.3; rm -rf /' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('site.setLocalMode', () => {
  it('writes the plugin with the chosen hosts and removes it when turned off', async () => {
    const s = setup();
    const file = join(s.docroot, 'wp-content/mu-plugins/devmagic-panel-local.php');
    const on = await runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', enabled: true, blockedHosts: ['api.hubapi.com'] });
    expect(on).toMatchObject({ ok: true, output: 'Local mode on: mail goes to Mailpit, 1 host blocked' });
    expect(readFileSync(file, 'utf8')).toContain("array( 'api.hubapi.com' )");
    expect((await runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', enabled: false })).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('rejects hosts that are not hostnames before writing anything', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', enabled: true, blockedHosts: ["a.com'"] })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('cert.reissue and hosts.remove', () => {
  it('reissue from the vhost then reload Apache, and remove one hosts line', async () => {
    const s = setup({}, () => ({ [`sudo -n ${DMP} cert-reissue-from-vhost`]: { stdout: 'ok\n' }, [`sudo -n ${DMP} hosts-remove`]: { stdout: 'ok\n' } }));
    expect((await runAction(s.ctx, 'cert.reissue', { domain: 'local.shop.com' })).ok).toBe(true);
    expect((await runAction(s.ctx, 'hosts.remove', { domain: 'local.gone.test' })).ok).toBe(true);
    expect(lines(s.calls)).toEqual([
      `sudo -n ${DMP} cert-reissue-from-vhost local.shop.com`,
      `sudo -n ${DMP} apache-reload`,
      `sudo -n ${DMP} hosts-remove local.gone.test`,
    ]);
    await expect(runAction(s.ctx, 'cert.reissue', { domain: 'www.example.com' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('site.setUploadsFrom and site.fixWritable', () => {
  it('redirects missing uploads through Local mode for a vhost made by hand, and only with Local mode on', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com' })).rejects.toThrow(/turn on Local mode first/);
    await runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', enabled: true });
    expect((await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com' })).ok).toBe(true);
    const plugin = readFileSync(join(s.docroot, 'wp-content/mu-plugins/devmagic-panel-local.php'), 'utf8');
    expect(plugin).toContain("const DMP_LOCAL_MODE_UPLOADS_FROM = 'www.shop.com';");
    expect(plugin).toContain("define( 'FS_METHOD', 'direct' );");
    expect(readLocalMode(s.docroot)).toMatchObject({ current: true, uploadsFrom: 'www.shop.com' });
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: null });
    expect(readLocalMode(s.docroot).uploadsFrom).toBeUndefined();
    await expect(runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: "x.com'; system('id'); '" })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('rewrites the panel\'s own vhost with or without the redirect', async () => {
    const s = setup({}, () => ({ [`sudo -n ${DMP} vhost-write`]: { stdout: 'ok: vhost enabled' } }));
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8')}`);
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com' });
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: null });
    expect(lines(s.calls)).toEqual([
      `sudo -n ${DMP} vhost-write local.shop.com --uploads-proxy www.shop.com local.shop.de www.local.shop.com`,
      `sudo -n ${DMP} vhost-write local.shop.com local.shop.de www.local.shop.com`,
    ]);
  });

  it('loads them with BE Media from Production instead, clearing the redirect first, without Local mode', async () => {
    const s = setup({}, (docroot) => ({
      [`wp --path=${docroot} --url=https://local.shop.com/ plugin activate`]: { stdout: 'Plugin activated.' },
      [`wp --path=${docroot} --url=https://local.shop.com/ plugin deactivate`]: { stdout: 'Plugin deactivated.' },
    }));
    // Without the plugin in the site there is nothing to turn on, and nothing is downloaded.
    await expect(runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com', via: 'plugin' })).rejects.toThrow(/does not have be-media-from-production/);
    mkdirSync(join(s.docroot, 'wp-content/plugins/be-media-from-production'), { recursive: true });
    await runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', enabled: true });
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com' });
    const before = s.calls.length;
    expect((await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com', via: 'plugin' })).ok).toBe(true);
    expect(readLocalMode(s.docroot).uploadsFrom).toBeUndefined();
    expect(lines(s.calls.slice(before)).filter((l) => l.startsWith('wp '))).toEqual([
      `wp --path=${s.docroot} --url=https://local.shop.com/ config set BE_MEDIA_FROM_PRODUCTION_URL https://www.shop.com --type=constant`,
      `wp --path=${s.docroot} --url=https://local.shop.com/ plugin activate be-media-from-production --skip-plugins --skip-themes`,
    ]);
    // Back to the redirect: the plugin is turned off; and stopping the plugin only turns it off.
    const back = s.calls.length;
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com', via: 'redirect' });
    expect(readLocalMode(s.docroot).uploadsFrom).toBe('www.shop.com');
    expect(lines(s.calls.slice(back)).at(-1)).toBe(`wp --path=${s.docroot} --url=https://local.shop.com/ plugin deactivate be-media-from-production --skip-plugins --skip-themes`);
    const stop = s.calls.length;
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: null, via: 'plugin' });
    expect(lines(s.calls.slice(stop))).toEqual([`wp --path=${s.docroot} --url=https://local.shop.com/ plugin deactivate be-media-from-production --skip-plugins --skip-themes`]);
  });

  it('makes wp-content group-writable as the panel user when it is already in the web group', async () => {
    const s = setup();
    const content = join(s.docroot, 'wp-content');
    chmodSync(content, 0o755);
    const gid = statSync(content).gid;
    expect(unwritableByWeb(s.docroot, 'web', gid)).toEqual({ dirs: [''], fixable: true });
    chmodSync(content, 0o775);
    expect(unwritableByWeb(s.docroot, 'web', gid)).toEqual({ dirs: [], fixable: true });
    chmodSync(content, 0o755);
    expect(unwritableByWeb(s.docroot, 'web', gid + 1)).toEqual({ dirs: [''], fixable: false });
  });
});

describe('a site under a path', () => {
  /** local.shop.com's vhost also serves a WordPress install at /learn from its own folder. */
  function withLearn() {
    const s = setup({}, () => ({}));
    const learn = join(s.config.WEB_DIR, 'local.learn.shop.com');
    mkdirSync(join(learn, 'wp-content'), { recursive: true });
    writeFileSync(join(learn, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_learn');\n$table_prefix = 'wp_';\n");
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, readFileSync(vhost, 'utf8').replace('</VirtualHost>', ` Alias /learn ${learn}\n</VirtualHost>`));
    return { ...s, learn };
  }

  it('runs WP-CLI in its own folder with its own address', async () => {
    const s = withLearn();
    await runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com', path: '/learn' });
    expect(lines(s.calls)[0]).toBe(`wp --path=${s.learn} --url=https://local.shop.com/learn/ cache flush`);
  });

  it('turns Local mode on in its own folder, and gets missing uploads through Local mode', async () => {
    const s = withLearn();
    expect((await runAction(s.ctx, 'site.setLocalMode', { domain: 'local.shop.com', path: '/learn', enabled: true })).ok).toBe(true);
    expect(readLocalMode(s.learn).enabled).toBe(true);
    expect(readLocalMode(s.docroot).enabled).toBe(false);
    expect((await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', path: '/learn', host: 'www.shop.com' })).ok).toBe(true);
    expect(readLocalMode(s.learn).uploadsFrom).toBe('www.shop.com');
    expect(lines(s.calls).some((l) => l.includes('vhost-write'))).toBe(false);
  });

  it('keeps the sites under a path when the panel rewrites its vhost for the uploads rule', async () => {
    const s = withLearn();
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8')}`);
    await runAction(s.ctx, 'site.setUploadsFrom', { domain: 'local.shop.com', host: 'www.shop.com' });
    expect(lines(s.calls)).toContain(`sudo -n ${DMP} vhost-write local.shop.com --uploads-proxy www.shop.com --mount /learn=local.learn.shop.com local.shop.de www.local.shop.com`);
  });

  it('refuses a path the vhost does not serve, or one that is not a path', async () => {
    const s = withLearn();
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com', path: '/nope' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com', path: '/../etc' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.shop.com', path: 'learn' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('site.addAliases', () => {
  it("adds a network's hosts to the panel's own vhost with the names it has, then the cert and the hosts line", async () => {
    const s = setup({}, () => ({ [`sudo -n ${DMP} vhost-write`]: { stdout: 'ok: vhost enabled' }, [`sudo -n ${DMP} cert-reissue-from-vhost`]: { stdout: 'ok' }, [`sudo -n ${DMP} hosts-add`]: { stdout: 'ok' } }));
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8')}`);
    const r = await runAction(s.ctx, 'site.addAliases', { domain: 'local.shop.com', aliases: ['local.shop.fr', 'local.shop.de'] });
    expect(r.ok).toBe(true);
    expect(lines(s.calls)).toEqual([
      `sudo -n ${DMP} vhost-write local.shop.com local.shop.de www.local.shop.com local.shop.fr`,
      `sudo -n ${DMP} cert-reissue-from-vhost local.shop.com`,
      `sudo -n ${DMP} hosts-add local.shop.com local.shop.de www.local.shop.com local.shop.fr`,
      `sudo -n ${DMP} apache-reload`,
    ]);
    expect((await runAction(s.ctx, 'site.addAliases', { domain: 'local.shop.com', aliases: ['local.shop.de'] })).output).toBe('local.shop.com serves local.shop.de already');
  });

  it('leaves a vhost made by hand as it is, and refuses names that are not local', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.addAliases', { domain: 'local.shop.com', aliases: ['local.shop.fr'] })).rejects.toThrow('add ServerAlias local.shop.fr to it yourself');
    await expect(runAction(s.ctx, 'site.addAliases', { domain: 'local.shop.com', aliases: ['shop.fr'] })).rejects.toBeInstanceOf(ActionInputError);
    expect(lines(s.calls)).toEqual([]);
  });
});

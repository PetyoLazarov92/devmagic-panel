import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { repoKey } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { ActionBusyError, ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import type { Secrets } from '../src/secrets.js';
import { checkFreeSpace, cloneProgress } from '../src/sites/create.js';
import { readLocalMode } from '../src/sites/local-mode.js';
import { saveUpload } from '../src/sites/uploads.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree, type FakeResponse } from './helpers.js';

const WPCORE = '/usr/local/lib/devmagic-panel/bin/wpcore';
const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };
const DUMP = `CREATE TABLE \`wp_options\` (x int);\nINSERT INTO \`wp_options\` VALUES (1,'siteurl','https://www.new.com','yes'),(2,'home','https://www.new.com','yes'),(3,'db_version','61833','yes');\n`;

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

async function setup(overrides: Record<string, FakeResponse> | ((wpBase: string) => Record<string, FakeResponse>) = {}, dump = DUMP) {
  const t = wpSiteTree();
  const docroot = join(t.config.WEB_DIR, 'local.new.com');
  const wpBase = `wp --path=${docroot} --url=https://local.new.com/`;
  const fake = fakeExec({
    'mysql --batch --skip-column-names --user root --host localhost -e SHOW DATABASES': { stdout: 'information_schema\nnew_com\n' },
    [`sudo -n ${DMP} site-dir-create local.new.com`]: () => (mkdirSync(docroot), { stdout: 'ok' }),
    'git clone': (call) => {
      const into = call.args.at(-1) as string;
      mkdirSync(join(into, '.git'), { recursive: true });
      writeFileSync(join(into, 'wp-config-local-sample.php'), "<?php\ndefine( 'DB_NAME', 'x' );\n$table_prefix = 'wp_';\n/* That's all, stop editing! */\n");
      writeFileSync(join(into, 'composer.json'), '{}');
      return { stdout: 'Cloning...' };
    },
    [`sudo -n ${WPCORE} link local.new.com 7.1.3`]: { stdout: 'linked' },
    [`sudo -n ${DMP} cert-issue`]: { stdout: 'ok' },
    [`sudo -n ${DMP} vhost-write`]: { stdout: 'ok' },
    [`sudo -n ${DMP} hosts-add`]: { stdout: 'ok' },
    'mysql --user root --host localhost': { stdout: '' },
    [`${wpBase} config shuffle-salts`]: { stdout: 'Success' },
    [`${wpBase} db import`]: { stdout: 'Success: Imported' },
    [`${wpBase} search-replace`]: { stdout: 'Success: Made 12 replacements.' },
    // One table, so each pass is one call; groups of tables are tested on their own.
    [`${wpBase} db tables`]: { stdout: 'wp_options\n' },
    [`${wpBase} db query`]: (call) => {
      const sql = call.args.find((a) => a.startsWith('SELECT')) ?? '';
      if (sql.startsWith('SELECT TABLE_NAME')) return { stdout: 'wp_options\t1048576\nwp_posts\t52428800\n' };
      if (sql.startsWith('SELECT blog_id')) return { stdout: '1\tlocal.new.com\t/\n' };
      // Every site's home and siteurl, already on the local name.
      return { stdout: [...sql.matchAll(/SELECT (\d+), option_name/g)].map((m) => `${m[1]}\thome\thttps://local.new.com\n${m[1]}\tsiteurl\thttps://local.new.com\n`).join('') };
    },
    [`${wpBase} plugin list --status=active`]: { stdout: 'akismet\nwp-rocket\n' },
    [`${wpBase} plugin list --status=active-network`]: { stdout: '' },
    [`${wpBase} super-admin add`]: { stdout: 'Success: Granted super-admin.' },
    [`${wpBase} plugin deactivate`]: { stdout: 'Plugin deactivated.' },
    [`${wpBase} user get dev`]: { code: 1, stderr: 'Error: Invalid user' },
    [`${wpBase} user create dev`]: { stdout: 'Success: Created user 3.' },
    'composer install': { stdout: 'Generating autoload files' },
    'chmod -R g+w': { stdout: '' },
    [`${wpBase} cache flush`]: { stdout: 'Success' },
    [`${wpBase} rewrite flush`]: { stdout: 'Success' },
    [`sudo -n ${DMP} hosts-remove local.new.com`]: { stdout: 'ok' },
    [`sudo -n ${DMP} vhost-remove local.new.com`]: { stdout: 'ok' },
    [`sudo -n ${DMP} cert-remove local.new.com`]: { stdout: 'ok' },
    [`sudo -n ${DMP} site-dir-remove local.new.com`]: { stdout: 'ok' },
    ...(typeof overrides === 'function' ? overrides(wpBase) : overrides),
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const uploadsDir = join(t.root, 'uploads');
  const upload = await saveUpload(fake.exec, uploadsDir, 'new.sql', Readable.from([dump]));
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: WPCORE, wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir, secrets,
  };
  const input = {
    source: 'repo',
    domain: 'local.new.com',
    aliases: ['local.new.de'],
    repo: { url: 'git@github.com:AcmeCo/new-site.git', branch: 'master', layout: 'site-root' },
    uploadId: upload.id,
    replace: [{ from: 'www.new.com', to: 'local.new.com' }],
    core: { mode: 'wpcore', version: '7.1.3' },
    admin: { user: 'dev', email: 'dev@example.com' },
    deactivate: ['wp-rocket', 'wordfence'],
    uploadsFrom: 'www.new.com',
    build: { composer: true, npm: false },
  };
  return { ...t, docroot, ctx, jobs, store, calls: fake.calls, input, upload, uploadsDir };
}

const lines = (calls: Array<{ file: string; args: string[] }>) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('site.create from a repo', () => {
  it('adds the network settings and network .htaccess rules for a multisite dump', async () => {
    const network = `${DUMP}CREATE TABLE \`wp_blogs\` (x int);\nINSERT INTO \`wp_blogs\` VALUES (1,1,'www.new.com','/','x','x',1,0,0,0,0,0),(2,1,'www.new.com','/de/','x','x',1,0,0,0,0,0);\nINSERT INTO \`wp_site\` VALUES (1,'www.new.com','/');\n`;
    const s = await setup({}, network);
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', s.input)).data?.jobId ?? '');
    expect(view.steps.find((x) => x.id === 'config')?.output).toContain('added the subdirectory network settings');
    const config = readFileSync(join(s.docroot, 'wp-config.php'), 'utf8');
    for (const line of ["define( 'MULTISITE', true );", "define( 'SUBDOMAIN_INSTALL', false );", "define( 'DOMAIN_CURRENT_SITE', 'local.new.com' );", "define( 'PATH_CURRENT_SITE', '/' );", "define( 'SITE_ID_CURRENT_SITE', 1 );"]) {
      expect(config).toContain(line);
    }
    expect(readFileSync(join(s.docroot, '.htaccess'), 'utf8')).toContain('RewriteRule ^([_0-9a-zA-Z-]+/)?(wp-(content|admin|includes).*) $2 [L]');
  });

  it('moves the sites of a network to their own domains in the same passes as the replace, with https where the dump has http', async () => {
    const network = `${DUMP}CREATE TABLE \`wp_blogs\` (x int);\nINSERT INTO \`wp_blogs\` VALUES (1,1,'www.new.com','/','x','x',1,0,0,0,0,0),(2,1,'www.new.com','/de/','x','x',1,0,0,0,0,0),(3,1,'www.new.com','/shop/','x','x',1,0,0,0,0,0);\nINSERT INTO \`wp_site\` VALUES (1,'www.new.com','/');\nCREATE TABLE \`wp_2_posts\` (x int);\nINSERT INTO \`wp_2_posts\` VALUES (1,'<a href=\\"http://www.new.com/de/kontakt\\">');\n`;
    const s = await setup((wpBase) => ({
      [`${wpBase} db query`]: { stdout: '' },
      // The repo's own network settings, with new sites as subdomains and one cookie domain.
      'git clone': (call) => {
        const into = call.args.at(-1) as string;
        mkdirSync(join(into, '.git'), { recursive: true });
        writeFileSync(join(into, 'wp-config-local-sample.php'), "<?php\ndefine( 'DB_NAME', 'x' );\ndefine( 'MULTISITE', true );\ndefine( 'SUBDOMAIN_INSTALL', true );\ndefine( 'DOMAIN_CURRENT_SITE', 'www.new.com' );\ndefine( 'COOKIE_DOMAIN', 'www.new.com' );\n$table_prefix = 'wp_';\n/* That's all, stop editing! */\n");
        return { stdout: 'Cloning...' };
      },
    }), network);
    const input = { ...s.input, network: { layout: 'subdomain', sites: [{ id: 1, domain: 'local.new.com', path: '/' }, { id: 2, domain: 'local.new.de', path: '/' }, { id: 3, domain: 'local.new.com', path: '/shop/' }] } };
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', input)).data?.jobId ?? '');
    expect(view.status).toBe('done');
    const ids = view.steps.map((x) => x.id);
    // One step for the addresses: no separate move or https step.
    expect(ids.filter((id) => ['replace', 'network', 'https'].includes(id))).toEqual(['replace']);
    expect(view.steps.find((x) => x.id === 'replace')?.label).toBe('Replace 1 domain, move 1 site to subdomains and use https, 8 passes');
    const all = ' wp_options --all-tables --skip-columns=guid --report-changed-only --skip-plugins --skip-themes';
    const wp = lines(s.calls).filter((l) => l.includes(' search-replace ') || l.includes(' db query UPDATE'));
    expect(wp.map((l) => l.split(' --path=')[1]?.split(' ').slice(2).join(' '))).toEqual([
      // The site that moves first, its path with it, http made https in the same pass.
      `search-replace http://www.new.com/de/ https://local.new.de/${all}`,
      `search-replace http:\\/\\/www.new.com\\/de\\/ https:\\/\\/local.new.de\\/${all}`,
      `search-replace //www.new.com/de/ //local.new.de/${all}`,
      `search-replace \\/\\/www.new.com\\/de\\/ \\/\\/local.new.de\\/${all}`,
      `search-replace http://www.new.com https://local.new.com${all}`,
      `search-replace http:\\/\\/www.new.com https:\\/\\/local.new.com${all}`,
      `search-replace //www.new.com //local.new.com${all}`,
      `search-replace \\/\\/www.new.com \\/\\/local.new.com${all}`,
      'search-replace ^www\\.new\\.com$ local.new.com wp_blogs wp_site --regex --regex-flags=i --skip-plugins --skip-themes',
      'search-replace ^https?://local\\.new\\.com/de$ https://local.new.de wp_2_options --regex --regex-delimiter=# --report-changed-only --skip-plugins --skip-themes',
      "db query UPDATE `wp_blogs` SET domain = 'local.new.de', path = '/' WHERE blog_id = 2 --skip-plugins --skip-themes",
    ]);
    const config = readFileSync(join(s.docroot, 'wp-config.php'), 'utf8');
    // A subdomain network chosen here: new sites get subdomains, with the subdomain rules.
    expect(config).toContain("define( 'SUBDOMAIN_INSTALL', true );");
    expect(view.steps.find((x) => x.id === 'config')?.output).toContain('COOKIE_DOMAIN to www.new.com');
  });

  it('writes a subdirectory network for that choice even when the dump was a subdomain one', async () => {
    const network = `${DUMP}CREATE TABLE \`wp_blogs\` (x int);\nINSERT INTO \`wp_blogs\` VALUES (1,1,'www.new.com','/','x','x',1,0,0,0,0,0),(2,1,'shop.new.com','/','x','x',1,0,0,0,0,0);\nCREATE TABLE \`wp_sitemeta\` (x int);\nINSERT INTO \`wp_sitemeta\` VALUES (1,1,'subdomain_install','1');\n`;
    const s = await setup((wpBase) => ({ [`${wpBase} db query`]: { stdout: '' } }), network);
    const input = { ...s.input, replace: [...s.input.replace, { from: 'shop.new.com', to: 'local.shop.new.com' }], network: { layout: 'subdirectory', sites: [{ id: 1, domain: 'local.new.com', path: '/' }, { id: 2, domain: 'local.new.com', path: '/shop/' }] } };
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', input)).data?.jobId ?? '');
    expect(view.steps.find((x) => x.id === 'config')?.output).toContain('added the subdirectory network settings');
    expect(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8')).toContain("define( 'SUBDOMAIN_INSTALL', false );");
    expect(view.steps.find((x) => x.id === 'replace')?.label).toBe('Replace 2 domains and move 1 site to subdirectories, 6 passes');
    // The site's own address with its path goes before its host's, so it lands under the main domain.
    const passes = lines(s.calls).filter((l) => l.includes(' search-replace //')).map((l) => l.split(' search-replace ')[1]?.split(' --')[0]);
    expect(passes).toEqual(['//shop.new.com/ //local.new.com/shop/ wp_options', '//shop.new.com //local.shop.new.com wp_options', '//www.new.com //local.new.com wp_options']);
    expect(readFileSync(join(s.docroot, '.htaccess'), 'utf8')).toContain('RewriteRule ^([_0-9a-zA-Z-]+/)?(wp-(content|admin|includes).*) $2 [L]');
  });

  it('refuses a network site on a domain the site does not serve, and two sites at one address', async () => {
    const s = await setup();
    const net = (sites: Array<{ id: number; domain: string; path: string }>) => ({ ...s.input, network: { layout: 'subdomain', sites } });
    await expect(runAction(s.ctx, 'site.create', net([{ id: 2, domain: 'local.other.com', path: '/' }]))).rejects.toThrow("local.other.com is not one of this site's domains");
    await expect(runAction(s.ctx, 'site.create', net([{ id: 2, domain: 'local.new.de', path: '/' }, { id: 3, domain: 'local.new.de', path: '/' }]))).rejects.toThrow('same address');
    await expect(runAction(s.ctx, 'site.create', net([{ id: 2, domain: 'local.new.de', path: "/x'/" }]))).rejects.toThrow('A path like /shop/');
  });

  it('keeps an .htaccess the repo tracks, untouched and out of the local exclude list', async () => {
    const s = await setup({
      'git clone': (call) => {
        const into = call.args.at(-1) as string;
        mkdirSync(join(into, '.git', 'info'), { recursive: true });
        writeFileSync(join(into, '.htaccess'), '# from the repo\n');
        writeFileSync(join(into, 'wp-config-local-sample.php'), "<?php\n$table_prefix = 'wp_';\n");
        return { stdout: 'Cloning...' };
      },
    });
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', s.input)).data?.jobId ?? '');
    expect(view.steps.find((x) => x.id === 'htaccess')?.output).toContain('already exists, left as is');
    expect(readFileSync(join(s.docroot, '.htaccess'), 'utf8')).toBe('# from the repo\n');
  });

  it('lets a failed build be skipped, finishes the install, and keeps what is left to do on the site', async () => {
    const s = await setup({ 'composer install': { code: 127, stderr: 'spawn composer ENOENT' } });
    const id = (await runAction(s.ctx, 'site.create', s.input)).data?.jobId ?? '';
    const failed = await settle(s.jobs, id);
    expect(failed.status).toBe('failed');
    const build = failed.steps.find((x) => x.status === 'failed');
    expect(build).toMatchObject({ id: 'build', skippable: expect.stringContaining(`cd ${s.docroot} && composer install`) });
    // The steps the site needs, or that keep it safe, never offer to be skipped.
    expect(failed.steps.filter((x) => ['db', 'config', 'import', 'replace', 'local'].includes(x.id)).every((x) => !x.skippable)).toBe(true);

    s.jobs.skip(id);
    const done = await settle(s.jobs, id);
    expect(done.status).toBe('done');
    expect(done.steps.find((x) => x.id === 'local')?.status).toBe('done');
    expect(s.store.installs().get('local.new.com')?.skipped).toEqual([{ label: 'Run the build', todo: expect.stringContaining('composer install') }]);
  });

  it('writes nothing of its own into the repo and remembers the answers in the panel after a good install', async () => {
    const s = await setup();
    const result = await runAction(s.ctx, 'site.create', s.input);
    expect((await settle(s.jobs, result.data?.jobId ?? '')).status).toBe('done');
    expect(existsSync(join(s.docroot, '.devmagic.json'))).toBe(false);
    expect(s.store.preset(repoKey(s.input.repo.url) as string)).toMatchObject({
      layout: 'site-root',
      domains: [{ production: 'www.new.com', local: 'local.new.com' }, { local: 'local.new.de' }],
      deactivate: ['wp-rocket', 'wordfence'],
    });
  });

  it('remembers nothing when the install fails', async () => {
    const s = await setup({ 'mysql --user root --host localhost': { code: 1, stderr: 'ERROR 1007: database exists' } });
    const result = await runAction(s.ctx, 'site.create', s.input);
    expect((await settle(s.jobs, result.data?.jobId ?? '')).status).toBe('failed');
    expect(s.store.preset(repoKey(s.input.repo.url) as string)).toBeUndefined();
  });

  it("writes the local constants from Settings into wp-config.php, over the repo's own value", async () => {
    const s = await setup();
    s.store.setMeta('local-constants', JSON.stringify([{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }, { name: 'ACME_DEV', value: true }, { name: 'WP_MEMORY_LIMIT', value: '512M' }]));
    const result = await runAction(s.ctx, 'site.create', s.input);
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    const config = readFileSync(join(s.docroot, 'wp-config.php'), 'utf8');
    expect(config).toContain("define( 'ACME_DEV', true );");
    expect(config).toContain("define( 'WP_MEMORY_LIMIT', '512M' );");
    expect(view.steps.find((x) => x.id === 'config')?.output).toContain("set the local constants from Settings: WP_ENVIRONMENT_TYPE = 'local', ACME_DEV = true, WP_MEMORY_LIMIT = '512M'");
  });

  it('runs every step and leaves a configured site', async () => {
    const s = await setup();
    const result = await runAction(s.ctx, 'site.create', s.input);
    expect(result.ok).toBe(true);
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.steps.filter((x) => x.status !== 'done')).toEqual([]);
    expect(view.steps.map((x) => x.id)).toEqual(['space', 'folder', 'clone', 'content', 'core', 'cert', 'vhost', 'hosts', 'db', 'config', 'import', 'replace', 'check', 'plugins', 'admin', 'build', 'htaccess', 'local', 'flush']);

    const all = lines(s.calls);
    expect(all).toContain(`git clone --progress -c core.fileMode=false --branch master --single-branch -- git@github.com:AcmeCo/new-site.git ${s.docroot}/.dmp-clone`);
    expect(all).toContain(`sudo -n ${DMP} vhost-write local.new.com --uploads-proxy www.new.com local.new.de`);
    expect(all).toContain(`wp --path=${s.docroot} --url=https://local.new.com/ plugin deactivate wp-rocket --skip-plugins --skip-themes`);
    expect(all.filter((l) => l.includes(' search-replace //www.new.com //local.new.com '))).toHaveLength(1);

    // The repo landed in the site folder, next to the panel's own files.
    expect(existsSync(join(s.docroot, '.git'))).toBe(true);
    expect(existsSync(join(s.docroot, '.dmp-clone'))).toBe(false);

    // Database password: in wp-config.php and the SQL on stdin, never on a command line.
    const config = readFileSync(join(s.docroot, 'wp-config.php'), 'utf8');
    const password = /define\( 'DB_PASSWORD', '([^']+)' \)/.exec(config)?.[1] ?? '';
    expect(password.length).toBeGreaterThan(16);
    expect(config).toContain("define( 'DB_NAME', 'new_com_2' );");
    expect(config).toContain("define( 'WP_ENVIRONMENT_TYPE', 'local' );");
    expect(all.some((l) => l.includes(password) || l.includes('adminpw'))).toBe(false);
    const sqlRun = s.calls.filter((c) => c.file === 'mysql' && c.input).map((c) => c.input?.split(' ').slice(0, 2).join(' '));
    expect(sqlRun.slice(0, 3)).toEqual(['CREATE USER', 'CREATE DATABASE', 'GRANT ALL']);
    expect(s.calls.find((c) => c.input?.startsWith('CREATE USER'))?.input).toContain(password);
    expect(password).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[-_])[\w-]{24}$/);

    // The dump is removed once the site is in place.
    expect(existsSync(join(s.uploadsDir, s.upload.id))).toBe(false);
  });

  it('skips a database name whose MySQL user was left behind without its database', async () => {
    const s = await setup({ 'mysql --batch --skip-column-names --user root --host localhost -e SELECT DISTINCT User FROM mysql.user': { stdout: 'root\nnew_com_2\n' } });
    const result = await runAction(s.ctx, 'site.create', s.input);
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8')).toContain("define( 'DB_NAME', 'new_com_3' );");
    expect(s.calls.find((c) => c.input?.startsWith('CREATE USER'))?.input).toContain("'new_com_3'@'localhost'");
  });

  it('installs a site on nginx when asked, once nginx runs next to Apache with PHP-FPM', async () => {
    const s = await setup({ [`sudo -n ${DMP} nginx-site-write`]: { stdout: 'ok' } });
    await expect(runAction(s.ctx, 'site.create', { ...s.input, server: 'nginx' })).rejects.toThrow(/nginx is not set up/);
    s.write('nginx/conf.d/devmagic-panel.conf', '# Managed by devmagic-panel. Edits here are overwritten.\n');
    s.write('mods-enabled/php8.3.load');
    mkdirSync(join(s.config.PHP_LIB_DIR, '8.3/sapi'), { recursive: true });
    s.write('php-lib/8.3/sapi/fpm');
    const result = await runAction(s.ctx, 'site.create', { ...s.input, server: 'nginx' });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'vhost')?.label).toBe('Write the nginx site and reload');
    const all = lines(s.calls);
    expect(all).toContain(`sudo -n ${DMP} nginx-site-write local.new.com --kind single --uploads-proxy www.new.com local.new.de`);
    expect(all.some((l) => l.includes('vhost-write'))).toBe(false);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, path: '/learn', aliases: [], server: 'nginx' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('adds a core the shared folder lacks before linking it', async () => {
    const s = await setup({ [`sudo -n ${WPCORE} add 7.2.0`]: { stdout: 'added' }, [`sudo -n ${WPCORE} link local.new.com 7.2.0`]: { stdout: 'linked' } });
    const result = await runAction(s.ctx, 'site.create', { ...s.input, core: { mode: 'wpcore', version: '7.2.0' } });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    const ids = view.steps.map((x) => x.id);
    expect(ids.indexOf('addcore')).toBe(ids.indexOf('core') - 1);
    expect(s.calls.find((c) => c.args.includes('add'))?.input).toBe('n\n');
  });

  it('loads missing uploads with BE Media from Production instead of a redirect when asked', async () => {
    const s = await setup((wpBase) => ({
      [`${wpBase} plugin is-installed be-media-from-production`]: { stdout: '' },
      [`${wpBase} plugin activate be-media-from-production`]: { stdout: 'Plugin activated.' },
    }));
    const result = await runAction(s.ctx, 'site.create', { ...s.input, uploadsVia: 'plugin' });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    const all = lines(s.calls);
    expect(all).toContain(`sudo -n ${DMP} vhost-write local.new.com local.new.de`);
    expect(view.steps.find((x) => x.id === 'media')?.output).toContain("set BE_MEDIA_FROM_PRODUCTION_URL to https://www.new.com in wp-config.php");
    expect(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8')).toContain("define( 'BE_MEDIA_FROM_PRODUCTION_URL', 'https://www.new.com' );");
    expect(all).toContain(`wp --path=${s.docroot} --url=https://local.new.com/ plugin activate be-media-from-production --skip-plugins --skip-themes`);
  });

  it('refuses BE Media from Production without a repo or a host', async () => {
    const s = await setup();
    const { uploadsFrom: _drop, ...noHost } = s.input;
    await expect(runAction(s.ctx, 'site.create', { ...noHost, uploadsVia: 'plugin' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it.each([
    ['the password policy refuses the user', 'CREATE USER', 'ERROR 1819 (HY000) at line 1: Your password does not satisfy the current policy requirements', []],
    ['the database cannot be made', 'CREATE DATABASE', 'ERROR 1007: database exists', ['DROP USER']],
    ['the grant fails', 'GRANT', 'ERROR 1044: access denied', ['DROP DATABASE', 'DROP USER']],
  ])('drops only what the database step made when %s', async (_, failing, stderr, dropped) => {
    const s = await setup({ 'mysql --user root --host localhost': (call) => (call.input?.startsWith(failing) ? { code: 1, stderr } : {}) });
    const result = await runAction(s.ctx, 'site.create', s.input);
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.steps.find((x) => x.id === 'db')).toMatchObject({ status: 'failed' });
    const drops = s.calls.filter((c) => c.input?.includes('DROP ')).flatMap((c) => c.input?.split('\n') ?? []).map((l) => l.split(' ').slice(0, 2).join(' '));
    expect(drops).toEqual(dropped);
  });

  it('gives the admin your password on stdin only, and keeps it out of run history', async () => {
    const s = await setup();
    const password = 'my local pass';
    const result = await runAction(s.ctx, 'site.create', { ...s.input, admin: { ...s.input.admin, password } });
    expect((await settle(s.jobs, result.data?.jobId ?? '')).status).toBe('done');
    const create = s.calls.find((c) => c.args.includes('create') && c.args.includes('dev'));
    expect(create?.input).toBe(`${password}\n`);
    expect(lines(s.calls).some((l) => l.includes(password))).toBe(false);
    expect(JSON.stringify(s.store.recent())).not.toContain(password);
    expect(JSON.parse(s.store.recent()[0]?.input ?? '{}').admin.password).toBe('(hidden)');
  });

  it('sets your password on an admin user the dump already has', async () => {
    const t = await setup((wpBase) => ({
      [`${wpBase} user get dev`]: { stdout: '3\n' },
      [`${wpBase} user set-role`]: { stdout: 'Success' },
      [`${wpBase} user update`]: { stdout: 'Success: Updated user 3.' },
    }));
    const result = await runAction(t.ctx, 'site.create', { ...t.input, admin: { ...t.input.admin, password: 'p4ss' } });
    expect((await settle(t.jobs, result.data?.jobId ?? '')).status).toBe('done');
    const update = t.calls.find((c) => c.args.includes('update') && c.args.includes('dev'));
    expect(update?.args).toContain('--prompt=user_pass');
    expect(update?.input).toBe('p4ss\n');
  });

  it('turns on the local helpers the site has and skips one it lacks, without downloading anything', async () => {
    const s = await setup((wpBase) => ({
      [`${wpBase} plugin is-installed query-monitor`]: { code: 0 },
      [`${wpBase} plugin is-installed wp-crontrol`]: { code: 1 },
      [`${wpBase} plugin activate`]: { stdout: 'Plugin activated.' },
    }));
    const result = await runAction(s.ctx, 'site.create', { ...s.input, activate: ['query-monitor', 'wp-crontrol'] });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'helpers')?.output).toContain('wp-crontrol is not in this site, skipped');
    const all = lines(s.calls);
    expect(all.some((l) => l.includes(' plugin activate query-monitor '))).toBe(true);
    expect(all.some((l) => l.includes(' plugin install '))).toBe(false);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, activate: ['some-random-plugin'] })).rejects.toBeInstanceOf(ActionInputError);
  });

  it.each([
    ['keep', 'create', true, ['user get'], 'is in the database already; left as it is'],
    ['keep', 'create', false, ['user get', 'user create'], ''],
    ['update', 'skip', false, ['user get'], 'is not in the database; no user added'],
    ['update', 'create', true, ['user get', 'user set-role', 'user update'], ''],
  ] as const)('handles the admin user with ifExists %s and ifMissing %s (in the dump: %s)', async (ifExists, ifMissing, exists, commands, note) => {
    const s = await setup((wpBase) => ({
      [`${wpBase} user get admin`]: exists ? { stdout: '1' } : { code: 1, stderr: 'Error: Invalid user' },
      [`${wpBase} user create admin`]: { stdout: 'Success: Created user 3.' },
      [`${wpBase} user set-role admin`]: { stdout: 'Success' },
      [`${wpBase} user update admin`]: { stdout: 'Success: Updated user 1.' },
    }));
    const admin = { user: 'admin', email: 'admin@local.new.com', password: 'admin', ifExists, ifMissing };
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', { ...s.input, admin })).data?.jobId ?? '');
    expect(view.status).toBe('done');
    const userCalls = lines(s.calls).filter((l) => / user (get|create|set-role|update) /.test(l)).map((l) => /user \S+/.exec(l)?.[0]);
    expect(userCalls).toEqual(commands);
    if (note) expect(view.steps.find((x) => x.id === 'admin')?.output).toContain(note);
  });

  it('adds no admin step when the user is to be left as is and never created', async () => {
    const s = await setup();
    const admin = { user: 'admin', email: 'admin@local.new.com', password: 'admin', ifExists: 'keep' as const, ifMissing: 'skip' as const };
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', { ...s.input, admin })).data?.jobId ?? '');
    expect(view.steps.map((x) => x.id)).not.toContain('admin');
  });

  it('replaces an address with a port, like a copy from another local setup', async () => {
    const s = await setup({}, DUMP.replaceAll('https://www.new.com', 'http://localhost:8888'));
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', { ...s.input, replace: [{ from: 'localhost:8888', to: 'local.new.com' }] })).data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(lines(s.calls).some((l) => l.includes(' search-replace //localhost:8888 //local.new.com wp_options '))).toBe(true);
  });

  it('refuses a password with a line break', async () => {
    const s = await setup();
    await expect(runAction(s.ctx, 'site.create', { ...s.input, admin: { ...s.input.admin, password: 'a\nb' } })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('undoes what it made, newest first, after a failure', async () => {
    const s = await setup({ 'mysql --user root --host localhost': { code: 1, stderr: 'ERROR 1007: database exists' } });
    const result = await runAction(s.ctx, 'site.create', s.input);
    let view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.id).toBe('db');
    // A failed install keeps its dump for Retry; Undo drops it.
    expect(s.jobs.uploadsInUse().has(s.upload.id)).toBe(true);
    expect(existsSync(join(s.uploadsDir, s.upload.id))).toBe(true);

    s.jobs.undo(view.id);
    view = await settle(s.jobs, view.id);
    expect(view.status).toBe('undone');
    expect(lines(s.calls).filter((l) => /(hosts|vhost|cert|site-dir)-remove/.test(l))).toEqual([
      `sudo -n ${DMP} hosts-remove local.new.com`,
      `sudo -n ${DMP} vhost-remove local.new.com`,
      `sudo -n ${DMP} cert-remove local.new.com`,
      `sudo -n ${DMP} site-dir-remove local.new.com`,
    ]);
    expect(existsSync(join(s.uploadsDir, s.upload.id))).toBe(false);
    expect(s.jobs.uploadsInUse().size).toBe(0);
  });
});

describe('site.create refusals', () => {
  it('refuses domains and aliases another site uses, before anything runs', async () => {
    const s = await setup();
    const before = s.calls.length;
    await expect(runAction(s.ctx, 'site.create', { ...s.input, domain: 'local.shop.com' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, aliases: ['local.shop.de'] })).rejects.toBeInstanceOf(ActionInputError);
    expect(s.calls.length).toBe(before);
  });

  it('needs the MySQL account, a core without known security issues and the upload', async () => {
    const s = await setup();
    await expect(runAction({ ...s.ctx, secrets: null }, 'site.create', s.input)).rejects.toThrow(/MySQL admin account/);
    const status = async () => ({ '7.1.3': 'latest' as const, '5.0.1': 'insecure' as const });
    await expect(runAction({ ...s.ctx, coreStatus: status }, 'site.create', { ...s.input, core: { mode: 'wpcore', version: '5.0.1' } })).rejects.toThrow(/known security issues; add it on the WordPress page first/);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, uploadId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/upload it again/);
  });

  it('refuses a folder that already exists', async () => {
    const s = await setup();
    mkdirSync(s.docroot);
    await expect(runAction(s.ctx, 'site.create', s.input)).rejects.toThrow(/already exists/);
  });
});

describe('site.create progress and space', () => {
  it("turns git's progress lines into one bar", () => {
    expect(cloneProgress('Receiving objects:  40% (400/1000), 1.2 MiB\r')).toEqual({ fraction: 0.34, note: 'receiving objects, 40%' });
    expect(cloneProgress('Receiving objects: 100% (1000/1000)\rResolving deltas:  50% (5/10)\r')?.fraction).toBeCloseTo(0.925);
    expect(cloneProgress('Cloning into x...')).toBeUndefined();
  });

  it('adds up needs on the same disk and refuses before anything is made', () => {
    const disks: Record<string, { dev: number; bytes: number }> = { '/www': { dev: 1, bytes: 3 * 1024 ** 3 }, '/mysql': { dev: 1, bytes: 3 * 1024 ** 3 }, '/other': { dev: 2, bytes: 9 * 1024 ** 3 } };
    const free = (p: string) => disks[p] as { dev: number; bytes: number };
    expect(checkFreeSpace([{ path: '/www', bytes: 2 * 1024 ** 3, what: 'the clone' }], free).code).toBe(0);
    const short = checkFreeSpace([{ path: '/www', bytes: 2 * 1024 ** 3, what: 'the clone' }, { path: '/mysql', bytes: 2 * 1024 ** 3, what: 'the database import' }], free);
    expect(short).toMatchObject({ code: 1, stderr: 'Not enough free disk space for the clone and the database import: about 4.0 GB needed, 3.0 GB free' });
    expect(checkFreeSpace([{ path: '/www', bytes: 2 * 1024 ** 3, what: 'the clone' }, { path: '/other', bytes: 2 * 1024 ** 3, what: 'the import' }], free).code).toBe(0);
  });

  it('refuses another install of a site, and any action on it, while it is being installed', async () => {
    const s = await setup((wpBase) => ({ [`${wpBase} db import`]: () => new Promise(() => undefined) as never }));
    const result = await runAction(s.ctx, 'site.create', s.input);
    for (let i = 0; i < 200 && !s.jobs.activeFor('site.create', 'local.new.com'); i++) await new Promise((r) => setTimeout(r, 2));
    await expect(runAction(s.ctx, 'site.create', s.input)).rejects.toBeInstanceOf(ActionBusyError);
    await expect(runAction(s.ctx, 'site.clearCache', { domain: 'local.new.com' })).rejects.toThrow(/still being installed/);
    expect(s.jobs.get(result.data?.jobId ?? '')?.kind).toBe('site.create');
  });
});

describe('site.create under a path of an existing site', () => {
  /** A fresh WordPress at local.shop.com/learn; the shop's vhost is the panel's unless `byHand`. */
  async function under(byHand = false) {
    const t = wpSiteTree();
    const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    if (!byHand) writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8').replace('</VirtualHost>', ' RewriteRule ^/?(.*)$ https://www.shop.com/$1 [R=302,L]\n</VirtualHost>')}`);
    const learn = join(t.config.WEB_DIR, 'local.learn.shop.com');
    const wpBase = `wp --path=${learn} --url=https://local.shop.com/learn/`;
    const fake = fakeExec({
      'mysql --batch --skip-column-names --user root --host localhost -e SHOW DATABASES': { stdout: 'information_schema\nshop_com\n' },
      [`sudo -n ${DMP} site-dir-create local.learn.shop.com`]: () => (mkdirSync(learn), { stdout: 'ok' }),
      [`sudo -n ${WPCORE} link local.learn.shop.com 7.1.3`]: { stdout: 'linked' },
      [`sudo -n ${DMP} vhost-write`]: { stdout: 'ok' },
      'mysql --user root --host localhost': { stdout: '' },
      'chmod -R g+w': { stdout: '' },
      [`${wpBase} config create`]: (call) => (writeFileSync(join(learn, 'wp-config.php'), "<?php\ndefine( 'DB_NAME', 'x' );\n$table_prefix = 'wp_';\n"), { stdout: 'Success' }),
      [`${wpBase} config shuffle-salts`]: { stdout: 'Success' },
      [`${wpBase} core install`]: { stdout: 'Success: WordPress installed.' },
      [`${wpBase} theme list`]: { stdout: 'twentytwentyfive\n' },
      [`${wpBase} cache flush`]: { stdout: 'Success' },
      [`${wpBase} rewrite flush`]: { stdout: 'Success' },
    });
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const ctx: ActionContext = { config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: WPCORE, wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir: join(t.root, 'uploads'), secrets };
    const input = { source: 'wordpress', domain: 'local.shop.com', path: '/learn', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'admin', email: 'admin@local.shop.com', password: 'admin' }, uploadsFrom: 'www.shop.com' };
    return { ...t, learn, ctx, jobs, calls: fake.calls, input };
  }

  it('makes its own folder and database, adds an Alias to the panel vhost and keeps its other names and rule', async () => {
    const s = await under();
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', s.input)).data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.title).toBe('Create local.shop.com/learn');
    expect(view.steps.map((x) => x.id)).toEqual(['folder', 'content', 'core', 'mount', 'db', 'config', 'install', 'htaccess', 'local', 'flush']);
    const all = lines(s.calls);
    expect(all).toContain(`sudo -n ${DMP} vhost-write local.shop.com --uploads-proxy www.shop.com --mount /learn=local.learn.shop.com local.shop.de www.local.shop.com`);
    expect(all.some((l) => /cert-issue|hosts-add/.test(l))).toBe(false);
    expect(all.find((l) => l.includes(' core install '))).toContain('--url=https://local.shop.com/learn/');
    expect(s.calls.find((c) => c.input?.startsWith('CREATE DATABASE'))?.input).toContain('`learn_shop_com`');
    const htaccess = readFileSync(join(s.learn, '.htaccess'), 'utf8');
    expect(htaccess).toContain('RewriteBase /learn/');
    expect(htaccess).toContain('RewriteRule . /learn/index.php [L]');
    expect(readLocalMode(s.learn).uploadsFrom).toBe('www.shop.com');
  });

  it('leaves a vhost made by hand as it is and says which lines to add', async () => {
    const s = await under(true);
    const view = await settle(s.jobs, (await runAction(s.ctx, 'site.create', s.input)).data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'mount')?.output).toContain(`Alias /learn ${s.learn}`);
    expect(lines(s.calls).some((l) => l.includes('vhost-write'))).toBe(false);
  });

  it('refuses a parent that does not exist, a path already served, aliases and an empty site', async () => {
    const s = await under();
    await expect(runAction(s.ctx, 'site.create', { ...s.input, domain: 'local.nope.com' })).rejects.toThrow(/no site called local.nope.com/);
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    mkdirSync(join(s.config.WEB_DIR, 'other'));
    writeFileSync(vhost, readFileSync(vhost, 'utf8').replace('</VirtualHost>', ` Alias /learn ${s.config.WEB_DIR}/other\n</VirtualHost>`));
    await expect(runAction(s.ctx, 'site.create', s.input)).rejects.toThrow(/already served/);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, path: '/docs', aliases: ['local.docs.com'] })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'site.create', { ...s.input, path: '/docs', source: 'empty' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import type { Secrets } from '../src/secrets.js';
import { discoverSites, siteRegistryEntry } from '../src/sites/discover.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(options: { panelMade?: boolean; dbUser?: string } = {}) {
  const t = wpSiteTree();
  const panelMade = options.panelMade ?? true;
  if (panelMade) {
    const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8')}`);
    const st = statSync(t.docroot);
    mkdirSync(join(t.config.STATE_DIR, 'sites'), { recursive: true });
    writeFileSync(siteRegistryEntry(t.config, 'local.shop.com'), `${t.docroot}\n${st.dev}:${st.ino}\n`);
  }
  writeFileSync(join(t.docroot, 'wp-config.php'), `<?php\ndefine('DB_NAME', 'shop_com');\ndefine('DB_USER', '${options.dbUser ?? 'shop_com'}');\n`);
  const fake = fakeExec({
    [`wp --path=${t.docroot} --url=https://local.shop.com/ db export`]: (call) => (writeFileSync(call.args[4] as string, 'CREATE TABLE x;'), { stdout: 'Success: Exported.' }),
    [`sudo -n ${DMP}`]: { stdout: 'ok' },
    'mysql --user root --host localhost': { stdout: '' },
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets,
  };
  return { ...t, ctx, jobs, calls: fake.calls };
}

describe('site.remove', () => {
  it('exports the database, archives the site into the trash, removes it only then and drops the database last', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.map((x) => x.id)).toEqual(['backup', 'export', 'archive', 'remove', 'db']);
    const root = s.calls.filter((c) => c.file === 'sudo').map((c) => c.args.slice(2).join(' '));
    expect(root[0]).toBe('backup');
    expect(root[1]).toMatch(/^trash-site local\.shop\.com \d{8}-\d{6} shop_com shop_com deleted$/);
    expect(root[2]).toBe(`trash-remove local.shop.com ${root[1]?.split(' ')[2]}`);
    const drop = s.calls.find((c) => c.file === 'mysql')?.input ?? '';
    expect(drop).toContain('DROP DATABASE IF EXISTS `shop_com`;');
    expect(drop).toContain("DROP USER IF EXISTS 'shop_com'@'localhost'");

    // The export is named with the same stamp, so trash-site finds it and moves it into the archive.
    const backups = readdirSync(join(s.config.BACKUP_DIR, 'sites'));
    expect(backups).toEqual([`local.shop.com-${root[1]?.split(' ')[2]}.sql.gz`]);
    expect(gunzipSync(readFileSync(join(s.config.BACKUP_DIR, 'sites', backups[0] as string))).toString()).toBe('CREATE TABLE x;');
  });

  it('forgets the site\'s compatibility scans and their cache, its installs under a path too, and no other site\'s', async () => {
    const s = setup();
    const store = s.ctx.store;
    const cache = join(s.root, 'tools/php-compat/cache');
    for (const key of ['local.shop.com', 'local.shop.com@learn', 'local.shopping.com']) {
      store.saveCompatScan(key, '8.4', { version: '8.4' });
      mkdirSync(join(cache, key, '8.4'), { recursive: true });
    }
    const result = await runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    expect((await settle(s.jobs, result.data?.jobId ?? '')).status).toBe('done');
    expect(store.compatScans('local.shop.com')).toEqual([]);
    expect(store.compatScans('local.shop.com@learn')).toEqual([]);
    expect(store.compatScans('local.shopping.com')).toHaveLength(1);
    expect(readdirSync(cache)).toEqual(['local.shopping.com']);
  });

  it('never drops a shared account like root', async () => {
    const s = setup({ dbUser: 'root' });
    const result = await runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    await settle(s.jobs, result.data?.jobId ?? '');
    const drop = s.calls.find((c) => c.file === 'mysql')?.input ?? '';
    expect(drop).toContain('DROP DATABASE');
    expect(drop).not.toContain('DROP USER');
  });

  it('keeps a database another site still uses', async () => {
    const s = setup();
    const other = join(s.config.WEB_DIR, 'local.copy.com');
    mkdirSync(other);
    writeFileSync(join(other, 'wp-config.php'), "<?php define('DB_NAME', 'shop_com');");
    writeFileSync(join(s.config.APACHE_SITES_AVAILABLE, 'local.copy.com-ssl.conf'), `ServerName local.copy.com\nDocumentRoot ${other}\n`);
    symlinkSync(join(s.config.APACHE_SITES_AVAILABLE, 'local.copy.com-ssl.conf'), join(s.config.APACHE_SITES_ENABLED, 'local.copy.com-ssl.conf'));
    const result = await runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.steps.map((x) => x.id)).toEqual(['backup', 'archive', 'remove']);
    expect(s.calls.find((c) => c.args.includes('trash-site'))?.args.slice(-3)).toEqual(['-', '-', 'deleted']);
    expect(s.calls.some((c) => c.file === 'mysql')).toBe(false);
  });

  it('removes a site made outside the panel the same way, into the trash', async () => {
    const s = setup({ panelMade: false });
    const result = await runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' });
    expect((await settle(s.jobs, result.data?.jobId ?? '')).status).toBe('done');
    expect(s.calls.some((c) => c.args.includes('trash-remove'))).toBe(true);
  });

  it('refuses a site whose folder or vhost the trash cannot find by name, before anything runs', async () => {
    const s = setup({ panelMade: false });
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    renameSync(vhost, join(s.config.APACHE_SITES_AVAILABLE, 'shop.conf'));
    rmSync(join(s.config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
    symlinkSync(join(s.config.APACHE_SITES_AVAILABLE, 'shop.conf'), join(s.config.APACHE_SITES_ENABLED, 'shop.conf'));
    await expect(runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' })).rejects.toThrow(/remove it by hand/);
    expect(s.calls).toHaveLength(0);
  });

  it('needs the domain typed exactly', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('marks every site in the usual layout removable in discovery, and tells panel-made ones apart', async () => {
    const made = setup();
    const hand = setup({ panelMade: false });
    const [a] = await discoverSites({ config: made.config, exec: fakeExec().exec, secrets: null, wpcoreConf: made.wpcoreConf });
    const [b] = await discoverSites({ config: hand.config, exec: fakeExec().exec, secrets: null, wpcoreConf: hand.wpcoreConf });
    expect([a?.removable, a?.panelMade]).toEqual([true, true]);
    expect([b?.removable, b?.panelMade]).toEqual([true, false]);
  });

  it('is no longer panel-made when the folder was swapped after the panel made it', async () => {
    const made = setup();
    renameSync(made.docroot, `${made.docroot}.old`);
    mkdirSync(made.docroot);
    writeFileSync(join(made.docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\n");
    const [site] = await discoverSites({ config: made.config, exec: fakeExec().exec, secrets: null, wpcoreConf: made.wpcoreConf });
    expect(site?.panelMade).toBe(false);
  });
});

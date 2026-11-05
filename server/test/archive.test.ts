import { mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import type { Secrets } from '../src/secrets.js';
import { siteRegistryEntry } from '../src/sites/discover.js';
import { parseTrashList } from '../src/sites/trash.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };
const ID = 'local.shop.com-20261024-153000';

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

/**
 * local.shop.com installed by the panel from a repo, with an older copy of it
 * in the archive. dmp-root and MySQL answer as if all went well; trash-list
 * also lists the archives this test's trash-site calls made.
 */
function setup() {
  const t = wpSiteTree();
  const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
  writeFileSync(vhost, `${VHOST_MARKER}\n${readFileSync(vhost, 'utf8')}`);
  const st = statSync(t.docroot);
  mkdirSync(join(t.config.STATE_DIR, 'sites'), { recursive: true });
  writeFileSync(siteRegistryEntry(t.config, 'local.shop.com'), `${t.docroot}\n${st.dev}:${st.ino}\n`);
  writeFileSync(join(t.docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\ndefine('DB_USER', 'shop_com');\ndefine('DB_PASSWORD', 'pw');\n");
  const dump = join(t.config.BACKUP_DIR, 'sites', 'restore.sql.gz');
  const made: string[] = [];
  const fake = fakeExec({
    [`wp --path=${t.docroot} --url=https://local.shop.com/ db export`]: (call) => (writeFileSync(call.args[4] as string, 'CREATE TABLE x;'), { stdout: 'Success: Exported.' }),
    [`wp --path=${t.docroot} --url=https://local.shop.com/ db import`]: { stdout: 'Success: Imported' },
    [`sudo -n ${DMP}`]: { stdout: 'ok' },
    [`sudo -n ${DMP} trash-site`]: (call) => (made.push(`${call.args[3]}-${call.args[4]}`), { stdout: 'ok' }),
    [`sudo -n ${DMP} trash-list`]: () => ({
      stdout: [`${ID}\tlocal.shop.com\t1792857000\t1024\t1\tshop_com\tdeleted\t1`, ...made.map((id) => `${id}\tlocal.shop.com\t1792900000\t1024\t1\tshop_com\trestore\t1`)].join('\n'),
    }),
    [`sudo -n ${DMP} trash-restore`]: () => {
      mkdirSync(join(t.config.BACKUP_DIR, 'sites'), { recursive: true });
      writeFileSync(dump, gzipSync('CREATE TABLE x;'));
      return { stdout: `ok: restored\nDUMP=${dump}\n` };
    },
    'mysql --batch --skip-column-names --user root --host localhost -e SHOW DATABASES': { stdout: 'information_schema\nshop_com\n' },
    'mysql --user root --host localhost': { stdout: '' },
    gunzip: () => (writeFileSync(dump.replace(/\.gz$/, ''), 'CREATE TABLE x;'), { stdout: '' }),
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets,
  };
  return { ...t, ctx, jobs, store, calls: fake.calls, made };
}

describe('restore over an existing site', () => {
  it('is refused unless confirmed, then archives the current site first and restores the copy; Undo puts the current one back', async () => {
    const s = setup();
    s.store.setInstall('local.shop.com', undefined, { how: 'repo', repo: 'git@github.com:acme/shop-new.git', at: '2026-10-25T08:00:00Z' });
    s.store.setInstall('local.shop.com', '/learn', { how: 'wordpress', at: '2026-10-25T08:00:00Z' });

    await expect(runAction(s.ctx, 'trash.restore', { id: ID })).rejects.toThrow('local.shop.com exists again; confirm replacing it');
    expect(s.calls).toHaveLength(0);

    const result = await runAction(s.ctx, 'trash.restore', { id: ID, replaceCurrent: true });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    const ids = view.steps.map((x) => x.id);
    expect(ids.slice(0, 5)).toEqual(['archive-backup', 'archive-export', 'archive-archive', 'archive-remove', 'archive-db']);
    expect(ids.slice(5, 7)).toEqual(['files', 'db']);
    // The current site went to the archive as replaced by a restore, and its database was dropped before the copy's came back.
    const trashSite = s.calls.find((c) => c.args.includes('trash-site'));
    expect(trashSite?.args.at(-1)).toBe('restore');
    const sql = s.calls.filter((c) => c.file === 'mysql' && c.input).map((c) => c.input as string);
    expect(sql.findIndex((x) => x.includes('DROP DATABASE'))).toBeLessThan(sql.findIndex((x) => x.includes('CREATE DATABASE')));

    // How the current site was installed went to its archive; the restored one is marked restored.
    const archivedId = s.made[0] as string;
    expect(s.store.archivedInstall(archivedId)).toMatchObject({ how: 'repo', repo: 'git@github.com:acme/shop-new.git' });
    expect(s.store.installs().get('local.shop.com')).toMatchObject({ how: 'restore', archivedAt: '2026-10-24T15:30:00Z' });
    expect(s.store.installs().has('local.shop.com/learn')).toBe(false);

    expect(view.undoable).toContain('Put local.shop.com back from the archive');
    s.jobs.undo(view.id);
    expect((await settle(s.jobs, view.id)).status).toBe('undone');
    // The restored copy went back to the archive first, then the site from before came back.
    expect(s.made).toHaveLength(2);
    const order = s.calls.map((c) => c.args.join(' '));
    expect(order.findLastIndex((c) => c.includes(`trash-remove local.shop.com ${s.made[1]?.slice(-15)}`))).toBeLessThan(order.findIndex((c) => c.endsWith(`trash-restore ${archivedId}`)));
    expect(s.store.installs().get('local.shop.com')).toMatchObject({ how: 'repo' });
    expect(s.store.archivedInstall(archivedId)).toBeUndefined();
  });

  it('refuses to replace a site the archive cannot take, before anything runs', async () => {
    const s = setup();
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    renameSync(vhost, join(s.config.APACHE_SITES_AVAILABLE, 'shop.conf'));
    rmSync(join(s.config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));
    symlinkSync(join(s.config.APACHE_SITES_AVAILABLE, 'shop.conf'), join(s.config.APACHE_SITES_ENABLED, 'shop.conf'));
    await expect(runAction(s.ctx, 'trash.restore', { id: ID, replaceCurrent: true })).rejects.toThrow(/remove it by hand/);
    expect(s.calls.filter((c) => c.file === 'sudo' && !c.args.includes('trash-list'))).toHaveLength(0);
  });
});

describe('reinstall', () => {
  const input = { source: 'empty' as const, domain: 'local.shop.com', aliases: [], replace: [], deactivate: [], activate: [] };

  it('is refused while the site exists, unless the current one may go to the archive first', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.create', input)).rejects.toThrow('local.shop.com is already used by another site');
    const result = await runAction(s.ctx, 'site.create', { ...input, replaceExisting: true });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.steps.map((x) => x.id).slice(0, 5)).toEqual(['archive-backup', 'archive-export', 'archive-archive', 'archive-remove', 'archive-db']);
    expect(view.steps.slice(5).every((x) => !x.id.startsWith('archive-'))).toBe(true);
    expect(s.calls.find((c) => c.args.includes('trash-site'))?.args.at(-1)).toBe('reinstall');
    expect(view.status).toBe('done');
    expect(s.store.installs().get('local.shop.com')).toMatchObject({ how: 'empty' });
  });

  it('reuses the name of the database and user it replaces', async () => {
    const s = setup();
    const config = join(s.docroot, 'wp-config.php');
    writeFileSync(config, readFileSync(config, 'utf8').replace('<?php\n', "<?php\ndefine('DB_USER', 'shop_com');\n"));
    const fake = s.ctx.exec;
    s.ctx.exec = (file, args, options) =>
      [file, ...args].join(' ').endsWith('SELECT DISTINCT User FROM mysql.user') ? Promise.resolve({ code: 0, stdout: 'root\nshop_com\n', stderr: '' }) : fake(file, args, options);
    const result = await runAction(s.ctx, 'site.create', { ...input, source: 'wordpress', core: { mode: 'wpcore', version: '7.1.3' }, admin: { user: 'admin', email: 'admin@local.shop.com', password: 'admin' }, replaceExisting: true });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.steps.find((x) => x.id === 'db')?.label).toBe('Create database shop_com and its user');
  });

  it('never replaces a site under a path', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'site.create', { ...input, source: 'wordpress', path: '/learn', replaceExisting: true })).rejects.toThrow();
  });
});

describe('install records', () => {
  it('come from the run history once, for sites the panel made before it kept them', () => {
    const store = new RunStore(':memory:');
    const run = store.start('site.create', { source: 'repo', domain: 'local.shop.com', repo: { url: 'git@github.com:acme/shop.git' } });
    store.finish(run, 0, 'ok');
    const failed = store.start('site.create', { source: 'wordpress', domain: 'local.gone.com' });
    store.finish(failed, 1, 'no');
    const restore = store.start('trash.restore', { id: 'local.old.com-20261020-090000' });
    store.finish(restore, 0, 'ok');
    // A store opened again on the same rows backfills; here the same object runs it through a fresh instance of the logic.
    (store as unknown as { backfillInstalls: () => void }).backfillInstalls();
    expect(store.installs().size).toBe(0);
    (store as unknown as { db: { exec: (s: string) => void } }).db.exec("DELETE FROM meta WHERE key = 'installs-backfilled'");
    (store as unknown as { backfillInstalls: () => void }).backfillInstalls();
    expect(Object.fromEntries(store.installs())).toEqual({
      'local.shop.com': expect.objectContaining({ how: 'repo', repo: 'git@github.com:acme/shop.git' }),
      'local.old.com': expect.objectContaining({ how: 'restore' }),
    });
  });

  it('move to the archive with the site, sites under its path included', () => {
    const store = new RunStore(':memory:');
    store.setInstall('local.shop.com', undefined, { how: 'repo' });
    store.setInstall('local.shop.com', '/learn', { how: 'wordpress' });
    store.setInstall('local.shop.community', undefined, { how: 'empty' });
    store.archiveInstall('local.shop.com', ID);
    expect([...store.installs().keys()]).toEqual(['local.shop.community']);
    expect(store.archivedInstall(ID)).toEqual({ how: 'repo' });
    store.forgetArchive(ID);
    expect(store.archivedInstall(ID)).toBeUndefined();
  });
});

describe('the archive list', () => {
  it('reads why each site went there and whether it holds the database, also from an older dmp-root', () => {
    const list = parseTrashList(`${ID}\tlocal.shop.com\t1792857000\t1024\t1\tshop_com\treinstall\t1\nlocal.old.com-20261020-090000\tlocal.old.com\t1792490000\t1024\t0\told_com\n`);
    expect(list.map((e) => [e.domain, e.reason, e.hasDump])).toEqual([
      ['local.shop.com', 'reinstall', true],
      ['local.old.com', 'deleted', true],
    ]);
  });
});

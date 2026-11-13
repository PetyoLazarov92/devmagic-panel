import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, fakeMysql, wpSiteTree } from './helpers.js';

const UPLOAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const USED = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function setup(admin = true) {
  const t = wpSiteTree();
  const server = fakeMysql({ shop_com__keep261112090000: { wp_options: 'old' } });
  const fake = fakeExec({ mysql: (call) => server.run(call) });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const uploadsDir = join(t.root, 'data', 'uploads');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir,
    secrets: admin ? { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } } : { panelPasswordHash: 'x' },
    drafts: { uploadsInUse: () => new Set([USED]) } as unknown as NonNullable<ActionContext['drafts']>,
  };
  return { t, ctx, store, server, uploadsDir, dataDir: dirname(uploadsDir) };
}
const clean = (ctx: ActionContext, kind: string) => runAction(ctx, 'storage.clean', { kind, confirm: 'clean' });

describe('Clean up now on the Sanctum page', () => {
  it('needs the confirmation and a kind it knows', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'storage.clean', { kind: 'snapshots' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'storage.clean', { kind: 'clean-copies', confirm: 'clean' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('removes every snapshot the panel took before a change, new ones too, and leaves the ones you took', async () => {
    const s = setup();
    const dir = join(s.t.config.BACKUP_DIR, 'snapshots', 'local.shop.com');
    mkdirSync(dir, { recursive: true });
    for (const name of ['20261113-080000-before-import.sql.gz', '20261113-090000-before-updates.sql.gz', '20261113-100000.sql.gz', '20261113-110000-launch.sql.gz']) writeFileSync(join(dir, name), 'x');
    expect((await clean(s.ctx, 'snapshots')).output).toContain('removed 2 automatic snapshots');
    expect(readdirSync(dir).sort()).toEqual(['20261113-100000.sql.gz', '20261113-110000-launch.sql.gz']);
  });

  it('removes every downloaded dump but one a draft uses, every Files tab delete and every MySQL settings backup, however new', async () => {
    const s = setup();
    for (const id of [UPLOAD, USED]) mkdirSync(join(s.uploadsDir, id), { recursive: true });
    const trash = join(s.dataDir, 'file-trash', '20261113-080000-a1b2c3');
    mkdirSync(trash, { recursive: true });
    const backups = join(s.dataDir, 'mysql-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'my.cnf-20261113'), 'x');
    expect((await clean(s.ctx, 'downloads')).output).toContain('removed 1 downloaded dump; 1 dump a job or a draft uses stay');
    expect(readdirSync(s.uploadsDir)).toEqual([USED]);
    expect((await clean(s.ctx, 'file-trash')).output).toContain('removed 1 Files tab delete');
    expect(existsSync(trash)).toBe(false);
    expect((await clean(s.ctx, 'mysql-backups')).output).toContain('removed 1 MySQL settings backup');
    expect(readdirSync(backups)).toEqual([]);
  });

  it('drops every kept database now, however young, and says it needs the admin account', async () => {
    const s = setup();
    s.store.addKeptDatabase({ name: 'shop_com__keep261112090000', site: 'local.shop.com', db: 'shop_com', reason: 'young', createdAt: new Date().toISOString() });
    expect((await clean(s.ctx, 'kept')).output).toContain('dropped shop_com__keep261112090000');
    expect(s.store.keptDatabases()).toEqual([]);
    expect(Object.keys(s.server.state())).toEqual([]);
    const without = setup(false);
    without.store.addKeptDatabase({ name: 'shop_com__keep261112090000', site: 'local.shop.com', db: 'shop_com', reason: 'young', createdAt: new Date().toISOString() });
    const refused = await clean(without.ctx, 'kept');
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain('no MySQL admin account');
  });

  it('deletes every finished run', async () => {
    const s = setup();
    const id = s.store.start('db.snapshot', { domain: 'local.shop.com' });
    s.store.finish(id, 0, 'ok');
    expect((await clean(s.ctx, 'runs')).output).toMatch(/deleted \d+ finished run/);
  });
});

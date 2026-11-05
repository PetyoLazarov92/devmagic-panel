import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { listKept, purgeKept } from '../src/sites/kept.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, fakeMysql, wpSiteTree } from './helpers.js';

const KEPT = 'shop_com__keep261020090500';
const CREATED = '2026-10-20T09:05:00.000Z';
/** A site after a clean copy: the dump's tables in, one it added, one the site had that stayed; the old tables kept. */
const AFTER_CLEAN = {
  shop_com: { wp_options: 'dump', wp_posts: 'dump', wp_users: 'emptied', wp_wc_orders: 'dump', wp_local_notes: 'old' },
  [KEPT]: { wp_options: 'old', wp_posts: 'old', wp_users: 'old' },
};
const BEFORE = ['wp_local_notes', 'wp_options', 'wp_posts', 'wp_users'];

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id);
    if (view && !['running', 'queued'].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

function setup(start: Record<string, Record<string, string>> = AFTER_CLEAN, admin = true) {
  const t = wpSiteTree();
  const server = fakeMysql(start);
  const wp = `wp --path=${t.docroot} --url=https://local.shop.com/`;
  const fake = fakeExec({ mysql: (call) => server.run(call), [`${wp} cache flush`]: { stdout: 'Success' }, [`${wp} rewrite flush`]: { stdout: 'Success' } });
  const store = new RunStore(':memory:');
  store.addKeptDatabase({ name: KEPT, site: 'local.shop.com', db: 'shop_com', reason: 'before shop.sql from production', createdAt: CREATED, before: BEFORE });
  const jobs = new Jobs(store);
  const mysql = { user: 'root', host: 'localhost', password: 'adminpw' };
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir: join(t.root, 'uploads'),
    secrets: admin ? { panelPasswordHash: 'x', mysql } : { panelPasswordHash: 'x' },
  };
  const restore = async (name: string) => settle(jobs, (await runAction(ctx, 'db.restoreKept', { domain: 'local.shop.com', name, confirm: 'local.shop.com' })).data?.jobId as string);
  return { ctx, store, server, exec: fake.exec, mysql, restore };
}

describe('kept databases', () => {
  it('lists a site\'s with their size and the day they go, and forgets one dropped by hand', async () => {
    const s = setup();
    s.store.addKeptDatabase({ name: 'shop_com__keep261021090500', site: 'local.shop.com', db: 'shop_com', reason: 'gone', createdAt: '2026-10-21T09:05:00.000Z' });
    s.store.addKeptDatabase({ name: 'other_com__keep261021090500', site: 'local.other.com', db: 'other_com', reason: 'not this site', createdAt: CREATED });
    expect(await listKept(s.store, s.exec, s.mysql, 'local.shop.com')).toEqual([
      { name: KEPT, reason: 'before shop.sql from production', createdAt: CREATED, purgeAt: '2026-10-27T09:05:00.000Z', sizeBytes: 3 * 1024 ** 2 },
    ]);
    expect(s.store.keptDatabases('local.shop.com').map((k) => k.name)).toEqual([KEPT]);
    // Without the admin account: listed, without a size.
    expect(await listKept(s.store, s.exec, null, 'local.shop.com')).toEqual([expect.not.objectContaining({ sizeBytes: expect.anything() })]);
  });

  it('puts back the tables from before, takes out the ones the swap brought in, and keeps those the same way', async () => {
    const s = setup();
    const view = await s.restore(KEPT);
    expect(view.status).toBe('done');
    const state = s.server.state();
    const out = Object.keys(state).find((db) => db !== 'shop_com') as string;
    expect(out).toMatch(/^shop_com__keep\d{12}$/);
    // As it was before the clean copy: wp_wc_orders, which the dump brought, went out too; wp_local_notes never moved.
    expect(state.shop_com).toEqual({ wp_local_notes: 'old', wp_options: 'old', wp_posts: 'old', wp_users: 'old' });
    expect(state[out]).toEqual({ wp_options: 'dump', wp_posts: 'dump', wp_users: 'emptied', wp_wc_orders: 'dump' });
    expect(state[KEPT]).toBeUndefined();
    expect(view.steps[0]?.output).toBe(`shop_com has its 3 tables from 2026-10-20 09:05 back; the 4 it had are kept in ${out} for 7 days`);
    const records = s.store.keptDatabases('local.shop.com');
    expect(records).toEqual([expect.objectContaining({ name: out, reason: 'before putting back the tables kept on 2026-10-20 09:05', before: ['wp_local_notes', 'wp_options', 'wp_posts', 'wp_users', 'wp_wc_orders'] })]);

    // And that can be put back too: the clean copy again.
    expect((await s.restore(out)).status).toBe('done');
    const again = s.server.state();
    expect(again.shop_com).toEqual(AFTER_CLEAN.shop_com);
  });

  it('drops one on request, only one the panel kept for this site', async () => {
    const s = setup();
    await runAction(s.ctx, 'db.deleteKept', { domain: 'local.shop.com', name: KEPT });
    expect(s.server.state()[KEPT]).toBeUndefined();
    expect(s.store.keptDatabases()).toEqual([]);
    await expect(runAction(s.ctx, 'db.deleteKept', { domain: 'local.shop.com', name: 'shop_com__keep261021090500' })).rejects.toThrow(/has no kept database called/);
    await expect(runAction(s.ctx, 'db.deleteKept', { domain: 'local.shop.com', name: 'shop_com' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('needs the typed domain to put one back, and the admin account', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'db.restoreKept', { domain: 'local.shop.com', name: KEPT, confirm: 'nope' })).rejects.toBeInstanceOf(ActionInputError);
    const without = setup(AFTER_CLEAN, false);
    await expect(runAction(without.ctx, 'db.restoreKept', { domain: 'local.shop.com', name: KEPT, confirm: 'local.shop.com' })).rejects.toThrow(/needs the MySQL admin account/);
  });

  it('are purged after 7 days, except a site\'s a job is working on, and only names the panel made', async () => {
    const s = setup({ ...AFTER_CLEAN, shop_com__keep261027090000: { wp_options: 'old' }, other_com__keep261019090000: { wp_options: 'old' } });
    s.store.addKeptDatabase({ name: 'shop_com__keep261027090000', site: 'local.shop.com', db: 'shop_com', reason: 'young', createdAt: '2026-10-27T09:00:00.000Z' });
    s.store.addKeptDatabase({ name: 'other_com__keep261019090000', site: 'local.other.com', db: 'other_com', reason: 'busy', createdAt: '2026-10-19T09:00:00.000Z' });
    s.store.addKeptDatabase({ name: 'shop_com', site: 'local.shop.com', db: 'shop_com', reason: 'not a kept name', createdAt: '2026-10-01T09:00:00.000Z' });
    const now = new Date('2026-10-28T10:00:00.000Z').getTime();
    const dropped = await purgeKept(s.store, s.exec, s.mysql, (site) => site === 'local.other.com', now);
    expect(dropped).toEqual([KEPT]);
    expect(Object.keys(s.server.state()).sort()).toEqual(['other_com__keep261019090000', 'shop_com', 'shop_com__keep261027090000']);
    expect(await purgeKept(s.store, s.exec, null, () => false, now)).toEqual([]);
  });
});

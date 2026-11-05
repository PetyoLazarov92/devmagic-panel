import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { cleanPreview } from '../src/sites/clean-current.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, fakeMysql, wpSiteTree } from './helpers.js';

/** A site after a production import: its own tables, with private data still in them. */
const IMPORTED = { shop_com: { wp_options: 'prod', wp_posts: 'prod', wp_users: 'prod', wp_usermeta: 'prod', wp_wc_orders: 'prod', wp_gf_entry: 'prod' } };

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id);
    if (view && !['running', 'queued', 'undoing'].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

function setup(server: ReturnType<typeof fakeMysql>, admin = true) {
  const t = wpSiteTree();
  const wp = `wp --path=${t.docroot} --url=https://local.shop.com/`;
  const fake = fakeExec({
    mysql: (call) => server.run(call),
    [`${wp} db query DELETE`]: { stdout: '' },
    [`${wp} plugin list --status=active`]: { stdout: 'akismet\nwp-mail-smtp\n' },
    [`${wp} plugin deactivate`]: { stdout: 'Success: Deactivated 1 of 1 plugins.' },
    [`${wp} user create`]: { stdout: 'Success: Created user 12.' },
    [`${wp} user update`]: { stdout: 'Success: Updated user 7.' },
    [`${wp} user get admin --field=ID`]: { stdout: '7\n' },
    [`${wp} cache flush`]: { stdout: 'Success' },
    [`${wp} rewrite flush`]: { stdout: 'Success' },
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir: join(t.root, 'uploads'),
    secrets: admin ? { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } } : { panelPasswordHash: 'x' },
  };
  const clean = async (user?: Record<string, string>) => {
    const result = await runAction(ctx, 'db.cleanCurrent', { domain: 'local.shop.com', confirm: 'local.shop.com', ...(user ? { user } : {}) });
    return settle(jobs, result.data?.jobId as string);
  };
  return { ctx, store, calls: fake.calls, clean };
}

describe('cleaning the database a site has now', () => {
  it('copies it beside the site, cleans the copy, swaps it in and keeps the tables from before for 7 days', async () => {
    const server = fakeMysql(IMPORTED);
    const s = setup(server);
    const view = await s.clean({ keep: 'admin', password: 'local-pass' });
    expect(view.steps.filter((x) => x.status === 'failed').map((x) => `${x.id}: ${x.output}`)).toEqual([]);
    expect(view.steps.map((x) => x.id)).toEqual(['copy', 'clean', 'swap', 'plugins', 'admin', 'flush']);
    const state = server.state();
    const kept = Object.keys(state).find((db) => /^shop_com__keep\d{12}$/.test(db)) as string;
    expect(state.shop_com).toEqual({ wp_gf_entry: 'emptied', wp_options: 'prod', wp_posts: 'prod', wp_usermeta: 'kept one', wp_users: 'kept one', wp_wc_orders: 'emptied' });
    expect(state[kept]).toEqual(IMPORTED.shop_com);
    expect(state.shop_com__import).toBeUndefined();
    // Cleaned in the copy, before the swap: the site never had a half-cleaned database.
    const swapAt = server.statements.findIndex((x) => x.startsWith('RENAME TABLE'));
    expect(server.statements.findIndex((x) => x === 'TRUNCATE TABLE `wp_wc_orders`;')).toBeLessThan(swapAt);
    expect(server.statements).toContain('INSERT INTO `shop_com__import`.`wp_posts` SELECT * FROM `shop_com`.`wp_posts`;');
    // The tables the clean-up empties are made without their rows; its report still counts what went.
    expect(server.statements).toContain('CREATE TABLE `shop_com__import`.`wp_wc_orders` LIKE `shop_com`.`wp_wc_orders`;');
    expect(server.statements.some((x) => x.startsWith('INSERT INTO `shop_com__import`.`wp_wc_orders`') || x.startsWith('INSERT INTO `shop_com__import`.`wp_gf_entry`'))).toBe(false);
    expect(view.steps[0]?.output).toContain('2 tables the clean empties, like logs, are made without their rows (2 MB not copied)');
    expect(view.steps[1]?.output).toContain('wp_wc_orders emptied: about 100 rows');
    expect(server.statements).toContain('SET sql_log_bin = 0;');
    expect(s.store.keptDatabases('local.shop.com')).toEqual([expect.objectContaining({ name: kept, reason: 'before cleaning it' })]);
    // No address is replaced: the database is already this site's.
    expect(s.calls.some((c) => c.args.includes('search-replace'))).toBe(false);
    const update = s.calls.find((c) => c.args.includes('update'));
    expect(update?.input).toBe('local-pass\n');
    expect(view.undoable).toEqual([]);
  });

  it('makes a new admin when asked, the author of every post', async () => {
    const server = fakeMysql(IMPORTED);
    const s = setup(server);
    const view = await s.clean();
    expect(view.status).toBe('done');
    expect(server.state().shop_com?.wp_users).toBe('emptied');
    expect(s.calls.find((c) => c.args.includes('create'))?.args).toEqual(expect.arrayContaining(['admin', 'admin@local.shop.com', '--role=administrator']));
  });

  it('leaves views where they are: only tables are copied and swapped', async () => {
    const server = fakeMysql(IMPORTED, { views: 4 });
    const view = await setup(server).clean();
    expect(view.status).toBe('done');
    expect(view.steps[0]?.output).toContain('4 views stay in shop_com and read the clean tables after the swap');
    expect(server.statements.some((x) => x.startsWith('CREATE VIEW') || x.includes('DROP VIEW'))).toBe(false);
  });

  it('stops before anything changes for a database with triggers or generated columns', async () => {
    for (const [option, why] of [['triggers', 'has triggers'], ['generated', 'has generated columns']] as const) {
      const server = fakeMysql(IMPORTED, { [option]: 1 });
      const view = await setup(server).clean();
      expect(view.steps.find((x) => x.status === 'failed')?.output).toContain(`cannot clean shop_com this way: shop_com ${why}`);
      expect(server.state()).toEqual(IMPORTED);
    }
  });

  it('needs the typed domain and the admin account', async () => {
    const s = setup(fakeMysql(IMPORTED));
    await expect(runAction(s.ctx, 'db.cleanCurrent', { domain: 'local.shop.com', confirm: 'local.other.com' })).rejects.toBeInstanceOf(ActionInputError);
    const without = setup(fakeMysql(IMPORTED), false);
    await expect(runAction(without.ctx, 'db.cleanCurrent', { domain: 'local.shop.com', confirm: 'local.shop.com' })).rejects.toThrow(/needs the MySQL admin account/);
  });
});

describe('what the card reads first', () => {
  it('lists the tables, the administrators and the size, or why it cannot clean', async () => {
    const s = setup(fakeMysql(IMPORTED, { admins: ['admin', 'alex'] }));
    expect(await cleanPreview(s.ctx, 'local.shop.com', undefined)).toEqual({
      tables: ['wp_options', 'wp_posts', 'wp_users', 'wp_usermeta', 'wp_wc_orders', 'wp_gf_entry'],
      prefix: 'wp_', multisite: false, admins: ['admin', 'alex'], sizeBytes: 6 * 1024 ** 2, leftOutBytes: 2 * 1024 ** 2,
    });
    // Fresh from MySQL 8, not its day-old cache: a table emptied since counts as empty.
    const asked = s.calls.flatMap((c) => c.args).filter((a) => a.includes('information_schema.TABLES'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.startsWith('SET SESSION information_schema_stats_expiry = 0; '))).toBe(true);
    const blocked = setup(fakeMysql(IMPORTED, { triggers: 2 }));
    expect((await cleanPreview(blocked.ctx, 'local.shop.com', undefined)).blocked).toBe('Cannot clean it this way: shop_com has triggers, which cannot move between databases.');
    const without = setup(fakeMysql(IMPORTED), false);
    expect((await cleanPreview(without.ctx, 'local.shop.com', undefined)).blocked).toMatch(/^Needs the MySQL admin account/);
  });
});

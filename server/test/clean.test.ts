import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { cleanupPlan, runCleanup } from '../src/sites/clean.js';
import { SWAP_UNDO } from '../src/sites/swap.js';
import { saveUpload } from '../src/sites/uploads.js';
import { RunStore } from '../src/store.js';
import type { FakeResponse } from './helpers.js';
import { DMP, fakeExec, fakeMysql, wpSiteTree } from './helpers.js';

const tables = (...names: string[]) => names.map((name) => ({ name, rows: 1000 }));
const sqlOf = (groups: ReturnType<typeof cleanupPlan>) => Object.fromEntries(groups.map((g) => [g.id, g.statements.join('\n')]));

describe('the cleanup statements', () => {
  const shop = tables(
    'wp_users', 'wp_usermeta', 'wp_options', 'wp_posts', 'wp_postmeta', 'wp_comments', 'wp_commentmeta', 'wp_wc_orders', 'wp_wc_orders_meta',
    'wp_woocommerce_order_items', 'wp_woocommerce_sessions', 'wp_wcpdf_invoice_number', 'wp_gf_entry', 'wp_gf_entry_meta', 'wp_wfHits', 'wp_actionscheduler_logs',
    'wp_ualp_user_activity', 'wp_uap_action_log_meta', 'wp_uap_tokens_log', 'wp_uap_action_logs_view',
  );

  it("empties the tables that only hold private data, for the tables the dump has, Wordfence's capitals included", () => {
    const sql = sqlOf(cleanupPlan(shop, 'wp_', 'admin@local.wandworks.example'));
    expect(sql.users).toContain('TRUNCATE TABLE `wp_users`;');
    expect(sql.users).toContain('TRUNCATE TABLE `wp_usermeta`;');
    expect(sql.users).not.toContain('dmp_keep_user');
    expect(sql.woocommerce).toContain('TRUNCATE TABLE `wp_wc_orders`;');
    expect(sql.woocommerce).toContain('TRUNCATE TABLE `wp_wcpdf_invoice_number`;');
    expect(sql.woocommerce).not.toContain('wp_wc_order_stats');
    expect(sql.forms).toContain('TRUNCATE TABLE `wp_gf_entry_meta`;');
    expect(sql.forms).not.toContain('wpforms');
    expect(sql.logs).toContain('TRUNCATE TABLE `wp_wfHits`;');
    expect(sql.logs).toContain('TRUNCATE TABLE `wp_actionscheduler_logs`;');
    expect(sql.logs).toContain('TRUNCATE TABLE `wp_ualp_user_activity`;');
    expect(sql.logs).toContain('TRUNCATE TABLE `wp_uap_action_log_meta`;');
    expect(sql.logs).toContain('TRUNCATE TABLE `wp_uap_tokens_log`;');
    expect(sql.logs).not.toContain('wp_uap_action_logs_view');
  });

  it('keeps the counter past the ids that went, so no new user takes the id comments still name', () => {
    const sql = sqlOf(cleanupPlan(shop, 'wp_', 'admin@local.wandworks.example'));
    const users = sql.users as string;
    expect(users.indexOf('SELECT COALESCE(MAX(ID), 0) + 1 INTO @dmp_next_id FROM `wp_users`;')).toBeLessThan(users.indexOf('TRUNCATE TABLE `wp_users`;'));
    expect(users).toContain("SET @dmp_ai = CONCAT('ALTER TABLE `wp_users` AUTO_INCREMENT = ', @dmp_next_id);");
    expect(users.indexOf('EXECUTE dmp_ai;')).toBeGreaterThan(users.indexOf('TRUNCATE TABLE `wp_users`;'));
  });

  it('keeps one administrator with its meta, at the local admin address, and every other user goes', () => {
    const users = sqlOf(cleanupPlan(shop, 'wp_', 'admin@local.wandworks.example', 'alex'));
    expect((users.users as string).split('\n').filter((l) => !l.startsWith('SELECT \'')).slice(0, 7)).toEqual([
      'SELECT COALESCE(MAX(ID), 0) + 1 INTO @dmp_next_id FROM `wp_users`;',
      "CREATE TEMPORARY TABLE dmp_keep_user AS SELECT * FROM `wp_users` WHERE user_login = 'alex';",
      'CREATE TEMPORARY TABLE dmp_keep_meta AS SELECT m.* FROM `wp_usermeta` m JOIN dmp_keep_user u ON u.ID = m.user_id;',
      'TRUNCATE TABLE `wp_users`;',
      'TRUNCATE TABLE `wp_usermeta`;',
      'INSERT INTO `wp_users` SELECT * FROM dmp_keep_user;',
      'INSERT INTO `wp_usermeta` SELECT * FROM dmp_keep_meta;',
    ]);
    expect(users.users).toContain("UPDATE `wp_users` SET user_email = 'admin@local.wandworks.example';");
  });

  it('removes orders stored as posts with their meta, order notes, product reviews, Flamingo messages and keys, and leaves comments as they are', () => {
    const sql = sqlOf(cleanupPlan(shop, 'wp_', 'admin@local.wandworks.example'));
    expect(sql.woocommerce).toContain(
      "DELETE m FROM `wp_postmeta` m JOIN `wp_posts` o ON o.ID = m.post_id WHERE o.post_type IN ('shop_order', 'shop_order_refund', 'shop_order_placehold', 'shop_subscription');",
    );
    expect(sql.woocommerce).toContain("c.comment_type IN ('order_note', 'webhook_delivery')");
    expect(sql.reviews).toContain("(c.comment_type = 'review' OR c.comment_post_ID IN (SELECT ID FROM `wp_posts` WHERE post_type = 'product'))");
    expect(sql.forms).toContain("WHERE post_type IN ('flamingo_inbound', 'flamingo_contact', 'flamingo_outbound', 'nf_sub');");
    expect(sql.secrets).toContain("option_name IN ('wp_mail_smtp', ");
    expect(sql.secrets).toContain("option_name LIKE 'woocommerce\\_stripe\\_%'");
    expect(Object.values(sql).join('\n')).not.toMatch(/comment_author|UPDATE `wp_comments`/);
    expect(sql.settings).toContain("UPDATE `wp_options` SET option_value = '0' WHERE option_name = 'blog_public';");
    expect(sql.settings).toContain("SET option_value = 'admin@local.wandworks.example' WHERE option_name IN ('admin_email', 'new_admin_email', ");
  });

  it('leaves WooCommerce and reviews alone on a site without WooCommerce', () => {
    const groups = cleanupPlan(tables('wp_users', 'wp_usermeta', 'wp_options', 'wp_posts', 'wp_postmeta', 'wp_comments'), 'wp_', 'admin@local.wandworks.example');
    expect(groups.map((g) => g.id)).toEqual(['users', 'forms', 'logs', 'secrets', 'settings']);
  });

  it("cleans each site of a network, and users, signups and the network's own tables once", () => {
    const network = tables('wp_users', 'wp_usermeta', 'wp_signups', 'wp_sitemeta', 'wp_options', 'wp_posts', 'wp_comments', 'wp_2_options', 'wp_2_posts', 'wp_2_comments', 'wp_2_wc_orders');
    const sql = sqlOf(cleanupPlan(network, 'wp_', 'admin@local.wandworks.example'));
    expect(sql.users).toContain('TRUNCATE TABLE `wp_signups`;');
    expect(sql.users).toContain("UPDATE `wp_sitemeta` SET meta_value = 'a:0:{}' WHERE meta_key = 'site_admins';");
    expect(sql.users).not.toContain('wp_2_');
    expect(sql.woocommerce).toContain('TRUNCATE TABLE `wp_2_wc_orders`;');
    // A kept user stays the network's only super admin.
    expect(sqlOf(cleanupPlan(network, 'wp_', 'admin@local.wandworks.example', 'alex')).users).toContain(`UPDATE \`wp_sitemeta\` SET meta_value = 'a:1:{i:0;s:4:"alex";}' WHERE meta_key = 'site_admins';`);
    expect(sql.settings).toContain("UPDATE `wp_2_options` SET option_value = '0' WHERE option_name = 'blog_public';");
    expect(sql.settings).toContain("UPDATE `wp_sitemeta` SET meta_value = 'admin@local.wandworks.example' WHERE meta_key = 'admin_email';");
  });

  it('reports what went, estimates marked, and leaves out what had nothing to remove', async () => {
    const fake = fakeExec({ mysql: { stdout: 'wp_wc_orders emptied\t120000\tabout\nwp_posts orders, refunds and subscriptions\t3207\texact\nwp_comments order notes\t0\texact\n' } });
    const target = { exec: fake.exec, mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };
    const [result] = await runCleanup(target, 'shop_com__import', [{ id: 'woocommerce', label: 'WooCommerce orders and customers', statements: ['TRUNCATE TABLE `wp_wc_orders`;'] }]);
    expect(result?.stdout).toBe('WooCommerce orders and customers\n  wp_wc_orders emptied: about 120,000 rows\n  wp_posts orders, refunds and subscriptions: 3,207');
    const cleanup = fake.calls.find((c) => c.input);
    expect(cleanup?.args.at(-1)).toBe('shop_com__import');
    expect(cleanup?.input?.startsWith('SET sql_log_bin = 0;\nSET foreign_key_checks = 0;\n')).toBe(true);
  });

  it("drops the SQL modes WordPress drops, so a copy of a table keeps its zero dates", async () => {
    const fake = fakeExec({ 'mysql --batch --skip-column-names --user root --host localhost -e SELECT @@SESSION.sql_mode': { stdout: 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE\n' }, mysql: { stdout: '' } });
    const target = { exec: fake.exec, mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };
    await runCleanup(target, 'shop_com__import', [{ id: 'users', label: 'Users', statements: ['TRUNCATE TABLE `wp_users`;'] }]);
    expect(fake.calls.find((c) => c.input)?.input).toBe("SET sql_log_bin = 0;\nSET foreign_key_checks = 0;\nSET SESSION sql_mode='NO_ZERO_IN_DATE';\nTRUNCATE TABLE `wp_users`;\n");
  });
});

const DUMP = [
  'CREATE TABLE `wp_options` (x int);',
  "INSERT INTO `wp_options` VALUES (1,'siteurl','https://www.shop.com','yes'),(2,'home','https://www.shop.com','yes');",
  'CREATE TABLE `wp_posts` (x int);',
  'CREATE TABLE `wp_users` (x int);',
  "INSERT INTO `wp_users` VALUES (1,'jane','x','jane','jane@customer.example','','2020-01-01 00:00:00','',0,'Jane');",
  'CREATE TABLE `wp_usermeta` (x int);',
  'CREATE TABLE `wp_wc_orders` (x int);',
  '',
].join('\n');

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id);
    if (view && !['running', 'queued', 'undoing'].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

async function setup(server: ReturnType<typeof fakeMysql>, extra: (wp: string) => Record<string, FakeResponse> = () => ({}), options: { dump?: string; admin?: boolean; user?: Record<string, string>; bare?: boolean } = {}) {
  const t = wpSiteTree();
  const wp = `wp --path=${t.docroot} --url=https://local.shop.com/`;
  const fake = fakeExec({
    mysql: (call) => server.run(call),
    [`${wp} search-replace`]: { stdout: 'Success: Made 3 replacements.' },
    [`${wp} db tables`]: { stdout: 'wp_options\n' },
    [`${wp} db query SELECT 1,`]: { stdout: '1\thome\thttps://local.shop.com\n1\tsiteurl\thttps://local.shop.com\n' },
    [`${wp} db query UPDATE`]: { stdout: '' },
    [`${wp} db query DELETE`]: { stdout: '' },
    [`${wp} user update`]: { stdout: 'Success: Updated user 7.' },
    [`${wp} user get alex --field=ID`]: { stdout: '7\n' },
    [`${wp} plugin list --status=active`]: { stdout: 'akismet\nwp-mail-smtp\nmailpoet\nwoocommerce\n' },
    [`${wp} plugin deactivate`]: { stdout: 'Success: Deactivated 2 of 2 plugins.' },
    [`${wp} user create`]: { stdout: 'Success: Created user 1.' },
    [`${wp} user get admin --field=ID`]: { stdout: '1\n' },
    [`${wp} cache flush`]: { stdout: 'Success' },
    [`${wp} rewrite flush`]: { stdout: 'Success' },
    ...extra(wp),
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs, uploadsDir: join(t.root, 'uploads'),
    secrets: options.admin === false ? { panelPasswordHash: 'x' } : { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } },
  };
  const { id } = await saveUpload(fake.exec, ctx.uploadsDir, 'shop.sql', Readable.from([options.dump ?? DUMP]));
  const input = { domain: 'local.shop.com', uploadId: id, replace: [{ from: 'www.shop.com', to: 'local.shop.com' }], confirm: 'local.shop.com', ...(options.user ? { user: options.user } : {}), ...(options.bare ? { replaceBare: true } : {}) };
  const start = async () => {
    const result = await runAction(ctx, 'db.cleanCopy', input);
    return { jobId: result.data?.jobId as string, view: await settle(jobs, result.data?.jobId as string) };
  };
  return { ctx, store, jobs, calls: fake.calls, start, input };
}

const BEFORE = { shop_com: { wp_options: 'old', wp_posts: 'old', wp_users: 'old', wp_usermeta: 'old', wp_local_notes: 'old' } };

describe('preparing a database from production', () => {
  it('cleans the dump in a side database, swaps it in, keeps the old tables for 7 days and makes admin the only user', async () => {
    const server = fakeMysql(BEFORE);
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.steps.filter((x) => x.status === 'failed').map((x) => `${x.id}: ${x.output}`)).toEqual([]);
    expect(view.steps.map((x) => x.id)).toEqual(['import', 'clean', 'swap', 'replace', 'check', 'plugins', 'admin', 'flush']);
    // Users and orders were emptied in the side database, before the swap: nothing private reached the site.
    const state = server.state();
    const kept = Object.keys(state).find((db) => /^shop_com__keep\d{12}$/.test(db)) as string;
    expect(state.shop_com).toEqual({ wp_local_notes: 'old', wp_options: 'dump', wp_posts: 'dump', wp_usermeta: 'emptied', wp_users: 'emptied', wp_wc_orders: 'emptied' });
    expect(state[kept]).toEqual({ wp_options: 'old', wp_posts: 'old', wp_usermeta: 'old', wp_users: 'old' });
    const swapAt = server.statements.findIndex((x) => x.startsWith('RENAME TABLE'));
    expect(server.statements.findIndex((x) => x === 'TRUNCATE TABLE `wp_users`;')).toBeLessThan(swapAt);
    expect(s.store.keptDatabases('local.shop.com')).toEqual([
      expect.objectContaining({ name: kept, db: 'shop_com', reason: 'before shop.sql from production', before: ['wp_options', 'wp_posts', 'wp_users', 'wp_usermeta', 'wp_local_notes'] }),
    ]);
    expect(view.steps.find((x) => x.id === 'swap')?.output).toContain(`are kept in ${kept} for 7 days`);
    // Mail plugins off without running them, admin made with its password on stdin, every post its own.
    expect(view.steps.find((x) => x.id === 'plugins')?.output).toContain('turned off: wp-mail-smtp, mailpoet');
    const create = s.calls.find((c) => c.args.includes('create'));
    expect(create?.args).toEqual(expect.arrayContaining(['admin', 'admin@local.shop.com', '--role=administrator', '--prompt=user_pass', '--skip-plugins']));
    expect(create?.input).toBe('admin\n');
    // Every post its own and an administrator of the site, as wp user delete --reassign leaves it.
    const reassign = s.calls.find((c) => c.args.some((a) => a.startsWith('DELETE FROM `wp_usermeta`')))?.args.find((a) => a.startsWith('DELETE')) as string;
    expect(reassign).toContain('UPDATE `wp_posts` SET post_author = 1 WHERE post_author <> 1;');
    expect(reassign).toContain(`(1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}'), (1, 'wp_user_level', '10');`);
    expect(view.steps.find((x) => x.id === 'admin')?.output).toContain('admin is the only user, an administrator, and the author of every post and link; comments keep who wrote them');
    // The kept database is the way back now, not the job's Undo.
    expect(view.undoable).toEqual([]);
  });

  it('keeps an administrator of the dump instead, with the chosen password on stdin and no notice mailed', async () => {
    const server = fakeMysql(BEFORE, { admins: ['alex'] });
    const s = await setup(server, undefined, { user: { keep: 'alex', password: 'local-pass' } });
    const { view } = await s.start();
    expect(view.steps.filter((x) => x.status === 'failed').map((x) => `${x.id}: ${x.output}`)).toEqual([]);
    expect(server.state().shop_com?.wp_users).toBe('kept one');
    const update = s.calls.find((c) => c.args.includes('update'));
    expect(update?.args).toEqual(expect.arrayContaining(['user', 'update', 'alex', '--prompt=user_pass', '--skip-email']));
    expect(update?.input).toBe('local-pass\n');
    expect(update?.args.join(' ')).not.toContain('local-pass');
    expect(s.calls.some((c) => c.args.includes('create'))).toBe(false);
    expect(view.steps.find((x) => x.id === 'admin')?.label).toBe('Keep alex as the only user, the author of every post');
    expect(s.calls.find((c) => c.args.some((a) => a.startsWith('DELETE FROM `wp_usermeta`')))?.args.join(' ')).toContain('SET post_author = 7 WHERE post_author <> 7;');
  });

  it('stops before the swap when the user to keep is missing or not an administrator, leaving the site as it was', async () => {
    for (const [keep, why] of [['jordan', 'there is no user jordan to keep'], ['casey', 'casey is not an administrator']] as const) {
      const server = fakeMysql(BEFORE, { members: ['casey'] });
      const s = await setup(server, undefined, { user: { keep } });
      const { view } = await s.start();
      expect(view.steps.find((x) => x.status === 'failed')?.output).toContain(why);
      expect(server.state().shop_com).toEqual(BEFORE.shop_com);
      expect(server.statements.some((x) => x.startsWith('TRUNCATE'))).toBe(false);
    }
  });

  it('puts the tables from before back and forgets the kept database when Undo follows a failed step', async () => {
    const server = fakeMysql(BEFORE);
    const s = await setup(server, (wp) => ({ [`${wp} user create`]: { code: 1, stderr: 'Error: Error establishing a database connection.' } }));
    const { jobId, view } = await s.start();
    expect(view.steps.find((x) => x.status === 'failed')?.id).toBe('admin');
    expect(view.undoable).toEqual([SWAP_UNDO]);
    s.jobs.undo(jobId);
    expect((await settle(s.jobs, jobId)).status).toBe('undone');
    expect(server.state()).toEqual(BEFORE);
    expect(s.store.keptDatabases()).toEqual([]);
  });

  it('replaces every mention of the production domain when asked, not only URLs', async () => {
    const mentions = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.file === 'wp' && c.args.includes('search-replace')).map((c) => c.args[c.args.indexOf('search-replace') + 1]);
    const urls = await setup(fakeMysql(BEFORE));
    expect((await urls.start()).view.status).toBe('done');
    expect(mentions(urls.calls).length).toBeGreaterThan(0);
    expect(mentions(urls.calls)).not.toContain('www.shop.com');
    const bare = await setup(fakeMysql(BEFORE), undefined, { bare: true });
    expect((await bare.start()).view.status).toBe('done');
    expect(mentions(bare.calls)).toContain('www.shop.com');
  });

  it('refuses without the admin account, and for a dump that makes views or triggers', async () => {
    const without = await setup(fakeMysql(BEFORE), undefined, { admin: false });
    await expect(runAction(without.ctx, 'db.cleanCopy', without.input)).rejects.toThrow(/needs the MySQL admin account/);
    const views = await setup(fakeMysql(BEFORE), undefined, { dump: `${DUMP}/*!50001 CREATE VIEW \`wp_top\` AS SELECT 1 AS \`x\`*/;\n` });
    await expect(runAction(views.ctx, 'db.cleanCopy', views.input)).rejects.toThrow(/makes views, triggers or routines/);
    await expect(runAction(views.ctx, 'db.cleanCopy', { ...views.input, confirm: 'local.other.com' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('fails before the swap when the site has triggers, leaving it as it was', async () => {
    const server = fakeMysql(BEFORE, { triggers: 1 });
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.steps.find((x) => x.status === 'failed')?.output).toContain("cannot keep shop_com's tables aside: shop_com has triggers");
    expect(server.state()).toEqual(BEFORE);
  });
});

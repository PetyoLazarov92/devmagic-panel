import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { type ActionContext, runAction } from '../src/actions.js';
import { type JobRuntime, type JobStep, Jobs } from '../src/jobs.js';
import { cleanupsDir, cleanupViewWhere, contentTitle, listCleanups, planContent, planDropTable, planEmptyTable, planOrphans, planTransients, pruneCleanups, setAutoload, undoCleanup } from '../src/mysql-cleanup.js';
import type { RowsContext } from '../src/mysql-rows.js';
import type { WordpressTables } from '../src/mysql-wordpress.js';
import { RunStore } from '../src/store.js';
import { type FakeCall, fakeExec, tempTree, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const SINGLE = ['wp_options', 'wp_posts', 'wp_postmeta', 'wp_comments', 'wp_commentmeta', 'wp_terms', 'wp_termmeta', 'wp_term_taxonomy', 'wp_term_relationships', 'wp_users', 'wp_usermeta'];
const NETWORK = [...SINGLE, 'wp_blogs', 'wp_sitemeta', 'wp_2_options', 'wp_2_posts', 'wp_2_postmeta', 'wp_2_comments', 'wp_2_commentmeta', 'wp_2_terms', 'wp_2_termmeta', 'wp_2_term_taxonomy', 'wp_2_term_relationships'];

/** MySQL and mysqldump for shop_com: counts of 3 rows and a highest key of 40, a dump of one INSERT. */
function fakeDb(tables = SINGLE, answer: (sql: string) => Partial<{ code: number; stdout: string; stderr: string }> | undefined = () => undefined) {
  return fakeExec({
    mysqldump: () => ({ stdout: 'INSERT IGNORE INTO `t` VALUES (1);\n' }),
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? call.inputText ?? '';
      const special = answer(sql);
      if (special) return special;
      if (sql.includes('SELECT TABLE_NAME FROM information_schema.TABLES')) return { stdout: `${tables.join('\n')}\n` };
      if (sql.includes('SELECT JSON_ARRAY(blog_id')) return { stdout: [[1, 'local.shop.com', '/', 0, 0, 0], [2, 'local.shop.com', '/outlet/', 0, 0, 0]].map((r) => JSON.stringify(r)).join('\n') };
      if (sql.includes('COUNT(*)')) return { stdout: sql.split('SELECT ').slice(1).map(() => '40\t3').join('\n') };
      if (sql.includes('ROW_COUNT()')) return { stdout: sql.split('ROW_COUNT()').slice(1).map(() => '3').join('\n') };
      return { stdout: '' };
    },
  });
}

function ctxFor(fake: ReturnType<typeof fakeExec>, config = wpSiteTree().config, extra: Partial<RowsContext> = {}): RowsContext {
  return { config, exec: fake.exec, mysql, kept: () => [], siteBusy: () => false, now: () => new Date('2026-11-07T10:15:00Z'), ...extra };
}

/** Runs a job's steps as the job runner would, collecting what its Undo would run. */
async function run(steps: JobStep[]) {
  const undos: Array<() => Promise<unknown>> = [];
  const job: JobRuntime = { onUndo: (_label, undo) => void undos.push(undo), progress: () => undefined };
  const out: string[] = [];
  for (const step of steps) {
    const r = await step.run(job);
    for (const x of Array.isArray(r) ? r : [r]) out.push(x.stdout);
  }
  return { out, undos };
}
const dumps = (fake: ReturnType<typeof fakeExec>) => fake.calls.filter((c) => c.file === 'mysqldump');
/** Every batched DELETE a clean-up sent, in order. */
const deletes = (fake: ReturnType<typeof fakeExec>) => fake.calls.filter((c) => c.input?.includes('DELETE FROM')).map((c) => c.input).join('\n');

describe('deleting transients', () => {
  it('saves the expired ones and their timeouts first, then deletes only what the copy holds', async () => {
    const fake = fakeDb();
    const ctx = ctxFor(fake);
    const { out } = await run(await planTransients(ctx, { domain: 'local.shop.com', scope: 'expired' }));
    expect(out[0]).toMatch(/^saved wp_options \(3 rows\): .* gzipped, kept 14 days$/);
    const [dump] = dumps(fake);
    const where = (dump as FakeCall).args.find((a) => a.startsWith('--where=')) as string;
    expect(where).toContain("option_name LIKE '\\_transient\\_timeout\\_%' AND CAST(option_value AS UNSIGNED) < UNIX_TIMESTAMP()");
    expect(where).toContain("CONCAT('_transient_timeout_', SUBSTRING(option_name, 12)) IN (SELECT n FROM (SELECT option_name AS n FROM `wp_options` WHERE");
    expect(where).toContain("CONCAT('_site_transient_timeout_', SUBSTRING(option_name, 17))");
    expect(where).toMatch(/ AND `option_id` <= 40$/);
    expect(dump?.args).toEqual(expect.arrayContaining(['--single-transaction', '--insert-ignore', '--no-create-info', '--hex-blob', '--', 'shop_com', 'wp_options']));
    expect(dump?.env).toEqual({ MYSQL_PWD: 'adminpw' });
    expect(deletes(fake)).toContain(`DELETE FROM \`wp_options\` WHERE ${where.slice('--where='.length)};`);
    expect(out[1]).toBe('wp_options: 3 rows. Undo puts them back for 14 days');
  });

  it("takes every transient, and on a network the first site's run takes the network's own", async () => {
    const tree = wpSiteTree({ multisite: true });
    const fake = fakeDb(NETWORK);
    await run(await planTransients(ctxFor(fake, tree.config), { domain: 'local.shop.com', scope: 'all' }));
    expect(dumps(fake).map((c) => c.args.at(-1))).toEqual(['wp_options', 'wp_sitemeta']);
    expect(dumps(fake)[0]?.args.find((a) => a.startsWith('--where='))).toBe("--where=((option_name LIKE '\\_transient\\_%') OR (option_name LIKE '\\_site\\_transient\\_%')) AND `option_id` <= 40");
    const second = fakeDb(NETWORK);
    await run(await planTransients(ctxFor(second, tree.config), { domain: 'local.shop.com', blog: 2, scope: 'all' }));
    expect(dumps(second).map((c) => c.args.at(-1))).toEqual(['wp_2_options']);
  });

  it('saves nothing and deletes nothing when there is nothing to remove', async () => {
    const fake = fakeDb(SINGLE, (sql) => (sql.includes('COUNT(*)') ? { stdout: '0\t0\n' } : undefined));
    const ctx = ctxFor(fake);
    const { out, undos } = await run(await planTransients(ctx, { domain: 'local.shop.com', scope: 'expired' }));
    expect(out).toEqual(['nothing to remove', 'nothing to remove']);
    expect(undos).toEqual([]);
    expect(dumps(fake)).toEqual([]);
    expect(existsSync(cleanupsDir(ctx.config))).toBe(false);
  });
});

describe('removing in batches', () => {
  it('deletes a big part in batches with progress, and a stop ends it between two with Undo in place', async () => {
    let left = 12_000;
    const fake = fakeDb(SINGLE, (sql) => {
      if (sql.includes('COUNT(*)') && sql.includes('wp_postmeta')) return { stdout: '40\t12000' };
      if (sql.includes('DELETE FROM')) {
        const n = Math.min(5000, left);
        left -= n;
        return { stdout: String(n) };
      }
      return undefined;
    });
    const steps = await planOrphans(ctxFor(fake), { domain: 'local.shop.com', kinds: ['postmeta'] });
    const notes: string[] = [];
    const undos: string[] = [];
    let stop = false;
    const job: JobRuntime = { onUndo: (label) => void undos.push(label), dropUndo: (label) => void undos.splice(undos.indexOf(label), 1), progress: (_f, note) => void (note && notes.push(note)), stopped: () => stop };
    await (steps[0] as JobStep).run(job);
    // Stop after the first batch.
    let batches = 0;
    const once: JobRuntime = { ...job, progress: (f, note) => { job.progress(f, note); batches += 1; stop = batches >= 1; } };
    const stopped = (await (steps[1] as JobStep).run(once)) as { code: number; stderr: string };
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toBe('Stopped after 5,000 of 12,000 rows: Retry carries on, Undo puts back what was removed.');
    expect(undos).toEqual(['Put back what delete what was left behind removed']);
    // Retry carries on until a batch takes fewer rows than it may.
    stop = false;
    const done = (await (steps[1] as JobStep).run(job)) as { code: number; stdout: string };
    expect(done.code).toBe(0);
    expect(notes.at(-1)).toBe('12,000 of 12,000 rows');
    expect(undos).toHaveLength(1);
    expect(fake.calls.filter((c) => c.input?.includes('DELETE FROM `wp_postmeta`')).every((c) => c.input?.includes('ORDER BY `meta_id` LIMIT 5000;'))).toBe(true);
  });

  it('refuses before saving when the copy may not fit on the disk', async () => {
    const fake = fakeDb(SINGLE, (sql) => (sql.includes('AVG_ROW_LENGTH') ? { stdout: 'wp_options\t900000000000000\t0\n' } : undefined));
    const [save] = await planTransients(ctxFor(fake), { domain: 'local.shop.com', scope: 'all' });
    await expect((save as JobStep).run({ onUndo: () => undefined, progress: () => undefined })).rejects.toThrow(/Saving what it removes first needs up to .*, and the disk has .* free: make room, then try again/);
    expect(dumps(fake)).toHaveLength(0);
  });

  it('removes transients in one statement: a value and its timeout go together', async () => {
    const fake = fakeDb();
    await run(await planTransients(ctxFor(fake), { domain: 'local.shop.com', scope: 'expired' }));
    const sent = fake.calls.filter((c) => c.input?.includes('DELETE FROM `wp_options`'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).not.toContain('LIMIT');
  });
});

describe('deleting content and what was left behind', () => {
  it('deletes posts with what WordPress deletes with them, the meta first and the posts last', async () => {
    const fake = fakeDb();
    await run(await planContent(ctxFor(fake), { domain: 'local.shop.com', kinds: ['revisions', 'trashedPosts', 'spamComments'] }));
    expect(dumps(fake).map((c) => c.args.at(-1))).toEqual(['wp_commentmeta', 'wp_comments', 'wp_postmeta', 'wp_term_relationships', 'wp_posts', 'wp_commentmeta', 'wp_comments']);
    const sql = deletes(fake);
    expect(sql).toContain("DELETE FROM `wp_postmeta` WHERE (post_id IN (SELECT ID FROM `wp_posts` WHERE post_type = 'revision' OR post_status = 'trash')) AND `meta_id` <= 40 ORDER BY `meta_id` LIMIT 5000;");
    expect(sql).toContain("taxonomy = 'link_category'");
    // A table without a one-column key is deleted by its condition alone.
    expect(sql).toMatch(/DELETE FROM `wp_term_relationships` WHERE object_id IN \(SELECT ID FROM `wp_posts` WHERE post_type = 'revision' OR post_status = 'trash'\) AND term_taxonomy_id NOT IN/);
    expect(sql).toContain("DELETE FROM `wp_comments` WHERE (comment_approved = 'spam') AND `comment_ID` <= 40 ORDER BY `comment_ID` LIMIT 5000;");
    expect(sql.indexOf('`wp_posts` WHERE (post_type')).toBeGreaterThan(sql.indexOf('DELETE FROM `wp_postmeta`'));
  });

  it("deletes orphaned meta and terms, never a link's, and user meta only with the network's first site", async () => {
    const fake = fakeDb();
    await run(await planOrphans(ctxFor(fake), { domain: 'local.shop.com', kinds: ['postmeta', 'termRelationships', 'usermeta'] }));
    const sql = deletes(fake);
    expect(sql).toContain('DELETE FROM `wp_postmeta` WHERE (NOT EXISTS (SELECT 1 FROM `wp_posts` p WHERE p.ID = `wp_postmeta`.post_id)) AND `meta_id` <= 40 ORDER BY `meta_id` LIMIT 5000;');
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM `wp_posts` p WHERE p.ID = `wp_term_relationships`.object_id) AND term_taxonomy_id NOT IN (SELECT term_taxonomy_id FROM `wp_term_taxonomy` WHERE taxonomy = 'link_category')");
    expect(sql).toContain('DELETE FROM `wp_usermeta` WHERE (NOT EXISTS (SELECT 1 FROM `wp_users` p WHERE p.ID = `wp_usermeta`.user_id)) AND `umeta_id` <= 40 ORDER BY `umeta_id` LIMIT 5000;');
    const tree = wpSiteTree({ multisite: true });
    await expect(planOrphans(ctxFor(fakeDb(NETWORK), tree.config), { domain: 'local.shop.com', blog: 2, kinds: ['usermeta'] })).rejects.toThrow(/none of those tables/);
  });

  it('refuses a site without a database here, and a site of the network it does not have', async () => {
    await expect(planContent(ctxFor(fakeDb(), tempTree().config), { domain: 'local.shop.com', kinds: ['revisions'] })).rejects.toThrow(/no database on this computer/);
    await expect(planContent(ctxFor(fakeDb()), { domain: 'local.shop.com', blog: 5, kinds: ['revisions'] })).rejects.toThrow(/no site 5/);
  });
});

describe('the saved copy and Undo', () => {
  it('keeps a private copy with what it removed, lists it without rows, and puts it back the last part first', async () => {
    const fake = fakeDb();
    const ctx = ctxFor(fake);
    const { undos } = await run(await planContent(ctx, { domain: 'local.shop.com', kinds: ['spamComments'] }));
    const dir = cleanupsDir(ctx.config);
    const [id] = readdirSync(dir);
    expect(id).toMatch(/^20261107-101500-[a-z0-9]{6}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, id as string)).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(join(dir, id as string))) expect(statSync(join(dir, id as string, f)).mode & 0o777).toBe(0o600);
    expect(listCleanups(ctx.config, 'shop_com')).toEqual([
      { id, title: 'Delete revisions, drafts, trash and spam', kind: 'content', tables: [{ table: 'wp_commentmeta', rows: 3 }, { table: 'wp_comments', rows: 3 }], bytes: expect.any(Number), savedAt: '2026-11-07T10:15:00.000Z', purgeAt: '2026-11-21T10:15:00.000Z' },
    ]);
    expect(listCleanups(ctx.config, 'shop_com', 'local.shop.com/learn')).toEqual([]);
    expect(listCleanups(ctx.config, 'other_db')).toEqual([]);
    await undos[0]?.();
    const imports = fake.calls.filter((c) => c.inputText?.includes('INSERT IGNORE'));
    expect(imports).toHaveLength(2);
    expect(imports[0]?.args).toContain('--database=shop_com');
    expect(imports[0]?.inputText).toMatch(/^SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'; SET autocommit = 0;/);
    expect(existsSync(join(dir, id as string))).toBe(false);
    await expect(undoCleanup(ctx, { database: 'shop_com', cleanup: id as string })).rejects.toThrow(/not saved any more/);
  });

  it('makes a deleted table again only while no table of its name is there', async () => {
    let there = '1';
    const fake = fakeDb(SINGLE, (sql) => (sql.includes('information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()') ? { stdout: `${there}\n` } : sql.includes("SELECT JSON_ARRAY('t'") ? { stdout: JSON.stringify(['t', 'acme_log', 'BASE TABLE', 'InnoDB', 3, 1, 1, 0, null, null]) } : undefined));
    const ctx = ctxFor(fake);
    const { out, undos } = await run(await planDropTable(ctx, { database: 'shop_com', table: 'acme_log', confirm: 'acme_log' }));
    expect(dumps(fake)[0]?.args).toEqual(expect.arrayContaining(['--skip-add-drop-table', '--insert-ignore']));
    expect(dumps(fake)[0]?.args).not.toContain('--no-create-info');
    expect(fake.calls.some((c) => c.input?.includes('DROP TABLE `acme_log`;'))).toBe(true);
    expect(out[1]).toBe('acme_log: deleted. Undo puts it back for 14 days');
    await expect(undos[0]?.()).rejects.toThrow(/table called acme_log is there again/);
    there = '0';
    expect(await undos[0]?.()).toMatchObject({ stdout: 'undid "Delete table acme_log": put back table acme_log' });
  });

  it('empties a table with TRUNCATE after saving all of it', async () => {
    const fake = fakeDb(SINGLE, (sql) => (sql.includes("SELECT JSON_ARRAY('t'") ? { stdout: JSON.stringify(['t', 'acme_log', 'BASE TABLE', 'InnoDB', 3, 1, 1, 0, null, null]) } : undefined));
    await run(await planEmptyTable(ctxFor(fake), { database: 'shop_com', table: 'acme_log', confirm: 'acme_log' }));
    expect(dumps(fake)[0]?.args).toEqual(expect.arrayContaining(['--no-create-info', '--insert-ignore']));
    expect(dumps(fake)[0]?.args.some((a) => a.startsWith('--where'))).toBe(false);
    expect(fake.calls.some((c) => c.input?.includes('TRUNCATE TABLE `acme_log`;'))).toBe(true);
  });

  it("leaves MySQL's own databases, kept ones, views and a busy site alone", async () => {
    const view = fakeDb(SINGLE, (sql) => (sql.includes("SELECT JSON_ARRAY('t'") ? { stdout: JSON.stringify(['t', 'recent', 'VIEW', null, null, null, null, null, null, null]) } : undefined));
    await expect(planEmptyTable(ctxFor(view), { database: 'mysql', table: 'user', confirm: 'user' })).rejects.toThrow(/MySQL's own/);
    await expect(planEmptyTable(ctxFor(view, undefined, { kept: () => [{ name: 'shop_old', site: 'local.shop.com' }] }), { database: 'shop_old', table: 'x', confirm: 'x' })).rejects.toThrow(/kept for a site/);
    await expect(planDropTable(ctxFor(view), { database: 'reports', table: 'recent', confirm: 'recent' })).rejects.toThrow(/is a view/);
    await expect(planEmptyTable(ctxFor(view, undefined, { siteBusy: () => true }), { database: 'shop_com', table: 'recent', confirm: 'recent' })).rejects.toThrow(/busy with a job/);
  });

  it('lets copies older than 14 days go', () => {
    const dir = join(tempTree().root, 'cleanups');
    mkdirSync(join(dir, '20261020-101500-aaaaaa'), { recursive: true });
    writeFileSync(join(dir, '20261020-101500-aaaaaa', '01-x.sql.gz'), gzipSync('x'));
    const old = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(join(dir, '20261020-101500-aaaaaa'), old, old);
    expect(pruneCleanups(dir)).toEqual(['20261020-101500-aaaaaa']);
  });
});

describe('autoload', () => {
  it('writes on and off, or yes and no where WordPress still does, as a row change with its Undo', async () => {
    let current = 'yes';
    const fake = fakeDb(SINGLE, (sql) => {
      if (sql.startsWith("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';\nSELECT option_id, autoload")) return { stdout: `7\t${current}\n` };
      if (sql.includes("SELECT JSON_ARRAY('t'")) {
        return { stdout: [['t', 'wp_options', 'BASE TABLE', 'InnoDB', 3, 1, 1, 0, 'utf8mb4_unicode_520_ci', null], ['c', 'option_id', 'bigint unsigned', 'bigint', 'NO', null, 'PRI', 'auto_increment', null, null, ''], ['c', 'autoload', 'varchar(20)', 'varchar', 'NO', 'yes', 'MUL', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''], ['i', 'PRIMARY', 0, 1, 'option_id', 'BTREE', 3]].map((r) => JSON.stringify(r)).join('\n') };
      }
      if (sql.includes('FOR UPDATE')) return { stdout: JSON.stringify(['7', current]) };
      return undefined;
    });
    const ctx = ctxFor(fake);
    const r = await setAutoload(ctx, { domain: 'local.shop.com', option: "acme's_cache", autoload: 'off' });
    expect(r.stdout).toBe("acme's_cache: autoload no (was yes); Undo puts it back");
    expect(r.change).toMatch(/^20261107-101500-/);
    const lookup = fake.calls.find((c) => c.input?.includes('SELECT option_id, autoload')) as FakeCall;
    expect(lookup.input).toContain(`WHERE option_name = _utf8mb4 X'${Buffer.from("acme's_cache").toString('hex')}'`);
    current = 'auto';
    expect((await setAutoload(ctx, { domain: 'local.shop.com', option: 'acme_cache', autoload: 'off' })).stdout).toBe('acme_cache: autoload off (was auto); Undo puts it back');
    current = 'off';
    await expect(setAutoload(ctx, { domain: 'local.shop.com', option: 'acme_cache', autoload: 'off' })).rejects.toThrow(/already loaded only when asked for/);
    const none = fakeDb(SINGLE, (sql) => (sql.includes('SELECT option_id, autoload') ? { stdout: '' } : undefined));
    await expect(setAutoload(ctxFor(none), { domain: 'local.shop.com', option: 'nope', autoload: 'on' })).rejects.toThrow(/no option called nope/);
  });

  it('runs as an action while the action holds the site, and waits for a job on it', async () => {
    const fake = fakeDb(SINGLE, (sql) => {
      if (sql.includes('SELECT option_id, autoload')) return { stdout: '7\ton\n' };
      if (sql.includes("SELECT JSON_ARRAY('t'")) {
        return { stdout: [['t', 'wp_options', 'BASE TABLE', 'InnoDB', 3, 1, 1, 0, 'utf8mb4_unicode_520_ci', null], ['c', 'option_id', 'bigint unsigned', 'bigint', 'NO', null, 'PRI', 'auto_increment', null, null, ''], ['c', 'autoload', 'varchar(20)', 'varchar', 'NO', 'yes', 'MUL', '', 'utf8mb4', 'utf8mb4_unicode_520_ci', ''], ['i', 'PRIMARY', 0, 1, 'option_id', 'BTREE', 3]].map((r) => JSON.stringify(r)).join('\n') };
      }
      if (sql.includes('FOR UPDATE')) return { stdout: JSON.stringify(['7', 'on']) };
      return undefined;
    });
    const tree = wpSiteTree();
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const ctx: ActionContext = { config: tree.config, exec: fake.exec, store, dmpRoot: '/x', wpcoreBin: '/x', wpcoreConf: '/x', home: tree.root, jobs, uploadsDir: join(tree.root, 'uploads'), secrets: { panelPasswordHash: 'x', mysql } };
    const result = await runAction(ctx, 'db.setAutoload', { domain: 'local.shop.com', option: 'acme_cache', autoload: 'off' });
    expect(result).toMatchObject({ ok: true, output: 'acme_cache: autoload off (was on); Undo puts it back' });

    let finish = () => {};
    const job = jobs.start([{ id: 'a', label: 'A', run: () => new Promise((done) => { finish = () => done({ code: 0, stdout: '', stderr: '' }); }) }], { runId: store.start('db.cleanContent', {}), title: 'Clean up local.shop.com', target: 'local.shop.com' });
    await expect(runAction(ctx, 'db.setAutoload', { domain: 'local.shop.com', option: 'acme_cache', autoload: 'off' })).rejects.toThrow(/local.shop.com is busy: Clean up local.shop.com/);
    finish();
    expect(job.id).toBeTruthy();
  });
});

describe('what plugins leave', () => {
  it('deletes oEmbed caches, Akismet history, finished actions after their logs, expired sessions and login sessions', async () => {
    const fake = fakeDb([...SINGLE, 'wp_actionscheduler_actions', 'wp_actionscheduler_logs', 'wp_woocommerce_sessions']);
    await run(await planContent(ctxFor(fake), { domain: 'local.shop.com', kinds: ['oembed', 'akismet', 'actionsDone', 'wcSessions', 'sessionTokens'] }));
    expect(dumps(fake).map((c) => c.args.at(-1))).toEqual(['wp_postmeta', 'wp_commentmeta', 'wp_actionscheduler_logs', 'wp_actionscheduler_actions', 'wp_woocommerce_sessions', 'wp_usermeta']);
    const sql = deletes(fake);
    expect(sql).toContain("DELETE FROM `wp_postmeta` WHERE (meta_key LIKE '\\_oembed\\_%') AND `meta_id` <= 40 ORDER BY `meta_id` LIMIT 5000;");
    expect(sql).toContain("DELETE FROM `wp_commentmeta` WHERE (meta_key IN ('akismet_history', 'akismet_as_submitted'))");
    expect(sql.indexOf('DELETE FROM `wp_actionscheduler_logs`')).toBeLessThan(sql.indexOf('DELETE FROM `wp_actionscheduler_actions`'));
    expect(sql).toContain("DELETE FROM `wp_actionscheduler_actions` WHERE (status IN ('complete', 'failed', 'canceled')) AND `action_id` <= 40");
    expect(sql).toContain('DELETE FROM `wp_woocommerce_sessions` WHERE (session_expiry < UNIX_TIMESTAMP()) AND `session_id` <= 40');
    expect(sql).toContain("DELETE FROM `wp_usermeta` WHERE (meta_key = 'session_tokens') AND `umeta_id` <= 40");
  });

  it('keeps the newest revisions of each post when asked, and removes repeated post meta in one statement', async () => {
    const fake = fakeDb();
    await run(await planContent(ctxFor(fake), { domain: 'local.shop.com', kinds: ['revisions', 'duplicateMeta'], keepRevisions: 3 }));
    const sql = deletes(fake);
    expect(sql).toContain("DELETE FROM `wp_posts` WHERE ((post_type = 'revision' AND ID IN (SELECT ID FROM (SELECT ID, ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_date DESC, ID DESC) AS n FROM `wp_posts` WHERE post_type = 'revision') r WHERE r.n > 3)))");
    const repeats = fake.calls.filter((c) => c.input?.includes('PARTITION BY post_id, meta_key, MD5(meta_value)') && c.input.includes('DELETE FROM'));
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.input).not.toContain('LIMIT');
  });

  it('names a clean-up of plugin leftovers for what it is', async () => {
    const { contentTitle } = await import('../src/mysql-cleanup.js');
    expect(contentTitle(['revisions', 'spamComments'])).toBe('Delete revisions, drafts, trash and spam');
    expect(contentTitle(['revisions', 'oembed'])).toBe('Delete what a clean-up found');
  });
});

describe('one clean-up for the whole card', () => {
  it('deletes content and what was left behind in one job, with one saved copy and one Undo', async () => {
    const fake = fakeDb();
    const { undos } = await run(await planContent(ctxFor(fake), { domain: 'local.shop.com', kinds: ['spamComments'], orphans: ['postmeta'] }));
    expect(dumps(fake).map((c) => c.args.at(-1))).toEqual(['wp_commentmeta', 'wp_comments', 'wp_postmeta']);
    expect(deletes(fake)).toContain('DELETE FROM `wp_postmeta` WHERE (NOT EXISTS (SELECT 1 FROM `wp_posts` p WHERE p.ID = `wp_postmeta`.post_id))');
    expect(undos).toHaveLength(1);
    expect(contentTitle(['spamComments'], ['postmeta'])).toBe('Delete what a clean-up found');
    expect(contentTitle(['spamComments'])).toBe('Delete revisions, drafts, trash and spam');
  });

  it('refuses a clean-up with nothing picked', async () => {
    await expect(planContent(ctxFor(fakeDb()), { domain: 'local.shop.com', kinds: [], orphans: [] })).rejects.toThrow('Pick at least one kind to delete');
  });
});

describe("a clean-up's rows in the Tables view", () => {
  const t: WordpressTables = { database: 'shop_com', prefix: 'wp_', blog: 1, blogPrefix: 'wp_', names: new Set([...SINGLE, 'wp_actionscheduler_actions', 'wp_actionscheduler_logs']) };
  const view = (kind: Parameters<typeof cleanupViewWhere>[1]['kind'], extra = {}) => ({ domain: 'local.shop.com', kind, ...extra });

  it('uses the condition the clean-up deletes by, on the table its count counts', () => {
    expect(cleanupViewWhere(t, view('revisions'), 'wp_posts')).toBe("post_type = 'revision'");
    expect(cleanupViewWhere(t, view('revisions', { keepRevisions: 3 }), 'wp_posts')).toMatch(/^\(post_type = 'revision' AND ID IN \(SELECT ID FROM \(.*\) r WHERE r\.n > 3\)\)$/);
    expect(cleanupViewWhere(t, view('spamComments'), 'wp_comments')).toBe("comment_approved = 'spam'");
    expect(cleanupViewWhere(t, view('actionsDone'), 'wp_actionscheduler_actions')).toMatch(/^status IN /);
    expect(cleanupViewWhere(t, view('postmeta'), 'wp_postmeta')).toBe('NOT EXISTS (SELECT 1 FROM `wp_posts` p WHERE p.ID = `wp_postmeta`.post_id)');
    expect(cleanupViewWhere(t, view('expiredTransients'), 'wp_options')).toContain('UNIX_TIMESTAMP()');
    expect(cleanupViewWhere(t, view('sessionTokens'), 'wp_usermeta')).toBe("meta_key = 'session_tokens'");
  });

  it("on a network's second site uses its own tables, and leaves the network's shared ones and sitemeta to the first", () => {
    const names = new Set([...NETWORK]);
    const second: WordpressTables = { database: 'shop_com', prefix: 'wp_', blog: 2, blogPrefix: 'wp_2_', names, network: [] };
    const first: WordpressTables = { ...second, blog: 1, blogPrefix: 'wp_' };
    expect(cleanupViewWhere(second, view('revisions'), 'wp_2_posts')).toBe("post_type = 'revision'");
    expect(() => cleanupViewWhere(second, view('revisions'), 'wp_posts')).toThrow(/does not count rows of wp_posts/);
    expect(cleanupViewWhere(second, view('postmeta'), 'wp_2_postmeta')).toBe('NOT EXISTS (SELECT 1 FROM `wp_2_posts` p WHERE p.ID = `wp_2_postmeta`.post_id)');
    expect(cleanupViewWhere(second, view('transients'), 'wp_2_options')).toContain("option_name LIKE '\\_transient\\_%'");
    // Users and their meta are the network's: only the first site shows or cleans them.
    expect(() => cleanupViewWhere(second, view('usermeta'), 'wp_usermeta')).toThrow(/does not count rows/);
    expect(() => cleanupViewWhere(second, view('sessionTokens'), 'wp_usermeta')).toThrow(/does not count rows/);
    expect(cleanupViewWhere(first, view('usermeta'), 'wp_usermeta')).toContain('`wp_users`');
    // The network's own transients live in sitemeta, deleted with the first site's; its rows show the options part.
    expect(cleanupViewWhere(first, view('transients'), 'wp_options')).toContain('option_name');
    expect(() => cleanupViewWhere(first, view('transients'), 'wp_sitemeta')).toThrow(/does not count rows/);
  });

  it('deletes content and leftovers of a network\'s second site in its own tables, in one job', async () => {
    const tree = wpSiteTree({ multisite: true });
    const fake = fakeDb(NETWORK);
    await run(await planContent(ctxFor(fake, tree.config), { domain: 'local.shop.com', blog: 2, kinds: ['revisions'], orphans: ['postmeta', 'usermeta'] }));
    expect(dumps(fake).map((c) => c.args.at(-1))).toEqual(['wp_2_commentmeta', 'wp_2_comments', 'wp_2_postmeta', 'wp_2_term_relationships', 'wp_2_posts', 'wp_2_postmeta']);
    expect(deletes(fake)).not.toContain('`wp_usermeta`');
  });

  it('refuses a table the kind does not count', () => {
    expect(() => cleanupViewWhere(t, view('revisions'), 'wp_postmeta')).toThrow('That clean-up does not count rows of wp_postmeta');
    expect(() => cleanupViewWhere(t, view('wcSessions'), 'wp_options')).toThrow(/does not count rows/);
  });
});

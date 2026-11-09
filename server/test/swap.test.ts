import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { saveUpload } from '../src/sites/uploads.js';
import { chooseMode, SWAP_UNDO } from '../src/sites/swap.js';
import { RunStore } from '../src/store.js';
import type { FakeResponse } from './helpers.js';
import { DMP, fakeExec, fakeMysql, wpSiteTree } from './helpers.js';

const DUMP = [
  'CREATE TABLE `wp_options` (x int);',
  "INSERT INTO `wp_options` VALUES (1,'siteurl','https://www.shop.com','yes'),(2,'home','https://www.shop.com','yes');",
  'CREATE TABLE `wp_posts` (x int);',
  "INSERT INTO `wp_posts` VALUES (1,'<a href=\\\"https://www.shop.com/about\\\">');",
  'CREATE TABLE `wp_comments` (x int);',
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

async function setup(server: ReturnType<typeof fakeMysql>, extra: (wp: string) => Record<string, FakeResponse> = () => ({}), dump = DUMP) {
  const t = wpSiteTree();
  const wp = `wp --path=${t.docroot} --url=https://local.shop.com/`;
  const fake = fakeExec({
    mysql: (call) => server.run(call),
    // wp db export writes the file it is given.
    [`${wp} db export`]: (call) => (writeFileSync(call.args[4] as string, '-- dump\n'), { stdout: 'Success: Exported.' }),
    [`${wp} search-replace`]: { stdout: 'Success: Made 3 replacements.' },
    [`${wp} db tables`]: { stdout: 'wp_options\n' },
    [`${wp} db query SELECT 1,`]: { stdout: '1\thome\thttps://local.shop.com\n1\tsiteurl\thttps://local.shop.com\n' },
    [`${wp} cache flush`]: { stdout: 'Success' },
    [`${wp} rewrite flush`]: { stdout: 'Success' },
    ...extra(wp),
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets: { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } },
  };
  const { id } = await saveUpload(fake.exec, ctx.uploadsDir, 'shop.sql', Readable.from([dump]));
  const start = async () => {
    const result = await runAction(ctx, 'db.import', { domain: 'local.shop.com', uploadId: id, replace: [{ from: 'www.shop.com', to: 'local.shop.com' }], confirm: 'local.shop.com' });
    return { jobId: result.data?.jobId as string, view: await settle(jobs, result.data?.jobId as string) };
  };
  return { ctx, jobs, calls: fake.calls, start, wp };
}

const BEFORE = { shop_com: { wp_options: 'old', wp_posts: 'old', wp_redirection_logs: 'old' } };

describe('an import through a side database', () => {
  it('imports beside the site, swaps the tables in at once and keeps the ones from before for 7 days', async () => {
    const server = fakeMysql(BEFORE);
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.status).toBe('done');
    expect(view.steps.map((x) => x.id)).toEqual(['import', 'swap', 'replace', 'check', 'flush', 'cleanup']);
    // The dump's tables in, a table it does not have left alone, and the ones it replaced in a kept database.
    const kept = Object.keys(server.state()).find((name) => name.startsWith('shop_com__keep')) as string;
    expect(kept).toMatch(/^shop_com__keep\d{12}$/);
    expect(server.state()).toEqual({ shop_com: { wp_comments: 'dump', wp_options: 'dump', wp_posts: 'dump', wp_redirection_logs: 'old' }, [kept]: { wp_options: 'old', wp_posts: 'old' } });
    expect(s.ctx.store.keptDatabases('local.shop.com')).toMatchObject([{ name: kept, db: 'shop_com', reason: 'before importing shop.sql', before: ['wp_options', 'wp_posts', 'wp_redirection_logs'] }]);
    expect(s.calls.find((c) => c.args.includes('--max-allowed-packet=1G'))?.args.at(-1)).toBe('shop_com__import');
    expect(view.steps.find((x) => x.id === 'swap')?.output).toBe(
      `swapped 3 tables into shop_com at once; the 2 ones they replace are kept in ${kept} for 7 days; 1 table the dump does not have stayed`,
    );
    expect(view.steps.find((x) => x.id === 'cleanup')).toMatchObject({ label: 'Keep the tables from before the import for 7 days', output: expect.stringContaining('under Kept databases') });
    // No slow export first, and the kept database is the way back once the job ends, not the job's Undo.
    expect(s.calls.some((c) => c.args.includes('export'))).toBe(false);
    expect(view.undoable).toEqual([]);
  });

  it('keeps the new tables when a later step fails, so Retry goes on, and Undo puts the ones from before back', async () => {
    const server = fakeMysql(BEFORE);
    const s = await setup(server, (wp) => ({ [`${wp} search-replace`]: { code: 1, stderr: 'Error: Error establishing a database connection.' } }));
    const { jobId, view } = await s.start();
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.id).toBe('replace');
    const kept = Object.keys(server.state()).find((name) => name.startsWith('shop_com__keep')) as string;
    expect(server.state()).toEqual({
      shop_com: { wp_comments: 'dump', wp_options: 'dump', wp_posts: 'dump', wp_redirection_logs: 'old' },
      [kept]: { wp_options: 'old', wp_posts: 'old' },
    });
    expect(view.undoable).toEqual([SWAP_UNDO]);
    s.jobs.undo(jobId);
    const undone = await settle(s.jobs, jobId);
    expect(undone.status).toBe('undone');
    expect(server.state()).toEqual(BEFORE);
    // Undo forgets the kept database it emptied.
    expect(s.ctx.store.keptDatabases()).toEqual([]);
  });

  it('leaves the site as it was when the dump does not go in, with no side database left', async () => {
    const server = fakeMysql(BEFORE, { failImport: true });
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.id).toBe('import');
    expect(server.state()).toEqual(BEFORE);
    expect(view.undoable).toEqual([]);
  });

  it('fails the swap without moving a table when MySQL refuses it, and keeps the import for a retry', async () => {
    const server = fakeMysql(BEFORE, { failRename: true });
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.steps.find((x) => x.status === 'failed')?.id).toBe('swap');
    expect(server.state()).toEqual({ ...BEFORE, shop_com__import: { wp_comments: 'dump', wp_options: 'dump', wp_posts: 'dump' } });
  });

  it('imports straight into an empty database, with no snapshot', async () => {
    const server = fakeMysql({ shop_com: {} });
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'import')?.output).toContain('importing straight into shop_com: shop_com is empty, so there is nothing to keep');
    expect(s.calls.find((c) => c.args.includes('--max-allowed-packet=1G'))?.args.at(-1)).toBe('shop_com');
    expect(s.calls.some((c) => c.args.includes('export'))).toBe(false);
    expect(view.steps.find((x) => x.id === 'swap')?.output).toBe('imported straight into shop_com: nothing to swap');
  });

  it('takes a snapshot and imports straight in when the tables have triggers', async () => {
    const server = fakeMysql(BEFORE, { triggers: 2 });
    const s = await setup(server);
    const { view } = await s.start();
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'import')?.output).toContain('shop_com has triggers, which cannot move to another database');
    expect(s.calls.some((c) => c.args.includes('export'))).toBe(true);
    expect(server.state().shop_com__prev).toBeUndefined();
  });

  it('keeps the snapshot and a plain import for a dump that makes views, triggers or routines', async () => {
    const server = fakeMysql(BEFORE);
    const views = await setup(server, undefined, `${DUMP}/*!50001 CREATE VIEW \`wp_top\` AS SELECT 1 AS \`x\`*/;\n`);
    const { view } = await views.start();
    expect(view.steps.map((x) => x.id)).toEqual(['snapshot', 'import', 'replace', 'check', 'flush']);
  });

  it('goes straight in when a second copy would not fit on the disk', async () => {
    const server = fakeMysql(BEFORE);
    const target = { exec: (await setup(server)).ctx.exec, mysql: { user: 'root', host: 'localhost', password: 'adminpw' } };
    // A datadir that exists, on a disk with 1 GB free.
    const fake = fakeExec({ mysql: { stdout: `3\t0\t0\t${process.cwd()}\n` } });
    const choice = await chooseMode({ ...target, exec: fake.exec }, 'shop_com', join(process.cwd(), 'package.json'), () => ({ bytes: 1024 ** 3 }));
    expect(choice).toEqual({ mode: 'direct', why: "a second copy needs about 1.0 GB and MySQL's disk has 1.0 GB free", hasTables: true });
    expect((await chooseMode({ ...target, exec: fake.exec }, 'shop_com', join(process.cwd(), 'package.json'), () => ({ bytes: 100 * 1024 ** 3 }))).mode).toBe('side');
  });
});

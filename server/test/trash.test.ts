import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ActionBusyError, ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { parseTrashList } from '../src/sites/trash.js';
import { readDbPassword } from '../src/sites/wpconfig.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree, type FakeResponse } from './helpers.js';

const ID = 'local.shop.com-20261024-153000';
const LIST = `${ID}\tlocal.shop.com\t1792857000\t52428800\t1\tshop_com\nlocal.hand.com-20261020-090000\tlocal.hand.com\t1792490000\t1024\t0\t-\n`;

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(databases = 'information_schema\n', mysql: FakeResponse = { stdout: '' }, extra: (docroot: string) => Record<string, FakeResponse> = () => ({})) {
  const t = tempTree();
  const docroot = join(t.config.WEB_DIR, 'local.shop.com');
  const dump = join(t.config.BACKUP_DIR, 'sites', `restore-${ID}.sql.gz`);
  const fake = fakeExec({
    [`sudo -n ${DMP} trash-list`]: { stdout: LIST },
    [`sudo -n ${DMP} trash-restore ${ID}`]: () => {
      // dmp-root puts the folder back and leaves the dump for the panel.
      mkdirSync(docroot, { recursive: true });
      writeFileSync(join(docroot, 'wp-config.php'), "<?php\ndefine('DB_NAME', 'shop_com');\ndefine('DB_USER', 'shop_com');\ndefine('DB_PASSWORD', 'it\\'s s3cret');\n");
      mkdirSync(join(t.config.BACKUP_DIR, 'sites'), { recursive: true });
      writeFileSync(dump, gzipSync('CREATE TABLE x;'));
      return { stdout: `ok: restored\nDUMP=${dump}\n` };
    },
    [`sudo -n ${DMP} trash-delete ${ID}`]: { stdout: 'ok' },
    'mysql --batch --skip-column-names --user root --host localhost -e SHOW DATABASES': { stdout: databases },
    'mysql --user root --host localhost': mysql,
    'mysql --batch --skip-column-names --user root --host localhost -e SELECT @@SESSION.sql_mode': { stdout: 'NO_ENGINE_SUBSTITUTION\n' },
    [`wp --path=${docroot} --url=https://local.shop.com/ db import`]: { stdout: 'Success: Imported' },
    ...extra(docroot),
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: join(t.root, 'wpcore.conf'), home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets: { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'adminpw' } },
  };
  return { ctx, jobs, calls: fake.calls, docroot };
}

describe('Deleted sites', () => {
  it('reads the list dmp-root prints, newest first, with when each is purged', () => {
    const list = parseTrashList(LIST, 14);
    expect(list.map((e) => e.id)).toEqual([ID, 'local.hand.com-20261020-090000']);
    expect(list[0]).toMatchObject({ domain: 'local.shop.com', sizeBytes: 52428800, panelMade: true, dbName: 'shop_com' });
    expect(new Date(list[0]?.purgeAt as string).getTime() - new Date(list[0]?.deletedAt as string).getTime()).toBe(14 * 86_400_000);
    expect(list[1]?.dbName).toBeUndefined();
  });

  it('restores the files, makes the database and its user with the password in wp-config.php, imports and empties the entry', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'trash.restore', { id: ID });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.map((x) => x.id)).toEqual(['files', 'db', 'import', 'cleanup']);
    expect(s.calls.find((c) => c.file === 'mysql' && c.input?.includes('CREATE DATABASE'))?.input).toContain('CREATE DATABASE `shop_com`');
    const create = s.calls.find((c) => c.file === 'mysql' && c.input?.includes('CREATE USER'))?.input ?? '';
    expect(create).toContain("CREATE USER IF NOT EXISTS 'shop_com'@'localhost' IDENTIFIED BY 'it\\'s s3cret';");
    // The password goes to MySQL on stdin only.
    expect(s.calls.some((c) => c.args.join(' ').includes('s3cret'))).toBe(false);
    // Straight into MySQL with the admin account, the gzip unpacked on the way and nothing left behind.
    const imported = s.calls.find((c) => c.args.includes('--max-allowed-packet=1G'));
    expect(imported?.args.at(-1)).toBe('shop_com');
    expect(imported?.env).toEqual({ MYSQL_PWD: 'adminpw' });
    expect(imported?.inputText).toBe('SET sql_log_bin = 0; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\nCREATE TABLE x;\nCOMMIT;\n');
    expect(readdirSync(join(s.ctx.config.BACKUP_DIR, 'sites'))).toEqual([]);
    expect(s.calls.at(-1)?.args.slice(2)).toEqual(['trash-delete', ID]);
  });

  it("imports through WP-CLI with the site's account when the admin account cannot sign in", async () => {
    const denied = { code: 1, stderr: "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)" };
    const s = setup(undefined, undefined, (docroot) => ({
      'mysql --batch --skip-column-names --user root --host localhost -e SELECT @@SESSION.sql_mode': denied,
      [`wp --path=${docroot} --url=https://local.shop.com/ db query`]: { stdout: 'NO_ENGINE_SUBSTITUTION\n' },
    }));
    const view = await settle(s.jobs, (await runAction(s.ctx, 'trash.restore', { id: ID })).data?.jobId ?? '');
    expect(view.status).toBe('done');
    const imported = s.calls.find((c) => c.args.includes('import'));
    expect(imported?.file).toBe('wp');
    // No binary log setting: the site's account may not change it.
    expect(imported?.inputText).toBe('SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\nCREATE TABLE x;\nCOMMIT;\n');
    expect(s.calls.some((c) => c.args.includes('--max-allowed-packet=1G'))).toBe(false);
  });

  it('gives the user a new password, also in wp-config.php, when MySQL refuses the old one', async () => {
    const policy = { code: 1, stderr: 'ERROR 1819 (HY000) at line 1: Your password does not satisfy the current policy requirements' };
    const s = setup(undefined, (call) => (call.input?.includes("IDENTIFIED BY 'it\\'s s3cret'") ? policy : { stdout: '' }));
    const result = await runAction(s.ctx, 'trash.restore', { id: ID });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.find((x) => x.id === 'db')?.output).toContain('MySQL refused the old password, so the user has a new one, also in wp-config.php');
    const fresh = /define\( 'DB_PASSWORD', '([^']+)' \)/.exec(readFileSync(join(s.docroot, 'wp-config.php'), 'utf8'))?.[1] ?? '';
    expect(fresh).toMatch(/^[\w-]{24}$/);
    expect(s.calls.filter((c) => c.input?.includes('CREATE USER')).at(-1)?.input).toContain(`IDENTIFIED BY '${fresh}'`);
  });

  it('refuses before anything runs when the database exists again, or the id is not a deleted site', async () => {
    const s = setup('information_schema\nshop_com\n');
    await expect(runAction(s.ctx, 'trash.restore', { id: ID })).rejects.toThrow(/database shop_com exists again/);
    expect(s.calls.some((c) => c.args.includes('trash-restore'))).toBe(false);
    await expect(runAction(s.ctx, 'trash.restore', { id: 'www.shop.com-20261024-153000' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'trash.restore', { id: 'local.gone.com-20261024-153000' })).rejects.toThrow(/no deleted site/);
  });

  it('deletes an entry for good only with its domain typed', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'trash.delete', { id: ID, confirm: 'local.shop' })).rejects.toBeInstanceOf(ActionInputError);
    expect((await runAction(s.ctx, 'trash.delete', { id: ID, confirm: 'local.shop.com' })).ok).toBe(true);
  });

  it('holds the entry and the site while a restore runs: no second restore, no delete, no other action', async () => {
    let release: () => void = () => undefined;
    const importing = new Promise<{ stdout: string }>((r) => (release = () => r({ stdout: 'Success: Imported' })));
    const gated = setup(undefined, undefined, () => ({ 'mysql --user root --host localhost --default-character-set=utf8mb4': () => importing }));
    const result = await runAction(gated.ctx, 'trash.restore', { id: ID });
    const jobId = result.data?.jobId ?? '';
    for (let i = 0; i < 500 && !gated.calls.some((c) => c.args.includes('--max-allowed-packet=1G')); i++) await new Promise((r) => setTimeout(r, 2));
    await expect(runAction(gated.ctx, 'trash.restore', { id: ID })).rejects.toBeInstanceOf(ActionBusyError);
    await expect(runAction(gated.ctx, 'trash.delete', { id: ID, confirm: 'local.shop.com' })).rejects.toThrow(/local\.shop\.com is busy: Restore local\.shop\.com/);
    await expect(runAction(gated.ctx, 'site.remove', { domain: 'local.shop.com', confirm: 'local.shop.com' })).rejects.toBeInstanceOf(ActionBusyError);
    expect(gated.calls.filter((c) => c.args.includes('trash-restore'))).toHaveLength(1);
    release();
    const view = await settle(gated.jobs, jobId);
    expect(view.status).toBe('done');
    // A restore makes nothing Undo could take back.
    expect(view.undoable).toEqual([]);
    expect(gated.jobs.undo(jobId)).toBeUndefined();
    expect(gated.jobs.busyFor('local.shop.com')).toBeUndefined();
  });

  it('counts a restore as done when its entry was already gone at the end', async () => {
    const s = setup(undefined, undefined, () => ({ [`sudo -n ${DMP} trash-delete ${ID}`]: { code: 1, stderr: `error: no trash entry ${ID}` } }));
    const result = await runAction(s.ctx, 'trash.restore', { id: ID });
    const view = await settle(s.jobs, result.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(view.steps.at(-1)?.output).toBe('the entry was already gone');
  });

  it('reads DB_PASSWORD with escaped quotes, skipping commented-out lines', () => {
    expect(readDbPassword("<?php\n// define('DB_PASSWORD', 'old');\ndefine( 'DB_PASSWORD', 'a\\'b//c' );\n")).toBe("a'b//c");
    expect(readDbPassword('<?php define("DB_PASSWORD", "x\\"y");')).toBe('x"y');
    expect(readDbPassword('<?php')).toBeUndefined();
  });
});

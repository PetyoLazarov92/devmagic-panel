import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import type { FakeCall } from './helpers.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { listSnapshots, replaceDomains, snapshotDir } from '../src/sites/db.js';
import { saveUpload } from '../src/sites/uploads.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const DUMP =
  "CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.shop.com','yes'),(2,'home','https://www.shop.com','yes');\nCREATE TABLE `wp_comments` (x int);\nINSERT INTO `wp_comments` VALUES (1,'Nice post');\n";
/** The same dump with a link that still says http. */
const HTTP_DUMP = `${DUMP}CREATE TABLE \`wp_posts\` (x int);\nINSERT INTO \`wp_posts\` VALUES (1,'<a href=\\"http://www.shop.com/about\\">About</a>');\n`;

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup() {
  const t = wpSiteTree();
  const wp = `wp --path=${t.docroot} --url=https://local.shop.com/`;
  const fake = fakeExec({
    // wp db export writes the file it is given.
    [`${wp} db export`]: (call: FakeCall) => {
      writeFileSync(call.args[4] as string, '-- dump\n');
      return { stdout: 'Success: Exported.\n' };
    },
    [`${wp} db import`]: { stdout: 'Success: Imported.\n' },
    [`${wp} db query SELECT @@SESSION.sql_mode`]: { stdout: 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION\n' },
    [`${wp} db tables`]: { stdout: 'wp_comments\nwp_options\nwp_posts\n' },
    [`${wp} db query SELECT TABLE_NAME,`]: { stdout: 'wp_comments\t16384\nwp_options\t1048576\nwp_posts\t52428800\n' },
    // Each site's home and siteurl after the replace: on the local name.
    [`${wp} db query SELECT 1,`]: { stdout: '1\thome\thttps://local.shop.com\n1\tsiteurl\thttps://local.shop.com\n' },
    [`${wp} search-replace`]: { stdout: 'Success: 41 replacements to be made.\n' },
    [`${wp} cache flush`]: { stdout: 'Success: The cache was flushed.\n' },
    [`${wp} rewrite flush`]: { stdout: 'Success: Rewrite rules flushed.\n' },
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets: null,
  };
  const wpCalls = () => fake.calls.filter((c) => c.file === 'wp').map((c) => c.args.slice(2).join(' '));
  /** The tables a search and replace call names: between the replace and the first option. */
  const tablesOf = (call: string) => {
    const words = call.split(' ');
    return words.slice(3, words.findIndex((w, i) => i >= 3 && w.startsWith('--')));
  };
  /**
   * The search and replace passes one table got, in the order it got them, without the table names: the same
   * whether this machine runs the tables in one group or several.
   */
  const passesOn = (table: string) =>
    wpCalls()
      .filter((c) => c.startsWith('search-replace') && tablesOf(c).includes(table))
      .map((c) => {
        const words = c.split(' ');
        return [...words.slice(0, 3), ...words.slice(3 + tablesOf(c).length)].join(' ');
      });
  const dir = snapshotDir(t.config, 'local.shop.com');
  return { ...t, ctx, jobs, wpCalls, tablesOf, passesOn, dir, calls: fake.calls };
}

async function startAndSettle(s: ReturnType<typeof setup>, id: Parameters<typeof runAction>[1], input: Record<string, unknown>) {
  const result = await runAction(s.ctx, id, input);
  expect(result.data?.jobId).toBeDefined();
  return settle(s.jobs, result.data?.jobId as string);
}

describe('db.snapshot', () => {
  it('exports, gzips into the snapshot folder and removes the plain export', async () => {
    const s = setup();
    const job = await startAndSettle(s, 'db.snapshot', { domain: 'local.shop.com', label: 'before-update' });
    expect(job.status).toBe('done');
    const files = readdirSync(s.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-before-update\.sql\.gz$/);
    expect(s.wpCalls()[0]).toMatch(/^db export .+\.sql --skip-plugins --skip-themes$/);
    expect(listSnapshots(s.config, 'local.shop.com')[0]).toMatchObject({ label: 'before-update', name: files[0] });
  });

  it('rejects labels that are not slugs', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'db.snapshot', { domain: 'local.shop.com', label: '../x' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('db.restore and db.deleteSnapshot', () => {
  function withSnapshot(s: ReturnType<typeof setup>) {
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, '20261020-090500.sql.gz'), gzipSync('-- old\n'));
  }

  it('snapshots the current database, imports the chosen one and flushes caches', async () => {
    const s = setup();
    withSnapshot(s);
    const job = await startAndSettle(s, 'db.restore', { domain: 'local.shop.com', snapshot: '20261020-090500.sql.gz', confirm: 'local.shop.com' });
    expect(job.steps.map((x) => [x.id, x.status])).toEqual([['snapshot', 'done'], ['restore', 'done'], ['flush', 'done']]);
    // The gzipped snapshot streams in through stdin, unpacked on the way, with WP-CLI's speedups and modes WordPress takes.
    expect(s.wpCalls().slice(1, 3)).toEqual(['db query SELECT @@SESSION.sql_mode --skip-column-names --skip-plugins --skip-themes', 'db import - --skip-plugins --skip-themes']);
    const sent = s.calls.find((c) => c.args.includes('import'))?.inputText;
    expect(sent).toBe("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\n-- old\n\nCOMMIT;\n");
    expect(readdirSync(s.dir).filter((f) => !f.endsWith('.sql.gz'))).toEqual([]);
    expect(listSnapshots(s.config, 'local.shop.com').map((x) => x.label)).toContain('before-restore');
  });

  it('needs the typed domain and an existing snapshot', async () => {
    const s = setup();
    withSnapshot(s);
    await expect(runAction(s.ctx, 'db.restore', { domain: 'local.shop.com', snapshot: '20261020-090500.sql.gz', confirm: 'nope' })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'db.restore', { domain: 'local.shop.com', snapshot: '20201020-090500.sql.gz', confirm: 'local.shop.com' })).rejects.toThrow(/no snapshot/);
    await expect(runAction(s.ctx, 'db.restore', { domain: 'local.shop.com', snapshot: '../../etc/passwd', confirm: 'local.shop.com' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('deletes one snapshot', async () => {
    const s = setup();
    withSnapshot(s);
    expect((await runAction(s.ctx, 'db.deleteSnapshot', { domain: 'local.shop.com', snapshot: '20261020-090500.sql.gz' })).ok).toBe(true);
    expect(listSnapshots(s.config, 'local.shop.com')).toEqual([]);
  });
});

describe('db.import', () => {
  async function upload(s: ReturnType<typeof setup>, dump = DUMP) {
    return saveUpload(s.ctx.exec, s.ctx.uploadsDir, 'shop.sql', Readable.from([dump]));
  }

  it('snapshots first, imports, replaces production domains in this site\'s tables and removes the upload', async () => {
    const s = setup();
    const { id } = await upload(s, HTTP_DUMP);
    const job = await startAndSettle(s, 'db.import', {
      domain: 'local.shop.com', uploadId: id, replace: [{ from: 'www.shop.com', to: 'local.shop.com' }], confirm: 'local.shop.com',
    });
    expect(job.steps.map((x) => x.id)).toEqual(['snapshot', 'import', 'replace', 'https', 'check', 'flush']);
    expect(job.steps.filter((x) => x.status === 'failed').map((x) => `${x.id}: ${x.output}`)).toEqual([]);
    expect(job.status).toBe('done');
    // URLs only, without --precise: plain SQL where no serialized data is, so big tables go fast. Each table gets every
    // pass in order, the tables at once; wp_comments has none of the addresses, so it is left out.
    const passes = [
      'search-replace //www.shop.com //local.shop.com --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes',
      'search-replace \\/\\/www.shop.com \\/\\/local.shop.com --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes',
      ...['local.shop.com', 'local.shop.de', 'www.local.shop.com'].flatMap((d) => [
        `search-replace http://${d} https://${d} --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes`,
        `search-replace http:\\/\\/${d} https:\\/\\/${d} --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes`,
      ]),
    ];
    expect(s.passesOn('wp_posts')).toEqual(passes);
    expect(s.passesOn('wp_options')).toEqual(passes);
    expect(s.passesOn('wp_comments')).toEqual([]);
    expect(job.steps.find((x) => x.id === 'check')?.output).toContain('home and siteurl of the site no longer use www.shop.com');
    expect(existsSync(join(s.ctx.uploadsDir, id))).toBe(false);
  });

  it('replaces every mention in one pass when asked, and makes the local names https only when the dump has http links', async () => {
    const s = setup();
    const bare = await startAndSettle(s, 'db.import', {
      domain: 'local.shop.com', uploadId: (await upload(s)).id, replace: [{ from: 'www.shop.com', to: 'local.shop.com' }], replaceBare: true, confirm: 'local.shop.com',
    });
    expect(bare.status).toBe('done');
    // Not an address, so the scan cannot rule a table out: every table once.
    expect(s.wpCalls().filter((c) => c.startsWith('search-replace www.shop.com ')).flatMap(s.tablesOf).sort()).toEqual(['wp_comments', 'wp_options', 'wp_posts']);
    expect(s.wpCalls().some((c) => c.startsWith('search-replace //www.shop.com'))).toBe(false);

    const t = setup();
    // A link to a local name on http: the dump came from another local copy.
    const https = await startAndSettle(t, 'db.import', { domain: 'local.shop.com', uploadId: (await upload(t, HTTP_DUMP.replace('http://www.shop.com', 'http://local.shop.de'))).id, confirm: 'local.shop.com' });
    expect(https.steps.map((x) => x.id)).toEqual(['snapshot', 'import', 'https', 'flush']);
    expect(t.wpCalls().filter((c) => c.startsWith('search-replace')).every((c) => c.startsWith('search-replace http'))).toBe(true);

    // A production link on http is left as it is, and the rest is on https already: nothing to search for.
    const u = setup();
    const none = await startAndSettle(u, 'db.import', { domain: 'local.shop.com', uploadId: (await upload(u, HTTP_DUMP)).id, confirm: 'local.shop.com' });
    expect(none.steps.map((x) => x.id)).toEqual(['snapshot', 'import', 'flush']);
  });

  it('refuses a dump whose table prefix differs from wp-config.php', async () => {
    const s = setup();
    const { id } = await upload(s, DUMP.replaceAll('wp_options', 'xyz_options'));
    await expect(runAction(s.ctx, 'db.import', { domain: 'local.shop.com', uploadId: id, confirm: 'local.shop.com' })).rejects.toThrow(/prefix xyz_ but wp-config.php uses wp_/);
  });
});

describe('db.searchReplace', () => {
  it('previews with a dry run, both plain and escaped slashes, without a snapshot', async () => {
    const s = setup();
    const job = await startAndSettle(s, 'db.searchReplace', { domain: 'local.shop.com', from: 'https://old.test/a', to: 'https://new.test/a', dryRun: true });
    expect(job.steps.map((x) => x.id)).toEqual(['preview']);
    expect(job.steps[0]?.output).toContain('41 replacements to be made');
    for (const table of ['wp_comments', 'wp_options', 'wp_posts']) {
      expect(s.passesOn(table)).toEqual([
        'search-replace https://old.test/a https://new.test/a --all-tables-with-prefix --skip-columns=guid --report-changed-only --dry-run --skip-plugins --skip-themes',
        'search-replace https:\\/\\/old.test\\/a https:\\/\\/new.test\\/a --all-tables-with-prefix --skip-columns=guid --report-changed-only --dry-run --skip-plugins --skip-themes',
      ]);
    }
  });

  it('takes a snapshot before a real run', async () => {
    const s = setup();
    const job = await startAndSettle(s, 'db.searchReplace', { domain: 'local.shop.com', from: 'Old Shop', to: 'New Shop', dryRun: false });
    expect(job.steps.map((x) => x.id)).toEqual(['snapshot', 'replace', 'flush']);
    expect(s.wpCalls().find((c) => c.startsWith('search-replace'))).not.toContain('--dry-run');
  });

  it('rejects text wp-cli could read as an option, and multi-line text', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'db.searchReplace', { domain: 'local.shop.com', from: '--url=x', to: 'abc', dryRun: true })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'db.searchReplace', { domain: 'local.shop.com', from: 'abc\ndef', to: 'xyz', dryRun: true })).rejects.toBeInstanceOf(ActionInputError);
    await expect(runAction(s.ctx, 'db.searchReplace', { domain: 'local.shop.com', from: 'same', to: 'same', dryRun: true })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('replaceDomains', () => {
  it('replaces the longest hosts first and only whole host names in a network\'s own tables', async () => {
    const calls: string[][] = [];
    const wp = async (args: string[]) => (calls.push(args), { code: 0, stdout: '', stderr: '' });
    await replaceDomains(wp, [
      { from: 'dailypost.com', to: 'local.dailypost.com' },
      { from: 'deals.dailypost.com', to: 'local.deals.dailypost.com' },
      { from: 'dailypost.com.br', to: 'local.dailypost.com.br' },
    ], { tables: '--all-tables', multisite: true, prefix: 'wp_' });
    expect(calls.filter((a) => a[0] === 'search-replace' && a.includes('--all-tables') && !a[1]?.startsWith('\\')).map((a) => a[1])).toEqual(['//deals.dailypost.com', '//dailypost.com.br', '//dailypost.com']);
    expect(calls.filter((a) => a.includes('--regex'))).toEqual([
      ['search-replace', '^deals\\.dailypost\\.com$', 'local.deals.dailypost.com', 'wp_blogs', 'wp_site', '--regex', '--regex-flags=i'],
      ['search-replace', '^dailypost\\.com\\.br$', 'local.dailypost.com.br', 'wp_blogs', 'wp_site', '--regex', '--regex-flags=i'],
      ['search-replace', '^dailypost\\.com$', 'local.dailypost.com', 'wp_blogs', 'wp_site', '--regex', '--regex-flags=i'],
    ]);
  });

  it("replaces whole host names in a domain mapping plugin's table too", async () => {
    const calls: string[][] = [];
    const wp = async (args: string[]) => (calls.push(args), { code: 0, stdout: '', stderr: '' });
    await replaceDomains(wp, [{ from: 'dailycats.com', to: 'local.dailycats.com' }], { tables: '--all-tables', multisite: true, prefix: 'wp_', domainMapping: true });
    expect(calls.find((a) => a.includes('--regex'))).toEqual(['search-replace', '^dailycats\\.com$', 'local.dailycats.com', 'wp_blogs', 'wp_site', 'wp_domain_mapping', '--regex', '--regex-flags=i']);
  });
});

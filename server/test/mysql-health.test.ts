import { describe, expect, it } from 'vitest';
import type { JobRuntime, JobStep } from '../src/jobs.js';
import { CORE_SCHEMA, planFixTable, planFixTables, planToInnodb, wordpressHealth } from '../src/mysql-health.js';
import type { RowsContext } from '../src/mysql-rows.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };
const json = (...rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).join('\n');
const CORE = ['options', 'posts', 'postmeta', 'comments', 'commentmeta', 'terms', 'term_taxonomy', 'term_relationships', 'termmeta', 'users', 'usermeta'];
const TABLES = CORE.map((c) => `wp_${c}`);

/**
 * shop_com as MySQL lists it: every table as WordPress makes it, except
 * wp_options (MyISAM, utf8, option_name not unique with 3 repeats), wp_posts
 * (lost its primary key and AUTO_INCREMENT), wp_postmeta (no meta_key index)
 * and wp_comments (latin1).
 */
function fakeShop({ zeroIds = 0, free = [] as unknown[][] } = {}) {
  const tables = TABLES.map((t) => {
    const broken = t === 'wp_options' ? ['MyISAM', 'utf8_general_ci'] : t === 'wp_comments' ? ['InnoDB', 'latin1_swedish_ci'] : ['InnoDB', 'utf8mb4_unicode_520_ci'];
    return ['ht', t, ...broken];
  });
  const indexes: unknown[][] = [];
  const columns: unknown[][] = [];
  for (const core of CORE) {
    const t = `wp_${core}`;
    const schema = CORE_SCHEMA[core] as (typeof CORE_SCHEMA)[string];
    if (t !== 'wp_posts') schema.primary.forEach((c, i) => indexes.push(['hi', t, 'PRIMARY', 0, i + 1, c]));
    for (const index of schema.indexes) {
      if (t === 'wp_postmeta' && index.name === 'meta_key') continue;
      const unique = index.unique && t !== 'wp_options' ? 0 : 1;
      index.columns.forEach((c, i) => indexes.push(['hi', t, index.name, unique, i + 1, c.replace(/\(\d+\)$/, '')]));
    }
    if (schema.autoIncrement) columns.push(['hc', t, schema.autoIncrement, 'bigint(20) unsigned', t === 'wp_posts' ? '' : 'auto_increment']);
  }
  return fakeExec({
    mysqldump: () => ({ stdout: 'DROP TABLE IF EXISTS `wp_posts`;\n' }),
    mysql: (call: FakeCall) => {
      if (call.args.includes('-e')) return { stdout: '8.0.43\n' };
      const sql = call.input ?? '';
      if (sql.includes('SELECT TABLE_NAME FROM information_schema.TABLES')) return { stdout: `${TABLES.join('\n')}\n` };
      if (sql.includes("JSON_ARRAY('ht'")) return { stdout: json(...tables, ...indexes, ...columns) };
      if (sql.includes('COUNT(DISTINCT `ID`)')) return { stdout: json([0, zeroIds]) };
      if (sql.includes('COUNT(DISTINCT `option_name`)')) return { stdout: json([3]) };
      if (sql.includes('TABLE_COLLATION LIKE')) return { stdout: 'utf8mb4_unicode_520_ci\n' };
      if (sql.includes('DATA_FREE')) return { stdout: json(...free) };
      if (sql.includes("SELECT COALESCE(ENGINE, '')")) return { stdout: sql.includes(Buffer.from('wp_done').toString('hex')) ? 'InnoDB\n' : 'MyISAM\n' };
      return { stdout: '' };
    },
  });
}

const browse = (fake: ReturnType<typeof fakeExec>) => ({ config: wpSiteTree().config, exec: fake.exec, mysql, kept: () => [] });
const rows = (fake: ReturnType<typeof fakeExec>): RowsContext => ({ ...browse(fake), siteBusy: () => false, now: () => new Date('2026-11-07T10:15:00Z') });

describe("the health of a site's WordPress tables", () => {
  it('finds lost keys, missing indexes, MyISAM and old character sets, with what blocks a fix', async () => {
    const health = await wordpressHealth(browse(fakeShop()), 'shop_com', new Set(TABLES), 'wp_', 'wp_', 1);
    expect(health.tables).toBe(11);
    expect(health.issues.map((i) => [i.table, i.problem, i.fix ?? null, i.blocked ?? null])).toEqual([
      ['wp_options', 'notUnique', null, '3 rows repeat another\'s option_name'],
      ['wp_options', 'engine', 'engine', null],
      ['wp_options', 'utf8mb3', 'charset', null],
      ['wp_posts', 'noPrimaryKey', 'keys', null],
      ['wp_postmeta', 'missingIndex', 'index', null],
      ['wp_comments', 'charset', null, null],
    ]);
  });

  it('leaves the shared users tables to the network\'s first site', async () => {
    const health = await wordpressHealth(browse(fakeShop()), 'shop_com', new Set([...TABLES, 'wp_2_options']), 'wp_', 'wp_2_', 2);
    expect(health.tables).toBe(1);
  });

  it('blocks a key fix while rows have ID 0', async () => {
    const health = await wordpressHealth(browse(fakeShop({ zeroIds: 2 })), 'shop_com', new Set(TABLES), 'wp_', 'wp_', 1);
    expect(health.issues.find((i) => i.table === 'wp_posts')).toMatchObject({ fix: 'keys', blocked: '2 rows have ID 0' });
    await expect(planFixTable(rows(fakeShop({ zeroIds: 2 })), { domain: 'local.shop.com', table: 'wp_posts', fix: 'keys' })).rejects.toThrow('Not yet: 2 rows have ID 0. Sort those rows out first, then fix it');
  });
});

describe('fixing a WordPress table', () => {
  const runAll = async (steps: JobStep[]) => {
    const undos: string[] = [];
    const job: JobRuntime = { onUndo: (label) => void undos.push(label), progress: () => undefined };
    const out: string[] = [];
    for (const step of steps) {
      const r = await step.run(job);
      for (const x of Array.isArray(r) ? r : [r]) out.push(x.code === 0 ? x.stdout : `failed: ${x.stderr}`);
    }
    return { out, undos };
  };

  it('saves the table whole, then gives it its primary key and AUTO_INCREMENT back', async () => {
    const fake = fakeShop();
    const { title, steps } = await planFixTable(rows(fake), { domain: 'local.shop.com', table: 'wp_posts', fix: 'keys' });
    expect(title).toBe('Give wp_posts its primary key back');
    const { out, undos } = await runAll(steps);
    expect(fake.calls.find((c) => c.file === 'mysqldump')?.args).toEqual(expect.arrayContaining(['shop_com', 'wp_posts']));
    const alter = fake.calls.find((c) => c.input?.includes('ALTER TABLE'))?.input ?? '';
    expect(alter).toContain('ALTER TABLE `wp_posts` ADD PRIMARY KEY (`ID`), MODIFY `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT;');
    expect(out[1]).toMatch(/Undo puts wp_posts back as it was, for 14 days$/);
    expect(undos).toEqual(['Put wp_posts back as it was']);
  });

  it('adds only the missing indexes, converts utf8 to the collation the site uses, and turns MyISAM into InnoDB', async () => {
    const index = fakeShop();
    await runAll((await planFixTable(rows(index), { domain: 'local.shop.com', table: 'wp_postmeta', fix: 'index' })).steps);
    expect(index.calls.find((c) => c.input?.includes('ALTER TABLE'))?.input).toContain('ALTER TABLE `wp_postmeta` ADD KEY `meta_key` (`meta_key`(191));');
    const charset = fakeShop();
    await runAll((await planFixTable(rows(charset), { domain: 'local.shop.com', table: 'wp_options', fix: 'charset' })).steps);
    expect(charset.calls.find((c) => c.input?.includes('ALTER TABLE'))?.input).toContain('ALTER TABLE `wp_options` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;');
    const engine = fakeShop();
    await runAll((await planFixTable(rows(engine), { domain: 'local.shop.com', table: 'wp_options', fix: 'engine' })).steps);
    expect(engine.calls.find((c) => c.input?.includes('ALTER TABLE'))?.input).toContain('ALTER TABLE `wp_options` ENGINE=InnoDB;');
  });

  it('refuses a fix the table does not need, a table that is not WordPress\'s, and latin1', async () => {
    await expect(planFixTable(rows(fakeShop()), { domain: 'local.shop.com', table: 'wp_postmeta', fix: 'engine' })).rejects.toThrow('wp_postmeta needs no such fix any more');
    await expect(planFixTable(rows(fakeShop()), { domain: 'local.shop.com', table: 'wp_wandworks_log', fix: 'engine' })).rejects.toThrow("wp_wandworks_log is not one of this site's WordPress tables");
    await expect(planFixTable(rows(fakeShop()), { domain: 'local.shop.com', table: 'wp_comments', fix: 'charset' })).rejects.toThrow('wp_comments needs no such fix any more');
  });
});

describe('space a rebuild gives back', () => {
  it('offers the tables with room worth it, and none when every table shares one InnoDB file', async () => {
    const mb = 1024 * 1024;
    const free = [['wp_postmeta', 48 * mb, 300 * mb], ['wp_options', 2 * mb, 10 * mb], ['wp_wandworks_log', 90 * mb, 120 * mb], ['wp_posts', 20 * mb, 900 * mb]];
    const health = await wordpressHealth(browse(fakeShop({ free })), 'shop_com', new Set([...TABLES, 'wp_wandworks_log', 'wp_2_options']), 'wp_', 'wp_', 1);
    expect(health.free).toEqual([{ table: 'wp_wandworks_log', freeBytes: 90 * mb, bytes: 120 * mb }, { table: 'wp_postmeta', freeBytes: 48 * mb, bytes: 300 * mb }]);
    const shared = TABLES.map((t) => [t, 512 * mb, 64 * mb]);
    expect((await wordpressHealth(browse(fakeShop({ free: shared })), 'shop_com', new Set(TABLES), 'wp_', 'wp_', 1)).free).toBeUndefined();
  });
});

describe('turning every MyISAM table into InnoDB', () => {
  const mb = 1024 * 1024;
  const runAll = async (steps: JobStep[]) => {
    const undos: string[] = [];
    const job: JobRuntime = { onUndo: (label) => void undos.push(label), progress: () => undefined };
    const out: string[] = [];
    for (const step of steps) {
      const r = await step.run(job);
      for (const x of Array.isArray(r) ? r : [r]) out.push(x.code === 0 ? x.stdout : `failed: ${x.stderr}`);
    }
    return { out, undos };
  };
  const facts = [['wp_wandworks_log', 0, 40 * mb, 'MyISAM'], ['wp_options', 0, 2 * mb, 'MyISAM'], ['wp_done', 0, mb, 'MyISAM'], ['wp_posts', 0, 90 * mb, 'InnoDB']];

  it("lists the site's MyISAM tables of every kind, the smallest first", async () => {
    const health = await wordpressHealth(browse(fakeShop({ free: facts })), 'shop_com', new Set([...TABLES, 'wp_wandworks_log', 'wp_done']), 'wp_', 'wp_', 1);
    expect(health.myisam).toEqual([{ table: 'wp_done', bytes: mb }, { table: 'wp_options', bytes: 2 * mb }, { table: 'wp_wandworks_log', bytes: 40 * mb }]);
  });

  it('saves and converts them one step a table, leaves one converted since, and Undo takes back only what it converted', async () => {
    const fake = fakeShop({ free: facts });
    const { title, steps } = await planToInnodb(rows(fake), { domain: 'local.shop.com' });
    expect(title).toBe('Turn 3 tables into InnoDB');
    expect(steps.map((x) => x.label)).toEqual(['Check the disk has room', 'Turn wp_done into InnoDB', 'Turn wp_options into InnoDB', 'Turn wp_wandworks_log into InnoDB']);
    const { out, undos } = await runAll(steps);
    expect(out.slice(1)).toEqual(['wp_done is InnoDB already: left as it is', 'wp_options is InnoDB now', 'wp_wandworks_log is InnoDB now']);
    const alters = fake.calls.filter((c) => c.input?.includes('ALTER TABLE')).map((c) => c.input?.match(/ALTER TABLE .*;/)?.[0]);
    expect(alters).toEqual(['ALTER TABLE `wp_options` ENGINE=InnoDB;', 'ALTER TABLE `wp_wandworks_log` ENGINE=InnoDB;']);
    expect(fake.calls.filter((c) => c.file === 'mysqldump').map((c) => c.args.at(-1))).toEqual(['wp_options', 'wp_wandworks_log']);
    expect(undos).toEqual(['Put the tables back as they were']);
  });

  it('refuses a site with no MyISAM table', async () => {
    await expect(planToInnodb(rows(fakeShop({ free: [['wp_posts', 0, mb, 'InnoDB']] })), { domain: 'local.shop.com' })).rejects.toThrow('This site has no MyISAM tables');
  });
});

describe('fixing every problem Table health found', () => {
  const mb = 1024 * 1024;
  const facts = [['wp_options', 0, 2 * mb, 'MyISAM'], ['wp_posts', 0, 90 * mb, 'InnoDB'], ['wp_postmeta', 0, mb, 'InnoDB']];
  const runAll = async (steps: JobStep[]) => {
    const undos: string[] = [];
    const job: JobRuntime = { onUndo: (label) => void undos.push(label), progress: () => undefined };
    const out: string[] = [];
    for (const step of steps) {
      const r = await step.run(job);
      for (const x of Array.isArray(r) ? r : [r]) out.push(x.code === 0 ? x.stdout : `failed: ${x.stderr}`);
    }
    return { out, undos };
  };

  it('fixes what the panel fixes, a table a step, the smallest first, each saved once, and leaves what needs a person', async () => {
    const fake = fakeShop({ free: facts });
    const { title, steps } = await planFixTables(rows(fake), { domain: 'local.shop.com' });
    expect(title).toBe('Fix 4 problems in 3 tables');
    expect(steps.map((x) => x.label)).toEqual(['Check the disk has room', 'Fix wp_postmeta: its indexes', 'Fix wp_options: InnoDB, utf8mb4', 'Fix wp_posts: its primary key']);
    const { undos } = await runAll(steps);
    const alters = fake.calls.filter((c) => c.input?.includes('ALTER TABLE')).map((c) => c.input?.match(/ALTER TABLE .*;/)?.[0]);
    expect(alters).toEqual([
      'ALTER TABLE `wp_postmeta` ADD KEY `meta_key` (`meta_key`(191));',
      'ALTER TABLE `wp_options` ENGINE=InnoDB;',
      'ALTER TABLE `wp_options` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;',
      'ALTER TABLE `wp_posts` ADD PRIMARY KEY (`ID`), MODIFY `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT;',
    ]);
    // wp_options is saved once for its two fixes; wp_comments (latin1) and the repeated option names are left to a person.
    expect(fake.calls.filter((c) => c.file === 'mysqldump').map((c) => c.args.at(-1))).toEqual(['wp_postmeta', 'wp_options', 'wp_posts']);
    expect(undos).toEqual(['Put the tables back as they were']);
  });

  it("turns a plugin's MyISAM table into InnoDB too, and does only the tables asked for", async () => {
    const withLog = [...facts, ['wp_wandworks_log', 0, 3 * mb, 'MyISAM']];
    const all = await planFixTables(rows(fakeShop({ free: withLog })), { domain: 'local.shop.com' });
    expect(all.steps.map((x) => x.label)).toContain('Fix wp_wandworks_log: InnoDB');
    const fake = fakeShop({ free: withLog });
    const one = await planFixTables(rows(fake), { domain: 'local.shop.com', tables: ['wp_wandworks_log'] });
    expect(one.title).toBe('Fix wp_wandworks_log');
    await runAll(one.steps);
    expect(fake.calls.filter((c) => c.input?.includes('ALTER TABLE')).map((c) => c.input?.match(/ALTER TABLE .*;/)?.[0])).toEqual(['ALTER TABLE `wp_wandworks_log` ENGINE=InnoDB;']);
    await expect(planFixTables(rows(fakeShop({ free: facts })), { domain: 'local.shop.com', tables: ['wp_terms'] })).rejects.toThrow('wp_terms needs no fix the panel makes any more');
  });

  it('leaves out a key fix that rows block', async () => {
    const { steps } = await planFixTables(rows(fakeShop({ zeroIds: 2, free: facts })), { domain: 'local.shop.com' });
    expect(steps.map((x) => x.label)).not.toContain('Fix wp_posts: its primary key');
  });
});

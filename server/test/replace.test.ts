import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import { ANY_HOST } from '../src/sites/dump.js';
import { checkAddresses, collapseWarnings, groupCount, longerHosts, passTimeout, runPasses, searchedHost, splitTables, sqlFirstPlan, tablesToSearch } from '../src/sites/replace.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

/**
 * A WP-CLI that lists these tables and sizes, records every search and
 * replace with its timeout, and can hold or fail one. Other queries go to
 * query, and are recorded with what came on stdin.
 */
function fakeWp(
  tables: Record<string, number>,
  answer: (args: string[]) => ExecResult | Promise<ExecResult> = () => ok('Success: Made 3 replacements.'),
  query: (sql: string, input?: string) => ExecResult = () => ok(),
) {
  const calls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
  const queries: Array<{ sql: string; input?: string | undefined }> = [];
  let running = 0;
  let most = 0;
  const wp = async (args: string[], timeoutMs?: number, input?: string): Promise<ExecResult> => {
    if (args[0] === 'db' && args[1] === 'tables') return ok(Object.keys(tables).join('\n'));
    if (args[0] === 'db' && args[2]?.startsWith('SELECT TABLE_NAME')) return ok(Object.entries(tables).map(([n, b]) => `${n}\t${b}`).join('\n'));
    if (args[0] === 'db' && args[1] === 'query') {
      const sql = args[2]?.startsWith('--') ? '' : (args[2] ?? '');
      queries.push({ sql, input });
      return query(sql, input);
    }
    calls.push({ args, timeoutMs });
    running++;
    most = Math.max(most, running);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await answer(args);
    } finally {
      running--;
    }
  };
  /** The passes one table got, as "search replace". */
  const on = (table: string) => calls.filter((c) => c.args.includes(table)).map((c) => `${c.args[1]} ${c.args[2]}`);
  return { wp, calls, queries, on, most: () => most };
}

const PASSES = [
  ['//acme.com', '//local.acme.com'],
  ['\\/\\/acme.com', '\\/\\/local.acme.com'],
] as const;

describe('groups of tables', () => {
  it('runs at most 4 groups, half the cores and one per 2 GB of free memory', () => {
    expect(groupCount(16, 20 * GB)).toBe(4);
    expect(groupCount(4, 20 * GB)).toBe(2);
    expect(groupCount(16, 5 * GB)).toBe(2);
    expect(groupCount(2, GB)).toBe(1);
  });

  it('splits tables into groups of about the same size, biggest first, none in two', () => {
    const tables = [
      { name: 'wp_postmeta', bytes: 8 * GB },
      { name: 'wp_posts', bytes: 3 * GB },
      { name: 'wp_options', bytes: 2 * GB },
      { name: 'wp_comments', bytes: 2 * GB },
      { name: 'wp_users', bytes: MB },
    ];
    const groups = splitTables(tables, 3);
    expect(groups.map((g) => g.map((t) => t.name))).toEqual([['wp_postmeta'], ['wp_posts', 'wp_users'], ['wp_comments', 'wp_options']]);
    expect(groups.flat().map((t) => t.name).sort()).toEqual(tables.map((t) => t.name).sort());
    // Of unknown size: spread over the groups all the same.
    expect(splitTables([{ name: 'a', bytes: 0 }, { name: 'b', bytes: 0 }, { name: 'c', bytes: 0 }], 2).map((g) => g.length)).toEqual([2, 1]);
    expect(splitTables([{ name: 'a', bytes: 1 }], 4)).toHaveLength(1);
  });

  it('gives each pass an hour, and half an hour more for each GB it reads', () => {
    expect(passTimeout(0)).toBe(60 * 60_000);
    expect(passTimeout(8 * GB)).toBe(300 * 60_000);
    expect(passTimeout(GB + 1)).toBe(120 * 60_000);
  });
});

describe('the tables a search and replace looks at', () => {
  const tables = ['wp_options', 'wp_posts', 'wp_actionscheduler_logs', 'wp_leftover', 'wp_links'].map((name) => ({ name, bytes: MB }));
  const hosts = { wp_options: ['acme.com'], wp_posts: ['cdn.Acme.com', 'acme.com.au'], wp_actionscheduler_logs: [], wp_links: [ANY_HOST] };

  it('reads the host a pass looks for, whatever the form', () => {
    expect(['//acme.com', '\\/\\/acme.com', 'http://acme.com', 'http:\\/\\/Acme.com:8080', '//acme.com/fr/'].map(searchedHost)).toEqual(['acme.com', 'acme.com', 'acme.com', 'acme.com', 'acme.com']);
    expect(searchedHost('acme.com')).toBeUndefined();
  });

  it('leaves out a table the dump made with none of the hosts, and keeps one it did not make or cannot list', () => {
    expect(tablesToSearch(tables, PASSES, hosts).map((t) => t.name)).toEqual(['wp_options', 'wp_posts', 'wp_leftover', 'wp_links']);
    // Hosts are compared in lower case, so a table is never left out for case alone.
    expect(tablesToSearch(tables, [['//cdn.acme.com', '//cdn.local.acme.com']], hosts).map((t) => t.name)).toEqual(['wp_posts', 'wp_leftover', 'wp_links']);
  });

  it('looks at every table without the scan, or for a search that is no address', () => {
    expect(tablesToSearch(tables, PASSES, undefined)).toHaveLength(5);
    expect(tablesToSearch(tables, [['acme.com', 'local.acme.com']], hosts)).toHaveLength(5);
  });

  it('finds the hosts a pass would only change because they start like its address', () => {
    expect(longerHosts(PASSES, { a: ['acme.com', 'acme.com.au', 'acme.community', 'shop.acme.com', 'Acme.com.br'], b: ['acme.com.au.cdn.net', ANY_HOST] })).toEqual([
      'acme.com.au.cdn.net',
      'acme.community',
      'acme.com.au',
    ]);
    // Replaced on purpose, or only a path that starts the same: nothing to keep.
    expect(longerHosts([...PASSES, ['//acme.com.au', '//local.acme.com.au']], { a: ['acme.com.au'] })).toEqual([]);
    expect(longerHosts([['//acme.com/fr/', '//fr.local.acme.com/']], { a: ['acme.com.au'] })).toEqual([]);
  });
});

describe('running the passes', () => {
  it('runs the groups at once, each table getting every pass in order, only on the tables that could change', async () => {
    const f = fakeWp({ wp_postmeta: 6 * GB, wp_posts: 2 * GB, wp_options: MB, wp_comments: 3 * GB });
    const tableHosts = { wp_postmeta: ['acme.com'], wp_posts: ['acme.com'], wp_options: ['acme.com'], wp_comments: [] };
    const notes: string[] = [];
    const results = await runPasses(f.wp, PASSES, { flag: '--all-tables-with-prefix', tableHosts, groups: 3, job: { onUndo: () => undefined, progress: () => undefined, activity: (l) => notes.push(l) } });
    expect(results.every((r) => r.code === 0)).toBe(true);
    for (const table of ['wp_postmeta', 'wp_posts', 'wp_options']) expect(f.on(table)).toEqual(['//acme.com //local.acme.com', '\\/\\/acme.com \\/\\/local.acme.com']);
    expect(f.on('wp_comments')).toEqual([]);
    expect(f.most()).toBe(3);
    // The flag stays: WP-CLI only keeps plugin tables named with it.
    expect(f.calls.every((c) => c.args.includes('--all-tables-with-prefix') && c.args.includes('--skip-columns=guid'))).toBe(true);
    expect(f.calls.find((c) => c.args.includes('wp_postmeta'))?.timeoutMs).toBe(passTimeout(6 * GB));
    expect(notes).toEqual(['left out 1 of 4 tables: the dump has none of these addresses in them', '3 tables in 3 groups at once']);
  });

  it('sets a longer host aside before the passes and puts it back after, in the tables that have it', async () => {
    const f = fakeWp({ wp_posts: GB, wp_options: MB, wp_leftover: MB });
    const tableHosts = { wp_posts: ['acme.com', 'acme.com.au'], wp_options: ['acme.com'] };
    const results = await runPasses(f.wp, PASSES, { flag: '--all-tables', tableHosts, groups: 1 });
    const posts = f.on('wp_posts');
    const token = /^\/\/acme\.com\.au \/\/(dmp-keep-[0-9a-f]{8}-0000)$/.exec(posts[0] ?? '')?.[1] as string;
    expect(token).toBeDefined();
    expect(posts).toEqual([
      `//acme.com.au //${token}`,
      `\\/\\/acme.com.au \\/\\/${token}`,
      '//acme.com //local.acme.com',
      '\\/\\/acme.com \\/\\/local.acme.com',
      `//${token} //acme.com.au`,
      `\\/\\/${token} \\/\\/acme.com.au`,
    ]);
    // wp_options has no acme.com.au; a table the dump did not make might.
    expect(f.on('wp_options')).toEqual(['//acme.com //local.acme.com', '\\/\\/acme.com \\/\\/local.acme.com']);
    expect(f.on('wp_leftover')).toHaveLength(6);
    expect(results[0]?.stdout).toBe('kept as they are: acme.com.au (they start like a replaced host)');
  });

  it('lets the other groups finish when one fails, and fails the step', async () => {
    const f = fakeWp({ wp_posts: GB, wp_options: GB }, (args) => (args.includes('wp_posts') ? { code: 1, stdout: '', stderr: 'Error: Table is full' } : ok()));
    const results = await runPasses(f.wp, PASSES, { flag: '--all-tables', groups: 2 });
    expect(f.on('wp_posts')).toHaveLength(1);
    expect(f.on('wp_options')).toHaveLength(2);
    expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual(['Error: Table is full']);
  });

  it('runs every pass on every table, one after the other, when the tables cannot be listed', async () => {
    const calls: string[][] = [];
    const wp = async (args: string[]) => {
      calls.push(args);
      return args[1] === 'tables' ? { code: 1, stdout: '', stderr: 'Error establishing a database connection' } : ok();
    };
    await runPasses(wp, PASSES, { flag: '--all-tables', tableHosts: { wp_posts: [] } });
    expect(calls.filter((a) => a[0] === 'search-replace')).toEqual([
      ['search-replace', '//acme.com', '//local.acme.com', '--all-tables', '--skip-columns=guid', '--report-changed-only'],
      ['search-replace', '\\/\\/acme.com', '\\/\\/local.acme.com', '--all-tables', '--skip-columns=guid', '--report-changed-only'],
    ]);
  });

  it('says so and runs nothing when no table has the addresses', async () => {
    const f = fakeWp({ wp_posts: GB });
    expect(await runPasses(f.wp, PASSES, { flag: '--all-tables', tableHosts: { wp_posts: ['other.com'] } })).toEqual([ok('no table has these addresses: nothing to replace')]);
    expect(f.calls).toEqual([]);
  });
});

/** wp_postmeta as information_schema describes it, and the probe: keys 1 to 120000, serialized values in meta_value only. */
const POSTMETA_COLUMNS = ['meta_id\tbigint\tPRI\tauto_increment', 'post_id\tbigint\tMUL\t', 'meta_key\tvarchar\tMUL\t', 'meta_value\tlongtext\t\t', 'guid\tvarchar\t\t'].join('\n');
function postmetaQueries(log: string[], columns = POSTMETA_COLUMNS, probe = '1\t120000\t0\t1') {
  return (sql: string, input?: string): ExecResult => {
    if (sql.includes('information_schema.COLUMNS')) return ok(columns);
    if (sql.startsWith('SELECT MIN(')) return ok(probe);
    if (input) {
      log.push(`sql ${/REPLACE\(`meta_value`, ('[^']*'), /.exec(input)?.[1]}`);
      return input.includes('FAIL') ? { code: 1, stdout: '', stderr: 'ERROR 1205: Lock wait timeout exceeded' } : ok(input.split('ROW_COUNT()').slice(1).map(() => '2').join('\n'));
    }
    return ok();
  };
}

describe('big tables WP-CLI would go through a row at a time', () => {
  it('get each pass in SQL first, by ranges of keys, on the values that are not serialized, then the WP-CLI pass', async () => {
    const log: string[] = [];
    const notes: string[] = [];
    const f = fakeWp(
      { wp_postmeta: GB, wp_options: MB },
      (args) => {
        log.push(`wp ${args[1]} ${args.filter((a) => a.startsWith('wp_')).join(',')}`);
        return ok('Success: Made 0 replacements.');
      },
      postmetaQueries(log),
    );
    const results = await runPasses(f.wp, PASSES, { flag: '--all-tables', groups: 1, job: { onUndo: () => undefined, progress: () => undefined, activity: (l) => notes.push(l) } });
    expect(log).toEqual([
      "sql '//acme.com'",
      'wp //acme.com wp_postmeta,wp_options',
      "sql '\\\\/\\\\/acme.com'",
      'wp \\/\\/acme.com wp_postmeta,wp_options',
    ]);
    const batch = f.queries.find((q) => q.input)?.input as string;
    expect(batch.split('\n')).toEqual(
      [
        [1, 50000],
        [50001, 100000],
        [100001, 120000],
      ].map(
        ([lo, hi]) =>
          `UPDATE \`wp_postmeta\` SET \`meta_value\` = IF(SUBSTRING(\`meta_value\`, 2, 1) = ':' OR LEFT(\`meta_value\`, 2) = 'N;', \`meta_value\`, REPLACE(\`meta_value\`, '//acme.com', '//local.acme.com')) WHERE \`meta_id\` BETWEEN ${lo} AND ${hi}; SELECT ROW_COUNT();`,
      ),
    );
    // Only the big table is looked at, once.
    expect(f.queries.filter((q) => q.sql.includes('information_schema.COLUMNS'))).toHaveLength(1);
    expect(f.queries.find((q) => q.sql.startsWith('SELECT MIN('))?.sql).toBe(
      "SELECT MIN(`meta_id`), MAX(`meta_id`), EXISTS(SELECT 1 FROM `wp_postmeta` WHERE `meta_key` REGEXP '^[aiO]:[1-9]'), EXISTS(SELECT 1 FROM `wp_postmeta` WHERE `meta_value` REGEXP '^[aiO]:[1-9]') FROM `wp_postmeta`",
    );
    expect(results.map((r) => r.stdout)).toContain('wp_postmeta: 6 rows changed with SQL, serialized values left to WP-CLI');
    expect(notes).toContain('wp_postmeta: plain values in meta_value replaced with SQL, WP-CLI only goes through the serialized ones');
  });

  it('stop the group when the SQL fails, before the WP-CLI pass', async () => {
    const log: string[] = [];
    const f = fakeWp({ wp_postmeta: GB }, () => ok(), postmetaQueries(log));
    const results = await runPasses(f.wp, [['//FAIL.com', '//local.fail.com']], { flag: '--all-tables', groups: 1 });
    expect(f.calls).toEqual([]);
    expect(results.at(-1)?.stderr).toBe('ERROR 1205: Lock wait timeout exceeded');
  });

  it('are left to WP-CLI alone for a dry run', async () => {
    const f = fakeWp({ wp_postmeta: GB }, () => ok(), postmetaQueries([]));
    await runPasses(f.wp, PASSES, { flag: '--all-tables', groups: 1, extra: ['--dry-run'] });
    expect(f.queries).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it('need serialized values somewhere, one whole-number key and rows', async () => {
    const plan = (columns: string, probe: string) => sqlFirstPlan(fakeWp({}, () => ok(), postmetaQueries([], columns, probe)).wp, 'wp_postmeta');
    expect(await plan(POSTMETA_COLUMNS, '1\t120000\t0\t1')).toEqual({ table: 'wp_postmeta', key: 'meta_id', columns: ['meta_value'], min: 1, max: 120000 });
    expect(await plan(POSTMETA_COLUMNS, '1\t120000\t0\t0')).toBeNull();
    expect(await plan(POSTMETA_COLUMNS, 'NULL\tNULL\t0\t0')).toBeNull();
    expect(await plan(POSTMETA_COLUMNS.replace('MUL', 'PRI'), '1\t120000\t0\t1')).toBeNull();
    expect(await plan(POSTMETA_COLUMNS.replace('bigint', 'varchar'), '1\t120000\t0\t1')).toBeNull();
    // A generated column cannot be written, and guid is never searched.
    expect(await plan(`${POSTMETA_COLUMNS}\nsummary\ttext\t\tVIRTUAL GENERATED`, '1\t9\t0\t1')).toEqual(expect.objectContaining({ columns: ['meta_value'] }));
    // A column with an expression default (MySQL 8 says DEFAULT_GENERATED) is an ordinary column.
    expect(await plan(`${POSTMETA_COLUMNS}\nnote\tvarchar\t\tDEFAULT_GENERATED`, '1\t9\t0\t1\t1')).toEqual(expect.objectContaining({ columns: ['meta_value', 'note'] }));
    expect(await sqlFirstPlan(fakeWp({}).wp, 'wp_post`meta')).toBeNull();
  });
});

describe("WP-CLI's warnings", () => {
  it('about objects of classes it did not load come as one line', () => {
    const warn = (name: string) => `Warning: Skipping an uninitialized class "${name}", replacements might not be complete.`;
    const stderr = [warn('Acme_Plan'), warn('Acme_Plan'), warn('Acme\\Logger\\Item'), 'Warning: something else'].join('\n');
    expect(collapseWarnings({ code: 0, stdout: 'Success: Made 4 replacements.', stderr })).toEqual({
      code: 0,
      stdout: 'Success: Made 4 replacements.',
      stderr: 'Warning: something else\nWarning: 3 serialized objects of plugin classes not loaded during the replace (Acme_Plan, Acme\\Logger\\Item) left as they are; addresses inside them did not change.',
    });
    expect(collapseWarnings(ok('x'))).toEqual(ok('x'));
  });
});

describe('the check after the replace', () => {
  const site = (answers: Record<string, string>) => async (args: string[]) => {
    const sql = args[2] ?? '';
    const key = Object.keys(answers).find((k) => sql.startsWith(k));
    return key ? ok(answers[key]) : { code: 1, stdout: '', stderr: `not faked: ${sql}` };
  };

  it('passes when home and siteurl left the production hosts', async () => {
    const wp = site({ 'SELECT 1,': '1\thome\thttps://local.acme.com\n1\tsiteurl\thttps://local.acme.com/wp\n' });
    expect(await checkAddresses(wp, { prefix: 'wp_', multisite: false, from: ['www.acme.com', 'acme.com'] })).toEqual(ok('home and siteurl of the site no longer use www.acme.com, acme.com'));
  });

  it("names each network site still on one, in its options or its blogs row, and reads every site's options in one charset", async () => {
    let options = '';
    const wp = async (args: string[]) => {
      const sql = args[2] ?? '';
      if (sql.startsWith('SELECT blog_id')) return ok('1\tlocal.acme.com\t/\n2\tacme.com.au\t/\n3\tshop.acme.com:8080\t/\n');
      options = sql;
      return ok('1\thome\thttps://local.acme.com\n2\thome\thttps://acme.com.au\n3\tsiteurl\thttp://shop.acme.com:8080/\n');
    };
    const r = await checkAddresses(wp, { prefix: 'wp_', multisite: true, from: ['acme.com.au', 'shop.acme.com:8080'] });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'still on a production address: site 2 is still at acme.com.au/ in wp_blogs; site 3 is still at shop.acme.com:8080/ in wp_blogs; site 2 home is still https://acme.com.au; site 3 siteurl is still http://shop.acme.com:8080/',
    );
    expect(options).toContain('FROM `wp_options`');
    expect(options).toContain('FROM `wp_2_options`');
    expect(options).toContain('FROM `wp_3_options`');
    // Options tables of mixed collations would make MySQL refuse the UNION.
    expect(options.match(/CONVERT\(option_name USING utf8mb4\), CONVERT\(option_value USING utf8mb4\) FROM/g)).toHaveLength(3);
  });
});

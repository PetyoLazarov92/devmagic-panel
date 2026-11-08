import type { WpDbReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { cleanupRows, healthRows, wordpressFindings } from '../src/lib/wp-findings.js';

const MB = 1024 * 1024;
const base: WpDbReport = { database: 'wandworks', prefix: 'wp_', blog: 1, blogPrefix: 'wp_', missingTables: [], errors: {}, checkedAt: '2026-11-07T10:00:00Z' };

describe('wordpressFindings', () => {
  it('says nothing about a database that is fine, or parts not read yet', () => {
    expect(wordpressFindings(base)).toEqual([]);
    expect(wordpressFindings({ ...base, autoload: { count: 300, bytes: 0.5 * MB, limitBytes: MB, top: [] }, transients: { count: 10, bytes: 100, expired: 0 } })).toEqual([]);
  });

  it('lists each card that found something, a lost key first', () => {
    const r: WpDbReport = {
      ...base,
      autoload: { count: 900, bytes: 1.5 * MB, limitBytes: MB, top: [] },
      transients: { count: 40, bytes: 1000, expired: 12 },
      health: { tables: 12, issues: [{ table: 'wp_posts', problem: 'noPrimaryKey' } as never, { table: 'wp_options', problem: 'engine' } as never] },
      plugins: { tables: [{ table: 'wp_wandworks_log', bytes: 10, rows: 1, plugin: 'Wandworks Log', state: 'missing' }], autoload: [{ plugin: 'Wandworks Forms', slug: 'wandworks-forms', state: 'inactive', count: 4, bytes: 200, options: [] }] },
      content: { revisions: 140, autoDrafts: 2, trashedPosts: 0, spamComments: 0, trashedComments: 0 } as never,
    };
    expect(wordpressFindings(r)).toEqual([
      { card: 'wp-health', tone: 'danger', text: '2 tables to fix, 1 with a lost key' },
      { card: 'wp-autoload', tone: 'warning', text: 'Autoload is 1.5 MB, over 1.0 MB' },
      { card: 'wp-transients', tone: 'warning', text: '12 expired transients' },
      { card: 'wp-plugins', tone: 'warning', text: '1 table of plugins that are gone, 4 options loaded for plugins that are off' },
      { card: 'wp-cleanup', tone: 'warning', text: '142 rows to clean up' },
    ]);
  });

  it('leaves a few revisions alone', () => {
    expect(wordpressFindings({ ...base, content: { revisions: 20, autoDrafts: 1, trashedPosts: 0, spamComments: 0, trashedComments: 0 } as never })).toEqual([]);
  });

  it('counts the rows the clean-up card ticks: caches, logs, sessions and repeats too, never saved logins', () => {
    const r: WpDbReport = {
      ...base,
      content: { revisions: 1000, autoDrafts: 10, trashedPosts: 5, spamComments: 20, trashedComments: 3, akismet: 400, oembed: 30, actionsDone: 2500, wcSessions: 70, sessionTokens: 9 } as never,
      orphans: { postmeta: 100, commentmeta: 2, termmeta: 0, termRelationships: 6, usermeta: 1 },
      duplicates: { rows: 44, keys: [] },
    };
    expect(cleanupRows(r)).toBe(1000 + 10 + 5 + 20 + 3 + 400 + 30 + 2500 + 70 + 109 + 44);
    expect(wordpressFindings(r).find((f) => f.card === 'wp-cleanup')?.text).toBe('4,191 rows to clean up');
  });

  it("lists each table once with all its problems, a plugin's MyISAM table too, a lost key first", () => {
    const rows = healthRows({
      tables: 11,
      issues: [
        { table: 'wp_options', problem: 'notUnique', text: '3 rows repeat', blocked: '3 rows repeat' },
        { table: 'wp_options', problem: 'engine', text: 'MyISAM', fix: 'engine' },
        { table: 'wp_options', problem: 'utf8mb3', text: 'utf8', fix: 'charset' },
        { table: 'wp_comments', problem: 'charset', text: 'latin1' },
        { table: 'wp_posts', problem: 'noPrimaryKey', text: 'no key', fix: 'keys' },
      ],
      myisam: [{ table: 'wp_wandworks_log', bytes: 10 }, { table: 'wp_options', bytes: 20 }],
    });
    expect(rows.map((r) => [r.table, r.issues.map((i) => i.problem), r.fixes, r.wordpress, r.danger])).toEqual([
      ['wp_posts', ['noPrimaryKey'], 1, true, true],
      ['wp_options', ['notUnique', 'engine', 'utf8mb3'], 2, true, false],
      ['wp_wandworks_log', ['engine'], 1, false, false],
      ['wp_comments', ['charset'], 0, true, false],
    ]);
    expect(wordpressFindings({ ...base, health: { tables: 11, issues: [], myisam: [{ table: 'wp_wandworks_log', bytes: 10 }] } })).toEqual([{ card: 'wp-health', tone: 'warning', text: '1 table to fix' }]);
  });
});

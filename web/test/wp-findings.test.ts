import type { WpDbReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { wordpressFindings } from '../src/lib/wp-findings.js';

const MB = 1024 * 1024;
const base: WpDbReport = { database: 'acme', prefix: 'wp_', blog: 1, blogPrefix: 'wp_', missingTables: [], errors: {}, checkedAt: '2026-11-07T10:00:00Z' };

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
      plugins: { tables: [{ table: 'wp_acme_log', bytes: 10, rows: 1, plugin: 'Acme Log', state: 'missing' }], autoload: [{ plugin: 'Acme Forms', slug: 'acme-forms', state: 'inactive', count: 4, bytes: 200, options: [] }] },
      content: { revisions: 140, autoDrafts: 2, trashedPosts: 0, spamComments: 0, trashedComments: 0 } as never,
    };
    expect(wordpressFindings(r)).toEqual([
      { card: 'wp-health', tone: 'danger', text: '2 table problems, 1 with a lost key' },
      { card: 'wp-autoload', tone: 'warning', text: 'Autoload is 1.5 MB, over 1.0 MB' },
      { card: 'wp-transients', tone: 'warning', text: '12 expired transients' },
      { card: 'wp-plugins', tone: 'warning', text: '1 table of plugins that are gone, 4 options loaded for plugins that are off' },
      { card: 'wp-cleanup', tone: 'warning', text: '142 rows to clean up' },
    ]);
  });

  it('leaves a few revisions alone', () => {
    expect(wordpressFindings({ ...base, content: { revisions: 20, autoDrafts: 1, trashedPosts: 0, spamComments: 0, trashedComments: 0 } as never })).toEqual([]);
  });
});

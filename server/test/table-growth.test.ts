import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/store.js';
import { tableGrowth } from '../src/table-growth.js';

const mb = 1024 * 1024;

describe('what grows', () => {
  it('notes the sizes once a day and shows the tables that grew most since the oldest note', () => {
    const store = new RunStore(':memory:');
    const first = tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: 10 * mb }, { table: 'wp_acme_log', bytes: 40 * mb }], new Date('2026-10-28T09:00:00Z'));
    expect(first).toEqual({ since: '2026-10-28', days: 0, tables: [] });
    // The same day again replaces the day's note.
    tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: 10 * mb }, { table: 'wp_acme_log', bytes: 41 * mb }], new Date('2026-10-28T18:00:00Z'));
    const later = tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: 10.5 * mb }, { table: 'wp_acme_log', bytes: 160 * mb }, { table: 'wp_new', bytes: 3 * mb }], new Date('2026-11-07T09:00:00Z'));
    expect(later).toEqual({ since: '2026-10-28', days: 10, tables: [{ table: 'wp_acme_log', bytes: 160 * mb, grewBytes: 119 * mb }, { table: 'wp_new', bytes: 3 * mb, grewBytes: 3 * mb }] });
  });

  it('keeps 30 days of notes', () => {
    const store = new RunStore(':memory:');
    tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: mb }], new Date('2026-09-01T09:00:00Z'));
    tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: 2 * mb }], new Date('2026-10-20T09:00:00Z'));
    expect(tableGrowth(store, 'shop_com#1', [{ table: 'wp_options', bytes: 9 * mb }], new Date('2026-11-07T09:00:00Z')).since).toBe('2026-10-20');
  });
});

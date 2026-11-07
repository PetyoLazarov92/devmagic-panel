import type { WpDbReport } from '@devmagic-panel/shared';
import type { RunStore } from './store.js';

/**
 * The size of a database's tables, noted once a day when the WordPress view
 * opens, kept 30 days in the panel's database: names and sizes only. What
 * grew most since the oldest note is what keeps filling the disk.
 */
const KEEP_DAYS = 30;
const MIN_GROWTH = 1024 * 1024;

interface Reading {
  date: string;
  sizes: Record<string, number>;
}

const key = (database: string) => `db-sizes:${database}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function tableGrowth(store: RunStore, database: string, sizes: Array<{ table: string; bytes: number }>, now = new Date()): NonNullable<WpDbReport['growth']> {
  let readings: Reading[] = [];
  try {
    readings = JSON.parse(store.getMeta(key(database)) ?? '[]') as Reading[];
  } catch {
    readings = [];
  }
  const today = day(now);
  const oldest = day(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  readings = [...readings.filter((r) => r.date >= oldest && r.date !== today), { date: today, sizes: Object.fromEntries(sizes.map((s) => [s.table, s.bytes])) }].sort((a, b) => a.date.localeCompare(b.date));
  store.setMeta(key(database), JSON.stringify(readings));
  const first = readings[0] as Reading;
  const days = Math.round((Date.parse(today) - Date.parse(first.date)) / 86_400_000);
  const tables = days === 0 ? [] : sizes
    .map((s) => ({ table: s.table, bytes: s.bytes, grewBytes: s.bytes - (first.sizes[s.table] ?? 0) }))
    .filter((t) => t.grewBytes >= MIN_GROWTH)
    .sort((a, b) => b.grewBytes - a.grewBytes)
    .slice(0, 5);
  return { since: first.date, days, tables };
}

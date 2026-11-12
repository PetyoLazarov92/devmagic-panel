import { describe, expect, it } from 'vitest';
import { tileSpan } from '../src/lib/tile-span.js';

// Each row of a six-column grid adds up to six, so no row of a site's tiles stops short.
const rows = (count: number, prefix: string, perRow: number) => {
  const spans = Array.from({ length: count }, (_, i) => Number(new RegExp(`(?:^| )${prefix}col-span-(\\d)`).exec(tileSpan(i, count))?.[1]));
  return Array.from({ length: Math.ceil(count / perRow) }, (_, r) => spans.slice(r * perRow, r * perRow + perRow).reduce((a, b) => a + b, 0));
};

describe('tileSpan', () => {
  it('fills every row of two and of three', () => {
    for (const count of [3, 4, 5, 6]) {
      expect(rows(count, '', 2).every((sum) => sum === 6)).toBe(true);
      expect(rows(count, '@xl:', 3).every((sum) => sum === 6)).toBe(true);
    }
  });

  it('lets the last two of five share their row', () => {
    expect(tileSpan(3, 5)).toBe('col-span-3 @xl:col-span-3');
    expect(tileSpan(4, 5)).toBe('col-span-6 @xl:col-span-3');
  });
});

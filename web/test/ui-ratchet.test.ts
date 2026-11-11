import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The parts in components/ui are the only place that draws buttons, tinted boxes, spinners and
 * odd text sizes; a page uses the parts. Each count below is how many old hand-made copies are
 * left outside components/ui and the mockup's parts page. A change may only lower a count, and
 * then lowers it here too, so a copy that is gone stays gone. At 0 the rule holds everywhere.
 */
const BASELINE: Record<keyof typeof PATTERNS, number> = {
  rawButton: 97,
  pxText: 198,
  statusTint: 65,
  handCard: 64,
  handSpinner: 138,
  handLink: 50,
  reloadWord: 2,
  rawDl: 22,
};

const PATTERNS = {
  /** A <button> made by hand: use Button, IconButton, FilterChips, a Menu or a row part. */
  rawButton: /<button[\s>]/g,
  /** A text size in pixels: text-dense, text-xs, text-2xs or text-sm instead. */
  pxText: /\btext-\[\d+(?:\.\d+)?px\]/g,
  /** A status colour as a fill outside a badge or notice: Notice, Badge or StatusBadge. */
  statusTint: /\bbg-(?:warning|danger|success)\/\d+/g,
  /** A card drawn by hand: Card and its parts. */
  handCard: /\brounded-xl border\b/g,
  /** A spinner by hand: Spinner. */
  handSpinner: /<LoaderCircle\b/g,
  /** A link styled by hand: TextLink. */
  handLink: /\btext-primary\b[^"'`]*\bhover:underline\b|\bhover:underline\b[^"'`]*\btext-primary\b/g,
  /** Reading a view again is Check again, never Reload or Refresh. */
  reloadWord: />\s*(?:Reload|Refresh|Read again)\s*</g,
  /** A list of facts by hand: KeyValue. */
  rawDl: /<dl[\s>]/g,
};

const SRC = join(import.meta.dirname, '..', 'src');
const OWN = [join('components', 'ui') + '/', join('pages', 'ui-kit.tsx')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

function counts(): { totals: Record<string, number>; where: Record<string, Record<string, number>> } {
  const totals: Record<string, number> = {};
  const where: Record<string, Record<string, number>> = {};
  for (const file of files(SRC)) {
    const name = relative(SRC, file);
    if (OWN.some((own) => name.startsWith(own))) continue;
    const text = readFileSync(file, 'utf8');
    for (const [key, pattern] of Object.entries(PATTERNS)) {
      const n = text.match(pattern)?.length ?? 0;
      if (!n) continue;
      totals[key] = (totals[key] ?? 0) + n;
      (where[key] ??= {})[name] = n;
    }
  }
  return { totals, where };
}

describe('ui ratchet', () => {
  const { totals, where } = counts();
  for (const key of Object.keys(PATTERNS) as Array<keyof typeof PATTERNS>) {
    it(`${key}: no more hand-made copies than before, and a lower count is written down`, () => {
      const now = totals[key] ?? 0;
      const files = Object.entries(where[key] ?? {}).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}: ${n}`).join('\n');
      expect(now, `${key} went from ${BASELINE[key]} to ${now}. ${now > BASELINE[key] ? 'Use the part from components/ui instead.' : `Lower BASELINE.${key} to ${now} in web/test/ui-ratchet.test.ts.`}\n${files}`).toBe(BASELINE[key]);
    });
  }
});

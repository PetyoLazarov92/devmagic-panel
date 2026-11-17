import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The source of one entry of the mock API, up to the next entry. */
const entry = (source: string, name: string) => {
  const start = source.indexOf(`\n  ${name}: `);
  if (start < 0) return '';
  const next = source.slice(start + 1).search(/\n {2}[a-zA-Z]+: /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe('the mockup and the demo', () => {
  it("give the panel's version from one place: another version in the session, health or panel status reads as an update, and the page loads again", () => {
    const source = readFileSync(new URL('../src/mock/api.ts', import.meta.url), 'utf8');
    for (const name of ['session', 'health', 'panelStatus']) {
      const body = entry(source, name);
      expect(body, name).toContain('CURRENT');
      expect(body, name).not.toMatch(/version: '\d/);
    }
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the unlock dialog', () => {
  it('closes only with its buttons, the × or Escape: a click outside it while you use the page does not mark the unlock seen', () => {
    const source = readFileSync(new URL('../src/features/modes/unlock-dialog.tsx', import.meta.url), 'utf8');
    const dialog = /<Dialog\b[^>]*>/s.exec(source)?.[0] ?? '';
    expect(dialog).toContain('closeOnBackdrop={false}');
    expect(dialog).not.toContain('closeOnEscape={false}');
  });
});

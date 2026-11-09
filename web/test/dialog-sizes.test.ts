import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIALOG_SIZES } from '../src/lib/dialog-sizes.js';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

/** Every <Dialog ...> opening tag in the web app, with the file it is in. */
function dialogTags(): Array<{ file: string; tag: string }> {
  return files(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/<Dialog\b[\s\S]*?\n?\s*>(?=\s*[\n{<])/g)].map((m) => ({ file: relative(SRC, file), tag: m[0] }));
  });
}

describe('dialog sizes', () => {
  it('are one set of widths, growing from sm to xl', () => {
    const rems = Object.values(DIALOG_SIZES).map((c) => Number(/min\((\d+)rem/.exec(c)?.[1]));
    expect(rems).toEqual([24, 32, 48, 64]);
  });

  it('come only from the size prop: no dialog sets a width of its own', () => {
    const tags = dialogTags();
    expect(tags.length).toBeGreaterThan(20);
    const own = tags.filter(({ tag }) => /className=(["'{`])[^"'`}]*\b(?:[a-z]+:)?(?:max-)?w-\[/.test(tag) || /className=(["'{`])[^"'`}]*\b(?:[a-z]+:)?max-w-/.test(tag));
    expect(own.map((t) => t.file)).toEqual([]);
  });
});

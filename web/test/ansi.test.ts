import { describe, expect, it } from 'vitest';
import { ansiRuns } from '../src/lib/ansi.js';
import { lastLine, plainText } from '../src/lib/output.js';

describe('terminal colors in command output', () => {
  it("reads git's diffstat colors into runs of text, and drops other codes", () => {
    expect(ansiRuns(' file.php | 2 \u001b[32m+\u001b[m\u001b[31m-\u001b[m\u001b[K\n')).toEqual([
      { text: ' file.php | 2 ' },
      { text: '+', color: 32 },
      { text: '-', color: 31 },
      { text: '\n' },
    ]);
  });

  it('reads bold, bright, 256 and 24-bit colors, and resets', () => {
    expect(ansiRuns('\u001b[1;94mstep\u001b[22m on\u001b[0m off')).toEqual([{ text: 'step', color: 34, bold: true }, { text: ' on', color: 34 }, { text: ' off' }]);
    expect(ansiRuns('\u001b[38;5;9mred\u001b[38;2;10;20;30mrgb\u001b[39m')).toEqual([{ text: 'red', color: 31 }, { text: 'rgb', rgb: 'rgb(10, 20, 30)' }]);
  });

  it('gives plain text for a summary line', () => {
    expect(plainText('\u001b[0;32mok:\u001b[0m done')).toBe('ok: done');
    expect(lastLine('\u001b[0;34m==>\u001b[0m pull\n\u001b[31merror:\u001b[0m not a fast-forward\n')).toBe('error: not a fast-forward');
  });
});

import { describe, expect, it } from 'vitest';
import { lastLine } from '../src/lib/output.js';

describe('the line shown for a failed run', () => {
  it('is the last line that says what went wrong, in whole words', () => {
    expect(lastLine('cloning\nTypeError: x is not a function\n    at build.js:1\ndone')).toBe('TypeError: x is not a function');
    expect(lastLine('npm ERR! code ELIFECYCLE\nnpm ERR! A complete log')).toBe('npm ERR! A complete log');
    expect(lastLine('Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('fatal: Could not read from remote repository.');
  });

  it('skips names that only contain the words, and progress lines', () => {
    const out = ['[theme] <s> [webpack.Progress] 9% setup compilation NoEmitOnErrorsPlugin', '[theme] <s> [webpack.Progress] 60% building 1 error', '[theme] exited with code SIGTERM'].join('\n');
    expect(lastLine(out)).toBe('[theme] exited with code SIGTERM');
    expect(lastLine('NoEmitOnErrorsPlugin\nall good')).toBe('all good');
    expect(lastLine('')).toBe('');
  });
});

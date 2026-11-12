import { describe, expect, it } from 'vitest';
import { compatLines } from '../src/lib/wporg-compat.js';

describe('compatLines', () => {
  it('says in red what the site is too old for and in amber a WordPress newer than it was tested with', () => {
    expect(compatLines({ requiresPhp: '8.2', requires: '7.2', tested: '6.8' }, { wordpress: '7.1.3', php: '8.1' }).map((l) => [l.label, l.tone])).toEqual([
      ['Requires PHP', 'danger'],
      ['Requires WordPress', 'danger'],
      ['Tested up to', 'warning'],
    ]);
  });

  it('is fine with a site that has what it needs, and a patch release past what it was tested with', () => {
    expect(compatLines({ requiresPhp: '7.4', requires: '6.3', tested: '7.1' }, { wordpress: '7.1.3', php: '8.3' }).every((l) => l.tone === 'ok')).toBe(true);
  });

  it('only lists what it needs when the site has no version to compare', () => {
    expect(compatLines({ requiresPhp: '7.4' }, {})).toEqual([{ label: 'Requires PHP', value: '7.4', tone: 'plain' }]);
  });
});

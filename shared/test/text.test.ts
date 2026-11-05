import { describe, expect, it } from 'vitest';
import { textLinks } from '../src/text.js';

describe('textLinks', () => {
  it('links http and https URLs and leaves wrapping punctuation outside', () => {
    expect(textLinks('Reset it here: https://local.shop.com/wp-login.php?action=rp&key=abc&login=admin\n\nThanks.')).toEqual([
      { text: 'Reset it here: ' },
      { text: 'https://local.shop.com/wp-login.php?action=rp&key=abc&login=admin', href: 'https://local.shop.com/wp-login.php?action=rp&key=abc&login=admin' },
      { text: '\n\nThanks.' },
    ]);
    expect(textLinks('(see http://x.test/a).').filter((p) => p.href)).toEqual([{ text: 'http://x.test/a', href: 'http://x.test/a' }]);
    expect(textLinks('<https://x.test>')).toEqual([{ text: '<' }, { text: 'https://x.test', href: 'https://x.test' }, { text: '>' }]);
  });

  it('never links other schemes', () => {
    expect(textLinks('javascript:alert(1) and ftp://x.test')).toEqual([{ text: 'javascript:alert(1) and ftp://x.test' }]);
  });
});

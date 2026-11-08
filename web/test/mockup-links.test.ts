import { describe, expect, it } from 'vitest';
import { leavesMockup } from '../src/lib/mockup-links.js';

describe('leavesMockup', () => {
  const origin = 'http://127.0.0.1:5173';
  it('keeps the mockup its own pages, and stops links to anywhere else', () => {
    expect(leavesMockup('/sites/local.acme.com', origin)).toBe(false);
    expect(leavesMockup('?install=failed', origin)).toBe(false);
    expect(leavesMockup('http://127.0.0.1:5173/update', origin)).toBe(false);
    expect(leavesMockup('https://local.acme.com/wp-admin/', origin)).toBe(true);
    expect(leavesMockup('https://github.com/acme/site/pull/12', origin)).toBe(true);
    expect(leavesMockup('vscode://file/var/www/local.acme.com', origin)).toBe(true);
    expect(leavesMockup('mailto:alex@acme.com', origin)).toBe(true);
  });
});

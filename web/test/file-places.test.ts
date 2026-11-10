import { describe, expect, it } from 'vitest';
import { placeFact } from '../src/lib/file-places.js';

describe('placeFact', () => {
  it('counts themes and plugins by name, other folders as entries', () => {
    expect(placeFact({ label: 'Themes', path: 'wp-content/themes', kind: 'dir', count: 1 })).toEqual({ text: '1 theme' });
    expect(placeFact({ label: 'Plugins', path: 'wp-content/plugins', kind: 'dir', count: 12 })).toEqual({ text: '12 plugins' });
    expect(placeFact({ label: 'Uploads', path: 'wp-content/uploads', kind: 'dir', count: 0 })).toEqual({ text: 'empty' });
    expect(placeFact({ label: 'wp-content', path: 'wp-content', kind: 'dir', count: 6 })).toEqual({ text: '6 entries' });
    expect(placeFact({ label: 'wp-content', path: 'wp-content', kind: 'dir' })).toBeNull();
  });
  it('gives a file its size, and a big debug.log a warning', () => {
    expect(placeFact({ label: 'debug.log', path: 'wp-content/debug.log', kind: 'file', sizeBytes: 24_800_000 })).toMatchObject({ warn: true });
    expect(placeFact({ label: 'debug.log', path: 'wp-content/debug.log', kind: 'file', sizeBytes: 0 })).toEqual({ text: 'empty' });
    expect(placeFact({ label: 'wp-config.php', path: 'wp-config.php', kind: 'file', sizeBytes: 435 })?.warn).toBeUndefined();
  });
});

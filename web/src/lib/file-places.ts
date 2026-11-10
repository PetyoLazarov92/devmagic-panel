import type { FileShortcut } from '@devmagic-panel/shared';
import { bytes } from './format.js';

/** A debug.log this big is worth a look, and worth emptying. */
export const BIG_LOG_BYTES = 10_000_000;

/** The short fact under a place's name: how many themes or plugins, how big a file is. */
export function placeFact(place: FileShortcut): { text: string; warn?: true } | null {
  if (place.kind === 'file') {
    if (place.sizeBytes === undefined) return null;
    const big = place.path.endsWith('debug.log') && place.sizeBytes >= BIG_LOG_BYTES;
    return { text: place.sizeBytes === 0 ? 'empty' : bytes(place.sizeBytes), ...(big ? { warn: true as const } : {}) };
  }
  const n = place.count;
  if (n === undefined) return null;
  if (n === 0) return { text: 'empty' };
  const noun = place.path === 'wp-content/themes' ? 'theme' : place.path === 'wp-content/plugins' ? 'plugin' : 'entry';
  return { text: `${n.toLocaleString('en-US')} ${n === 1 ? noun : noun === 'entry' ? 'entries' : `${noun}s`}` };
}

import type { SiteAddress } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobRuntime } from '../jobs.js';
import type { WpRunner } from './db.js';

/** A search for an address in a regex with # as its delimiter: dots matched as dots. */
const literal = (text: string) => text.replace(/[.#]/g, (c) => `\\${c}`);

/**
 * Puts the network's moved sites at their addresses here, once their links
 * are replaced (db.ts, rewriteAddresses): their own home and siteurl, which
 * have no slash at the end so the links' passes miss them, on https, and
 * their row in the blogs table. `from` is where the replace of hosts left
 * them.
 */
export async function placeSites(wp: WpRunner, prefix: string, moves: ReadonlyArray<{ id: number; from: SiteAddress; to: SiteAddress }>, job?: JobRuntime): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (const [i, { id, from, to }] of moves.entries()) {
    job?.progress(i / moves.length, `${from.domain}${from.path} to ${to.domain}${to.path}`);
    // home and siteurl: the whole value, with http or https, now on https.
    const bare = (p: string) => p.replace(/\/$/, '');
    const own = await wp([
      'search-replace', `^https?://${literal(from.domain)}${literal(bare(from.path))}$`, `https://${to.domain}${bare(to.path)}`,
      `${prefix}${id}_options`, '--regex', '--regex-delimiter=#', '--report-changed-only',
    ]);
    results.push(own);
    if (own.code !== 0) return results;
    // The domain and path are checked local names and paths: nothing in them can end the quotes.
    const row = await wp(['db', 'query', `UPDATE \`${prefix}blogs\` SET domain = '${to.domain}', path = '${to.path}' WHERE blog_id = ${id}`]);
    results.push(row.code === 0 ? { ...row, stdout: `${row.stdout}${row.stdout ? '\n' : ''}site ${id} now answers at ${to.domain}${to.path}` } : row);
    if (row.code !== 0) return results;
  }
  return results;
}

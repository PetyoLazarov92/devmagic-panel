import { existsSync, readFileSync } from 'node:fs';
import type { SystemConfig } from '../config.js';

/** Same lines as DMP_HOSTS_BEGIN and DMP_HOSTS_END in scripts/lib/hosts.sh. */
export const HOSTS_BEGIN = '# BEGIN devmagic-panel (managed by the panel, edit sites there)';
export const HOSTS_END = '# END devmagic-panel';

export const readHosts = (config: SystemConfig) => (existsSync(config.HOSTS_FILE) ? readFileSync(config.HOSTS_FILE, 'utf8') : '');

/** The lines of a hosts file, each with whether it sits inside the panel's block. */
function hostsLines(text: string): Array<{ inside: boolean; address: string; names: string[]; raw: string }> {
  const out: Array<{ inside: boolean; address: string; names: string[]; raw: string }> = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === HOSTS_BEGIN) inside = true;
    else if (trimmed === HOSTS_END) inside = false;
    else {
      const [address, ...names] = raw.replace(/#.*/, '').trim().split(/\s+/);
      if (address && names.length) out.push({ inside, address, names: names.map((n) => n.toLowerCase()), raw });
    }
  }
  return out;
}

/** The address of a site's line in the panel's block, keyed by its primary domain, as dmp-root writes it. */
export function hostsBlockAddress(text: string, domain: string): string | undefined {
  return hostsLines(text).find((l) => l.inside && l.names[0] === domain)?.address;
}

/**
 * The names a hosts line outside the panel's block lists, among the given
 * ones: glibc takes the first line naming a host, so such a line decides where
 * the site goes, whatever the panel's line says. Mirrors dmp_hosts_outside_block.
 */
export function hostsOutsideBlock(text: string, names: string[]): string[] {
  const outside = new Set(hostsLines(text).filter((l) => !l.inside).flatMap((l) => l.names));
  return [...new Set(names)].filter((n) => outside.has(n));
}

/**
 * The lines outside the panel's block that name a site: its own, where every
 * name is one of the site's (a takeover moves them into its record, and Give
 * back puts them back), and ones it shares with other hosts, which only a
 * person edits. Mirrors dmp_takeover_hosts_read.
 */
export function hostsLinesOutside(text: string, names: string[]): { own: string[]; shared: string[] } {
  const site = new Set(names.map((n) => n.toLowerCase()));
  const own: string[] = [];
  const shared: string[] = [];
  for (const line of hostsLines(text)) {
    if (line.inside || !line.names.some((n) => site.has(n))) continue;
    (line.names.every((n) => site.has(n)) ? own : shared).push(line.raw.trim());
  }
  return { own, shared };
}

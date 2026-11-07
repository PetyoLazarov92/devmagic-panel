import type { WpDbReport } from '@devmagic-panel/shared';

/** A card of the WordPress view that has something to look at, for the summary above the cards. */
export interface WpFinding {
  /** The card's anchor: wp-autoload, wp-health and the like. */
  card: string;
  tone: 'danger' | 'warning';
  text: string;
}

const MB = 1024 * 1024;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/**
 * What needs a look in a site's WordPress database, the worst first: one
 * line per card that found something, never one for a card that is fine.
 * Only what the report has read counts; a part still reading adds nothing.
 */
export function wordpressFindings(r: WpDbReport): WpFinding[] {
  const out: WpFinding[] = [];
  const health = r.health?.issues ?? [];
  if (health.length) {
    const keys = health.filter((i) => i.problem === 'noPrimaryKey' || i.problem === 'noAutoIncrement').length;
    out.push({ card: 'wp-health', tone: keys ? 'danger' : 'warning', text: `${plural(health.length, 'table problem')}${keys ? `, ${keys} with a lost key` : ''}` });
  }
  if (r.autoload && r.autoload.bytes > r.autoload.limitBytes) {
    out.push({ card: 'wp-autoload', tone: r.autoload.bytes > 2 * r.autoload.limitBytes ? 'danger' : 'warning', text: `Autoload is ${(r.autoload.bytes / MB).toFixed(1)} MB, over ${(r.autoload.limitBytes / MB).toFixed(1)} MB` });
  }
  if (r.transients && r.transients.expired > 0) out.push({ card: 'wp-transients', tone: 'warning', text: plural(r.transients.expired, 'expired transient') });
  const gone = (r.plugins?.tables ?? []).filter((t) => t.state === 'missing' || t.unused).length;
  const offAutoload = (r.plugins?.autoload ?? []).reduce((n, p) => n + p.count, 0);
  if (gone || offAutoload) {
    out.push({ card: 'wp-plugins', tone: 'warning', text: [gone ? `${plural(gone, 'table')} of plugins that are gone` : '', offAutoload ? `${plural(offAutoload, 'option')} loaded for plugins that are off` : ''].filter(Boolean).join(', ') });
  }
  const c = r.content;
  const orphans = r.orphans ? Object.values(r.orphans).reduce((n: number, v) => n + (v ?? 0), 0) : 0;
  const clean = (c ? c.revisions + c.autoDrafts + c.trashedPosts + c.spamComments + c.trashedComments : 0) + orphans;
  if (clean >= 100) out.push({ card: 'wp-cleanup', tone: 'warning', text: `${plural(clean, 'row')} to clean up` });
  const unregistered = (r.postTypes?.unregistered ?? []).reduce((n, t) => n + t.count, 0);
  if (unregistered) out.push({ card: 'wp-plugins', tone: 'warning', text: `${plural(unregistered, 'post')} of types nothing registers` });
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
}

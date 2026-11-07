import type { WpDbHealth, WpDbHealthIssue, WpDbReport } from '@devmagic-panel/shared';

/** A card of the WordPress view that has something to look at, for the summary above the cards. */
export interface WpFinding {
  /** The card's anchor: wp-autoload, wp-health and the like. */
  card: string;
  tone: 'danger' | 'warning';
  text: string;
}

const MB = 1024 * 1024;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** One table of Table health with everything wrong with it: the card's row, and the summary's count. */
export interface HealthRow {
  table: string;
  issues: WpDbHealthIssue[];
  /** One of WordPress's own tables; the others are plugins' and themes', checked only for MyISAM. */
  wordpress: boolean;
  /** The fixes the panel can make now: a fix, and nothing a person must sort out first. */
  fixes: number;
  /** A lost key or AUTO_INCREMENT: new rows get ID 0. */
  danger: boolean;
}

const KEY_PROBLEMS = new Set<WpDbHealthIssue['problem']>(['noPrimaryKey', 'noAutoIncrement']);

/**
 * Every table that is not as it should be, once, with all its problems: the
 * WordPress tables' issues and MyISAM in any table of the site. A lost key
 * first, then what the panel fixes, then what only a person can.
 */
export function healthRows(h: WpDbHealth): HealthRow[] {
  const rows = new Map<string, HealthRow>();
  const row = (table: string, wordpress: boolean) => {
    const r = rows.get(table) ?? { table, issues: [], wordpress, fixes: 0, danger: false };
    rows.set(table, r);
    return r;
  };
  const add = (r: HealthRow, issue: WpDbHealthIssue) => {
    r.issues.push(issue);
    if (issue.fix && !issue.blocked) r.fixes++;
    if (KEY_PROBLEMS.has(issue.problem)) r.danger = true;
  };
  for (const issue of h.issues) add(row(issue.table, true), issue);
  for (const m of h.myisam ?? []) {
    const r = rows.get(m.table);
    if (r?.issues.some((i) => i.problem === 'engine')) continue;
    add(r ?? row(m.table, false), { table: m.table, problem: 'engine', text: 'It is MyISAM: no transactions, and a crash can damage it. InnoDB is what WordPress makes', fix: 'engine' });
  }
  const rank = (r: HealthRow) => (r.danger ? 0 : r.fixes ? 1 : 2);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b));
}

/**
 * The rows the clean-up card ticks on its own: every kind it found, but
 * saved login sessions (deleting them signs everyone out). The card's
 * Delete button and the summary above the cards both count these, so the
 * two never disagree.
 */
export function cleanupRows(r: Pick<WpDbReport, 'content' | 'orphans' | 'duplicates'>): number {
  const c = r.content;
  const content = c ? c.revisions + c.autoDrafts + c.trashedPosts + c.spamComments + c.trashedComments + (c.akismet ?? 0) + (c.oembed ?? 0) + (c.actionsDone ?? 0) + (c.wcSessions ?? 0) : 0;
  const orphans = r.orphans ? Object.values(r.orphans).reduce((n: number, v) => n + (v ?? 0), 0) : 0;
  return content + orphans + (r.duplicates?.rows ?? 0);
}

/**
 * What needs a look in a site's WordPress database, the worst first: one
 * line per card that found something, never one for a card that is fine.
 * Only what the report has read counts; a part still reading adds nothing.
 */
export function wordpressFindings(r: WpDbReport): WpFinding[] {
  const out: WpFinding[] = [];
  const health = r.health ? healthRows(r.health) : [];
  if (health.length) {
    const keys = health.filter((x) => x.danger).length;
    out.push({ card: 'wp-health', tone: keys ? 'danger' : 'warning', text: `${plural(health.length, 'table')} to fix${keys ? `, ${keys} with a lost key` : ''}` });
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
  const clean = cleanupRows(r);
  if (clean >= 100) out.push({ card: 'wp-cleanup', tone: 'warning', text: `${plural(clean, 'row')} to clean up` });
  const unregistered = (r.postTypes?.unregistered ?? []).reduce((n, t) => n + t.count, 0);
  if (unregistered) out.push({ card: 'wp-plugins', tone: 'warning', text: `${plural(unregistered, 'post')} of types nothing registers` });
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
}

import type { AuraItem, KnownVulnerability, Site, SiteVulnerabilities } from '@devmagic-panel/shared';
import { preferences, wpSlug } from '@devmagic-panel/shared';
import type { Executor } from './exec.js';
import { readPlugins, readThemes } from './sites/plugins.js';
import { siteFor } from './sites/site-actions.js';
import type { RunStore } from './store.js';
import type { FetchJson } from './wporg-plugins.js';

/**
 * Known vulnerabilities of the sites' plugins and themes, from
 * WPVulnerability (free, no key). Off until switched on in Aura. Only the
 * slugs WordPress's own update check found on WordPress.org are asked
 * about, so the name of a custom or client plugin never leaves the machine,
 * and never a version: the answer lists every vulnerability with its version
 * range, and the panel compares the installed version here. Answers are kept
 * a day per slug, and the sites are checked once a day, in the background.
 */

const KEEP_MS = 24 * 3_600_000;
const SOURCE = 'https://www.wpvulnerability.net';
const META = 'vulns:';
/**
 * What a site's result holds, in a number: a release that keeps more in it (2: each hit's folder,
 * for Aura's Update) raises it, and the next read of Aura checks again at once instead of a day
 * after the last round. The answers per slug are still kept a day, so that round asks nobody.
 */
const FORMAT = '2';

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'devmagic-panel' } });
  return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
};

/** One entry as kept: its version range and what the panel shows. */
interface Range extends KnownVulnerability {
  min?: string;
  minOp?: string;
  max?: string;
  maxOp?: string;
}

/** Compares two version strings part by part (5.10 after 5.9); a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    // A pre-release word sorts before the release: 6.2-beta1 before 6.2.
    if (typeof p === 'number') return 1;
    if (typeof q === 'number') return -1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const holds = (version: string, op: string | undefined, bound: string | undefined) => {
  if (!bound || !op) return true;
  const c = compareVersions(version, bound);
  return op === 'ge' ? c >= 0 : op === 'gt' ? c > 0 : op === 'le' ? c <= 0 : op === 'lt' ? c < 0 : op === 'eq' ? c === 0 : true;
};

/** Whether a kept entry covers a version. */
export const affects = (r: Range, version: string) => holds(version, r.minOp, r.min) && holds(version, r.maxOp, r.max);

const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim().slice(0, max) : undefined);
const version = (v: unknown) => (typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : undefined);
const SEVERITIES = new Set(['none', 'low', 'medium', 'high', 'critical']);

/** WPVulnerability's answer for one slug, as the panel keeps it. */
export function parseVulnerabilities(body: unknown): Range[] {
  const list = (body as { data?: { vulnerability?: unknown } } | null)?.data?.vulnerability;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).flatMap((v): Range[] => {
    if (!v || typeof v !== 'object') return [];
    const e = v as { name?: unknown; operator?: Record<string, unknown>; source?: unknown; impact?: unknown };
    const op = e.operator ?? {};
    if (op.closed === '1' || op.closed === 1) return [];
    const impact = (e.impact && typeof e.impact === 'object' && !Array.isArray(e.impact) ? e.impact : {}) as Record<string, { score?: unknown; severity?: unknown } | undefined>;
    const cvss = impact.cvss3 ?? impact.cvss;
    const score = Number(cvss?.score);
    const severity = typeof cvss?.severity === 'string' && SEVERITIES.has(cvss.severity) ? (cvss.severity as KnownVulnerability['severity']) : undefined;
    const source = Array.isArray(e.source) ? (e.source as Array<{ link?: unknown }>).map((s) => s?.link).find((l) => typeof l === 'string' && /^https:\/\//.test(l)) : undefined;
    const min = version(op.min_version);
    const max = version(op.max_version);
    const unfixed = op.unfixed === '1' || op.unfixed === 1;
    return [{
      title: text(e.name, 200) ?? 'A vulnerability',
      ...(min ? { min, minOp: String(op.min_operator ?? '') } : {}),
      ...(max ? { max, maxOp: String(op.max_operator ?? '') } : {}),
      ...(Number.isFinite(score) && score >= 0 && score <= 10 ? { score } : {}),
      ...(severity ? { severity } : {}),
      ...(unfixed ? { unfixed: true as const } : max && op.max_operator === 'lt' ? { fixedIn: max } : {}),
      ...(source ? { link: source as string } : {}),
    }];
  });
}

/** One slug's entries, kept a day in the panel's database; null when WPVulnerability did not answer. */
export async function vulnerabilitiesOf(kind: 'plugin' | 'theme', slug: string, store: Pick<RunStore, 'getMeta' | 'setMeta'>, fetcher: FetchJson = fetchJson, now = Date.now()): Promise<Range[] | null> {
  if (!wpSlug.safeParse(slug).success) return [];
  const key = `wpvuln-${kind}:${slug}`;
  try {
    const kept = JSON.parse(store.getMeta(key) ?? 'null') as { at: number; list: Range[] } | null;
    if (kept && now - kept.at < KEEP_MS) return kept.list;
  } catch {
    // asked again
  }
  try {
    const { status, body } = await fetcher(`${SOURCE}/${kind}/${encodeURIComponent(slug)}/`);
    if (status !== 200 && status !== 404) return null;
    const list = parseVulnerabilities(body);
    store.setMeta(key, JSON.stringify({ at: now, list }));
    return list;
  } catch {
    return null;
  }
}

/** One site's check: its plugins and themes from WordPress.org, each at the version installed. */
export async function checkSite(exec: Executor, site: ReturnType<typeof siteFor>, store: Pick<RunStore, 'getMeta' | 'setMeta'>, fetcher: FetchJson = fetchJson, now = Date.now()): Promise<SiteVulnerabilities> {
  const [plugins, themes] = await Promise.all([readPlugins(exec, site), readThemes(exec, site)]);
  const items = [
    // Its folder too when the panel can update it there: a plugin folder (not one file, must-use or a drop-in), a theme right in wp-content/themes.
    ...plugins.plugins.flatMap((p) => (p.wporg && p.version ? [{ kind: 'plugin' as const, slug: p.wporg, title: p.title, version: p.version, ...(!p.oneFile && p.status !== 'must-use' && p.status !== 'dropin' ? { name: p.name } : {}) }] : [])),
    ...themes.themes.flatMap((t) => (t.wporg && t.version ? [{ kind: 'theme' as const, slug: t.wporg, title: t.title, version: t.version, ...(!t.inRepo && t.folder === `wp-content/themes/${t.name}` ? { name: t.name } : {}) }] : [])),
  ];
  const hits: SiteVulnerabilities['hits'] = [];
  for (const item of items) {
    const list = await vulnerabilitiesOf(item.kind, item.slug, store, fetcher, now);
    const found = (list ?? []).filter((r) => affects(r, item.version)).map(({ min: _a, minOp: _b, max: _c, maxOp: _d, ...shown }) => shown);
    if (found.length) hits.push({ ...item, vulnerabilities: found.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) });
  }
  return { checkedAt: new Date(now).toISOString(), checked: items.length, hits };
}

const worst = (hit: SiteVulnerabilities['hits'][number]) => hit.vulnerabilities[0];

/** Aura's lines for the sites' last checks: a failure for high and critical ones, else a warning. */
export function vulnerabilityItems(sites: readonly Site[], kept: (site: string) => SiteVulnerabilities | undefined): AuraItem[] {
  return sites.flatMap((site) => {
    const found = kept(`${site.domain}${site.path ?? ''}`);
    return (found?.hits ?? []).map((hit): AuraItem => {
      const top = worst(hit);
      const serious = top?.severity === 'high' || top?.severity === 'critical';
      const fixed = hit.vulnerabilities.map((v) => v.fixedIn).filter((v): v is string => Boolean(v)).sort(compareVersions).at(-1);
      const count = hit.vulnerabilities.length;
      // A fixed version and a folder the panel updates: Update, from WordPress.org, a snapshot first, asked first.
      const canUpdate = Boolean(fixed && hit.name);
      const what = `${hit.kind === 'theme' ? 'the theme ' : ''}${hit.title}`;
      return {
        id: 'site.vulnerable',
        status: serious ? 'fail' : 'warn',
        text: `${hit.kind === 'theme' ? 'The theme ' : ''}${hit.title} ${hit.version} has ${count} known vulnerabilit${count === 1 ? 'y' : 'ies'}${top?.severity ? `, the worst ${top.severity}` : ''}${fixed ? `: fixed in ${fixed}` : hit.vulnerabilities.some((v) => v.unfixed) ? ': not fixed yet' : ''}`,
        hint: `${top?.title ?? ''}${top?.link ? ` (${top.link})` : ''}. ${canUpdate ? 'Update takes the newest version from WordPress.org' : 'Update it with WP-CLI or in wp-admin, the way production updates it'}. From WPVulnerability, checked ${found?.checkedAt.slice(0, 10)}.`,
        domain: site.domain,
        ...(site.path ? { path: site.path } : {}),
        ...(canUpdate && hit.name
          ? {
              fix: {
                action: 'site.updatePlugins' as const,
                input: { domain: site.domain, ...(site.path ? { path: site.path } : {}), plugins: hit.kind === 'plugin' ? [hit.name] : [], themes: hit.kind === 'theme' ? [hit.name] : [], snapshot: true },
                label: `Update ${hit.title}`,
                confirm: `Updates ${what} from ${hit.version} to the newest version on WordPress.org (fixed in ${fixed}) with WP-CLI, after a snapshot of the database. Its folder is kept in the file trash first, so Undo on the job puts ${hit.version} back.`,
              },
            }
          : {}),
      };
    });
  });
}

/**
 * The daily check of every WordPress site, one site at a time in the
 * background: started by a read of Aura when it is on and the last round is
 * a day old, or by Check now. Each site's result is kept in the panel's
 * database; a site whose plugins cannot be read keeps its last result.
 */
export class VulnerabilityWatch {
  private round: Promise<void> | null = null;

  constructor(
    private store: RunStore,
    private exec: Executor,
    private config: Parameters<typeof siteFor>[0],
    private fetcher: FetchJson = fetchJson,
    private now: () => number = Date.now,
  ) {}

  enabled(): boolean {
    try {
      const saved = preferences.safeParse(JSON.parse(this.store.getMeta('preferences') ?? '{}'));
      return saved.success && saved.data.checkVulnerabilities;
    } catch {
      return false;
    }
  }

  kept(site: string): SiteVulnerabilities | undefined {
    try {
      return (JSON.parse(this.store.getMeta(`${META}${site}`) ?? 'null') as SiteVulnerabilities | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  running(): boolean {
    return this.round !== null;
  }

  /** When the last round started, as an ISO time. */
  lastRound(): string | undefined {
    const at = Number(this.store.getMeta('vulns-round') ?? 0);
    return at ? new Date(at).toISOString() : undefined;
  }

  /** Starts a round when it is on, none runs and the last is a day old or kept less than this release keeps (or now, when forced). */
  maybeStart(sites: () => Promise<Site[]>, force = false): void {
    if (!this.enabled() || this.round) return;
    const last = Number(this.store.getMeta('vulns-round') ?? 0);
    const current = this.store.getMeta('vulns-format') === FORMAT;
    if (!force && current && this.now() - last < KEEP_MS) return;
    this.store.setMeta('vulns-round', String(this.now()));
    this.store.setMeta('vulns-format', FORMAT);
    this.round = (async () => {
      for (const site of await sites()) {
        if (site.core.kind === 'none') continue;
        try {
          const found = await checkSite(this.exec, siteFor(this.config, site.domain, site.path), this.store, this.fetcher, this.now());
          this.store.setMeta(`${META}${site.domain}${site.path ?? ''}`, JSON.stringify(found));
        } catch {
          // Its plugins could not be read: the last result stays.
        }
      }
    })().finally(() => {
      this.round = null;
    });
  }

  /** For tests: waits for the round to end. */
  async settled(): Promise<void> {
    await this.round;
  }
}

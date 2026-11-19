import { preferences, type PhpRelease } from '@devmagic-panel/shared';
import type { RunStore } from '../store.js';

/**
 * PHP's releases from php.net, to say when one is out that apt's sources do
 * not have yet (the PHP PPA usually builds it within a day). The panel asks
 * php.net for its public list of release versions only, through HTTPS, and
 * sends nothing else: no version of yours, no site. On unless switched off in
 * Settings (checkPhpReleases). Kept in the panel's database and read again
 * every 12 hours by a timed task, or when the PHP tab's Check again finds
 * the list over an hour old; a failure keeps the last list and says nothing.
 */

/** Debian's package version, like 1:8.3.14-1+ubuntu24.04.1, as the PHP release it carries: 8.3.14. */
export const upstreamVersion = (pkg: string): string => pkg.replace(/^\d+:/, '').split(/[-+~]/)[0] ?? pkg;

/** A build of a release candidate, alpha or beta: Debian marks one with ~ in its upstream part, like 8.6.0~rc3-1. */
export const isPrerelease = (pkg: string): boolean => (pkg.replace(/^\d+:/, '').split('-')[0] ?? '').includes('~');

export const PHP_RELEASES_KEY = 'php-releases';
export const PHP_RELEASES_URL = (major: number) => `https://www.php.net/releases/index.php?json&version=${major}&max=20`;
/** The timed task reads them this often; Check again asks again once the list is older than FORCED_MS. */
export const PHP_RELEASES_EVERY_MS = 12 * 3_600_000;
const FORCED_MS = 3_600_000;
/** More than php.net's answer ever is: a bigger one is not read. */
const MAX_BYTES = 256 * 1024;

export interface KeptReleases {
  at: string;
  releases: PhpRelease[];
}

export type FetchText = (url: string) => Promise<{ status: number; text: string }>;

const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'devmagic-panel', accept: 'application/json' } });
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return { status: 413, text: '' };
  const text = await res.text();
  return { status: res.status, text: text.length > MAX_BYTES ? '' : text };
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** php.net's "19 Nov 2026" as 2026-11-19; anything else, undefined. */
export function releaseDay(text: string): string | undefined {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf((m[2] as string).toLowerCase()) : -1;
  if (!m || month < 0) return undefined;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

/**
 * php.net's answer, `{ "8.4.28": { "tags": ["security"], "date": "19 Nov 2026", ... } }`,
 * as releases: only plain x.y.z versions with a date it can read; anything
 * else in it is left out.
 */
export function parsePhpReleases(json: unknown): PhpRelease[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const out: PhpRelease[] = [];
  for (const [version, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(version) || !entry || typeof entry !== 'object') continue;
    const { date, tags } = entry as { date?: unknown; tags?: unknown };
    const day = typeof date === 'string' ? releaseDay(date) : undefined;
    if (!day) continue;
    out.push({ version, date: day, security: Array.isArray(tags) && tags.includes('security') });
  }
  return out;
}

const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
/** 8.4.28 is of the 8.4 branch. */
export const branchOf = (version: string) => version.split('.').slice(0, 2).join('.');

/** The newest release of a branch, like 8.4. */
export function newestOf(releases: readonly PhpRelease[], branch: string): PhpRelease | undefined {
  return releases.filter((r) => branchOf(r.version) === branch).sort((a, b) => byVersion(b.version, a.version))[0];
}

/** A build from the PHP PPA or packages.sury.org, which follow php.net's releases; Ubuntu's and Debian's own keep their release and backport fixes. */
export const followsPhpNet = (pkg: string) => /sury/.test(pkg);

/**
 * What php.net says about an installed version: a newer release than the
 * installed one, and whether apt's sources have it (a final build at least
 * that new). Nothing for Ubuntu's or Debian's own builds, or when the
 * installed one is php.net's newest.
 */
export function releasedFor(branch: string, releases: readonly PhpRelease[], installed?: string, candidate?: string): (PhpRelease & { inApt: boolean }) | undefined {
  if (!installed || !followsPhpNet(installed)) return undefined;
  const newest = newestOf(releases, branch);
  if (!newest || byVersion(newest.version, upstreamVersion(installed)) <= 0) return undefined;
  const inApt = candidate !== undefined && !isPrerelease(candidate) && byVersion(upstreamVersion(candidate), newest.version) >= 0;
  return { ...newest, inApt };
}

/**
 * New PHP versions final on php.net (x.y.0 out), newer than every installed
 * one, that apt does not offer yet (`available` holds the versions it does).
 */
export function releasedNew(releases: readonly PhpRelease[], installed: readonly string[], available: readonly string[]): PhpRelease[] {
  const newest = [...installed].sort(byVersion).at(-1);
  if (!newest) return [];
  const branches = [...new Set(releases.map((r) => branchOf(r.version)))].filter((b) => byVersion(b, newest) > 0 && !available.includes(b) && !installed.includes(b));
  return branches.sort(byVersion).flatMap((b) => {
    const r = newestOf(releases, b);
    return r ? [r] : [];
  });
}

/** php.net's releases as the panel keeps them, read again when due. */
export class PhpReleases {
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: Pick<RunStore, 'getMeta' | 'setMeta'>,
    private readonly get: FetchText = fetchText,
    private readonly now: () => number = Date.now,
  ) {}

  enabled(): boolean {
    try {
      const saved = preferences.safeParse(JSON.parse(this.store.getMeta('preferences') ?? '{}'));
      return saved.success ? saved.data.checkPhpReleases : true;
    } catch {
      return true;
    }
  }

  /** The last list read, while the check is on. */
  kept(): KeptReleases | null {
    if (!this.enabled()) return null;
    try {
      const k = JSON.parse(this.store.getMeta(PHP_RELEASES_KEY) ?? 'null') as KeptReleases | null;
      return k && typeof k.at === 'string' && Array.isArray(k.releases) ? k : null;
    } catch {
      return null;
    }
  }

  private age(): number {
    const k = this.kept();
    return k ? this.now() - Date.parse(k.at) : Number.POSITIVE_INFINITY;
  }

  /**
   * Reads php.net again when the list is older than `olderThan` (the timed
   * task's 12 hours by default, an hour for Check again), for the majors
   * given (8, and 9 once a version of it is around). One read at a time.
   */
  async refresh(majors: readonly number[] = [8], olderThan = PHP_RELEASES_EVERY_MS - 60_000): Promise<'read' | 'fresh' | 'off' | 'failed'> {
    if (!this.enabled()) return 'off';
    if (this.age() < olderThan) return 'fresh';
    if (this.running) {
      await this.running;
      return 'read';
    }
    let result: 'read' | 'failed' = 'failed';
    this.running = (async () => {
      const releases: PhpRelease[] = [];
      for (const major of [...new Set(majors)].sort()) {
        try {
          const r = await this.get(PHP_RELEASES_URL(major));
          if (r.status !== 200) return;
          releases.push(...parsePhpReleases(JSON.parse(r.text)));
        } catch {
          return;
        }
      }
      if (releases.length === 0) return;
      this.store.setMeta(PHP_RELEASES_KEY, JSON.stringify({ at: new Date(this.now()).toISOString(), releases } satisfies KeptReleases));
      result = 'read';
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return result;
  }

  /** Check again on the PHP tab: reads again once the list is over an hour old. */
  refreshForced(majors: readonly number[]): Promise<'read' | 'fresh' | 'off' | 'failed'> {
    return this.refresh(majors, FORCED_MS);
  }
}

/** The majors to ask php.net about: 8, and every major of a version installed or offered. */
export const majorsOf = (versions: readonly string[]) => [...new Set([8, ...versions.map((v) => Number(v.split('.')[0])).filter((n) => Number.isInteger(n) && n >= 8)])];

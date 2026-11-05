import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WP_RELEASES_URL } from '@devmagic-panel/shared';

/** WordPress.org's answer per version: the newest release, an older safe one, or one with known security issues. */
export type CoreStatus = 'latest' | 'outdated' | 'insecure';
export type CoreStatusMap = Record<string, CoreStatus>;

export const STABLE_CHECK_URL = WP_RELEASES_URL;
/** WordPress.org's list is kept this long: a security release shows within the hour. */
export const MAX_AGE_MS = 3_600_000;

export type FetchJson = (url: string) => Promise<unknown>;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

function parse(data: unknown): CoreStatusMap | null {
  if (!data || typeof data !== 'object') return null;
  const out: CoreStatusMap = {};
  for (const [version, status] of Object.entries(data)) {
    if (/^\d+(\.\d+){1,3}$/.test(version) && (status === 'latest' || status === 'outdated' || status === 'insecure')) out[version] = status;
  }
  return Object.keys(out).length ? out : null;
}

export function latestOf(map: CoreStatusMap): string | undefined {
  return Object.entries(map).find(([, s]) => s === 'latest')?.[0];
}

export interface CoreStatusOptions {
  /** Ask WordPress.org now, not the copy (Check again on the WordPress page). */
  fresh?: boolean;
}

export type CoreStatusSource = (options?: CoreStatusOptions) => Promise<CoreStatusMap | null>;

/**
 * Which WordPress versions are current, outdated or insecure, from
 * WordPress.org. Kept in a file for an hour, or asked again on request;
 * offline, the last copy is used, and without one the checks that need it
 * are skipped.
 */
export function coreStatusSource(cacheFile: string, fetcher: FetchJson = fetchJson): CoreStatusSource {
  let pending: Promise<CoreStatusMap | null> | null = null;
  const readCache = () => {
    try {
      return parse(JSON.parse(readFileSync(cacheFile, 'utf8')));
    } catch {
      return null;
    }
  };
  return (options = {}) => {
    if (!options.fresh && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < MAX_AGE_MS) {
      const cached = readCache();
      if (cached) return Promise.resolve(cached);
    }
    pending ??= (async () => {
      try {
        const map = parse(await fetcher(STABLE_CHECK_URL));
        if (map) {
          mkdirSync(dirname(cacheFile), { recursive: true });
          writeFileSync(cacheFile, JSON.stringify(map));
          return map;
        }
      } catch {
        // offline or WordPress.org is down: fall back to the last copy
      }
      return readCache();
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}

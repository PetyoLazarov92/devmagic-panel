import type { WpDbReport, WpDbSection } from '@devmagic-panel/shared';
import { WP_DB_SECTIONS } from '@devmagic-panel/shared';
import type { RunStore } from './store.js';

/**
 * The WordPress view of a site's database as it was last read, kept in the
 * panel's database, so the tab shows at once on a big database and reads the
 * parts that scan whole tables only on Check again or after a clean-up. Only
 * names, sizes and counts: the same report the browser gets, never a row.
 */
const key = (domain: string, path: string | undefined, blog: number) => `wpdb-report:${domain}${path ?? ''}#${blog}`;

export function cachedReport(store: RunStore, domain: string, path: string | undefined, blog: number): WpDbReport | undefined {
  const text = store.getMeta(key(domain, path, blog));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as WpDbReport;
  } catch {
    return undefined;
  }
}

/** Keeps the parts just read over the ones kept before, each with when it was read; a part that failed keeps its older value. */
export function keepReport(store: RunStore, domain: string, path: string | undefined, blog: number, fresh: WpDbReport, sections: readonly WpDbSection[]): void {
  const kept = cachedReport(store, domain, path, blog);
  // The report's own facts (database, network, missing tables) from this read; its parts merged one by one below.
  const facts = Object.fromEntries(Object.entries(fresh).filter(([k]) => !(WP_DB_SECTIONS as readonly string[]).includes(k)));
  const merged = { ...(kept ?? {}), ...facts, errors: { ...(kept?.errors ?? {}) }, readAt: { ...(kept?.readAt ?? {}) } } as WpDbReport;
  for (const section of sections) {
    const value = fresh[section];
    if (value === undefined) continue;
    if (fresh.errors[section]) {
      // Keep the last good value; say why this read failed only when there is none.
      if (kept?.[section] == null) {
        (merged as unknown as Record<string, unknown>)[section] = value;
        merged.errors[section] = fresh.errors[section];
      }
      continue;
    }
    delete merged.errors[section];
    (merged as unknown as Record<string, unknown>)[section] = value;
    (merged.readAt as Record<string, string>)[section] = fresh.checkedAt;
  }
  // Only the parts this report has: a section never read stays out.
  for (const section of WP_DB_SECTIONS) if (merged[section] === undefined) delete merged.errors[section];
  store.setMeta(key(domain, path, blog), JSON.stringify(merged));
}

/** Forgets what was kept for a site (its key: domain and path), like after a job changed it: the next visit reads every part. */
export function forgetReport(store: RunStore, site: string): void {
  for (const k of store.metaKeys(`wpdb-report:${site}#`)) store.deleteMeta(k);
}

/**
 * One read of the same parts at a time: a second request waits for the
 * first. The read stops when every request that waits for it has gone.
 */
export class SharedReads<T> {
  private running = new Map<string, { promise: Promise<T>; controller: AbortController; waiting: number }>();

  read(id: string, start: (signal: AbortSignal) => Promise<T>, gone: AbortSignal): Promise<T> {
    let entry = this.running.get(id);
    if (!entry) {
      const controller = new AbortController();
      const promise = start(controller.signal).finally(() => this.running.delete(id));
      entry = { promise, controller, waiting: 0 };
      this.running.set(id, entry);
    }
    const shared = entry;
    shared.waiting += 1;
    gone.addEventListener(
      'abort',
      () => {
        shared.waiting -= 1;
        if (shared.waiting === 0) shared.controller.abort();
      },
      { once: true },
    );
    return shared.promise;
  }
}

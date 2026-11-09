import type { WporgPlugin } from '@devmagic-panel/shared';
import { wpSlug } from '@devmagic-panel/shared';
import type { RunStore } from './store.js';

/**
 * Whether plugins are on WordPress.org, by slug, from its plugins API:
 * their name and latest version, or null for one it does not have (a
 * premium or custom plugin). Answers are kept a day in the panel's
 * database. Only slugs that pass wpSlug are asked about.
 */

export type FetchJson = (url: string) => Promise<{ status: number; body: unknown }>;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'devmagic-panel' } });
  return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
};

const KEEP_MS = 24 * 3_600_000;
const key = (slug: string) => `wporg-plugin:${slug}`;
export const wporgPluginUrl = (slug: string) =>
  `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0&request[fields][description]=0&request[fields][screenshots]=0&request[fields][versions]=0`;

export async function wporgPlugins(slugs: readonly string[], store: Pick<RunStore, 'getMeta' | 'setMeta'>, fetcher: FetchJson = fetchJson, now = Date.now()): Promise<Record<string, WporgPlugin | null>> {
  const out: Record<string, WporgPlugin | null> = {};
  const wanted = [...new Set(slugs)].filter((s) => wpSlug.safeParse(s).success).slice(0, 100);
  await Promise.all(
    wanted.map(async (slug) => {
      try {
        const kept = JSON.parse(store.getMeta(key(slug)) ?? 'null') as { at: number; plugin: WporgPlugin | null } | null;
        if (kept && now - kept.at < KEEP_MS) {
          out[slug] = kept.plugin;
          return;
        }
      } catch {
        // asked again
      }
      try {
        const { status, body } = await fetcher(wporgPluginUrl(slug));
        const b = body as { slug?: unknown; name?: unknown; version?: unknown; error?: unknown } | null;
        const plugin: WporgPlugin | null =
          b && b.slug === slug && typeof b.version === 'string'
            ? { name: typeof b.name === 'string' ? b.name.replace(/<[^>]*>/g, '').slice(0, 200) : slug, version: b.version.slice(0, 40) }
            : null;
        // A 404 or "not found" is an answer; a failed request is not kept.
        if (plugin || status === 404 || (b && typeof b.error === 'string')) {
          store.setMeta(key(slug), JSON.stringify({ at: now, plugin }));
          out[slug] = plugin;
        }
      } catch {
        // WordPress.org did not answer: the slug stays unknown.
      }
    }),
  );
  return out;
}

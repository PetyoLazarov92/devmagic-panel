import type { DumpPlugin, RepoPlacement, WporgPlugin } from '@devmagic-panel/shared';
import { repoTarget } from '@devmagic-panel/shared';

/**
 * Plugins a dump names that none of the install's repos brings, and what to
 * do with each: install it from WordPress.org, turn it off, or leave it
 * (WordPress turns a missing active plugin off on its own).
 */

export type PluginPick = 'install' | 'off' | 'leave';

/** Where a plugin entry lives in a site: wp-content/plugins/akismet for akismet/akismet.php, wp-content/plugins/hello.php for hello.php. */
export const pluginSitePath = (file: string) => `wp-content/plugins/${file.includes('/') ? file.split('/')[0] : file}`;

/** Its slug for WordPress.org: what the update check said, else its folder or file name. */
export const pluginSlug = (p: Pick<DumpPlugin, 'file' | 'slug'>) => p.slug ?? (p.file.includes('/') ? (p.file.split('/')[0] as string) : p.file.replace(/\.php$/, ''));

/** Every plugin folder the repos bring, as paths in the site: each repo's own plugins folders at its place, and a repo that is a plugin itself. */
export function repoPluginPaths(rows: ReadonlyArray<{ placement: RepoPlacement; plugins?: readonly string[] }>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const at = repoTarget(r.placement);
    if (/^wp-content\/plugins\/[^/]+$/.test(at)) out.add(at);
    for (const p of r.plugins ?? []) out.add(at ? `${at}/${p}` : p);
  }
  return out;
}

/** The plugins a dump names that the repos do not bring. */
export const missingPlugins = (plugins: readonly DumpPlugin[], present: ReadonlySet<string>) => plugins.filter((p) => !present.has(pluginSitePath(p.file)));

/** What happens to a missing plugin unless you choose: one on WordPress.org that is active, or that the last install of the repo installed, is installed; every other is left. */
export function defaultPick(p: DumpPlugin, wporg: WporgPlugin | null | undefined, remembered: readonly string[] = []): PluginPick {
  return wporg && (p.active || remembered.includes(pluginSlug(p))) ? 'install' : 'leave';
}

/** The plugins to install and to turn off, from the picks. */
export function pluginChoices(missing: readonly DumpPlugin[], picks: Readonly<Record<string, PluginPick>>, wporg: Readonly<Record<string, WporgPlugin | null>>, remembered: readonly string[] = []) {
  const install: Array<{ slug: string; version?: string }> = [];
  const off: string[] = [];
  for (const p of missing) {
    const slug = pluginSlug(p);
    const pick = picks[p.file] ?? defaultPick(p, wporg[slug], remembered);
    if (pick === 'install' && wporg[slug]) install.push({ slug, ...(p.version ? { version: p.version } : {}) });
    if (pick === 'off' && /^[a-z0-9_-]{1,100}$/.test(slug)) off.push(slug);
  }
  return { install: install.filter((x, i) => install.findIndex((y) => y.slug === x.slug) === i), off: [...new Set(off)] };
}

const WPORG_SLUG = /^[a-z0-9_-]{1,100}$/;
/** WordPress.org is asked about this many plugins at once. */
const ASK_AT_ONCE = 100;

/**
 * Asks WordPress.org about plugins by slug, through the panel. A slug
 * WordPress.org could not have (capitals, a dot, a space: a custom plugin's
 * folder) is answered here as not there, so one odd folder name never stops
 * the answers for the rest; long lists go in parts. failed says some part got
 * no answer, so those slugs stay unknown and can be asked again.
 */
export async function askWporg(slugs: readonly string[], ask: (slugs: string[]) => Promise<Record<string, WporgPlugin | null>>): Promise<{ answers: Record<string, WporgPlugin | null>; failed: boolean }> {
  const answers: Record<string, WporgPlugin | null> = {};
  const valid: string[] = [];
  for (const slug of new Set(slugs)) {
    if (WPORG_SLUG.test(slug)) valid.push(slug);
    else answers[slug] = null;
  }
  let failed = false;
  for (let i = 0; i < valid.length; i += ASK_AT_ONCE) {
    const part = valid.slice(i, i + ASK_AT_ONCE);
    try {
      const got = await ask(part);
      Object.assign(answers, got);
      // WordPress.org did not answer for some: they stay unknown.
      if (part.some((slug) => !(slug in got))) failed = true;
    } catch {
      failed = true;
    }
  }
  return { answers, failed };
}

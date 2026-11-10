import type { DumpPlugin, DumpTheme, RepoPlacement, ServerFiles, WporgPlugin } from '@devmagic-panel/shared';
import { repoTarget } from '@devmagic-panel/shared';

/**
 * Plugins a dump names that none of the install's repos brings, and what to
 * do with each: install it from WordPress.org, copy it from the site's own
 * server when WordPress.org does not have it, turn it off, or leave it
 * (WordPress turns a missing active plugin off on its own).
 */

export type PluginPick = 'install' | 'server' | 'off' | 'leave';

/** What to ask the server for: the plugin's folder, or its one file. */
export const pluginItem = (file: string) => (file.includes('/') ? (file.split('/')[0] as string) : file);

/** The server's entry for a plugin, when it has it: by its folder, or a single file's name without .php. */
export function onServer(p: Pick<DumpPlugin, 'file'>, server: ServerFiles | null | undefined) {
  const name = p.file.includes('/') ? (p.file.split('/')[0] as string) : p.file.replace(/\.php$/, '');
  return server?.plugins.find((x) => x.name === name);
}

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

/**
 * What happens to a missing plugin unless you choose: one on WordPress.org
 * that is active, or that the last install of the repo installed, is
 * installed; an active one WordPress.org does not have is copied from the
 * server when the server has it; every other is left.
 */
export function defaultPick(p: DumpPlugin, wporg: WporgPlugin | null | undefined, remembered: readonly string[] = [], server?: ServerFiles | null): PluginPick {
  if (wporg && (p.active || remembered.includes(pluginSlug(p)))) return 'install';
  return wporg === null && p.active && onServer(p, server) ? 'server' : 'leave';
}

const SERVER_ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The plugins to install, to copy from the server and to turn off, from the picks. */
export function pluginChoices(missing: readonly DumpPlugin[], picks: Readonly<Record<string, PluginPick>>, wporg: Readonly<Record<string, WporgPlugin | null>>, remembered: readonly string[] = [], server?: ServerFiles | null) {
  const install: Array<{ slug: string; version?: string }> = [];
  const off: string[] = [];
  const copy: string[] = [];
  for (const p of missing) {
    const slug = pluginSlug(p);
    const pick = picks[p.file] ?? defaultPick(p, wporg[slug], remembered, server);
    const item = pluginItem(p.file);
    if (pick === 'server' && onServer(p, server) && SERVER_ITEM.test(item) && !item.includes('..')) copy.push(item);
    if (pick === 'install' && wporg[slug]) install.push({ slug, ...(p.version ? { version: p.version } : {}) });
    if (pick === 'off' && /^[a-z0-9_-]{1,100}$/.test(slug)) off.push(slug);
  }
  return { install: install.filter((x, i) => install.findIndex((y) => y.slug === x.slug) === i), off: [...new Set(off)], copy: [...new Set(copy)] };
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

// ── themes ───────────────────────────────────────────────────

/** What to do with a theme the dump uses that no repo brings: install it from WordPress.org, copy it from the server, or leave it. */
export type ThemePick = 'install' | 'server' | 'leave';

/** The themes the repos bring, by folder name: a repo that is the theme, a repo's themes folders at its place, and a theme in a folder of a repo in wp-content/repos. */
export function repoThemeNames(rows: ReadonlyArray<{ placement: RepoPlacement; themes?: readonly string[]; themeIn?: string }>): Set<string> {
  const out = new Set<string>();
  const inThemes = (path: string) => /^wp-content\/themes\/([^/]+)$/.exec(path)?.[1];
  for (const r of rows) {
    const at = repoTarget(r.placement);
    const own = inThemes(at);
    if (own) out.add(own);
    for (const t of r.themes ?? []) {
      const name = inThemes(at ? `${at}/${t}` : t);
      if (name) out.add(name);
    }
    if (r.themeIn) out.add(r.themeIn);
  }
  return out;
}

/** The themes a dump uses that the repos do not bring. */
export const missingThemes = (themes: readonly DumpTheme[], present: ReadonlySet<string>) => themes.filter((t) => !present.has(t.name));

/** What happens to a missing theme unless you choose: one on WordPress.org is installed, one only the server has is copied from it, any other is left. */
export function defaultThemePick(t: DumpTheme, wporg: WporgPlugin | null | undefined, server?: ServerFiles | null): ThemePick {
  if (wporg) return 'install';
  return wporg === null && server?.themes.some((x) => x.name === t.name) ? 'server' : 'leave';
}

/** The themes to install and to copy from the server, from the picks. */
export function themeChoices(missing: readonly DumpTheme[], picks: Readonly<Record<string, ThemePick>>, wporg: Readonly<Record<string, WporgPlugin | null>>, server?: ServerFiles | null) {
  const install: Array<{ slug: string; version?: string }> = [];
  const copy: string[] = [];
  for (const t of missing) {
    const pick = picks[t.name] ?? defaultThemePick(t, wporg[t.name], server);
    if (pick === 'install' && wporg[t.name] && WPORG_SLUG.test(t.name)) install.push({ slug: t.name, ...(t.version ? { version: t.version } : {}) });
    if (pick === 'server' && server?.themes.some((x) => x.name === t.name) && SERVER_ITEM.test(t.name) && !t.name.includes('..')) copy.push(t.name);
  }
  return { install, copy };
}

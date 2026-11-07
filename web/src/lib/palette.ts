import type { ActionId, PaletteEntry, Site } from '@devmagic-panel/shared';
import { paletteEntries } from '@devmagic-panel/shared';
import { match } from './router.js';
import { siteName, siteTarget } from './site-ref.js';

export interface PaletteRun {
  key: string;
  id: ActionId;
  entry: PaletteEntry;
  /** What the palette shows: the entry's label, with the site's name unless it is the open site. */
  label: string;
  /** What the toast says: always with the site's name. */
  title: string;
  /** The open site's own commands come first, under This site. */
  here: boolean;
  site?: string;
  input: Record<string, unknown>;
}

/** The site whose page is open, as its domain and path. */
export function currentSite(path: string): { domain: string; path?: string } | null {
  const under = match('/sites/:domain/:path', path);
  if (under?.domain && under.path && under.domain !== 'new') return { domain: under.domain, path: `/${under.path}` };
  const site = match('/sites/:domain', path);
  return site?.domain && site.domain !== 'new' ? { domain: site.domain } : null;
}

/**
 * Whether a palette entry fits a site: git ones need a repository at its
 * root, domain ones a site that is not under a path, and a move to a web
 * server a site on the other one that can move there as it is (one whose
 * .htaccess nginx would leave out needs the Server tab, which asks).
 */
export function entryFits(entry: PaletteEntry, site: Site): boolean {
  if (entry.scope === 'git') return !site.path && Boolean(site.git);
  const server = entry.input?.server;
  if (server !== undefined) return !site.path && site.server !== server && site.move !== undefined && !site.move.refusal && site.move.ignored.length === 0;
  if (entry.scope === 'domain') return !site.path;
  return entry.scope === 'site';
}

/** The registry's palette entries for these sites and the machine, the open site's first. */
export function paletteRuns(sites: Site[], here: { domain: string; path?: string } | null): PaletteRun[] {
  const isHere = (s: Site) => here !== null && s.domain === here.domain && (s.path ?? '') === (here.path ?? '');
  const ordered = [...sites.filter(isHere), ...sites.filter((s) => !isHere(s))];
  const runs = paletteEntries().flatMap(({ id, entry }): PaletteRun[] => {
    if (entry.scope === 'machine') return [{ key: `${id}:${entry.label}`, id, entry, label: entry.label, title: entry.label, here: false, input: { ...entry.input } }];
    return ordered.filter((s) => entryFits(entry, s)).map((s): PaletteRun => {
      const name = siteName(s);
      const input = entry.scope === 'site' ? siteTarget(s) : { domain: s.domain };
      return { key: `${id}:${entry.label}:${name}`, id, entry, label: isHere(s) ? entry.label : `${entry.label} on ${name}`, title: `${entry.label} on ${name}`, here: isHere(s), site: name, input: { ...input, ...entry.input } };
    });
  });
  // WordPress-level actions first, then git, then the domain's certificate.
  const rank = (r: PaletteRun) => ({ site: 0, git: 1, domain: 2, machine: 3 })[r.entry.scope];
  const byScope = runs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
  return [...byScope.filter((r) => r.here), ...byScope.filter((r) => !r.here)];
}

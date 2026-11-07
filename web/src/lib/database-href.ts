import type { Site } from '@devmagic-panel/shared';
import { siteHref } from './site-ref';

/** Where in a table the Tables view is: the table, and its rows or its structure. */
export interface DbPlace {
  table: string | null;
  show: 'rows' | 'structure';
}

export type DbView = 'overview' | 'tables' | 'sql' | 'tools';

/**
 * The Database tab's address: its view, in Tables the table and what of it
 * shows, in Overview the site of a network. Overview is the tab's own
 * address, for a site that has WordPress; another site opens on Tables.
 */
export function databaseHref(site: Pick<Site, 'domain' | 'path'>, view: DbView, location: DbPlace = { table: null, show: 'rows' }, blog = 1): string {
  const q = new URLSearchParams({ tab: 'database' });
  if (view === 'overview') {
    if (blog !== 1) q.set('blog', String(blog));
  } else if (view === 'tables' && location.table) {
    q.set('table', location.table);
    if (location.show === 'structure') q.set('show', 'structure');
  } else {
    q.set('view', view);
  }
  return `${siteHref(site)}?${q.toString()}`;
}

/** The view an address asks for: a table means Tables, view=wordpress (its name before) is Overview, and none is Overview where WordPress is. */
export function databaseView(requested: string | null, table: string | null, wordpress: boolean): DbView {
  if (requested === 'sql' || requested === 'tools') return requested;
  if (requested === 'tables' || table) return 'tables';
  return wordpress ? 'overview' : 'tables';
}

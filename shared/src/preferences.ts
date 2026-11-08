import { z } from 'zod';
import { SITE_SERVERS } from './nginx.js';

/** How the panel looks for you: kept in the panel's database, so every browser you sign in from gets them. */
export const THEMES = ['light', 'dark', 'system'] as const;
export const SITES_VIEWS = ['grid', 'list'] as const;
export const SITES_SORTS = ['newest', 'oldest', 'name', 'name-desc'] as const;

export const SITES_SORT_LABELS: Record<(typeof SITES_SORTS)[number], string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A to Z',
  'name-desc': 'Name Z to A',
};

/** How a database's tables list: by name, or biggest first. */
export const TABLE_SORTS = ['name', 'size'] as const;

/** The lists of the WordPress view that can show every row, not only the first few (kept per site in the browser). */
export const WP_DB_LISTS = ['autoload', 'metaKeys', 'pluginTables', 'pluginOptions', 'health', 'users', 'postTypes', 'cleanup'] as const;
export type WpDbList = (typeof WP_DB_LISTS)[number];
/** How many rows a list of the WordPress view shows before Show all. */
export const WP_DB_LIST_ROWS = 7;

const fields = { theme: z.enum(THEMES), sitesView: z.enum(SITES_VIEWS), sitesSort: z.enum(SITES_SORTS), /** The web server a new site of its own gets, once nginx runs next to Apache. */ newSiteServer: z.enum(SITE_SERVERS), tablesSort: z.enum(TABLE_SORTS), rowDialogFull: z.boolean() };

export const preferences = z.object({
  theme: fields.theme.default('system'),
  sitesView: fields.sitesView.default('grid'),
  sitesSort: fields.sitesSort.default('name'),
  newSiteServer: fields.newSiteServer.default('apache'),
  tablesSort: fields.tablesSort.default('name'),
  /** A row's dialogs (view, edit, duplicate, add) open full screen, as last chosen. */
  rowDialogFull: fields.rowDialogFull.default(false),
});

export type Preferences = z.infer<typeof preferences>;
/** What a save sends: only what changed, so no default fills in the rest. */
export const preferencesUpdate = z.object(fields).partial().strict();
export type PreferencesUpdate = z.infer<typeof preferencesUpdate>;

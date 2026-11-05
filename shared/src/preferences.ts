import { z } from 'zod';

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

const fields = { theme: z.enum(THEMES), sitesView: z.enum(SITES_VIEWS), sitesSort: z.enum(SITES_SORTS) };

export const preferences = z.object({
  theme: fields.theme.default('system'),
  sitesView: fields.sitesView.default('grid'),
  sitesSort: fields.sitesSort.default('name'),
});

export type Preferences = z.infer<typeof preferences>;
/** What a save sends: only what changed, so no default fills in the rest. */
export const preferencesUpdate = z.object(fields).partial().strict();
export type PreferencesUpdate = z.infer<typeof preferencesUpdate>;

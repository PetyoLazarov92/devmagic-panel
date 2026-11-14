import type { ModeId } from '@devmagic-panel/shared';

/** The names a mode gives pages, by their Classic name. Routes and the words inside pages stay as they are. */
const PAGE_NAMES: Partial<Record<ModeId, Record<string, string>>> = {
  wizard: {
    Demo: 'Mirage',
    Mockup: 'Mirage',
    Sites: 'Portals',
    Mail: 'Ravens',
    Services: 'Sentinels',
    'WP Cores': 'Keystones',
    Activity: 'Quests',
    Updates: 'Phoenix',
    Settings: 'Grimoire',
    Modes: 'Glamours',
    Developer: 'Arcana',
    'Developer options': 'Arcana',
  },
};

export function pageName(classic: string, mode: ModeId): string {
  return PAGE_NAMES[mode]?.[classic] ?? classic;
}

/** The few lines a mode says its own way. Errors, warnings, status labels and anything that removes something never change. */
const TEXT = {
  newSite: { classic: 'New site', wizard: 'Conjure a site' },
  search: { classic: 'Search sites and actions', wizard: 'Search the portals' },
  palette: { classic: 'Jump to a site, a tab or a view, or run an action', wizard: 'Cast a command...' },
  aiReading: { classic: 'Claude is reading your sites...', wizard: 'Scrying your sites...' },
  allGood: { classic: 'All good', wizard: 'All wards hold' },
  noJobs: { classic: 'No jobs since the panel started', wizard: 'No quests since the panel woke' },
} satisfies Record<string, { classic: string } & Partial<Record<ModeId, string>>>;
export type ModeTextKey = keyof typeof TEXT;

export function modeText(key: ModeTextKey, mode: ModeId): string {
  const entry: { classic: string } & Partial<Record<ModeId, string>> = TEXT[key];
  return entry[mode] ?? entry.classic;
}

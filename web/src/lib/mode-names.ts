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
  circuit: {
    Demo: 'Simulation',
    Mockup: 'Simulation',
    Sites: 'Nodes',
    Aura: 'Diagnostics',
    Mail: 'Comms',
    Services: 'Systems',
    'WP Cores': 'Cores',
    Activity: 'Ops log',
    Sanctum: 'Mainframe',
    Updates: 'Firmware',
    Settings: 'Config',
    Modes: 'Interface',
    Developer: 'Debug',
    'Developer options': 'Debug',
  },
};

export function pageName(classic: string, mode: ModeId): string {
  return PAGE_NAMES[mode]?.[classic] ?? classic;
}

/** The few lines a mode says its own way. Errors, warnings, status labels and anything that removes something never change. */
const TEXT = {
  newSite: { classic: 'New site', wizard: 'Conjure a site', circuit: 'Deploy a site' },
  search: { classic: 'Search sites and actions', wizard: 'Search the portals', circuit: 'Search nodes and commands' },
  palette: { classic: 'Jump to a site, a tab or a view, or run an action', wizard: 'Cast a command...', circuit: 'Enter a command_' },
  aiReading: { classic: 'Claude is reading your sites...', wizard: 'Scrying your sites...', circuit: 'Scanning your sites...' },
  allGood: { classic: 'All good', wizard: 'All wards hold', circuit: 'All systems nominal' },
  noJobs: { classic: 'No jobs since the panel started', wizard: 'No quests since the panel woke', circuit: 'Log empty' },
} satisfies Record<string, { classic: string } & Partial<Record<ModeId, string>>>;
export type ModeTextKey = keyof typeof TEXT;

export function modeText(key: ModeTextKey, mode: ModeId): string {
  const entry: { classic: string } & Partial<Record<ModeId, string>> = TEXT[key];
  return entry[mode] ?? entry.classic;
}

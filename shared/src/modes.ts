import { z } from 'zod';

/**
 * Modes: looks that sit on top of the light and dark theme. Classic is always
 * there; the others start sealed and unlock from normal use of the panel, by
 * the first of their paths to reach its goal, or by a word typed in Ctrl+K.
 *
 * The rules live here and nowhere else: the docs, the changelog, commit
 * messages and the UI never spell out how a mode unlocks before it does.
 */
export const MODES = ['classic', 'wizard'] as const;
export type ModeId = (typeof MODES)[number];
export type SealedModeId = Exclude<ModeId, 'classic'>;

export const MODE_INFO: Record<ModeId, { title: string; description: string }> = {
  classic: { title: 'Classic', description: 'The panel as you know it. Every mode works in light and dark.' },
  wizard: { title: 'Wizard', description: 'Enchanted paper, rune circles, star dust, and a few pages with a story.' },
};

/** What a mode's effects can do, each switched on its own. */
export const MODE_EFFECTS = ['pointer', 'elements', 'background'] as const;
export type ModeEffect = (typeof MODE_EFFECTS)[number];
export const modeEffects = z.object({ pointer: z.boolean(), elements: z.boolean(), background: z.boolean() });
export type ModeEffects = z.infer<typeof modeEffects>;
export const EFFECTS_OFF: ModeEffects = { pointer: false, elements: false, background: false };
export const EFFECTS_ON: ModeEffects = { pointer: true, elements: true, background: true };

export const MODE_EFFECT_INFO: Record<ModeEffect, { label: string; what: string }> = {
  pointer: { label: 'Pointer', what: 'A light that follows your cursor, and a few stars when you click.' },
  elements: { label: 'Elements', what: 'A glow on a broken site, a pulse on a healthy one, turning rune circles.' },
  background: { label: 'Background', what: 'A soft glow behind the pages, and motes drifting up.' },
};

/** What the panel counts. A path reads one counter from the point it started. */
export const MODE_COUNTERS = ['siteWizard', 'undo', 'auraFix', 'paletteCommand', 'nginxSite', 'sqlQuery'] as const;
export type ModeCounter = (typeof MODE_COUNTERS)[number];
/** The counters the browser reports itself; the rest the server counts as things finish. */
export const BROWSER_COUNTERS = ['auraFix', 'paletteCommand'] as const satisfies readonly ModeCounter[];
export type BrowserCounter = (typeof BROWSER_COUNTERS)[number];

export interface ModePath {
  id: string;
  mode: SealedModeId;
  counter: ModeCounter;
  goal: number;
  /** Shown on the sealed card. */
  riddle: string;
  /** Shown in the unlock dialog when this path wins. */
  line: string;
  /** The rule, said plainly: only Developer options shows it. */
  rule: string;
}

export const MODE_PATHS: ModePath[] = [
  { id: 'wizard.wizard', mode: 'wizard', counter: 'siteWizard', goal: 3, riddle: "Walk the wizard's path three times.", line: 'Three sites, conjured through the wizard.', rule: 'Finish the New site wizard 3 times' },
  { id: 'wizard.undo', mode: 'wizard', counter: 'undo', goal: 3, riddle: 'Bend time three times.', line: 'Three times you turned back time.', rule: 'Use Undo 3 times' },
  { id: 'wizard.aura', mode: 'wizard', counter: 'auraFix', goal: 5, riddle: 'Mend five ailments.', line: 'Five ailments, mended.', rule: 'Apply 5 fixes from Aura' },
];

/** Typed in Ctrl+K, a word unlocks its mode at once. */
export const MODE_WORDS: Record<SealedModeId, string> = { wizard: 'abracadabra' };
export const MODE_WORD_LINE: Record<SealedModeId, string> = { wizard: 'You spoke the word.' };
/** Ends every line of a mode's unlock dialog. */
export const MODE_UNLOCK_TAIL: Record<SealedModeId, string> = { wizard: 'The panel thinks you have earned a robe.' };

/** How a mode was unlocked: a path's id, its word, or by hand in Developer options. */
export type UnlockedBy = string;

export interface ModesState {
  counters: Partial<Record<ModeCounter, number>>;
  /** Where each path started counting: the counter's value then, and when. */
  starts: Record<string, { from: number; since: string }>;
  unlocks: Partial<Record<SealedModeId, { at: string; by: UnlockedBy; seen: boolean }>>;
  /** Things counted once each, like the sites moved to nginx. */
  once: Partial<Record<ModeCounter, string[]>>;
  /** When counting began, for paths that never started over. */
  since: string;
}

export function emptyModesState(now = new Date()): ModesState {
  return { counters: {}, starts: {}, unlocks: {}, once: {}, since: now.toISOString() };
}

/** A saved state, or a fresh one when what is saved does not read as one. */
export function readModesState(raw: string | undefined, now = new Date()): ModesState {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<ModesState>) : {};
    if (!value || typeof value !== 'object') return emptyModesState(now);
    return {
      counters: typeof value.counters === 'object' && value.counters ? value.counters : {},
      starts: typeof value.starts === 'object' && value.starts ? value.starts : {},
      unlocks: typeof value.unlocks === 'object' && value.unlocks ? value.unlocks : {},
      once: typeof value.once === 'object' && value.once ? value.once : {},
      since: typeof value.since === 'string' ? value.since : now.toISOString(),
    };
  } catch {
    return emptyModesState(now);
  }
}

export function pathProgress(state: ModesState, path: ModePath): number {
  return Math.max(0, (state.counters[path.counter] ?? 0) - (state.starts[path.id]?.from ?? 0));
}

export function isUnlocked(state: ModesState, mode: ModeId): boolean {
  return mode === 'classic' || state.unlocks[mode] !== undefined;
}

function unlock(state: ModesState, mode: SealedModeId, by: UnlockedBy, now: Date): void {
  state.unlocks[mode] = { at: now.toISOString(), by, seen: false };
}

/** Unlocks every sealed mode one of whose paths reached its goal, the first path in the list winning a tie; returns the modes it unlocked. */
export function checkPaths(state: ModesState, now = new Date()): SealedModeId[] {
  const unlocked: SealedModeId[] = [];
  for (const path of MODE_PATHS) {
    if (isUnlocked(state, path.mode) || pathProgress(state, path) < path.goal) continue;
    unlock(state, path.mode, path.id, now);
    unlocked.push(path.mode);
  }
  return unlocked;
}

/** Counts one more; with `key`, only the first time for that key (a site moved to nginx counts once). Changes `state`. */
export function countMode(state: ModesState, counter: ModeCounter, now = new Date(), key?: string): SealedModeId[] {
  if (key !== undefined) {
    const seen = state.once[counter] ?? [];
    if (seen.includes(key)) return [];
    state.once[counter] = [...seen, key].slice(-200);
  }
  state.counters[counter] = (state.counters[counter] ?? 0) + 1;
  return checkPaths(state, now);
}

/** A word typed in Ctrl+K: unlocks its mode when it is one, and is never kept. Changes `state`. */
export function speakWord(state: ModesState, text: string, now = new Date()): SealedModeId | null {
  const word = text.trim().toLowerCase();
  const mode = (Object.keys(MODE_WORDS) as SealedModeId[]).find((m) => MODE_WORDS[m] === word);
  if (!mode || isUnlocked(state, mode)) return null;
  unlock(state, mode, 'word', now);
  return mode;
}

/** What the Modes page and the unlock dialog see: never a rule or a count. */
export interface ModeView {
  id: ModeId;
  title: string;
  description: string;
  unlocked: boolean;
  unlockedAt?: string;
  /** The sealed card's riddles, one per path; `weakening` once that path is past half way. */
  riddles?: Array<{ text: string; weakening: boolean }>;
  /** For the unlock dialog: what earned it, with the mode's own ending. */
  unlockLine?: string;
}

export interface ModesView {
  modes: ModeView[];
  /** Unlocked, and the dialog has not been shown yet. */
  fresh: SealedModeId[];
}

function unlockLine(mode: SealedModeId, by: UnlockedBy): string {
  const first = by === 'word' ? MODE_WORD_LINE[mode] : by === 'developer' ? 'Unlocked from Developer options.' : (MODE_PATHS.find((p) => p.id === by)?.line ?? '');
  return [first, MODE_UNLOCK_TAIL[mode]].filter(Boolean).join(' ');
}

export function modesView(state: ModesState): ModesView {
  const modes = MODES.map((id): ModeView => {
    const base = { id, ...MODE_INFO[id] };
    if (id === 'classic') return { ...base, unlocked: true };
    const done = state.unlocks[id];
    if (done) return { ...base, unlocked: true, unlockedAt: done.at, unlockLine: unlockLine(id, done.by) };
    const riddles = MODE_PATHS.filter((p) => p.mode === id).map((p) => ({ text: p.riddle, weakening: pathProgress(state, p) * 2 >= p.goal }));
    return { ...base, unlocked: false, riddles };
  });
  const fresh = (Object.keys(state.unlocks) as SealedModeId[]).filter((m) => state.unlocks[m]?.seen === false && (MODES as readonly string[]).includes(m));
  return { modes, fresh };
}

/** Developer options' view: the rules, each path's progress, and the raw counters. */
export interface ModesDeveloperView {
  modes: Array<{
    id: SealedModeId;
    title: string;
    unlocked?: { at: string; by: UnlockedBy; byLabel: string; seen: boolean };
    word: string;
    paths: Array<{ id: string; rule: string; progress: number; goal: number; since: string }>;
  }>;
  counters: Array<{ id: ModeCounter; count: number }>;
}

export function modesDeveloperView(state: ModesState): ModesDeveloperView {
  const sealable = MODES.filter((m): m is SealedModeId => m !== 'classic');
  return {
    modes: sealable.map((id) => {
      const done = state.unlocks[id];
      const byLabel = !done ? '' : done.by === 'word' ? 'the word' : done.by === 'developer' ? 'you, from here' : `the ${MODE_PATHS.find((p) => p.id === done.by)?.id.split('.')[1] ?? done.by} path`;
      return {
        id,
        title: MODE_INFO[id].title,
        ...(done ? { unlocked: { ...done, byLabel } } : {}),
        word: MODE_WORDS[id],
        paths: MODE_PATHS.filter((p) => p.mode === id).map((p) => ({ id: p.id, rule: p.rule, progress: pathProgress(state, p), goal: p.goal, since: state.starts[p.id]?.since ?? state.since })),
      };
    }),
    counters: MODE_COUNTERS.map((id) => ({ id, count: state.counters[id] ?? 0 })),
  };
}

/** Developer options: unlock by hand, seal again, show the dialog again, start a path over or fill it. Each changes `state`. */
export const modesDeveloper = {
  unlock(state: ModesState, mode: SealedModeId, now = new Date()): void {
    if (!isUnlocked(state, mode)) unlock(state, mode, 'developer', now);
  },
  seal(state: ModesState, mode: SealedModeId): void {
    delete state.unlocks[mode];
  },
  replay(state: ModesState, mode: SealedModeId): void {
    const done = state.unlocks[mode];
    if (done) done.seen = false;
  },
  resetPath(state: ModesState, pathId: string, now = new Date()): void {
    const path = MODE_PATHS.find((p) => p.id === pathId);
    if (path) state.starts[path.id] = { from: state.counters[path.counter] ?? 0, since: now.toISOString() };
  },
  resetMode(state: ModesState, mode: SealedModeId, now = new Date()): void {
    for (const p of MODE_PATHS.filter((x) => x.mode === mode)) modesDeveloper.resetPath(state, p.id, now);
  },
  /** Fills a path to its goal, so the real unlock runs: the dialog and its line for that path. */
  completePath(state: ModesState, pathId: string, now = new Date()): SealedModeId[] {
    const path = MODE_PATHS.find((p) => p.id === pathId);
    if (!path) return [];
    const short = path.goal - pathProgress(state, path);
    if (short > 0) state.starts[path.id] = { from: (state.starts[path.id]?.from ?? 0) - short, since: state.starts[path.id]?.since ?? state.since };
    return checkPaths(state, now);
  },
};

export const modeId = z.enum(MODES);
export const sealedModeId = z.enum(MODES.filter((m): m is SealedModeId => m !== 'classic') as [SealedModeId, ...SealedModeId[]]);
export const browserCounter = z.enum(BROWSER_COUNTERS);

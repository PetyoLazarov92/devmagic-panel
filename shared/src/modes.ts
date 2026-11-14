import { z } from 'zod';

/**
 * Modes: looks that sit on top of the light and dark theme. Classic is always
 * there; the others start sealed and unlock from normal use of the panel, by
 * the first of their paths to reach its goal, or by a word typed in Ctrl+K.
 *
 * The rules live here and nowhere else: the docs, the changelog, commit
 * messages and the UI never spell out how a mode unlocks before it does.
 */
export const MODES = ['classic', 'wizard', 'circuit', 'forge', 'grove', 'abyss', 'neon', 'ink', 'dune', 'pixel', 'sorbet'] as const;
export type ModeId = (typeof MODES)[number];
export type SealedModeId = Exclude<ModeId, 'classic'>;

export const MODE_INFO: Record<ModeId, { title: string; description: string }> = {
  classic: { title: 'Classic', description: 'The panel as you know it. Every mode works in light and dark.' },
  wizard: { title: 'Wizard', description: 'Enchanted paper, rune circles, star dust, and a few pages with a story.' },
  circuit: { title: 'Circuit', description: 'Glass panels, a live circuit board behind the pages, and a lock on whatever you point at.' },
  forge: { title: 'Forge', description: 'Iron plates with molten cracks, sparks and embers, and a few pages named for the work.' },
  grove: { title: 'Grove', description: 'Rounded leaves, fireflies and a falling leaf, and a few pages named like a garden.' },
  abyss: { title: 'Abyss', description: 'The deep sea: glowing coral, a jellyfish light and rising bubbles, and a few pages named for the ocean.' },
  neon: { title: 'Neon', description: 'An 80s night: magenta and sunset orange, a light trail, a glowing grid, and a few pages named for the arcade.' },
  ink: { title: 'Ink', description: 'Black ink on rice paper: a brushed circle and a red seal, a drop of ink where you click, and a few pages named for the scroll.' },
  dune: { title: 'Dune', description: 'Sand and terracotta: dune lines under a low sun, a trail of sand behind your cursor, and a few pages named for the desert.' },
  pixel: { title: 'Pixel', description: 'Square edges and hard shadows: a pixel heart over stepped hills, a +1 where you click, and a few pages named for the game.' },
  sorbet: { title: 'Sorbet', description: 'Pastel mint, strawberry and lemon: rounded everything, three scoops in each corner, sprinkles where you click, and a few pages named for the ice cream parlor.' },
};

/** What a mode's effects can do, each switched on its own. */
export const MODE_EFFECTS = ['pointer', 'elements', 'background'] as const;
export type ModeEffect = (typeof MODE_EFFECTS)[number];
export const modeEffects = z.object({ pointer: z.boolean(), elements: z.boolean(), background: z.boolean() });
export type ModeEffects = z.infer<typeof modeEffects>;
export const EFFECTS_OFF: ModeEffects = { pointer: false, elements: false, background: false };
export const EFFECTS_ON: ModeEffects = { pointer: true, elements: true, background: true };

export const MODE_EFFECT_LABEL: Record<ModeEffect, string> = { pointer: 'Pointer', elements: 'Elements', background: 'Background' };
/** What each effect does in each mode. */
export const MODE_EFFECT_INFO: Record<SealedModeId, Record<ModeEffect, string>> = {
  wizard: {
    pointer: 'A light that follows your cursor, and a few stars when you click.',
    elements: 'A glow on a broken site, a pulse on a healthy one, turning rune circles.',
    background: 'A soft glow behind the pages, and motes drifting up.',
  },
  circuit: {
    pointer: 'A reticle that follows your cursor and locks onto what you point at, with a ring when you click.',
    elements: "A glint of light passes over a card now and then, a broken site's outline pulses red, a healthy one's light breathes.",
    background: 'Light runs along the circuit board behind the pages.',
  },
  forge: {
    pointer: 'Sparks fly when you click.',
    elements: 'The cracks in each card breathe, a broken site glows like hot metal, a gear turns where something runs.',
    background: 'Embers rise slowly from the bottom of the page.',
  },
  grove: {
    pointer: 'A firefly follows your cursor, slowly.',
    elements: 'A healthy site glows like a firefly, a broken one turns autumn brown at its edge, a seed sprouts where something runs.',
    background: 'A few fireflies drift, and leaves fall now and then, a few at a time.',
  },
  abyss: {
    pointer: 'A jellyfish glow follows your cursor, and a click sends up a few bubbles.',
    elements: 'The coral in each card breathes, a healthy site glows aqua, a broken one glows anemone red, a shell turns where something runs.',
    background: 'Bubbles rise slowly under light falling from the surface.',
  },
  neon: {
    pointer: 'A short light trail follows your cursor, and a click sends out a ring of light.',
    elements: 'Card titles glow like neon, a healthy site glows like a tube, a broken one flickers like a failing sign, a cassette reel turns where something runs.',
    background: 'A glowing grid drifts very slowly toward you along the bottom of the page, under a few stars.',
  },
  ink: {
    pointer: 'A click leaves a drop of ink that spreads and fades.',
    elements: "A brush line draws itself under a page's title, a broken site bleeds red ink at its edge, a healthy site's dot spreads softly, a brushed circle draws itself where something runs.",
    background: 'A faint paper grain, and a soft wash of ink drifting slowly across the page.',
  },
  dune: {
    pointer: 'A few grains of sand trail your cursor while it moves, then settle and fade.',
    elements: "The sun in each card's corner glows slowly, a broken site's edge glows red like heat, a healthy site's dot glows warm, an hourglass turns where something runs.",
    background: 'A warm haze along the bottom of the page, and now and then a thin drift of sand crossing it.',
  },
  pixel: {
    pointer: 'A click shows a +1 floating up and a few square sparks.',
    elements: "A broken site's card blinks its border in steps, a healthy site's square dot blinks softly, a ring of squares lights up where something runs.",
    background: 'A few square stars blink slowly behind the pages.',
  },
  sorbet: {
    pointer: 'A click pops a few pastel sprinkles that fall and fade.',
    elements: "The scoops in each card's corner bob slowly, a broken site glows soft strawberry at its edge, a healthy site's dot glows mint, three scoops circle where something runs.",
    background: 'Soft blobs of mint, strawberry and lemon drift slowly behind the pages.',
  },
};

/** What the panel counts. A path reads one counter from the point it started. */
export const MODE_COUNTERS = ['siteWizard', 'undo', 'auraFix', 'paletteCommand', 'nginxSite', 'sqlQuery', 'panelUpdate', 'pluginUpdate', 'phpSwitch', 'healthyDay', 'vulnCheckDay', 'restore', 'fileFind', 'mailDay', 'lateNight', 'wpLogin', 'serverCopy', 'fileSave', 'certReissue', 'dbClean', 'usedDay', 'dbSnapshot', 'cronTask', 'modeEarned', 'jobContinue', 'itemInstall', 'cacheClear', 'pluginToggle', 'branchSwitch'] as const;
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
  /**
   * For a mode added after counting began: the path counts from when the panel
   * first saw it, not from what its counter held already, so a new mode is
   * earned from the release that brings it.
   */
  startsFresh?: true;
}

export const MODE_PATHS: ModePath[] = [
  { id: 'wizard.wizard', mode: 'wizard', counter: 'siteWizard', goal: 3, riddle: "Walk the wizard's path three times.", line: 'Three sites, conjured through the wizard.', rule: 'Finish the New site wizard 3 times' },
  { id: 'wizard.undo', mode: 'wizard', counter: 'undo', goal: 3, riddle: 'Bend time three times.', line: 'Three times you turned back time.', rule: 'Use Undo 3 times' },
  { id: 'wizard.aura', mode: 'wizard', counter: 'auraFix', goal: 5, riddle: 'Mend five ailments.', line: 'Five ailments, mended.', rule: 'Apply 5 fixes from Aura' },
  { id: 'circuit.keyboard', mode: 'circuit', counter: 'paletteCommand', goal: 40, riddle: 'Forty orders, and never a click.', line: 'Forty commands from Ctrl+K: you clearly prefer the keyboard.', rule: 'Run 40 commands from Ctrl+K', startsFresh: true },
  { id: 'circuit.servers', mode: 'circuit', counter: 'nginxSite', goal: 1, riddle: 'Two servers, one machine.', line: 'A site on nginx, next to Apache: you know your way around a server.', rule: 'Move a site to nginx, or put nginx in front of one', startsFresh: true },
  { id: 'circuit.queries', mode: 'circuit', counter: 'sqlQuery', goal: 25, riddle: 'Ask the database twenty-five questions.', line: 'Twenty-five questions for the database: you like to look under the hood.', rule: 'Run 25 queries in the SQL runner', startsFresh: true },
  { id: 'forge.updates', mode: 'forge', counter: 'panelUpdate', goal: 5, riddle: 'Rise from the ashes five times.', line: 'Five times the panel rose from the ashes.', rule: 'Update the panel 5 times', startsFresh: true },
  { id: 'forge.temper', mode: 'forge', counter: 'pluginUpdate', goal: 25, riddle: 'Temper twenty-five blades.', line: 'Twenty-five plugins and themes, tempered.', rule: 'Update 25 plugins or themes', startsFresh: true },
  { id: 'forge.metal', mode: 'forge', counter: 'phpSwitch', goal: 5, riddle: 'Change the metal five times.', line: 'Five times you changed the metal.', rule: "Switch a site's PHP version 5 times", startsFresh: true },
  { id: 'grove.bloom', mode: 'grove', counter: 'healthyDay', goal: 7, riddle: 'Seven days of every garden flowering.', line: 'Seven days with every garden flowering.', rule: 'Have every site Healthy (3 or more) on 7 different days', startsFresh: true },
  { id: 'grove.tend', mode: 'grove', counter: 'auraFix', goal: 15, riddle: 'Tend fifteen hurts.', line: 'Fifteen hurts, tended.', rule: 'Apply 15 fixes from Aura', startsFresh: true },
  { id: 'grove.watch', mode: 'grove', counter: 'vulnCheckDay', goal: 30, riddle: 'Keep watch for thirty days.', line: 'Thirty days of keeping watch.', rule: 'Let the vulnerability check run on 30 different days', startsFresh: true },
  { id: 'abyss.salvage', mode: 'abyss', counter: 'restore', goal: 3, riddle: 'Bring three things back from the deep.', line: 'Three things, brought back from the deep.', rule: 'Restore 3 times: a database, kept tables, a removed site or a deleted file', startsFresh: true },
  { id: 'abyss.search', mode: 'abyss', counter: 'fileFind', goal: 20, riddle: 'Search the depths twenty times.', line: 'Twenty searches of the depths.', rule: "Search with the Files tab's find 20 times", startsFresh: true },
  { id: 'abyss.bottles', mode: 'abyss', counter: 'mailDay', goal: 10, riddle: 'Ten days of messages in bottles.', line: 'Ten days of messages in bottles.', rule: 'Open Mail on 10 different days', startsFresh: true },
  { id: 'neon.nights', mode: 'neon', counter: 'lateNight', goal: 5, riddle: 'Five nights when only the signs are still awake.', line: 'Five nights awake with the signs.', rule: 'Do something in the panel between midnight and 4 in the morning on 5 different nights', startsFresh: true },
  { id: 'neon.doors', mode: 'neon', counter: 'wpLogin', goal: 50, riddle: 'Fifty doors opened without a key.', line: 'Fifty doors, opened without a key.', rule: "Sign in to wp-admin with the panel's one-click login 50 times", startsFresh: true },
  { id: 'neon.tapes', mode: 'neon', counter: 'serverCopy', goal: 5, riddle: 'Five tapes brought home from the city.', line: 'Five tapes, brought home from the city.', rule: "Copy plugins, themes or uploads from a site's server 5 times", startsFresh: true },
  { id: 'ink.pages', mode: 'ink', counter: 'fileSave', goal: 30, riddle: 'Fill thirty pages by your own hand.', line: 'Thirty pages, filled by your own hand.', rule: 'Save 30 files in the Files tab', startsFresh: true },
  { id: 'ink.seals', mode: 'ink', counter: 'certReissue', goal: 10, riddle: 'Press the seal ten times.', line: 'Ten seals, pressed.', rule: "Reissue a site's certificate 10 times", startsFresh: true },
  { id: 'ink.wash', mode: 'ink', counter: 'dbClean', goal: 10, riddle: 'Rinse the stone clean ten times.', line: 'Ten times the stone rinsed clean.', rule: "Clean up a site's database 10 times: transients, revisions and the like, or leftovers", startsFresh: true },
  { id: 'dune.crossing', mode: 'dune', counter: 'usedDay', goal: 30, riddle: 'Thirty days across the sand.', line: 'Thirty days across the sand.', rule: 'Do something in the panel on 30 different days', startsFresh: true },
  { id: 'dune.water', mode: 'dune', counter: 'dbSnapshot', goal: 10, riddle: 'Carry water ten times before the crossing.', line: 'Ten skins of water, carried for the crossing.', rule: 'Take 10 database snapshots yourself', startsFresh: true },
  { id: 'dune.sundial', mode: 'dune', counter: 'cronTask', goal: 5, riddle: 'Set the sundial five times.', line: 'Five shadows, set on the sundial.', rule: 'Add 5 scheduled tasks on the Cron page', startsFresh: true },
  { id: 'pixel.worlds', mode: 'pixel', counter: 'modeEarned', goal: 5, riddle: 'Clear five worlds.', line: 'Five worlds cleared.', rule: "Unlock 5 other modes yourself, by a path or a word (Developer options' unlocks do not count); modes earned before this release count too" },
  { id: 'pixel.continues', mode: 'pixel', counter: 'jobContinue', goal: 5, riddle: 'Continue five times after the game is over.', line: 'Five continues, and you kept playing.', rule: 'Retry or skip a failed step of a job 5 times', startsFresh: true },
  { id: 'pixel.items', mode: 'pixel', counter: 'itemInstall', goal: 20, riddle: 'Pick up twenty items along the way.', line: 'Twenty items picked up along the way.', rule: 'Install 20 plugins or themes from WordPress.org through the panel', startsFresh: true },
  { id: 'sorbet.chill', mode: 'sorbet', counter: 'cacheClear', goal: 20, riddle: 'Cool it down twenty times.', line: 'Twenty times you cooled it down.', rule: "Clear a site's cache 20 times", startsFresh: true },
  { id: 'sorbet.toppings', mode: 'sorbet', counter: 'pluginToggle', goal: 30, riddle: 'Swap thirty toppings.', line: 'Thirty toppings, swapped.', rule: 'Turn a plugin on or off 30 times', startsFresh: true },
  { id: 'sorbet.flavors', mode: 'sorbet', counter: 'branchSwitch', goal: 15, riddle: 'Try fifteen flavors.', line: 'Fifteen flavors, tried.', rule: "Switch a repo's branch 15 times", startsFresh: true },
];

/** Typed in Ctrl+K, a word unlocks its mode at once. */
export const MODE_WORDS: Record<SealedModeId, string> = { wizard: 'abracadabra', circuit: 'overclock', forge: 'ignite', grove: 'bloom', abyss: 'dive', neon: 'afterglow', ink: 'calligraphy', dune: 'sandstorm', pixel: 'extralife', sorbet: 'brainfreeze' };
export const MODE_WORD_LINE: Record<SealedModeId, string> = { wizard: 'You spoke the word.', circuit: 'Override accepted.', forge: 'The fire caught.', grove: 'Something took root.', abyss: 'You took the plunge.', neon: 'The lights flickered on.', ink: 'The ink took to the paper.', dune: 'The storm let you through.', pixel: 'One extra life.', sorbet: 'Brain freeze, worth it.' };
/** Ends every line of a mode's unlock dialog. */
export const MODE_UNLOCK_TAIL: Record<SealedModeId, string> = { wizard: 'The panel thinks you have earned a robe.', circuit: 'Systems online.', forge: 'The forge is lit.', grove: 'The grove is growing.', abyss: 'The deep opens.', neon: 'The city never sleeps.', ink: 'The page is yours.', dune: 'The dunes are shifting.', pixel: 'Player one, ready.', sorbet: 'Help yourself to a scoop.' };

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
  const count = state.counters[path.counter] ?? 0;
  // A path that starts fresh and has not been seen yet has counted nothing so far.
  const from = state.starts[path.id]?.from ?? (path.startsFresh ? count : 0);
  return Math.max(0, count - from);
}

/**
 * Gives every path that starts fresh its starting point the first time the
 * panel sees it, and counts the modes earned before the earned count began.
 * Changes `state`.
 */
export function startFreshPaths(state: ModesState, now = new Date()): void {
  if (state.counters.modeEarned === undefined) {
    const earned = (Object.keys(state.unlocks) as SealedModeId[]).filter((m) => state.unlocks[m] && state.unlocks[m]?.by !== 'developer');
    state.once.modeEarned = earned;
    state.counters.modeEarned = earned.length;
  }
  for (const path of MODE_PATHS) {
    if (path.startsFresh && !state.starts[path.id]) state.starts[path.id] = { from: state.counters[path.counter] ?? 0, since: now.toISOString() };
  }
}

export function isUnlocked(state: ModesState, mode: ModeId): boolean {
  return mode === 'classic' || state.unlocks[mode] !== undefined;
}

function unlock(state: ModesState, mode: SealedModeId, by: UnlockedBy, now: Date): void {
  state.unlocks[mode] = { at: now.toISOString(), by, seen: false };
  // A mode earned by a path or a word, not opened from Developer options: one more world cleared, once per mode.
  const earned = state.once.modeEarned ?? [];
  if (by !== 'developer' && !earned.includes(mode)) {
    state.once.modeEarned = [...earned, mode];
    state.counters.modeEarned = (state.counters.modeEarned ?? 0) + 1;
  }
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

/** Counts one more, or `amount` more; with `key`, only the first time for that key (a site moved to nginx counts once). Changes `state`. */
export function countMode(state: ModesState, counter: ModeCounter, now = new Date(), key?: string, amount = 1): SealedModeId[] {
  startFreshPaths(state, now);
  if (key !== undefined) {
    const seen = state.once[counter] ?? [];
    if (seen.includes(key)) return [];
    state.once[counter] = [...seen, key].slice(-200);
  }
  state.counters[counter] = (state.counters[counter] ?? 0) + Math.max(1, Math.floor(amount));
  return checkPaths(state, now);
}

/** A word typed in Ctrl+K: unlocks its mode when it is one, and is never kept. Changes `state`. */
export function speakWord(state: ModesState, text: string, now = new Date()): SealedModeId | null {
  const word = text.trim().toLowerCase();
  const mode = (Object.keys(MODE_WORDS) as SealedModeId[]).find((m) => MODE_WORDS[m] === word);
  if (!mode || isUnlocked(state, mode)) return null;
  unlock(state, mode, 'word', now);
  // A mode earned may finish a path that counts modes earned; that one shows its own dialog after.
  checkPaths(state, now);
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

/**
 * Developer options: unlock by hand, seal again, start a path over or fill it.
 * An unlock from there brings up the unlock dialog, as any other. Each changes
 * `state`.
 */
export const modesDeveloper = {
  unlock(state: ModesState, mode: SealedModeId, now = new Date()): void {
    if (!isUnlocked(state, mode)) unlock(state, mode, 'developer', now);
  },
  seal(state: ModesState, mode: SealedModeId): void {
    delete state.unlocks[mode];
  },
  resetPath(state: ModesState, pathId: string, now = new Date()): void {
    const path = MODE_PATHS.find((p) => p.id === pathId);
    if (path) state.starts[path.id] = { from: state.counters[path.counter] ?? 0, since: now.toISOString() };
  },
  resetMode(state: ModesState, mode: SealedModeId, now = new Date()): void {
    for (const p of MODE_PATHS.filter((x) => x.mode === mode)) modesDeveloper.resetPath(state, p.id, now);
  },
  /** Fills a path to its goal, so the real unlock runs: the dialog, with that path's line. */
  completePath(state: ModesState, pathId: string, now = new Date()): SealedModeId[] {
    const path = MODE_PATHS.find((p) => p.id === pathId);
    if (!path) return [];
    startFreshPaths(state, now);
    const short = path.goal - pathProgress(state, path);
    if (short > 0) state.starts[path.id] = { from: (state.starts[path.id]?.from ?? 0) - short, since: state.starts[path.id]?.since ?? state.since };
    return checkPaths(state, now);
  },
};

export const modeId = z.enum(MODES);
export const sealedModeId = z.enum(MODES.filter((m): m is SealedModeId => m !== 'classic') as [SealedModeId, ...SealedModeId[]]);
export const browserCounter = z.enum(BROWSER_COUNTERS);

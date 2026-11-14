import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODE_WORDS } from '@devmagic-panel/shared';
import { modeText, pageName } from '../src/lib/mode-names.js';
import { modeDots } from '../src/lib/mode-dots.js';

/** Every source file of the web app, but the mockup's stand-in for the server. */
function webSources(dir = join(__dirname, '../src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'mock' ? [] : webSources(path);
    return /\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

describe('the modes secrets stay out of the web app', () => {
  it('never imports the words, the paths or the daily lines outside the mockup', () => {
    const secret = /\b(MODE_WORDS|MODE_WORD_LINE|MODE_PATHS|modeForWord|speakWord|DAILY_LINES|MODE_PUZZLES|modesDeveloperView)\b/;
    const offenders = webSources().filter((file) => secret.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it("keeps the public demo's modes free of them: every mode open, nothing about how one opens", async () => {
    const source = readFileSync(join(__dirname, '../src/mock/modes-demo.ts'), 'utf8');
    expect(source).not.toMatch(/\b(MODE_WORDS|MODE_WORD_LINE|MODE_PATHS|modeForWord|speakWord|DAILY_LINES|dailyLine\(|checkPaths|countMode|modesDeveloperView|modesView)\b/);
    const { mockModesApi, mockModeOpen } = await import('../src/mock/modes-demo.js');
    const view = await mockModesApi.modes();
    expect(view.modes.every((m) => m.unlocked && !m.riddles)).toBe(true);
    expect(view.fresh).toEqual([]);
    expect(await mockModesApi.modeWordCheck('anything')).toEqual({ mode: null });
    await expect(mockModesApi.dailyLine()).rejects.toThrow();
    await expect(mockModesApi.modesDeveloper()).rejects.toThrow();
    expect(mockModeOpen('storms')).toBe(true);
  });

  it('never writes a word anywhere in its text, not even inside a line', () => {
    const text = webSources().map((file) => readFileSync(file, 'utf8').toLowerCase()).join('\n');
    const found = Object.values(MODE_WORDS).filter((w) => new RegExp(`\\b${w}\\b`).test(text));
    expect(found).toEqual([]);
  });
});

describe('mode names and lines', () => {
  it("gives pages Wizard's names and leaves the rest, and Classic its own", () => {
    expect(pageName('Mail', 'wizard')).toBe('Ravens');
    expect(pageName('Settings', 'wizard')).toBe('Grimoire');
    expect(pageName('Modes', 'wizard')).toBe('Glamours');
    expect(pageName('Aura', 'wizard')).toBe('Aura');
    expect(pageName('local.spellbook.example', 'wizard')).toBe('local.spellbook.example');
    expect(pageName('Mail', 'classic')).toBe('Mail');
  });

  it("gives pages Circuit's names", () => {
    expect(pageName('Sites', 'circuit')).toBe('Nodes');
    expect(pageName('Updates', 'circuit')).toBe('Firmware');
    expect(pageName('Developer options', 'circuit')).toBe('Debug');
    expect(modeText('newSite', 'circuit')).toBe('Deploy a site');
  });

  it("gives pages Forge's names", () => {
    expect(pageName('Sites', 'forge')).toBe('Foundry');
    expect(pageName('Settings', 'forge')).toBe('Blueprints');
    expect(modeText('allGood', 'forge')).toBe('All fires lit');
  });

  it("gives pages Grove's names", () => {
    expect(pageName('Sites', 'grove')).toBe('Gardens');
    expect(pageName('Aura', 'grove')).toBe('Weather');
    expect(modeText('newSite', 'grove')).toBe('Plant a site');
  });

  it("gives pages Abyss's names", () => {
    expect(pageName('Sites', 'abyss')).toBe('Reefs');
    expect(pageName('Mail', 'abyss')).toBe('Bottles');
    expect(modeText('allGood', 'abyss')).toBe('Calm waters');
  });

  it("gives pages Neon's names", () => {
    expect(pageName('Sites', 'neon')).toBe('Skyline');
    expect(pageName('Activity', 'neon')).toBe('High scores');
    expect(modeText('palette', 'neon')).toBe('Press start...');
  });

  it("gives pages Ink's names", () => {
    expect(pageName('Sites', 'ink')).toBe('Scrolls');
    expect(pageName('Aura', 'ink')).toBe('Proofreading');
    expect(modeText('noJobs', 'ink')).toBe('Blank page');
  });

  it("gives pages Dune's names", () => {
    expect(pageName('Sites', 'dune')).toBe('Dunes');
    expect(pageName('Activity', 'dune')).toBe('Footprints');
    expect(modeText('allGood', 'dune')).toBe('Clear skies');
  });

  it("gives pages Pixel's names", () => {
    expect(pageName('Sites', 'pixel')).toBe('Levels');
    expect(pageName('Settings', 'pixel')).toBe('Options');
    expect(modeText('newSite', 'pixel')).toBe('New game');
  });

  it("gives pages Sorbet's names", () => {
    expect(pageName('Sites', 'sorbet')).toBe('Scoops');
    expect(pageName('Services', 'sorbet')).toBe('Freezer');
    expect(modeText('palette', 'sorbet')).toBe('What flavor?');
  });

  it("gives pages Art Deco's names", () => {
    expect(pageName('Sites', 'deco')).toBe('Suites');
    expect(pageName('Aura', 'deco')).toBe('Concierge');
    expect(modeText('allGood', 'deco')).toBe('All in order');
  });

  it("gives pages Atlas's names", () => {
    expect(pageName('Sites', 'atlas')).toBe('Lands');
    expect(pageName('Activity', 'atlas')).toBe("Ship's log");
    expect(modeText('palette', 'atlas')).toBe('Set a course...');
  });

  it("gives pages Frostfall's names", () => {
    expect(pageName('Sites', 'frostfall')).toBe('Holdfasts');
    expect(pageName('Mail', 'frostfall')).toBe('Ravens');
    expect(modeText('allGood', 'frostfall')).toBe('The walls hold');
  });

  it("gives pages Hall of Storms' names", () => {
    expect(pageName('Sites', 'storms')).toBe('Realms');
    expect(pageName('Activity', 'storms')).toBe('Sagas');
    expect(modeText('aiReading', 'storms')).toBe('Reading the runes...');
  });

  it("gives pages Chrome's names", () => {
    expect(pageName('Sites', 'chrome')).toBe('Fleet');
    expect(pageName('Activity', 'chrome')).toBe('Telemetry');
    expect(modeText('aiReading', 'chrome')).toBe('Running diagnostics...');
  });

  it('says a line its own way in Wizard, and the plain one in Classic', () => {
    expect(modeText('newSite', 'wizard')).toBe('Conjure a site');
    expect(modeText('newSite', 'classic')).toBe('New site');
    expect(modeText('allGood', 'wizard')).toBe('All wards hold');
  });
});

describe("the daily line's dots", () => {
  const view = (open: Array<[string, string]>) => ({
    earned: true,
    fresh: [],
    modes: open.map(([id, at]) => ({ id, title: id, description: '', unlocked: true, unlockedAt: at })),
  }) as unknown as Parameters<typeof modeDots>[0];

  it('lights the modes found in the order they were found, the bonus ones in slots 5, 10 and 15', () => {
    const dots = modeDots(view([['grove', '2026-11-02'], ['wizard', '2026-11-01'], ['atlas', '2026-11-03'], ['classic', '']]));
    expect(dots).toHaveLength(15);
    expect(dots.map((d) => d.mode)).toEqual(['wizard', 'grove', null, null, 'atlas', null, null, null, null, null, null, null, null, null, null]);
    expect(dots.map((d, i) => (d.bonus ? i : -1)).filter((i) => i >= 0)).toEqual([4, 9, 14]);
  });

  it('shows nothing lit before anything is found', () => {
    expect(modeDots(null).every((d) => d.mode === null)).toBe(true);
  });
});


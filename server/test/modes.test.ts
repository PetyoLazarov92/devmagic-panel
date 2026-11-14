import { countMode, emptyModesState, MODE_PATHS, modesDeveloper, modesView, pathProgress, readModesState, speakWord } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { countAction, ModeProgress, newerVersion } from '../src/modes.js';

function memory() {
  const meta = new Map<string, string>();
  return { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => void meta.set(k, v), meta };
}

describe('mode progress', () => {
  it('unlocks a mode by the first path to reach its goal, and the others stop mattering', () => {
    const store = memory();
    const progress = new ModeProgress(store);
    expect(progress.count('undo')).toEqual([]);
    expect(progress.count('siteWizard')).toEqual([]);
    expect(progress.count('siteWizard')).toEqual([]);
    expect(progress.count('siteWizard')).toEqual(['wizard']);
    const dev = progress.developerView().modes[0];
    expect(dev?.unlocked?.by).toBe('wizard.wizard');
    expect(dev?.unlocked?.byLabel).toBe('the wizard path');
    expect(progress.count('undo')).toEqual([]);
    expect(progress.count('undo')).toEqual([]);
    expect(progress.developerView().modes[0]?.unlocked?.by).toBe('wizard.wizard');
  });

  it('says a path is weakening past half way, and never says the rule on the sealed card', () => {
    const state = emptyModesState();
    state.counters.auraFix = 3;
    const wizard = modesView(state).modes.find((m) => m.id === 'wizard');
    expect(wizard?.riddles?.map((r) => r.weakening)).toEqual([false, false, true]);
    expect(JSON.stringify(wizard)).not.toMatch(/Aura|Undo|New site/);
  });

  it('counts a site moved to nginx once, Undo actions, and nothing that failed or is unknown', () => {
    const progress = new ModeProgress(memory());
    countAction(progress, 'site.setServer', { domain: 'local.spellbook.example', server: 'nginx' });
    countAction(progress, 'site.setServer', { domain: 'local.spellbook.example', server: 'nginx-apache' });
    countAction(progress, 'site.setServer', { domain: 'local.shop.com', server: 'apache' });
    countAction(progress, 'cron.undo', {});
    countAction(progress, 'site.create', {});
    const counters = Object.fromEntries(progress.developerView().counters.map((c) => [c.id, c.count]));
    expect(counters).toMatchObject({ nginxSite: 1, undo: 1, siteWizard: 0 });
  });

  it('reports from the browser at most once a second', () => {
    let at = 0;
    const progress = new ModeProgress(memory(), () => new Date(at));
    progress.report('paletteCommand');
    progress.report('paletteCommand');
    at = 1500;
    progress.report('paletteCommand');
    expect(progress.developerView().counters.find((c) => c.id === 'paletteCommand')?.count).toBe(2);
  });

  it('starts one path over without touching the others, and fills one for a test unlock', () => {
    const state = emptyModesState();
    state.counters.undo = 2;
    state.counters.auraFix = 4;
    const undo = MODE_PATHS.find((p) => p.id === 'wizard.undo')!;
    const aura = MODE_PATHS.find((p) => p.id === 'wizard.aura')!;
    modesDeveloper.resetPath(state, 'wizard.undo');
    expect(pathProgress(state, undo)).toBe(0);
    expect(pathProgress(state, aura)).toBe(4);
    expect(modesDeveloper.completePath(state, 'wizard.undo')).toEqual(['wizard']);
    expect(state.unlocks.wizard?.by).toBe('wizard.undo');
    modesDeveloper.seal(state, 'wizard');
    modesDeveloper.resetMode(state, 'wizard');
    expect(MODE_PATHS.filter((p) => p.mode === 'wizard').map((p) => pathProgress(state, p))).toEqual([0, 0, 0]);
  });

  it("counts a newer mode's paths from when the panel first sees them, and keeps the older mode's progress", () => {
    const state = emptyModesState();
    state.counters.paletteCommand = 55;
    state.counters.undo = 2;
    const keyboard = MODE_PATHS.find((p) => p.id === 'circuit.keyboard')!;
    const undo = MODE_PATHS.find((p) => p.id === 'wizard.undo')!;
    expect(pathProgress(state, keyboard)).toBe(0);
    expect(countMode(state, 'paletteCommand')).toEqual([]);
    expect(pathProgress(state, keyboard)).toBe(1);
    expect(pathProgress(state, undo)).toBe(2);
    for (let i = 0; i < 38; i++) countMode(state, 'paletteCommand');
    expect(countMode(state, 'paletteCommand')).toEqual(['circuit']);
    expect(modesView(state).modes.find((m) => m.id === 'circuit')?.unlockLine).toContain('you clearly prefer the keyboard');
  });

  it('unlocks Circuit by its word, and only an unlocked mode is left alone by it', () => {
    const state = emptyModesState();
    expect(speakWord(state, 'overclocked')).toBeNull();
    expect(speakWord(state, 'OverClock')).toBe('circuit');
    expect(speakWord(state, 'overclock')).toBeNull();
    expect(modesView(state).modes.find((m) => m.id === 'circuit')?.unlockLine).toBe('Override accepted. Systems online.');
  });

  it("counts Forge's paths: each plugin or theme updated, each PHP switch, and a start on a newer panel version", () => {
    const store = memory();
    const progress = new ModeProgress(store);
    countAction(progress, 'site.updatePlugins', { domain: 'local.spellbook.example', plugins: ['wandworks-forms', 'wandworks-seo'], themes: ['wandworks'] });
    countAction(progress, 'site.setPhp', { domain: 'local.spellbook.example', version: '8.3' });
    expect(progress.noteVersion('1.50.0')).toEqual([]);
    progress.noteVersion('1.50.0');
    progress.noteVersion('1.49.1');
    progress.noteVersion('1.51.0');
    const counters = Object.fromEntries(progress.developerView().counters.map((c) => [c.id, c.count]));
    expect(counters).toMatchObject({ pluginUpdate: 3, phpSwitch: 1, panelUpdate: 1 });
    for (let i = 0; i < 4; i++) countAction(progress, 'site.setPhp', {});
    expect(progress.developerView().modes.find((m) => m.id === 'forge')?.unlocked?.by).toBe('forge.metal');
  });

  it("counts Grove's healthy days and check days once per day each, and its own Aura fixes from when it is first seen", () => {
    const state = emptyModesState();
    state.counters.auraFix = 12;
    const tend = MODE_PATHS.find((p) => p.id === 'grove.tend')!;
    const bloom = MODE_PATHS.find((p) => p.id === 'grove.bloom')!;
    expect(pathProgress(state, tend)).toBe(0);
    countMode(state, 'healthyDay', new Date('2026-11-14T09:00:00Z'), '2026-11-14');
    countMode(state, 'healthyDay', new Date('2026-11-14T17:00:00Z'), '2026-11-14');
    expect(pathProgress(state, bloom)).toBe(1);
    for (let d = 15; d <= 20; d++) countMode(state, 'healthyDay', new Date(`2026-11-${d}T09:00:00Z`), `2026-11-${d}`);
    expect(state.unlocks.grove?.by).toBe('grove.bloom');
  });

  it("counts Abyss's restores of any kind", () => {
    const progress = new ModeProgress(memory());
    countAction(progress, 'db.restore', { domain: 'local.spellbook.example' });
    countAction(progress, 'trash.restore', {});
    countAction(progress, 'file.restore', {});
    expect(progress.developerView().modes.find((m) => m.id === 'abyss')?.unlocked?.by).toBe('abyss.salvage');
  });

  it('tells a newer version from an older or the same one', () => {
    expect(newerVersion('1.51.0', '1.50.9')).toBe(true);
    expect(newerVersion('v2.0.0', '1.99.99')).toBe(true);
    expect(newerVersion('1.50.0', '1.50.0')).toBe(false);
    expect(newerVersion('1.49.1', '1.50.0')).toBe(false);
  });

  it('reads a broken saved state as a fresh one', () => {
    expect(readModesState('{nope').counters).toEqual({});
    expect(readModesState('null').unlocks).toEqual({});
  });
});

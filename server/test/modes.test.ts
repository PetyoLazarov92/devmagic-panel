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

  it("counts Neon's late nights once a night, only before 4 in the morning, its logins and its copies from a server", () => {
    let now = new Date(2026, 10, 15, 1, 30);
    const progress = new ModeProgress(memory(), () => now);
    const count = (id: string) => progress.developerView().counters.find((c) => c.id === id)?.count ?? 0;
    progress.noteUse();
    progress.noteUse();
    now = new Date(2026, 10, 15, 3, 59);
    progress.noteUse();
    now = new Date(2026, 10, 15, 4, 0);
    progress.noteUse();
    now = new Date(2026, 10, 15, 23, 59);
    progress.noteUse();
    expect(count('lateNight')).toBe(1);
    for (let d = 16; d <= 19; d++) {
      now = new Date(2026, 10, d, 0, 5);
      progress.noteUse();
    }
    expect(progress.developerView().modes.find((m) => m.id === 'neon')?.unlocked?.by).toBe('neon.nights');
    countAction(progress, 'site.login', { domain: 'local.spellbook.example' });
    expect(count('wpLogin')).toBe(1);
    progress.count('serverCopy');
    expect(count('serverCopy')).toBe(1);
  });

  it("counts Ink's file saves, certificate reissues and database cleanups", () => {
    const progress = new ModeProgress(memory());
    const count = (id: string) => progress.developerView().counters.find((c) => c.id === id)?.count ?? 0;
    countAction(progress, 'file.write', {});
    countAction(progress, 'cert.reissue', { domain: 'local.spellbook.example' });
    countAction(progress, 'db.cleanTransients', {});
    countAction(progress, 'db.cleanContent', {});
    countAction(progress, 'db.cleanOrphans', {});
    countAction(progress, 'db.cleanCopy', {});
    expect([count('fileSave'), count('certReissue'), count('dbClean')]).toEqual([1, 1, 3]);
    for (let i = 0; i < 9; i++) countAction(progress, 'cert.reissue', {});
    expect(progress.developerView().modes.find((m) => m.id === 'ink')?.unlocked?.by).toBe('ink.seals');
  });

  it("counts Dune's days once a day each, its snapshots and its cron tasks", () => {
    let now = new Date(2026, 10, 20, 9, 0);
    const progress = new ModeProgress(memory(), () => now);
    const count = (id: string) => progress.developerView().counters.find((c) => c.id === id)?.count ?? 0;
    progress.noteUse();
    now = new Date(2026, 10, 20, 18, 0);
    progress.noteUse();
    expect(count('usedDay')).toBe(1);
    expect(count('lateNight')).toBe(0);
    now = new Date(2026, 10, 21, 2, 0);
    progress.noteUse();
    expect([count('usedDay'), count('lateNight')]).toEqual([2, 1]);
    countAction(progress, 'db.snapshot', { domain: 'local.spellbook.example' });
    countAction(progress, 'cron.add', {});
    expect([count('dbSnapshot'), count('cronTask')]).toEqual([1, 1]);
    for (let i = 0; i < 4; i++) countAction(progress, 'cron.add', {});
    expect(progress.developerView().modes.find((m) => m.id === 'dune')?.unlocked?.by).toBe('dune.sundial');
  });

  it("counts Pixel's worlds from the modes earned before, once per mode, never Developer options' unlocks", () => {
    const state = emptyModesState();
    state.unlocks.wizard = { at: '2026-11-01T00:00:00Z', by: 'wizard.undo', seen: true };
    state.unlocks.circuit = { at: '2026-11-02T00:00:00Z', by: 'word', seen: true };
    state.unlocks.forge = { at: '2026-11-03T00:00:00Z', by: 'developer', seen: true };
    const worlds = MODE_PATHS.find((p) => p.id === 'pixel.worlds')!;
    countMode(state, 'undo');
    expect(pathProgress(state, worlds)).toBe(2);
    // Sealed and spoken again, the same mode is not a second world.
    modesDeveloper.seal(state, 'circuit');
    speakWord(state, 'overclock');
    expect(pathProgress(state, worlds)).toBe(2);
    // Forge is open from Developer options already: its word earns nothing.
    speakWord(state, 'ignite');
    speakWord(state, 'bloom');
    speakWord(state, 'dive');
    expect(pathProgress(state, worlds)).toBe(4);
    expect(state.unlocks.pixel).toBeUndefined();
    // The fifth world opens Pixel at once, after the mode that earned it.
    speakWord(state, 'afterglow');
    expect(state.unlocks.pixel?.by).toBe('pixel.worlds');
  });

  it("counts Pixel's continues and its plugins and themes installed", () => {
    const progress = new ModeProgress(memory());
    const count = (id: string) => progress.developerView().counters.find((c) => c.id === id)?.count ?? 0;
    countAction(progress, 'site.installPlugins', { domain: 'local.spellbook.example', plugins: [{ slug: 'wand-forms' }, { slug: 'spellbook-blocks' }], themes: [{ slug: 'wandworks' }] });
    progress.count('jobContinue');
    expect([count('itemInstall'), count('jobContinue')]).toEqual([3, 1]);
  });

  it("counts Sorbet's cache clears, plugin switches and branch switches", () => {
    const progress = new ModeProgress(memory());
    const count = (id: string) => progress.developerView().counters.find((c) => c.id === id)?.count ?? 0;
    countAction(progress, 'site.clearCache', { domain: 'local.spellbook.example' });
    countAction(progress, 'site.pluginSet', { domain: 'local.spellbook.example', plugin: 'wand-forms', active: false });
    countAction(progress, 'git.switch', {});
    expect([count('cacheClear'), count('pluginToggle'), count('branchSwitch')]).toEqual([1, 1, 1]);
    for (let i = 0; i < 14; i++) countAction(progress, 'git.switch', {});
    expect(progress.developerView().modes.find((m) => m.id === 'sorbet')?.unlocked?.by).toBe('sorbet.flavors');
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

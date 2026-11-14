import { emptyModesState, MODE_PATHS, modesDeveloper, modesView, pathProgress, readModesState } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { countAction, ModeProgress } from '../src/modes.js';

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

  it('reads a broken saved state as a fresh one', () => {
    expect(readModesState('{nope').counters).toEqual({});
    expect(readModesState('null').unlocks).toEqual({});
  });
});

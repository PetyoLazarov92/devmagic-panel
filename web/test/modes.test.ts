import { describe, expect, it } from 'vitest';
import { modeText, pageName } from '../src/lib/mode-names.js';

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

  it('says a line its own way in Wizard, and the plain one in Classic', () => {
    expect(modeText('newSite', 'wizard')).toBe('Conjure a site');
    expect(modeText('newSite', 'classic')).toBe('New site');
    expect(modeText('allGood', 'wizard')).toBe('All wards hold');
  });
});

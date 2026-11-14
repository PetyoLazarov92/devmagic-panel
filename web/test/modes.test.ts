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

  it('says a line its own way in Wizard, and the plain one in Classic', () => {
    expect(modeText('newSite', 'wizard')).toBe('Conjure a site');
    expect(modeText('newSite', 'classic')).toBe('New site');
    expect(modeText('allGood', 'wizard')).toBe('All wards hold');
  });
});

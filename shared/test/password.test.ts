import { describe, expect, it } from 'vitest';
import { PANEL_PASSWORD_MAX, panelPasswordProblem } from '../src/password.js';

describe('panel password rules', () => {
  it('takes any long enough password, with no composition rules', () => {
    expect(panelPasswordProblem('copper kettle rain')).toBeUndefined();
    expect(panelPasswordProblem('abcdefgz')).toBeUndefined();
    expect(panelPasswordProblem('ünïcödé pässwörd')).toBeUndefined();
    expect(panelPasswordProblem('x'.repeat(7) + 'y')).toBeUndefined();
  });

  it('refuses too short, too long, the most common, one character repeated, and the user name with digits', () => {
    expect(panelPasswordProblem('short')).toBe('At least 8 characters');
    expect(panelPasswordProblem('x'.repeat(PANEL_PASSWORD_MAX + 1))).toBe(`At most ${PANEL_PASSWORD_MAX} characters`);
    expect(panelPasswordProblem('Password123')).toMatch(/Too common/);
    expect(panelPasswordProblem('DevMagic-Panel')).toMatch(/Too common/);
    expect(panelPasswordProblem('aaaaaaaaaa')).toMatch(/repeated/);
    expect(panelPasswordProblem('alexm2026!', 'alexm')).toBe('Too close to your user name');
    expect(panelPasswordProblem('alexm likes tea', 'alexm')).toBeUndefined();
  });
});

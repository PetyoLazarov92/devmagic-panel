import type { InstallDraft } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { draftHref, draftProgress, keptUntil, landingStep, stepsFor } from '../src/lib/drafts.js';

const draft = (step: string, state: unknown): InstallDraft => ({
  id: 'd1e2f3a4-0000-4000-8000-000000000001', kind: 'manual', title: 'local.wandworks.example', step, state, uploads: [], status: 'open',
  createdAt: '2026-10-26T08:00:00Z', updatedAt: '2026-10-26T09:00:00Z',
});

describe('a draft in the lists', () => {
  it('says which step of its kind it stopped at', () => {
    expect(draftProgress(draft('domains', { source: 'repo' }))).toEqual({ kind: 'repo', at: 4, total: 6, step: 'domains', label: 'Domains' });
    expect(draftProgress(draft('database', { source: 'repo', org: { name: '', useClaude: false } }))).toMatchObject({ at: 3, total: 6, label: 'Database' });
    // An organization install from before 1.28 had Claude read the repo; its old step names map to today's,
    // and the links' step of before 1.31 is the one Claude step.
    expect(draftProgress(draft('access', { source: 'repo', org: { name: 'wandworks' } }))).toEqual({ kind: 'repo', at: 3, total: 7, step: 'read', label: 'Claude reads the project' });
    expect(stepsFor('repo', true)).toEqual(['start', 'code', 'read', 'database', 'domains', 'wordpress', 'review']);
    expect(draftProgress(draft('org', { source: 'repo', org: { name: 'wandworks' } }))).toMatchObject({ at: 2, step: 'code' });
    expect(draftProgress(draft('source', { source: 'repo' }))).toMatchObject({ at: 2, step: 'code' });
    expect(draftProgress(draft('wordpress', { source: 'wordpress' }))).toMatchObject({ kind: 'wordpress', at: 3, total: 4 });
  });

  it('starts over at the first step when its step or kind is not one the wizard knows', () => {
    expect(draftProgress(draft('source', { source: 'empty' }))).toMatchObject({ kind: 'empty', at: 1, step: 'start' });
    expect(draftProgress(draft('domains', { source: 'ftp' }))).toMatchObject({ kind: 'repo', at: 4 });
    expect(draftProgress(draft('domains', null))).toMatchObject({ kind: 'repo', at: 4 });
  });
});

describe('a draft address', () => {
  it('names the draft, and the step when there is one', () => {
    expect(draftHref('d1e2f3a4-0000-4000-8000-000000000001', 'domains')).toBe('/sites/new/d1e2f3a4-0000-4000-8000-000000000001/domains');
    expect(draftHref('d1e2f3a4-0000-4000-8000-000000000001')).toBe('/sites/new/d1e2f3a4-0000-4000-8000-000000000001');
  });

  it('opens the step it names when the draft got that far', () => {
    const flow = stepsFor('repo');
    expect(landingStep(flow, 'domains', { start: 'a', code: 'b', database: 'c' })).toBe('domains');
    expect(landingStep(flow, 'code', { start: 'a', code: 'b', database: 'c' })).toBe('code');
  });

  it('opens the furthest step it can for a step ahead of the draft, of another kind, or none', () => {
    const flow = stepsFor('repo');
    const passed = { start: 'a', code: 'b', database: 'c' };
    expect(landingStep(flow, 'review', passed)).toBe('domains');
    expect(landingStep(flow, 'org', passed)).toBe('domains');
    expect(landingStep(flow, 'nonsense', passed)).toBe('domains');
    expect(landingStep(flow, undefined, {})).toBe('start');
  });
});

describe('when a draft goes', () => {
  const now = new Date(2026, 9, 26, 9, 0);
  it('shows the time today, tomorrow for the next day, else the date', () => {
    expect(keptUntil(new Date(2026, 9, 26, 18, 40).toISOString(), now)).toBe('18:40');
    expect(keptUntil(new Date(2026, 9, 27, 9, 5).toISOString(), now)).toBe('tomorrow 09:05');
    expect(keptUntil(new Date(2026, 9, 28, 0, 0).toISOString(), now)).toBe('Oct 28 00:00');
  });
});

describe('drafts from before 1.28', () => {
  it('read the old layout as where the repo goes', async () => {
    const { migrateDraftState } = await import('../src/lib/drafts.js');
    expect(migrateDraftState({ repoUrl: 'git@github.com:wandworks/wandworks.git', layout: 'theme', branch: 'main' })).toEqual({ repoUrl: 'git@github.com:wandworks/wandworks.git', branch: 'main', placement: { dir: 'wp-content/themes', folder: 'wandworks' } });
    expect(migrateDraftState({ layout: 'site-root' })).toEqual({ placement: { dir: '', folder: '' } });
    // A placement already there wins; something odd is dropped.
    expect(migrateDraftState({ layout: 'plugin', placement: { dir: 'app', folder: '' } })).toEqual({ placement: { dir: 'app', folder: '' } });
    expect(migrateDraftState({ layout: 'nonsense' })).toEqual({});
    expect(migrateDraftState(null)).toEqual({});
    // An organization draft keeps Claude on; the old steps it passed count for the Code step.
    expect(migrateDraftState({ org: { name: 'wandworks' }, passed: { start: 'a', org: 'b' } })).toEqual({ org: { name: 'wandworks', useClaude: true }, passed: { start: 'a', code: 'b' } });
  });
});

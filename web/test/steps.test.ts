import { describe, expect, it } from 'vitest';
import { answersHash, canOpen, stepViews } from '../src/lib/steps.js';

type S = 'start' | 'source' | 'domains' | 'wordpress' | 'review';
const flow: S[] = ['start', 'source', 'domains', 'wordpress', 'review'];

/** The wizard as answers per step; passed is what each step had when you continued. */
function wizard(answers: Record<S, unknown>, passed: Partial<Record<S, unknown>>, blocked: S[] = []) {
  const hashes = Object.fromEntries(Object.entries(passed).map(([k, v]) => [k, answersHash(v)])) as Partial<Record<S, string>>;
  return (current: S) => stepViews(flow, current, hashes, (s) => answersHash(answers[s]), (s) => !blocked.includes(s));
}
const opened = (views: ReturnType<ReturnType<typeof wizard>>) => flow.filter((s) => views[s].open);
const answers = { start: 'repo', source: ['git@github.com:wandworks/site.git', 'main'], domains: ['local.wandworks.example'], wordpress: ['admin'], review: null };

describe('the step list', () => {
  it('opens only the steps up to the current one on a new install', () => {
    const views = wizard(answers, { start: 'repo' })('source');
    expect(opened(views)).toEqual(['start', 'source']);
    expect(views.start.done).toBe(true);
    expect(views.source.done).toBe(false);
  });

  it('opens the steps you reached again when you go back and change nothing', () => {
    const views = wizard(answers, { start: 'repo', source: answers.source, domains: answers.domains })('source');
    expect(opened(views)).toEqual(['start', 'source', 'domains', 'wordpress']);
    expect(views.domains.done).toBe(true);
    expect(views.wordpress.done).toBe(false);
    expect(views.review.open).toBe(false);
  });

  it('closes the steps after a changed answer, and opens them again when it is put back', () => {
    const passed = { start: 'repo', source: answers.source, domains: answers.domains, wordpress: answers.wordpress };
    const changed = wizard({ ...answers, source: ['git@github.com:wandworks/shop.git', 'main'] }, passed)('source');
    expect(opened(changed)).toEqual(['start', 'source']);
    expect(changed.domains).toEqual({ open: false, done: false, stale: true });
    expect(changed.review.stale).toBe(false);
    expect(opened(wizard(answers, passed)('source'))).toEqual(flow);
  });

  it('after continuing with a change, opens only up to the first step whose own answers changed too', () => {
    const passed = { start: 'repo', source: ['git@github.com:wandworks/shop.git', 'main'], domains: answers.domains, wordpress: answers.wordpress };
    // The new repo left the domains as they were: everything opens again.
    expect(opened(wizard({ ...answers, source: passed.source }, passed)('domains'))).toEqual(flow);
    // It rewrote the domains: WordPress and Review wait for Continue on Domains.
    expect(opened(wizard({ ...answers, source: passed.source, domains: ['local.shop.com'] }, passed)('domains'))).toEqual(['start', 'source', 'domains']);
  });

  it('keeps a step closed while one before it cannot go on, and keeps the earlier steps open', () => {
    const passed = { start: 'repo', source: answers.source, domains: answers.domains, wordpress: answers.wordpress };
    expect(opened(wizard(answers, passed, ['domains'])('source'))).toEqual(['start', 'source', 'domains']);
    expect(opened(wizard(answers, {}, [])('wordpress'))).toEqual(['start', 'source', 'domains', 'wordpress']);
  });

  it('hashes answers the same way every time, and different answers differently', () => {
    expect(answersHash({ a: [1, 'x'] })).toBe(answersHash({ a: [1, 'x'] }));
    expect(answersHash(['local.wandworks.example'])).not.toBe(answersHash(['local.shop.com']));
    expect(answersHash(undefined)).toBe(answersHash(undefined));
  });
});

describe('an address that names a step', () => {
  it('opens the first step, and any step right after one you continued from', () => {
    const passed = { start: 'a', source: 'b' };
    expect(canOpen(flow, 'start', {})).toBe(true);
    expect(canOpen(flow, 'source', {})).toBe(false);
    expect(canOpen(flow, 'domains', passed)).toBe(true);
    expect(canOpen(flow, 'wordpress', passed)).toBe(false);
    expect(canOpen(flow, 'review', passed)).toBe(false);
  });

  it('opens no step the flow has not', () => {
    expect(canOpen(flow, 'org' as S, { start: 'a' })).toBe(false);
  });
});

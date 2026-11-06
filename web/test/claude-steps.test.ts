import type { JobView, OrgStatus } from '@devmagic-panel/shared';
import { DEFAULT_ORG_SETTINGS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { orgCardState, resumeStep, runSource, skipAccess, tokenCount, unskipAccess, usageText } from '../src/lib/claude-steps.js';

const job = (status: JobView['status'], id = 'j1', output?: string): JobView => ({
  id, title: 'Read acme/site with Claude Code', status, steps: [{ id: 'read', label: 'Claude Code reads the docs of acme/site', status: status === 'failed' ? 'failed' : 'done', ...(output ? { output } : {}) }],
  undo: [], undoable: [], progress: 0, startedAt: '2026-10-26T10:00:00Z', runId: 1,
});

describe('a Claude Code step coming back', () => {
  const key = 'acme/site@main';
  it('uses the answer kept for the same repo and branch, and never one for another', () => {
    expect(resumeStep(key, { key }, undefined, null)).toEqual({ use: 'answer' });
    expect(resumeStep(key, { key: 'acme/site@develop' }, undefined, null)).toEqual({ use: 'start' });
  });

  it('follows its job while it runs, and says why it failed', () => {
    expect(resumeStep(key, undefined, { id: 'j1', key }, job('running'))).toEqual({ use: 'follow', jobId: 'j1' });
    expect(resumeStep(key, undefined, { id: 'j1', key }, job('queued'))).toEqual({ use: 'follow', jobId: 'j1' });
    expect(resumeStep(key, undefined, { id: 'j1', key }, job('failed', 'j1', 'cloning\nClaude Code stopped at the spending cap of $0.5'))).toEqual({
      use: 'failed', jobId: 'j1', reason: 'Claude Code stopped at the spending cap of $0.5',
    });
  });

  it('starts again for another repo, a job the panel lost, or one that ended without an answer', () => {
    expect(resumeStep(key, undefined, { id: 'j1', key: 'acme/shop@main' }, job('running'))).toEqual({ use: 'start' });
    expect(resumeStep(key, undefined, { id: 'j1', key }, null)).toEqual({ use: 'start' });
    expect(resumeStep(key, undefined, { id: 'j1', key }, job('done'))).toEqual({ use: 'start' });
  });
});

describe('the organization card', () => {
  const status = (claude: OrgStatus['claude']): OrgStatus => ({ claude, gh: { installed: true, signedIn: true }, glab: { installed: false, hosts: [] }, rclone: { installed: false }, settings: DEFAULT_ORG_SETTINGS });
  it('opens with a claude.ai sign-in, notes another sign-in, and says what is missing otherwise', () => {
    expect(orgCardState({ status: null, checking: true })).toBe('checking');
    expect(orgCardState({ status: null, checking: false })).toBe('error');
    expect(orgCardState({ status: status({ found: false, signedIn: false, claudeAi: false }), checking: false })).toBe('missing');
    expect(orgCardState({ status: status({ found: true, signedIn: false, claudeAi: false }), checking: false })).toBe('signed-out');
    expect(orgCardState({ status: status({ found: true, signedIn: true, claudeAi: false }), checking: false })).toBe('api');
    expect(orgCardState({ status: status({ found: true, signedIn: true, claudeAi: true }), checking: false })).toBe('ready');
  });
});

describe('skipping the access check', () => {
  const done = { status: 'done' as const, costUsd: 0.12 };
  it('keeps a finished answer and its cost, and skips anything else', () => {
    expect(skipAccess(done)).toBe(done);
    for (const status of ['idle', 'checking', 'error'] as const) expect(skipAccess({ status })).toEqual({ status: 'skipped' });
  });

  it('looks again when you ask for the check after a skip, and changes nothing else', () => {
    expect(unskipAccess({ status: 'skipped' })).toEqual({ status: 'idle' });
    expect(unskipAccess(done)).toBe(done);
    expect(unskipAccess({ status: 'checking' })).toEqual({ status: 'checking' });
  });
});

describe("the Claude Code card's values", () => {
  const defaults = { model: 'sonnet' as const, effort: 'medium' as const, budgetUsd: 0.5 };
  it('are your defaults until this install changes one, and again when it changes them back', () => {
    expect(runSource(undefined, defaults)).toBe('defaults');
    expect(runSource({ ...defaults }, defaults)).toBe('defaults');
    expect(runSource({ ...defaults, effort: 'high' }, defaults)).toBe('install');
    expect(runSource({ ...defaults, budgetUsd: 1 }, defaults)).toBe('install');
  });
});

describe('what a Claude Code run took', () => {
  it('reads as time, tokens and the estimate, and older answers as the estimate alone', () => {
    expect(usageText({ costUsd: 0.31, durationMs: 72_400, tokens: { input: 1200, output: 800, cacheRead: 40_000, cacheWrite: 6200 } })).toBe('1 min 12 s · 48k tokens · $0.31');
    expect(usageText({ costUsd: 0.12 })).toBe('$0.12');
  });

  it('counts tokens at a glance', () => {
    expect([tokenCount(950), tokenCount(4210), tokenCount(48_210), tokenCount(1_350_000), tokenCount(2_000_000)]).toEqual(['950', '4.2k', '48k', '1.4M', '2M']);
  });
});

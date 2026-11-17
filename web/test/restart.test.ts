import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notePanelVersion, waitForRestart } from '../src/lib/restart.js';
import { expectRestart, isSessionLost, noteStatus } from '../src/lib/session-watch.js';

/** A /healthz that gives these answers in turn, then the last one forever. */
const answers = (...list: Array<string | null>) => {
  let i = 0;
  return vi.fn(async () => list[Math.min(i++, list.length - 1)] ?? null);
};

describe('waiting for the panel to restart', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends when the panel answers again after it did not', async () => {
    const done = vi.fn();
    waitForRestart(answers('1.0.0', '1.0.0', null, null, '1.0.0'), done, { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(4000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('ends when it answers with a new version, even without seeing it down', async () => {
    const done = vi.fn();
    waitForRestart(answers('1.0.0', '1.1.0'), done, { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('ends at the first answer when the new panel answers before this page sees it down', async () => {
    const done = vi.fn();
    waitForRestart(answers('1.1.0'), done, { from: '1.0.0', now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('compares with the version the page loaded from, and still waits for a reinstall of it to come back', async () => {
    notePanelVersion('1.0.0');
    const moved = vi.fn();
    waitForRestart(answers('1.1.0'), moved, { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(moved).toHaveBeenCalledTimes(1);
    const same = vi.fn();
    waitForRestart(answers('1.0.0', null, '1.0.0'), same, { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(same).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(same).toHaveBeenCalledTimes(1);
  });

  it('ends after the longest wait whatever it says, and not once stopped', async () => {
    const done = vi.fn();
    waitForRestart(answers('1.0.0'), done, { maxMs: 10_000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(done).toHaveBeenCalledTimes(1);
    const never = vi.fn();
    const stop = waitForRestart(answers('1.0.0', '1.1.0'), never, { now: () => Date.now() });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('a restart the page expects', () => {
  it('opens no login dialog on a 401 meanwhile', () => {
    expectRestart();
    noteStatus('/api/sites', 401);
    expect(isSessionLost()).toBe(false);
  });
});

describe('a page left open during an update', () => {
  it('loads again, once, when the panel answers with a new version, and never for the same one or no answer', async () => {
    const { isNewPanel, notePanelVersion, reloadIfNewPanel } = await import('../src/lib/restart.js');
    notePanelVersion('1.69.0');
    expect(isNewPanel('1.69.0')).toBe(false);
    expect(isNewPanel(null)).toBe(false);
    expect(isNewPanel('1.70.0')).toBe(true);
    let reloads = 0;
    expect(reloadIfNewPanel('1.69.0', () => reloads++)).toBe(false);
    expect(reloadIfNewPanel('1.70.0', () => reloads++)).toBe(true);
    expect(reloadIfNewPanel('1.70.0', () => reloads++)).toBe(false);
    expect(reloads).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELAY_MS, panelNotAnswering, startPanel, startupDelay } from '../src/lib/startup.js';

/** An error like the API client's, with the answer's status and body. */
const answer = (status: number, data: Record<string, unknown> = {}) => Object.assign(new Error(`Request failed (${status})`), { status, data });

/** A load that fails with these in turn, then answers with value. */
const loadAfter = <T>(failures: unknown[], value: T) => {
  let i = 0;
  return vi.fn(async () => {
    if (i < failures.length) throw failures[i++];
    return value;
  });
};

describe('telling that the panel does not answer yet', () => {
  it('counts a failed fetch and the gateway errors Apache gives for a panel that is down', () => {
    expect(panelNotAnswering(new TypeError('Failed to fetch'))).toBe(true);
    for (const status of [502, 503, 504]) expect(panelNotAnswering(answer(status, { error: 'x' }))).toBe(true);
    // A proxy's own error page, without the panel's JSON (the dev server's proxy answers 500).
    expect(panelNotAnswering(answer(500))).toBe(true);
  });

  it('leaves the panel own answers alone', () => {
    expect(panelNotAnswering(answer(500, { error: 'Internal Server Error' }))).toBe(false);
    expect(panelNotAnswering(answer(401, {}))).toBe(false);
    expect(panelNotAnswering(answer(429, {}))).toBe(false);
    expect(panelNotAnswering(new Error('Something else'))).toBe(false);
    expect(panelNotAnswering(null)).toBe(false);
  });

  it('waits longer each time, up to the longest wait', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(startupDelay)).toEqual([1000, 2000, 4000, 8000, MAX_DELAY_MS, MAX_DELAY_MS, MAX_DELAY_MS]);
  });
});

describe('starting the page while the panel starts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers at once when the panel is up', async () => {
    const ready = vi.fn();
    const waiting = vi.fn();
    startPanel(loadAfter([], 'session'), { ready, waiting, failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledWith('session');
    expect(waiting).not.toHaveBeenCalled();
  });

  it('keeps trying with growing waits until the panel answers', async () => {
    const ready = vi.fn();
    const waiting = vi.fn();
    const load = loadAfter([new TypeError('Failed to fetch'), answer(503), answer(503)], 'session');
    startPanel(load, { ready, waiting, failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(waiting).toHaveBeenLastCalledWith(2);
    // The next try is 2 seconds later, not 1.
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(waiting).toHaveBeenLastCalledWith(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ready).toHaveBeenCalledWith('session');
    expect(load).toHaveBeenCalledTimes(4);
    // Nothing more once it answered.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('tries again at once when asked, without a second try running alongside', async () => {
    const ready = vi.fn();
    const load = loadAfter([answer(503)], 'session');
    const start = startPanel(load, { ready, waiting: vi.fn(), failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    start.retryNow();
    start.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    // The try that was waiting does not run as well.
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops on any other error, and does nothing once stopped', async () => {
    const failed = vi.fn();
    startPanel(loadAfter([answer(500, { error: 'Internal Server Error' })], 'session'), { ready: vi.fn(), waiting: vi.fn(), failed });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Request failed (500)' }));

    const ready = vi.fn();
    const load = loadAfter([answer(503)], 'session');
    const start = startPanel(load, { ready, waiting: vi.fn(), failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    start.stop();
    start.retryNow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });
});

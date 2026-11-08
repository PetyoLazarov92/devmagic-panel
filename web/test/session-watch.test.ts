import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_CHECK_MS, isSessionLost, isTabMessage, noteStatus, onSessionChange, refused, sessionBack, SessionWatch, TICK_MS, WAKE_GAP_MS } from '../src/lib/session-watch.js';

describe('a session ending on an open page', () => {
  beforeEach(() => sessionBack());

  it('ends with the first 401 and tells the page once', () => {
    const seen = vi.fn();
    const stop = onSessionChange(seen);
    noteStatus('/api/sites', 200);
    expect(isSessionLost()).toBe(false);
    noteStatus('/api/sites', 401);
    noteStatus('/api/jobs?active=1', 401);
    expect(isSessionLost()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never ends for the session check or logging in and out, nor for a 403', () => {
    noteStatus('/api/session', 401);
    noteStatus('/api/login', 401);
    noteStatus('/api/logout', 401);
    noteStatus('/api/sites', 403);
    expect(isSessionLost()).toBe(false);
  });

  it('stops requests while it is over, except the session check and logging in and out', () => {
    expect(refused('/api/sites')).toBe(false);
    noteStatus('/api/sites', 401);
    expect(refused('/api/sites')).toBe(true);
    expect(refused('/api/uploads?name=wandworks.sql')).toBe(true);
    expect(refused('/api/session')).toBe(false);
    expect(refused('/api/login')).toBe(false);
    expect(refused('/api/logout')).toBe(false);
    sessionBack();
    expect(refused('/api/sites')).toBe(false);
  });
});

describe('when the session is checked', () => {
  const start = 1_000_000;
  const watch = () => {
    const check = vi.fn(async () => undefined);
    return { check, w: new SessionWatch(check, start) };
  };

  it('checks once when a tab hidden for a minute or more is shown, never after a quick switch', () => {
    const { check, w } = watch();
    w.hidden(start);
    w.shown(start + HIDDEN_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    w.hidden(start + 10_000);
    w.shown(start + 10_000 + HIDDEN_CHECK_MS);
    expect(check).toHaveBeenCalledTimes(1);
    // Shown again without being hidden: nothing.
    w.shown(start + 10 * HIDDEN_CHECK_MS);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks once after the computer slept with the tab in front, and not for ticks on time or on a hidden tab', () => {
    const { check, w } = watch();
    w.tick(start + TICK_MS, true);
    w.tick(start + 2 * TICK_MS, true);
    expect(check).not.toHaveBeenCalled();
    w.tick(start + 2 * TICK_MS + WAKE_GAP_MS, false);
    expect(check).not.toHaveBeenCalled();
    w.tick(start + 2 * TICK_MS + 2 * WAKE_GAP_MS, true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks when the network comes back, one check at a time, and again after one that failed', async () => {
    let finish: () => void = () => undefined;
    const check = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const w = new SessionWatch(check, start);
    w.online();
    w.online();
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    w.online();
    expect(check).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => {
      throw new Error('Cannot reach the panel');
    });
    const f = new SessionWatch(failing, start);
    f.online();
    await new Promise((r) => setTimeout(r, 0));
    f.online();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

it('takes only its own messages from other tabs', () => {
  expect(isTabMessage('logged-out')).toBe(true);
  expect(isTabMessage('logged-in')).toBe(true);
  expect(isTabMessage('reload')).toBe(false);
  expect(isTabMessage({ type: 'logged-out' })).toBe(false);
});

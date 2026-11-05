/**
 * Noticing that the panel's session ended while a page is open: after a
 * restart, the idle limit, or a log out in another tab. A 401 on any request
 * ends it here; a single session check runs when the tab comes back after a
 * while or the computer wakes. Nothing asks the server on a timer.
 */

/** A tab hidden at least this long checks the session when it is shown again. */
export const HIDDEN_CHECK_MS = 60_000;
/** How often the page looks at the clock, without asking the server. */
export const TICK_MS = 30_000;
/** A tick this late means the computer slept. */
export const WAKE_GAP_MS = 2 * 60_000;

/** Requests that work without a session: the session check, logging in and out. */
const OPEN = new Set(['/api/session', '/api/login', '/api/logout', '/api/password/reset']);
const pathOf = (url: string) => url.split('?')[0] as string;

let lost = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Calls fn whenever the session ends or comes back here; returns the unsubscribe. */
export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isSessionLost = () => lost;

let restarting = false;

/**
 * The panel is about to restart (an update) and the page will load again on
 * its own: a 401 meanwhile opens no login dialog, as the page that loads
 * shows the login page if it is still needed.
 */
export function expectRestart(): void {
  restarting = true;
}

/** The session ended: the login dialog opens and requests stop going out. */
export function sessionLost(): void {
  if (lost || restarting) return;
  lost = true;
  changed();
}

/** Logged in again without a reload (the login page). */
export function sessionBack(): void {
  if (!lost) return;
  lost = false;
  changed();
}

/** True for a request that should not go out: the session ended, so it would only get a 401. */
export const refused = (url: string) => lost && !OPEN.has(pathOf(url));

/** Notes a response: a 401 on anything but the open requests means the session ended. */
export function noteStatus(url: string, status: number): void {
  if (status === 401 && !OPEN.has(pathOf(url))) sessionLost();
}

/**
 * When to check the session: once when a tab hidden HIDDEN_CHECK_MS or more is
 * shown, once when a tick comes WAKE_GAP_MS late on a shown tab (the computer
 * slept), once when the network comes back. One check at a time.
 */
export class SessionWatch {
  private hiddenAt: number | null = null;
  private lastTick: number;
  private checking = false;

  constructor(
    private readonly check: () => Promise<void>,
    now: number,
  ) {
    this.lastTick = now;
  }

  hidden(now: number): void {
    this.hiddenAt = now;
  }

  shown(now: number): void {
    const long = this.hiddenAt !== null && now - this.hiddenAt >= HIDDEN_CHECK_MS;
    this.hiddenAt = null;
    this.lastTick = now;
    if (long) this.run();
  }

  /** A hidden tab's timers are slowed by the browser, so only a shown tab counts a late tick. */
  tick(now: number, visible: boolean): void {
    const late = now - this.lastTick >= WAKE_GAP_MS;
    this.lastTick = now;
    if (late && visible) this.run();
  }

  online(): void {
    this.run();
  }

  private run(): void {
    if (this.checking) return;
    this.checking = true;
    void this.check()
      .catch(() => undefined)
      .finally(() => {
        this.checking = false;
      });
  }
}

/** Starts the watch on this page's events; returns the stop. */
export function startSessionWatch(check: () => Promise<void>): () => void {
  const watch = new SessionWatch(check, Date.now());
  const onVisibility = () => (document.visibilityState === 'hidden' ? watch.hidden(Date.now()) : watch.shown(Date.now()));
  const onOnline = () => watch.online();
  // A page the browser brings back from its cache counts as one hidden for long.
  const onPageShow = (e: PageTransitionEvent) => e.persisted && watch.online();
  const timer = window.setInterval(() => watch.tick(Date.now(), document.visibilityState === 'visible'), TICK_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onPageShow);
  };
}

/** What one tab tells the panel's other tabs. */
export type TabMessage = 'logged-out' | 'logged-in';
export const isTabMessage = (v: unknown): v is TabMessage => v === 'logged-out' || v === 'logged-in';

let channel: BroadcastChannel | null | undefined;
/** One channel per page: a message never comes back to the tab that sent it. */
const tabs = () => {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('devmagic-panel-session');
  return channel;
};

export function tellOtherTabs(message: TabMessage): void {
  tabs()?.postMessage(message);
}

/** Calls fn with each message from the panel's other tabs; returns the stop. */
export function listenToOtherTabs(fn: (message: TabMessage) => void): () => void {
  const ch = tabs();
  if (!ch) return () => undefined;
  const onMessage = (e: MessageEvent) => isTabMessage(e.data) && fn(e.data);
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
}

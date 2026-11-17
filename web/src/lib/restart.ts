/** The version of the panel this page loaded from, once its session answered. */
let pageVersion: string | undefined;
export function notePanelVersion(version: string): void {
  pageVersion = version;
}

/** True when the panel answers with another version than this page loaded from: it was updated, and this page is the old one. */
export const isNewPanel = (version: string | null | undefined): boolean => Boolean(version && pageVersion && version !== pageVersion);

let reloading = false;
/**
 * After an update, on whatever page you are: the panel answers with a new
 * version, so this page loads again, once, to run the new one (its old code
 * would talk to the new panel). True when it reloads.
 */
export function reloadIfNewPanel(version: string | null | undefined, reload: () => void = () => window.location.reload()): boolean {
  if (reloading || !isNewPanel(version)) return false;
  reloading = true;
  reload();
  return true;
}

/** How a wait for the restart ended: a new version answers, the panel answers again after it did not, or the longest wait passed. */
export type RestartEnd = 'new' | 'back' | 'timeout';

/**
 * Waiting for the panel to come back after an update restarts it: done runs
 * once /healthz answers with a version other than the one this page loaded
 * from (`from`), or answers again after it did not, or after maxMs whatever it
 * says. Without `from`, the first answer stands in for it. Returns the stop.
 */
export function waitForRestart(
  health: () => Promise<string | null>,
  done: (end: RestartEnd) => void,
  { everyMs = 1000, maxMs = 60_000, now = Date.now, from = pageVersion }: { everyMs?: number; maxMs?: number; now?: () => number; from?: string | undefined } = {},
): () => void {
  const started = now();
  // The version before the restart: the page's own, else the first answer
  // (null when the panel did not answer). The new panel can answer first, so
  // the page's version is the one to trust.
  let first: string | null | undefined = from;
  let wentDown = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (end: RestartEnd) => {
    if (stopped) return;
    stopped = true;
    done(end);
  };
  const poll = async () => {
    const version = await health();
    if (stopped) return;
    if (first === undefined) first = version;
    else if (version === null) wentDown = true;
    else if (wentDown || version !== first) return finish(first && version !== first ? 'new' : 'back');
    if (now() - started >= maxMs) return finish('timeout');
    timer = setTimeout(() => void poll(), everyMs);
  };
  timer = setTimeout(() => void poll(), everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

let following: { pages: Set<string>; stop: () => void } | null = null;

/**
 * An update or switch you started: the panel restarts on the new release
 * while you may be on any page by then, so the wait does not end when you
 * leave the page that started it. Once the panel answers with another version
 * (or again after it went down), the pages that show the update's progress
 * (`pages`: the Updates page, its job) go to the Updates page to show how it
 * ended, and any other page loads again, to run the new panel. After maxMs
 * with neither, those pages go to the Updates page too and others stay as
 * they are. One wait at a time: another call adds its pages and starts the
 * wait again, with a new longest wait.
 */
export function followRestart(
  health: () => Promise<string | null>,
  pages: readonly string[],
  {
    path = () => window.location.pathname,
    go = (url: string) => window.location.assign(url),
    reload = () => window.location.reload(),
    maxMs = 10 * 60_000,
    ...wait
  }: { path?: () => string; go?: (url: string) => void; reload?: () => void; maxMs?: number; everyMs?: number; now?: () => number; from?: string } = {},
): void {
  const merged = new Set([...(following?.pages ?? []), ...pages]);
  following?.stop();
  const mine = { pages: merged, stop: () => undefined as void };
  following = mine;
  mine.stop = waitForRestart(
    health,
    (end) => {
      if (following === mine) following = null;
      if (mine.pages.has(path())) go('/update');
      else if (end !== 'timeout') reload();
    },
    { maxMs, ...wait },
  );
}

/** The update failed before the restart: nothing restarts, so nothing waits for it. */
export function stopFollowingRestart(): void {
  following?.stop();
  following = null;
}

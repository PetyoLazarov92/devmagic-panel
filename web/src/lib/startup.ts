/**
 * Opening the page while the panel may not answer yet. After a reboot the
 * browser restores its tabs as soon as you log in, before the panel's user
 * service has started: the page comes from the browser's cache, and its first
 * request finds no panel (the fetch fails, or Apache answers 502 or 503 for
 * it). The page then keeps asking, sooner at first, and at once when the tab
 * is shown again or the network comes back.
 */

/** The longest wait between two tries. */
export const MAX_DELAY_MS = 10_000;

/** The wait before try number attempt + 1: 1, 2, 4 and 8 seconds, then 10. */
export const startupDelay = (attempt: number) => Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);

/** After this many tries the page says where to look. */
export const HINT_AFTER = 6;

/**
 * True when the panel itself did not answer: the request failed (nothing on
 * the other end), Apache had no panel to pass it to (502, 503, 504), or an
 * answer came without the panel's JSON (a proxy's own error page).
 */
export function panelNotAnswering(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const { status, data } = error as { status: unknown; data?: Record<string, unknown> };
  if (typeof status !== 'number') return false;
  if (status === 502 || status === 503 || status === 504) return true;
  return status >= 500 && !(data && 'error' in data);
}

export interface PanelStartEvents<T> {
  ready: (value: T) => void;
  /** The panel did not answer; attempt counts the tries so far. */
  waiting: (attempt: number) => void;
  /** Any other failure ends it. */
  failed: (error: Error) => void;
}

export interface PanelStart {
  /** Tries again now instead of at the next try, unless a try is under way. */
  retryNow: () => void;
  stop: () => void;
}

/** Runs load until the panel answers. */
export function startPanel<T>(load: () => Promise<T>, on: PanelStartEvents<T>, delay: (attempt: number) => number = startupDelay): PanelStart {
  let attempt = 0;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    if (stopped || busy) return;
    clearTimeout(timer);
    timer = undefined;
    busy = true;
    try {
      const value = await load();
      if (!stopped) {
        stopped = true;
        on.ready(value);
      }
    } catch (error) {
      if (stopped) return;
      if (!panelNotAnswering(error)) {
        stopped = true;
        on.failed(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      attempt += 1;
      on.waiting(attempt);
      timer = setTimeout(() => void run(), delay(attempt));
    } finally {
      busy = false;
    }
  };

  void run();
  return {
    retryNow: () => void run(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** Tries again at once when the tab is shown, the network comes back or the page returns from the cache; returns the stop. */
export function retryOnWake(retry: () => void): () => void {
  const onVisibility = () => document.visibilityState === 'visible' && retry();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', retry);
  window.addEventListener('pageshow', retry);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', retry);
    window.removeEventListener('pageshow', retry);
  };
}

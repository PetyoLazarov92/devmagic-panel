/** The version of the panel this page loaded from, once its session answered. */
let pageVersion: string | undefined;
export function notePanelVersion(version: string): void {
  pageVersion = version;
}

/**
 * Waiting for the panel to come back after an update restarts it: done runs
 * once /healthz answers with a version other than the one this page loaded
 * from (`from`), or answers again after it did not, or after maxMs whatever it
 * says. Without `from`, the first answer stands in for it. Returns the stop.
 */
export function waitForRestart(
  health: () => Promise<string | null>,
  done: () => void,
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
  const finish = () => {
    if (stopped) return;
    stopped = true;
    done();
  };
  const poll = async () => {
    const version = await health();
    if (stopped) return;
    if (first === undefined) first = version;
    else if (version === null) wentDown = true;
    else if (wentDown || version !== first) return finish();
    if (now() - started >= maxMs) return finish();
    timer = setTimeout(() => void poll(), everyMs);
  };
  timer = setTimeout(() => void poll(), everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Waiting for the panel to come back after an update restarts it: done runs
 * once /healthz answers with a new version, or answers again after it did
 * not, or after maxMs whatever it says. Returns the stop.
 */
export function waitForRestart(health: () => Promise<string | null>, done: () => void, { everyMs = 1000, maxMs = 60_000, now = Date.now } = {}): () => void {
  const started = now();
  // undefined until the first answer; null when the panel did not answer.
  let first: string | null | undefined;
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

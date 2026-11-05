/**
 * Failed jobs you have already opened, so the header badge stops asking for
 * attention. A per-browser convenience: lost storage only means a failed job
 * shows up once more.
 */
const KEY = 'dmp:seen-jobs';
const EVENT = 'dmp:seen-jobs';
const KEEP = 50;

export function seenJobs(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markJobSeen(id: string): void {
  const seen = seenJobs();
  if (seen.has(id)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen, id].slice(-KEEP)));
  } catch {
    // Storage blocked: the badge just keeps showing the failure.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Calls back when a job is marked seen, here or in another part of the page. */
export function onJobSeen(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}

/**
 * Whether the panel answers: a request that finds no panel (the connection
 * dropped while it restarted, or Apache reloaded) marks it unreachable until
 * the next answer, for the status in the top bar.
 */

let unreachable = false;
const listeners = new Set<() => void>();

export function onConnectionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isUnreachable = () => unreachable;

export function noteReached(reached: boolean): void {
  if (unreachable === !reached) return;
  unreachable = !reached;
  listeners.forEach((fn) => fn());
}

/** How long a read waits before it is asked once more, after a dropped connection. */
export const RETRY_MS = 1000;

/** The panel did not answer: a read says to try again, a change that it may or may not have run. */
export const unreachableMessage = (method: string) =>
  method === 'GET'
    ? 'The panel did not answer: it may be restarting. It comes back by itself in a moment.'
    : 'The panel did not answer, so it is not known whether this ran: it may have restarted. Activity shows what ran.';

/** The answers Apache gives while the panel behind it is down or restarting. */
export const isProxyDown = (status: number) => status === 502 || status === 503 || status === 504;

const aborted = (error: unknown, signal?: AbortSignal) => signal?.aborted === true || (error as Error)?.name === 'AbortError';

/**
 * Sends a request the way the panel's pages do when it may be restarting: a
 * read that finds no panel (a dropped connection, or Apache's 502, 503 or
 * 504 for it) is asked once more after RETRY_MS; a change never is, as it may
 * have run. Answers the response, or 'unreachable' when the panel did not
 * answer, and marks the panel reached or not. An abort is thrown as it is.
 */
export async function sendWithRetry(send: () => Promise<Response>, method: string, signal?: AbortSignal, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<Response | 'unreachable'> {
  const once = async (): Promise<Response | null> => {
    try {
      const res = await send();
      return isProxyDown(res.status) ? null : res;
    } catch (error) {
      if (aborted(error, signal)) throw error;
      return null;
    }
  };
  let res = await once();
  if (!res && method === 'GET') {
    await wait(RETRY_MS);
    res = await once();
  }
  noteReached(res !== null);
  return res ?? 'unreachable';
}

import { describe, expect, it } from 'vitest';
import { isUnreachable, sendWithRetry } from '../src/lib/connection.js';

const answer = (status: number) => new Response('{}', { status });
const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
const noWait = async () => undefined;

describe('a request while the panel may be restarting', () => {
  it('asks a read once more after a dropped connection or a proxy error, and marks the panel reached again', async () => {
    let calls = 0;
    const res = await sendWithRetry(() => (++calls === 1 ? dropped() : Promise.resolve(answer(200))), 'GET', undefined, noWait);
    expect(calls).toBe(2);
    expect(res).not.toBe('unreachable');
    expect(isUnreachable()).toBe(false);
    calls = 0;
    expect(await sendWithRetry(() => Promise.resolve(answer(++calls === 1 ? 503 : 200)), 'GET', undefined, noWait)).not.toBe('unreachable');
    expect(calls).toBe(2);
  });

  it('never sends a change twice, as it may have run, and says the panel did not answer', async () => {
    let calls = 0;
    expect(await sendWithRetry(() => (calls++, dropped()), 'POST', undefined, noWait)).toBe('unreachable');
    expect(calls).toBe(1);
    expect(isUnreachable()).toBe(true);
    // A read that fails twice gives up too.
    expect(await sendWithRetry(dropped, 'GET', undefined, noWait)).toBe('unreachable');
  });

  it('lets an abort through as it is, and counts a real answer like 500 as the panel answering', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(sendWithRetry(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'GET', stop.signal, noWait)).rejects.toThrow('aborted');
    expect(await sendWithRetry(() => Promise.resolve(answer(500)), 'GET', undefined, noWait)).toMatchObject({ status: 500 });
    expect(isUnreachable()).toBe(false);
  });
});

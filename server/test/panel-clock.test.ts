import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/exec.js';
import { ModeProgress } from '../src/modes.js';
import { type BootClock, CLOCK_KEY, PanelClock } from '../src/panel-clock.js';
import { ghSource, httpsSource, splitGhAnswer } from '../src/release-source.js';

function memory() {
  const meta = new Map<string, string>();
  return { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => void meta.set(k, v), meta };
}

const GITHUB_DATE = 'Sun, 15 Nov 2026 10:00:00 GMT';
const HOUR = 3_600_000;

/** A machine clock and a boot clock the test moves by hand. */
function computer(machine: number) {
  const pc = { machine, boot: { id: 'boot-1', upMs: 50_000 } as BootClock | null };
  return { pc, clock: (store = memory()) => new PanelClock(store, () => pc.machine, () => pc.boot) };
}

describe('panel clock', () => {
  it("goes by GitHub's time, carried by how long the computer is up, whatever the system clock says", () => {
    const { pc, clock } = computer(Date.parse('2026-11-30T10:00:00Z'));
    const c = clock();
    c.learn(GITHUB_DATE);
    expect(c.now().toISOString()).toBe('2026-11-15T10:00:00.000Z');
    pc.machine += 40 * 24 * HOUR;
    pc.boot = { id: 'boot-1', upMs: 50_000 + 2 * HOUR };
    expect(c.now().toISOString()).toBe('2026-11-15T12:00:00.000Z');
  });

  it('keeps its time when the panel restarts in the same boot, and ignores an answer that is not a date', () => {
    const { pc, clock } = computer(Date.parse('2026-11-15T10:00:00Z'));
    const store = memory();
    clock(store).learn(GITHUB_DATE);
    clock(store).learn('soon');
    clock(store).learn(null);
    pc.machine += 5 * 24 * HOUR;
    pc.boot = { id: 'boot-1', upMs: 50_000 + HOUR };
    expect(clock(store).now().toISOString()).toBe('2026-11-15T11:00:00.000Z');
  });

  it("starts a new boot from the machine's clock, never earlier than the last time it knew, and carries that too", () => {
    const { pc, clock } = computer(Date.parse('2026-11-15T10:00:00Z'));
    const store = memory();
    clock(store).learn(GITHUB_DATE);
    pc.boot = { id: 'boot-2', upMs: 10_000 };
    pc.machine = Date.parse('2026-11-01T08:00:00Z');
    expect(clock(store).now().toISOString()).toBe('2026-11-15T10:00:00.000Z');
    pc.boot = { id: 'boot-3', upMs: 10_000 };
    pc.machine = Date.parse('2026-11-16T08:00:00Z');
    const c = clock(store);
    expect(c.now().toISOString()).toBe('2026-11-16T08:00:00.000Z');
    pc.machine += 30 * 24 * HOUR;
    pc.boot = { id: 'boot-3', upMs: 10_000 + HOUR };
    expect(c.now().toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(JSON.parse(store.meta.get(CLOCK_KEY) ?? '{}')).toMatchObject({ id: 'boot-3', from: 'machine' });
  });

  it("is the machine's clock where there is no boot clock", () => {
    const { pc, clock } = computer(Date.parse('2026-11-20T10:00:00Z'));
    pc.boot = null;
    const c = clock();
    c.learn(GITHUB_DATE);
    expect(c.now().toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });
});

describe("the modes' day", () => {
  it('never goes back, so the line and the day counters stay put when the clock is set back', () => {
    let now = new Date(2026, 10, 16, 9, 0);
    const progress = new ModeProgress(memory(), () => now);
    const used = () => progress.developerView().counters.find((c) => c.id === 'usedDay')?.count ?? 0;
    progress.noteUse();
    const line = progress.line();
    expect(line.date).toBe('2026-11-16');
    now = new Date(2026, 10, 15, 9, 0);
    progress.noteUse();
    expect(progress.day()).toBe('2026-11-16');
    expect(progress.line()).toMatchObject({ date: '2026-11-16', text: line.text });
    expect(used()).toBe(1);
    now = new Date(2026, 10, 17, 9, 0);
    progress.noteUse();
    expect([progress.line().date, used()]).toEqual(['2026-11-17', 2]);
  });
});

describe("GitHub's time from the update check", () => {
  it('reads the Date of every answer the public way gets, a refusal too', async () => {
    const seen: Array<string | null | undefined> = [];
    const get = (async () => new Response('{"message":"x"}', { status: 403, headers: { date: GITHUB_DATE } })) as unknown as typeof fetch;
    await expect(httpsSource('me/panel', get, (d) => seen.push(d)).releases()).rejects.toThrow('too many requests');
    expect(seen).toEqual([GITHUB_DATE]);
  });

  it("reads the Date from gh api's headers and the releases from its body", async () => {
    const answer = `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nDate: ${GITHUB_DATE}\r\n\r\n[{"tag_name":"v0.7.0","body":"* new","assets":[]}]`;
    expect(splitGhAnswer(answer)).toEqual({ date: GITHUB_DATE, body: '[{"tag_name":"v0.7.0","body":"* new","assets":[]}]' });
    expect(splitGhAnswer('[]')).toEqual({ date: null, body: '[]' });
    const seen: Array<string | null | undefined> = [];
    const exec: Executor = async () => ({ code: 0, stdout: answer, stderr: '' });
    expect(await ghSource(exec, 'me/panel', (d) => seen.push(d)).releases()).toEqual([{ tag: 'v0.7.0', notes: '* new', sizes: {} }]);
    expect(seen).toEqual([GITHUB_DATE]);
  });
});

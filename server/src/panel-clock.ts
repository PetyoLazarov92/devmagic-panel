import { readFileSync } from 'node:fs';

/** Which boot this is and how long the computer has been up, sleep included (Linux's boot time, never set by hand). */
export interface BootClock {
  id: string;
  upMs: number;
}

let bootId: string | null | undefined;

/** The boot from /proc: its id and /proc/uptime, which counts sleep too. Null where /proc has neither. */
export function readBootClock(): BootClock | null {
  try {
    bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    const up = Number.parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0] ?? '');
    return bootId && Number.isFinite(up) ? { id: bootId, upMs: Math.round(up * 1000) } : null;
  } catch {
    bootId = null;
    return null;
  }
}

interface MetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** The meta row that holds the clock's last known time. */
export const CLOCK_KEY = 'panel-clock';

/** A time the panel knew, where in the boot it knew it, and where it came from. */
interface Anchor {
  at: number;
  id: string;
  up: number;
  from: 'github' | 'machine';
}

function readAnchor(raw: string | undefined): Anchor | null {
  try {
    const a = JSON.parse(raw ?? '') as Partial<Anchor>;
    if (typeof a.at === 'number' && typeof a.id === 'string' && typeof a.up === 'number' && (a.from === 'github' || a.from === 'machine')) return a as Anchor;
  } catch {
    // none yet
  }
  return null;
}

/**
 * The time the modes go by. It starts from GitHub's clock, read from the Date
 * of the answer the update check already gets (no request of its own), and
 * carries it forward by how long the computer has been up, so setting the
 * system clock changes nothing while this boot lasts. A new boot with no
 * answer from GitHub yet starts from this machine's clock, never earlier than
 * the last time the panel knew. Where /proc is missing it is the machine's
 * clock.
 */
export class PanelClock {
  private anchor: Anchor | null | undefined;

  constructor(
    private readonly store: MetaStore,
    private readonly machine: () => number = () => Date.now(),
    private readonly boot: () => BootClock | null = readBootClock,
  ) {}

  private keep(anchor: Anchor): void {
    this.anchor = anchor;
    this.store.setMeta(CLOCK_KEY, JSON.stringify(anchor));
  }

  /** The Date header of an answer from GitHub; anything that is not a date is ignored. */
  learn(date: string | null | undefined): void {
    const at = date ? Date.parse(date) : Number.NaN;
    const b = this.boot();
    if (!Number.isFinite(at) || !b) return;
    this.keep({ at, id: b.id, up: b.upMs, from: 'github' });
  }

  now(): Date {
    const b = this.boot();
    if (!b) return new Date(this.machine());
    this.anchor ??= readAnchor(this.store.getMeta(CLOCK_KEY));
    const a = this.anchor;
    if (a && a.id === b.id && b.upMs >= a.up) return new Date(a.at + (b.upMs - a.up));
    const at = Math.max(this.machine(), a?.at ?? 0);
    this.keep({ at, id: b.id, up: b.upMs, from: 'machine' });
    return new Date(at);
  }
}

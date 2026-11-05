import { useEffect, useRef, useState } from 'react';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';

/**
 * The hidden Developer options, turned on like Android's: tap the version
 * seven times. Remembered per browser; losing it only hides the page again.
 */
const KEY = 'dmp:developer';
const EVENT = 'dmp:developer';
const TAPS = 7;

export function developerOn(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setDeveloper(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the switch lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export function useDeveloper(): boolean {
  const [on, setOn] = useState(developerOn);
  useEffect(() => {
    const changed = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, changed);
    return () => window.removeEventListener(EVENT, changed);
  }, []);
  return on;
}

/** Counts taps on the version; a pause of two seconds starts over. */
export function useVersionTaps(): () => void {
  const taps = useRef({ count: 0, last: 0 });
  return () => {
    const now = Date.now();
    const t = taps.current;
    t.count = now - t.last > 2000 ? 1 : t.count + 1;
    t.last = now;
    if (developerOn()) {
      if (t.count === 1) return;
      toast({ tone: 'info', title: 'Developer options are already on', key: KEY });
      navigate('/developer');
      t.count = 0;
      return;
    }
    const left = TAPS - t.count;
    if (left === 0) {
      setDeveloper(true);
      toast({ tone: 'success', title: 'Developer options are on', detail: 'They are in the menu; turn them off on their page.', key: KEY });
      navigate('/developer');
      t.count = 0;
    } else if (left <= 3) {
      toast({ tone: 'info', title: `${left} more tap${left === 1 ? '' : 's'} to turn on developer options`, key: KEY });
    }
  };
}

import type { Preferences, PreferencesUpdate } from '@devmagic-panel/shared';
import { preferences as schema } from '@devmagic-panel/shared';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';

/**
 * How the panel looks, kept in its database so every browser you sign in
 * from gets it. This browser keeps a copy, so the first paint already shows
 * your theme and view; the panel's values win once they arrive.
 */
const KEY = 'dmp-preferences';
/** The theme alone, which index.html reads before the first paint. */
const THEME_KEY = 'dmp-theme';

function readCopy(): Preferences {
  try {
    const copy = schema.safeParse({ ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), ...(localStorage.getItem(THEME_KEY) ? { theme: localStorage.getItem(THEME_KEY) } : {}) });
    return copy.success ? copy.data : schema.parse({});
  } catch {
    return schema.parse({});
  }
}

let current = readCopy();
const listeners = new Set<() => void>();

function set(next: Preferences): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    localStorage.setItem(THEME_KEY, next.theme);
  } catch {
    // Private windows may refuse storage; the panel keeps them.
  }
  listeners.forEach((l) => l());
}

/** Takes the panel's values, once signed in. */
export async function loadPreferences(): Promise<void> {
  try {
    set(schema.parse(await api.preferences()));
  } catch {
    // Not signed in yet, or the panel is restarting: the copy stays.
  }
}

/** Changes some of them at once here, and saves them to the panel; before sign-in only here. */
export function savePreferences(update: PreferencesUpdate): void {
  set(schema.parse({ ...current, ...update }));
  void api.savePreferences(update).catch(() => undefined);
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

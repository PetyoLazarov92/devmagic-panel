import { type BrowserCounter, EFFECTS_OFF, type ModeEffects, type ModeId, type ModesView, MODES } from '@devmagic-panel/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { usePreferences } from '@/lib/preferences';
import { type ModeTextKey, modeText, pageName } from '@/lib/mode-names';

export { type ModeTextKey, modeText, pageName };

/**
 * Modes: a look on top of the light and dark theme. The panel says which are
 * unlocked; this keeps its answer, the mode shown for a moment by Preview,
 * the names a mode gives pages and the few lines it says its own way.
 */

let view: ModesView | null = null;
let preview: ModeId | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setModesView(next: ModesView): void {
  view = next;
  emit();
}

export function useModesView(): ModesView | null {
  return useSyncExternalStore(subscribe, () => view);
}

let lastRead = 0;
/** Asks the panel again, at most every few seconds unless `now`: after a page change, a job that ended, or on the Modes page. */
export async function refreshModes(now = false): Promise<void> {
  if (!now && Date.now() - lastRead < 4000) return;
  lastRead = Date.now();
  try {
    setModesView(await api.modes());
  } catch {
    // Signed out or restarting: the next page change asks again.
  }
}

/** Something the browser counts for the modes' paths: a command run from Ctrl+K, a fix from Aura. Never in the way if it fails. */
export function reportModeEvent(event: BrowserCounter): void {
  void api.modeEvent(event).then(setModesView, () => undefined);
}

/** A word typed in Ctrl+K with nothing to match: the panel says whether it unlocked a mode. */
export async function speakModeWord(word: string): Promise<string | null> {
  try {
    const answer = await api.modeWord(word);
    setModesView(answer);
    return answer.unlocked;
  } catch {
    return null;
  }
}

/** Shows a mode on this page for a moment, without saving it; null ends it. */
export function setPreviewMode(mode: ModeId | null): void {
  preview = mode;
  emit();
}

export function usePreviewMode(): ModeId | null {
  return useSyncExternalStore(subscribe, () => preview);
}

const reducedQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)');

/** Whether the system asks for less motion: then no effect runs, whatever is switched on. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      const q = reducedQuery();
      q.addEventListener('change', l);
      return () => q.removeEventListener('change', l);
    },
    () => reducedQuery().matches,
  );
}

/** The mode on screen (a preview wins over the saved one) and the effects that run, none with reduced motion. */
export function useActiveMode(): { mode: ModeId; effects: ModeEffects; reduced: boolean } {
  const prefs = usePreferences();
  const previewing = usePreviewMode();
  const reduced = useReducedMotion();
  const saved = (MODES as readonly string[]).includes(prefs.mode) ? prefs.mode : 'classic';
  const mode = previewing ?? saved;
  const chosen = mode === 'classic' ? EFFECTS_OFF : previewing ? { pointer: true, elements: true, background: true } : (prefs.effects[mode] ?? EFFECTS_OFF);
  return { mode, effects: reduced ? EFFECTS_OFF : chosen, reduced };
}

/** Puts the mode on the page's root, where its styles hang: `data-mode`, `data-fx` for the elements effect and `data-fx-bg` for the background's glow. */
export function useApplyMode(): void {
  const { mode, effects } = useActiveMode();
  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'classic') delete root.dataset.mode;
    else root.dataset.mode = mode;
    if (mode !== 'classic' && effects.elements) root.dataset.fx = '';
    else delete root.dataset.fx;
    // The background effect's still part, a soft glow behind the page, is CSS; its moving part is the canvas.
    if (mode !== 'classic' && effects.background) root.dataset.fxBg = '';
    else delete root.dataset.fxBg;
  }, [mode, effects.elements, effects.background]);
}

/** A page's name in the mode on screen. */
export function usePageName(): (classic: string) => string {
  const { mode } = useActiveMode();
  return (classic) => pageName(classic, mode);
}

export function useModeText(): (key: ModeTextKey) => string {
  const { mode } = useActiveMode();
  return (key) => modeText(key, mode);
}

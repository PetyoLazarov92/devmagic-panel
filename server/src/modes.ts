import { type BrowserCounter, countMode, isUnlocked as unlockedIn, type ModeCounter, type ModesDeveloperView, modesDeveloper, modesDeveloperView, type ModesState, type ModesView, modesView, readModesState, type SealedModeId, speakWord } from '@devmagic-panel/shared';

/** The meta row that holds the counters, where each path started and what is unlocked. */
export const MODES_KEY = 'modes';

interface MetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** How often the browser may report the same thing: a burst of clicks counts once a second. */
const BROWSER_EVENT_GAP_MS = 1000;

/**
 * The modes' progress, kept in the panel's database: counted as things finish
 * well, never sent anywhere. A typed word is compared and dropped.
 */
export class ModeProgress {
  private readonly lastBrowserEvent = new Map<BrowserCounter, number>();

  constructor(private readonly store: MetaStore, private readonly now: () => Date = () => new Date()) {}

  private change<T>(edit: (state: ModesState, now: Date) => T): T {
    const now = this.now();
    const state = readModesState(this.store.getMeta(MODES_KEY), now);
    const result = edit(state, now);
    this.store.setMeta(MODES_KEY, JSON.stringify(state));
    return result;
  }

  private state(): ModesState {
    return readModesState(this.store.getMeta(MODES_KEY), this.now());
  }

  /** One more of something the server saw finish; `key` counts it once per key. */
  count(counter: ModeCounter, key?: string): SealedModeId[] {
    return this.change((state, now) => countMode(state, counter, now, key));
  }

  /** One more of something the browser reports, at most once a second each. */
  report(counter: BrowserCounter): SealedModeId[] {
    const at = this.now().getTime();
    const last = this.lastBrowserEvent.get(counter);
    if (last !== undefined && at - last < BROWSER_EVENT_GAP_MS) return [];
    this.lastBrowserEvent.set(counter, at);
    return this.count(counter);
  }

  word(text: string): SealedModeId | null {
    return this.change((state, now) => speakWord(state, text, now));
  }

  view(): ModesView {
    return modesView(this.state());
  }

  isUnlocked(mode: string): boolean {
    return mode === 'classic' || unlockedIn(this.state(), mode as SealedModeId);
  }

  seen(mode: SealedModeId): void {
    this.change((state) => {
      const done = state.unlocks[mode];
      if (done) done.seen = true;
    });
  }

  developerView(): ModesDeveloperView {
    return modesDeveloperView(this.state());
  }

  unlock(mode: SealedModeId): void {
    this.change((state, now) => modesDeveloper.unlock(state, mode, now));
  }

  seal(mode: SealedModeId): void {
    this.change((state) => modesDeveloper.seal(state, mode));
  }

  replay(mode: SealedModeId): void {
    this.change((state) => modesDeveloper.replay(state, mode));
  }

  resetMode(mode: SealedModeId): void {
    this.change((state, now) => modesDeveloper.resetMode(state, mode, now));
  }

  resetPath(pathId: string): void {
    this.change((state, now) => modesDeveloper.resetPath(state, pathId, now));
  }

  completePath(pathId: string): SealedModeId[] {
    return this.change((state, now) => modesDeveloper.completePath(state, pathId, now));
  }
}

/** Action runs that count, once they finished well: an Undo, or a site moved onto nginx (once per site). */
export function countAction(progress: ModeProgress, id: string, input: unknown): void {
  if (id === 'mysql.undoRowChange' || id === 'mysql.undoCleanup' || id === 'cron.undo' || id === 'wpcron.undo') progress.count('undo');
  if (id === 'site.setServer' && input && typeof input === 'object') {
    const { domain, server } = input as { domain?: unknown; server?: unknown };
    if (typeof domain === 'string' && (server === 'nginx' || server === 'nginx-apache')) progress.count('nginxSite', domain);
  }
}

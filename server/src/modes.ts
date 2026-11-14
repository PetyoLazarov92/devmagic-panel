import { type BrowserCounter, countMode, startFreshPaths, isUnlocked as unlockedIn, type ModeCounter, type ModesDeveloperView, modesDeveloper, modesDeveloperView, type ModesState, type ModesView, modesView, readModesState, type SealedModeId, speakWord } from '@devmagic-panel/shared';

/** The meta row that holds the counters, where each path started and what is unlocked. */
export const MODES_KEY = 'modes';
/** The panel version the modes last saw running, to notice an update. */
export const VERSION_KEY = 'modes-version';

/** Whether a version like 1.51.0 (or v1.51.0) is newer than another. */
export function newerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

interface MetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** A late night runs from midnight to this hour, by this machine's clock. */
const LATE_NIGHT_ENDS = 4;

/** How often the browser may report the same thing: a burst of clicks counts once a second. */
const BROWSER_EVENT_GAP_MS = 1000;

/**
 * The modes' progress, kept in the panel's database: counted as things finish
 * well, never sent anywhere. A typed word is compared and dropped.
 */
export class ModeProgress {
  private readonly lastBrowserEvent = new Map<BrowserCounter, number>();
  /** The last late night counted, so the requests after it in the same night skip the database. */
  private lastNight: string | undefined;

  constructor(private readonly store: MetaStore, private readonly now: () => Date = () => new Date()) {
    // A mode this release added starts its paths now, from what the counters hold.
    this.change((state, at) => startFreshPaths(state, at));
  }

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
  count(counter: ModeCounter, key?: string, amount = 1): SealedModeId[] {
    return this.change((state, now) => countMode(state, counter, now, key, amount));
  }

  /** Something done in the panel: between midnight and 4 in the morning by this machine's clock, that night counts once. */
  noteLateNight(): SealedModeId[] {
    const now = this.now();
    if (now.getHours() >= LATE_NIGHT_ENDS) return [];
    const night = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (night === this.lastNight) return [];
    this.lastNight = night;
    return this.count('lateNight', night);
  }

  /** The panel started on `version`: one panel update when it is newer than the one it ran before (a switch back is not one). */
  noteVersion(version: string): SealedModeId[] {
    const before = this.store.getMeta(VERSION_KEY);
    this.store.setMeta(VERSION_KEY, version);
    return before && newerVersion(version, before) ? this.count('panelUpdate') : [];
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

/** Action runs that count, once they started or finished well: an Undo, a site moved onto nginx (once per site), the plugins and themes updated, a site's PHP switched, something restored. */
export function countAction(progress: ModeProgress, id: string, input: unknown): void {
  if (id === 'site.updatePlugins' && input && typeof input === 'object') {
    const { plugins, themes } = input as { plugins?: unknown; themes?: unknown };
    const n = (Array.isArray(plugins) ? plugins.length : 0) + (Array.isArray(themes) ? themes.length : 0);
    if (n > 0) progress.count('pluginUpdate', undefined, n);
  }
  if (id === 'site.setPhp') progress.count('phpSwitch');
  if (id === 'site.login') progress.count('wpLogin');
  if (id === 'file.write') progress.count('fileSave');
  if (id === 'cert.reissue') progress.count('certReissue');
  if (id === 'db.cleanTransients' || id === 'db.cleanContent' || id === 'db.cleanOrphans') progress.count('dbClean');
  if (id === 'db.restore' || id === 'db.restoreKept' || id === 'trash.restore' || id === 'file.restore') progress.count('restore');
  if (id === 'mysql.undoRowChange' || id === 'mysql.undoCleanup' || id === 'cron.undo' || id === 'wpcron.undo') progress.count('undo');
  if (id === 'site.setServer' && input && typeof input === 'object') {
    const { domain, server } = input as { domain?: unknown; server?: unknown };
    if (typeof domain === 'string' && (server === 'nginx' || server === 'nginx-apache')) progress.count('nginxSite', domain);
  }
}

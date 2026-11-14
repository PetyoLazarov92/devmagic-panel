import { checkPaths, countMode, dailyLine, emptyModesState, isUnlocked, localDate, modeForWord, type ModeId, type ModePuzzle, modesDeveloper, modesDeveloperView, type ModesState, modesView, nextPuzzle, puzzleQuestion, readModesState, speakWord, startFreshPaths } from '@devmagic-panel/shared';
import type { Api } from '@/lib/api';

/**
 * The modes in the mockup: the panel's own rules, run in this browser and kept
 * in its storage, counted from what the mockup can see. Only the local mockup
 * uses this; the public demo is built with mock/modes-demo.ts in its place
 * (web/vite.config.ts), so the words, the paths and the daily lines never ship
 * with it.
 */

function mockLineSeen(): string | null {
  try {
    return localStorage.getItem('dmp-mock-line-seen');
  } catch {
    return null;
  }
}

// Developer options' puzzle in the mockup: the question asked, and whether it was solved in this tab.
let mockPuzzle: ModePuzzle | undefined;
const MOCK_MODES_OPEN = 'dmp-mock-modes-open';
function mockModesOpen(): boolean {
  try {
    return sessionStorage.getItem(MOCK_MODES_OPEN) === '1';
  } catch {
    return false;
  }
}
function setMockModesOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(MOCK_MODES_OPEN, '1');
    else sessionStorage.removeItem(MOCK_MODES_OPEN);
  } catch {
    // the mockup forgets it then
  }
}

// The modes' progress, kept in this browser: the same rules as the panel's, counted from what the mockup can see.
const MOCK_MODES_KEY = 'dmp-mock-modes';
function mockModes(): ModesState {
  try {
    const state = readModesState(localStorage.getItem(MOCK_MODES_KEY) ?? undefined);
    startFreshPaths(state);
    checkPaths(state);
    return state;
  } catch {
    return emptyModesState();
  }
}
function changeMockModes(edit: (state: ModesState) => unknown): ModesState {
  const state = mockModes();
  edit(state);
  try {
    localStorage.setItem(MOCK_MODES_KEY, JSON.stringify(state));
  } catch {
    // the mock forgets them then
  }
  return state;
}

/** Whether a mode may be switched on. */
export function mockModeOpen(mode: ModeId): boolean {
  return isUnlocked(mockModes(), mode);
}

type ModesApi = Pick<Api, 'modes' | 'modeSeen' | 'modeEvent' | 'modeWordCheck' | 'modeWord' | 'modesDeveloper' | 'modeDeveloper' | 'modePath' | 'modesDeveloperState' | 'modesPuzzle' | 'modesPuzzleAnswer' | 'modesLock' | 'dailyLine' | 'dailyLineSeen'>;

export const mockModesApi: ModesApi = {
  modes: async () => modesView(mockModes()),
  modeSeen: async (mode) => modesView(changeMockModes((st) => { const done = st.unlocks[mode]; if (done) done.seen = true; })),
  modeEvent: async (event) => modesView(changeMockModes((st) => countMode(st, event))),
  modeWordCheck: async (word) => ({ mode: modeForWord(word) }),
  modeWord: async (word) => {
    let unlocked: string | null = null;
    const state = changeMockModes((st) => { unlocked = speakWord(st, word); });
    return { ...modesView(state), unlocked };
  },
  modesDeveloper: async () => {
    if (!mockModesOpen()) throw new Error('The modes are locked: solve the puzzle first');
    return modesDeveloperView(mockModes());
  },
  modeDeveloper: async (mode, what) => {
    const state = changeMockModes((st) => {
      if (what === 'unlock') modesDeveloper.unlock(st, mode);
      if (what === 'seal') modesDeveloper.seal(st, mode);
      if (what === 'reset') modesDeveloper.resetMode(st, mode);
    });
    return modesDeveloperView(state);
  },
  modePath: async (path, what) => modesDeveloperView(changeMockModes((st) => void (what === 'reset' ? modesDeveloper.resetPath(st, path) : modesDeveloper.completePath(st, path)))),
  // The puzzle as the panel asks it, the open state kept for this tab only.
  modesDeveloperState: async () => ({ open: mockModesOpen() }),
  modesPuzzle: async () => puzzleQuestion((mockPuzzle = nextPuzzle(mockPuzzle?.id))),
  modesPuzzleAnswer: async (id, choice) => {
    const asked = mockPuzzle;
    mockPuzzle = nextPuzzle(asked?.id);
    if (asked && asked.id === id && asked.answer === choice) {
      setMockModesOpen(true);
      return { solved: true };
    }
    return { solved: false, next: puzzleQuestion(mockPuzzle) };
  },
  modesLock: async () => {
    setMockModesOpen(false);
    return { open: false };
  },
  // The daily line as the panel picks it, shown once a day in this browser.
  dailyLine: async () => ({ ...dailyLine(mockModes(), localDate()), seen: mockLineSeen() === localDate() }),
  dailyLineSeen: async () => {
    try {
      localStorage.setItem('dmp-mock-line-seen', localDate());
    } catch {
      // the mockup shows it again then
    }
    return { ...dailyLine(mockModes(), localDate()), seen: true };
  },
};

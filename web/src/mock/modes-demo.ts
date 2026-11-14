import { BONUS_GOAL, isBonusMode, MODE_INFO, MODES, type ModeId, type ModesView } from '@devmagic-panel/shared';
import type { Api } from '@/lib/api';

/**
 * The modes in the public demo: a showcase. Every mode is open from the start
 * for visitors to try, and nothing about how a mode opens is here: no words,
 * no paths or their rules, no daily lines. The hunt, the riddles and the line
 * for today belong to the real panel. The public demo is built with this file
 * in place of mock/modes.ts (web/vite.config.ts), so the demo's code never
 * imports the secrets; the local mockup keeps the panel's rules.
 */

const OPEN_AT = '2026-01-01T00:00:00.000Z';
const NOTHING_TO_REVEAL = 'In the demo every mode is open, so there is nothing to reveal here. The real panel keeps its secrets.';

function showcase(): ModesView {
  return {
    modes: MODES.map((id) => ({
      id,
      ...MODE_INFO[id],
      unlocked: true,
      ...(id === 'classic' ? {} : { unlockedAt: OPEN_AT }),
      ...(isBonusMode(id) ? { bonus: { have: BONUS_GOAL[id], goal: BONUS_GOAL[id] } } : {}),
    })),
    earned: true,
    fresh: [],
  };
}

/** Whether a mode may be switched on: in the demo, every one. */
export function mockModeOpen(_mode: ModeId): boolean {
  return true;
}

type ModesApi = Pick<Api, 'modes' | 'modeSeen' | 'modeEvent' | 'modeWordCheck' | 'modeWord' | 'modesDeveloper' | 'modeDeveloper' | 'modePath' | 'modesDeveloperState' | 'modesPuzzle' | 'modesPuzzleAnswer' | 'modesLock' | 'dailyLine' | 'dailyLineSeen'>;

export const mockModesApi: ModesApi = {
  modes: async () => showcase(),
  modeSeen: async () => showcase(),
  modeEvent: async () => showcase(),
  modeWordCheck: async () => ({ mode: null }),
  modeWord: async () => ({ ...showcase(), unlocked: null }),
  modesDeveloper: async () => {
    throw new Error(NOTHING_TO_REVEAL);
  },
  modeDeveloper: async () => {
    throw new Error(NOTHING_TO_REVEAL);
  },
  modePath: async () => {
    throw new Error(NOTHING_TO_REVEAL);
  },
  modesDeveloperState: async () => ({ open: false }),
  modesPuzzle: async () => {
    throw new Error(NOTHING_TO_REVEAL);
  },
  modesPuzzleAnswer: async () => {
    throw new Error(NOTHING_TO_REVEAL);
  },
  modesLock: async () => ({ open: false }),
  dailyLine: async () => {
    throw new Error('The line for today lives in the real panel.');
  },
  dailyLineSeen: async () => {
    throw new Error('The line for today lives in the real panel.');
  },
};

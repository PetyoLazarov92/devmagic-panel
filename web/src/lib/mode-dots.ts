import { BONUS_MODES, isBonusMode, type ModeId, type ModesView } from '@devmagic-panel/shared';

/** Each mode's main color, light and dark, as its thumbnail's accent: the color its dot takes once found. */
export const MODE_COLOR: Record<Exclude<ModeId, 'classic'>, [string, string]> = {
  wizard: ['#5a3fd6', '#a78bfa'],
  circuit: ['#0a7fa6', '#3fd8ff'],
  forge: ['#c4501a', '#ff8a3d'],
  grove: ['#2f7d4a', '#7ccf8a'],
  abyss: ['#c2407e', '#ff7ab6'],
  neon: ['#b0208f', '#ff4fd8'],
  ink: ['#b8432f', '#e0664c'],
  dune: ['#c0623a', '#e2955a'],
  pixel: ['#4a9a22', '#9be15d'],
  sorbet: ['#e0628c', '#ff9bb3'],
  deco: ['#a07a24', '#d4af5a'],
  chrome: ['#6a7480', '#c8d2de'],
  atlas: ['#b03024', '#e6b45a'],
  frostfall: ['#4a7ca6', '#9cc8ec'],
  storms: ['#b06a1a', '#ffb347'],
};

/** The dots' slots: 15 in one row, the bonus modes at 5, 10 and 15, where they open as the others are found. */
export const SLOTS = 15;
const BONUS_SLOTS = [4, 9, 14];

export interface Dot { mode: Exclude<ModeId, 'classic'> | null; bonus: boolean }

/**
 * The modes found so far, as dots: the others in the order they were found, each in its own color,
 * the bonus modes in their own slots with a ring. Never a name, and an empty dot says nothing of
 * which mode it stands for.
 */
export function modeDots(view: ModesView | null): Dot[] {
  const found = (view?.modes ?? [])
    .filter((m) => m.id !== 'classic' && m.unlocked && !isBonusMode(m.id))
    .sort((a, b) => (a.unlockedAt ?? '').localeCompare(b.unlockedAt ?? ''))
    .map((m) => m.id as Exclude<ModeId, 'classic'>);
  const bonusOpen = new Set((view?.modes ?? []).filter((m) => isBonusMode(m.id) && m.unlocked).map((m) => m.id));
  let next = 0;
  return Array.from({ length: SLOTS }, (_, i): Dot => {
    const b = BONUS_SLOTS.indexOf(i);
    if (b >= 0) {
      const mode = BONUS_MODES[b] as Exclude<ModeId, 'classic'>;
      return { mode: bonusOpen.has(mode) ? mode : null, bonus: true };
    }
    return { mode: found[next++] ?? null, bonus: false };
  });
}

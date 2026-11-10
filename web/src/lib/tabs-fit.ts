/** Room kept for the More button once some tabs do not fit. */
export const MORE_WIDTH = 96;

/**
 * Which tabs show in a row this wide, from each tab's width: all of them
 * when they fit, else as many as fit beside More. The open tab always shows,
 * in place of the last one that would.
 */
export function fittingTabs(widths: number[], room: number, selected: number): number[] {
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, b) => a + b, 0) <= room) return all;
  const shown: number[] = [];
  let used = MORE_WIDTH;
  for (const i of all) {
    if (used + (widths[i] ?? 0) > room) break;
    used += widths[i] ?? 0;
    shown.push(i);
  }
  if (selected >= 0 && !shown.includes(selected)) {
    // The open tab takes the place of the last ones, as many as its width needs.
    while (shown.length && used + (widths[selected] ?? 0) > room) used -= widths[shown.pop() as number] ?? 0;
    shown.push(selected);
  }
  return shown;
}

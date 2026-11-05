/**
 * Which wizard steps the step list opens. Continue remembers a short hash of
 * the step's answers; a step after it opens again while every step before it
 * still has those answers and can go on. Change an answer and the steps after
 * it close; put it back and they open again.
 */

/** A short, stable hash of a step's answers, kept in the draft instead of the answers. */
export function answersHash(answers: unknown): string {
  const text = JSON.stringify(answers) ?? '';
  // FNV-1a, 32 bits: enough to tell one set of answers from another.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface StepView {
  /** Opens from the step list. */
  open: boolean;
  /** Passed and still the same: shown with a check. */
  done: boolean;
  /** Passed once, closed now because an answer before it changed. */
  stale: boolean;
}

/**
 * Every step of the flow: open up to the current one, and past it as far as
 * each step was passed with the answers it has now and can still go on.
 */
export function stepViews<S extends string>(flow: readonly S[], current: S, passed: Partial<Record<S, string>>, now: (step: S) => string, canNext: (step: S) => boolean): Record<S, StepView> {
  const at = flow.indexOf(current);
  let reach = 0;
  while (reach < flow.length - 1) {
    const step = flow[reach] as S;
    if (passed[step] === undefined || passed[step] !== now(step) || !canNext(step)) break;
    reach++;
  }
  const views = {} as Record<S, StepView>;
  flow.forEach((step, i) => {
    const open = i <= Math.max(at, reach);
    const same = passed[step] === undefined ? i < at : passed[step] === now(step) && canNext(step);
    views[step] = { open, done: open && step !== current && same, stale: !open && passed[step] !== undefined };
  });
  return views;
}

/**
 * Whether an address may open a step: the first one always, any other once
 * you continued from the step before it. Steps you skip ahead to by typing
 * the address are not opened.
 */
export function canOpen<S extends string>(flow: readonly S[], step: S, passed: Partial<Record<S, string>>): boolean {
  const i = flow.indexOf(step);
  if (i <= 0) return i === 0;
  return passed[flow[i - 1] as S] !== undefined;
}

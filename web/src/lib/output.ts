import { ansiRuns } from './ansi';

/** Output without its terminal color codes. */
export const plainText = (output: string) => ansiRuns(output).map((r) => r.text).join('');

/** A line that says what went wrong: whole words, so a name like NoEmitOnErrorsPlugin does not count, and TypeError does. */
const PROBLEM = /\w*errors?\b|\bfail(?:ed|ure|s)?\b|\bfatal\b|\bdenied\b|\brefus(?:ed|es)\b|\bERR!/i;
/** Progress lines (webpack --progress) name plugins, never a problem. */
const PROGRESS = /\[webpack\.Progress\]/;

/** The line of a command's output worth showing: the last that says what went wrong, else the last one. */
export function lastLine(output: string): string {
  // As plain text: a summary or a toast has no room for terminal colors.
  const lines = plainText(output).trim().split('\n').filter(Boolean);
  return lines.findLast((l) => PROBLEM.test(l) && !PROGRESS.test(l)) ?? lines.at(-1) ?? '';
}

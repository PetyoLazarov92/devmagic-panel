/**
 * Terminal color codes (ESC [ ... m) in command output, read into runs of text
 * with their color, so a page shows git's or an installer's colors instead of
 * the codes. Other codes (cursor moves, line clears) are dropped.
 */
export interface AnsiRun {
  text: string;
  /** 30 to 37, as for the 8 normal colors: the bright ones (90 to 97) count as these. */
  color?: number;
  /** A 24-bit color, as rgb(...). */
  rgb?: string;
  bold?: boolean;
  dim?: boolean;
}

const CODE = /\u001b\[([0-9;?]*)([@-~])|\u001b/g;

/** The style being built: a code may turn a part off again (undefined) before the run is written. */
type Style = { color?: number | undefined; rgb?: string | undefined; bold?: boolean | undefined; dim?: boolean | undefined };

export function ansiRuns(text: string): AnsiRun[] {
  const runs: Array<{ text: string } & Style> = [];
  let style: Style = {};
  let at = 0;
  const push = (part: string) => {
    if (!part) return;
    const last = runs.at(-1);
    if (last && last.color === style.color && last.rgb === style.rgb && last.bold === style.bold && last.dim === style.dim) last.text += part;
    else runs.push({ text: part, ...style });
  };
  for (const m of text.matchAll(CODE)) {
    push(text.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] as number;
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, bold: true };
      else if (c === 2) style = { ...style, dim: true };
      else if (c === 22) style = { ...style, bold: undefined, dim: undefined };
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) style = { ...style, color: c >= 90 ? c - 60 : c, rgb: undefined };
      else if (c === 39) style = { ...style, color: undefined, rgb: undefined };
      else if (c === 38 && codes[i + 1] === 5) {
        // 256 colors: the first 16 are the normal and bright ones; the rest keep the text color.
        const n = codes[i + 2] ?? 0;
        style = { ...style, color: n < 8 ? 30 + n : n < 16 ? 22 + n : undefined, rgb: undefined };
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) {
        style = { ...style, color: undefined, rgb: `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})` };
        i += 4;
      } else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  push(text.slice(at));
  // Drop empty keys so a run without style is just its text.
  return runs.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as unknown as AnsiRun);
}

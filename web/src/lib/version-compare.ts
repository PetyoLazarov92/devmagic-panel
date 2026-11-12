/** Orders two version numbers part by part (6.4.2 before 6.10); a part that is not a number is left equal. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(/[.+-]/);
  const y = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = Number(x[i] ?? 0);
    const q = Number(y[i] ?? 0);
    if (p !== q && Number.isFinite(p) && Number.isFinite(q)) return p < q ? -1 : 1;
  }
  return 0;
}

/** The first two parts of a version (7.1.3 is 7.1), as WordPress compares "tested up to". */
export const majorMinor = (v: string) => v.split('.').slice(0, 2).join('.');

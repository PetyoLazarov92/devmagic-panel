// Fails when a built web app holds any of the modes' secrets: a word, a path's rule or unlock line, a
// word's line or a daily line. The panel's own build (web, npm run build) and the public demo
// (scripts/demo/finish.mjs) both run it on what they built. Needs shared/ built first.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The secrets found in the files of `dir` (its .js and .html, one level down too), as a list. */
export async function modeSecretsIn(dir) {
  const { DAILY_LINES, MODE_PATHS, MODE_WORDS, MODE_WORD_LINE } = await import('../shared/dist/index.js');
  const files = readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? readdirSync(join(dir, e.name)).map((f) => join(dir, e.name, f)) : [join(dir, e.name)],
  );
  const built = files.filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  const lower = built.toLowerCase();
  return [
    ...Object.values(MODE_WORDS).filter((w) => new RegExp(`\\b${w}\\b`).test(lower)),
    ...[...MODE_PATHS.map((p) => p.rule), ...MODE_PATHS.map((p) => p.line), ...Object.values(MODE_WORD_LINE)].filter((t) => t && built.includes(t)),
    ...Object.values(DAILY_LINES).flat().map((l) => l.text.replace(/\*\*/g, '')).filter((t) => built.includes(t.slice(0, 40))),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node scripts/check-secrets.mjs <built folder>');
  const leaks = await modeSecretsIn(dir);
  if (leaks.length) {
    console.error(`${dir} holds ${leaks.length} of the modes' secrets, starting with: ${leaks[0]}`);
    process.exit(1);
  }
}

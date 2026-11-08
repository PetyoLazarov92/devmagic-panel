// Takes the README's and webtimeless.cloud's screenshots from the mockup, in light and dark:
// npm run screenshots. Each is 1440x900, on made-up sample data, so a release can redo them all
// in a minute. Uses the system's Chrome through playwright-core (no browser download); set
// CHROME_PATH to use another Chromium.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 5179;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = fileURLToPath(new URL('../assets/screenshots/', import.meta.url));
const SITE = '/sites/local.spellbook.example';

/** Name, address, and what to do on the page before the picture. */
const SHOTS = [
  ['sites', '/sites'],
  ['aura', '/aura'],
  ['new-site', '/sites/new'],
  ['site', `${SITE}?tab=php`],
  ['database', `${SITE}?tab=database`],
  [
    'sql',
    `${SITE}?tab=database&view=sql`,
    async (page) => {
      await page.locator('.cm-content').click();
      await page.keyboard.type('SELECT option_name, autoload, LENGTH(option_value) AS bytes FROM wp_options ORDER BY bytes DESC LIMIT 12', { delay: 5 });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.getByText('Result', { exact: true }).waitFor();
      await page.mouse.wheel(0, 380);
      await page.waitForTimeout(600);
    },
  ],
  ['performance', `${SITE}?tab=performance`],
  [
    'palette',
    '/sites',
    async (page) => {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(500);
    },
  ],
  ['activity', '/activity/runs'],
];

const only = process.argv.slice(2);

// A static build of the mockup, served here: steadier than Vite's dev server, which can reload
// while it prepares a lazily loaded part like the SQL editor.
const BUILT = fileURLToPath(new URL('../dist-shots/', import.meta.url));
const build = spawnSync('npx', ['vite', 'build', '--outDir', BUILT, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: fileURLToPath(new URL('../web/', import.meta.url)),
  env: { ...process.env, VITE_MOCK: '1' },
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const asked = normalize(join(BUILT, decodeURIComponent(new URL(req.url ?? '/', BASE).pathname)));
  let file = join(BUILT, 'index.html');
  try {
    if (asked.startsWith(BUILT) && statSync(asked).isFile()) file = asked;
  } catch {}
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

try {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addInitScript((t) => localStorage.setItem('dmp-theme', t), theme);
    for (const [name, path, before] of SHOTS) {
      if (only.length && !only.includes(name)) continue;
      const page = await context.newPage();
      await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}proposals=none`);
      await page.locator('main h1').first().waitFor();
      // The mockup's own menu item is for the mockup, not for the panel's pictures.
      await page.addStyleTag({ content: 'a[href="/mockup"] { display: none !important; }' });
      // The mockup answers after a short wait, like the panel; let every card load.
      await page.waitForTimeout(1800);
      if (before) await before(page);
      await page.screenshot({ path: `${OUT}${name}-${theme}.png` });
      await page.close();
      console.log(`${name}-${theme}.png`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.close();
}

// Lists every control the panel's screens show, page by page, from the mockup: buttons, links,
// fields, tabs, switches, headings and the items of every menu. A redesign checks it did not
// lose one: npm run ui:inventory writes web/test/ui-inventory.json, and
// npm run ui:inventory -- --check compares the screens with it and fails on anything missing
// (new controls are listed, not a failure). Numbers and times are left out of the names, so
// sample data that moves with the clock does not count as a change. Uses the system's Chrome
// through playwright-core, like scripts/screenshots.mjs; set CHROME_PATH for another Chromium.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 5181;
const BASE = `http://127.0.0.1:${PORT}`;
const SNAPSHOT = fileURLToPath(new URL('../web/test/ui-inventory.json', import.meta.url));
const check = process.argv.includes('--check');

const SITE = '/sites/local.spellbook.example';
const SITE_TABS = ['overview', 'logs', 'files', 'network', 'plugins', 'database', 'performance', 'cron', 'config', 'php', 'domains'];
const PAGES = [
  '/sites',
  '/sites?filter=removed',
  '/sites/new',
  ...SITE_TABS.map((t) => `${SITE}?tab=${t}`),
  `${SITE}?tab=plugins&view=themes`,
  `${SITE}?tab=files&view=uploads`,
  `${SITE}?tab=database&view=tables`,
  `${SITE}?tab=database&view=sql`,
  `${SITE}?tab=database&view=tools`,
  `${SITE}?tab=php&view=htaccess`,
  '/sites/local.spellbook.example/learn',
  '/sites/local.arcade.example',
  '/sites/local.biketours.example',
  '/aura',
  '/aura/machine',
  '/mail',
  '/cores',
  '/services',
  '/services/php',
  '/services/php/8.3',
  '/services/php/8.3/settings',
  '/services/php/8.3/modules',
  '/services/php/8.3/xdebug',
  '/services/php/8.3/sites',
  '/services/php/8.3/info',
  '/services/mysql',
  '/services/apache',
  '/services/nginx',
  '/services/cron',
  '/activity',
  '/activity/runs',
  '/update',
  '/settings',
  '/modes',
  '/developer',
];

// A static build of the mockup, served here, as the screenshots do.
const BUILT = fileURLToPath(new URL('../dist-inventory/', import.meta.url));
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

/** What the page shows inside main: role and accessible name, digits and times folded. */
function collect() {
  const fold = (s) =>
    s
      // TextLink tells screen readers a link opens a new tab; the link's name is the same.
      .replace(/\(opens in a new tab\)/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\d+([.,:]\d+)*/g, '#')
      .replace(/# ?(sec|min|hr|day|days|week|weeks|month|months|year|years)\.?( ago)?/gi, '# time')
      .trim()
      .slice(0, 120);
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
    return tag;
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return labelled.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent ?? '';
    }
    return el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };
  const root = document.querySelector('main') ?? document.body;
  const out = new Set();
  for (const el of root.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=menuitem], h1, h2, h3')) {
    if (el.closest('[aria-hidden=true]')) continue;
    const name = fold(nameOf(el));
    if (name) out.add(`${roleOf(el)}: ${name}`);
  }
  return [...out];
}

const found = {};
try {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const visit = async (path) => {
    const page = await context.newPage();
    await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}proposals=none`);
    await page.locator('main h1').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2200);
    const items = new Set(await page.evaluate(collect));
    // The items of each menu, opened one at a time.
    const triggers = page.locator('main [aria-haspopup=menu]');
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible())) continue;
      const name = ((await trigger.getAttribute('aria-label')) || (await trigger.textContent()) || '').replace(/\d+/g, '#').trim();
      await trigger.click().catch(() => undefined);
      await page.waitForTimeout(150);
      for (const item of await page.locator('[role=menuitem]').allTextContents()) items.add(`menu ${name}: ${item.replace(/\d+/g, '#').trim()}`);
      await page.keyboard.press('Escape');
    }
    const links = await page.evaluate(() => [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href')));
    await page.close();
    found[path] = [...items].sort();
    return links;
  };
  const extra = new Set();
  for (const path of PAGES) {
    for (const href of await visit(path)) {
      // One job, one run and one install draft, whatever their ids are today.
      for (const kind of ['/jobs/', '/runs/', '/sites/new/']) if (href?.startsWith(kind) && ![...extra].some((e) => e.startsWith(kind))) extra.add(href);
    }
  }
  for (const path of extra) await visit(path);
  await browser.close();
} finally {
  server.close();
}

// Ids in job, run and draft addresses change; their pages count under one name each.
const keyed = Object.fromEntries(Object.entries(found).map(([path, items]) => [path.replace(/^\/jobs\/.*/, '/jobs/:id').replace(/^\/runs\/.*/, '/runs/:id').replace(/^\/sites\/new\/.+/, '/sites/new/:draft'), items]));

if (!check) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(keyed, null, 1)}\n`);
  console.log(`${Object.keys(keyed).length} pages, ${Object.values(keyed).reduce((n, i) => n + i.length, 0)} controls, written to web/test/ui-inventory.json`);
} else {
  const before = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  let missing = 0;
  for (const [path, items] of Object.entries(before)) {
    const now = new Set(keyed[path] ?? []);
    // A control that kept its name under another role (a toggle button that became a radio) is still there.
    const nameOf = (i) => i.slice(i.indexOf(': ') + 2);
    const names = new Set([...now].map(nameOf));
    const gone = items.filter((i) => !now.has(i) && !names.has(nameOf(i)));
    const added = (keyed[path] ?? []).filter((i) => !items.includes(i));
    if (gone.length || added.length) console.log(`\n${path}`);
    for (const g of gone) console.log(`  - ${g}`);
    for (const a of added) console.log(`  + ${a}`);
    missing += gone.length;
  }
  console.log(missing ? `\n${missing} controls missing` : '\nNothing missing');
  process.exit(missing ? 1 : 0);
}

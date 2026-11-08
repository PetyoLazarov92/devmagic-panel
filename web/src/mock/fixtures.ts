import type { LogLine, RunSummary, Site } from '@devmagic-panel/shared';
import { LOCAL_MODE_DEFAULT_BLOCKED_HOSTS } from '@devmagic-panel/shared';

const DEBUG_LOG_ONLY: Site['debug']['constants'] = { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false, SCRIPT_DEBUG: null, SAVEQUERIES: null };
const DEBUG_OFF: Site['debug']['constants'] = { WP_DEBUG: false, WP_DEBUG_LOG: null, WP_DEBUG_DISPLAY: null, SCRIPT_DEBUG: null, SAVEQUERIES: null };

/**
 * Sample data for the design mockup (npm run mockup). Made-up sites shaped
 * like a typical local setup; replaced by API data once Phase 1 is wired.
 */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const sites: Site[] = [
  {
    domain: 'local.spellbook.example',
    title: 'Spellbook',
    aliases: ['local.spellbook.de', 'local.spellbook.fr', 'local.spellbook.es', 'local.spellbook.pt', 'local.spellbook.co.jp'],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.spellbook.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-05-23T00:00:10Z', names: ['local.spellbook.example', 'local.spellbook.de', 'local.spellbook.fr', 'local.spellbook.es', 'local.spellbook.pt', 'local.spellbook.co.jp'], issuer: 'legacy' },
    git: { remote: 'git@github.com:WandworksCo/marketing-spellbook.git', branch: 'feature/translation-export', upstream: 'origin/feature/translation-export', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '03df05b55', subject: "Fix: skip video embeds on import", author: 'Alex Morgan', date: '2026-10-21T16:46:46+08:00' } },
    // A theme and a plugin with repos of their own inside the site's folder.
    repos: [
      { folder: 'wp-content/themes/spellbook', kind: 'theme', name: 'spellbook', git: { remote: 'git@gitlab.com:wandworks-web/themes/spellbook.git', branch: 'main', upstream: 'origin/main', dirty: 1, ahead: 0, behind: 2, lastCommit: { hash: '8c21d0a4e', subject: 'Header: keep the menu open on tablets (!14)', author: 'Alex Morgan', date: '2026-10-24T10:12:00+03:00' } } },
      { folder: 'wp-content/plugins/spellbook-blocks', kind: 'plugin', name: 'spellbook-blocks', git: { remote: 'git@github.com:WandworksCo/spellbook-blocks.git', branch: 'feature/hero-block', upstream: null, dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: 'b77e1f320', subject: 'Hero block: add a video background option', author: 'Sam Lee', date: '2026-10-23T15:40:00+03:00' } } },
    ],
    db: { name: 'spellbookdb', sizeBytes: 1_480_000_000, tables: 214 },
    debug: { enabled: true, logBytes: 182_000, constants: DEBUG_LOG_ONLY },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    // As on many sites: BE Media from Production in the repo, its URL in wp-config.php.
    uploadsFrom: { host: 'www.spellbook.example', via: 'plugin' },
    mediaPlugin: { active: true, host: 'www.spellbook.example' },
    prodUrl: 'https://www.spellbook.example',
    health: 'warn',
    issues: [{ id: 'cert.legacy', status: 'warn', text: 'Cert still signed by the old LocalhostCA', fix: { action: 'cert.reissue', input: { domain: 'local.spellbook.example' }, label: 'Reissue cert' } }],
  },
  // Spellbook Learn: its own WordPress install under /learn, served by the Spellbook vhost.
  {
    domain: 'local.spellbook.example',
    path: '/learn',
    title: 'Spellbook Learn',
    aliases: [],
    vhostManaged: false,
    server: 'apache',
    removable: false, panelMade: false,
    docroot: '/var/www/local.learn.spellbook.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    git: { remote: 'git@github.com:WandworksCo/learn-spellbook.git', branch: 'bugfix/editor-heading-spacing', upstream: 'origin/bugfix/editor-heading-spacing', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '50e828431', subject: "Remove the extra heading margin in the editor (#88)", author: 'Alex Morgan', date: '2026-10-19T19:49:32+08:00' } },
    db: { name: 'spellbooklearndb', sizeBytes: 640_000_000, tables: 98 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: false, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS], uploadsFrom: 'www.spellbook.example' },
    uploadsFrom: { host: 'www.spellbook.example', via: 'local-mode' },
    health: 'warn',
    issues: [{ id: 'local.outdated', status: 'warn', text: 'The Local mode plugin is an older version', fix: { action: 'site.setLocalMode', input: { domain: 'local.spellbook.example', path: '/learn', enabled: true }, label: 'Update it' } }],
  },
  {
    domain: 'local.dailypost.example',
    title: 'Daily Post',
    aliases: [
      'local.deals.dailypost.example', 'local.dailypost.co.uk', 'local.dailypost.fr', 'local.dailypost.es',
      'local.dailypost.de', 'local.dailypost.it', 'local.dailypost.example.br', 'local.dailylists.example',
      'local.dailycats.example', 'local.dailyleaks.example', 'local.kids.dailymedia.example', 'local.dailyshopping.example',
      'local.dailytoday.example', 'local.dailycute.example',
    ],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.dailypost.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-12-15T12:06:55Z', names: ['local.dailypost.example', 'local.deals.dailypost.example'], issuer: 'legacy' },
    notInHosts: ['local.dailytoday.example', 'local.dailycute.example'],
    git: { remote: 'git@github.com:DailyMedia/dailypost.git', branch: 'bugfix/newsletter-invalid-url', upstream: null, dirty: 2, ahead: 0, behind: 0, lastCommit: { hash: 'f430d728c', subject: "Merge pull request #239 from DailyMedia/feature/plugin-updates", author: 'Sam Lee', date: '2026-10-19T14:18:40+03:00' } },
    db: { name: 'dailypostdb', sizeBytes: 3_900_000_000, tables: 61 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: false, current: true, blockedHosts: [] },
    prodUrl: 'https://dailypost.example',
    health: 'warn',
    issues: [
      { id: 'cert.uncovered', status: 'warn', text: 'www.local.dailypost.example is not covered by the cert', fix: { action: 'cert.reissue', input: { domain: 'local.dailypost.example' }, label: 'Reissue cert' } },
      {
        id: 'hosts.missing',
        status: 'warn',
        text: 'local.dailytoday.example, local.dailycute.example are missing from /etc/hosts',
        fix: { action: 'hosts.add', input: { domain: 'local.dailypost.example', aliases: [] }, label: 'Add to hosts' },
      },
      {
        id: 'vhost.portDrift',
        status: 'warn',
        text: 'Port 80 and 443 names differ: local.dailywishlist.example only on port 80 (no HTTPS)',
        hint: 'The panel leaves this vhost as is: list the same names in both blocks of /etc/apache2/sites-available/local.dailypost.example-ssl.conf, then reissue the cert.',
      },
      { id: 'local.off', status: 'warn', text: 'Local mode is off: this copy can email real people and call live mail APIs', fix: { action: 'site.setLocalMode', input: { domain: 'local.dailypost.example', enabled: true }, label: 'Turn on Local mode' } },
    ],
  },
  {
    domain: 'local.biketours.example',
    title: 'Bike Tours',
    aliases: [],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.biketours.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:42Z', names: ['local.biketours.example'], issuer: 'legacy' },
    git: { remote: 'git@github.com:WandworksCo/Bike-Tours.git', branch: 'master', upstream: 'origin/master', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: 'a407e4865', subject: "Listing filters: stop facet links from 404ing on archives (#950)", author: 'jordan-k', date: '2026-10-22T16:28:28-05:00' } },
    db: { name: 'biketoursdb', sizeBytes: 920_000_000, tables: 148 },
    debug: { enabled: true, logBytes: 4_200, constants: DEBUG_LOG_ONLY },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    prodUrl: 'https://biketours.example',
    health: 'ok',
    issues: [],
  },
  {
    domain: 'local.crmblog.example',
    title: 'CRM Blog',
    aliases: [],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.crmblog.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:18Z', names: ['local.crmblog.example'], issuer: 'legacy' },
    git: { remote: 'git@github.com:WandworksCo/CRM-Blog.git', branch: 'demo/resource-layout', upstream: 'origin/demo/resource-layout', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '4bd2eae91', subject: "Merge branch 'feature/resource-layout' into demo/resource-layout", author: 'Riley Chen', date: '2026-10-08T16:32:47+03:00' } },
    db: { name: 'crmblogdb', sizeBytes: 640_000_000, tables: 97 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'ok',
    issues: [],
  },
  {
    domain: 'local.wandworks-brands.example',
    title: 'Wandworks Brands',
    aliases: ['local.wandworks-outlet.example'],
    vhostManaged: true,
    server: 'nginx',
    move: { refusals: {}, ignored: [], php: '8.3', front: { apachePaths: [], staticRules: [] } },
    removable: true, panelMade: true,
    docroot: '/var/www/local.wandworks-brands.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    // Domains mapped to each site, with SUBDOMAIN_INSTALL off: a subdomain network whose new sites go under paths.
    network: {
      mode: 'subdirectory',
      type: 'subdomain',
      sites: [
        { id: 1, url: 'https://local.wandworks-brands.example/', title: 'Wandworks Brands' },
        { id: 2, url: 'https://local.wandworks-outlet.example/', title: 'Wandworks Outlet' },
        { id: 3, url: 'https://local.wandworks-repairs.example/', title: 'Wandworks Repairs', served: false },
      ],
    },
    cert: { expiresAt: '2028-03-02T09:00:00Z', names: ['local.wandworks-brands.example', 'local.wandworks-outlet.example'], issuer: 'new' },
    db: { name: 'wandworks_brands_com', sizeBytes: 220_000_000, tables: 61 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'warn',
    issues: [
      { id: 'network.unserved', status: 'warn', text: 'local.wandworks-repairs.example is a site of the network this site does not serve here', fix: { action: 'site.addAliases', input: { domain: 'local.wandworks-brands.example', aliases: ['local.wandworks-repairs.example'] }, label: 'Add as an alias' } },
    ],
  },
  {
    domain: 'local.arcade.example',
    title: 'Arcade.example',
    aliases: [],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.arcade.example',
    core: { kind: 'standalone', version: '6.8.3' },
    network: {
      mode: 'subdirectory',
      type: 'subdirectory',
      sites: [
        { id: 1, url: 'https://local.arcade.example/', title: 'Arcade.example' },
        { id: 2, url: 'https://local.arcade.example/de/', title: 'Arcade.example Deutschland' },
        { id: 3, url: 'https://local.arcade.example/es/', title: 'Arcade.example España' },
        { id: 4, url: 'https://local.arcade.example/pt-br/', title: 'Arcade.example Brasil' },
        { id: 5, url: 'https://local.arcade.example/fr/', title: 'Arcade.example France', archived: true },
        { id: 6, url: 'https://local.arcade.example/staging/', title: 'Arcade.example Staging', hidden: true },
        { id: 8, url: 'https://local.arcade.example/promo/', title: 'Arcade.example Promo', archived: true, spam: true },
      ],
      deleted: [{ id: 7, url: 'https://local.arcade.example/it/' }],
    },
    cert: { expiresAt: '2028-01-16T05:26:21Z', names: ['local.arcade.example'], issuer: 'legacy' },
    git: { remote: 'git@github.com:WandworksCo/ArcadeBet.git', branch: 'master', upstream: 'origin/master', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '5a14c83', subject: "Prize wheel: add an option to turn a prize off (#30)", author: 'Riley Chen', date: '2025-06-03T16:36:17+03:00' } },
    db: { name: 'arcadebetmsdb', sizeBytes: 310_000_000, tables: 402 },
    debug: { enabled: true, logBytes: 2_400_000, constants: DEBUG_LOG_ONLY },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'fail',
    issues: [
      { id: 'php.fatals', status: 'fail', text: '3 PHP fatal errors in the last hour', hint: 'Open the Logs tab to read them.' },
      { id: 'core.outdated', status: 'warn', text: 'WordPress 6.8.3 is outdated (latest is 7.1.3)', hint: 'This site has its own copy of WordPress: update it with wp core update.' },
    ],
  },
  {
    domain: 'local.newsnow.example',
    title: 'News Now',
    aliases: [],
    vhostManaged: false,
    server: 'apache',
    removable: true, panelMade: false,
    docroot: '/var/www/local.newsnow.example',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:01Z', names: ['local.newsnow.example'], issuer: 'legacy' },
    git: { remote: 'git@github.com:WandworksCo/NewsNow.git', branch: 'master', upstream: 'origin/master', dirty: 1, ahead: 0, behind: 0, lastCommit: { hash: '7e967209', subject: "Homepage: show a loading state while more articles load (#32)", author: 'Riley Chen', date: '2026-10-19T16:23:50+03:00' } },
    db: { name: 'newsnowdb', sizeBytes: 120_000_000, tables: 38 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'ok',
    issues: [],
  },
];

// A site the panel created: the only kind it can remove.
sites.push({
  domain: 'local.wandworks.test',
  title: 'Wandworks test shop',
  aliases: [],
  vhostManaged: true,
  server: 'apache',
  move: {
    refusals: {},
    ignored: ['W3TC Browser Cache', '2 lines of your own'],
    php: '8.3',
    front: { apachePaths: ['/wp-content/uploads/wc-logs'], staticRules: ['ExpiresByType image/png', 'Header set Cache-Control'] },
  },
  removable: true, panelMade: true,
  docroot: '/var/www/local.wandworks.test',
  core: { kind: 'wpcore', version: '7.1.3' },
  cert: { expiresAt: '2029-01-26T09:00:00Z', names: ['local.wandworks.test'], issuer: 'new' },
  db: { name: 'wandworks_test', sizeBytes: 4_200_000, tables: 12 },
  debug: { enabled: true, logBytes: 0, constants: DEBUG_LOG_ONLY },
  localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
  health: 'ok',
  issues: [],
});

// How the sample sites came here; the others were made by hand.
const installs: Record<string, Site['install']> = {
  'local.wandworks.test': {
    how: 'organization', org: 'wandworks', repo: 'git@github.com:wandworks/test-shop.git', at: '2026-10-22T10:00:00Z',
    skipped: [{ label: 'Run the build', todo: 'The build did not run, so built theme or plugin files may be missing. Run it in a terminal: cd /var/www/local.wandworks.test/wp-content/themes/shop && npm install && npm run build' }],
  },
  'local.biketours.example': { how: 'repo', repo: 'git@github.com:WandworksCo/Bike-Tours.git', at: '2026-10-24T17:20:00Z' },
  'local.newsnow.example': { how: 'restore', at: '2026-10-21T08:30:00Z', archivedAt: '2026-10-19T16:05:00Z' },
};
for (const site of sites) site.install = (!site.path && installs[site.domain]) || { how: site.panelMade ? 'panel' : 'hand' };

export const debugLog: LogLine[] = [
  { time: ago(2), level: 'fatal', message: "Uncaught Error: Call to undefined function arcade_bonus_locale() in /var/www/local.arcade.example/wp-content/themes/arcade/inc/bonus.php:88", source: 'themes/arcade/inc/bonus.php:88' },
  { time: ago(3), level: 'warning', message: 'Undefined array key "currency" in /var/www/local.arcade.example/wp-content/plugins/arcade-odds/src/Feed.php on line 142', source: 'plugins/arcade-odds/src/Feed.php:142' },
  { time: ago(9), level: 'deprecated', message: 'Function get_page_by_title is deprecated since version 6.2.0! Use WP_Query instead.' },
  { time: ago(14), level: 'fatal', message: "Uncaught Error: Call to undefined function arcade_bonus_locale() in /var/www/local.arcade.example/wp-content/themes/arcade/inc/bonus.php:88", source: 'themes/arcade/inc/bonus.php:88' },
  { time: ago(22), level: 'notice', message: 'Function _load_textdomain_just_in_time was called incorrectly. Translation loading for the arcade domain was triggered too early.' },
  { time: ago(31), level: 'error', message: 'WordPress database error Table arcadebetmsdb.wp_3_odds_cache doesn\'t exist for query SELECT * FROM wp_3_odds_cache WHERE expires > 1793091000' },
  { time: ago(47), level: 'fatal', message: 'Allowed memory size of 268435456 bytes exhausted (tried to allocate 20480 bytes) in /var/www/wp-cores/6.8.3/wp-includes/class-wpdb.php on line 2351' },
  { time: ago(58), level: 'info', message: 'Cron reschedule event error for hook: arcade_odds_refresh, Error code: invalid_schedule' },
];

export const runs: RunSummary[] = [
  { id: 41, action: 'cache.clear', title: 'Clear cache', target: 'local.spellbook.example', ok: true, startedAt: ago(12), durationMs: 2_100 },
  { id: 40, action: 'site.create', title: 'Create site', target: 'local.wandworks.test', ok: true, skipped: 1, startedAt: ago(60 * 5), durationMs: 184_000 },
  { id: 39, action: 'hosts.add', title: 'Add hosts entry', target: 'local.dailypost.example', ok: false, startedAt: ago(60 * 6), durationMs: 300 },
  { id: 38, action: 'core.switch', title: 'Switch WordPress core', target: 'local.newsnow.example', ok: true, startedAt: ago(60 * 26), durationMs: 4_800 },
  { id: 37, action: 'debug.toggle', title: 'Turn on WP_DEBUG', target: 'local.arcade.example', ok: true, startedAt: ago(60 * 27), durationMs: 900 },
  { id: 36, action: 'db.import', title: 'Import a database dump', target: 'local.newsnow.example', ok: false, interrupted: true, startedAt: ago(60 * 30), durationMs: 95_000 },
  // Older runs, for the second page of Run history.
  ...Array.from({ length: 60 }, (_, i): RunSummary => ({ id: 35 - i, action: 'site.clearCache', title: 'Clear cache', target: 'local.spellbook.example', ok: true, startedAt: ago(60 * 31 + i * 45), durationMs: 1_800 })),
];

export const coreVersions = ['7.1.3', '7.0.4', '6.8.3'];

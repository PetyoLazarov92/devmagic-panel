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
    domain: 'local.northwind.com',
    title: 'Northwind',
    aliases: ['local.northwind.de', 'local.northwind.fr', 'local.northwind.es', 'local.northwind.pt', 'local.northwind.co.jp'],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.northwind.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-05-23T00:00:10Z', names: ['local.northwind.com', 'local.northwind.de', 'local.northwind.fr', 'local.northwind.es', 'local.northwind.pt', 'local.northwind.co.jp'], issuer: 'legacy' },
    git: { remote: 'git@github.com:AcmeCo/marketing-northwind.git', branch: 'feature/translation-export', upstream: 'origin/feature/translation-export', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '03df05b55', subject: "Fix: skip video embeds on import", author: 'Alex Morgan', date: '2026-10-21T16:46:46+08:00' } },
    db: { name: 'northwinddb', sizeBytes: 1_480_000_000, tables: 214 },
    debug: { enabled: true, logBytes: 182_000, constants: DEBUG_LOG_ONLY },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    // As on many sites: BE Media from Production in the repo, its URL in wp-config.php.
    uploadsFrom: { host: 'www.northwind.com', via: 'plugin' },
    mediaPlugin: { active: true, host: 'www.northwind.com' },
    prodUrl: 'https://www.northwind.com',
    health: 'warn',
    issues: [{ id: 'cert.legacy', status: 'warn', text: 'Cert still signed by the old LocalhostCA', fix: { action: 'cert.reissue', input: { domain: 'local.northwind.com' }, label: 'Reissue cert' } }],
  },
  // Northwind Learn: its own WordPress install under /learn, served by the Northwind vhost.
  {
    domain: 'local.northwind.com',
    path: '/learn',
    title: 'Northwind Learn',
    aliases: [],
    vhostManaged: false,
    removable: false, panelMade: false,
    docroot: '/var/www/local.learn.northwind.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    git: { remote: 'git@github.com:AcmeCo/learn-northwind.git', branch: 'bugfix/editor-heading-spacing', upstream: 'origin/bugfix/editor-heading-spacing', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '50e828431', subject: "Remove the extra heading margin in the editor (#88)", author: 'Alex Morgan', date: '2026-10-19T19:49:32+08:00' } },
    db: { name: 'northwindlearndb', sizeBytes: 640_000_000, tables: 98 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: false, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS], uploadsFrom: 'www.northwind.com' },
    uploadsFrom: { host: 'www.northwind.com', via: 'local-mode' },
    health: 'warn',
    issues: [{ id: 'local.outdated', status: 'warn', text: 'The Local mode plugin is an older version', fix: { action: 'site.setLocalMode', input: { domain: 'local.northwind.com', path: '/learn', enabled: true }, label: 'Update it' } }],
  },
  {
    domain: 'local.dailypost.com',
    title: 'Daily Post',
    aliases: [
      'local.deals.dailypost.com', 'local.dailypost.co.uk', 'local.dailypost.fr', 'local.dailypost.es',
      'local.dailypost.de', 'local.dailypost.it', 'local.dailypost.com.br', 'local.dailylists.com',
      'local.dailycats.com', 'local.dailyleaks.com', 'local.kids.dailymedia.com', 'local.dailyshopping.com',
      'local.dailytoday.com', 'local.dailycute.com',
    ],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.dailypost.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-12-15T12:06:55Z', names: ['local.dailypost.com', 'local.deals.dailypost.com'], issuer: 'legacy' },
    notInHosts: ['local.dailytoday.com', 'local.dailycute.com'],
    git: { remote: 'git@github.com:DailyMedia/dailypost.git', branch: 'bugfix/newsletter-invalid-url', upstream: null, dirty: 2, ahead: 0, behind: 0, lastCommit: { hash: 'f430d728c', subject: "Merge pull request #239 from DailyMedia/feature/plugin-updates", author: 'Sam Lee', date: '2026-10-19T14:18:40+03:00' } },
    db: { name: 'dailypostdb', sizeBytes: 3_900_000_000, tables: 61 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: false, current: true, blockedHosts: [] },
    prodUrl: 'https://dailypost.com',
    health: 'warn',
    issues: [
      { id: 'cert.uncovered', status: 'warn', text: 'www.local.dailypost.com is not covered by the cert', fix: { action: 'cert.reissue', input: { domain: 'local.dailypost.com' }, label: 'Reissue cert' } },
      {
        id: 'hosts.missing',
        status: 'warn',
        text: 'local.dailytoday.com, local.dailycute.com are missing from /etc/hosts',
        fix: { action: 'hosts.add', input: { domain: 'local.dailypost.com', aliases: [] }, label: 'Add to hosts' },
      },
      {
        id: 'vhost.portDrift',
        status: 'warn',
        text: 'Port 80 and 443 names differ: local.dailywishlist.com only on port 80 (no HTTPS)',
        hint: 'The panel leaves this vhost as is: list the same names in both blocks of /etc/apache2/sites-available/local.dailypost.com-ssl.conf, then reissue the cert.',
      },
      { id: 'local.off', status: 'warn', text: 'Local mode is off: this copy can email real people and call live mail APIs', fix: { action: 'site.setLocalMode', input: { domain: 'local.dailypost.com', enabled: true }, label: 'Turn on Local mode' } },
    ],
  },
  {
    domain: 'local.biketours.com',
    title: 'Bike Tours',
    aliases: [],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.biketours.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:42Z', names: ['local.biketours.com'], issuer: 'legacy' },
    git: { remote: 'git@github.com:AcmeCo/Bike-Tours.git', branch: 'master', upstream: 'origin/master', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: 'a407e4865', subject: "Listing filters: stop facet links from 404ing on archives (#950)", author: 'jordan-k', date: '2026-10-22T16:28:28-05:00' } },
    db: { name: 'biketoursdb', sizeBytes: 920_000_000, tables: 148 },
    debug: { enabled: true, logBytes: 4_200, constants: DEBUG_LOG_ONLY },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    prodUrl: 'https://biketours.com',
    health: 'ok',
    issues: [],
  },
  {
    domain: 'local.crmblog.com',
    title: 'CRM Blog',
    aliases: [],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.crmblog.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:18Z', names: ['local.crmblog.com'], issuer: 'legacy' },
    git: { remote: 'git@github.com:AcmeCo/CRM-Blog.git', branch: 'demo/resource-layout', upstream: 'origin/demo/resource-layout', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '4bd2eae91', subject: "Merge branch 'feature/resource-layout' into demo/resource-layout", author: 'Riley Chen', date: '2026-10-08T16:32:47+03:00' } },
    db: { name: 'crmblogdb', sizeBytes: 640_000_000, tables: 97 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'ok',
    issues: [],
  },
  {
    domain: 'local.acme-brands.com',
    title: 'Acme Brands',
    aliases: ['local.acme-outlet.com'],
    vhostManaged: true,
    removable: true, panelMade: true,
    docroot: '/var/www/local.acme-brands.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    // Domains mapped to each site, with SUBDOMAIN_INSTALL off: a subdomain network whose new sites go under paths.
    network: {
      mode: 'subdirectory',
      type: 'subdomain',
      sites: [
        { id: 1, url: 'https://local.acme-brands.com/', title: 'Acme Brands' },
        { id: 2, url: 'https://local.acme-outlet.com/', title: 'Acme Outlet' },
        { id: 3, url: 'https://local.acme-repairs.com/', title: 'Acme Repairs', served: false },
      ],
    },
    cert: { expiresAt: '2028-03-02T09:00:00Z', names: ['local.acme-brands.com', 'local.acme-outlet.com'], issuer: 'new' },
    db: { name: 'acme_brands_com', sizeBytes: 220_000_000, tables: 61 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'warn',
    issues: [
      { id: 'network.unserved', status: 'warn', text: 'local.acme-repairs.com is a site of the network this site does not serve here', fix: { action: 'site.addAliases', input: { domain: 'local.acme-brands.com', aliases: ['local.acme-repairs.com'] }, label: 'Add as an alias' } },
    ],
  },
  {
    domain: 'local.arcade.bet',
    title: 'Arcade.bet',
    aliases: [],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.arcade.bet',
    core: { kind: 'standalone', version: '6.8.3' },
    network: {
      mode: 'subdirectory',
      type: 'subdirectory',
      sites: [
        { id: 1, url: 'https://local.arcade.bet/', title: 'Arcade.bet' },
        { id: 2, url: 'https://local.arcade.bet/de/', title: 'Arcade.bet Deutschland' },
        { id: 3, url: 'https://local.arcade.bet/es/', title: 'Arcade.bet España' },
        { id: 4, url: 'https://local.arcade.bet/pt-br/', title: 'Arcade.bet Brasil' },
        { id: 5, url: 'https://local.arcade.bet/fr/', title: 'Arcade.bet France', archived: true },
        { id: 6, url: 'https://local.arcade.bet/staging/', title: 'Arcade.bet Staging', hidden: true },
        { id: 8, url: 'https://local.arcade.bet/promo/', title: 'Arcade.bet Promo', archived: true, spam: true },
      ],
      deleted: [{ id: 7, url: 'https://local.arcade.bet/it/' }],
    },
    cert: { expiresAt: '2028-01-16T05:26:21Z', names: ['local.arcade.bet'], issuer: 'legacy' },
    git: { remote: 'git@github.com:AcmeCo/ArcadeBet.git', branch: 'master', upstream: 'origin/master', dirty: 0, ahead: 0, behind: 0, lastCommit: { hash: '5a14c83', subject: "Prize wheel: add an option to turn a prize off (#30)", author: 'Riley Chen', date: '2025-06-03T16:36:17+03:00' } },
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
    domain: 'local.newsnow.com',
    title: 'News Now',
    aliases: [],
    vhostManaged: false,
    removable: true, panelMade: false,
    docroot: '/var/www/local.newsnow.com',
    core: { kind: 'wpcore', version: '7.1.3' },
    cert: { expiresAt: '2028-01-16T05:27:01Z', names: ['local.newsnow.com'], issuer: 'legacy' },
    git: { remote: 'git@github.com:AcmeCo/NewsNow.git', branch: 'master', upstream: 'origin/master', dirty: 1, ahead: 0, behind: 0, lastCommit: { hash: '7e967209', subject: "Homepage: show a loading state while more articles load (#32)", author: 'Riley Chen', date: '2026-10-19T16:23:50+03:00' } },
    db: { name: 'newsnowdb', sizeBytes: 120_000_000, tables: 38 },
    debug: { enabled: false, logBytes: 0, constants: DEBUG_OFF },
    localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
    health: 'ok',
    issues: [],
  },
];

// A site the panel created: the only kind it can remove.
sites.push({
  domain: 'local.acme.test',
  title: 'Acme test shop',
  aliases: [],
  vhostManaged: true,
  removable: true, panelMade: true,
  docroot: '/var/www/local.acme.test',
  core: { kind: 'wpcore', version: '7.1.3' },
  cert: { expiresAt: '2029-01-26T09:00:00Z', names: ['local.acme.test'], issuer: 'new' },
  db: { name: 'acme_test', sizeBytes: 4_200_000, tables: 12 },
  debug: { enabled: true, logBytes: 0, constants: DEBUG_LOG_ONLY },
  localMode: { enabled: true, current: true, blockedHosts: [...LOCAL_MODE_DEFAULT_BLOCKED_HOSTS] },
  health: 'ok',
  issues: [],
});

// How the sample sites came here; the others were made by hand.
const installs: Record<string, Site['install']> = {
  'local.acme.test': {
    how: 'organization', org: 'acme', repo: 'git@github.com:acme/test-shop.git', at: '2026-10-22T10:00:00Z',
    skipped: [{ label: 'Run the build', todo: 'The build did not run, so built theme or plugin files may be missing. Run it in a terminal: cd /var/www/local.acme.test/wp-content/themes/shop && npm install && npm run build' }],
  },
  'local.biketours.com': { how: 'repo', repo: 'git@github.com:AcmeCo/Bike-Tours.git', at: '2026-10-24T17:20:00Z' },
  'local.newsnow.com': { how: 'restore', at: '2026-10-21T08:30:00Z', archivedAt: '2026-10-19T16:05:00Z' },
};
for (const site of sites) site.install = (!site.path && installs[site.domain]) || { how: site.panelMade ? 'panel' : 'hand' };

export const debugLog: LogLine[] = [
  { time: ago(2), level: 'fatal', message: "Uncaught Error: Call to undefined function arcade_bonus_locale() in /var/www/local.arcade.bet/wp-content/themes/arcade/inc/bonus.php:88", source: 'themes/arcade/inc/bonus.php:88' },
  { time: ago(3), level: 'warning', message: 'Undefined array key "currency" in /var/www/local.arcade.bet/wp-content/plugins/arcade-odds/src/Feed.php on line 142', source: 'plugins/arcade-odds/src/Feed.php:142' },
  { time: ago(9), level: 'deprecated', message: 'Function get_page_by_title is deprecated since version 6.2.0! Use WP_Query instead.' },
  { time: ago(14), level: 'fatal', message: "Uncaught Error: Call to undefined function arcade_bonus_locale() in /var/www/local.arcade.bet/wp-content/themes/arcade/inc/bonus.php:88", source: 'themes/arcade/inc/bonus.php:88' },
  { time: ago(22), level: 'notice', message: 'Function _load_textdomain_just_in_time was called incorrectly. Translation loading for the arcade domain was triggered too early.' },
  { time: ago(31), level: 'error', message: 'WordPress database error Table arcadebetmsdb.wp_3_odds_cache doesn\'t exist for query SELECT * FROM wp_3_odds_cache WHERE expires > 1793091000' },
  { time: ago(47), level: 'fatal', message: 'Allowed memory size of 268435456 bytes exhausted (tried to allocate 20480 bytes) in /var/www/wp-cores/6.8.3/wp-includes/class-wpdb.php on line 2351' },
  { time: ago(58), level: 'info', message: 'Cron reschedule event error for hook: arcade_odds_refresh, Error code: invalid_schedule' },
];

export const runs: RunSummary[] = [
  { id: 41, action: 'cache.clear', title: 'Clear cache', target: 'local.northwind.com', ok: true, startedAt: ago(12), durationMs: 2_100 },
  { id: 40, action: 'site.create', title: 'Create site', target: 'local.acme.test', ok: true, skipped: 1, startedAt: ago(60 * 5), durationMs: 184_000 },
  { id: 39, action: 'hosts.add', title: 'Add hosts entry', target: 'local.dailypost.com', ok: false, startedAt: ago(60 * 6), durationMs: 300 },
  { id: 38, action: 'core.switch', title: 'Switch WordPress core', target: 'local.newsnow.com', ok: true, startedAt: ago(60 * 26), durationMs: 4_800 },
  { id: 37, action: 'debug.toggle', title: 'Turn on WP_DEBUG', target: 'local.arcade.bet', ok: true, startedAt: ago(60 * 27), durationMs: 900 },
  { id: 36, action: 'db.import', title: 'Import a database dump', target: 'local.newsnow.com', ok: false, interrupted: true, startedAt: ago(60 * 30), durationMs: 95_000 },
  // Older runs, for the second page of Run history.
  ...Array.from({ length: 60 }, (_, i): RunSummary => ({ id: 35 - i, action: 'site.clearCache', title: 'Clear cache', target: 'local.northwind.com', ok: true, startedAt: ago(60 * 31 + i * 45), durationMs: 1_800 })),
];

export const coreVersions = ['7.1.3', '7.0.4', '6.8.3'];

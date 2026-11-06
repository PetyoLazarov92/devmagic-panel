import type { AccessReport, ActionRunResult, ApacheReport, NginxReport, MysqlBackup, MysqlReport, AssistantSettings, AuraItem, AuraReport, Briefing, ChatReply, CleanCopyInfo, CleanPreview, CoresReport, EnvironmentReport, FolderEntry, GitDetails, GitPullRequest, InstallDraft, JobView, KeptDatabaseInfo, MailSummary, NetworkAdmins, LocalConstant, OrgRepo, OrgSettings, Preferences, SiteConstant, SiteSalts, QueuedProposal, RepoBuild, RepoFacts, RepoInspection, RunStep, ServicesReport, Site, SitePlugin, SnapshotInfo, TrashEntry, UpdateStatus, UploadResult, WizardSuggestion } from '@devmagic-panel/shared';
import { accessKey, actions, apacheModuleLock, DEFAULT_CLAUDE_STEPS, isActionId, isLocalName, localDomainFor, LEGACY_SALT_KEYS, readKey, WP_SALT_KEYS } from '@devmagic-panel/shared';
import { previewSteps } from '@/lib/plan';
import type { Api } from '@/lib/api';
import { coreVersions, debugLog, runs, sites } from './fixtures';
import { mockDbCell, mockDbOverview, mockDbRows, mockDbStructure } from './db-browser';
import { mockCron, mockCronAction, mockCronRun, mockCronRunNow, mockCronRuns, mockWpCron } from './cron';
import { mockFpmFindings, mockIniChanges, mockPhpInfo, mockPhpIni, mockPhpReport, mockPhpSettings, mockPhpVersions, mockPhpJob, mockPhpMode, mockPhpPackages, mockCheckCompat, mockCheckCompatAll, mockDeleteCompat, mockSetSitePhp, mockVersionCompat, mockSiteCompat, mockSitePhp, mockSitePhpInfo, mockSitePools } from './php';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for actions that are not wired yet; does nothing on the system. */
export const mockDelay = () => wait(700);

const environment: EnvironmentReport = {
  checkedAt: new Date().toISOString(),
  durationMs: 2300,
  checks: [
    {
      id: 'panel.autostart', group: 'panel', label: 'Starts again after a restart', status: 'warn',
      detail: 'your home folder is encrypted (eCryptfs), so systemd cannot start the panel or Mailpit at boot or login: after a restart https://local.devmagic shows Service Unavailable until you start them',
      fixes: [{ action: 'panel.autostart', input: {}, label: 'Start them after login' }],
    },
    { id: 'apache.running', group: 'apache', label: 'Apache is running', status: 'ok', detail: 'apache2 service is active' },
    { id: 'apache.modules', group: 'apache', label: 'Apache modules', status: 'ok', detail: 'ssl, rewrite, headers, proxy, proxy_http, proxy_wstunnel' },
    { id: 'ca.exists', group: 'certificates', label: 'Local CA', status: 'ok', detail: '/etc/ssl/localcerts/devmagic-panel-ca/ca.pem' },
    {
      id: 'ca.legacy', group: 'certificates', label: 'Old LocalhostCA', status: 'warn', detail: 'still trusted by the system',
      fixes: [{ action: 'ca.untrustLegacy', input: {}, label: 'Remove old CA', confirm: 'Open every site first and check it loads without a certificate warning.' }],
    },
    {
      id: 'hosts.local.dailypost.com', group: 'hosts', label: 'local.dailypost.com', status: 'fail',
      detail: 'not in hosts: www.local.dailypost.com, local.dailywishlist.com',
      fixes: [{ action: 'hosts.add', input: { domain: 'local.dailypost.com', aliases: [] }, label: 'Add to hosts' }],
    },
    { id: 'mysql.reachable', group: 'database', label: 'MySQL admin account', status: 'ok', detail: 'connected as root@localhost' },
    { id: 'php.version', group: 'php', label: 'PHP', status: 'ok', detail: '8.3.6' },
    { id: 'php.imagick', group: 'php', label: 'Imagick', status: 'ok', detail: 'installed', recommended: true },
    { id: 'tools.wpcli', group: 'tools', label: 'WP-CLI', status: 'ok', detail: 'WP-CLI 2.11.0' },
    { id: 'tools.git', group: 'tools', label: 'git', status: 'ok', detail: 'git version 2.43.0' },
    { id: 'tools.unzip', group: 'tools', label: 'unzip', status: 'ok', detail: 'UnZip 6.00' },
    {
      id: 'tools.composer', group: 'tools', label: 'Composer', status: 'warn', recommended: true,
      detail: 'not installed: repos with a composer.json need it to install their dependencies (apt install composer)',
    },
    { id: 'tools.phpmyadmin', group: 'tools', label: 'phpMyAdmin', status: 'warn', detail: 'not installed', optional: true },
    { id: 'access.github', group: 'access', label: 'GitHub over SSH', status: 'ok', detail: "Hi! You've successfully authenticated" },
  ],
};

/** Plays a run step by step, the way the real WebSocket stream will. */
async function playRun(steps: RunStep[], onUpdate: (steps: RunStep[]) => void, failAt?: string): Promise<boolean> {
  const state = steps.map((s) => ({ ...s, status: 'pending' as RunStep['status'] }));
  onUpdate(state.map((s) => ({ ...s })));
  for (const step of state) {
    step.status = 'running';
    onUpdate(state.map((s) => ({ ...s })));
    const ms = 500 + Math.round(Math.random() * 900);
    await wait(ms);
    step.durationMs = ms;
    if (step.id === failAt) {
      step.status = 'failed';
      step.output = `${step.output ?? ''}\nerror: Access denied for user 'root'@'localhost' (using password: YES)`.trim();
      onUpdate(state.map((s) => ({ ...s })));
      return false;
    }
    step.status = 'done';
    onUpdate(state.map((s) => ({ ...s })));
  }
  return true;
}

// ── mock jobs: steps advance on a timer; the first install fails at the database step ──

// ── mock plugins: one list for every site, switched in place ──
const mockPlugins: SitePlugin[] = [
  { name: 'devmagic-panel-local', title: 'devmagic-panel Local mode', status: 'must-use', version: '3' },
  { name: 'advanced-cache.php', title: 'advanced-cache.php', status: 'dropin', version: '' },
  { name: 'advanced-custom-fields-pro', title: 'Advanced Custom Fields PRO', status: 'active', version: '6.4.2', requiredBy: ['ACF Blocks for Acme'] },
  { name: 'acme-acf-blocks', title: 'ACF Blocks for Acme', status: 'active', version: '1.3.0', requires: ['advanced-custom-fields-pro'] },
  { name: 'cloudflare', title: 'Cloudflare', status: 'inactive', version: '4.14.4', update: '4.14.5', productionOnly: true },
  { name: 'wp-rocket', title: 'WP Rocket', status: 'inactive', version: '3.19.1', productionOnly: true },
  { name: 'gravityforms', title: 'Gravity Forms', status: 'active', version: '2.9.8', update: '2.9.9' },
  { name: 'query-monitor', title: 'Query Monitor', status: 'active', version: '3.17.0', localHelper: true },
  { name: 'user-switching', title: 'User Switching', status: 'inactive', version: '1.9.1', localHelper: true },
  { name: 'seo-by-rank-math', title: 'Rank Math SEO', status: 'active', version: '1.0.279', update: '1.0.280' },
  { name: 'stream', title: 'Stream', status: 'active', version: '4.1.1' },
  { name: 'wp-mail-smtp-pro', title: 'WP Mail SMTP Pro', status: 'active', version: '4.8.0' },
];

const mockJobs = new Map<string, JobView>();
// An install that finished with its build skipped, as on local.acme.test's page and run 40.
mockJobs.set('mock-done-skipped', {
  id: 'mock-done-skipped', title: 'Create site', target: 'local.acme.test', status: 'done', kind: 'site.create', runId: 40, progress: 1, undo: [], undoable: [],
  startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  steps: [
    { id: 'clone', label: 'Clone the repo', status: 'done' },
    { id: 'database', label: 'Create the database', status: 'done' },
    { id: 'build', label: 'Run the build', status: 'skipped', output: 'sh: 1: vite: not found', skippable: 'The build did not run, so built theme or plugin files may be missing.' },
    { id: 'flush', label: 'Flush caches', status: 'done' },
  ],
});
let failNextAtDb = true;
let failNextAtBuild = true;
const MOCK_SKIPPABLE: Record<string, string> = {
  build: 'The build did not run, so built theme or plugin files may be missing. Run it in a terminal: cd /var/www/local.acme.com/wp-content/themes/acme && npm install && npm run build',
  htaccess: 'The site may have no .htaccess, so pages other than the home page can answer 404: Aura offers to write it.',
  flush: "Caches and rewrite rules were not flushed: use Clear caches and Flush rewrite rules on the site's page.",
};

function advance(job: JobView, list: 'steps' | 'undo', failAt?: string, outputs: Record<string, string> = {}) {
  const steps = job[list];
  const tick = () => {
    const running = steps.find((s) => s.status === 'running');
    // Clone and import report progress in the real panel; the mockup walks them in a few ticks.
    if (running && (running.id === 'clone' || running.id === 'import') && (running.progress ?? 0) < 1) {
      running.progress = Math.min(1, (running.progress ?? 0) + 0.2);
      running.note = running.id === 'import' ? `${(running.progress * 1.4).toFixed(1)} GB of 1.4 GB, under a minute left` : `receiving objects, ${Math.round(running.progress * 100)}%`;
      job.progress = (steps.filter((s) => s.status === 'done').length + running.progress) / steps.length;
      setTimeout(tick, 600);
      return;
    }
    if (running) {
      delete running.progress;
      delete running.note;
      running.durationMs = 400 + Math.round(Math.random() * 600);
      if (running.id === failAt) {
        running.status = 'failed';
        running.output = outputs[`${running.id}-failed`] ?? (running.id === 'build' ? 'wp-content/themes/acme: Node 20.18.0 from nvm (.nvmrc asks for 20)\nnpm error code ELIFECYCLE\nnpm error command failed: webpack --mode production' : "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)");
        job.status = 'failed';
        return;
      }
      running.status = 'done';
      const output = outputs[running.id];
      if (output) running.output = output;
    }
    job.progress = steps.filter((s) => s.status === 'done').length / steps.length;
    const next = steps.find((s) => s.status === 'pending');
    if (!next) {
      job.status = list === 'undo' ? 'undone' : 'done';
      return;
    }
    next.status = 'running';
    setTimeout(tick, 500 + Math.random() * 500);
  };
  tick();
}

// An organization in the mockup: its repos, what Claude reads from one, and the dumps its links point to.
const MOCK_DUMP_UPLOAD = '00000000-0000-4000-8000-0000000000d1';
let mockOrgSettings: OrgSettings = { selected: ['acme', 'gitlab.com/acme-web', 'gitlab.com/~shared'], gitlabHosts: ['git.acme.test'], accountHosts: ['github.com', 'gitlab.com'], ...structuredClone(DEFAULT_CLAUDE_STEPS) };
// A GitLab group in the mockup, its projects in subgroups: two of one name, kept apart by their path.
const mockGitlabRepos: OrgRepo[] = [
  { org: 'gitlab.com/acme-web', name: 'site', fullName: 'acme-web/clients/site', description: 'Client site on WordPress', sshUrl: 'git@gitlab.com:acme-web/clients/site.git', url: 'https://gitlab.com/acme-web/clients/site', defaultBranch: 'main', pushedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), archived: false, kind: 'site' },
  { org: 'gitlab.com/acme-web', name: 'site', fullName: 'acme-web/internal/site', description: 'The agency site', sshUrl: 'git@gitlab.com:acme-web/internal/site.git', url: 'https://gitlab.com/acme-web/internal/site', defaultBranch: 'master', pushedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), archived: false, kind: 'wp-content' },
];
const mockOrgRepos: OrgRepo[] = [
  { org: 'acme', name: 'storefront', fullName: 'acme/storefront', description: 'The Acme store, WooCommerce', sshUrl: 'git@github.com:acme/storefront.git', url: 'https://github.com/acme/storefront', defaultBranch: 'main', pushedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), archived: false, kind: 'site' },
  { org: 'acme', name: 'test-shop', fullName: 'acme/test-shop', description: 'Staging copy of the shop', sshUrl: 'git@github.com:acme/test-shop.git', url: 'https://github.com/acme/test-shop', defaultBranch: 'main', pushedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), archived: false, kind: 'site', local: { installed: [{ domain: 'local.acme.test', how: 'organization' }] } },
  { org: 'acme', name: 'old-campaign', fullName: 'acme/old-campaign', sshUrl: 'git@github.com:acme/old-campaign.git', url: 'https://github.com/acme/old-campaign', defaultBranch: 'master', pushedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), archived: false, kind: 'site', local: { archived: { count: 1, latest: new Date(Date.now() - 86_400_000).toISOString() } } },
  { org: 'acme', name: 'brand-theme', fullName: 'acme/brand-theme', description: 'Shared theme', sshUrl: 'git@github.com:acme/brand-theme.git', url: 'https://github.com/acme/brand-theme', defaultBranch: 'main', pushedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(), archived: false, kind: 'theme' },
  { org: 'acme', name: 'design-tokens', fullName: 'acme/design-tokens', sshUrl: 'git@github.com:acme/design-tokens.git', url: 'https://github.com/acme/design-tokens', defaultBranch: 'main', pushedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), archived: false, kind: 'other' },
];
let mockOrgScan = { checkedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), listedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
const mockFacts: RepoFacts = {
  productionUrl: 'https://www.acme-store.com', docsLocalSetup: 'Lando',
  wordpressVersion: '6.8.3', phpVersion: '8.2', branch: 'develop', composer: true, npm: true, buildCommands: [{ folder: 'wp-content/themes/acme', command: 'npm run prod' }, { folder: 'wp-content/plugins/acme-slider', command: 'npm run prod-bundle' }],
  asanaLinks: ['https://app.asana.com/0/120000/130000'], googleLinks: ['https://drive.google.com/drive/folders/1AcmeDumpsFolder01', 'https://docs.google.com/document/d/1AcmeSetupDoc0001/edit'],
  dumpHints: ['Weekly dumps are in the Drive folder linked from the Local setup task'], notes: ['WooCommerce with Stripe in test mode for staging'],
  sources: [{ field: 'productionUrl', file: 'README.md' }, { field: 'docsLocalSetup', file: '.lando.yml' }, { field: 'asanaLinks', file: 'docs/local.md' }, { field: 'buildCommands', file: 'README.md' }],
};

/** What the mockup reads from a dump you pick: the file name picks which. */
async function mockUpload(file: File, onProgress: (fraction: number) => void): Promise<UploadResult> {
  for (let i = 1; i <= 10; i++) {
    await wait(80);
    onProgress(i / 10);
  }
  const id = '00000000-0000-4000-8000-000000000001';
  // Enough plugins for the WordPress step's plugin search to show.
  const plugins = ['advanced-custom-fields-pro', 'wordfence', 'wp-rocket', 'yoast-seo', 'gravityforms', 'wp-mail-smtp', 'akismet', 'classic-editor', 'contact-form-7', 'duplicate-post', 'mailchimp-for-wp', 'redirection', 'regenerate-thumbnails', 'safe-svg', 'wp-mail-logging', 'user-switching'];
  const suggest = (hosts: string[]) => hosts.map((from) => ({ from, to: isLocalName(from) ? from : localDomainFor(from) }));
  // The file name picks the mockup's dump: a local network under paths, a Daily Post network, a copy already on local names, or Northwind from production.
  if (/paths/i.test(file.name)) {
    const hosts = ['local.acme-group.com'];
    const sites = [
      { id: 1, domain: 'local.acme-group.com', path: '/', name: 'Acme Group Network' },
      { id: 3, domain: 'local.acme-group.com', path: '/acme-repairs/', name: 'Acme Repairs' },
      { id: 4, domain: 'local.acme-group.com', path: '/flood-help/', name: 'Flood Help' },
      { id: 10, domain: 'local.acme-group.com', path: '/north-cleanup/', name: 'North Cleanup & Dry' },
      { id: 12, domain: 'local.acme-group.com', path: '/first-call/', name: '1st Call Restoration' },
    ];
    return { id, name: file.name, size: file.size, facts: { tablePrefix: 'wp_', siteUrl: 'https://local.acme-group.com', home: 'https://local.acme-group.com', dbVersion: 61833, multisite: true, subdomainInstall: false, networkPath: '/', sites, hosts, activePlugins: plugins, partial: false, httpHosts: [], admins: ['admin'], superAdmins: ['admin'] }, suggestions: { replace: suggest(hosts) } };
  }
  if (/dailypost|network/i.test(file.name)) {
    const hosts = ['dailypost.com', 'www.dailypost.com', 'deals.dailypost.com', 'dailypost.com.br', 'dailylists.com', 'dailycats.com'];
    const sites = [
      { id: 1, domain: 'dailypost.com', path: '/', name: 'Daily Post' }, { id: 2, domain: 'dailypost.com', path: '/stories/', name: 'Daily Post Stories' }, { id: 3, domain: 'dailylists.com', path: '/', name: 'Daily Lists' },
      { id: 4, domain: 'dailypost.com', path: '/ca/', name: 'Daily Post Canada' }, { id: 5, domain: 'dailycats.com', path: '/', name: 'Daily Cats' }, { id: 6, domain: 'deals.dailypost.com', path: '/', name: 'Daily Deals' }, { id: 7, domain: 'dailypost.com.br', path: '/', name: 'Daily Post Brasil' },
    ];
    return { id, name: file.name, size: file.size, facts: { tablePrefix: 'wp_', siteUrl: 'https://dailypost.com', home: 'https://dailypost.com', dbVersion: 61833, multisite: true, subdomainInstall: false, sites, hosts, activePlugins: plugins, partial: false, httpHosts: ['dailycats.com'], admins: ['admin'], superAdmins: ['admin', 'netadmin'] }, suggestions: { replace: suggest(hosts) } };
  }
  if (/local/i.test(file.name)) {
    const hosts = ['local.northwind.com'];
    return { id, name: file.name, size: file.size, facts: { tablePrefix: 'wp_', siteUrl: 'http://local.northwind.com', home: 'http://local.northwind.com', dbVersion: 61833, multisite: false, hosts, activePlugins: [...plugins, 'query-monitor'], partial: false, httpHosts: ['local.northwind.com'], admins: [] }, suggestions: { replace: suggest(hosts) } };
  }
  const hosts = ['www.northwind.com', 'www.northwind.de', 'www.northwind.fr'];
  // The tables a production shop dump makes, for what a clean copy finds in it.
  const tableHosts = Object.fromEntries(
    ['wp_options', 'wp_posts', 'wp_postmeta', 'wp_users', 'wp_usermeta', 'wp_comments', 'wp_wc_orders', 'wp_wc_orders_meta', 'wp_woocommerce_order_items', 'wp_woocommerce_sessions', 'wp_gf_entry', 'wp_gf_entry_meta', 'wp_actionscheduler_logs', 'wp_wfHits', 'wp_redirection_404'].map((t) => [t, ['www.northwind.com']]),
  );
  return { id, name: file.name, size: file.size, facts: { tablePrefix: 'wp_', siteUrl: 'https://www.northwind.com', home: 'https://www.northwind.com', dbVersion: 61833, multisite: false, hosts, activePlugins: plugins, partial: false, httpHosts: [], tableHosts, storedObjects: false, admins: ['admin', 'northwindadmin'] }, suggestions: { replace: suggest(hosts) } };
}

/** The store dump an organization's links find in the mockup. */
async function mockStoreUpload(id: string): Promise<UploadResult> {
  await wait(150);
  return {
    id, name: 'acme-store-2026-10-24.sql.gz', size: 432_000_000,
    facts: { tablePrefix: 'wp_', siteUrl: 'https://www.acme-store.com', home: 'https://www.acme-store.com', dbVersion: 58975, multisite: false, hosts: ['www.acme-store.com', 'acme-store.de'], activePlugins: ['woocommerce', 'woocommerce-gateway-stripe', 'wp-rocket'], partial: false, admins: ['admin', 'acmeshop'] },
    suggestions: { replace: [{ from: 'www.acme-store.com', to: 'local.acme-store.com' }, { from: 'acme-store.de', to: 'local.acme-store.de' }] },
  };
}

const mockUploads = new Map<string, UploadResult>();

const mockAccess: AccessReport = {
  links: [
    { url: 'https://app.asana.com/0/120000/130000', status: 'ok', title: 'Local setup for the store' },
    { url: 'https://drive.google.com/drive/folders/1AcmeDumpsFolder01', status: 'ok', title: 'Store database dumps' },
    { url: 'https://docs.google.com/document/d/1AcmeSetupDoc0001/edit', status: 'no-access', title: null },
  ],
  facts: [{ text: 'Uploads are served from www.acme-store.com', source: 'Asana task Local setup for the store' }, { text: 'Deactivate the payment gateway plugin locally', source: 'Asana task comment' }],
  dumps: [
    { fileId: '1AcmeDump20261024x', name: 'acme-store-2026-10-24.sql.gz', sizeBytes: 432_000_000, modifiedAt: '2026-10-24T03:00:00Z', foundIn: 'Store database dumps folder' },
    { fileId: '1AcmeDump20261017x', name: 'acme-store-2026-10-17.sql.gz', sizeBytes: 428_000_000, modifiedAt: '2026-10-17T03:00:00Z', foundIn: 'Store database dumps folder' },
  ],
};

// Two unfinished installs in the mockup: one two hours old, one from last night.
const mockDrafts = new Map<string, InstallDraft>([
  [
    'd1e2f3a4-0000-4000-8000-000000000002',
    {
      id: 'd1e2f3a4-0000-4000-8000-000000000002', kind: 'manual', title: 'local.northwind.test', step: 'wordpress',
      state: { source: 'wordpress', domains: [{ prod: '', local: 'local.northwind.test' }] },
      uploads: [], status: 'open', createdAt: new Date(Date.now() - 16 * 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 15 * 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 9 * 3_600_000).toISOString(),
    },
  ],
  [
    'd1e2f3a4-0000-4000-8000-000000000001',
    {
      id: 'd1e2f3a4-0000-4000-8000-000000000001', kind: 'manual', title: 'local.shop.com', step: 'domains',
      state: { source: 'repo', repoUrl: 'git@github.com:acme/shop.git', branch: 'main', domains: [{ prod: 'www.shop.com', local: 'local.shop.com' }] },
      uploads: [], status: 'open', createdAt: new Date(Date.now() - 2.2 * 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 22 * 3_600_000).toISOString(),
    },
  ],
]);

// The archive in the mockup: a site removed yesterday, one about to be purged, and two copies of a site that is installed again.
const mockTrash: TrashEntry[] = [
  { id: 'local.old-campaign.test-20261023-101500', domain: 'local.old-campaign.test', deletedAt: new Date(Date.now() - 86_400_000).toISOString(), purgeAt: new Date(Date.now() + 13 * 86_400_000).toISOString(), sizeBytes: 640_000_000, panelMade: true, dbName: 'old_campaign_test', reason: 'deleted', hasDump: true, install: { how: 'repo', at: '2026-10-02T09:00:00Z', repo: 'git@github.com:acme/old-campaign.git' } },
  { id: 'local.biketours.com-20261024-171200', domain: 'local.biketours.com', deletedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), purgeAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), sizeBytes: 920_000_000, panelMade: false, dbName: 'biketoursdb', reason: 'reinstall', hasDump: true, replaces: { refusal: null } },
  { id: 'local.biketours.com-20261020-110000', domain: 'local.biketours.com', deletedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), purgeAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), sizeBytes: 900_000_000, panelMade: false, dbName: 'biketoursdb', reason: 'restore', hasDump: true, replaces: { refusal: null } },
  { id: 'local.newsnow-legacy.com-20261011-090000', domain: 'local.newsnow-legacy.com', deletedAt: new Date(Date.now() - 13 * 86_400_000).toISOString(), purgeAt: new Date(Date.now() + 86_400_000).toISOString(), sizeBytes: 1_100_000_000, panelMade: false, dbName: 'newsnowdb_old', reason: 'deleted', hasDump: true },
];

// Mailpit starts stopped in the mockup; installing it there "starts" it and the sample mail appears.
let mockNginxSetUp = false;
let mailpitRunning = false;
/** The user step's label for a clean-up, from the user it keeps or makes. */
const mockUserLabel = (input: Record<string, unknown>) => {
  const user = (input.user ?? {}) as { keep?: string; login?: string };
  return user.keep ? `Keep ${user.keep} as the only user, the author of every post` : `Make ${user.login ?? 'admin'} the only user, the author of every post`;
};
const mockMail: Array<MailSummary & { text: string; html: string }> = [
  { id: 'm1', from: 'BikeTours <bookings@local.biketours.com>', to: ['anna@example.com'], subject: 'Your booking: Mountain Lakes Tour, July 2027', date: new Date(Date.now() - 4 * 60_000).toISOString(), snippet: 'Thanks for booking with Bike Tours. Your guides will contact you...', site: 'local.biketours.com', read: false, text: 'Thanks for booking with Bike Tours.', html: '<h2 style="font-family:sans-serif">Thanks for booking!</h2><p style="font-family:sans-serif">Your guides will contact you two weeks before the trip.</p>' },
  { id: 'm2', from: 'WordPress <wordpress@local.northwind.com>', to: ['acmeco@local.test'], subject: '[Northwind] Password Reset', date: new Date(Date.now() - 50 * 60_000).toISOString(), snippet: 'Someone has requested a password reset for the following account...', site: 'local.northwind.com', read: true, text: 'Someone has requested a password reset for the following account:\n\nSite Name: Northwind\n\nUsername: acmeco\n\nIf this was a mistake, ignore this email and nothing will happen.\n\nTo reset your password, visit the following address:\n\nhttps://local.northwind.com/wp-login.php?action=rp&key=mockkey&login=acmeco&wp_lang=en_US\n', html: '' },
  { id: 'm3', from: 'Gravity Forms <noreply@local.crmblog.com>', to: ['editors@crmblog.com'], subject: 'New submission: Newsletter signup', date: new Date(Date.now() - 3 * 3600_000).toISOString(), snippet: 'Email: test@example.com', site: 'local.crmblog.com', read: true, text: 'Email: test@example.com', html: '<p>Email: <b>test@example.com</b></p>' },
];

const snapshots = new Map<string, SnapshotInfo[]>([
  [
    'local.dailypost.com',
    [
      { name: '20261023-174210-before-import.sql.gz', label: 'before-import', sizeBytes: 412_000_000, createdAt: '2026-10-23T17:42:10Z' },
      { name: '20261020-090500.sql.gz', sizeBytes: 405_300_000, createdAt: '2026-10-20T09:05:00Z' },
    ],
  ],
]);

const cleanCopies = new Map<string, CleanCopyInfo[]>([
  [
    'local.northwind.com',
    [
      {
        name: 'northwind.com-local-clean-2026.10.27.sql.gz', sizeBytes: 96_400_000, createdAt: '2026-10-27T16:20:00Z',
        leftoverEmails: { total: 214, tables: [{ table: 'wp_postmeta', count: 201, samples: ['j***@customer.net', 'm***@gmail.com', 'a***@northwind-partner.de'] }, { table: 'wp_acme_leads', count: 13, samples: ['s***@outlook.com'] }] },
      },
      { name: 'northwind.com-local-clean-2026.10.20.sql.gz', sizeBytes: 94_100_000, createdAt: '2026-10-20T11:02:00Z', leftoverEmails: { total: 0, tables: [] } },
    ],
  ],
]);

const keptDatabases = new Map<string, KeptDatabaseInfo[]>([
  ['local.northwind.com', [{ name: 'northwind_com__keep261024101500', reason: 'before northwind-prod.sql.gz from production', createdAt: '2026-10-24T10:15:00Z', purgeAt: '2026-10-31T10:15:00Z', sizeBytes: 1_840_000_000 }]],
]);

const stamp = (at: Date) => at.toISOString().replace(/\D/g, '').slice(2, 14);
const dayOf = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** Database actions run as jobs in the mockup too, with plausible steps and output. */
/** The MySQL server of the mockup: the sites' databases and users, one left behind, one of another project. */
const mockMysqlExtra = {
  databases: [
    { name: 'oldclient_com', sizeBytes: 342_000_000, tables: 58, kind: 'unused' as const },
    { name: 'reports', sizeBytes: 18_400_000, tables: 9, kind: 'unused' as const },
  ],
  users: [
    { user: 'oldshop_com', host: 'localhost', kind: 'leftover' as const, databases: [], missing: ['oldshop_com'], global: false },
    { user: 'reports', host: 'localhost', kind: 'other' as const, databases: ['reports'], missing: [], global: false },
  ],
};

const MOCK_BACKUPS_DIR = '/home/acmeco/.local/share/devmagic-panel/mysql-backups';
const savedAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
let mockBackups: MysqlBackup[] = [
  { name: 'oldblog_com-20261022-091500.sql.gz', kind: 'database', subject: 'oldblog_com', sizeBytes: 48_200_000, savedAt: savedAgo(7).toISOString(), purgeAt: savedAgo(-7).toISOString() },
  { name: 'users-20261027-160200.sql', kind: 'users', subject: 'oldblog_com@localhost', sizeBytes: 412, savedAt: savedAgo(2).toISOString(), purgeAt: savedAgo(-12).toISOString() },
];

/** The mockup's mods-available: what a stock Ubuntu Apache with mod_php has, and a few turned on for a WordPress machine. */
const MOCK_APACHE_ON = ['access_compat', 'alias', 'auth_basic', 'authn_core', 'authn_file', 'authz_core', 'authz_host', 'authz_user', 'autoindex', 'deflate', 'dir', 'env', 'expires', 'filter', 'headers', 'mime', 'mpm_prefork', 'negotiation', 'php8.3', 'proxy', 'proxy_http', 'proxy_wstunnel', 'reqtimeout', 'rewrite', 'setenvif', 'socache_shmcb', 'ssl', 'status'];
const MOCK_APACHE_OFF = ['actions', 'asis', 'auth_digest', 'auth_form', 'authn_anon', 'authn_dbd', 'authn_socache', 'authz_dbm', 'authz_groupfile', 'authz_owner', 'brotli', 'buffer', 'cache', 'cache_disk', 'cache_socache', 'cgi', 'charset_lite', 'data', 'dav', 'dav_fs', 'dbd', 'dump_io', 'echo', 'ext_filter', 'file_cache', 'http2', 'include', 'info', 'ldap', 'log_debug', 'log_forensic', 'lua', 'macro', 'md', 'mpm_event', 'mpm_worker', 'proxy_ajp', 'proxy_balancer', 'proxy_fcgi', 'proxy_html', 'ratelimit', 'remoteip', 'request', 'sed', 'session', 'speling', 'substitute', 'suexec', 'unique_id', 'userdir', 'usertrack', 'vhost_alias', 'xml2enc'];
const mockApacheModules = [...MOCK_APACHE_ON.map((name) => ({ name, enabled: true })), ...MOCK_APACHE_OFF.map((name) => ({ name, enabled: false }))].sort((a, b) => a.name.localeCompare(b.name));

function mockMysql(): MysqlReport {
  const siteDbs = sites.filter((s) => s.db).map((s) => ({ name: s.db?.name ?? '', sizeBytes: s.db?.sizeBytes ?? 0, tables: s.db?.tables ?? 0, kind: 'site' as const, sites: [{ domain: s.domain, ...(s.path ? { path: s.path } : {}) }] }));
  const system = ['information_schema', 'mysql', 'performance_schema', 'sys'].map((name, i) => ({ name, sizeBytes: [0, 2_600_000, 0, 16_384][i] ?? 0, tables: [79, 38, 111, 101][i] ?? 0, kind: 'system' as const }));
  const databases = [...siteDbs, ...mockMysqlExtra.databases, ...system].sort((a, b) => a.name.localeCompare(b.name));
  const siteUsers = siteDbs.map((d) => ({ user: d.name.slice(0, 32), host: 'localhost', kind: 'site' as const, databases: [d.name], missing: [], global: false, sites: d.sites }));
  const users = [
    { user: 'debian-sys-maint', host: 'localhost', kind: 'system' as const, databases: [], missing: [], global: true },
    { user: 'devmagic_panel', host: 'localhost', kind: 'panel' as const, databases: [], missing: [], global: true },
    { user: 'mysql.sys', host: 'localhost', kind: 'system' as const, databases: [], missing: [], global: false },
    { user: 'root', host: 'localhost', kind: 'system' as const, databases: [], missing: [], global: true },
    ...siteUsers,
    ...mockMysqlExtra.users,
  ].sort((a, b) => a.user.localeCompare(b.user));
  return {
    checkedAt: new Date().toISOString(),
    server: { product: 'MySQL', version: '8.0.43-0ubuntu0.24.04.1', account: 'devmagic_panel@localhost', datadir: '/var/lib/mysql/', totalBytes: databases.reduce((n, d) => n + d.sizeBytes, 0) },
    databases,
    users,
    backups: [...mockBackups].sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    backupsDir: MOCK_BACKUPS_DIR,
  };
}

/** What a MySQL job of the mockup changes once it is done, as the panel would. */
function afterMysqlJob(job: JobView, input: Record<string, unknown>) {
  if (job.status === 'running') return void window.setTimeout(() => afterMysqlJob(job, input), 500);
  if (job.status !== 'done') return;
  const saved = { savedAt: new Date().toISOString(), purgeAt: savedAgo(-14).toISOString() };
  if (job.kind === 'mysql.dropDatabase') {
    mockMysqlExtra.databases = mockMysqlExtra.databases.filter((d) => d.name !== input.database);
    mockBackups = [{ name: `${String(input.database)}-20261029-101500.sql.gz`, kind: 'database', subject: String(input.database), sizeBytes: 61_000_000, ...saved }, ...mockBackups];
  }
  if (job.kind === 'mysql.dropUsers') {
    const gone = (input.accounts as Array<{ user: string; host: string }>).map((a) => `${a.user}@${a.host}`);
    mockMysqlExtra.users = mockMysqlExtra.users.filter((u) => !gone.includes(`${u.user}@${u.host}`));
    mockBackups = [{ name: 'users-20261029-101500.sql', kind: 'users', subject: gone.join(', '), sizeBytes: 240 * gone.length, ...saved }, ...mockBackups];
  }
}

/** A network's super admins in the mockup: admin has a role on two of its sites, netadmin on all. */
const networkAdmins = new Map<string, NetworkAdmins>();
function mockNetworkAdmins(domain: string): NetworkAdmins {
  const site = sites.find((s) => s.domain === domain);
  const count = site?.network?.sites.length ?? 0;
  if (!networkAdmins.has(domain)) networkAdmins.set(domain, { sites: count, admins: [{ login: 'admin', member: Math.min(2, count) }, { login: 'netadmin', member: count }] });
  return networkAdmins.get(domain) as NetworkAdmins;
}

function mockDbJob(id: string, input: Record<string, unknown>): string {
  // A restore from Deleted sites works on the entry's domain, like the panel's lock.
  const domain = typeof input.id === 'string' && id.startsWith('trash.') ? input.id.replace(/-\d{8}-\d{6}$/, '') : String(input.domain);
  const busy = busyJob(domain);
  if (busy && domain !== 'undefined') throw new Error(`${domain} is busy: ${busy.title}. Wait until it finishes`);
  const snapshot = { id: 'snapshot', label: 'Snapshot the current database first' };
  const accounts = Array.isArray(input.accounts) ? (input.accounts as Array<{ user: string; host: string }>).map((a) => `${a.user}@${a.host}`) : [];
  const plans: Record<string, Array<{ id: string; label: string }>> = {
    ...(id === 'cron.runNow' ? { 'cron.runNow': [{ id: 'run', label: `Run ${mockCronRunNow(String(input.id))}` }] } : {}),
    'mysql.dropDatabase': [{ id: 'export', label: `Export ${String(input.database)} to the MySQL backups` }, { id: 'drop', label: `Delete database ${String(input.database)}` }],
    'mysql.dropUsers': [{ id: 'save', label: `Save ${accounts.length === 1 ? accounts[0] : `${accounts.length} accounts`} and their rights` }, { id: 'drop', label: `Delete ${accounts.join(', ')}` }],
    'mysql.optimize': [{ id: 'optimize', label: `Optimize the tables of ${String(input.database)}` }],
    'db.snapshot': [{ id: 'snapshot', label: `Snapshot the database${input.label ? ` (${String(input.label)})` : ''}` }],
    'db.restore': [snapshot, { id: 'restore', label: `Import ${String(input.snapshot)}` }, { id: 'flush', label: 'Flush caches and rewrite rules' }],
    'db.import': [{ id: 'import', label: 'Import the dump' }, { id: 'swap', label: 'Swap the imported tables in' }, { id: 'replace', label: 'Replace production domains' }, { id: 'flush', label: 'Flush caches and rewrite rules' }, { id: 'cleanup', label: 'Remove the tables from before the import' }],
    'db.cleanCopy': [
      { id: 'import', label: 'Import the dump beside the site' },
      { id: 'clean', label: 'Remove users, orders, reviews, form entries, logs and keys' },
      { id: 'swap', label: 'Swap the clean tables in' },
      ...(Array.isArray(input.replace) && input.replace.length > 0 ? [{ id: 'replace', label: `Replace ${input.replace.length} production domain${input.replace.length > 1 ? 's' : ''}` }, { id: 'check', label: 'Check no site is left on a production address' }] : []),
      { id: 'plugins', label: 'Turn off mail and production-only plugins' },
      { id: 'admin', label: mockUserLabel(input) },
      { id: 'flush', label: 'Flush caches and rewrite rules' },
    ],
    'db.cleanCurrent': [
      { id: 'copy', label: 'Copy the database beside the site' },
      { id: 'clean', label: 'Remove users, orders, reviews, form entries, logs and keys' },
      { id: 'swap', label: 'Swap the clean tables in' },
      { id: 'plugins', label: 'Turn off mail and production-only plugins' },
      { id: 'admin', label: mockUserLabel(input) },
      { id: 'flush', label: 'Flush caches and rewrite rules' },
    ],
    'db.exportClean': [{ id: 'export', label: 'Export the database as a clean copy' }],
    'db.restoreKept': [{ id: 'restore', label: `Put back ${String(input.name)}` }, { id: 'flush', label: 'Flush caches and rewrite rules' }],
    'core.add': [{ id: 'add', label: `Download WordPress ${String(input.version)} into /var/www/wp-cores` }],
    'network.addAdmin': [{ id: 'members', label: `Make ${String(input.user)} administrator on every site of the network` }],
    'site.setPhp':
      input.version === null && Object.keys((input.values ?? {}) as object).length === 0
        ? [
            { id: 'pool', label: `Put ${String(input.domain)}${String(input.path ?? '')} back on the PHP every site runs` },
            { id: 'site', label: `Check ${String(input.domain)} answers` },
            { id: 'trial', label: 'Open the home page and wp-admin on PHP 8.3 and read the new lines in its logs' },
          ]
        : [
            { id: 'pool', label: `Run ${String(input.domain)}${String(input.path ?? '')} on PHP ${String(input.version ?? '8.3')} through its own PHP-FPM pool` },
            { id: 'fpm', label: `Check the pool answers with PHP ${String(input.version ?? '8.3')}` },
            { id: 'site', label: `Check ${String(input.domain)} answers` },
            { id: 'trial', label: `Open the home page and wp-admin on PHP ${String(input.version ?? '8.3')} and read the new lines in its logs` },
          ],
    'php.checkCompatAll': [
      ...['local.northwind.com', 'local.northwind.com/learn', 'local.dailypost.com', 'local.biketours.com'].map((host) => ({ id: `site-${host}`, label: `Scan ${host}` })),
      { id: 'summary', label: 'Sum up' },
    ],
    'php.checkCompat': [
      { id: 'list', label: `List ${String(input.domain)}${String(input.path ?? '')}'s ${input.scope === 'all' ? 'themes and plugins' : 'active theme and plugins'}` },
      { id: 'scan', label: `Scan them against PHP ${String(input.version)}` },
    ],
    'php.switchToFpm': [
      { id: 'switch', label: `Turn mod_php 8.3 off and run every site without a PHP of its own on PHP ${String(input.version)} through PHP-FPM` },
      { id: 'sites', label: 'Check every site answers' },
    ],
    'php.switchToModPhp': [
      { id: 'switch', label: `Turn mod_php ${String(input.version)} back on for every site without a PHP of its own` },
      { id: 'sites', label: 'Check every site answers' },
    ],
    'php.install': [{ id: 'install', label: `Install PHP ${String(input.version)} with PHP-FPM, the command line and the common modules` }],
    'php.upgrade': [{ id: 'upgrade', label: `Update PHP ${String(input.version)} to the newest build apt has` }],
    'php.remove': [{ id: 'remove', label: `Remove PHP ${String(input.version)} (its settings stay in /etc/php/${String(input.version)})` }],
    'php.package': [{ id: String(input.how), label: `${input.how === 'install' ? 'Install' : 'Remove'} php${String(input.version)}-${String(input.name)}` }],
    'php.matchFpm': [{ id: 'match', label: `Give PHP-FPM ${String(input.version)} the modules, settings and php.ini of Apache's PHP ${String(input.version)}` }],
    'php.adoptIni': [
      { id: 'settings-web', label: `Add max_execution_time, memory_limit, post_max_size, upload_max_filesize to the panel's web settings for PHP ${String(input.version)}` },
      { id: 'reset-apache2', label: `Put the packaged php.ini back for PHP ${String(input.version)} (apache2)` },
    ],
    'trash.restore': [
      ...(input.replaceCurrent ? [{ id: 'archive-archive', label: `Archive the current ${String(input.id).slice(0, -16)}` }, { id: 'archive-remove', label: 'Remove the vhost, certificate, hosts line and folder' }] : []),
      { id: 'files', label: `Restore the folder, vhost, certificate and hosts line of ${String(input.id).slice(0, -16)}` },
      { id: 'db', label: 'Create the database' },
      { id: 'import', label: 'Import the database' },
      { id: 'cleanup', label: 'Remove the copy from the Archive' },
    ],
    'mailpit.install': [
      { id: 'download', label: 'Download Mailpit 1.31.4' },
      { id: 'verify', label: 'Check the checksum' },
      { id: 'unpack', label: 'Unpack the mailpit binary' },
      { id: 'service', label: 'Start Mailpit as a user service' },
    ],
    'panel.installRelease': [
      { id: 'start', label: `Start ${String(input.release)}'s installer in the background with your sudo password` },
      { id: 'install', label: `Install ${String(input.release)}: root scripts, system steps, then the restart` },
    ],
    'panel.update': [
      { id: 'download', label: `Download ${String(input.version)}` },
      { id: 'verify', label: 'Check the checksum' },
      { id: 'unpack', label: `Unpack ${String(input.version)} next to the installed releases` },
      { id: 'switch', label: `Switch the panel to ${String(input.version)}` },
      { id: 'restart', label: 'Restart the panel' },
    ],
    'panel.switchRelease': [
      { id: 'switch', label: `Switch the panel to ${String(input.release)}` },
      { id: 'restart', label: 'Restart the panel' },
    ],
    'dump.download': [
      { id: 'space', label: 'Check free disk space' },
      { id: 'download', label: `Download ${String(input.name)} from Google Drive and read it` },
    ],
    'dump.useDownloaded': [{ id: 'take', label: `Take ${String(input.file).split('/').pop()} from Downloads and read it` }],
    'db.searchReplace': input.dryRun
      ? [{ id: 'preview', label: `Count what replacing ${String(input.from)} would change` }]
      : [snapshot, { id: 'replace', label: `Replace ${String(input.from)} with ${String(input.to)}` }, { id: 'flush', label: 'Flush caches and rewrite rules' }],
  };
  const jobId = `mock-${Date.now()}`;
  const job: JobView = { id: jobId, title: isActionId(id) ? actions[id].title : id, target: domain, status: 'running', steps: (plans[id] ?? []).map((s) => ({ ...s, status: 'pending' })), undo: [], undoable: [], progress: 0, startedAt: new Date().toISOString(), kind: id, runId: 900 + mockJobs.size };
  mockJobs.set(jobId, job);
  if (id.startsWith('php.')) mockPhpJob(id, input);
  if (id === 'php.checkCompatAll') mockCheckCompatAll(String(input.version), input.scope === 'all' ? 'all' : 'active');
  if (id === 'php.checkCompat') mockCheckCompat(`${String(input.domain)}${String(input.path ?? '')}`, String(input.version), input.scope === 'all' ? 'all' : 'active');
  if (id === 'site.setPhp') mockSetSitePhp(`${String(input.domain)}${String(input.path ?? '')}`, (input.version as string | null) ?? null, (input.values ?? {}) as Record<string, string>);
  if (id === 'php.adoptIni') {
    window.setTimeout(() => {
      mockIniChanges.moved = true;
      const web = mockPhpSettings['8.3']?.scopes.find((x) => x.scope === 'web');
      if (web) web.panel = { max_execution_time: '300', memory_limit: '512M', post_max_size: '64M', upload_max_filesize: '64M', ...web.panel };
    }, 1500);
  }
  if (id === 'network.addAdmin') {
    const user = String(input.user);
    const admins = mockNetworkAdmins(domain);
    const missing = admins.sites - (admins.admins.find((a) => a.login === user)?.member ?? 0);
    job.title = `Make ${user} administrator on every site of ${domain}`;
    if (missing > 0) job.undoable = [`Take ${user} off the ${missing} site${missing === 1 ? '' : 's'} it was added to`];
    const done = () => {
      if (job.status === 'running') return void window.setTimeout(done, 500);
      if (job.status === 'done') for (const a of admins.admins) if (a.login === user) a.member = admins.sites;
    };
    done();
  }
  if (id.startsWith('mysql.')) {
    job.title = id === 'mysql.optimize' ? `Optimize ${String(input.database)}` : id === 'mysql.dropDatabase' ? `Delete database ${String(input.database)}` : `Delete ${accounts.length === 1 ? accounts[0] : `${accounts.length} MySQL users`}`;
    if (id !== 'mysql.optimize') job.undoable = [id === 'mysql.dropDatabase' ? `Put ${String(input.database)} back from its export` : 'Make the accounts again'];
    afterMysqlJob(job, input);
  }
  // A dump job for an install notes itself on the draft and hands it the dump once it is in, as in the panel.
  const draftId = typeof input.draftId === 'string' ? input.draftId : null;
  const draft = draftId ? mockDrafts.get(draftId) : undefined;
  if (draftId && draft && id.startsWith('dump.')) {
    mockDrafts.set(draftId, { ...draft, jobs: { ...draft.jobs, dump: { id: jobId } } });
    const attach = () => {
      if (job.status !== 'done') return void window.setTimeout(attach, 500);
      const d = mockDrafts.get(draftId);
      if (d) mockDrafts.set(draftId, { ...d, uploads: [...new Set([...d.uploads, MOCK_DUMP_UPLOAD])], attached: [MOCK_DUMP_UPLOAD] });
    };
    attach();
  }
  // The mockup's sudo password is anything but "wrong".
  advance(job, 'steps', id === 'panel.installRelease' && input.password === 'wrong' ? 'start' : undefined, {
    'start-failed': 'sudo did not accept the password: nothing was changed. Log: /home/acmeco/.local/state/devmagic-panel/logs/install-20261031-120000.log',
    start: `install.sh --from-panel runs as devmagic-panel-install-20261031120000`,
    install: `${String(input.release)} installed, replacing v0.6.0`,
    preview: `+------------+--------------+--------------+------+\n| Table      | Column       | Replacements | Type |\n+------------+--------------+--------------+------+\n| wp_options | option_value | 4            | PHP  |\n| wp_posts   | post_content | 37           | SQL  |\n+------------+--------------+--------------+------+\nSuccess: 41 replacements to be made.`,
    replace: 'Success: Made 41 replacements.',
    download: `downloaded ${String(input.name)} (412 MB): upload ${MOCK_DUMP_UPLOAD}, for www.acme-store.com`,
    take: `took ${String(input.file).split('/').pop()} (412 MB): upload ${MOCK_DUMP_UPLOAD}, for www.acme-store.com; your file stays in /home/acmeco/Downloads`,
    clean: 'Users\n  wp_users removed, all but admin: about 18,239 rows\n  wp_usermeta removed with them: about 402,113 rows\nWooCommerce orders and customers\n  wp_wc_orders emptied: about 51,320 rows\n  wp_comments order notes: 88,412\nForm entries\n  wp_gf_entry emptied: about 9,804 rows\nLogs\n  wp_actionscheduler_logs emptied: about 1,204,511 rows\n  wp_wfHits emptied: about 603,220 rows\nPayment, mail and API keys\n  wp_options settings with keys: 7\nSettings: done',
    plugins: 'turned off: wp-mail-smtp, mailchimp-for-wp, wordfence, wp-rocket',
    copy: 'copied 12 tables into northwind_com__import',
    trial: 'Opened home page 200, wp-login.php 200, wp-admin 200. New in the logs: 2 deprecations.\n  PHP Deprecated:  Creation of dynamic property Acme_Forms_Entry::$meta is deprecated in /var/www/local.northwind.com/wp-content/plugins/acme-forms/includes/class-entries.php on line 64 (2 times)',
    scan: `PHP ${String(input.version)}: 3 errors and 5 warnings in 1843 files; errors in Acme Forms`,
    summary: `4 sites checked against PHP ${String(input.version)}: errors in local.northwind.com (3 errors), local.northwind.com/learn (3 errors), local.dailypost.com (3 errors), local.biketours.com (3 errors).`,

    members: `${String(input.user)} is administrator on 2 more sites: #3, #4`,
    admin: 'admin is the only user, an administrator, and the author of every post and link; comments keep who wrote them',
    drop: id === 'mysql.dropDatabase' ? `deleted ${String(input.database)}` : `deleted ${accounts.join(', ')}`,
    save: 'saved to /home/acmeco/.local/share/devmagic-panel/mysql-backups/users-20261029-101500.sql, kept 14 days',
    optimize: `optimized 58 tables of ${String(input.database)}: 342 MB before, 118 MB now`,
    export: id === 'mysql.dropDatabase' ? `saved /home/acmeco/.local/share/devmagic-panel/mysql-backups/${String(input.database)}-20261029-101500.sql.gz (61 MB gzipped), kept 14 days` : 'saved /home/acmeco/devmagic-panel-backups/clean/local.northwind.com/northwind.com-local-clean-2026.10.28.sql.gz (95 MB gzipped, 1.1 GB of SQL)\nno email addresses left in it, apart from local and example ones',
  });
  // What each finished job leaves for the Database tab's lists.
  if (id === 'db.cleanCopy' || id === 'db.cleanCurrent') {
    const at = new Date();
    const kept: KeptDatabaseInfo = { name: `${domain.replace(/^local\./, '').replace(/\W/g, '_')}__keep${stamp(at)}`, reason: id === 'db.cleanCopy' ? 'before the dump from production' : 'before cleaning it', createdAt: at.toISOString(), purgeAt: new Date(at.getTime() + 7 * 86_400_000).toISOString(), sizeBytes: 1_860_000_000 };
    keptDatabases.set(domain, [kept, ...(keptDatabases.get(domain) ?? [])]);
  }
  if (id === 'db.exportClean') {
    const now = new Date();
    const day = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    const taken = (cleanCopies.get(domain) ?? []).filter((c) => c.name.includes(day)).length;
    const name = `${domain.replace(/^local\./, '')}-local-clean-${day}${taken ? `-${taken + 1}` : ''}.sql.gz`;
    cleanCopies.set(domain, [{ name, sizeBytes: 95_200_000, createdAt: now.toISOString(), leftoverEmails: { total: 0, tables: [] } }, ...(cleanCopies.get(domain) ?? [])]);
  }
  if (id === 'db.restoreKept') {
    const list = keptDatabases.get(domain) ?? [];
    const back = list.find((k) => k.name === input.name);
    const at = new Date();
    const out: KeptDatabaseInfo = { name: `${String(input.name).replace(/__keep\d{12}$/, '')}__keep${stamp(at)}`, reason: `before putting back the tables kept on ${back ? dayOf(back.createdAt) : 'that day'}`, createdAt: at.toISOString(), purgeAt: new Date(at.getTime() + 7 * 86_400_000).toISOString(), sizeBytes: 1_860_000_000 };
    keptDatabases.set(domain, [out, ...list.filter((k) => k.name !== input.name)]);
  }
  if (['db.snapshot', 'db.restore', 'db.import', 'db.searchReplace'].includes(id) && (id !== 'db.searchReplace' || !input.dryRun)) {
    const label = id === 'db.snapshot' ? (input.label as string | undefined) : id === 'db.restore' ? 'before-restore' : id === 'db.import' ? 'before-import' : 'before-replace';
    const name = `20261024-${String(Date.now()).slice(-6)}${label ? `-${label}` : ''}.sql.gz`;
    snapshots.set(domain, [{ name, ...(label ? { label } : {}), sizeBytes: 418_000_000, createdAt: new Date().toISOString() }, ...(snapshots.get(domain) ?? [])]);
  }
  return jobId;
}

const MOCK_READ_LINES = ['Reading README.md', 'Reading docs/local.md', 'Reading .lando.yml', 'The docs say dumps are in the Store database dumps folder on Drive.', 'Reading composer.json', 'Writing the answer'];
const MOCK_ACCESS_LINES = [
  'Asana: opening the task 1200001',
  "Asana: reading the task's comments 1200001",
  'Google Drive: searching files acme-store',
  'Google Drive: reading the file details 1AcmeDump20261024',
  'Google Docs: reading the document 1AcmeSetupDoc0001',
  'The setup doc is not shared with this account.',
  'Writing the answer',
];

/**
 * Claude Code reading a repo or checking its links in the mockup: a job of
 * a few seconds, noted on the draft with what it is for, its answer kept
 * there, so leaving the page and coming back can be tried.
 */
function mockClaudeJob(id: 'org.readRepo' | 'org.checkAccess', input: Record<string, unknown>): string {
  const step = id === 'org.readRepo' ? 'read' : 'access';
  const draftId = String(input.draftId);
  const fullName = String(input.fullName);
  const key = step === 'read' ? readKey(fullName, String(input.branch)) : accessKey(fullName, input.links as string[], (input.dumpHints as string[] | undefined) ?? []);
  const noted = mockDrafts.get(draftId)?.jobs?.[step];
  const running = noted?.key === key ? mockJobs.get(noted.id) : undefined;
  if (running?.status === 'running') return running.id;
  const jobId = `mock-${Date.now()}`;
  const job: JobView = {
    id: jobId, title: step === 'read' ? `Read ${fullName} with Claude Code` : `Check the links of ${fullName} with Claude Code`, target: draftId, kind: id, status: 'running',
    steps: [{ id: step, label: step === 'read' ? `Claude Code reads the docs of ${fullName}` : `Claude Code checks ${(input.links as string[]).length} links`, status: 'running' }],
    undo: [], undoable: [], progress: 0, startedAt: new Date().toISOString(), runId: 900 + mockJobs.size,
  };
  mockJobs.set(jobId, job);
  const draft = mockDrafts.get(draftId);
  if (draft) mockDrafts.set(draftId, { ...draft, jobs: { ...draft.jobs, [step]: { id: jobId, key } } });
  // What Claude Code does as it goes, a line every few hundred milliseconds.
  const lines = step === 'read' ? MOCK_READ_LINES : MOCK_ACCESS_LINES;
  lines.forEach((line, i) =>
    window.setTimeout(() => {
      const first = job.steps[0];
      if (first && first.status === 'running') first.activity = [...(first.activity ?? []), line];
    }, 400 + i * 550),
  );
  window.setTimeout(() => {
    const result = step === 'read'
      ? { key, facts: structuredClone(mockFacts), files: ['README.md', '.lando.yml', 'composer.json', 'docs/local.md'], costUsd: 0.03, durationMs: 41_800, tokens: { input: 3100, output: 1400, cacheRead: 22_600, cacheWrite: 9800 }, activity: lines }
      : { key, report: structuredClone(mockAccess), costUsd: 0.06, durationMs: 96_300, tokens: { input: 5200, output: 2300, cacheRead: 61_000, cacheWrite: 12_400 }, activity: lines };
    const first = job.steps[0];
    if (first) Object.assign(first, { status: 'done', durationMs: 5200, output: step === 'read' ? 'Read 4 files for $0.03' : 'Checked 2 links and found 2 dumps for $0.06' });
    Object.assign(job, { status: 'done', progress: 1 });
    const d = mockDrafts.get(draftId);
    if (d) mockDrafts.set(draftId, { ...d, results: { ...d.results, [step]: result } });
  }, step === 'read' ? 5000 : 5500);
  return jobId;
}

/** A mock job still working on a site, like the panel's busy lock. */
function busyJob(key: string): JobView | undefined {
  return [...mockJobs.values()].find((j) => j.kind !== 'site.create' && j.target === key && (j.status === 'running' || j.status === 'queued' || j.status === 'undoing'));
}

function withBusy(site: Site): Site {
  const job = busyJob(`${site.domain}${site.path ?? ''}`);
  return job ? { ...site, busy: { jobId: job.id, title: job.title } } : site;
}

let conventionsText = '# Local site conventions\n\nHow sites are set up on this machine. The assistant reads this before it fills in the new site wizard.\n\n## Domains\n\n- The local domain is the production domain with `local.` in front, without `www.`.\n';

let queued: QueuedProposal[] = [
  {
    id: 'q1', action: 'site.setDebug', title: 'Set debug constants', description: '', input: { domain: 'local.biketours.com', constants: { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false } },
    why: 'Turn on WP_DEBUG_LOG to catch the checkout notice you are chasing.', source: 'claude-code', createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  },
];

/** What a wp-config.php from a repo usually defines, as the panel reads it. */
const mockConstants: SiteConstant[] = [
  { name: 'DB_NAME', value: 'acme_local' },
  { name: 'DB_USER', value: 'acme' },
  { name: 'DB_PASSWORD', hidden: true },
  { name: 'DB_HOST', value: 'localhost' },
  { name: 'DB_CHARSET', value: 'utf8mb4' },
  { name: 'AUTH_KEY', hidden: true },
  { name: 'NONCE_SALT', hidden: true },
  { name: 'SECRET_KEY', hidden: true },
  { name: 'WP_DEBUG', value: true },
  { name: 'WP_ENVIRONMENT_TYPE', value: 'local' },
  { name: 'WP_DEBUG_LOG', value: true },
  { name: 'WP_DEBUG_DISPLAY', value: false },
  { name: 'FS_METHOD', value: 'direct' },
  { name: 'WP_MEMORY_LIMIT', value: '256M' },
  { name: 'DISALLOW_FILE_EDIT', value: true },
  { name: 'ABSPATH', code: "__DIR__ . '/'" },
];

/** The keys a site's constants have, as the panel reads them: the mock has no placeholders or copies. */
function mockSalts(constants: SiteConstant[]): SiteSalts {
  const has = (name: string) => constants.some((c) => c.name === name);
  return { names: [...WP_SALT_KEYS], missing: WP_SALT_KEYS.filter((k) => !has(k)), placeholder: [], duplicate: [], legacy: LEGACY_SALT_KEYS.filter(has) };
}

let mockLocalConstants: LocalConstant[] = [{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }, { name: 'ACME_DEV', value: true }];

// Kept for the browser session, as the panel keeps them in its database.
const mockPreferences: Preferences = (() => {
  try {
    return { theme: 'system', sitesView: 'grid', sitesSort: 'name', newSiteServer: 'apache', ...JSON.parse(sessionStorage.getItem('dmp-mock-preferences') ?? '{}') };
  } catch {
    return { theme: 'system', sitesView: 'grid', sitesSort: 'name', newSiteServer: 'apache' };
  }
})();

/** As for a release that changes install.sh but no root script, read over git because the repository is private. */
/**
 * The mockup's Updates page in other states, from the address:
 * ?terminal (the newest release changes the root scripts and is downloaded),
 * ?install=done|failed|interrupted (how the last install from the page went).
 */
function mockUpdateVariant(): Partial<UpdateStatus> {
  const query = new URLSearchParams(window.location.search);
  const variant: Partial<UpdateStatus> = {};
  if (query.has('terminal')) {
    variant.mode = 'terminal';
    variant.command = '/home/acmeco/.local/share/devmagic-panel/releases/v0.8.0/install.sh';
    variant.reason = 'v0.8.0 changes the root scripts (dmp-root, php.sh), which only its install.sh may put in place, with your sudo password.';
    // Spread over mockUpdate, so it must be there to clear it.
    variant.installerChanged = undefined as never;
    variant.releases = [{ name: 'v0.8.0', version: '0.8.0', current: false, installedAt: new Date().toISOString(), built: '2026-10-31T10:00:00Z', mode: 'terminal', command: variant.command, fromPanel: true }, ...mockUpdate.releases];
  }
  const install = query.get('install');
  if (install === 'done' || install === 'failed' || install === 'interrupted') {
    const log = '/home/acmeco/.local/state/devmagic-panel/logs/install-20261031-120000.log';
    const base = { release: 'v0.8.0', previous: 'v0.6.0', started: new Date(Date.now() - 600_000).toISOString(), finished: new Date(Date.now() - 300_000).toISOString(), log, rolledBack: false, message: '' };
    variant.install =
      install === 'done' ? { ...base, state: 'done', step: 'finish' }
      : install === 'failed' ? { ...base, state: 'failed', step: 'system', message: 'the update stopped at system', rolledBack: true }
      : { ...base, state: 'running', step: 'scripts', finished: '', interrupted: true };
  }
  return variant;
}

let mockPasswordChangedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();

const mockUpdate: UpdateStatus = {
  current: '0.6.0',
  release: 'v0.6.0',
  latest: 'v0.8.0',
  source: 'git',
  access: [
    { way: 'https', problem: 'acme/devmagic-panel is not public' },
    { way: 'gh', problem: 'the GitHub CLI (gh) is not installed' },
  ],
  available: true,
  checkedAt: new Date().toISOString(),
  mode: 'panel',
  installerChanged: true,
  command: '/home/acmeco/.local/share/devmagic-panel/current/install.sh',
  packageBytes: 10_725_138,
  releases: [
    {
      name: 'v0.6.0', version: '0.6.0', current: true, installedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), built: '2026-10-25T09:03:09Z', mode: 'panel',
      changes: { kind: 'running', sections: [{ version: 'v0.6.0', date: '2026-10-25', items: ['**Panel:** runs from a release, with the newest others kept to switch back to', '**Updates:** a page for new releases'] }] },
    },
    { name: 'v0.6.0-dev.89b2be1', version: '0.6.0', current: false, installedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), built: '2026-10-25T08:40:00Z', mode: 'panel' },
    {
      name: 'v0.5.2', version: '0.5.2', current: false, installedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(), built: '2026-10-21T10:00:00Z', mode: 'terminal',
      command: '/home/alex/.local/share/devmagic-panel/releases/v0.5.2/install.sh',
      changes: {
        kind: 'removes',
        sections: [
          { version: 'v0.6.0', date: '2026-10-25', items: ['**Panel:** runs from a release, with the newest others kept to switch back to', '**Updates:** a page for new releases'] },
          { version: 'v0.5.3', date: '2026-10-23', items: ['**Sites:** the list shows each site\'s branch'] },
        ],
      },
    },
  ],
  changelog: [
    {
      version: 'v0.8.0',
      date: '2026-10-29',
      items: [
        '**Updates:** what is new shows right under the update, the newest release open and the ones before it closed',
        '**Environment:** check groups that all pass start closed',
      ],
    },
    {
      version: 'v0.7.1',
      date: '2026-10-28',
      items: ['**Mail:** a site\'s mail can be deleted from its page'],
    },
    {
      version: 'v0.7.0',
      date: '2026-10-27',
      items: [
        '**Sites:** sites under a path, like Northwind Learn at /learn, show as sites of their own',
        '**Panel:** the update page shows what is new before you update',
        '**Mail:** search the caught mail by subject or address',
      ],
    },
  ],
};

const assistantSettings: AssistantSettings = { enabled: true, model: 'claude-opus-5-5', keySource: 'panel', keyHint: 'x9Qa' };

let healthCalls = 0;

export const mockApi: Api = {
  session: async () => ({ authenticated: true, user: 'acmeco', version: '0.2.0-mockup', setupRequired: false }),
  // Down every third call, so the wait for a restart after an update ends in a few seconds.
  health: async () => (++healthCalls % 3 === 2 ? null : '0.2.0-mockup'),
  login: async () => undefined,
  logout: async () => undefined,
  // The mockup's current panel password and computer password are "correct horse"; anything else is wrong.
  passwordInfo: async () => ({ changedAt: mockPasswordChangedAt }),
  changePassword: async (current) => {
    await wait(500);
    if (current !== 'correct horse') throw new Error('The current password is not right');
    mockPasswordChangedAt = new Date().toISOString();
  },
  resetWays: async () => ({ system: true, command: 'node ~/.local/share/devmagic-panel/current/server/dist/cli.js set-password' }),
  resetPassword: async (system) => {
    await wait(900);
    if (system !== 'correct horse') throw new Error('Your computer password was not accepted');
    mockPasswordChangedAt = new Date().toISOString();
  },
  environment: async () => {
    await wait(400);
    return { ...environment, checkedAt: new Date().toISOString() };
  },
  runAction: async (id, input): Promise<ActionRunResult> => {
    await wait(700);
    const cron = mockCronAction(id, input);
    if (cron) return cron;
    if (id === 'git.pull') {
      // As git answers with color.ui = always: a diffstat with its colors.
      const g = '\u001b[32m', r = '\u001b[31m', x = '\u001b[m';
      const output = [
        'Updating 1a2b3c4..5d6e7f8',
        'Fast-forward',
        ` wp-content/plugins/acme-forms/includes/class-acme-forms-submission-handler.php | 48 ${g}++++++++++++++++++++++++++++++++++++${x}${r}------------${x}`,
        ` .../acme-forms/languages/acme-forms-es_ES.mo | Bin ${r}166583${x} -> ${g}166590${x} bytes`,
        ` wp-content/themes/acme/style.css | 2 ${g}+${x}${r}-${x}`,
        ' 3 files changed, 37 insertions(+), 13 deletions(-)',
      ].join('\n');
      return { runId: 42, ok: true, exitCode: 0, output };
    }
    if (id === 'site.shuffleSalts' || id === 'site.removeLegacySalts') {
      const site = sites.find((x) => x.domain === input.domain && x.path === input.path);
      if (site) {
        let list = site.constants ?? structuredClone(mockConstants);
        if (id === 'site.removeLegacySalts') list = list.filter((c) => !LEGACY_SALT_KEYS.some((k) => k === c.name));
        else for (const key of WP_SALT_KEYS) if (!list.some((c) => c.name === key)) list.push({ name: key, hidden: true });
        site.constants = list;
        site.salts = mockSalts(list);
      }
      return { runId: 42, ok: true, exitCode: 0, output: id === 'site.removeLegacySalts' ? "Success: Deleted the constant 'SECRET_KEY'." : 'Success: Shuffled the salt keys.' };
    }
    if (id === 'site.openTerminal') {
      const site = sites.find((x) => x.domain === input.domain && x.path === input.path);
      return { runId: 42, ok: true, exitCode: 0, output: `Opened gnome-terminal in ${site?.docroot ?? '/var/www'}` };
    }
    if (id === 'apache.setModule') {
      const module = mockApacheModules.find((m) => m.name === input.module);
      // As the panel's configtest would: http2 does not run under mpm_prefork.
      if (input.module === 'http2' && input.enabled) {
        return { runId: 42, ok: false, exitCode: 1, output: 'AH00534: apache2: Configuration error: The MPM cannot be used with mod_http2\nturning http2 on breaks the Apache config, so it is off again' };
      }
      if (module) module.enabled = input.enabled === true;
      return { runId: 42, ok: true, exitCode: 0, output: `ok: apache configtest passed\nok: apache restarted\nok: apache module ${String(input.module)} ${input.enabled ? 'on' : 'off'}` };
    }
    if (id === 'mysql.analyze') {
      const list = input.database ? [String(input.database)] : mockMysql().databases.filter((d) => d.kind !== 'system').map((d) => d.name);
      return { runId: 42, ok: true, exitCode: 0, output: list.map((d) => `${d}: analyzed 58 tables`).join('\n') };
    }
    if (id === 'mysql.deleteBackup') {
      mockBackups = mockBackups.filter((b) => b.name !== input.name);
      return { runId: 42, ok: true, exitCode: 0, output: `deleted ${MOCK_BACKUPS_DIR}/${String(input.name)}` };
    }
    if (id === 'mysql.resetSiteUser') {
      return { runId: 42, ok: true, exitCode: 0, output: `${String(input.domain).replace(/^local\./, '').replaceAll('.', '_')}@localhost has a new password; the password is in /var/www/${String(input.domain)}/wp-config.php` };
    }
    if (id === 'site.setConstant') {
      const site = sites.find((x) => x.domain === input.domain && x.path === input.path);
      if (site) {
        const list = (site.constants ?? mockConstants).filter((c) => c.name !== input.name);
        const at = (site.constants ?? mockConstants).findIndex((c) => c.name === input.name);
        if (input.value !== null) list.splice(at >= 0 ? at : list.length, 0, { name: String(input.name), value: input.value as string | boolean | number });
        site.constants = list;
      }
      return { runId: 42, ok: true, exitCode: 0, output: input.value === null ? `Success: Deleted the constant '${input.name}'.` : `Success: Updated the constant '${input.name}'.` };
    }
    if (id === 'trash.delete') {
      const at = mockTrash.findIndex((e) => e.id === input.id);
      if (at >= 0) mockTrash.splice(at, 1);
    }
    if (id === 'panel.autostart') {
      const check = environment.checks.find((c) => c.id === 'panel.autostart');
      if (check) Object.assign(check, { status: 'ok', detail: '~/.config/autostart/devmagic-panel.desktop starts the panel and Mailpit when you log in', fixes: undefined });
      return { runId: 42, ok: true, exitCode: 0, output: 'wrote /home/alex/.config/autostart/devmagic-panel.desktop: the panel and Mailpit start after you log in' };
    }
    if (id === 'php.setModule') {
      const version = mockPhpVersions.find((v) => (input.version ? v.version === input.version : v.apache));
      const module = version?.modules.find((m) => m.name === input.module);
      if (!version || !module) return { runId: 42, ok: false, exitCode: 1, output: `${String(input.module)} is not installed for PHP ${String(input.version ?? '8.3')} (mockup)` };
      for (const part of ['apache2', 'fpm', 'cli'] as const) if (module[part] !== undefined) module[part] = input.enabled === true;
      return { runId: 42, ok: true, exitCode: 0, output: `ok: ${module.name} ${input.enabled ? 'on' : 'off'} for PHP ${version.version}` };
    }
    if (id === 'php.deleteCompat') {
      const n = mockDeleteCompat(input.domain ? `${String(input.domain)}${String(input.path ?? '')}` : undefined, input.version ? String(input.version) : undefined);
      return { runId: 42, ok: true, exitCode: 0, output: `deleted ${n} compatibility scan${n === 1 ? '' : 's'}` };
    }
    if (id === 'php.setCli') {
      for (const v of mockPhpVersions) v.cli = v.version === input.version;
      return { runId: 42, ok: true, exitCode: 0, output: `ok: php on the command line is PHP ${String(input.version)}` };
    }
    if (id === 'php.setXdebug') {
      const version = mockPhpVersions.find((v) => (input.version ? v.version === input.version : v.apache));
      if (version) version.xdebug = { ...version.xdebug, enabled: input.enabled === true, modes: input.modes as string[], startWithRequest: String(input.startWithRequest) };
    }
    if (id === 'php.setIni') {
      const scope = mockPhpSettings[String(input.version)]?.scopes.find((s) => s.scope === input.scope);
      if (scope) scope.panel = { ...(input.values as Record<string, string>) };
      return { runId: 42, ok: true, exitCode: 0, output: `ok: PHP ${String(input.version)} ${String(input.scope)} settings written` };
    }
    if (id === 'site.pluginSet') {
      const plugin = mockPlugins.find((p) => p.name === input.plugin);
      if (!plugin || plugin.status === 'must-use' || plugin.status === 'dropin') return { runId: 42, ok: false, exitCode: 1, output: `Error: no plugin called ${String(input.plugin)} (mockup)` };
      plugin.status = input.active ? 'active' : 'inactive';
      const needs = mockPlugins.find((p) => p.name === 'advanced-custom-fields-pro');
      const blocks = mockPlugins.find((p) => p.name === 'acme-acf-blocks');
      if (needs && blocks) {
        if (blocks.status === 'active') needs.requiredBy = [blocks.title];
        else delete needs.requiredBy;
      }
      return { runId: 42, ok: true, exitCode: 0, output: `Success: ${input.active ? 'Activated' : 'Deactivated'} 1 of 1 plugins. (mockup)` };
    }
    if (id === 'site.skippedDone') {
      const site = sites.find((s) => s.domain === input.domain && s.path === input.path);
      if (site?.install?.skipped) {
        const left = site.install.skipped.filter((s) => s.label !== input.label);
        if (left.length) site.install.skipped = left;
        else delete site.install.skipped;
      }
      return { runId: 42, ok: true, exitCode: 0, output: `${String(input.label)}: marked done on ${String(input.domain)}` };
    }
    if (id === 'db.deleteCleanCopy') cleanCopies.set(String(input.domain), (cleanCopies.get(String(input.domain)) ?? []).filter((c) => c.name !== input.name));
    if (id === 'db.deleteKept') keptDatabases.set(String(input.domain), (keptDatabases.get(String(input.domain)) ?? []).filter((k) => k.name !== input.name));
    if (id === 'db.deleteSnapshot') {
      snapshots.set(String(input.domain), (snapshots.get(String(input.domain)) ?? []).filter((s) => s.name !== input.snapshot));
    }
    return { runId: 42, ok: true, exitCode: 0, output: 'ok: done (mockup)' };
  },
  localConstants: async () => structuredClone(mockLocalConstants),
  saveLocalConstants: async (list) => {
    mockLocalConstants = structuredClone(list);
    return structuredClone(list);
  },
  preferences: async () => ({ ...mockPreferences }),
  savePreferences: async (update) => {
    Object.assign(mockPreferences, update);
    try {
      sessionStorage.setItem('dmp-mock-preferences', JSON.stringify(mockPreferences));
    } catch {
      // the mock forgets them then
    }
    return { ...mockPreferences };
  },
  assistant: async () => structuredClone(assistantSettings),
  saveAssistant: async (settings) => {
    await wait(200);
    Object.assign(assistantSettings, settings);
    return structuredClone(assistantSettings);
  },
  saveAssistantKey: async (apiKey) => {
    await wait(200);
    Object.assign(assistantSettings, { keySource: 'panel', keyHint: apiKey.slice(-4) });
    return structuredClone(assistantSettings);
  },
  removeAssistantKey: async () => {
    await wait(200);
    assistantSettings.keySource = 'none';
    delete assistantSettings.keyHint;
    return structuredClone(assistantSettings);
  },
  testAssistant: async () => {
    await wait(600);
    return { ok: true };
  },
  conventions: async () => ({ text: conventionsText, saved: false, path: '/home/acmeco/.config/devmagic-panel/conventions.md' }),
  saveConventions: async (text) => {
    await wait(200);
    conventionsText = text;
    return { text, saved: true, path: '/home/acmeco/.config/devmagic-panel/conventions.md' };
  },
  suggestWizard: async (input): Promise<WizardSuggestion> => {
    await wait(2200);
    return {
      branch: 'develop',
      preset: {
        domains: [
          { production: 'www.acme.com', local: 'local.acme.com' },
          { production: 'shop.acme.com', local: 'local.shop.acme.com' },
        ],
        layout: 'wp-content',
        activate: [],
        core: { mode: 'wpcore', version: '7.1.3' },
        deactivate: ['wp-rocket', 'wordfence'],
        uploadsFrom: 'www.acme.com',
        build: { composer: true, npm: true },
      },
      notes: `Took the shop subdomain from your description${input.uploadId ? ' and the dump' : ''}; the repo holds wp-content like local.biketours.com. No dump yet, so the core is the newest installed one.`,
      sent: JSON.stringify({ description: input.description, repo: input.repoUrl ?? 'none given' }, null, 1),
    };
  },
  proposals: async () => structuredClone(queued),
  closeProposal: async (id) => {
    queued = queued.filter((p) => p.id !== id);
  },
  mcpCommand: async () => ({ command: 'claude mcp add devmagic-panel -- /home/acmeco/.nvm/versions/node/v22.13.1/bin/node --disable-warning=ExperimentalWarning /home/acmeco/.local/share/devmagic-panel/current/server/dist/cli.js mcp' }),
  chat: async (messages): Promise<ChatReply> => {
    await wait(1500);
    const last = messages.at(-1)?.content.toLowerCase() ?? '';
    if (/cert|ssl|https/.test(last)) {
      return {
        reply: 'DailyPost has a cert that misses www.local.dailypost.com, and Northwind still uses the old LocalhostCA. Reissuing both from their vhosts fixes it.',
        looked: ['aura_findings', 'site_details local.dailypost.com'],
        proposals: [
          { id: 'p1', action: 'cert.reissue', title: 'Reissue certificate', description: '', input: { domain: 'local.dailypost.com' }, why: 'The cert misses www.local.dailypost.com.' },
          { id: 'p2', action: 'cert.reissue', title: 'Reissue certificate', description: '', input: { domain: 'local.northwind.com' }, why: 'Moves Northwind off the old LocalhostCA.' },
        ],
      };
    }
    if (/fatal|error|log/.test(last)) {
      return {
        reply: 'local.arcade.bet logged 3 fatals in the last hour, all "Call to undefined function wc_get_product()" from the arcade-bonus plugin: it runs before WooCommerce loads. Clearing caches will not help; the plugin needs a function_exists check.',
        looked: ['read_log local.arcade.bet debug'],
        proposals: [{ id: 'p3', action: 'site.clearDebugLog', title: 'Clear debug.log', description: '', input: { domain: 'local.arcade.bet' }, why: 'Start from an empty log to see whether the fatal comes back after the fix.' }],
      };
    }
    return {
      reply: 'You have 7 local sites. 2 need attention: local.arcade.bet (PHP fatals, outdated WordPress) and local.dailypost.com (cert and hosts). Ask me about either.',
      looked: ['list_sites'],
      proposals: [],
    };
  },
  briefing: async (): Promise<Briefing> => {
    await wait(1800);
    if (!assistantSettings.enabled) return { status: 'off' };
    const items: AuraItem[] = sites.flatMap((s) => s.issues.map((issue) => ({ ...issue, domain: s.domain })));
    const find = (id: string) => items.filter((i) => i.id === id);
    return {
      status: 'ready',
      headline: 'One site throws PHP fatals and two need small fixes.',
      points: [
        { text: 'local.arcade.bet logged 3 PHP fatal errors in the last hour and runs an outdated WordPress. Check the Logs tab first.', items: [...find('php.fatals'), ...find('core.outdated')] },
        { text: 'DailyPost: www is missing from the cert and two names from /etc/hosts. Reissue the cert and add the hosts line.', items: [...find('cert.uncovered'), ...find('hosts.missing')] },
        { text: 'Northwind still uses the old LocalhostCA cert; reissue it.', items: find('cert.legacy') },
      ],
      model: assistantSettings.model,
      generatedAt: new Date().toISOString(),
      sent: JSON.stringify(items.map((it, i) => ({ n: i + 1, site: it.domain, status: it.status, problem: it.text, ...(it.fix ? { fix: it.fix.label } : {}) })), null, 1),
    };
  },
  services: async (): Promise<ServicesReport> => {
    await wait(300);
    return {
      checkedAt: new Date().toISOString(),
      services: [
        { id: 'apache', label: 'Apache', state: 'running', detail: 'Apache/2.4.58', canRestart: true },
        mockNginxSetUp
          ? { id: 'nginx', label: 'nginx', state: 'running', detail: 'nginx/1.24.0 on 127.0.0.2, Apache on 127.0.0.1', canRestart: true }
          : { id: 'nginx', label: 'nginx', state: 'stopped', detail: 'nginx/1.24.0 installed, not set up next to Apache yet', canRestart: false },
        { id: 'mysql', label: 'MySQL', state: 'running', detail: 'mysql  Ver 8.0.43-0ubuntu0.24.04.1 for Linux on x86_64', canRestart: true },
        mailpitRunning
          ? { id: 'mailpit', label: 'Mailpit', state: 'running', detail: 'catching mail on port 1025, read it at http://localhost:8025/', canRestart: false }
          : { id: 'mailpit', label: 'Mailpit', state: 'stopped', detail: 'not listening on port 1025', canRestart: false, offer: 'install' },
        { id: 'cron', label: 'Cron', state: 'running', detail: `${mockCron().tasks.length} tasks of the panel, 1 line of your own`, canRestart: false },
      ],
      php: { apache: '8.3', cli: '8.3.6' },
    };
  },
  php: async () => {
    await wait(300);
    return mockPhpReport();
  },
  phpIni: async (version) => {
    await wait(200);
    return mockPhpIni(version);
  },
  phpInfo: async (version, sapi) => {
    await wait(400);
    return mockPhpInfo(version, sapi);
  },
  phpSettings: async (version) => {
    await wait(200);
    const settings = mockPhpSettings[version] ?? { version, scopes: [] };
    return { ...settings, scopes: settings.scopes.map((x) => ({ ...x, panel: { ...x.panel }, files: { ...x.files } })) };
  },
  phpPackages: async (version) => {
    await wait(300);
    return mockPhpPackages(version);
  },
  sitePhp: async (domain, path) => {
    await wait(200);
    return mockSitePhp(`${domain}${path ?? ''}`);
  },
  phpVersionCompat: async (version) => {
    await wait(250);
    return mockVersionCompat(version);
  },
  sitePhpCompat: async (domain, path) => {
    await wait(200);
    return mockSiteCompat(`${domain}${path ?? ''}`);
  },
  sitePhpInfo: async (domain, path) => {
    await wait(400);
    return mockSitePhpInfo(`${domain}${path ?? ''}`);
  },
  phpFpmCheck: async () => {
    await wait(300);
    return mockFpmFindings();
  },
  mysql: async (): Promise<MysqlReport> => {
    await wait(300);
    return mockMysql();
  },
  dbOverview: async (database) => {
    await wait(250);
    return mockDbOverview(database);
  },
  dbStructure: async (database, table) => {
    await wait(200);
    return mockDbStructure(database, table);
  },
  dbRows: async (database, table, query) => {
    await wait(250);
    return mockDbRows(database, table, query);
  },
  dbCell: async (database, table, query) => {
    await wait(150);
    return mockDbCell(database, table, query.column, query.key);
  },
  apache: async (): Promise<ApacheReport> => {
    await wait(300);
    const vhosts = sites
      .filter((s) => !s.path)
      .map((s) => ({
        file: `${s.domain}-ssl.conf`,
        enabled: true,
        managed: s.vhostManaged,
        names: [s.domain, ...s.aliases],
        docroot: s.docroot,
        site: s.domain,
        mounts: (s.mounts ?? []).map((m) => m.path),
        ...(s.cert ? { certExpiresAt: s.cert.expiresAt } : {}),
      }));
    return {
      checkedAt: new Date().toISOString(),
      configtest: { ok: true, output: 'Syntax OK' },
      server: { state: 'running', version: 'Apache/2.4.58', since: new Date(Date.now() - 3 * 86_400_000 - 4 * 3_600_000).toISOString(), mpm: 'mpm_prefork', php: '8.3', ports: ['80', '443'] },
      modules: mockApacheModules.map((m) => {
        const locked = apacheModuleLock(m.name, !m.enabled);
        return { ...m, ...(locked ? { locked } : {}) };
      }),
      vhosts: [
        { file: '000-default.conf', enabled: true, managed: false, names: [], docroot: '/var/www/html', mounts: [] },
        ...vhosts,
        { file: 'local.oldclient.test.conf', enabled: false, managed: false, names: ['local.oldclient.test'], docroot: '/var/www/local.oldclient.test', mounts: [] },
        { file: 'local.devmagic.conf', enabled: true, managed: false, names: ['local.devmagic'], mounts: [], certExpiresAt: '2028-06-01T00:00:00.000Z' },
      ],
      errorLog: '/var/log/apache2/error.log',
    };
  },
  nginx: async (): Promise<NginxReport> => {
    await wait(300);
    return {
      checkedAt: new Date().toISOString(),
      installed: true,
      setUp: mockNginxSetUp,
      addresses: { nginx: '127.0.0.2', apache: '127.0.0.1' },
      configtest: { ok: true, output: 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful' },
      server: mockNginxSetUp ? { state: 'running', version: 'nginx/1.24.0', since: new Date(Date.now() - 2 * 3_600_000).toISOString() } : { state: 'stopped', version: 'nginx/1.24.0' },
      configs: [
        { file: 'default', enabled: !mockNginxSetUp, managed: false, names: [], listens: ['80 default_server', '[::]:80 default_server'] },
        { file: 'local.legacy.test', enabled: false, managed: false, names: ['local.legacy.test'], listens: ['127.0.0.2:443 ssl'] },
      ],
      errorLog: '/var/log/nginx/error.log',
    };
  },
  nginxState: async () => ({ setUp: mockNginxSetUp, php: '8.3' }),
  nginxLog: async () => {
    await wait(150);
    return {
      file: '/var/log/nginx/error.log',
      shared: true,
      exists: true,
      lines: mockNginxSetUp ? [{ time: new Date(Date.now() - 600_000).toISOString(), level: 'notice', message: 'signal process started' }] : [],
    };
  },
  apacheLog: async () => {
    await wait(150);
    return {
      file: '/var/log/apache2/error.log',
      shared: true,
      exists: true,
      lines: [
        { time: new Date(Date.now() - 3_600_000).toISOString(), level: 'notice', message: 'AH00489: Apache/2.4.58 (Ubuntu) OpenSSL/3.0.13 configured -- resuming normal operations' },
        { time: new Date(Date.now() - 1_800_000).toISOString(), level: 'error', message: "[client 127.0.0.1:51234] PHP Warning:  Undefined array key \"acme_option\" in /var/www/local.northwind.com/wp-content/themes/northwind/functions.php on line 42" },
      ],
    };
  },
  aura: async (): Promise<AuraReport> => {
    await wait(300);
    const items: AuraItem[] = sites.flatMap((s) => s.issues.map((issue) => ({ ...issue, domain: s.domain })));
    items.push({
      id: 'hosts.stale',
      status: 'warn',
      text: '/etc/hosts still points local.oldclient.test here, but no site uses it',
      fix: { action: 'hosts.remove', input: { domain: 'local.oldclient.test' }, label: 'Remove the line' },
    });
    items.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
    return { checkedAt: new Date().toISOString(), items };
  },
  sites: async () => {
    await wait(250);
    for (const site of sites) {
      if (site.core.kind !== 'none' && !site.constants) site.constants = structuredClone(mockConstants);
      if (site.constants) site.salts = mockSalts(site.constants);
      const own = mockSitePools[`${site.domain}${site.path ?? ''}`];
      if (site.core.kind !== 'none') site.php = own ? { version: own.version, own: true } : { version: mockPhpMode.fpm ?? '8.3', own: false };
    }
    // A made-up day each, in a mixed order, so the sort has something to sort.
    return sites.map((site, i) => withBusy({ ...site, addedAt: site.addedAt ?? new Date(Date.UTC(2026, 6, 1 + ((i * 7) % 23) * 4)).toISOString() }));
  },
  site: async (domain, path) => {
    await wait(150);
    const site = sites.find((s) => s.domain === domain && s.path === path);
    if (site && site.core.kind !== 'none' && !site.constants) site.constants = structuredClone(mockConstants);
    if (site?.constants) site.salts = mockSalts(site.constants);
    return site ? withBusy(site) : null;
  },
  gitDetails: async (domain, mount, inner): Promise<GitDetails> => {
    await wait(200);
    const site = sites.find((s) => s.domain === domain && !s.path);
    // A site under a path has its own repo; other mounted folders are its parent's; a theme or plugin has its own.
    const owner = mount ? sites.find((s) => s.domain === domain && s.path === mount) : site;
    const repo = inner ? owner?.repos?.find((r) => r.folder === inner)?.git : mount ? (owner?.git ?? site?.mounts?.find((m) => m.path === mount)?.git) : site?.git;
    const branch = repo?.branch ?? 'master';
    const last = repo?.lastCommit;
    return {
      branches: [
        { name: branch, current: true, remoteOnly: false },
        ...['master', 'develop', 'feature/ts-editor', 'feature/cart-drawer', 'bugfix/search-results-pagination', 'release/2026-10']
          .filter((b) => b !== branch)
          .map((name) => ({ name, current: false, remoteOnly: false })),
        ...['feature/checkout-redesign', 'hotfix/cart-totals', 'feature/tracking-consent', 'bugfix/newsletter-invalid-url', 'feature/multisite-sso', 'chore/update-plugins-october']
          .map((name) => ({ name, current: false, remoteOnly: true })),
      ],
      commits: [
        ...(last ? [last] : []),
        { hash: '8c1e2d4a7', subject: 'Update plugins for October', author: 'Sam Lee', date: '2026-10-17T11:02:10+03:00' },
        { hash: '1f9a0b3c2', subject: 'Fix: header menu overlaps the logo on tablets', author: 'Alex Morgan', date: '2026-10-15T09:40:00+08:00' },
      ],
      changes: (repo?.dirty ?? 0) > 0 ? [{ code: ' M', path: 'wp-content/themes/dailypost/functions.php' }, { code: '??', path: 'wp-content/themes/dailypost/notes.txt' }] : [],
      fetchedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
    };
  },
  gitPulls: async (domain, mount, inner): Promise<GitPullRequest[]> => {
    // Slower than the Git card's own data, as gh is.
    await wait(900);
    const site = sites.find((s) => s.domain === domain && !s.path);
    const owner = mount ? sites.find((s) => s.domain === domain && s.path === mount) : site;
    const repo = inner ? owner?.repos?.find((r) => r.folder === inner)?.git : mount ? (owner?.git ?? site?.mounts?.find((m) => m.path === mount)?.git) : site?.git;
    const github = repo?.remote ? /github\.com[:/](.+?)(\.git)?$/.exec(repo.remote)?.[1] : undefined;
    const gitlab = repo?.remote ? /gitlab\.com[:/](.+?)(\.git)?$/.exec(repo.remote)?.[1] : undefined;
    if (!repo || (!github && !gitlab)) return [];
    const pull = (number: number, title: string, branch: string, draft = false) =>
      github
        ? { kind: 'pull' as const, number, title, url: `https://github.com/${github}/pull/${number}`, branch, draft }
        : { kind: 'merge' as const, number, title, url: `https://gitlab.com/${gitlab}/-/merge_requests/${number}`, branch, draft };
    // The checked-out branch has one once it is pushed and is not a main line.
    const own = repo.upstream !== null && !['master', 'develop'].includes(repo.branch);
    return [
      ...(own ? [pull(312, repo.lastCommit.subject.replace(/ \(#\d+\)$/, ''), repo.branch)] : []),
      pull(305, 'Typed settings editor for the theme options', 'feature/ts-editor', true),
      pull(298, 'Checkout: one page with the cart and payment side by side', 'feature/checkout-redesign'),
      pull(287, 'Search results: keep the page number when filters change', 'bugfix/search-results-pagination'),
    ].filter((p, i, all) => all.findIndex((q) => q.branch === p.branch) === i);
  },
  networkAdmins: async (domain) => {
    await wait(500);
    return structuredClone(mockNetworkAdmins(domain));
  },
  cron: async () => {
    await wait(300);
    return mockCron();
  },
  cronRuns: async (id) => {
    await wait(150);
    return mockCronRuns(id);
  },
  cronRun: async (run) => {
    await wait(100);
    const found = mockCronRun(run);
    if (!found) throw new Error('No such run');
    return structuredClone(found);
  },
  wpCron: async (domain, path, url) => {
    await wait(500);
    const site = sites.find((s) => s.domain === domain && s.path === path);
    return mockWpCron(domain, path, url, Boolean(site?.constants?.some((c) => c.name === 'DISABLE_WP_CRON' && c.value === true)));
  },
  wpCronTest: async (domain) => {
    await wait(600);
    return domain === 'local.biketours.com'
      ? { ok: false, output: 'Error: WP-Cron spawn returned HTTP status code: 401 Unauthorized' }
      : { ok: true, output: 'Success: WP-Cron spawning is working as expected.' };
  },
  plugins: async (domain) => {
    await wait(400);
    return { plugins: structuredClone(mockPlugins), network: Boolean(sites.find((s) => s.domain === domain)?.network) };
  },
  snapshots: async (domain, path) => {
    await wait(150);
    return structuredClone(snapshots.get(`${domain}${path ?? ''}`) ?? []);
  },
  cleanCopies: async (domain, path) => {
    await wait(150);
    return structuredClone(cleanCopies.get(`${domain}${path ?? ''}`) ?? []);
  },
  keptDatabases: async (domain, path) => {
    await wait(150);
    return structuredClone(keptDatabases.get(`${domain}${path ?? ''}`) ?? []);
  },
  cleanPreview: async (domain): Promise<CleanPreview> => {
    await wait(200);
    const tables = ['wp_options', 'wp_posts', 'wp_postmeta', 'wp_users', 'wp_usermeta', 'wp_comments', 'wp_wc_orders', 'wp_wc_orders_meta', 'wp_gf_entry', 'wp_gf_entry_meta', 'wp_actionscheduler_logs', 'wp_wfHits'];
    return { tables, prefix: 'wp_', multisite: false, admins: domain === 'local.northwind.com' ? ['admin', 'northwindadmin'] : ['shopowner'], sizeBytes: 1_740_000_000, leftOutBytes: 310_000_000 };
  },
  inspectRepo: async (url): Promise<RepoInspection> => {
    await wait(900);
    // Northwind was installed here before in the mockup, so the wizard remembers its answers; others start empty.
    if (!/northwind/i.test(url)) return { defaultBranch: 'main', branch: 'main', branches: ['main', 'develop', 'feature/checkout-redesign', 'hotfix/cart-totals'] };
    return {
      defaultBranch: 'develop',
      branch: 'develop',
      branches: ['develop', 'feature/ts-editor', 'feature/pricing-page', 'master', 'release/2026.10'],
      preset: {
        domains: [
          { production: 'www.northwind.com', local: 'local.northwind.com' },
          { production: 'www.northwind.de', local: 'local.northwind.de' },
          { production: 'www.northwind.fr', local: 'local.northwind.fr' },
        ],
        layout: 'site-root',
        activate: ['query-monitor'],
        core: { mode: 'wpcore', version: '7.1.3' },
        deactivate: ['wp-rocket', 'wordfence', 'cloudflare'],
        uploadsFrom: 'www.northwind.com',
        build: { composer: true, npm: true },
      },
    };
  },
  repoHelpers: async (url, branch) => {
    await wait(1200);
    // Northwind's develop branch carries Query Monitor and User Switching in the mockup; other branches and repos only Query Monitor.
    // Every repo in the mockup has BE Media from Production, as the client repos here do.
    // Like the repos here: one theme to build, a custom plugin with Composer, and plugins that ship their built files.
    const builds: RepoBuild[] = [
      { dir: 'wp-content/themes/acme', tool: 'npm', scripts: ['build', 'build-all', 'prod', 'dev'], script: 'build', needed: true, why: 'dist/ is ignored by git', stopsOthers: ['build-all'] },
      { dir: 'wp-content/plugins/acme-api', tool: 'composer', scripts: [], needed: true, why: 'vendor/ is ignored by git' },
      { dir: 'wp-content/plugins/acme-slider', tool: 'npm', scripts: ['prod', 'prod-bundle', 'dev'], script: 'prod', needed: false, why: 'its built files are in the repo', builtInRepo: true },
      { dir: 'wp-content/plugins/acme-forms', tool: 'npm', scripts: ['build'], script: 'build', needed: false, why: 'a wordpress.org plugin, built already', builtInRepo: true },
      { dir: 'wp-content/plugins/acme-maps', tool: 'composer', scripts: [], needed: false, why: 'its vendor/ is in the repo', builtInRepo: true },
    ];
    return { helpers: /northwind/i.test(url) && branch === 'develop' ? ['query-monitor', 'user-switching'] : ['query-monitor'], mediaPlugin: true, builds };
  },
  startJob: async (id, input) => {
    await wait(300);
    if (id === 'org.readRepo' || id === 'org.checkAccess') return mockClaudeJob(id, input);
    // The mockup's Mailpit "runs" once its install job has had time to finish.
    if (id === 'mailpit.install') window.setTimeout(() => (mailpitRunning = true), 3500);
    if (id === 'nginx.setup' || id === 'nginx.teardown') window.setTimeout(() => (mockNginxSetUp = id === 'nginx.setup'), 3500);
    if (id === 'sites.setServerAll') {
      for (const s of sites) if (!s.path && !s.move?.refusal) s.server = input.server === 'nginx' ? 'nginx' : 'apache';
    }
    if (id === 'site.setServer') {
      const moved = sites.find((s) => s.domain === input.domain && !s.path);
      if (moved) moved.server = input.server === 'nginx' ? 'nginx' : 'apache';
    }
    return mockDbJob(id, input);
  },
  logs: async (domain, source) => {
    await wait(150);
    const site = sites.find((s) => s.domain === domain);
    if (source === 'apache') {
      return { file: '/var/log/apache2/error.log', shared: !site?.vhostManaged, exists: true, lines: [] };
    }
    return {
      file: `${site?.docroot ?? `/var/www/${domain}`}/wp-content/debug.log`,
      shared: false,
      exists: true,
      lines: debugLog.map((l) => ({ ...l, message: l.message.replaceAll('local.arcade.bet', domain) })),
    };
  },
  runs: async (page = 1) => ({ runs: runs.slice((page - 1) * 50, page * 50), page, pageSize: 50, total: runs.length }),
  deleteUpload: async () => ({ ok: true }),
  developer: async () => {
    await wait(300);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const listed: Array<[string, string, 'remove' | 'ask' | 'keep', string, number?]> = [
      ['dir', '/etc/devmagic-panel', 'remove', 'settings folder'],
      ['file', '/etc/devmagic-panel/config.env', 'remove', 'settings read by dmp-root and the panel', 612],
      ['dir', '/usr/local/lib/devmagic-panel', 'remove', 'root-owned scripts the sudoers rule allows'],
      ['file', '/usr/local/lib/devmagic-panel/bin/dmp-root', 'remove', 'root script', 28_412],
      ['file', '/usr/local/lib/devmagic-panel/bin/dmp-restore', 'remove', 'root script', 3_920],
      ['file', '/etc/sudoers.d/devmagic-panel', 'remove', 'lets you run dmp-root and wpcore without a password', 167],
      ['dir', '/home/acmeco/devmagic-panel-backups', 'ask', 'backups of certs, vhosts and hosts, and database snapshots'],
      ['dir', '/var/lib/devmagic-panel', 'ask', 'the registry of panel-made sites and the deleted sites'],
      ['modules', 'apache:ssl rewrite headers proxy proxy_http proxy_wstunnel', 'keep', 'Apache modules the panel turned on; sites use them too'],
      ['dir', '/etc/ssl/localcerts/devmagic-panel-ca', 'ask', 'the local CA, its key and certificate; every site certificate is signed with it'],
      ['file', '/usr/local/share/ca-certificates/devmagic-panel-ca.crt', 'remove', 'the local CA in the system trust store', 1_294],
      ['store', '/home/acmeco/.pki/nssdb', 'remove', 'the local CA in this browser certificate store, as devmagic-panel Local CA'],
      ['line', '/etc/hosts', 'remove', 'local.devmagic in the devmagic-panel block'],
      ['file', '/home/acmeco/.config/systemd/user/devmagic-panel.service', 'remove', "the panel's systemd user service", 302],
      ['file', '/var/lib/devmagic-panel/installed-files', 'remove', 'this list', 2_410],
    ];
    return {
      version: '0.5.0',
      commit: 'v0.4.0-12-g73cfec1',
      node: 'v22.20.0',
      repo: '/home/acmeco/projects/devmagic-panel',
      server: { pid: 930032, startedAt: at(95), memoryBytes: 118_000_000, nodePath: '/home/acmeco/.nvm/versions/node/v22.23.3/bin/node', port: 4710, runningJobs: 0 },
      services: [
        { unit: 'devmagic-panel.service', label: 'Panel', scope: 'user', active: 'active', enabled: 'enabled', since: at(95) },
        { unit: 'devmagic-panel-mailpit.service', label: 'Mailpit', scope: 'user', active: mailpitRunning ? 'active' : 'inactive', enabled: 'enabled', ...(mailpitRunning ? { since: at(2000) } : {}) },
        { unit: 'apache2.service', label: 'Apache', scope: 'system', active: 'active', enabled: 'enabled', since: at(3000) },
        { unit: 'mysql.service', label: 'MySQL', scope: 'system', active: 'active', enabled: 'enabled', since: at(3000) },
      ],
      linger: false,
      config: [['PANEL_USER', 'acmeco'], ['PANEL_PORT', '4710'], ['PANEL_DOMAIN', 'local.devmagic'], ['WEB_DIR', '/var/www'], ['CERTS_DIR', '/etc/ssl/localcerts'], ['BACKUP_DIR', '/home/acmeco/devmagic-panel-backups'], ['STATE_DIR', '/var/lib/devmagic-panel']].map(([key, value]) => ({ key: key as string, value: value as string })),
      installedFiles: listed.map(([kind, path, onUninstall, note, size]) => ({ kind, path, onUninstall, note, exists: true, ...(size ? { sizeBytes: size } : {}) })),
      panelFiles: [
        { path: '/home/acmeco/.config/devmagic-panel/secrets.json', note: 'panel password hash, MySQL admin account and the Anthropic key (mode 0600)', exists: true, sizeBytes: 412, kind: 'file' },
        { path: '/home/acmeco/.local/share/devmagic-panel/panel.db', note: "run history, queued proposals and the wizard's answers per repo", exists: true, sizeBytes: 1_843_200, kind: 'file' },
        { path: '/home/acmeco/.local/share/devmagic-panel/uploads', note: 'database dumps waiting for an install or import', exists: true, kind: 'dir' },
        { path: '/home/acmeco/.local/share/devmagic-panel/mailpit', note: 'Mailpit, when installed from the panel', exists: mailpitRunning, kind: 'dir' },
        { path: '/home/acmeco/.local/state/devmagic-panel/logs', note: 'install and update logs', exists: true, kind: 'dir' },
      ],
      logs: [
        { name: 'install-20261025-091500.log', sizeBytes: 18_204, modifiedAt: at(45) },
        { name: 'install-20261023-142010.log', sizeBytes: 21_877, modifiedAt: at(60 * 43) },
      ],
    };
  },
  developerFolder: async (path) => {
    await wait(250);
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const file = (name: string, sizeBytes: number, days = 3): FolderEntry => ({ name, kind: 'file', sizeBytes, modifiedAt: at(days) });
    const dir = (name: string, days = 3): FolderEntry => ({ name, kind: 'dir', modifiedAt: at(days) });
    // A few folders of the sample machine; the trash is root's, as on a real one.
    const folders: Record<string, FolderEntry[] | string> = {
      '/etc/devmagic-panel': [file('config.env', 612)],
      '/usr/local/lib/devmagic-panel': [dir('bin'), dir('lib')],
      '/usr/local/lib/devmagic-panel/bin': [file('dmp-restore', 3_920), file('dmp-root', 28_412), file('wpcore', 19_640)],
      '/usr/local/lib/devmagic-panel/lib': ['apache.sh', 'backup.sh', 'ca.sh', 'cert.sh', 'config.sh', 'hosts.sh', 'site.sh', 'trash.sh', 'validate.sh'].map((n, i) => file(n, 2_000 + i * 410)),
      '/var/lib/devmagic-panel': [dir('sites', 1), dir('trash', 1), file('installed-files', 2_410)],
      '/var/lib/devmagic-panel/sites': [file('local.northwind.com', 96, 9), file('local.dailypost.test', 96, 4)],
      '/var/lib/devmagic-panel/trash': 'only root can list this',
      '/etc/ssl/localcerts/devmagic-panel-ca': [file('ca.crt', 1_294, 30), file('ca.key', 3_243, 30), file('ca.srl', 41, 1)],
      '/home/acmeco/devmagic-panel-backups': [dir('snapshots', 1), file('backup-20261025-091400.tar.gz', 48_210, 1), file('backup-20261024-171200.tar.gz', 47_980, 2)],
      '/home/acmeco/.local/share/devmagic-panel/uploads': [dir('3f2a91c0-5b6d-4e1f-9a7c-2d4e6f8a0b1c', 0)],
      '/home/acmeco/.local/share/devmagic-panel/uploads/3f2a91c0-5b6d-4e1f-9a7c-2d4e6f8a0b1c': [file('meta.json', 1_830, 0), file('northwind-2026-10-24.sql.gz', 412_000_000, 0)],
      '/home/acmeco/.local/state/devmagic-panel/logs': [file('install-20261023-142010.log', 21_877, 3), file('install-20261025-091500.log', 18_204, 1)],
    };
    const found = folders[path];
    if (typeof found === 'string') return { path, entries: [], more: 0, error: found };
    return { path, entries: found ?? [], more: 0 };
  },
  update: async (refresh) => {
    await wait(refresh ? 900 : 200);
    return { ...mockUpdate, ...mockUpdateVariant(), checkedAt: new Date().toISOString() };
  },
  developerLog: async (name) => {
    await wait(200);
    return {
      name,
      text: [
        'devmagic-panel install.sh, 2026-10-25T09:15:00+03:00, v0.4.0-12-g73cfec1',
        '==> Checking the system',
        'ok: Ubuntu 24.04.3 LTS, node v22.20.0',
        '==> Writing /etc/devmagic-panel/config.env',
        '==> Checking required packages',
        'ok: required packages present',
        '==> Installing root scripts to /usr/local/lib/devmagic-panel',
        '==> Panel password and MySQL admin account',
        '   (the questions and answers of this step are not logged)',
        '==> Installing the systemd user service',
        '==> Writing the list of installed files to /var/lib/devmagic-panel/installed-files',
        'ok: devmagic-panel is installed: https://local.devmagic',
      ].join('\n'),
    };
  },
  developerStartup: async () => {
    await wait(200);
    return {
      text: [
        '2026-10-25T09:16:02+03:00 magic systemd[1873]: Started devmagic-panel.service - devmagic-panel.',
        '2026-10-25T09:16:03+03:00 info Server listening at http://127.0.0.1:4710',
        '2026-10-25T11:02:40+03:00 warn trash purge: no deleted sites yet',
      ].join('\n'),
    };
  },
  run: async (id) => {
    const run = runs.find((r) => r.id === id);
    if (!run) throw new Error('No such run');
    const job = [...mockJobs.values()].find((j) => j.runId === id);
    const output = run.skipped
      ? 'done    Clone the repo\ndone    Create the database\nskipped Run the build\nsh: 1: vite: not found\ndone    Flush caches\ndone, 1 step skipped'
      : run.interrupted
      ? 'done    Snapshot the database first\nrunning Import the dump\nInterrupted: the panel stopped before this run finished.'
      : run.ok
        ? 'ok: done (mockup)'
        : 'Error: /etc/hosts has no devmagic-panel block yet (mockup)';
    return { ...run, input: { domain: run.target }, output, ...(job ? { jobId: job.id } : {}) };
  },
  upload: async (file, onProgress) => {
    const result = await mockUpload(file, onProgress);
    mockUploads.set(result.id, result);
    return result;
  },
  uploadInfo: async (id) => {
    // An upload the mockup made answers with what it read; any other is the store dump an organization's links found.
    const made = mockUploads.get(id);
    if (made) return wait(150).then(() => structuredClone(made));
    return mockStoreUpload(id);
  },
  createSite: async (input) => {
    await wait(300);
    const id = `mock-${Date.now()}`;
    const job: JobView = { id, title: `Create ${input.domain}`, target: input.domain, kind: 'site.create', status: 'running', steps: previewSteps(input, 'new_site', undefined, coreVersions), undo: [], undoable: ['Remove the hosts entry', 'Remove the vhost', 'Remove the certificate', 'Remove the site folder'], progress: 0, startedAt: new Date().toISOString(), runId: 900 + mockJobs.size };
    mockJobs.set(id, job);
    // As in the panel: the draft stays while its install runs, goes once the site is in place, and opens again when it fails.
    const draftId = input.draftId;
    const draft = draftId ? mockDrafts.get(draftId) : undefined;
    if (draftId && draft) {
      const { expiresAt: _gone, ...rest } = draft;
      mockDrafts.set(draftId, { ...rest, status: 'installing', jobId: id });
      const watch = window.setInterval(() => {
        const status = mockJobs.get(id)?.status;
        if (status === 'running' || status === 'queued') return;
        window.clearInterval(watch);
        const d = mockDrafts.get(draftId);
        if (!d) return;
        if (status === 'done') mockDrafts.delete(draftId);
        else mockDrafts.set(draftId, { ...d, status: 'failed', expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString() });
      }, 500);
    }
    // As in the panel, the steps the site works without can be skipped when they fail.
    for (const step of job.steps) {
      const skippable = MOCK_SKIPPABLE[step.id];
      if (skippable) step.skippable = skippable;
    }
    // The first install fails at the database; the first with a build after that fails at the build.
    const failAt = failNextAtDb && input.source !== 'empty' ? 'db' : failNextAtBuild && job.steps.some((s) => s.id === 'build') ? 'build' : undefined;
    if (failAt === 'build') failNextAtBuild = false;
    failNextAtDb = false;
    advance(job, 'steps', failAt);
    return id;
  },
  removal: async () => {
    await wait(400);
    return { refusal: null, sizeBytes: 1_740_000_000, freeBytes: 102_000_000_000, trashDays: 14 };
  },
  orgStatus: async () => {
    await wait(900);
    // ?claude=missing, signed-out or api in the address shows the organization card's other states.
    const as = new URLSearchParams(window.location.search).get('claude');
    const found = as !== 'missing';
    const signedIn = found && as !== 'signed-out';
    return {
      claude: { found, ...(found ? { path: '/home/acmeco/.local/bin/claude', version: '2.1.309' } : {}), signedIn, claudeAi: signedIn && as !== 'api' },
      // ?gh=signed-out in the address shows the stored list without the GitHub CLI.
      gh: new URLSearchParams(window.location.search).get('gh') === 'signed-out' ? { installed: true, signedIn: false, problem: 'not signed in: run gh auth login' } : { installed: true, signedIn: true, user: 'acmeco' },
      // ?glab=missing or signed-out in the address shows the GitLab CLI's other states.
      glab: ((as) =>
        as === 'missing'
          ? { installed: false, hosts: ['gitlab.com', ...mockOrgSettings.gitlabHosts].map((host) => ({ host, installed: false, signedIn: false, problem: 'the GitLab CLI (glab) is not installed' })) }
          : {
              installed: true,
              version: '1.36.0',
              hosts: ['gitlab.com', ...mockOrgSettings.gitlabHosts].map((host) =>
                as === 'signed-out' || host !== 'gitlab.com' ? { host, installed: true, signedIn: false, problem: `not signed in to ${host}: run glab auth login --hostname ${host}` } : { host, installed: true, signedIn: true, user: 'acmeco' },
              ),
            })(new URLSearchParams(window.location.search).get('glab')),
      // ?rclone=1 in the address shows a Google Drive remote set up, with its Download button.
      rclone: new URLSearchParams(window.location.search).get('rclone') === '1' ? { installed: true, remote: 'gdrive' } : { installed: false },
      settings: mockOrgSettings,
    };
  },
  saveOrgSettings: async (settings) => {
    await wait(150);
    mockOrgSettings = settings;
    return settings;
  },
  orgTest: async () => {
    await wait(1500);
    return { asana: true, drive: true, docs: true, costUsd: 0.004 };
  },
  orgOrgs: async () => {
    await wait(300);
    const ns = (ref: string, label: string, provider: 'github' | 'gitlab', host: string) => ({ ref, label, provider, host });
    return {
      namespaces: [
        ns('acme', 'acme (GitHub)', 'github', 'github.com'),
        ns('acme-labs', 'acme-labs (GitHub)', 'github', 'github.com'),
        ns('acmeco', 'acmeco (GitHub)', 'github', 'github.com'),
        ns('gitlab.com/acme-web', 'acme-web (gitlab.com)', 'gitlab', 'gitlab.com'),
        ns('gitlab.com/partners/acme-team', 'partners/acme-team (gitlab.com)', 'gitlab', 'gitlab.com'),
        ns('~shared', 'Shared with you (GitHub)', 'github', 'github.com'),
        ns('gitlab.com/acmeco', 'acmeco (gitlab.com)', 'gitlab', 'gitlab.com'),
        ns('gitlab.com/~shared', 'Shared with you (gitlab.com)', 'gitlab', 'gitlab.com'),
      ],
      problems: [],
    };
  },
  gitHosts: async () => ({ gitlab: mockOrgSettings.gitlabHosts, detected: { 'code.acme.test': 'Gitea' as const }, aliases: { 'gitlab-work': 'gitlab.com' } }),
  orgRepos: async (org, scan) => {
    // The stored list comes at once; a check finds one new repo, a full list takes longer. ?scan=fail shows GitHub timing out.
    if (org === 'gitlab.com/~shared') {
      await wait(scan === 'none' ? 150 : 700);
      const at = new Date(Date.now() - 6 * 86_400_000).toISOString();
      return { repos: [{ org, name: 'client-site', fullName: 'partner/client-site', description: 'A partner agency site you were added to', sshUrl: 'git@gitlab.com:partner/client-site.git', url: 'https://gitlab.com/partner/client-site', defaultBranch: 'main', pushedAt: at, archived: false, kind: 'site' }], ...mockOrgScan };
    }
    if (org === 'gitlab.com/acme-web') {
      await wait(scan === 'none' ? 150 : 900);
      return { repos: structuredClone(mockGitlabRepos), ...mockOrgScan };
    }
    if (org !== 'acme') return { repos: [] };
    const due = scan === 'check' || scan === 'full' || (scan === 'auto' && Date.now() - Date.parse(mockOrgScan.checkedAt) > 3_600_000);
    await wait(scan === 'none' ? 150 : !due ? 200 : scan === 'full' ? 2500 : 1500);
    if (due && new URLSearchParams(window.location.search).get('scan') === 'fail') {
      return { repos: structuredClone(mockOrgRepos), ...mockOrgScan, problem: 'the GitHub CLI cannot list the repos of acme: HTTP 504: 504 Gateway Timeout (https://api.github.com/orgs/acme/repos)' };
    }
    if (due) {
      const at = new Date().toISOString();
      if (!mockOrgRepos.some((r) => r.name === 'spring-landing')) {
        mockOrgRepos.unshift({ org: 'acme', name: 'spring-landing', fullName: 'acme/spring-landing', description: 'Landing pages for the spring sale', sshUrl: 'git@github.com:acme/spring-landing.git', url: 'https://github.com/acme/spring-landing', defaultBranch: 'main', pushedAt: new Date(Date.now() - 40 * 60_000).toISOString(), archived: false, kind: 'site' });
      }
      mockOrgScan = { checkedAt: at, listedAt: scan === 'full' ? at : mockOrgScan.listedAt };
    }
    return { repos: structuredClone(mockOrgRepos), ...mockOrgScan };
  },
  downloads: async () => {
    await wait(150);
    return [{ file: '/home/acmeco/Downloads/acme-store-2026-10-24.sql.gz', name: 'acme-store-2026-10-24.sql.gz', sizeBytes: 432_000_000, modifiedAt: new Date(Date.now() - 20 * 60_000).toISOString() }];
  },
  drafts: async () => {
    await wait(150);
    return [...mockDrafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  draft: async (id) => {
    await wait(150);
    const draft = mockDrafts.get(id);
    // As the panel answers: a 404 for a draft that went.
    if (!draft) throw Object.assign(new Error('No such draft: it ran out or was finished'), { status: 404 });
    return structuredClone(draft);
  },
  saveDraft: async (id, input) => {
    const now = new Date();
    // As in the panel: the jobs, their answers and the dumps they brought stay whatever the wizard saves.
    const before = mockDrafts.get(id);
    if (before?.status === 'installing') throw Object.assign(new Error('Its install is running; follow it on the Jobs page'), { status: 409 });
    const attached = before?.attached ?? [];
    const draft: InstallDraft = {
      id, kind: input.kind ?? 'manual', title: input.title, step: input.step, state: input.state, uploads: [...new Set([...input.uploads, ...attached])], status: 'open',
      createdAt: before?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
      ...(before?.jobs ? { jobs: before.jobs } : {}), ...(before?.results ? { results: before.results } : {}), ...(attached.length ? { attached } : {}),
    };
    mockDrafts.set(id, draft);
    return draft;
  },
  discardDraft: async (id) => {
    await wait(150);
    mockDrafts.delete(id);
  },
  trash: async () => {
    await wait(200);
    return structuredClone(mockTrash).map((e) => {
      const job = busyJob(e.domain);
      return job ? { ...e, busy: { jobId: job.id, title: job.title } } : e;
    });
  },
  removeSite: async (domain) => {
    await wait(300);
    const id = `mock-remove-${Date.now()}`;
    const steps = ['Back up vhosts, certificates and hosts', 'Export the database', 'Archive the site', 'Remove the vhost, certificate, hosts line and folder', 'Drop the database and its user'];
    const site = sites.find((s) => s.domain === domain);
    window.setTimeout(() => {
      mockTrash.unshift({ id: `${domain}-20261024-180000`, domain, deletedAt: new Date().toISOString(), purgeAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), sizeBytes: 1_200_000_000, panelMade: site?.panelMade ?? false, ...(site?.db ? { dbName: site.db.name } : {}), reason: 'deleted', hasDump: Boolean(site?.db), ...(site?.install ? { install: site.install } : {}) });
    }, 3000);
    const job: JobView = { id, title: `Remove ${domain}`, target: domain, kind: 'site.remove', status: 'running', steps: steps.map((label, i) => ({ id: `s${i}`, label, status: 'pending' })), undo: [], undoable: [], progress: 0, startedAt: new Date().toISOString(), runId: 900 + mockJobs.size };
    mockJobs.set(id, job);
    advance(job, 'steps');
    return id;
  },
  job: async (id) => structuredClone(mockJobs.get(id) as JobView),
  jobs: async () => [...mockJobs.values()].map((j) => structuredClone(j)).reverse(),
  mail: async (site) => {
    await wait(200);
    if (!mailpitRunning) throw new Error('Mailpit is not reachable: connect ECONNREFUSED 127.0.0.1:8025');
    const messages = mockMail.filter((m) => !site || m.site === site).map(({ text: _t, html: _h, ...m }) => m);
    return { total: messages.length, messages };
  },
  mailUnread: async () => ({ unread: mailpitRunning ? mockMail.filter((m) => !m.read).length : null }),
  mailMessage: async (id) => {
    await wait(150);
    const m = mockMail.find((x) => x.id === id);
    if (!m) throw new Error('No such message');
    m.read = true;
    return { id: m.id, from: m.from, to: m.to, subject: m.subject, date: m.date, text: m.text, html: m.html };
  },
  retryJob: async (id) => {
    const job = mockJobs.get(id) as JobView;
    const failed = job.steps.find((s) => s.status === 'failed');
    if (failed) {
      failed.status = 'pending';
      delete failed.output;
    }
    job.status = 'running';
    advance(job, 'steps');
    return structuredClone(job);
  },
  skipJob: async (id) => {
    const job = mockJobs.get(id) as JobView;
    const failed = job.steps.find((s) => s.status === 'failed');
    if (!failed?.skippable) throw new Error('only a failed step the panel marks as skippable can be skipped');
    failed.status = 'skipped';
    job.status = 'running';
    advance(job, 'steps');
    return structuredClone(job);
  },
  undoJob: async (id) => {
    const job = mockJobs.get(id) as JobView;
    if (job.undoable.length === 0) throw new Error('this job cannot be undone now');
    job.status = 'undoing';
    job.undo = job.undoable.map((label, i) => ({ id: `undo-${i}`, label, status: 'pending' }));
    job.undoable = [];
    advance(job, 'undo');
    return structuredClone(job);
  },
  cores: async () => coreVersions,
  coresReport: async (): Promise<CoresReport> => {
    await wait(250);
    const status: Record<string, CoresReport['available'][number]['status']> = { '7.1.3': 'latest', '7.0.4': 'insecure', '6.8.3': 'insecure' };
    return {
      coresDir: '/var/www/wp-cores',
      ready: true,
      latest: '7.1.3',
      cores: coreVersions.map((version) => ({
        version,
        ...(status[version] ? { status: status[version] } : {}),
        sites: sites.filter((s) => s.core.kind === 'wpcore' && s.core.version === version).map((s) => s.domain),
      })),
      standalone: sites.flatMap((s) => (s.core.kind === 'standalone' && s.core.version ? [{ domain: s.domain, version: s.core.version, status: 'outdated' as const }] : [])),
      available: [{ version: '7.0.7', status: 'outdated' }, { version: '6.9.10', status: 'outdated' }],
      insecure: ['7.1.2', '7.0.4', '6.8.3', '6.8.1'],
    };
  },
  playRun,
};

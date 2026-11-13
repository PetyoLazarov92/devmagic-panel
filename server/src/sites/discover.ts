import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, type Stats, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Site, SiteCert, SiteConstant, SiteGit, SiteIssue, SiteNetwork, SiteRepo, SiteRepoKind } from '@devmagic-panel/shared';
import { isLocalName, siteDir, isSecretConstant, onNginxAddress, SITE_SERVER_LABEL, MEDIA_PLUGIN, MEDIA_PLUGIN_URL, networkType, SYSTEM_DATABASES, WP_DEBUG_CONSTANTS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { latestOf, type CoreStatusMap } from '../core-status.js';
import { hostsNames } from '../environment.js';
import type { Executor } from '../exec.js';
import { freshStatsSql } from '../mysql-stats.js';
import { poolFolder, readPools } from '../php/pools.js';
import { apachePhpVersion, fpmDefaultVersion, installedVersions } from '../php/versions.js';
import type { Secrets } from '../secrets.js';
import { installedCores, readWpcoreConfig } from '../wpcore.js';
import { hasNetworkRules, htaccessIgnored, readHtaccess, siteKind, staticRules } from './htaccess.js';
import { hostsBlockAddress } from './hosts-block.js';
import { readLocalMode } from './local-mode.js';
import { parseDebugLog, tailFile } from './logs.js';
import { readSiteVhosts, siteAddress, siteServer, type VhostInfo } from './vhost.js';
import { saltStatus } from './salts.js';
import { parseWpConfig, parseWpVersion, type WpConfig } from './wpconfig.js';
import { removalRefusal } from './remove.js';
import { isPanelFolder, siteRegistryEntry } from './registry.js';

export { isPanelFolder, siteRegistryEntry };
import { apachePaths, moveFacts } from './server-switch.js';
import { readHtaccessReport, ruleDiff } from './htaccess-rules.js';

export interface DiscoverContext {
  config: SystemConfig;
  exec: Executor;
  secrets: Secrets | null;
  wpcoreConf: string;
  /** WordPress.org's status per version; null when unknown (offline). */
  coreStatus?: CoreStatusMap | null;
  /** The .htaccess checksums of a change to a site on nginx you put off (Not now), from the panel's database. */
  htaccessDismissed?: (domain: string) => Record<string, string> | undefined;
  /** Folders of a site (domain and path) the panel cloned repos into, from how it was installed. */
  repoPaths?: (site: string) => string[];
  now?: () => number;
}

const SQL_NAME = /^[A-Za-z0-9_$-]{1,64}$/;
const ident = (name: string) => `\`${name}\``;
/** A column in one charset, so a UNION over tables of mixed collations runs. */
const utf8 = (column: string) => `CONVERT(${column} USING utf8mb4)`;

// ── certificates ─────────────────────────────────────────────

export function parseCertText(text: string): Omit<SiteCert, 'issuer'> & { issuerText: string } {
  const notAfter = /notAfter=(.+)/.exec(text)?.[1]?.trim() ?? '';
  const issuerText = /issuer=(.+)/.exec(text)?.[1]?.trim() ?? '';
  const sanBlock = /Subject Alternative Name:\s*\n\s*(.+)/.exec(text)?.[1] ?? '';
  const names = [...sanBlock.matchAll(/DNS:([^,\s]+)/g)].map((m) => (m[1] as string).toLowerCase());
  const expires = new Date(notAfter);
  return { expiresAt: Number.isNaN(expires.getTime()) ? '' : expires.toISOString(), names, issuerText };
}

async function readCert(exec: Executor, file: string, legacyIssuer: string | null): Promise<SiteCert | undefined> {
  const out = await exec('openssl', ['x509', '-in', file, '-noout', '-enddate', '-issuer', '-ext', 'subjectAltName']);
  if (out.code !== 0) return undefined;
  const { issuerText, ...cert } = parseCertText(out.stdout);
  const issuer: SiteCert['issuer'] = /devmagic-panel/.test(issuerText)
    ? 'new'
    : legacyIssuer && issuerText === legacyIssuer
      ? 'legacy'
      : 'unknown';
  return { ...cert, issuer };
}

async function legacyIssuerOf(exec: Executor, config: SystemConfig): Promise<string | null> {
  const pem = join(config.CERTS_DIR, 'cert-issuer', 'LocalhostCA.pem');
  if (!existsSync(pem)) return null;
  const out = await exec('openssl', ['x509', '-in', pem, '-noout', '-subject']);
  return out.code === 0 ? (/subject=(.+)/.exec(out.stdout)?.[1]?.trim() ?? null) : null;
}

// ── git ──────────────────────────────────────────────────────

export async function readGit(exec: Executor, dir: string): Promise<SiteGit | { error: string } | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined;
  const git = (...args: string[]) => exec('git', ['-C', dir, ...args], { timeoutMs: 10_000 });
  const [head, remote, upstream, status, log] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('remote', 'get-url', 'origin'),
    git('rev-parse', '--abbrev-ref', '@{upstream}'),
    git('status', '--porcelain'),
    git('log', '-1', '--format=%h%x1f%s%x1f%an%x1f%aI'),
  ]);
  if (head.code !== 0) {
    const reason = /dubious ownership/.test(head.stderr) ? 'git refuses this folder (dubious ownership)' : head.stderr.trim().split('\n')[0] ?? 'git failed';
    return { error: reason };
  }
  const hasUpstream = upstream.code === 0 && upstream.stdout.trim() !== '';
  let ahead = 0;
  let behind = 0;
  if (hasUpstream) {
    const counts = await git('rev-list', '--left-right', '--count', '@{upstream}...HEAD');
    const [b = '0', a = '0'] = counts.stdout.trim().split(/\s+/);
    behind = Number(b) || 0;
    ahead = Number(a) || 0;
  }
  const [hash = '', subject = '', author = '', date = ''] = log.stdout.trim().split('\x1f');
  return {
    ...(remote.code === 0 && remote.stdout.trim() ? { remote: remote.stdout.trim() } : {}),
    branch: head.stdout.trim(),
    upstream: hasUpstream ? upstream.stdout.trim() : null,
    dirty: status.stdout.split('\n').filter((l) => l.trim()).length,
    ahead,
    behind,
    lastCommit: { hash, subject, author, date },
  };
}

// ── WordPress core ───────────────────────────────────────────

/** A site has at most this many repos inside its folder; more is a vendor folder, not a site. */
export const MAX_SITE_REPOS = 20;

const isRealDir = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The repos inside a site's own folder: wp-content itself, then each theme,
 * plugin and must-use plugin folder one level down that has a .git, by name.
 * A folder reached through a symlink is left out, as it is another place.
 */
export function findSiteRepos(docroot: string, cloned: readonly string[] = []): Array<Omit<SiteRepo, 'git'>> {
  const found: Array<Omit<SiteRepo, 'git'>> = [];
  // Repos the panel cloned elsewhere in the site: only real folders inside it, reached without a link, that still have a .git.
  const extra = cloned.filter((p) => p && siteDir.safeParse(p).success && p.split('/').every((_, i, parts) => isRealDir(join(docroot, ...parts.slice(0, i + 1)))) && existsSync(join(docroot, p, '.git')));
  const content = join(docroot, 'wp-content');
  if (!isRealDir(content)) return [...new Set(extra)].slice(0, MAX_SITE_REPOS).map((p) => ({ folder: p, kind: 'folder' as const, name: p.split('/').pop() as string }));
  if (existsSync(join(content, '.git'))) found.push({ folder: 'wp-content', kind: 'wp-content', name: 'wp-content' });
  const kinds: Array<[string, SiteRepoKind]> = [['themes', 'theme'], ['plugins', 'plugin'], ['mu-plugins', 'mu-plugin']];
  for (const [dir, kind] of kinds) {
    const parent = join(content, dir);
    if (!isRealDir(parent)) continue;
    let names: string[];
    try {
      names = readdirSync(parent).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..').sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const name of names) {
      const folder = join(parent, name);
      if (isRealDir(folder) && existsSync(join(folder, '.git'))) found.push({ folder: `wp-content/${dir}/${name}`, kind, name });
    }
  }
  const known = new Set(found.map((r) => r.folder));
  for (const p of new Set(extra)) if (!known.has(p)) found.push({ folder: p, kind: 'folder', name: p.split('/').pop() as string });
  return found.slice(0, MAX_SITE_REPOS);
}

export function readCore(docroot: string): Site['core'] {
  const includes = join(docroot, 'wp-includes');
  try {
    if (lstatSync(includes).isSymbolicLink()) {
      const target = readlinkSync(includes);
      return { kind: 'wpcore', version: basename(dirname(target)) };
    }
  } catch {
    // no wp-includes at all
  }
  const versionFile = join(includes, 'version.php');
  if (existsSync(versionFile)) {
    const version = parseWpVersion(readFileSync(versionFile, 'utf8'));
    return version ? { kind: 'standalone', version } : { kind: 'standalone' };
  }
  return { kind: 'none' };
}

const compareVersions = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// ── database ─────────────────────────────────────────────────

type Mysql = (sql: string) => Promise<string[][] | null>;

function mysqlRunner(exec: Executor, secrets: Secrets | null): Mysql | null {
  const account = secrets?.mysql;
  if (!account) return null;
  return async (sql) => {
    // utf8mb4 by name: the service has no UTF-8 locale, and the client's own default turns a title in Cyrillic into question marks.
    const out = await exec('mysql', ['--batch', '--skip-column-names', '--user', account.user, '--host', account.host, '--default-character-set=utf8mb4', '-e', sql], {
      env: { MYSQL_PWD: account.password },
      timeoutMs: 15_000,
    });
    if (out.code !== 0) return null;
    return out.stdout.split('\n').filter(Boolean).map((row) => row.split('\t'));
  };
}

/** Each database's size and table count; null when MySQL could not be read, which is not the same as no databases. */
async function databaseSizes(mysql: Mysql | null, fresh: () => Promise<string>): Promise<Map<string, { sizeBytes: number; tables: number }> | null> {
  const sizes = new Map<string, { sizeBytes: number; tables: number }>();
  // Fresh, not the day-old sizes MySQL 8 keeps; MySQL's own databases are left out.
  const rows = mysql
    ? await mysql(`${await fresh()}SELECT table_schema, COALESCE(SUM(data_length + index_length), 0), COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ')}) GROUP BY table_schema`)
    : null;
  if (!rows) return null;
  for (const [schema, size, count] of rows) {
    if (schema) sizes.set(schema, { sizeBytes: Number(size) || 0, tables: Number(count) || 0 });
  }
  return sizes;
}

/**
 * The production host BE Media from Production loads missing uploads from:
 * the plugin is in the site and wp-config.php sets its URL constant.
 */
export function mediaPluginHost(docroot: string, configText: string): string | undefined {
  if (!existsSync(join(docroot, 'wp-content', 'plugins', MEDIA_PLUGIN))) return undefined;
  const m = new RegExp(`^\\s*define\\s*\\(\\s*['"]${MEDIA_PLUGIN_URL}['"]\\s*,\\s*['"]([^'"]+)['"]`, 'm').exec(configText);
  if (!m) return undefined;
  try {
    return new URL(m[1] as string).host || undefined;
  } catch {
    return undefined;
  }
}

/** Whether the database has BE Media from Production active, on the site or network wide; null when it cannot be read. */
async function mediaPluginActive(mysql: Mysql | null, wp: WpConfig): Promise<boolean | null> {
  if (!mysql || !wp.dbName || !wp.tablePrefix || !SQL_NAME.test(wp.dbName) || !SQL_NAME.test(wp.tablePrefix)) return null;
  const db = ident(wp.dbName);
  const rows = await mysql(
    wp.multisite
      ? `SELECT ${utf8('option_value')} FROM ${db}.${ident(`${wp.tablePrefix}options`)} WHERE option_name = 'active_plugins' UNION ALL SELECT ${utf8('meta_value')} FROM ${db}.${ident(`${wp.tablePrefix}sitemeta`)} WHERE meta_key = 'active_sitewide_plugins'`
      : `SELECT option_value FROM ${db}.${ident(`${wp.tablePrefix}options`)} WHERE option_name = 'active_plugins'`,
  );
  return rows === null ? null : rows.some(([value]) => (value ?? '').includes(`${MEDIA_PLUGIN}/`));
}

/** Main title and, for a network, every site with its title. */
async function readWordPressData(mysql: Mysql | null, wp: WpConfig): Promise<{ title?: string; network?: SiteNetwork }> {
  // wp-config.php alone says whether this is a network; listing its sites needs the database.
  const mode = wp.subdomainInstall ? 'subdomain' : 'subdirectory';
  const bare: { network?: SiteNetwork } = wp.multisite ? { network: { mode, type: mode, sites: [] } } : {};
  if (!mysql || !wp.dbName || !wp.tablePrefix || !SQL_NAME.test(wp.dbName) || !SQL_NAME.test(wp.tablePrefix)) return bare;
  const db = ident(wp.dbName);
  const options = (id: number) => `${db}.${ident(id === 1 ? `${wp.tablePrefix}options` : `${wp.tablePrefix}${id}_options`)}`;
  const titleRows = await mysql(`SELECT option_value FROM ${options(1)} WHERE option_name = 'blogname'`);
  const title = titleRows?.[0]?.[0];
  if (!wp.multisite) return title ? { title } : {};

  const blogs = await mysql(`SELECT blog_id, domain, path, archived, spam, deleted, public FROM ${db}.${ident(`${wp.tablePrefix}blogs`)} ORDER BY blog_id LIMIT 1000`);
  const all = (blogs ?? [])
    .map(([id, domain, path, archived, spam, deleted, open]) => ({
      id: Number(id),
      domain: domain ?? '',
      path: path ?? '/',
      ...(archived === '1' ? { archived: true as const } : {}),
      ...(spam === '1' ? { spam: true as const } : {}),
      ...(open === '0' ? { hidden: true as const } : {}),
      deleted: deleted === '1',
    }))
    .filter((b) => Number.isInteger(b.id) && b.id > 0);
  const list = all.filter((b) => !b.deleted);
  const deleted = all.filter((b) => b.deleted).map((b) => ({ id: b.id, url: `https://${b.domain}${b.path}` }));
  // An old domain mapping plugin (WordPress MU Domain Mapping, Mercator) keeps the domain a site answers at in a table of its own.
  const mapped = new Map<number, string>();
  for (const [id, host] of (await mysql(`SELECT blog_id, domain FROM ${db}.${ident(`${wp.tablePrefix}domain_mapping`)} WHERE active = 1 ORDER BY id`)) ?? []) {
    if (host && !mapped.has(Number(id))) mapped.set(Number(id), host.toLowerCase());
  }
  const sites = list.map((b) => (mapped.has(b.id) ? { ...b, domain: mapped.get(b.id) as string, path: '/' } : b));
  const titles = new Map<number, string>();
  if (list.length > 0) {
    const union = list
      .map((b) => `SELECT ${b.id}, ${utf8('option_value')} FROM ${options(b.id)} WHERE option_name = 'blogname'`)
      .join(' UNION ALL ');
    for (const [id, value] of (await mysql(union)) ?? []) titles.set(Number(id), value ?? '');
  }
  return {
    ...(title ? { title } : {}),
    network: {
      mode,
      type: networkType(sites) ?? mode,
      sites: sites.map(({ id, domain, path, deleted: _deleted, ...flags }) => ({ id, url: `https://${domain}${path}`, title: titles.get(id) || `${domain}${path}`, ...flags })),
      ...(deleted.length > 0 ? { deleted } : {}),
    },
  };
}

// ── health ───────────────────────────────────────────────────

function healthOf(issues: SiteIssue[]): Site['health'] {
  if (issues.some((i) => i.status === 'fail')) return 'fail';
  return issues.length > 0 ? 'warn' : 'ok';
}

function debugLogPath(docroot: string, wp: WpConfig): string {
  return typeof wp.debugLog === 'string' && wp.debugLog.startsWith('/') ? wp.debugLog : join(docroot, 'wp-content', 'debug.log');
}

/**
 * Insecure or outdated cores, from WordPress.org's list. The fix switches a
 * shared-core site to the newest installed core that is safe. Offline, a
 * site is only compared with the installed cores.
 */
export function coreIssueFor(domain: string, core: Site['core'], installed: string[], status: CoreStatusMap | null, path?: string): SiteIssue | null {
  const version = core.version;
  if (!version) return null;
  const latest = status ? latestOf(status) : undefined;
  const state = status?.[version];
  const better = installed.find((v) => compareVersions(v, version) > 0 && status?.[v] !== 'insecure');
  const fix: Pick<SiteIssue, 'fix' | 'hint'> =
    core.kind === 'wpcore' && better
      ? { fix: { action: 'core.switch', input: { domain, ...(path ? { path } : {}), version: better }, label: `Switch to ${better}` } }
      : core.kind === 'wpcore'
        ? { hint: `Add WordPress ${latest ?? 'latest'} on the WordPress page, then switch this site to it.` }
        : { hint: 'This site has its own copy of WordPress: update it with wp core update.' };

  if (state === 'insecure') {
    return { id: 'core.insecure', status: 'fail', text: `WordPress ${version} has known security issues${latest ? ` (latest is ${latest})` : ''}`, ...fix };
  }
  if (state === 'outdated') {
    return { id: 'core.outdated', status: 'warn', text: `WordPress ${version} is outdated${latest ? ` (latest is ${latest})` : ''}`, ...fix };
  }
  if (!status && better) {
    return { id: 'core.outdated', status: 'warn', text: `WordPress ${version} is older than the newest installed core (${installed[0]})`, ...fix };
  }
  return null;
}

// ── discovery ────────────────────────────────────────────────

/** True when a folder holds fewer than limit files, counted until the limit (or it does not exist). */
export function fewFiles(dir: string, limit: number): boolean {
  let count = 0;
  const walk = (d: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!walk(join(d, e.name))) return false;
      } else if (++count >= limit) {
        return false;
      }
    }
    return true;
  };
  return walk(dir);
}

/** A group's id from /etc/group, or undefined. */
function groupId(name: string): number | undefined {
  try {
    const line = readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
    const gid = line ? Number(line.split(':')[2]) : NaN;
    return Number.isInteger(gid) ? gid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wp-content folders the web server group cannot write to. Fixable means
 * every one is owned by the panel user and already in that group, so a chmod
 * as the panel user is enough; anything else needs a hand-run sudo.
 */
export function unwritableByWeb(docroot: string, webGroup: string, gid = groupId(webGroup)): { dirs: string[]; fixable: boolean } {
  const dirs: string[] = [];
  let fixable = true;
  for (const d of ['', 'plugins', 'themes', 'uploads']) {
    let st: Stats;
    try {
      st = statSync(join(docroot, 'wp-content', d));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const writable = (st.mode & 0o002) !== 0 || (gid !== undefined && st.gid === gid && (st.mode & 0o020) !== 0);
    if (writable) continue;
    dirs.push(d);
    if (gid === undefined || st.gid !== gid || st.uid !== process.getuid?.()) fixable = false;
  }
  return { dirs, fixable };
}

/** The registry entry dmp-root writes for a folder it creates (scripts/lib/site.sh): the path, then device:inode. */


/**
 * True when the panel created this site's folder. Only for showing the remove
 * button: dmp-root checks the same entry, and that it is root-owned, before it deletes anything.
 */
/** wp-config.php's constants for the page: the value of one that looks like a secret stays here. */
export function siteConstants(wp: WpConfig): SiteConstant[] {
  return wp.constants.map((c) => (isSecretConstant(c.name) ? { name: c.name, hidden: true as const } : c));
}

/** When a folder was made: its birth time, or its last change where the filesystem keeps none. */
export function folderTime(dir: string): string | undefined {
  try {
    const st = statSync(dir);
    return (st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
  } catch {
    return undefined;
  }
}


type Shared = { legacyIssuer: string | null; sizes: Map<string, { sizeBytes: number; tables: number }>; /** Whether the sizes were read, so a database missing from them is missing from MySQL. */ read: boolean; hosts: Set<string>; hostsText: string; cores: string[]; mysql: Mysql | null };

/** A mounted folder that is a WordPress install of its own: it shows as a site, not as a folder of its parent. */
const isWordPressMount = (m: { docroot: string }) => existsSync(join(m.docroot, 'wp-config.php'));

/**
 * One site: the vhost's own WordPress install, or with `mount` the install an
 * Alias serves under a path of the same domain. A site under a path has its
 * own folder, database, git, debug, logs and Local mode; the vhost,
 * certificate and hosts line (and their issues) belong to the parent.
 */
async function discoverOne(ctx: DiscoverContext, vhost: VhostInfo, shared: Shared, mount?: { path: string; docroot: string }): Promise<Site> {
  const docroot = mount?.docroot ?? (vhost.docroot as string);
  const path = mount?.path;
  const at = path ? { path } : {};
  const now = ctx.now?.() ?? Date.now();
  const names = vhost.names.filter(isLocalName);
  const domain = names[0] as string;
  const configFile = join(docroot, 'wp-config.php');
  const configText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
  const wp = configText !== null ? parseWpConfig(configText) : null;
  const mediaHost = configText !== null ? mediaPluginHost(docroot, configText) : undefined;
  const hasMediaPlugin = wp !== null && existsSync(join(docroot, 'wp-content', 'plugins', MEDIA_PLUGIN));
  // Folders mounted into the site that are not WordPress installs of their own; those show as sites.
  const folders = mount ? [] : vhost.mounts.filter((m) => !isWordPressMount(m));

  const inner = findSiteRepos(docroot, ctx.repoPaths?.(`${domain}${path ?? ''}`) ?? []);
  // A database MySQL does not have (a site whose dump is not imported yet) is not asked about: each read of it would fail.
  const dbMysql = wp?.dbName && shared.read && !shared.sizes.has(wp.dbName) ? null : shared.mysql;
  const [cert, git, mountGits, innerGits, wpData, mediaActive] = await Promise.all([
    vhost.certFile && !mount ? readCert(ctx.exec, vhost.certFile, shared.legacyIssuer) : Promise.resolve(undefined),
    readGit(ctx.exec, docroot),
    Promise.all(folders.map((m) => readGit(ctx.exec, m.docroot))),
    Promise.all(inner.map((r) => readGit(ctx.exec, join(docroot, r.folder)))),
    wp ? readWordPressData(dbMysql, wp) : Promise.resolve<{ title?: string; network?: SiteNetwork }>({}),
    // Only asked when the site has the plugin; without the database it counts as on.
    wp && hasMediaPlugin ? mediaPluginActive(dbMysql, wp) : Promise.resolve(null),
  ]);

  const core = readCore(docroot);
  const localMode = wp ? readLocalMode(docroot) : undefined;
  const issues: SiteIssue[] = [];

  // dmp-root reissues only certs it can find by the site's own names.
  const reissue: SiteIssue['fix'] =
    basename(vhost.file) === (vhost.server === 'nginx' ? `${domain}.conf` : `${domain}-ssl.conf`) && vhost.certFile === join(ctx.config.CERTS_DIR, domain, `${domain}.crt`)
      ? { action: 'cert.reissue', input: { domain }, label: 'Reissue cert' }
      : undefined;
  const certHint = reissue ? {} : { hint: `The vhost loads its cert from ${vhost.certFile ?? 'nowhere'}; reissue it by hand.` };
  const certFix = reissue ? { fix: reissue } : certHint;

  if (mount) {
    // The vhost, certificate and hosts line are the parent's, and so are their issues.
  } else if (!cert) issues.push({ id: 'cert.missing', status: 'fail', text: 'No readable certificate for this vhost', ...certFix });
  else {
    const missing = names.filter((n) => !cert.names.includes(n));
    if (missing.length) {
      issues.push({ id: 'cert.uncovered', status: 'warn', text: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not covered by the cert`, ...certFix });
    }
    if (cert.issuer === 'legacy') issues.push({ id: 'cert.legacy', status: 'warn', text: 'Cert still signed by the old LocalhostCA', ...certFix });
    const days = (new Date(cert.expiresAt).getTime() - now) / 86_400_000;
    if (days < 0) issues.push({ id: 'cert.expired', status: 'fail', text: 'Certificate has expired', ...certFix });
    else if (days < 30) issues.push({ id: 'cert.expiring', status: 'warn', text: `Certificate expires in ${Math.floor(days)} days`, ...certFix });
  }

  const notInHosts = mount ? [] : names.filter((n) => !shared.hosts.has(n));
  if (notInHosts.length) {
    issues.push({
      id: 'hosts.missing',
      status: 'warn',
      text: `${notInHosts.join(', ')} ${notInHosts.length === 1 ? 'is' : 'are'} missing from /etc/hosts`,
      fix: { action: 'hosts.add', input: { domain, aliases: names.slice(1) }, label: 'Add to hosts' },
    });
  }
  // The panel's hosts line goes where the site runs: another address sends it to the other server.
  const lineAddress = mount ? undefined : hostsBlockAddress(shared.hostsText, domain);
  const wanted = siteAddress(ctx.config, vhost);
  if (lineAddress && lineAddress !== wanted && (onNginxAddress(siteServer(vhost)) || lineAddress === ctx.config.NGINX_ADDRESS)) {
    issues.push({
      id: 'hosts.server',
      status: 'fail',
      text: `/etc/hosts sends ${domain} to ${lineAddress}, but it runs on ${SITE_SERVER_LABEL[siteServer(vhost)]} at ${wanted}`,
      fix: { action: 'hosts.add', input: { domain, aliases: names.slice(1) }, label: 'Point it there' },
    });
  }

  // A subdomain network's sites answer at hosts of their own: one the vhost or /etc/hosts lacks does not open here.
  let network = wpData.network;
  if (network && !mount && network.type !== 'subdirectory') {
    const hostOf = (url: string) => url.replace(/^https:\/\//, '').split('/')[0] ?? '';
    const unserved = [...new Set(network.sites.filter((s) => s.id !== 1).map((s) => hostOf(s.url)).filter((h) => !names.includes(h) || !shared.hosts.has(h)))];
    if (unserved.length) {
      network = { ...network, sites: network.sites.map((s) => (unserved.includes(hostOf(s.url)) ? { ...s, served: false as const } : s)) };
      const local = unserved.filter(isLocalName);
      const others = unserved.filter((h) => !isLocalName(h));
      const hint = [
        others.length ? `${others.join(', ')} ${others.length === 1 ? 'is not a local name' : 'are not local names'}: replace ${others.length === 1 ? 'it' : 'them'} with a local one with Search and replace on the Database tab.` : '',
        local.length && !vhost.managed ? `Add ServerAlias ${local.join(' ')} to the vhost by hand, then reissue the cert and add ${local.length === 1 ? 'it' : 'them'} to /etc/hosts. Or take the site over on its Overview, and the panel adds ${local.length === 1 ? 'it' : 'them'} for you.` : '',
      ].filter(Boolean).join(' ');
      issues.push({
        id: 'network.unserved',
        status: 'warn',
        text: `${unserved.join(', ')} ${unserved.length === 1 ? 'is a site' : 'are sites'} of the network this site does not serve here`,
        ...(vhost.managed && local.length ? { fix: { action: 'site.addAliases', input: { domain, aliases: local }, label: local.length === 1 ? 'Add as an alias' : 'Add as aliases' } } : {}),
        ...(hint ? { hint } : {}),
      });
    }
  }

  // A name in one block only: on 443 only, http:// does not redirect; on 80 only, https:// gets another site.
  const { http, https } = vhost.byPort;
  if (!mount && http.length && https.length) {
    const httpOnly = http.filter((n) => isLocalName(n) && !https.includes(n));
    const httpsOnly = https.filter((n) => isLocalName(n) && !http.includes(n));
    if (httpOnly.length || httpsOnly.length) {
      const parts = [
        httpOnly.length ? `${httpOnly.join(', ')} only on port 80 (no HTTPS)` : '',
        httpsOnly.length ? `${httpsOnly.join(', ')} only on port 443 (no redirect from http)` : '',
      ].filter(Boolean);
      issues.push({
        id: 'vhost.portDrift',
        status: 'warn',
        text: `Port 80 and 443 names differ: ${parts.join('; ')}`,
        hint: vhost.managed
          ? 'Recreate the site to rewrite its vhost with one name list.'
          : `The panel leaves this vhost as is: list the same names in both blocks of ${vhost.file}, then reissue the cert. Or take the site over on its Overview, and the panel writes one name list.`,
      });
    }
  }

  let logBytes = 0;
  if (wp) {
    const logFile = debugLogPath(docroot, wp);
    if (existsSync(logFile)) {
      logBytes = statSync(logFile).size;
      const hourAgo = now - 3_600_000;
      const fatals = parseDebugLog(tailFile(logFile, 128 * 1024), 2000).filter((l) => l.level === 'fatal' && new Date(l.time).getTime() > hourAgo).length;
      if (fatals) {
        issues.push({ id: 'php.fatals', status: 'fail', text: `${fatals} PHP fatal error${fatals === 1 ? '' : 's'} in the last hour`, hint: 'Open the Logs tab to read them.' });
      }
    }
  }

  const coreIssue = coreIssueFor(domain, core, shared.cores, ctx.coreStatus ?? null, path);
  if (coreIssue) issues.push(coreIssue);
  if (git && 'error' in git) issues.push({ id: 'git.error', status: 'warn', text: git.error });

  if (wp && vhost.server === 'nginx') {
    if (!mount) {
      // nginx reads no .htaccess: the panel translates what it can into the site's nginx file, once you review it.
      const applied = { rules: vhost.rules ?? [], sums: vhost.htaccessSums ?? {} };
      const report = readHtaccessReport(docroot, applied, Date.now(), false, ctx.htaccessDismissed?.(domain));
      const translatable = report.rules.filter((r) => r.status === 'translated').length;
      if (report.pending && !report.dismissed) {
        const recorded = Object.keys(applied.sums).length > 0;
        const { added, removed } = ruleDiff(report, applied.rules);
        const parts = [added.length ? `${added.length} rule${added.length === 1 ? '' : 's'} to add` : '', removed.length ? `${removed.length} to take out` : ''].filter(Boolean).join(' and ');
        issues.push({
          id: 'nginx.htaccess.changed',
          status: 'warn',
          text: recorded
            ? `An .htaccess changed since its rules were applied on nginx: ${parts}`
            : `${translatable} .htaccess rule${translatable === 1 ? '' : 's'} the panel can translate ${translatable === 1 ? 'is' : 'are'} not on nginx`,
          hint: 'Review and apply them on the Server and PHP tab, under .htaccess rules.',
        });
      }
      const left = report.rules.filter((r) => r.status === 'manual' || r.status === 'php');
      if (left.length) {
        issues.push({
          id: 'nginx.htaccess',
          status: 'warn',
          text: `nginx does nothing with ${left.length} .htaccess rule${left.length === 1 ? '' : 's'} the panel does not translate`,
          hint: 'The .htaccess rules card on the Server and PHP tab lists them; put nginx in front of Apache when the site needs them.',
        });
      }
    } else {
      // A site under a path of a site on nginx: its own .htaccess is not read either.
      const ignored = htaccessIgnored(readHtaccess(docroot) ?? '');
      if (ignored.length) {
        issues.push({
          id: 'nginx.htaccess',
          status: 'warn',
          text: `nginx does not read .htaccess, so these rules do nothing: ${ignored.join(', ')}`,
          hint: 'Move the site back to Apache on its Server and PHP tab when it needs them.',
        });
      }
    }
    if (!mount && siteKind(wp) !== (vhost.kind ?? 'single')) {
      issues.push({
        id: 'nginx.kind',
        status: 'warn',
        text: `The site is a ${siteKind(wp) === 'single' ? 'single site' : `${siteKind(wp)} network`} now, but its nginx rules are for a ${vhost.kind === 'subdirectory' ? 'subdirectory network' : vhost.kind === 'subdomain' ? 'subdomain network' : 'single site'}`,
        fix: { action: 'site.setServer', input: { domain, server: 'nginx' }, label: 'Write its nginx rules again' },
      });
    }
  } else if (wp) {
    const htaccess = readHtaccess(docroot);
    if (htaccess === null) {
      issues.push({
        id: 'htaccess.missing',
        status: 'warn',
        text: 'No .htaccess: pretty permalinks and wp-admin links give 404s',
        fix: { action: 'site.writeHtaccess', input: { domain, ...at }, label: 'Write .htaccess' },
      });
    } else if (siteKind(wp) === 'subdirectory' && !hasNetworkRules(htaccess)) {
      issues.push({
        id: 'htaccess.single',
        status: 'warn',
        text: '.htaccess has single-site rules, so wp-admin of network sites gives 404s',
        hint: "The panel never overwrites an existing .htaccess: replace its WordPress block with the network rules from WordPress's .htaccess documentation.",
      });
    }
  }

  if (wp && vhost.front?.static && !mount) {
    // nginx in front of Apache serves images, CSS, JS and fonts itself: rules about them in .htaccess do not run.
    const front = vhost.front;
    const rules = staticRules(readHtaccess(docroot) ?? '');
    if (rules.length) {
      issues.push({
        id: 'nginx.static',
        status: 'warn',
        text: `nginx serves images, CSS, JS and fonts itself, so these .htaccess rules do not run for them: ${rules.join(', ')}`,
        fix: { action: 'site.setServer', input: { domain, server: 'nginx-apache', static: false }, label: 'Send everything through Apache' },
      });
    }
    const added = apachePaths(docroot).filter((p) => !front.apachePaths.includes(p));
    if (added.length) {
      issues.push({
        id: 'nginx.folders',
        status: 'warn',
        text: `${added.join(', ')} ${added.length === 1 ? 'has an .htaccess of its' : 'have an .htaccess of their'} own now, but nginx serves the files there itself`,
        fix: { action: 'site.setServer', input: { domain, server: 'nginx-apache', static: true }, label: 'Write its nginx rules again' },
      });
    }
  }

  if (localMode && !localMode.enabled) {
    issues.push({
      id: 'local.off',
      status: 'warn',
      text: 'Local mode is off: this copy can email real people and call live mail APIs',
      fix: { action: 'site.setLocalMode', input: { domain, ...at, enabled: true }, label: 'Turn on Local mode' },
    });
  } else if (localMode && !localMode.current) {
    issues.push({
      id: 'local.outdated',
      status: 'warn',
      text: 'The Local mode plugin is an older version',
      fix: { action: 'site.setLocalMode', input: { domain, ...at, enabled: true, blockedHosts: localMode.blockedHosts }, label: 'Update it' },
    });
  }

  // BE Media from Production, when it is on, loads missing uploads itself; otherwise the panel's redirect, if any.
  const uploadsFrom: Site['uploadsFrom'] =
    mediaHost && mediaActive !== false
      ? { host: mediaHost, via: 'plugin' }
      : vhost.managed && vhost.uploadsProxy && !mount
        ? { host: vhost.uploadsProxy, via: 'apache' }
        : localMode?.uploadsFrom
          ? { host: localMode.uploadsFrom, via: 'local-mode' }
          : undefined;
  // A client site (one with a repo) with next to no uploads shows broken images unless missing ones load from production.
  if (wp && git && !uploadsFrom && fewFiles(join(docroot, 'wp-content', 'uploads'), 20)) {
    issues.push({
      id: 'uploads.empty',
      status: 'warn',
      text: 'Uploads are nearly empty and missing ones do not load from production',
      hint: 'Set the production host under Uploads on the site page, so images load from there.',
    });
  }

  if (wp) {
    const notWritable = unwritableByWeb(docroot, ctx.config.WEB_GROUP);
    if (notWritable.dirs.length > 0) {
      issues.push({
        id: 'wp.notWritable',
        status: 'warn',
        text: `WordPress cannot write to ${notWritable.dirs.map((d) => `wp-content/${d}`.replace(/\/$/, '')).join(', ')}, so installs and updates from wp-admin fail`,
        ...(notWritable.fixable
          ? { fix: { action: 'site.fixWritable', input: { domain, ...at }, label: 'Make it writable' } }
          : { hint: `Give the ${ctx.config.WEB_GROUP} group write access by hand: sudo chgrp -R ${ctx.config.WEB_GROUP} wp-content && sudo chmod -R g+w wp-content` }),
      });
    }
  }

  const db = wp?.dbName ? shared.sizes.get(wp.dbName) : undefined;
  const repos = inner.flatMap((r, i): SiteRepo[] => {
    const g = innerGits[i];
    return g && !('error' in g) ? [{ ...r, git: g }] : [];
  });
  const mounts = folders.map((m, i) => {
    const g = mountGits[i];
    return g && !('error' in g) ? { ...m, git: g } : { ...m };
  });

  const added = folderTime(docroot);
  return {
    domain,
    ...at,
    ...(added ? { addedAt: added } : {}),
    aliases: mount ? [] : names.slice(1),
    docroot,
    vhostManaged: vhost.managed,
    server: siteServer(vhost),
    ...(mount ? {} : { move: moveFacts(ctx.config, vhost, domain) }),
    // A site under a path goes with its parent; the panel does not remove one on its own.
    removable: !mount && removalRefusal(ctx.config, domain, docroot, vhost.file) === null,
    panelMade: !mount && vhost.managed && isPanelFolder(ctx.config, docroot, domain),
    ...(wpData.title ? { title: wpData.title } : {}),
    core,
    ...(network ? { network } : {}),
    ...(cert ? { cert } : {}),
    ...(notInHosts.length ? { notInHosts } : {}),
    ...(git && !('error' in git) ? { git } : {}),
    ...(repos.length ? { repos } : {}),
    ...(wp?.dbName ? { db: { name: wp.dbName, sizeBytes: db?.sizeBytes ?? 0, tables: db?.tables ?? 0 } } : {}),
    debug: {
      enabled: wp?.debug ?? false,
      logBytes,
      constants: Object.fromEntries(WP_DEBUG_CONSTANTS.map((name) => [name, wp?.debugConstants[name] ?? null])) as Site['debug']['constants'],
    },
    ...(wp ? { constants: siteConstants(wp), salts: saltStatus(wp, docroot) } : {}),
    ...(localMode ? { localMode } : {}),
    ...(uploadsFrom ? { uploadsFrom } : {}),
    ...(hasMediaPlugin ? { mediaPlugin: { active: mediaActive, ...(mediaHost ? { host: mediaHost } : {}) } } : {}),
    ...(mounts.length ? { mounts } : {}),
    health: healthOf(issues),
    issues,
  };
}

/** Every local site on this machine, read from the system each time. */
export async function discoverSites(ctx: DiscoverContext): Promise<Site[]> {
  const vhosts = readSiteVhosts(ctx.config);
  const mysql = mysqlRunner(ctx.exec, ctx.secrets);
  const wpcore = readWpcoreConfig(ctx.wpcoreConf);
  const [legacyIssuer, read] = await Promise.all([legacyIssuerOf(ctx.exec, ctx.config), databaseSizes(mysql, () => (ctx.secrets?.mysql ? freshStatsSql(ctx.exec, ctx.secrets.mysql) : Promise.resolve('')))]);
  const hostsText = existsSync(ctx.config.HOSTS_FILE) ? readFileSync(ctx.config.HOSTS_FILE, 'utf8') : '';
  const hosts = hostsNames(hostsText);
  const cores = wpcore ? installedCores(wpcore.coresDir) : [];
  const shared = { legacyIssuer, sizes: read ?? new Map<string, { sizeBytes: number; tables: number }>(), read: read !== null, hosts, hostsText, mysql, cores };
  // Each vhost's own site, followed by the WordPress installs it serves under a path.
  const list = await Promise.all(vhosts.map((v) => Promise.all([discoverOne(ctx, v, shared), ...v.mounts.filter(isWordPressMount).map((m) => discoverOne(ctx, v, shared, m))])));
  return withPhp(ctx.config, list.flat());
}

/** Each site's PHP: its own pool's version, else the default (mod_php's, the FPM default, or the newest FPM). */
function withPhp(config: SystemConfig, sites: Site[]): Site[] {
  const pools = readPools(config);
  const fallback = apachePhpVersion(config) ?? fpmDefaultVersion(config) ?? installedVersions(config).find((v) => v.sapis.includes('fpm'))?.version;
  return sites.map((site) => {
    if (site.core.kind === 'none') return site;
    const folder = poolFolder(config, site.docroot);
    const pool = folder ? pools.find((p) => p.folder === folder) : undefined;
    const version = pool?.version ?? fallback;
    return version ? { ...site, php: { version, own: Boolean(pool) } } : site;
  });
}

/** The vhost behind a site, for routes that need its log or folders. */
export function findVhost(config: SystemConfig, domain: string): VhostInfo | undefined {
  return readSiteVhosts(config).find((v) => v.names.includes(domain));
}

export { debugLogPath };

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, truncateSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ActionInput } from '@devmagic-panel/shared';
import { isLocalName, MEDIA_PLUGIN, MEDIA_PLUGIN_URL, WP_DEBUG_CONSTANTS, WP_DEBUG_DEFAULTS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import { installedCores, keepRepoIndex, readWpcoreConfig } from '../wpcore.js';
import { debugLogPath, findVhost, readCore, unwritableByWeb } from './discover.js';
import { ensureHtaccess, siteKind } from './htaccess.js';
import { readLocalMode, setLocalMode as writeLocalMode } from './local-mode.js';
import { installMuPlugin } from './mu-plugins.js';
import { badSalts, saltStatus } from './salts.js';
import { sitePool, wpCommand } from '../php/pools.js';
import { parseWpConfig, type WpConfig } from './wpconfig.js';

export interface SiteActionContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  wpcoreBin: string;
  wpcoreConf: string;
}

export interface HandlerOutcome {
  results: ExecResult[];
  data?: { url?: string; jobId?: string; backup?: string };
  /** The action started a job that records its own outcome. */
  detached?: boolean;
}

export class SiteNotFoundError extends Error {}

/** A site action that cannot run as asked, with what to do instead. */
export class SiteActionRefused extends Error {}

export interface SiteRef {
  domain: string;
  /** Set for a WordPress install under a path of the domain, like /learn. */
  path?: string;
  /** The domain and path, for WP-CLI's --url: local.northwind.com/learn. */
  host: string;
  /** A folder-safe name for the site's snapshots: local.northwind.com or local.northwind.com@learn. */
  key: string;
  docroot: string;
  names: string[];
  wp: WpConfig;
  /** The PHP version of the site's own PHP-FPM pool, when it has one; WP-CLI then runs on it too. */
  php?: string;
}

/** The sites a panel vhost serves under paths, as dmp-root's --mount arguments, so rewriting the vhost keeps them. */
export function mountArgs(config: SystemConfig, mounts: Array<{ path: string; docroot: string }>): string[] {
  return mounts.filter((m) => dirname(m.docroot) === config.WEB_DIR).flatMap((m) => ['--mount', `${m.path}=${basename(m.docroot)}`]);
}

/** The address of a site, with its path when it has one. */
export const siteHost = (domain: string, path?: string) => `${domain}${path ?? ''}`;
export const siteKey = (domain: string, path?: string) => (path ? `${domain}@${path.slice(1).replaceAll('/', '@')}` : domain);

/**
 * The site behind a domain, read from its vhost; never from the request. With
 * a path, the WordPress install that the vhost's Alias for that path serves.
 */
export function siteFor(config: SystemConfig, domain: string, path?: string): SiteRef {
  const vhost = findVhost(config, domain);
  if (!vhost?.docroot || vhost.names[0] !== domain) throw new SiteNotFoundError(`no site called ${domain}`);
  const docroot = path === undefined ? vhost.docroot : vhost.mounts.find((m) => m.path === path)?.docroot;
  if (!docroot) throw new SiteNotFoundError(`no site at ${domain}${path}`);
  const configFile = join(docroot, 'wp-config.php');
  if (!existsSync(configFile)) throw new SiteNotFoundError(`${siteHost(domain, path)} is not a WordPress site (no wp-config.php)`);
  const php = sitePool(config, docroot)?.version;
  return { domain, ...(path ? { path } : {}), host: siteHost(domain, path), key: siteKey(domain, path), docroot, names: vhost.names, wp: parseWpConfig(readFileSync(configFile, 'utf8')), ...(php ? { php } : {}) };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** wp-cli as the panel user, always pinned to the site's folder and URL. */
function wp(ctx: Pick<SiteActionContext, 'exec'>, site: SiteRef, args: string[], url = `https://${site.host}/`): Promise<ExecResult> {
  const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=${url}`, ...args]);
  return ctx.exec(cmd.file, cmd.args, { timeoutMs: 120_000, ...(cmd.env ? { env: cmd.env } : {}) });
}

/** Runs steps in order and stops at the first failure. */
async function steps(...run: Array<() => Promise<ExecResult>>): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (const step of run) {
    const result = await step();
    results.push(result);
    if (result.code !== 0) break;
  }
  return results;
}

export async function clearCache(ctx: SiteActionContext, { domain, path }: ActionInput<'site.clearCache'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  return {
    results: await steps(
      () => wp(ctx, site, ['cache', 'flush']),
      () => wp(ctx, site, ['transient', 'delete', '--all']),
      ...(site.wp.multisite ? [() => wp(ctx, site, ['transient', 'delete', '--all', '--network'])] : []),
      // mod_php keeps OPcache in Apache; a graceful reload resets it.
      () => runRoot(ctx.exec, ctx.dmpRoot, ['apache-reload']),
    ),
  };
}

export async function flushRewrites(ctx: SiteActionContext, { domain, path }: ActionInput<'site.flushRewrites'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  return { results: await steps(() => wp(ctx, site, ['rewrite', 'flush'])) };
}

export async function setDebug(ctx: SiteActionContext, { domain, path, constants }: ActionInput<'site.setDebug'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const set = (name: string, value: boolean) => () => wp(ctx, site, ['config', 'set', name, String(value), '--raw', '--type=constant']);
  // A constant already at the value asked for is left alone: one wp-config.php
  // leaves out stays out, and a custom WP_DEBUG_LOG path is kept.
  const changes = WP_DEBUG_CONSTANTS.filter((name) => {
    const want = constants[name];
    return want !== undefined && (site.wp.debugConstants[name] ?? WP_DEBUG_DEFAULTS[name]) !== want;
  }).map((name) => set(name, constants[name] as boolean));
  if (changes.length === 0) return { results: [ok('wp-config.php already has these settings')] };
  return { results: await steps(...changes) };
}

/** One constant through WP-CLI, which changes it where it is (inside an if too) or adds it; null removes it. */
export async function setConstant(ctx: SiteActionContext, { domain, path, name, value }: ActionInput<'site.setConstant'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const had = site.wp.constants.some((c) => c.name === name);
  if (value === null) {
    if (!had) return { results: [ok(`wp-config.php has no ${name}, nothing to remove`)] };
    return { results: [await wp(ctx, site, ['config', 'delete', name, '--type=constant'])] };
  }
  const raw = typeof value !== 'string';
  return { results: [await wp(ctx, site, ['config', 'set', name, String(value), ...(raw ? ['--raw'] : []), '--type=constant'])] };
}

/** New keys and salts through WP-CLI: only the missing ones, which logs nobody out, or all of them. */
export async function shuffleSalts(ctx: SiteActionContext, { domain, path, only }: ActionInput<'site.shuffleSalts'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const status = saltStatus(site.wp, site.docroot);
  // By name, with --force to add the ones not there: the site's WordPress may ask for others than WP-CLI's own list.
  const names = only === 'all' ? status.names : badSalts(status);
  if (names.length === 0) return { results: [ok(`wp-config.php has all ${status.names.length} keys and salts, each its own`)] };
  return { results: [await wp(ctx, site, ['config', 'shuffle-salts', ...names, '--force'])] };
}

/** SECRET_KEY and SECRET_SALT out of wp-config.php, once the current keys make them unused. */
export async function removeLegacySalts(ctx: SiteActionContext, { domain, path }: ActionInput<'site.removeLegacySalts'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const status = saltStatus(site.wp, site.docroot);
  if (status.legacy.length === 0) return { results: [ok('wp-config.php has no SECRET_KEY or SECRET_SALT')] };
  const bad = badSalts(status);
  if (bad.length > 0) return { results: [failed(`WordPress still reads ${status.legacy.join(' and ')} while ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not usable: fix the keys first`)] };
  return { results: await steps(...status.legacy.map((name) => () => wp(ctx, site, ['config', 'delete', name, '--type=constant']))) };
}

export async function clearDebugLog(ctx: SiteActionContext, { domain, path }: ActionInput<'site.clearDebugLog'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const file = debugLogPath(site.docroot, site.wp);
  if (!existsSync(file)) return { results: [ok(`${file} does not exist, nothing to clear`)] };
  try {
    truncateSync(file, 0);
    return { results: [ok(`cleared ${file}`)] };
  } catch (error) {
    // PHP often owns the log (www-data or root). Removing it only needs write
    // access to its folder, and needs no root: PHP writes a new one on the next error.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') return { results: [failed(`could not clear ${file}: ${(error as Error).message}`)] };
    try {
      unlinkSync(file);
      return { results: [ok(`removed ${file}; WordPress starts a new one on the next error`)] };
    } catch (unlinkError) {
      return { results: [failed(`could not clear ${file}: ${(unlinkError as Error).message}. Its folder is not writable by you.`)] };
    }
  }
}

export async function setLocalMode(ctx: SiteActionContext, { domain, path, enabled, blockedHosts }: ActionInput<'site.setLocalMode'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  return { results: [await writeLocalMode(ctx.exec, site.docroot, enabled, blockedHosts)] };
}

export async function writeHtaccess(ctx: SiteActionContext, { domain, path }: ActionInput<'site.writeHtaccess'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  return { results: [await ensureHtaccess(ctx.exec, site.docroot, siteKind(site.wp), site.path ? `${site.path}/` : '/')] };
}

export async function setUploadsFrom(ctx: SiteActionContext, { domain, path, host, via }: ActionInput<'site.setUploadsFrom'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const hasPlugin = existsSync(join(site.docroot, 'wp-content', 'plugins', MEDIA_PLUGIN));
  const plugin = (action: 'activate' | 'deactivate') => () => wp(ctx, site, ['plugin', action, MEDIA_PLUGIN, ...(site.wp.multisite ? ['--network'] : []), '--skip-plugins', '--skip-themes']);
  if (via === 'plugin') {
    if (!hasPlugin) throw new SiteActionRefused(`${site.host} does not have ${MEDIA_PLUGIN}; the panel never downloads it`);
    if (!host) return { results: await steps(plugin('deactivate')) };
    // One way at a time: a redirect the panel set goes first, so the plugin alone loads them.
    const cleared = await redirectUploads(ctx, site, null, true);
    if (cleared && cleared.code !== 0) return { results: [cleared] };
    const results = await steps(() => wp(ctx, site, ['config', 'set', MEDIA_PLUGIN_URL, `https://${host}`, '--type=constant']), plugin('activate'));
    return { results: cleared ? [cleared, ...results] : results };
  }
  const set = (await redirectUploads(ctx, site, host, false)) as ExecResult;
  // The redirect replaces the plugin, which is turned off when the site has it.
  if (host && hasPlugin && set.code === 0) return { results: [set, ...(await steps(plugin('deactivate')))] };
  return { results: [set] };
}

/**
 * Sets or clears the redirect for missing uploads: the panel's vhost for a
 * site it made, Local mode for a vhost made by hand or a site under a path.
 * With `onlyIfSet`, nothing runs (null) when there is no redirect to clear.
 */
async function redirectUploads(ctx: SiteActionContext, site: SiteRef, host: string | null, onlyIfSet: boolean): Promise<ExecResult | null> {
  const vhost = findVhost(ctx.config, site.domain);
  // A site under a path shares its parent's vhost, whose rule covers the parent's uploads only: Local mode does it.
  if (vhost?.managed && !site.path) {
    if (onlyIfSet && !vhost.uploadsProxy) return null;
    // The panel's vhost is rebuilt from its names, with or without the redirect; dmp-root tests the config and reloads Apache.
    const aliases = vhost.names.slice(1).filter(isLocalName);
    return runRoot(ctx.exec, ctx.dmpRoot, ['vhost-write', site.domain, ...(host ? ['--uploads-proxy', host] : []), ...mountArgs(ctx.config, vhost.mounts), ...aliases]);
  }
  const localMode = readLocalMode(site.docroot);
  if (onlyIfSet && !localMode.uploadsFrom) return null;
  if (!localMode.enabled) {
    throw new SiteActionRefused(`${site.host} gets missing uploads through the Local mode plugin; turn on Local mode first, or use BE Media from Production`);
  }
  return writeLocalMode(ctx.exec, site.docroot, true, undefined, host);
}

/**
 * Adds domains to a site whose vhost the panel made: the vhost is written
 * again with its names, folders and uploads redirect plus the new ones, the
 * certificate is issued again from it, and the hosts line lists them all.
 */
export async function addAliases(ctx: SiteActionContext, { domain, aliases }: ActionInput<'site.addAliases'>): Promise<HandlerOutcome> {
  const vhost = findVhost(ctx.config, domain);
  if (!vhost || vhost.names[0] !== domain) throw new SiteActionRefused(`${domain} is not a site's primary domain here`);
  if (!vhost.managed) throw new SiteActionRefused(`the vhost of ${domain} was made by hand, so the panel leaves it as it is: add ServerAlias ${aliases.join(' ')} to it yourself`);
  const current = vhost.names.slice(1).filter(isLocalName);
  const added = [...new Set(aliases)].filter((a) => a !== domain && !current.includes(a));
  if (added.length === 0) return { results: [ok(`${domain} serves ${aliases.join(', ')} already`)] };
  for (const name of added) {
    const other = findVhost(ctx.config, name);
    if (other && other.file !== vhost.file) throw new SiteActionRefused(`${name} belongs to another site, ${other.names[0] ?? name}`);
  }
  const names = [...current, ...added];
  const root = (...args: string[]) => () => runRoot(ctx.exec, ctx.dmpRoot, args);
  return {
    results: await steps(
      root('vhost-write', domain, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...mountArgs(ctx.config, vhost.mounts), ...names),
      root('cert-reissue-from-vhost', domain),
      root('hosts-add', domain, ...names),
      root('apache-reload'),
    ),
  };
}

export async function fixWritable(ctx: SiteActionContext, { domain, path }: ActionInput<'site.fixWritable'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const { dirs, fixable } = unwritableByWeb(site.docroot, ctx.config.WEB_GROUP);
  if (dirs.length === 0) return { results: [ok('wp-content is already writable by WordPress')] };
  if (!fixable) throw new SiteActionRefused(`wp-content of ${domain} is not owned by you in the ${ctx.config.WEB_GROUP} group; fix it by hand with sudo`);
  const content = join(site.docroot, 'wp-content');
  return { results: [await ctx.exec('chmod', ['-R', 'g+w', '--', content], { timeoutMs: 5 * 60_000 })] };
}

// ── one-click login ──────────────────────────────────────────

export const LOGIN_PLUGIN_FILE = 'devmagic-panel-login.php';

/**
 * Consumes the one-time tokens the panel stores with wp-cli. It only acts on
 * local host names and is added to the repo's local git exclude list, so it
 * never travels to production.
 */
export const LOGIN_PLUGIN = `<?php
/**
 * Plugin Name: devmagic-panel login
 * Description: One-click wp-admin login from devmagic-panel on this machine. Added by the panel and excluded from git locally.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'init',
	static function () {
		if ( empty( $_GET['dmp_login'] ) ) {
			return;
		}
		$host = isset( $_SERVER['HTTP_HOST'] ) ? strtolower( (string) $_SERVER['HTTP_HOST'] ) : '';
		if ( ! preg_match( '/^(www\\.)?local\\.|\\.test(:\\d+)?$|\\.localhost(:\\d+)?$/', $host ) ) {
			return;
		}
		$token   = sanitize_text_field( wp_unslash( $_GET['dmp_login'] ) );
		$key     = 'dmp_login_' . substr( hash( 'sha256', $token ), 0, 40 );
		$user_id = (int) get_transient( $key );
		delete_transient( $key );
		if ( $user_id <= 0 || ! get_userdata( $user_id ) ) {
			wp_die( esc_html__( 'This login link has expired. Open wp-admin from devmagic-panel again.' ), '', array( 'response' => 403 ) );
		}
		wp_set_current_user( $user_id );
		wp_set_auth_cookie( $user_id, false, is_ssl() );
		$to = ( isset( $_GET['to'] ) && 'network' === $_GET['to'] && is_multisite() ) ? network_admin_url() : admin_url();
		wp_safe_redirect( $to );
		exit;
	},
	1
);
`;

/** Puts the login mu-plugin in place and keeps it out of git. */
function ensureLoginPlugin(ctx: Pick<SiteActionContext, 'exec'>, site: SiteRef): Promise<ExecResult> {
  return installMuPlugin(ctx.exec, site.docroot, LOGIN_PLUGIN_FILE, LOGIN_PLUGIN, 'devmagic-panel one-click login, local only');
}

/** The URL to sign in on: the main site, or a network site served by this vhost. */
function loginUrl(site: SiteRef, requested: string | undefined): string {
  if (!requested) return `https://${site.host}/`;
  const url = new URL(requested);
  const host = url.hostname.toLowerCase();
  const belongs = isLocalName(host) && (site.names.includes(host) || host.endsWith(`.${site.domain}`));
  if (url.protocol !== 'https:' || !belongs) throw new SiteNotFoundError(`${requested} is not part of ${site.domain}`);
  return `https://${host}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`;
}

export async function login(ctx: SiteActionContext, input: ActionInput<'site.login'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, input.domain, input.path);
  const { results, link } = await loginLink(ctx, site, loginUrl(site, input.siteUrl));
  return { results, ...(link ? { data: { url: `${link}${input.to === 'network' ? '&to=network' : ''}` } } : {}) };
}

/**
 * A one-time login link for the first administrator (the first super admin on
 * a network), valid 60 seconds, through the login mu-plugin, which it puts in
 * place when it is missing. Also used by a PHP switch to open wp-admin signed in.
 */
export async function loginLink(ctx: Pick<SiteActionContext, 'exec'>, site: SiteRef, url = `https://${site.host}/`): Promise<{ results: ExecResult[]; link?: string }> {
  const results: ExecResult[] = [];

  const plugin = await ensureLoginPlugin(ctx, site);
  results.push(plugin);
  if (plugin.code !== 0) return { results };

  // First super admin on a network, otherwise the first administrator.
  const users = site.wp.multisite
    ? await wp(ctx, site, ['super-admin', 'list', '--format=json'], url)
    : await wp(ctx, site, ['user', 'list', '--role=administrator', '--field=user_login', '--orderby=ID', '--order=ASC', '--number=1'], url);
  results.push(users);
  if (users.code !== 0) return { results };
  let loginName: string | undefined;
  try {
    if (site.wp.multisite) {
      // wp-cli prints [{"user_login":"superadmin"}]; older versions printed plain names.
      const first = (JSON.parse(users.stdout) as Array<string | { user_login?: string }>)[0];
      loginName = typeof first === 'string' ? first : first?.user_login;
    } else {
      loginName = users.stdout.trim().split('\n')[0];
    }
  } catch {
    loginName = undefined;
  }
  if (!loginName) return { results: [...results, failed('no administrator found on this site')] };

  const id = await wp(ctx, site, ['user', 'get', loginName, '--field=ID'], url);
  results.push(id);
  const userId = id.stdout.trim();
  if (id.code !== 0 || !/^\d+$/.test(userId)) return { results };

  const token = randomBytes(24).toString('base64url');
  const key = `dmp_login_${createHash('sha256').update(token).digest('hex').slice(0, 40)}`;
  const stored = await wp(ctx, site, ['transient', 'set', key, userId, '60'], url);
  results.push({ ...stored, stdout: `one-time login for ${loginName}, valid 60 seconds` });
  if (stored.code !== 0) return { results };

  return { results, link: `${url}?dmp_login=${token}` };
}

// ── core switch ──────────────────────────────────────────────

export async function switchCore(ctx: SiteActionContext, { domain, path, version }: ActionInput<'core.switch'>): Promise<HandlerOutcome> {
  const site = siteFor(ctx.config, domain, path);
  const core = readCore(site.docroot);
  if (core.kind !== 'wpcore') return { results: [failed(`${domain} has its own copy of WordPress; switching only works for sites on a shared core`)] };
  const conf = readWpcoreConfig(ctx.wpcoreConf);
  if (!conf || !installedCores(conf.coresDir).includes(version)) return { results: [failed(`WordPress ${version} is not installed in the shared cores folder`)] };
  if (core.version === version) return { results: [ok(`${domain} already uses WordPress ${version}`)] };

  return {
    results: await steps(
      // wpcore asks whether to update the database; answer no and do it as the panel user below.
      () => ctx.exec('sudo', ['-n', ctx.wpcoreBin, 'switch', basename(site.docroot), version], { input: 'n\n', timeoutMs: 120_000 }),
      () => keepRepoIndex(ctx.exec, site.docroot),
      () => wp(ctx, site, ['core', 'update-db', ...(site.wp.multisite ? ['--network'] : [])]),
    ),
  };
}

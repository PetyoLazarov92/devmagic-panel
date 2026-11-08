import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLocalName, onNginxAddress, type SiteServer } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { SiteKind } from './htaccess.js';
import { hostsBlockAddress, readHosts } from './hosts-block.js';

/** Same marker line as DMP_VHOST_MARKER in scripts/lib/vhost.sh. */
export const VHOST_MARKER = '# Managed by devmagic-panel. Edits here are overwritten.';

export interface VhostInfo {
  /** The server that has this file: an Apache vhost, or the panel's nginx site (scripts/lib/nginx.sh). */
  server: 'apache' | 'nginx';
  file: string;
  managed: boolean;
  /** ServerName and ServerAlias from every block, lowercase, in file order. */
  names: string[];
  /** Names per block, to spot names served on one port only. */
  byPort: { http: string[]; https: string[] };
  docroot: string | null;
  certFile: string | null;
  /** Resolved ErrorLog path, or null when Apache's default applies. */
  errorLog: string | null;
  /** `Alias /path /dir` lines whose target is a folder. */
  mounts: Array<{ path: string; docroot: string }>;
  /** The production host the panel's own vhost sends missing uploads to (scripts/lib/vhost.sh). */
  uploadsProxy: string | null;
  /** For a site on nginx: the WordPress rules its file was written with (the "# kind:" line). */
  kind?: SiteKind;
  /** For the panel's nginx file of a site with nginx in front of Apache: "# mode: apache". */
  mode?: 'apache';
  /** For an Apache vhost with nginx in front of it: the panel's nginx file and how it was written. */
  front?: NginxFront;
}

/** nginx in front of an Apache vhost (scripts/lib/nginx.sh dmp_nginx_front_render). */
export interface NginxFront {
  file: string;
  /** nginx serves images, CSS, JS and fonts that exist itself ("# static: on"). */
  static: boolean;
  /** Folders with an .htaccess of their own that go to Apache ("# apache-path:" lines). */
  apachePaths: string[];
}

const directive = (line: string, name: string) => new RegExp(`^\\s*${name}\\s+(.+?)\\s*$`, 'i').exec(line)?.[1];
const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1');

export function parseVhost(text: string, file: string, apacheLogDir: string): VhostInfo {
  const names: string[] = [];
  let docroot: string | null = null;
  let docroot443: string | null = null;
  let certFile: string | null = null;
  let errorLog: string | null = null;
  let errorLog443: string | null = null;
  const mounts: VhostInfo['mounts'] = [];
  let in443 = false;
  let in80 = false;
  const byPort: VhostInfo['byPort'] = { http: [], https: [] };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*#.*$/, '');
    if (/<VirtualHost\s+[^>]*:443\s*>/i.test(line)) in443 = true;
    if (/<VirtualHost\s+[^>]*:80\s*>/i.test(line)) in80 = true;
    if (/<\/VirtualHost>/i.test(line)) in443 = in80 = false;

    const server = directive(line, 'Server(?:Name|Alias)');
    if (server) {
      for (const n of server.toLowerCase().split(/\s+/)) {
        if (!names.includes(n)) names.push(n);
        const block = in443 ? byPort.https : in80 ? byPort.http : null;
        if (block && !block.includes(n)) block.push(n);
      }
    }

    const root = directive(line, 'DocumentRoot');
    if (root) {
      docroot ??= unquote(root);
      if (in443) docroot443 ??= unquote(root);
    }
    const cert = directive(line, 'SSLCertificateFile');
    if (cert) certFile ??= unquote(cert);
    const log = directive(line, 'ErrorLog');
    if (log) {
      const path = unquote(log).replace(/\$\{APACHE_LOG_DIR\}/g, apacheLogDir);
      errorLog ??= path;
      if (in443) errorLog443 ??= path;
    }
    const alias = /^\s*Alias\s+("?)(\/[^\s"]*)\1\s+("?)(\/[^\s"]+)\3\s*$/i.exec(line);
    // "Alias /learn/ ..." and "Alias /learn ..." are the same mount.
    const mountAt = alias?.[2]?.replace(/\/+$/, '');
    if (mountAt && alias?.[4] && !mounts.some((m) => m.path === mountAt)) mounts.push({ path: mountAt, docroot: alias[4].replace(/\/+$/, '') });
  }

  return {
    server: 'apache',
    file,
    managed: text.split('\n', 1)[0] === VHOST_MARKER,
    names,
    byPort,
    docroot: docroot443 ?? docroot,
    certFile,
    errorLog: errorLog443 ?? errorLog,
    mounts,
    uploadsProxy: /^\s*RewriteRule \^\/\?\(\.\*\)\$ https:\/\/([a-z0-9.-]+)\/\$1 \[R=302,L\]\s*$/im.exec(text)?.[1] ?? null,
  };
}

/**
 * The panel's nginx site (scripts/lib/nginx.sh dmp_nginx_site_render): its
 * names, folder, certificate, log, uploads redirect and WordPress rules.
 */
export function parseNginxSite(text: string, file: string): VhostInfo {
  const names: string[] = [];
  const value = (name: string) => new RegExp(`^\\s*${name}\\s+([^;\\s]+);`, 'm').exec(text)?.[1] ?? null;
  for (const m of text.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
    for (const n of (m[1] as string).toLowerCase().split(/\s+/)) if (n && n !== '_' && !names.includes(n)) names.push(n);
  }
  const kind = /^# kind: (single|subdirectory|subdomain)$/m.exec(text)?.[1] as SiteKind | undefined;
  const front = /^# mode: apache$/m.test(text);
  const docroot = value('root');
  // Sites under its paths: "# mount: /learn=local.learn.shop.com", a folder next to the site's own.
  const mounts = docroot
    ? [...text.matchAll(/^# mount: (\/[A-Za-z0-9._/-]+)=([a-z0-9.-]+)$/gm)].map((m) => ({ path: m[1] as string, docroot: join(dirname(docroot), m[2] as string) }))
    : [];
  return {
    server: 'nginx',
    file,
    managed: text.split('\n', 1)[0] === VHOST_MARKER,
    names,
    byPort: { http: [...names], https: [...names] },
    docroot,
    certFile: value('ssl_certificate'),
    errorLog: value('error_log'),
    mounts,
    uploadsProxy: /^\s*return 302 https:\/\/([a-z0-9.-]+)\$request_uri;\s*$/m.exec(text)?.[1] ?? null,
    ...(kind ? { kind } : {}),
    ...(front ? { mode: 'apache' as const } : {}),
  };
}

/** How a front file was written: what nginx serves itself, and the folders it leaves to Apache. */
export function parseNginxFront(text: string, file: string): NginxFront {
  return {
    file,
    static: !/^# static: off$/m.test(text),
    apachePaths: [...text.matchAll(/^# apache-path: (\/[A-Za-z0-9._/-]+)$/gm)].map((m) => m[1] as string),
  };
}

/** The panel's enabled nginx sites, from sites-enabled. */
function readNginxSites(config: SystemConfig): VhostInfo[] {
  if (!existsSync(config.NGINX_SITES_ENABLED)) return [];
  const out: VhostInfo[] = [];
  for (const entry of readdirSync(config.NGINX_SITES_ENABLED).filter((f) => f.endsWith('.conf')).sort()) {
    let file: string;
    let text: string;
    try {
      file = realpathSync(join(config.NGINX_SITES_ENABLED, entry));
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const info = parseNginxSite(text, file);
    const primary = info.names[0];
    // Only the panel's files are sites here; nginx configs made by hand are listed on the nginx tab.
    if (!info.managed || !primary || !isLocalName(primary) || primary === config.PANEL_DOMAIN) continue;
    if (!info.docroot?.startsWith(`${config.WEB_DIR}/`)) continue;
    info.mounts = info.mounts.filter((m) => existsSync(m.docroot));
    out.push(info);
  }
  return out;
}

/** The web server that has a site: Apache, nginx in front of its Apache vhost, or nginx with PHP-FPM. */
export const siteServer = (vhost: Pick<VhostInfo, 'server' | 'front' | 'mode'>): SiteServer =>
  vhost.front || vhost.mode === 'apache' ? 'nginx-apache' : vhost.server;

/** The address a site answers on: nginx's for a site on nginx or with nginx in front, else Apache's. */
export const siteAddress = (config: SystemConfig, vhost: Pick<VhostInfo, 'server' | 'front' | 'mode'> | undefined) =>
  vhost && onNginxAddress(siteServer(vhost)) ? config.NGINX_ADDRESS : config.APACHE_ADDRESS;

/**
 * Every enabled vhost that serves a local site from the web root, and the
 * panel's nginx sites. Apache's defaults and the panel's own vhost are
 * skipped. A site both servers have (halfway through a move) is the one its
 * hosts line points at.
 */
export function readSiteVhosts(config: SystemConfig): VhostInfo[] {
  const apache = readApacheVhosts(config);
  const all = readNginxSites(config);
  if (all.length === 0) return apache;
  // nginx in front of an Apache vhost: the site is the vhost, with the front file noted on it.
  const nginx: VhostInfo[] = [];
  for (const n of all) {
    const vhost = n.mode === 'apache' ? apache.find((a) => a.names[0] === n.names[0]) : undefined;
    if (vhost) vhost.front = parseNginxFront(readFileSync(n.file, 'utf8'), n.file);
    else nginx.push(n);
  }
  if (nginx.length === 0) return apache;
  const hosts = readHosts(config);
  const onNginx = new Set(nginx.map((n) => n.names[0] as string).filter((d) => !apache.some((a) => a.names[0] === d) || hostsBlockAddress(hosts, d) === config.NGINX_ADDRESS));
  return [...apache.filter((a) => !onNginx.has(a.names[0] as string)), ...nginx.filter((n) => onNginx.has(n.names[0] as string))];
}

function readApacheVhosts(config: SystemConfig): VhostInfo[] {
  if (!existsSync(config.APACHE_SITES_ENABLED)) return [];
  const out: VhostInfo[] = [];
  for (const entry of readdirSync(config.APACHE_SITES_ENABLED).filter((f) => f.endsWith('.conf')).sort()) {
    let file: string;
    let text: string;
    try {
      file = realpathSync(join(config.APACHE_SITES_ENABLED, entry));
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const info = parseVhost(text, file, config.APACHE_LOG_DIR);
    const primary = info.names[0];
    if (!primary || !isLocalName(primary) || primary === config.PANEL_DOMAIN) continue;
    if (!info.docroot?.startsWith(`${config.WEB_DIR}/`)) continue;
    info.mounts = info.mounts.filter((m) => existsSync(m.docroot));
    out.push(info);
  }
  return out;
}

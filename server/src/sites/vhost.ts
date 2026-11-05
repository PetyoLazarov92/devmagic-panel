import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';

/** Same marker line as DMP_VHOST_MARKER in scripts/lib/vhost.sh. */
export const VHOST_MARKER = '# Managed by devmagic-panel. Edits here are overwritten.';

export interface VhostInfo {
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
 * Every enabled vhost that serves a local site from the web root. Apache's
 * defaults and the panel's own vhost are skipped.
 */
export function readSiteVhosts(config: SystemConfig): VhostInfo[] {
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

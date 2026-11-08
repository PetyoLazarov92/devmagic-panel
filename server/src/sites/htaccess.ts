import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecResult, Executor } from '../exec.js';
import { excludeLocally } from './mu-plugins.js';

/** A single site, or a network whose sites live under paths of one host or on their own hosts. */
export type SiteKind = 'single' | 'subdirectory' | 'subdomain';

const head = (base: string) => `# BEGIN WordPress
# Written by devmagic-panel because the site had no .htaccess; kept out of git locally.
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase ${base}
RewriteRule ^index\\.php$ - [L]`;

const TAIL = `</IfModule>
# END WordPress
`;

/**
 * WordPress's own rewrite rules for each kind of site (wordpress.org
 * documentation, htaccess); `base` is the path a site under a path is served at, like /learn/.
 */
export function htaccessFor(kind: SiteKind, base = '/'): string {
  const HEAD = head(base);
  if (kind === 'single') {
    return `${HEAD}
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . ${base}index.php [L]
${TAIL}`;
  }
  const site = kind === 'subdirectory' ? '([_0-9a-zA-Z-]+/)?' : '';
  const ref = kind === 'subdirectory' ? '$2' : '$1';
  return `${HEAD}

# add a trailing slash to /wp-admin
RewriteRule ^${site}wp-admin$ ${kind === 'subdirectory' ? '$1' : ''}wp-admin/ [R=301,L]

RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]
RewriteRule ^${site}(wp-(content|admin|includes).*) ${ref} [L]
RewriteRule ^${site}(.*\\.php)$ ${ref} [L]
RewriteRule . index.php [L]
${TAIL}`;
}

/**
 * True when an .htaccess has the network rules that send /site/wp-admin to
 * WordPress: a RewriteRule whose wp-(...) group lists admin, in any order, as
 * wp-(content|admin|includes) in WordPress's documentation or
 * wp-(includes|admin|content) in files written by hand.
 */
export const hasNetworkRules = (text: string) =>
  text
    .split('\n')
    .some((line) => /^\s*RewriteRule\s/i.test(line) && [...line.matchAll(/wp-\(([a-z|]+)\)/g)].some((m) => (m[1] as string).split('|').includes('admin')));

/**
 * Writes WordPress's rules when the site has no .htaccess. An existing file is
 * never touched: it may hold rules someone wrote on purpose.
 */
export async function ensureHtaccess(exec: Executor, docroot: string, kind: SiteKind, base = '/'): Promise<ExecResult> {
  const file = join(docroot, '.htaccess');
  if (existsSync(file)) return { code: 0, stdout: `${file} already exists, left as is`, stderr: '' };
  writeFileSync(file, htaccessFor(kind, base), { mode: 0o644 });
  await excludeLocally(exec, file, 'devmagic-panel .htaccess, local only');
  return { code: 0, stdout: `wrote ${file} with the ${kind === 'single' ? 'single site' : `${kind} network`} rules`, stderr: '' };
}

/** The kind of site from wp-config.php settings. */
export const siteKind = (wp: { multisite: boolean; subdomainInstall: boolean }): SiteKind =>
  !wp.multisite ? 'single' : wp.subdomainInstall ? 'subdomain' : 'subdirectory';

/**
 * What nginx leaves out of an .htaccess: every # BEGIN section but
 * WordPress's own, and rules outside any section. Comments do not count.
 */
export function htaccessIgnored(text: string): string[] {
  const sections: string[] = [];
  let inside: string | null = null;
  let loose = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const begin = /^#\s*BEGIN\s+(.+)$/.exec(line)?.[1]?.trim();
    if (begin) {
      inside = begin;
      if (!/^WordPress\b/i.test(begin) && !sections.includes(begin)) sections.push(begin);
      continue;
    }
    if (/^#\s*END\b/.test(line)) {
      inside = null;
      continue;
    }
    if (!inside && line && !line.startsWith('#')) loose++;
  }
  return loose ? [...sections, `${loose} line${loose === 1 ? '' : 's'} of your own`] : sections;
}

export const readHtaccess = (docroot: string): string | null => {
  const file = join(docroot, '.htaccess');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/** Folders the scan for .htaccess files never goes into: dependencies and git, never served as a site's own rules. */
const SKIP_FOLDERS = new Set(['node_modules', 'vendor', '.git', '.svn', 'bower_components']);
/** Where the scan stops, so a site with a deep uploads tree is read in a moment. */
const SCAN_DEPTH = 8;
const SCAN_FOLDERS = 5000;

/**
 * The site's folders, below its own, that have an .htaccess of their own,
 * like /wp-content/uploads/wc-logs: with nginx in front of Apache they always
 * go to Apache, so their rules run for every file in them. Links are not
 * followed, and only names dmp-root takes (letters, digits, . _ -) count.
 */
export function htaccessFolders(docroot: string, fresh = false): string[] {
  // A folder under another one that goes to Apache goes with it.
  return scanHtaccess(docroot, fresh).folders.filter((p, i, all) => !all.slice(0, i).some((q) => p.startsWith(`${q}/`)));
}

/**
 * Every folder below the site's own with an .htaccess, sorted, and whether
 * the scan stopped at its limit of folders.
 */
export function scanHtaccess(docroot: string, fresh = false): { folders: string[]; partial: boolean } {
  const hit = scans.get(docroot);
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.scan;
  const scan = walkHtaccess(docroot);
  scans.set(docroot, { at: Date.now(), scan });
  return scan;
}

/** Scans of a site's folders, kept a minute: the sites list reads them for every site. */
const scans = new Map<string, { at: number; scan: { folders: string[]; partial: boolean } }>();
const SCAN_TTL_MS = 60_000;

function walkHtaccess(docroot: string): { folders: string[]; partial: boolean } {
  const found: string[] = [];
  let seen = 0;
  let partial = false;
  const walk = (dir: string, at: string, depth: number) => {
    if (depth > SCAN_DEPTH) return;
    if (seen >= SCAN_FOLDERS) {
      partial = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    seen++;
    if (at && entries.some((e) => e.isFile() && e.name === '.htaccess')) found.push(at);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_FOLDERS.has(e.name) || !/^[A-Za-z0-9._-]+$/.test(e.name) || e.name === '.' || e.name === '..') continue;
      walk(join(dir, e.name), `${at}/${e.name}`, depth + 1);
    }
  };
  walk(docroot, '', 0);
  return { folders: found.sort(), partial };
}

/** Files nginx serves itself in front of Apache (DMP_NGINX_STATIC_EXT in scripts/lib/nginx.sh). */
const STATIC_EXT = /\\\.\S*\b(css|js|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)\b/i;
const STATIC_WORDS = /\b(css|js|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)\b|image\/|font\/|text\/css|javascript/i;

/**
 * Rules of an .htaccess that are about images, CSS, JS or fonts: headers,
 * expiry and compression, and rewrites or access rules of those files. They
 * do not run for the files nginx serves itself in front of Apache.
 * WordPress's own section is left out. Each comes back as its first words.
 */
export function staticRules(text: string): string[] {
  const out: string[] = [];
  let section: string | null = null;
  let files: boolean | null = null;
  const add = (line: string) => {
    const words = line.replace(/^<|>$/g, '').split(/\s+/).slice(0, 3).join(' ');
    if (!out.includes(words)) out.push(words);
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const begin = /^#\s*BEGIN\s+(.+)$/.exec(line)?.[1]?.trim();
    if (begin) section = begin;
    if (/^#\s*END\b/.test(line)) section = null;
    if (!line || line.startsWith('#') || (section && /^WordPress\b/i.test(section))) continue;
    const opening = /^<(Files|FilesMatch)\s+(.+)>$/i.exec(line);
    if (opening) {
      files = STATIC_WORDS.test(opening[2] as string);
      if (files) add(line);
      continue;
    }
    if (/^<\/Files(Match)?>/i.test(line)) {
      files = null;
      continue;
    }
    if (files) continue;
    if (/^(Header|ExpiresActive|ExpiresByType|ExpiresDefault|AddOutputFilterByType|SetOutputFilter|FileETag|AddType|AddEncoding|AddCharset)\b/i.test(line)) {
      add(line);
      continue;
    }
    if (/^(RewriteRule|RewriteCond|RedirectMatch)\b/i.test(line) && STATIC_EXT.test(line)) add(line);
  }
  return out.slice(0, 8);
}

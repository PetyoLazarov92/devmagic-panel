import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

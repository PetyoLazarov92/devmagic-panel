import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { PhpFpmFinding } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { diffIni, parseIni } from './ini.js';
import { installedVersions, readPhpModules } from './versions.js';

/**
 * What behaves differently once a site runs on PHP-FPM instead of mod_php:
 * php_value lines (a 500 in .htaccess, a configtest failure in a vhost),
 * .user.ini files (FPM reads them, mod_php does not), phpMyAdmin (its
 * settings sit in mod_php blocks), and FPM's own php.ini and module list.
 */

const PHP_DIRECTIVE = /^\s*php_(?:admin_)?(?:value|flag)\s/i;
/** Folders a walk of the sites skips: dependencies and history, never a site's own config. */
const SKIP = new Set(['node_modules', 'vendor', '.git', 'bower_components', 'cache', 'uploads']);
const MAX_DEPTH = 4;
const MAX_FILES = 50_000;

/** The php_value lines a config file applies without mod_php: those outside `<IfModule mod_php...>` blocks. */
export function phpDirectivesOutsideModPhp(text: string): number {
  const stack: boolean[] = [];
  let count = 0;
  for (const line of text.split('\n')) {
    const open = /^\s*<IfModule\s+!?([^>\s]+)\s*>/i.exec(line);
    if (open) {
      stack.push(/php/i.test(open[1] as string));
      continue;
    }
    if (/^\s*<\/IfModule\s*>/i.test(line)) {
      stack.pop();
      continue;
    }
    if (PHP_DIRECTIVE.test(line) && !stack.some(Boolean)) count++;
  }
  return count;
}

/** Files under a site folder, a few levels deep, without following links: wpcore's core files are links. */
function walk(root: string, names: Set<string>, found: string[] = [], depth = 0, seen = { n: 0 }): string[] {
  if (depth > MAX_DEPTH || seen.n > MAX_FILES) return found;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    seen.n++;
    if (entry.isDirectory() && !SKIP.has(entry.name)) walk(join(root, entry.name), names, found, depth + 1, seen);
    else if (entry.isFile() && names.has(entry.name)) found.push(join(root, entry.name));
  }
  return found;
}

/**
 * The settings one part of a version ends up with from its files: php.ini,
 * then every conf.d file in name order, as PHP reads them. Module loading is
 * left out; modules are compared on their own.
 */
export function effectiveIni(sapiDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const confD = join(sapiDir, 'conf.d');
  const files = [join(sapiDir, 'php.ini'), ...(existsSync(confD) ? readdirSync(confD).filter((f) => f.endsWith('.ini')).sort().map((f) => join(confD, f)) : [])];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of parseIni(text)) if (key !== 'extension' && key !== 'zend_extension') out.set(key, value);
  }
  return out;
}

const configFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.conf')).map((f) => join(dir, f)) : []);

export function readFpmFindings(config: SystemConfig): PhpFpmFinding[] {
  const findings: PhpFpmFinding[] = [];
  const confEnabled = join(dirname(config.APACHE_SITES_AVAILABLE), 'conf-enabled');

  const apacheFiles = [...configFiles(config.APACHE_SITES_ENABLED), ...configFiles(confEnabled)].filter((f) => {
    try {
      return phpDirectivesOutsideModPhp(readFileSync(f, 'utf8')) > 0;
    } catch {
      return false;
    }
  });
  findings.push(
    apacheFiles.length > 0
      ? { id: 'apache-php-value', status: 'warn', text: 'Apache config sets PHP settings with php_value, which only mod_php understands: Apache would refuse to start without mod_php. Move them to the PHP settings of the site or version.', files: apacheFiles }
      : { id: 'apache-php-value', status: 'ok', text: 'No Apache config sets PHP settings with php_value.' },
  );

  const siteFiles = walk(config.WEB_DIR, new Set(['.htaccess', '.user.ini']));
  const htaccess = siteFiles.filter((f) => f.endsWith('.htaccess')).filter((f) => {
    try {
      return phpDirectivesOutsideModPhp(readFileSync(f, 'utf8')) > 0;
    } catch {
      return false;
    }
  });
  const rel = (f: string) => relative(config.WEB_DIR, f);
  findings.push(
    htaccess.length > 0
      ? { id: 'htaccess-php-value', status: 'warn', text: '.htaccess files set PHP settings with php_value: on PHP-FPM those sites answer with error 500. Move the values to the site\'s PHP settings, or wrap them in <IfModule mod_php.c>.', files: htaccess.map(rel) }
      : { id: 'htaccess-php-value', status: 'ok', text: 'No .htaccess in your sites sets PHP settings with php_value.' },
  );
  const userIni = siteFiles.filter((f) => f.endsWith('.user.ini'));
  findings.push(
    userIni.length > 0
      ? { id: 'user-ini', status: 'warn', text: '.user.ini files are ignored by mod_php but read by PHP-FPM, so their settings start to apply (a security plugin\'s auto_prepend_file, for one).', files: userIni.map(rel) }
      : { id: 'user-ini', status: 'ok', text: 'No .user.ini files in your sites.' },
  );

  if (existsSync(join(confEnabled, 'phpmyadmin.conf'))) {
    findings.push({ id: 'phpmyadmin', status: 'info', text: 'phpMyAdmin keeps its upload folder and folder limit in mod_php blocks. It runs on mod_php until mod_php goes off, then gets a pool of its own with the same settings.' });
  }

  for (const { version, sapis } of installedVersions(config)) {
    if (!sapis.includes('apache2') || !sapis.includes('fpm')) continue;
    const base = join(config.PHP_CONF_DIR, version);
    const differs = diffIni(effectiveIni(join(base, 'apache2')), effectiveIni(join(base, 'fpm')));
    findings.push(
      differs.length > 0
        ? { id: 'ini-differs', status: 'warn', version, text: `PHP ${version}: FPM's settings differ from Apache's in ${differs.map((d) => d.key).join(', ')}. A site moved to FPM ${version} would get FPM's values: make PHP-FPM ${version} match Apache first.` }
        : { id: 'ini-differs', status: 'ok', text: `PHP ${version}: Apache and FPM have the same settings.` },
    );
    const modules = readPhpModules(config, version).filter((m) => m.apache2 !== m.fpm).map((m) => `${m.name} (${m.apache2 ? 'on for Apache only' : 'on for FPM only'})`);
    findings.push(
      modules.length > 0
        ? { id: 'modules-differ', status: 'warn', version, text: `PHP ${version}: modules differ between Apache and FPM: ${modules.join(', ')}.` }
        : { id: 'modules-differ', status: 'ok', text: `PHP ${version}: Apache and FPM have the same modules on.` },
    );
  }
  return findings;
}

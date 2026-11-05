import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PhpIniChange, PhpIniDiff, PhpIniReport, PhpSapi } from '@devmagic-panel/shared';
import { PHP_SAPIS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';

/**
 * Whether a version has a part (apache2, fpm, cli): its package's marker in
 * PHP_LIB_DIR/<version>/sapi and its config folder. Removing mod_php leaves
 * /etc/php/<version>/apache2/php.ini behind, so the folder alone is not enough.
 */
export const hasSapi = (config: SystemConfig, version: string, sapi: PhpSapi): boolean =>
  existsSync(join(config.PHP_LIB_DIR, version, 'sapi', sapi)) && existsSync(join(config.PHP_CONF_DIR, version, sapi));

/** The panel's own files in a conf.d start with this, like 99-devmagic-panel.ini. */
export const PANEL_INI_PREFIX = '99-devmagic-panel';

/**
 * The settings an ini file sets, in the order it first sets them: `key = value`
 * lines outside comments, quotes taken off, a comment after an unquoted value
 * dropped. Section headers like [PHP] are only labels for PHP and are skipped.
 * A key set twice (extension=) keeps every value, joined with ", ".
 */
export function parseIni(text: string): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const m = /^([A-Za-z0-9_.[\]-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    const quoted = /^"([^"]*)"/.exec(value);
    value = quoted ? (quoted[1] as string) : value.replace(/\s*;.*$/, '').trim();
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return new Map([...out].map(([k, v]) => [k, v.join(', ')]));
}

/** What `current` sets differently from `original`: changed, added and removed keys, in the order they appear. */
export function diffIni(original: Map<string, string>, current: Map<string, string>): PhpIniChange[] {
  const changes: PhpIniChange[] = [];
  for (const [key, value] of current) {
    const before = original.get(key);
    if (before === value) continue;
    changes.push({ key, ...(before !== undefined ? { original: before } : {}), current: value });
  }
  for (const [key, value] of original) if (!current.has(key)) changes.push({ key, original: value });
  return changes;
}

/** The php.ini a version's package ships for one part: the command line has its own copy on Debian. */
export function packagedIni(config: SystemConfig, version: string, sapi: PhpSapi): string | undefined {
  const dir = join(config.PHP_LIB_DIR, version);
  const files = sapi === 'cli' ? ['php.ini-production.cli', 'php.ini-production'] : ['php.ini-production'];
  return files.map((f) => join(dir, f)).find((f) => existsSync(f));
}

/** Files in a conf.d that are not phpenmod's links into mods-available. */
function extraFiles(confD: string): PhpIniDiff['extraFiles'] {
  if (!existsSync(confD)) return [];
  const available = join(dirname(dirname(confD)), 'mods-available');
  return readdirSync(confD)
    .filter((name) => name.endsWith('.ini'))
    .filter((name) => {
      const path = join(confD, name);
      if (!lstatSync(path).isSymbolicLink()) return true;
      const target = readlinkSync(path);
      return dirname(target.startsWith('/') ? target : join(confD, target)) !== available;
    })
    .sort()
    .map((name) => ({ name, panel: name.startsWith(PANEL_INI_PREFIX) }));
}

/** One part's php.ini compared with the packaged one, or undefined when the part has no php.ini. */
export function readIniDiff(config: SystemConfig, version: string, sapi: PhpSapi): PhpIniDiff | undefined {
  const file = join(config.PHP_CONF_DIR, version, sapi, 'php.ini');
  if (!hasSapi(config, version, sapi) || !existsSync(file)) return undefined;
  const original = packagedIni(config, version, sapi);
  const changes = original ? diffIni(parseIni(readFileSync(original, 'utf8')), parseIni(readFileSync(file, 'utf8'))) : [];
  return { sapi, file, ...(original ? { original } : {}), changes, extraFiles: extraFiles(join(dirname(file), 'conf.d')) };
}

export function readIniReport(config: SystemConfig, version: string): PhpIniReport {
  return { version, sapis: PHP_SAPIS.map((sapi) => readIniDiff(config, version, sapi)).filter((d): d is PhpIniDiff => d !== undefined) };
}

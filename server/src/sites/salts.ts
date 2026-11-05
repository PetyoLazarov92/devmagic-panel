import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteSalts } from '@devmagic-panel/shared';
import { LEGACY_SALT_KEYS, WP_SALT_KEYS } from '@devmagic-panel/shared';
import type { WpConfig } from './wpconfig.js';

/** What wp-config-sample.php leaves in each key; WordPress treats it as no key at all. */
export const SALT_PLACEHOLDER = 'put your unique phrase here';

/**
 * The keys and salts the site's WordPress asks for: every constant its
 * wp-config-sample.php leaves at the placeholder, so a new one in a later
 * WordPress is picked up; else the 8 WordPress has used since 2.7.
 */
export function saltNames(docroot: string): string[] {
  try {
    const text = readFileSync(join(docroot, 'wp-config-sample.php'), 'utf8');
    const names = [...text.matchAll(/define\s*\(\s*(['"])([A-Z_]+)\1\s*,\s*(['"])put your unique phrase here\3\s*\)/g)].map((m) => m[2] as string);
    return names.length > 0 ? [...new Set(names)] : [...WP_SALT_KEYS];
  } catch {
    return [...WP_SALT_KEYS];
  }
}

/**
 * The legacy keys the site's WordPress still reads: those its wp_salt() checks
 * by name (the current ones it builds from parts) that wp-config-sample.php no
 * longer lists, SECRET_KEY and SECRET_SALT today. The pair as WordPress has it
 * now when its pluggable.php cannot be read.
 */
export function legacySaltNames(docroot: string, names: readonly string[]): string[] {
  try {
    const php = readFileSync(join(docroot, 'wp-includes', 'pluggable.php'), 'utf8');
    const start = php.indexOf('function wp_salt(');
    if (start === -1) return [...LEGACY_SALT_KEYS];
    // Its body runs to the next pluggable function, each wrapped in function_exists().
    const end = php.indexOf('function_exists(', start);
    const body = php.slice(start, end === -1 ? undefined : end);
    return [...new Set([...body.matchAll(/defined\s*\(\s*(['"])([A-Z_]+)\1\s*\)/g)].map((m) => m[2] as string))].filter((name) => !names.includes(name));
  } catch {
    return [...LEGACY_SALT_KEYS];
  }
}

/**
 * Which keys WordPress would not use from wp-config.php, as wp_salt() decides:
 * missing, left at the placeholder, or the same value as another key (legacy
 * SECRET_KEY and SECRET_SALT count). For those it makes its own and keeps them
 * in the database. A value written as code, like getenv(), counts as set.
 * Names come from the site's own WordPress, so a later one is followed.
 */
export function saltStatus(wp: Pick<WpConfig, 'constants'>, docroot: string): SiteSalts {
  const names = saltNames(docroot);
  const legacy = legacySaltNames(docroot, names);
  const find = (name: string) => wp.constants.find((c) => c.name === name);
  const seen = new Map<string, number>();
  for (const name of [...names, ...legacy]) {
    const value = find(name)?.value;
    if (typeof value === 'string') seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  const status: SiteSalts = { names, missing: [], placeholder: [], duplicate: [], legacy: legacy.filter((name) => find(name) !== undefined) };
  for (const name of names) {
    const c = find(name);
    if (!c) status.missing.push(name);
    else if (c.value === SALT_PLACEHOLDER || c.value === '') status.placeholder.push(name);
    else if (typeof c.value === 'string' && (seen.get(c.value) ?? 0) > 1) status.duplicate.push(name);
  }
  return status;
}

/** The keys WordPress does not take from wp-config.php, in the order the sample lists them. */
export const badSalts = (s: SiteSalts): string[] => s.names.filter((n) => s.missing.includes(n) || s.placeholder.includes(n) || s.duplicate.includes(n));

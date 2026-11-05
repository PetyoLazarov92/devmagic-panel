import type { WpDebugConstant } from '@devmagic-panel/shared';
import { WP_DEBUG_CONSTANTS } from '@devmagic-panel/shared';

/**
 * Reads constants from wp-config.php without running PHP. Comments are
 * skipped and the first definition wins, as in PHP (a second define() is
 * ignored with a warning). Values set conditionally (inside an if) are
 * still read; that is good enough for display.
 */
export interface WpConfig {
  dbName?: string;
  dbUser?: string;
  dbHost?: string;
  dbCharset?: string;
  tablePrefix?: string;
  multisite: boolean;
  subdomainInstall: boolean;
  domainCurrentSite?: string;
  debug: boolean;
  /** true, false, or a custom log path. */
  debugLog: boolean | string;
  /** The debug constants wp-config.php defines; a custom log path counts as true. */
  debugConstants: Partial<Record<WpDebugConstant, boolean>>;
  /** Every constant it defines, first definition only, in its order: a plain value, or the PHP of one that is not. */
  constants: Array<{ name: string; value?: string | boolean | number; code?: string }>;
}

/**
 * The code without its comments, strings left whole: a key or salt holds
 * any character, // and /* and # among them, which are not comments there.
 */
function stripComments(php: string): string {
  let out = '';
  let i = 0;
  while (i < php.length) {
    const c = php[i] as string;
    const next = php[i + 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < php.length && php[j] !== c) j += php[j] === '\\' ? 2 : 1;
      out += php.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '*') {
      const end = php.indexOf('*/', i + 2);
      i = end === -1 ? php.length : end + 2;
    } else if ((c === '/' && next === '/') || c === '#') {
      const end = php.indexOf('\n', i);
      i = end === -1 ? php.length : end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** A define()'s value: a quoted string as a whole (a ; or ) inside it is text), else anything up to the closing ); */
export const DEFINE_VALUE = String.raw`'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^;]*?`;

function literal(raw: string): string | boolean | number | undefined {
  const v = raw.trim();
  const single = /^'((?:\\.|[^'\\])*)'$/s.exec(v);
  if (single) return (single[1] as string).replace(/\\(['\\])/g, '$1');
  const quoted = /^"(.*)"$/s.exec(v);
  if (quoted) return quoted[1];
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

export function parseWpConfig(php: string): WpConfig {
  const code = stripComments(php);
  const constants = new Map<string, string | boolean | number | undefined>();
  const raw = new Map<string, string>();
  const re = new RegExp(String.raw`define\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*,\s*(${DEFINE_VALUE})\s*\)\s*;`, 'g');
  for (const m of code.matchAll(re)) {
    const name = m[2] as string;
    if (constants.has(name)) continue;
    constants.set(name, literal(m[3] ?? ''));
    raw.set(name, (m[3] ?? '').trim());
  }
  const prefix = /\$table_prefix\s*=\s*(['"])([A-Za-z0-9_]+)\1/.exec(code)?.[2];
  const str = (k: string) => {
    const v = constants.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const debugLog = constants.get('WP_DEBUG_LOG');

  return {
    ...(str('DB_NAME') !== undefined ? { dbName: str('DB_NAME') as string } : {}),
    ...(str('DB_USER') !== undefined ? { dbUser: str('DB_USER') as string } : {}),
    ...(str('DB_HOST') !== undefined ? { dbHost: str('DB_HOST') as string } : {}),
    ...(str('DB_CHARSET') ? { dbCharset: str('DB_CHARSET') as string } : {}),
    ...(prefix ? { tablePrefix: prefix } : {}),
    multisite: constants.get('MULTISITE') === true,
    subdomainInstall: constants.get('SUBDOMAIN_INSTALL') === true,
    ...(str('DOMAIN_CURRENT_SITE') ? { domainCurrentSite: str('DOMAIN_CURRENT_SITE') as string } : {}),
    debug: constants.get('WP_DEBUG') === true,
    debugLog: typeof debugLog === 'string' ? debugLog : debugLog === true,
    debugConstants: Object.fromEntries(
      WP_DEBUG_CONSTANTS.filter((name) => constants.has(name)).map((name) => {
        const v = constants.get(name);
        return [name, v === true || (name === 'WP_DEBUG_LOG' && typeof v === 'string' && v !== '')];
      }),
    ),
    constants: [...constants].map(([name, value]) => (value === undefined ? { name, code: raw.get(name) ?? '' } : { name, value })),
  };
}

/** The WordPress version from wp-includes/version.php. */
export function parseWpVersion(versionPhp: string): string | undefined {
  return /\$wp_version\s*=\s*['"]([^'"]+)['"]/.exec(versionPhp)?.[1];
}

/**
 * DB_PASSWORD, read only where the panel needs it: making a restored site's
 * database user again. It is never part of WpConfig, so it never reaches the
 * browser or Claude. Commented-out lines are skipped; quotes may be escaped.
 */
export function readDbPassword(php: string): string | undefined {
  for (const line of php.split('\n')) {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('#') || code.startsWith('*') || code.startsWith('/*')) continue;
    const m = /define\s*\(\s*(['"])DB_PASSWORD\1\s*,\s*(['"])((?:\\.|(?!\2).)*)\2\s*\)/.exec(code);
    if (m) return (m[3] ?? '').replace(/\\(['"\\])/g, '$1');
  }
  return undefined;
}

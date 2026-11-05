import { randomInt } from 'node:crypto';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
/** Symbols that need no escaping in wp-config.php, SQL strings or a shell. */
const SYMBOLS = '-_';
const ALL = LOWER + UPPER + DIGITS;

/**
 * A password for a site's own MySQL user that passes MySQL's validate_password
 * policy at any level: 24 characters with at least one lowercase letter,
 * uppercase letter, digit and symbol, at random positions.
 */
export function mysqlPassword(length = 24): string {
  const chars = Array.from({ length: length - 4 }, () => ALL[randomInt(ALL.length)] as string);
  for (const set of [LOWER, UPPER, DIGITS, SYMBOLS]) chars.splice(randomInt(chars.length + 1), 0, set[randomInt(set.length)] as string);
  return chars.join('');
}

/** MySQL refused a password under its validate_password policy (ERROR 1819). */
export const isPolicyRefusal = (stderr: string) => /\bERROR 1819\b/.test(stderr);

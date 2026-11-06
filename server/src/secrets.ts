import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Per-user secrets in ~/.config/devmagic-panel/secrets.json, mode 0600.
 * The panel password is stored as a scrypt hash only. Nothing in here is
 * ever logged or sent to an AI.
 */
export interface Secrets {
  panelPasswordHash: string;
  /** When the panel password was last set, by setup, set-password or the panel. */
  panelPasswordChangedAt?: string;
  mysql?: {
    user: string;
    password: string;
    host: string;
  };
  /** The SQL runner's account: SELECT and SHOW VIEW only (mysql-admin.ts). */
  mysqlReadOnly?: {
    user: string;
    password: string;
    host: string;
  };
  /** The assistant's Anthropic API key, when saved in the panel. */
  anthropic?: { apiKey: string };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readSecrets(file: string): Secrets | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes the whole file in one rename, so a crash never leaves half a secrets file and no panel password. */
export function writeSecrets(file: string, secrets: Secrets): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Panels before v0.7.0 kept a GitHub token for their updates; they need none
 * now. Deletes it from secrets.json and notes when, in markerFile, so the
 * Updates page can say to revoke it on GitHub. True when one was deleted.
 */
export function removeGithubToken(file: string, markerFile: string, now = new Date()): boolean {
  const current = readSecrets(file) as (Secrets & { github?: unknown }) | null;
  if (!current || !('github' in current)) return false;
  const { github: _old, ...rest } = current;
  writeSecrets(file, rest);
  mkdirSync(dirname(markerFile), { recursive: true, mode: 0o700 });
  writeFileSync(markerFile, `${now.toISOString()}\n`, { mode: 0o600 });
  return true;
}

/** The note for the Updates page, for 30 days after the token was deleted. */
export function githubTokenNotice(markerFile: string, now = Date.now()): string | undefined {
  try {
    if (now - statSync(markerFile).mtimeMs > 30 * 86_400_000) return undefined;
  } catch {
    return undefined;
  }
  return 'The panel no longer uses a GitHub token: the one it saved is deleted. Revoke it on GitHub too, at github.com/settings/personal-access-tokens.';
}

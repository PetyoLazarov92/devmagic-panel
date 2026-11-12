import { readSecrets, type Secrets, writeSecrets } from './secrets.js';

/**
 * A server's SSH password, saved in the panel when you ask, for the runs that
 * sign in there (a refresh from production, uploads, plugins copied from the
 * server). It lives in secrets.json (0600) with the MySQL admin account, one
 * per host as you wrote it, and goes back to no browser: the panel only says
 * that one is saved. It reaches ssh the way a typed one does, through the
 * askpass helper and its FIFO (ssh-password.ts), never argv, the environment,
 * a log, run history or an AI. A password typed for a run wins over it.
 */

/** The key a host is saved under: as written, without case, so `Spellbook-prod` and `spellbook-prod` are one. */
export const sshKey = (host: string) => host.trim().toLowerCase();

/** What ssh's askpass helper can hand on in one line: no line break or NUL, at most 1024 characters. */
export const isSavablePassword = (password: string) => password.length > 0 && password.length <= 1024 && !/[\r\n\0]/.test(password);

/** The saved password for a host, if there is one. */
export function savedSshPassword(secrets: Secrets | null | undefined, host: string): string | undefined {
  return secrets?.sshPasswords?.[sshKey(host)];
}

/** Saves or replaces a host's password. False when the panel has no secrets file yet (setup not run). */
export function saveSshPassword(file: string, host: string, password: string): boolean {
  if (!isSavablePassword(password)) throw new Error('A password of one line, up to 1024 characters');
  const current = readSecrets(file);
  if (!current) return false;
  writeSecrets(file, { ...current, sshPasswords: { ...current.sshPasswords, [sshKey(host)]: password } });
  return true;
}

/** Forgets a host's password; true when there was one. */
export function forgetSshPassword(file: string, host: string): boolean {
  const current = readSecrets(file);
  const key = sshKey(host);
  if (!current?.sshPasswords || !(key in current.sshPasswords)) return false;
  const { [key]: _gone, ...rest } = current.sshPasswords;
  const { sshPasswords: _all, ...others } = current;
  writeSecrets(file, Object.keys(rest).length > 0 ? { ...others, sshPasswords: rest } : others);
  return true;
}

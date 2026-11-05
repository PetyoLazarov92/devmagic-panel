import { panelPasswordProblem } from '@devmagic-panel/shared';
import type { Executor } from './exec.js';
import { hashPassword, type Secrets, writeSecrets } from './secrets.js';

/**
 * Changing the panel password, and resetting a forgotten one with the
 * computer password. Neither is a registry action: the bodies are secrets,
 * never logged, never seen by the assistant.
 */

/** Writes a new panel password's hash, keeping the other secrets. Sessions made with the old one end by themselves. */
export async function setPanelPassword(file: string, current: Secrets, password: string, now = new Date()): Promise<void> {
  writeSecrets(file, { ...current, panelPasswordHash: await hashPassword(password), panelPasswordChangedAt: now.toISOString() });
}

/** Why a new password cannot be used, by the shared rules, or undefined. */
export const newPasswordProblem = (password: unknown, user: string): string | undefined =>
  typeof password !== 'string' ? 'Give a new password' : panelPasswordProblem(password, user);

export interface ResetWays {
  /** The computer password can prove who you are: sudo asks this account for one. */
  system: boolean;
  /** Why it cannot, when it cannot. */
  reason?: string;
  /** The terminal command, which always works. */
  command: string;
}

export const SET_PASSWORD_COMMAND = 'node ~/.local/share/devmagic-panel/current/server/dist/cli.js set-password';

/**
 * Whether the computer password proves anything here: sudo has to ask this
 * account for one. -k ignores a credential sudo still holds, -n never waits.
 * When sudo asks for none (NOPASSWD for everything) or the account may not use
 * sudo, the login page offers the terminal only.
 */
export async function resetWays(exec: Executor): Promise<ResetWays> {
  const r = await exec('sudo', ['-n', '-k', '-v'], { timeoutMs: 10_000 });
  if (r.code === 0) return { system: false, reason: 'sudo here asks for no password, so your computer password cannot prove who you are', command: SET_PASSWORD_COMMAND };
  if (/password is required/i.test(r.stderr)) return { system: true, command: SET_PASSWORD_COMMAND };
  return { system: false, reason: 'this account may not use sudo, which checks the computer password', command: SET_PASSWORD_COMMAND };
}

/**
 * Checks the computer password with sudo: on stdin only, -v runs no command,
 * -k so an earlier credential cannot stand in for it; sudo -K drops the one it
 * made either way.
 */
export async function checkSystemPassword(exec: Executor, password: string): Promise<boolean> {
  const r = await exec('sudo', ['-k', '-S', '-p', '', '-v'], { input: `${password}\n`, timeoutMs: 20_000 });
  await exec('sudo', ['-K'], { timeoutMs: 10_000 });
  return r.code === 0;
}

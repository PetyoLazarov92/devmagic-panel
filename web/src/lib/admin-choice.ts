import type { UploadResult } from '@devmagic-panel/shared';

/** What the admin rule reads from the wizard. */
export interface AdminState {
  source: string;
  upload: UploadResult | null;
  adminCreate: boolean | null;
  adminIfExists: 'keep' | 'update';
  adminIfMissing: 'create' | 'skip';
}

/**
 * The admins of a dump by login (a network's super admins), when the scan
 * read its users through; undefined when it could not tell.
 */
export function dumpAdmins(state: AdminState): string[] | undefined {
  const facts = state.source === 'repo' ? state.upload?.facts : undefined;
  return facts ? (facts.multisite ? facts.superAdmins : facts.admins) : undefined;
}

/** Make an admin for this copy: your choice, else on only when the dump has none. */
export const adminCreateOf = (state: AdminState) => state.adminCreate ?? (dumpAdmins(state)?.length ?? 0) === 0;

/**
 * What the install does with the admin user. With the dump's admins known,
 * the switch decides: on gives the user this password and the admin role,
 * creating it when missing; off touches no user. Otherwise your two choices.
 */
export function adminChoices(state: AdminState): { ifExists: 'keep' | 'update'; ifMissing: 'create' | 'skip' } {
  if (!dumpAdmins(state)) return { ifExists: state.adminIfExists, ifMissing: state.adminIfMissing };
  return adminCreateOf(state) ? { ifExists: 'update', ifMissing: 'create' } : { ifExists: 'keep', ifMissing: 'skip' };
}

/**
 * The one user a cleaned copy keeps: the WordPress step's admin, kept as it
 * is when it is an administrator of the dump and you make none, else made
 * with this password.
 */
export function cleanUserOf(state: AdminState, user: string, password: string): { keep?: string; login: string; password: string } {
  const admin = (dumpAdmins(state) ?? []).find((login) => login.toLowerCase() === user.toLowerCase());
  return admin && !adminCreateOf(state) ? { keep: admin, login: user, password } : { login: user, password };
}

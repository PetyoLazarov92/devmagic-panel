import { randomBytes } from 'node:crypto';
import { pingMysql } from './environment.js';
import type { ExecResult, Executor } from './exec.js';
import type { Secrets } from './secrets.js';

/** The MySQL account setup can make for the panel when no account you have works. */
export const PANEL_MYSQL_USER = 'devmagic_panel';

/** The SQL that makes the account, or gives it a new password when it is there. */
export function panelAccountSql(password: string, user = PANEL_MYSQL_USER): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error('unsafe password for SQL');
  const account = `'${user}'@'localhost'`;
  return [
    `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY '${password}';`,
    `ALTER USER ${account} IDENTIFIED BY '${password}';`,
    // The panel makes and drops site databases and their users, and grants them rights.
    `GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION;`,
    'FLUSH PRIVILEGES;',
    '',
  ].join('\n');
}

/**
 * Makes (or resets) the panel's own MySQL admin account, for setup. On a new
 * MySQL or MariaDB, root signs in only through the socket as the system
 * root, so this runs `sudo mysql` once: sudo asks for your password on the
 * terminal, never through the sudoers rule. The password is generated and
 * goes to MySQL over stdin only.
 */
export async function createPanelAccount(
  exec: Executor,
  password = randomBytes(24).toString('base64url'),
): Promise<{ account: NonNullable<Secrets['mysql']> } | { problem: string }> {
  const firstLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;
  const made = await exec('sudo', ['mysql'], { input: panelAccountSql(password), timeoutMs: 120_000 });
  if (made.code !== 0) return { problem: firstLine(made) };
  const account = { user: PANEL_MYSQL_USER, host: 'localhost', password };
  const ping = await pingMysql(exec, account);
  return ping.code === 0 ? { account } : { problem: `made ${PANEL_MYSQL_USER}, but cannot sign in with it: ${firstLine(ping)}` };
}

/** The account the SQL runner reads with: SELECT and SHOW VIEW only, so MySQL itself refuses any change. */
export const READ_ONLY_MYSQL_USER = 'devmagic_panel_ro';

/**
 * The SQL that makes the read-only account, or gives it a new password and
 * takes away any other right it was given since. Run with the admin account,
 * the password on stdin only.
 */
export function readOnlyAccountSql(password: string, user = READ_ONLY_MYSQL_USER): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error('unsafe password for SQL');
  const account = `'${user}'@'localhost'`;
  return [
    `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY '${password}';`,
    `ALTER USER ${account} IDENTIFIED BY '${password}';`,
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};`,
    `GRANT SELECT, SHOW VIEW ON *.* TO ${account};`,
    'FLUSH PRIVILEGES;',
    '',
  ].join('\n');
}

/** Makes (or resets) the read-only account with the admin account, and checks it signs in. */
export async function createReadOnlyAccount(
  exec: Executor,
  admin: NonNullable<Secrets['mysql']>,
  password = randomBytes(24).toString('base64url'),
): Promise<{ account: NonNullable<Secrets['mysqlReadOnly']> } | { problem: string }> {
  const firstLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;
  const made = await exec('mysql', ['--batch', '--skip-column-names', '--user', admin.user, '--host', admin.host], {
    env: { MYSQL_PWD: admin.password },
    input: readOnlyAccountSql(password),
    timeoutMs: 30_000,
  });
  if (made.code !== 0) return { problem: firstLine(made) };
  const account = { user: READ_ONLY_MYSQL_USER, host: 'localhost', password };
  const ping = await pingMysql(exec, account);
  return ping.code === 0 ? { account } : { problem: `made ${READ_ONLY_MYSQL_USER}, but cannot sign in with it: ${firstLine(ping)}` };
}

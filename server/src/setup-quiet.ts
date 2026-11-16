import { panelPasswordProblem } from '@devmagic-panel/shared';
import { pingMysql } from './environment.js';
import type { Executor } from './exec.js';
import { createPanelAccount, PANEL_MYSQL_USER } from './mysql-admin.js';
import type { Secrets } from './secrets.js';

/**
 * cli.js setup --yes, for the Windows setup, which asks its questions in its
 * own window: no question here. The panel password comes on stdin (never on a
 * command line) or the current one is kept; the MySQL account is the saved one
 * when it signs in, else the panel's own made with sudo mysql.
 */

export type QuietPassword = { keep: true } | { keep: false; password: string } | { refused: string };

/** What setup --yes does with the panel password: keep it, take the new one, or say why not. */
export function quietPanelPassword(keepFlag: boolean, hasPassword: boolean, stdinLine: string, user: string): QuietPassword {
  if (keepFlag) return hasPassword ? { keep: true } : { refused: 'no panel password is set yet to keep: give a new one on stdin' };
  const problem = panelPasswordProblem(stdinLine, user);
  return problem ? { refused: problem } : { keep: false, password: stdinLine };
}

/** The saved MySQL account when it signs in, else the panel's own made with sudo mysql, else none for now (the Machine checks offer it). */
export async function quietMysql(exec: Executor, current: Secrets['mysql'], say: (line: string) => void): Promise<Secrets['mysql']> {
  if (current && (await pingMysql(exec, current)).code === 0) {
    say(`MySQL: the saved account, ${current.user}@${current.host}, signs in.`);
    return current;
  }
  const made = await createPanelAccount(exec);
  if ('account' in made) {
    say(`MySQL: made ${PANEL_MYSQL_USER}@localhost for the panel; its password is only in the panel's secrets file.`);
    return made.account;
  }
  say(`MySQL: could not make the panel's account (${made.problem}); the Machine checks offer it again.`);
  return current;
}

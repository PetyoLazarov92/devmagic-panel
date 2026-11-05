import { describe, expect, it } from 'vitest';
import { createPanelAccount, panelAccountSql, PANEL_MYSQL_USER } from '../src/mysql-admin.js';
import { fakeExec } from './helpers.js';

const password = 'Abcdefghijklmnop_-0123456789';

describe('the panel MySQL account setup offers', () => {
  it('makes the account with sudo mysql, the password only on stdin, and signs in with it', async () => {
    const { exec, calls } = fakeExec({ 'sudo mysql': {}, 'mysql --user': { stdout: '1\n' } });
    const made = await createPanelAccount(exec, password);
    expect(made).toEqual({ account: { user: PANEL_MYSQL_USER, host: 'localhost', password } });
    expect(calls[0]).toMatchObject({ file: 'sudo', args: ['mysql'] });
    expect(calls[0]?.input).toContain(`CREATE USER IF NOT EXISTS 'devmagic_panel'@'localhost' IDENTIFIED BY '${password}';`);
    expect(calls[0]?.input).toContain('WITH GRANT OPTION;');
    for (const call of calls) expect(call.args.join(' ')).not.toContain(password);
    expect(calls[1]?.env).toEqual({ MYSQL_PWD: password });
  });

  it('says why when sudo or the new account does not work', async () => {
    expect(await createPanelAccount(fakeExec({ 'sudo mysql': { code: 1, stderr: 'sudo: a terminal is required\n' } }).exec, password)).toEqual({
      problem: 'sudo: a terminal is required',
    });
    const signIn = await createPanelAccount(fakeExec({ 'sudo mysql': {}, 'mysql --user': { code: 1, stderr: 'Access denied\n' } }).exec, password);
    expect(signIn).toEqual({ problem: 'made devmagic_panel, but cannot sign in with it: Access denied' });
  });

  it('never puts anything but a generated password into the SQL', () => {
    expect(() => panelAccountSql("x'; DROP DATABASE wp; --")).toThrow();
    expect(() => panelAccountSql('short')).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { quietMysql, quietPanelPassword } from '../src/setup-quiet.js';
import { fakeExec } from './helpers.js';

describe('setup --yes, the panel password', () => {
  it('keeps the current one only when there is one', () => {
    expect(quietPanelPassword(true, true, '', 'alex')).toEqual({ keep: true });
    expect(quietPanelPassword(true, false, '', 'alex')).toMatchObject({ refused: expect.stringContaining('no panel password is set yet') });
  });

  it('takes a new one from stdin by the panel form rules, and says why not', () => {
    expect(quietPanelPassword(false, true, 'blue-owl-at-noon', 'alex')).toEqual({ keep: false, password: 'blue-owl-at-noon' });
    expect(quietPanelPassword(false, false, 'short', 'alex')).toEqual({ refused: 'At least 8 characters' });
    expect(quietPanelPassword(false, false, 'password123', 'alex')).toMatchObject({ refused: expect.stringContaining('Too common') });
    expect(quietPanelPassword(false, false, 'alex2026!', 'alex')).toMatchObject({ refused: expect.stringContaining('user name') });
    expect(quietPanelPassword(false, false, '', 'alex')).toEqual({ refused: 'At least 8 characters' });
  });
});

describe('setup --yes, the MySQL account', () => {
  const saved = { user: 'root', host: 'localhost', password: 'db-secret' };

  it('keeps a saved account that signs in, and makes nothing', async () => {
    const fake = fakeExec({ mysql: { stdout: '1\n' } });
    const lines: string[] = [];
    expect(await quietMysql(fake.exec, saved, (l) => lines.push(l))).toEqual(saved);
    expect(lines).toEqual(['MySQL: the saved account, root@localhost, signs in.']);
    expect(fake.calls.some((c) => c.file === 'sudo')).toBe(false);
  });

  it("makes the panel's own account through sudo mysql when none signs in, and says so", async () => {
    let made = false;
    const fake = fakeExec({
      sudo: () => {
        made = true;
        return {};
      },
      mysql: () => (made ? { stdout: '1\n' } : { code: 1, stderr: 'Access denied' }),
    });
    const lines: string[] = [];
    const account = await quietMysql(fake.exec, saved, (l) => lines.push(l));
    expect(account).toMatchObject({ user: 'devmagic_panel', host: 'localhost' });
    expect(fake.calls.find((c) => c.file === 'sudo')?.args).toEqual(['mysql']);
    expect(lines).toEqual(["MySQL: made devmagic_panel@localhost for the panel; its password is only in the panel's secrets file."]);
  });

  it('goes on without an account when sudo mysql fails, keeping what was saved', async () => {
    const fake = fakeExec({ sudo: { code: 1, stderr: 'sudo: a password is required' }, mysql: { code: 1, stderr: 'Access denied' } });
    const lines: string[] = [];
    expect(await quietMysql(fake.exec, saved, (l) => lines.push(l))).toEqual(saved);
    expect(lines[0]).toContain("could not make the panel's account (sudo: a password is required)");
  });
});

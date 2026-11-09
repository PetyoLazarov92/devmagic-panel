import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { actions } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { withoutPasswords } from '../src/actions.js';
import type { JobStep } from '../src/jobs.js';
import { planServerDump, serverSignIn, SSH_OPTIONS } from '../src/sites/more-dumps.js';
import { oncePassword, PASSWORD_OPTIONS, withSshPassword } from '../src/sites/ssh-password.js';
import { DMP, fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

const SECRET = 'correct horse battery';
const DONE = "-- MySQL dump\nCREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.spellbook.example','yes');\n-- Dump completed on 2026-11-10 10:00:00\n";
const job = () => ({ progress: () => undefined, onUndo: () => undefined }) as unknown as Parameters<JobStep['run']>[0];

function setup(responses: Record<string, FakeResponse>) {
  const t = wpSiteTree();
  const runtimeDir = join(t.root, 'run');
  mkdirSync(runtimeDir);
  const fake = fakeExec({ mkfifo: { stdout: '' }, ...responses });
  const fed: string[] = [];
  const feed = async (_fifo: string, text: string) => void fed.push(text);
  const ctx = { config: t.config, exec: fake.exec, uploadsDir: join(t.root, 'uploads'), dmpRoot: DMP, sshPassword: { runtimeDir, feed } };
  return { ctx, fake, fed, runtimeDir, feed };
}

describe('a server that asks for a password', () => {
  it('signs ssh and sftp in through the helper, with the password in no argument, environment or input, and leaves nothing behind', async () => {
    const s = setup({ ssh: { stdout: 'ok' }, sftp: { stdout: '' }, git: { stdout: '' } });
    const out = await withSshPassword({ exec: s.fake.exec, runtimeDir: s.runtimeDir, feed: s.feed }, SECRET, async (exec) => {
      await exec('ssh', [...SSH_OPTIONS, '--', 'alex@www.spellbook.example', 'true'], { env: { LANG: 'C' } });
      await exec('sftp', ['-q', '-b', '-', ...SSH_OPTIONS, '--', 'alex@www.spellbook.example'], { input: 'get /a.sql /tmp/a.sql\n' });
      await exec('git', ['status']);
      return 'done';
    });
    expect(out).toBe('done');
    const [fifo, ssh, sftp, git] = s.fake.calls;
    expect(fifo).toMatchObject({ file: 'mkfifo', args: ['-m', '600', expect.stringContaining(s.runtimeDir)] });
    // Before ssh's own options, since ssh keeps the first value: prompts through the helper, one try, and still no new host key trusted.
    expect(ssh?.args.slice(0, 4)).toEqual(PASSWORD_OPTIONS);
    expect(ssh?.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', '--', 'alex@www.spellbook.example', 'true']));
    expect(ssh?.env).toMatchObject({ LANG: 'C', SSH_ASKPASS_REQUIRE: 'force', DMP_ASKPASS_FIFO: fifo?.args[2] });
    expect(sftp?.args.slice(0, 4)).toEqual(PASSWORD_OPTIONS);
    // Another program runs as it is.
    expect(git).toEqual({ file: 'git', args: ['status'] });
    expect(s.fed).toEqual([`${SECRET}\n`]);
    expect(JSON.stringify(s.fake.calls)).not.toContain(SECRET);
    expect(readdirSync(s.runtimeDir)).toEqual([]);
  });

  it('removes the FIFO and the helper when the work fails too', async () => {
    const s = setup({});
    await expect(withSshPassword({ exec: s.fake.exec, runtimeDir: s.runtimeDir, feed: s.feed }, SECRET, async () => Promise.reject(new Error('stopped')))).rejects.toThrow('stopped');
    expect(readdirSync(s.runtimeDir)).toEqual([]);
  });

  it('exports with the password given for the run, writes nothing on the server, and has none left for a Retry', async () => {
    const s = setup({ ssh: { stdout: DONE } });
    const steps = planServerDump(s.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [], password: SECRET }, () => undefined);
    const first = [await (steps[0] as JobStep).run(job())].flat();
    expect(first.every((r) => r.code === 0)).toBe(true);
    const ssh = s.fake.calls.filter((c) => c.file === 'ssh');
    expect(ssh).toHaveLength(1);
    expect(ssh[0]?.args.slice(0, 4)).toEqual(PASSWORD_OPTIONS);
    // Only WP-CLI's export runs there: nothing that writes, and no key is added.
    expect(ssh[0]?.args.slice(ssh[0].args.indexOf('--') + 2, ssh[0].args.indexOf('--') + 6)).toEqual(['wp', '--path=/var/www/spellbook', 'db', 'export']);
    expect(JSON.stringify(s.fake.calls)).not.toContain(SECRET);
    expect(first.map((r) => r.stdout + r.stderr).join('')).not.toContain(SECRET);
    // The password went when the step ended.
    const again = [await (steps[0] as JobStep).run(job())].flat();
    expect(again).toMatchObject([{ code: 1, stderr: 'The password was used once and is gone: start this again and give the password' }]);
    expect(s.fake.calls.filter((c) => c.file === 'ssh')).toHaveLength(1);
  });

  it('says the password was not taken, and where to give one when none was given', async () => {
    const denied = { code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey,password).' };
    const withOne = setup({ ssh: denied });
    const a = [await (planServerDump(withOne.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [], password: SECRET }, () => undefined)[0] as JobStep).run(job())].flat();
    expect(a[0]).toMatchObject({ code: 1, stderr: 'alex@www.spellbook.example did not take the password, or it does not let you sign in with one. Nothing was kept' });
    const without = setup({ ssh: denied });
    const b = [await (planServerDump(without.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined)[0] as JobStep).run(job())].flat();
    expect(b[0]?.stderr).toContain('refused your SSH key');
    expect(b[0]?.stderr).toContain('the field for it shows under the host');
    // Without a password ssh runs in batch mode as before: no helper, no FIFO.
    expect(without.fake.calls.some((c) => c.file === 'mkfifo')).toBe(false);
    expect(without.fake.calls[0]?.args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
  });

  it('asks how a server signs you in with one batch connection that runs only true, and no password', async () => {
    const ask = async (response: FakeResponse) => {
      const fake = fakeExec({ ssh: response });
      const answer = await serverSignIn(fake.exec, 'alex@www.spellbook.example');
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.args).toEqual([...SSH_OPTIONS, '--', 'alex@www.spellbook.example', 'true']);
      expect(fake.calls[0]?.env).toBeUndefined();
      return answer;
    };
    expect(await ask({ stdout: '' })).toEqual({ how: 'key' });
    expect(await ask({ code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey,password).' })).toEqual({ how: 'password' });
    expect(await ask({ code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey,keyboard-interactive).' })).toEqual({ how: 'password' });
    // Keys only: a password would not help, so none is asked for.
    expect(await ask({ code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey).' })).toMatchObject({ how: 'refused', problem: expect.stringContaining('takes SSH keys only') });
    expect(await ask({ code: 255, stderr: 'Host key verification failed.' })).toMatchObject({ how: 'unknown', problem: expect.stringContaining('is not in your known_hosts') });
    expect(await ask({ code: 255, stderr: 'ssh: connect to host www.spellbook.example port 22: Connection refused' })).toMatchObject({ how: 'unknown', problem: expect.stringContaining('Connection refused') });
  });

  it('hands a password out once, and run history never keeps it', () => {
    const once = oncePassword(SECRET);
    expect([once.given, once.take(), once.take()]).toEqual([true, SECRET, undefined]);
    expect(oncePassword(undefined).given).toBe(false);
    expect(oncePassword('').given).toBe(false);
    const parsed = actions['dump.fromServer'].input.parse({ host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', password: SECRET });
    expect(JSON.stringify(withoutPasswords(parsed))).not.toContain(SECRET);
    const refresh = actions['site.refreshFromProduction'].input.parse({ domain: 'local.spellbook.example', user: { login: 'admin', password: 'x' }, confirm: 'local.spellbook.example', password: SECRET });
    expect(JSON.stringify(withoutPasswords(refresh))).not.toContain(SECRET);
  });
});

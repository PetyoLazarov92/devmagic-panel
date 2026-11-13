import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { actions, isWpCliCommand, splitSshHost } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { withoutPasswords } from '../src/actions.js';
import type { JobStep } from '../src/jobs.js';
import { passwordSignIn, planServerDump, serverSignIn, serverTables, SSH_OPTIONS, sshProblem, sshTarget } from '../src/sites/more-dumps.js';
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

  it('tests a password with one sign-in through the helper that runs only true, and says when the server did not take it', async () => {
    const works = setup({ ssh: { stdout: '' } });
    expect(await passwordSignIn({ exec: works.fake.exec, runtimeDir: works.runtimeDir, feed: works.feed }, 'spellbook-prod', SECRET)).toEqual({ works: true });
    const ssh = works.fake.calls.find((c) => c.file === 'ssh');
    expect(ssh?.args).toEqual([...PASSWORD_OPTIONS, ...SSH_OPTIONS, '--', 'spellbook-prod', 'true']);
    expect(ssh?.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force' });
    expect(works.fed).toEqual([`${SECRET}\n`]);
    expect(JSON.stringify(works.fake.calls)).not.toContain(SECRET);
    expect(readdirSync(works.runtimeDir)).toEqual([]);
    const refused = setup({ ssh: { code: 255, stderr: 'Permission denied, please try again.\nspellbook-prod: Permission denied (publickey,password).' } });
    expect(await passwordSignIn({ exec: refused.fake.exec, runtimeDir: refused.runtimeDir, feed: refused.feed }, 'spellbook-prod', SECRET)).toMatchObject({ works: false, problem: expect.stringContaining('refused your SSH key') });
  });

  it('says how to add a host key in a terminal, and that the password prompt there can be closed', () => {
    const said = sshProblem('spellbook-prod', 'No ED25519 host key is known for spellbook-prod and you have requested strict checking.\nHost key verification failed.');
    expect(said).toContain('run ssh spellbook-prod in a terminal');
    expect(said).toContain('answer yes');
    expect(said).toContain('Ctrl+C');
    expect(sshProblem('spellbook-prod', 'ssh_askpass: exec(/run/user/1000/x/askpass): Permission denied\nPermission denied (publickey,password).')).toContain('could not ask the panel for the password');
  });

  it('takes a port after the host and gives it to ssh and sftp as an option of its own', async () => {
    expect(splitSshHost('alex@www.spellbook.example:2222')).toEqual({ host: 'alex@www.spellbook.example', port: 2222 });
    expect(splitSshHost('staging-spellbook')).toEqual({ host: 'staging-spellbook' });
    for (const bad of ['alex@www.spellbook.example:0', 'alex@www.spellbook.example:70000', 'alex@www.spellbook.example:22a', 'host:-oProxyCommand=x', '-p2222', 'host: 22', 'host:']) {
      expect(splitSshHost(bad)).toBeNull();
      expect(actions['dump.fromServer'].input.safeParse({ host: bad, mode: 'export', path: '/var/www' }).success).toBe(false);
    }
    expect(sshTarget('alex@www.spellbook.example:2222')).toEqual(['-p', '2222', '--', 'alex@www.spellbook.example']);
    expect(sshTarget('alex@www.spellbook.example:2222', 'sftp')).toEqual(['-P', '2222', '--', 'alex@www.spellbook.example']);
    expect(sshTarget('staging-spellbook')).toEqual(['--', 'staging-spellbook']);
    const fake = fakeExec({ ssh: { code: 255, stderr: 'Host key verification failed.' } });
    const answer = await serverSignIn(fake.exec, 'alex@www.spellbook.example:2222');
    expect(fake.calls[0]?.args).toEqual([...SSH_OPTIONS, '-p', '2222', '--', 'alex@www.spellbook.example', 'true']);
    // The command it says to type has the port the way ssh takes it.
    expect(answer.problem).toContain('ssh -p 2222 alex@www.spellbook.example');
  });

  it('runs WP-CLI by the name the server gives it, and takes only a program name or path', async () => {
    const s = setup({ ssh: { stdout: DONE } });
    const steps = planServerDump(s.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [], wpCli: 'wp-cli' }, () => undefined);
    expect([await (steps[0] as JobStep).run(job())].flat().every((r) => r.code === 0)).toBe(true);
    const args = s.fake.calls.find((c) => c.file === 'ssh')?.args ?? [];
    expect(args.slice(args.indexOf('--') + 2, args.indexOf('--') + 6)).toEqual(['wp-cli', '--path=/var/www/spellbook', 'db', 'export']);
    // The tables are read with the same command.
    const tables = fakeExec({ ssh: { stdout: '[{"Name":"wp_options","Size":"1048576"}]' } });
    await serverTables(tables.exec, 'staging-spellbook', '/var/www/spellbook', '~/bin/wp');
    expect(tables.calls[0]?.args.slice(tables.calls[0].args.indexOf('--') + 2, tables.calls[0].args.indexOf('--') + 4)).toEqual(['~/bin/wp', '--path=/var/www/spellbook']);
    // A server without it says which command was missing, and where to give another.
    const none = setup({ ssh: { code: 127, stderr: 'bash: line 1: wp: command not found' } });
    const out = [await (planServerDump(none.ctx, { host: 'staging-spellbook', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined)[0] as JobStep).run(job())].flat();
    expect(out[0]?.stderr).toContain('has no WP-CLI as wp');
    expect(out[0]?.stderr).toContain('give its command under the folder');
    for (const good of ['wp', 'wp-cli', '~/bin/wp', '/usr/local/bin/wp-cli.phar']) expect(isWpCliCommand(good)).toBe(true);
    for (const bad of ['wp --allow-root', '-wp', 'wp;id', 'wp$(id)', 'wp`id`', "wp'", 'php wp-cli.phar', '../wp', '/a/../wp', '']) {
      expect(isWpCliCommand(bad)).toBe(false);
      expect(actions['dump.fromServer'].input.safeParse({ host: 'staging', mode: 'export', path: '/var/www', wpCli: bad }).success).toBe(false);
    }
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

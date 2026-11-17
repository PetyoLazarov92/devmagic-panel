import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WP_CLI_RELEASE } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { Jobs, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { planSystemInstall } from '../src/system-install.js';
import type { HeldPassword } from '../src/update-install.js';
import { fakeExec } from './helpers.js';

const PHAR = Buffer.from('<?php pretend this is wp-cli');
const PIN = { version: '9.9.9', url: 'https://github.com/wp-cli/wp-cli/releases/download/v9.9.9/wp-cli-9.9.9.phar', sha256: createHash('sha256').update(PHAR).digest('hex') };

async function run(steps: ReturnType<typeof planSystemInstall>): Promise<JobView> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const view = jobs.start(steps, { runId: store.start('system.install', { items: [], password: '(hidden)' }), title: 'Install' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    if (v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(responses: Parameters<typeof fakeExec>[0] = {}) {
  const tmpDir = join(mkdtempSync(join(tmpdir(), 'dmp-sysinstall-')), 'tmp');
  const fake = fakeExec({ 'sudo -k -S -p  true': { stdout: '' }, 'sudo -k -S -p  env': { stdout: 'Setting up git (1:2.43.0-1ubuntu7)\n' }, 'sudo -k -S -p  install': { stdout: '' }, '/usr/local/bin/wp --version': { stdout: 'WP-CLI 9.9.9\n' }, ...responses });
  const urls: string[] = [];
  const download = async (url: string, file: string) => {
    urls.push(url);
    writeFileSync(file, PHAR);
  };
  return { tmpDir, fake, urls, download, ctx: { exec: fake.exec, tmpDir, download } };
}

describe('installing with your sudo password', () => {
  it('pins WP-CLI with its published SHA-256', () => {
    expect(WP_CLI_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(WP_CLI_RELEASE.url).toBe(`https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_RELEASE.version}/wp-cli-${WP_CLI_RELEASE.version}.phar`);
  });

  it('checks the password, installs the packages with apt and WP-CLI from its pin, the password only ever on stdin', async () => {
    const s = setup();
    const held: HeldPassword = { value: 's3cret' };
    const view = await run(planSystemInstall(s.ctx, ['wp-cli', 'unzip', 'git'], held, PIN));
    expect(view.status).toBe('done');
    const lines = s.fake.calls.map((c) => [c.file, ...c.args].join(' '));
    expect(lines[0]).toBe("sudo -k -S -p  true");
    expect(lines[1]).toBe('sudo -k -S -p  env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y -q -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -- unzip git');
    expect(lines[2]).toBe(`sudo -k -S -p  install -m 0755 -o root -g root ${join(s.tmpDir, 'wp-cli-9.9.9.phar')} /usr/local/bin/wp`);
    expect(lines[3]).toBe('/usr/local/bin/wp --version');
    expect(s.urls).toEqual([PIN.url]);
    // The password: on every sudo's stdin, never on a command line; let go of at the end.
    for (const c of s.fake.calls.filter((x) => x.file === 'sudo')) expect(c.input).toBe('s3cret\n');
    expect(lines.join(' ')).not.toContain('s3cret');
    expect(held.value).toBeUndefined();
    expect(readdirSync(s.tmpDir)).toEqual([]);
  });

  it('installs nothing when sudo does not take the password, and lets go of it', async () => {
    const s = setup({ 'sudo -k -S -p  true': { code: 1, stderr: 'Sorry, try again.\nsudo: 1 incorrect password attempt\n' } });
    const held: HeldPassword = { value: 'wrong' };
    const view = await run(planSystemInstall(s.ctx, ['git'], held, PIN));
    expect(view.status).toBe('failed');
    expect(view.steps[0]?.output).toContain('did not take that password');
    expect(s.fake.calls).toHaveLength(1);
    expect(held.value).toBeUndefined();
  });

  it('Retry takes the password again after a wrong one, and gives sudo only the new one', async () => {
    const s = setup({ 'sudo -k -S -p  true': (call) => (call.input === 'right\n' ? { stdout: '' } : { code: 1, stderr: 'Sorry, try again.\n' }) });
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const held: HeldPassword = { value: 'wrong' };
    const started = jobs.start(planSystemInstall(s.ctx, ['git'], held, PIN), { runId: store.start('system.install', {}), title: 'Install git', secret: { held, label: 'your sudo password' } });
    const settle = async () => {
      for (let i = 0; i < 300; i++) {
        const v = jobs.get(started.id) as JobView;
        if (v.status !== 'running') return v;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('job did not settle');
    };
    expect((await settle()).status).toBe('failed');
    expect(jobs.retryNeeds(started.id)).toBe('your sudo password');
    jobs.retry(started.id, 'right');
    expect((await settle()).status).toBe('done');
    expect(s.fake.calls.filter((c) => c.file === 'sudo').map((c) => c.input)).toEqual(['wrong\n', 'right\n', 'right\n']);
    expect(held.value).toBeUndefined();
  });

  it('reads the package lists once when apt cannot find a package, then installs', async () => {
    let installs = 0;
    const s = setup({
      'sudo -k -S -p  env': (call) => {
        if (call.args.includes('update')) return { stdout: 'Reading package lists...\n' };
        installs++;
        return installs === 1 ? { code: 100, stderr: 'E: Unable to locate package composer\n' } : { stdout: 'Setting up composer\n' };
      },
    });
    const view = await run(planSystemInstall(s.ctx, ['composer'], 'pw', PIN));
    expect(view.status).toBe('done');
    expect(s.fake.calls.map((c) => c.args.at(-1))).toEqual(['true', 'composer', 'update', 'composer']);
  });

  it('deletes a WP-CLI download whose checksum does not match, and puts nothing in place', async () => {
    const s = setup();
    const held: HeldPassword = { value: 'pw' };
    const view = await run(planSystemInstall(s.ctx, ['wp-cli'], held, { ...PIN, sha256: 'a'.repeat(64) }));
    expect(view.status).toBe('failed');
    expect(view.steps.find((x) => x.status === 'failed')?.output).toMatch(/checksum mismatch/);
    expect(s.fake.calls.map((c) => c.args.at(-1))).toEqual(['true']);
    expect(existsSync(join(s.tmpDir, 'wp-cli-9.9.9.phar.part'))).toBe(false);
    expect(held.value).toBeUndefined();
  });

  it("answers phpMyAdmin's questions from a private file first, then installs it", async () => {
    let answers = '';
    const s = setup({
      'sudo -k -S -p  debconf-set-selections': (call) => {
        const file = call.args.at(-1) as string;
        answers = readFileSync(file, 'utf8');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        return { stdout: '' };
      },
    });
    const view = await run(planSystemInstall(s.ctx, ['phpmyadmin'], 'pw', PIN));
    expect(view.status).toBe('done');
    expect(answers).toBe('phpmyadmin phpmyadmin/reconfigure-webserver multiselect apache2\nphpmyadmin phpmyadmin/dbconfig-install boolean false\n');
    const lines = s.fake.calls.map((c) => [c.file, ...c.args].join(' '));
    expect(lines[0]).toBe('sudo -k -S -p  true');
    expect(lines[1]).toMatch(/^sudo -k -S -p {2}debconf-set-selections \/.+\/phpmyadmin\.debconf$/);
    expect(lines[2]).toMatch(/ install -- phpmyadmin$/);
    expect(lines).toHaveLength(3);
    // The answers file is gone, and the password went to stdin only.
    expect(readdirSync(s.tmpDir)).toEqual([]);
    for (const c of s.fake.calls) expect(c.input).toBe('pw\n');
  });

  it('gives phpMyAdmin its pool under PHP-FPM, and only there', async () => {
    const s = setup({ 'sudo -n /dmp-root php-switch-fpm': { stdout: 'ok' }, 'sudo -k -S -p  debconf-set-selections': { stdout: '' } });
    const fpm = await run(planSystemInstall({ ...s.ctx, fpm: { version: '8.3', dmpRoot: '/dmp-root' } }, ['phpmyadmin', 'git'], 'pw', PIN));
    expect(fpm.status).toBe('done');
    expect(fpm.steps.map((x) => x.id)).toEqual(['password', 'apt', 'phpmyadmin-pool', 'done']);
    expect(s.fake.calls.at(-1)?.args).toEqual(['-n', '/dmp-root', 'php-switch-fpm', '8.3']);
    const git = await run(planSystemInstall({ ...s.ctx, fpm: { version: '8.3', dmpRoot: '/dmp-root' } }, ['git'], 'pw', PIN));
    expect(git.steps.map((x) => x.id)).toEqual(['password', 'apt', 'done']);
  });
});

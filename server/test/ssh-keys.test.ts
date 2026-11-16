import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../src/exec.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { githubIdentities, keyFacts, keyFiles, listSshKeys, planAddSshKey, planCopyWindowsKey, planMakeSshKey, tokenScopes } from '../src/ssh-keys.js';
import { keepGithubSshKey, NO_PROMPTS, remoteGit, useGithubHttps, useGithubSshKey } from '../src/sites/git.js';
import { RunStore } from '../src/store.js';
import { fakeExec } from './helpers.js';

afterEach(() => {
  useGithubSshKey(null);
  useGithubHttps(null);
});

async function run(steps: ReturnType<typeof planMakeSshKey>): Promise<JobView & { notes: string[] }> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const notes: string[] = [];
  const view = jobs.start(steps, { runId: store.start('github.makeSshKey', {}), title: 'keys' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    const note = v.steps.find((x) => x.status === 'running')?.note;
    if (note && !notes.includes(note)) notes.push(note);
    if (v.status !== 'running') return { ...v, notes };
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

/** A home with ~/.ssh and a Windows profile with its .ssh, as WSL sees them. */
function places() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-ssh-'));
  const home = join(root, 'home');
  const profile = join(root, 'Users', 'alex');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(profile, '.ssh'), { recursive: true });
  return { root, home, profile, tmpDir: join(root, 'tmp'), here: join(home, '.ssh'), windows: join(profile, '.ssh') };
}

/** ssh-keygen and ssh as they answer for these keys: names with "locked" have a passphrase, "id_ed25519" is on GitHub as alex-morgan. */
function keyTools() {
  return fakeExec({
    'ssh-keygen -l -f': (call) => {
      const name = basename(call.args[2] as string);
      return { stdout: `256 SHA256:${name}fp ${name}@laptop (ED25519)\n` };
    },
    'ssh-keygen -y -P': (call) => (basename(call.args[4] as string).includes('locked') ? { code: 1, stderr: 'incorrect passphrase supplied to decrypt private key' } : { stdout: `ssh-ed25519 AAAAC3${basename(call.args[4] as string)} derived\n` }),
    'ssh -T -i': (call) =>
      basename(call.args[2] as string) === 'id_ed25519' ? { code: 1, stderr: "Hi alex-morgan! You've successfully authenticated, but GitHub does not provide shell access.\n" } : { code: 255, stderr: 'git@github.com: Permission denied (publickey).\n' },
  });
}

describe('reading SSH keys', () => {
  it('reads what ssh-keygen -l says of a key', () => {
    expect(keyFacts('256 SHA256:abcDEF alex@laptop (devmagic-panel) (ED25519)\n')).toEqual({ bits: 256, fingerprint: 'SHA256:abcDEF', comment: 'alex@laptop (devmagic-panel)', type: 'ED25519' });
    expect(keyFacts('3072 SHA256:xyz no comment (RSA)')).toEqual({ bits: 3072, fingerprint: 'SHA256:xyz', type: 'RSA' });
    expect(keyFacts('config is not a public key file.')).toBeNull();
  });

  it('finds the key Windows names for github.com in its ssh config', () => {
    const config = ['Host gitlab.com', '  IdentityFile ~/.ssh/gitlab', '', 'Host github.com', '  HostName github.com', '  IdentityFile C:\\Users\\alex\\.ssh\\id_ed25519_github', 'Host work', '  IdentityFile ~/.ssh/work', 'Host *.com !gitlab.com', '  IdentityFile=~/.ssh/all', 'Match host github.com', '  IdentityFile ~/.ssh/matched'].join('\r\n');
    expect(githubIdentities(config)).toEqual(['id_ed25519_github', 'all']);
  });

  it('takes only key files from a .ssh folder', () => {
    const p = places();
    for (const name of ['id_ed25519', 'id_ed25519.pub', 'known_hosts', 'known_hosts.old', 'config', 'config.bak-2026-11-15', 'authorized_keys', 'old.removed-20261117-0100', '.hidden', 'work']) writeFileSync(join(p.here, name), 'x');
    writeFileSync(join(p.here, 'empty'), '');
    mkdirSync(join(p.here, 'folder'));
    expect(keyFiles(p.here)).toEqual(['id_ed25519', 'work']);
    expect(keyFiles(join(p.root, 'none'))).toEqual([]);
  });

  it('lists the keys here and in Windows, each tested alone, Windows ones on a 0600 copy that goes after', async () => {
    const p = places();
    writeFileSync(join(p.here, 'id_ed25519'), 'private');
    writeFileSync(join(p.here, 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3here alex@laptop\n');
    writeFileSync(join(p.windows, 'locked_github'), 'private');
    writeFileSync(join(p.windows, 'work'), 'private');
    writeFileSync(join(p.windows, 'config'), 'Host github.com\n  IdentityFile ~/.ssh/locked_github\n');
    const tools = keyTools();
    const keys = await listSshKeys(tools.exec, { home: p.home, tmpDir: p.tmpDir, windowsProfile: p.profile });
    expect(keys).toEqual([
      { name: 'id_ed25519', where: 'here', type: 'ED25519', bits: 256, fingerprint: 'SHA256:id_ed25519fp', comment: 'id_ed25519@laptop', passphrase: false, github: 'alex-morgan', publicKey: 'ssh-ed25519 AAAAC3here alex@laptop' },
      { name: 'locked_github', where: 'windows', type: 'ED25519', bits: 256, fingerprint: 'SHA256:locked_githubfp', comment: 'locked_github@laptop', passphrase: true, windowsForGithub: true },
      { name: 'work', where: 'windows', type: 'ED25519', bits: 256, fingerprint: 'SHA256:workfp', comment: 'work@laptop', passphrase: false, github: null },
    ]);
    // Windows' own files were never handed to ssh: only the copies, and those are gone.
    const tested = tools.calls.flatMap((c) => c.args).filter((a) => a.includes('locked_github') || a.endsWith('/work'));
    expect(tested.every((a) => a.startsWith(p.tmpDir))).toBe(true);
    expect(readdirSync(p.tmpDir)).toEqual([]);
    // A key with a passphrase is never tried against GitHub.
    expect(tools.calls.filter((c) => c.file === 'ssh').map((c) => basename(c.args[2] as string))).toEqual(['id_ed25519', 'work']);
  });

  it('says a Windows key is copied here already', async () => {
    const p = places();
    writeFileSync(join(p.windows, 'work'), 'private');
    writeFileSync(join(p.here, 'windows-work'), 'private');
    const keys = await listSshKeys(keyTools().exec, { home: p.home, tmpDir: p.tmpDir, windowsProfile: p.profile });
    expect(keys.find((k) => k.where === 'windows')).toMatchObject({ name: 'work', copiedAs: 'windows-work' });
  });
});

describe('making and copying keys', () => {
  it('makes an ed25519 key without a passphrase, never over a key, and uses it', async () => {
    const p = places();
    const made: Array<string | null> = [];
    const fake = fakeExec({
      'ssh-keygen -q': (call) => {
        const file = call.args[call.args.indexOf('-f') + 1] as string;
        writeFileSync(file, 'private', { mode: 0o600 });
        writeFileSync(`${file}.pub`, `ssh-ed25519 AAAAnew ${basename(file)}\n`);
        return { stdout: '' };
      },
    });
    let view = await run(planMakeSshKey({ exec: fake.exec, home: p.home, chosen: (n) => made.push(n) }));
    expect(view.status).toBe('done');
    expect(fake.calls[0]?.args.slice(0, 6)).toEqual(['-q', '-t', 'ed25519', '-N', '', '-C']);
    expect(view.steps[0]?.output).toContain('ssh-ed25519 AAAAnew id_ed25519');
    view = await run(planMakeSshKey({ exec: fake.exec, home: p.home, chosen: (n) => made.push(n) }));
    expect(made).toEqual(['id_ed25519', 'id_ed25519_devmagic']);
    expect(statSync(p.here).mode & 0o777).toBe(0o700);
  });

  it('copies a Windows key without a passphrase as windows-<name>, 0600, and uses it', async () => {
    const p = places();
    writeFileSync(join(p.windows, 'work'), 'private');
    const chosen: Array<string | null> = [];
    const view = await run(planCopyWindowsKey({ exec: keyTools().exec, home: p.home, windowsProfile: p.profile, chosen: (n) => chosen.push(n) }, 'work'));
    expect(view.status).toBe('done');
    expect(statSync(join(p.here, 'windows-work')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(p.here, 'windows-work.pub'), 'utf8')).toMatch(/^ssh-ed25519 AAAAC3windows-work.part derived\n$/);
    expect(chosen).toEqual(['windows-work']);
    expect(existsSync(join(p.windows, 'work'))).toBe(true);
  });

  it('copies nothing of a key with a passphrase, or of a name that is no key there', async () => {
    const p = places();
    writeFileSync(join(p.windows, 'locked'), 'private');
    const view = await run(planCopyWindowsKey({ exec: keyTools().exec, home: p.home, windowsProfile: p.profile, chosen: () => undefined }, 'locked'));
    expect(view.status).toBe('failed');
    expect(view.steps[0]?.output).toContain('has a passphrase');
    expect(readdirSync(p.here)).toEqual([]);
    const missing = await run(planCopyWindowsKey({ exec: keyTools().exec, home: p.home, windowsProfile: p.profile, chosen: () => undefined }, 'config'));
    expect(missing.steps[0]?.output).toContain('is not a key');
  });
});

describe('adding a key to GitHub', () => {
  it('reads the token scopes gh auth status shows', () => {
    expect(tokenScopes("  - Token: gho_****\n  - Token scopes: 'gist', 'read:org', 'repo'\n")).toEqual(['gist', 'read:org', 'repo']);
  });

  function gh(scopes: string) {
    const fake = fakeExec({
      'gh auth status': { stdout: `github.com\n  ✓ Logged in to github.com account alex-morgan\n  - Token scopes: ${scopes}\n` },
      'gh ssh-key add': { stdout: '' },
      'ssh -T -i': { code: 1, stderr: "Hi alex-morgan! You've successfully authenticated, but GitHub does not provide shell access.\n" },
    });
    const exec: Executor = async (file, args, options) => {
      if (file === 'gh' && args[1] === 'refresh') {
        await fake.exec(file, args, options);
        options?.onStderr?.('\n! One-time code (EF56-GH78) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
        await new Promise((r) => setTimeout(r, 20));
        return { code: 0, stdout: '', stderr: '' };
      }
      return fake.exec(file, args, options);
    };
    return { exec, calls: fake.calls };
  }

  it('asks GitHub for the right to add keys first, showing the code, then adds it and checks', async () => {
    const p = places();
    writeFileSync(join(p.here, 'id_ed25519.pub'), 'ssh-ed25519 AAAA\n');
    const g = gh("'gist', 'read:org', 'repo'");
    const view = await run(planAddSshKey({ exec: g.exec, home: p.home }, 'id_ed25519'));
    expect(view.status).toBe('done');
    expect(view.notes).toContain('Open https://github.com/login/device and enter EF56-GH78');
    expect(g.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['auth status', 'auth refresh', 'ssh-key add', '-T -i']);
    expect(g.calls[1]?.args).toEqual(['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'admin:public_key']);
    expect(g.calls[2]?.args.slice(0, 3)).toEqual(['ssh-key', 'add', join(p.here, 'id_ed25519.pub')]);
    expect(view.steps.at(-1)?.output).toBe('GitHub knows id_ed25519 as alex-morgan');
  });

  it('adds it straight away when gh may add keys already', async () => {
    const p = places();
    writeFileSync(join(p.here, 'id_ed25519.pub'), 'ssh-ed25519 AAAA\n');
    const g = gh("'admin:public_key', 'repo'");
    await run(planAddSshKey({ exec: g.exec, home: p.home }, 'id_ed25519'));
    expect(g.calls.map((c) => c.args[1])).toEqual(['status', 'add', '-i']);
  });
});

describe('the key GitHub repos clone with', () => {
  it('has git try the chosen key first over SSH, and nothing over HTTPS', () => {
    useGithubSshKey('/home/alex/.ssh/id_ed25519');
    expect(remoteGit()).toEqual({ ...NO_PROMPTS, GIT_SSH_COMMAND: `${NO_PROMPTS.GIT_SSH_COMMAND} -i '/home/alex/.ssh/id_ed25519'` });
    useGithubHttps('gh');
    expect(remoteGit().GIT_SSH_COMMAND).toBe(NO_PROMPTS.GIT_SSH_COMMAND);
  });

  it("has a site's GitHub repo keep the key in its .git/config", async () => {
    const fake = fakeExec({ git: { stdout: '' } });
    expect(await keepGithubSshKey(fake.exec, '/var/www/shop', 'git@github.com:acme/shop.git')).toBe('');
    useGithubSshKey('/home/alex/.ssh/id_ed25519');
    expect(await keepGithubSshKey(fake.exec, '/var/www/shop', 'git@github.com:acme/shop.git')).toContain('/home/alex/.ssh/id_ed25519');
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual(["-C /var/www/shop config core.sshCommand ssh -i '/home/alex/.ssh/id_ed25519'"]);
    expect(await keepGithubSshKey(fake.exec, '/var/www/blog', 'git@gitlab.com:acme/blog.git')).toBe('');
  });
});

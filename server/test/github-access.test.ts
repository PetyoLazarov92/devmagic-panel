import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../src/exec.js';
import { deviceCode, planGithubSignIn } from '../src/github-access.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { useGhBinary } from '../src/repo-hosts/github.js';
import { gitlabHttpsHosts, gitReason, githubHttpsOn, githubHttpsUrl, keepGithubHttps, NO_PROMPTS, remoteGit, sshHost, useGithubHttps, useGitlabHttps, withHttpsFallback } from '../src/sites/git.js';
import { RunStore } from '../src/store.js';
import { fakeExec } from './helpers.js';

const SAID = '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';

afterEach(() => {
  useGithubHttps(null);
  useGhBinary(null);
  useGitlabHttps([], 'glab', () => undefined);
});

async function run(steps: ReturnType<typeof planGithubSignIn>): Promise<JobView & { notes: string[] }> {
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const notes: string[] = [];
  const view = jobs.start(steps, { runId: store.start('github.signIn', {}), title: 'Sign in to GitHub' });
  for (let i = 0; i < 300; i++) {
    const v = jobs.get(view.id) as JobView;
    const note = v.steps.find((x) => x.status === 'running')?.note;
    if (note && !notes.includes(note)) notes.push(note);
    if (v.status !== 'running') return { ...v, notes };
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

/** gh not signed in, then signed in once auth login ran (which prints its code as gh does); ssh as given. */
function github(ssh: 'works' | 'refused', login: { code: number; stderr?: string } = { code: 0 }) {
  let signedIn = false;
  const fake = fakeExec({
    'gh api user': () => (signedIn ? { stdout: 'alex-morgan\n' } : { code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }),
    'ssh -T': ssh === 'works' ? { code: 1, stderr: "Hi alex-morgan! You've successfully authenticated, but GitHub does not provide shell access.\n" } : { code: 255, stderr: 'git@github.com: Permission denied (publickey).\n' },
  });
  const exec: Executor = async (file, args, options) => {
    if (file === 'gh' && args[0] === 'auth') {
      await fake.exec(file, args, options);
      options?.onStderr?.(SAID);
      await new Promise((r) => setTimeout(r, 20));
      if (login.code === 0) signedIn = true;
      return { code: login.code, stdout: '', stderr: login.stderr ?? (login.code === 0 ? '' : `${SAID}error: authentication timed out\n`) };
    }
    return fake.exec(file, args, options);
  };
  return { exec, calls: fake.calls };
}

describe("GitHub's device sign-in", () => {
  it('reads the one-time code gh prints', () => {
    expect(deviceCode(SAID)).toBe('AB12-CD34');
    expect(deviceCode('\n! One-time code (EF56-GH78) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n')).toBe('EF56-GH78');
    expect(deviceCode('nothing yet')).toBeNull();
  });

  it('shows the code and the page while gh waits, then clones over HTTPS when SSH cannot reach GitHub', async () => {
    const g = github('refused');
    let https = false;
    const view = await run(planGithubSignIn({ exec: g.exec, cloneOverHttps: () => (https = true) }));
    expect(view.status).toBe('done');
    expect(view.notes).toContain('Open https://github.com/login/device and enter AB12-CD34');
    const login = g.calls.find((c) => c.args[0] === 'auth');
    expect(login?.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--web']);
    expect(login?.env).toMatchObject({ BROWSER: 'true', GH_PROMPT_DISABLED: '1' });
    expect(https).toBe(true);
    expect(view.steps.at(-1)?.output).toContain('clone over HTTPS now');
    // The code is shown once, in the running step, and kept in no output.
    expect(JSON.stringify(view.steps.map((x) => x.output))).not.toContain('AB12-CD34');
  });

  it('keeps SSH when your key works, and skips the sign-in when gh is signed in already', async () => {
    const g = github('works');
    let https = false;
    expect((await run(planGithubSignIn({ exec: g.exec, cloneOverHttps: () => (https = true) }))).steps.at(-1)?.output).toContain('keep cloning over SSH');
    expect(https).toBe(false);
    const again = await run(planGithubSignIn({ exec: g.exec, cloneOverHttps: () => (https = true) }));
    expect(again.steps[0]?.output).toBe('gh is signed in already, as alex-morgan');
  });

  it('fails without the code in its output when the sign-in is not approved in time', async () => {
    const view = await run(planGithubSignIn({ exec: github('refused', { code: 1 }).exec, cloneOverHttps: () => undefined }));
    expect(view.status).toBe('failed');
    const out = view.steps.find((x) => x.status === 'failed')?.output ?? '';
    expect(out).toContain('authentication timed out');
    expect(out).not.toContain('AB12-CD34');
  });
});

describe('GitHub over HTTPS through gh', () => {
  it('gives git no extra settings until it is on', () => {
    expect(githubHttpsOn()).toBe(false);
    expect(remoteGit()).toEqual(NO_PROMPTS);
  });

  it("turns GitHub's SSH addresses into HTTPS and has gh give the sign-in, in git's environment only", () => {
    useGithubHttps('/home/alex/.local/share/devmagic-panel/tools/gh/2.104.0/gh');
    expect(remoteGit()).toEqual({
      ...NO_PROMPTS,
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: "!'/home/alex/.local/share/devmagic-panel/tools/gh/2.104.0/gh' auth git-credential",
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_2: 'git@github.com:',
      GIT_CONFIG_KEY_3: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_3: 'ssh://git@github.com/',
    });
  });

  it('knows GitHub SSH addresses and nothing else', () => {
    expect(githubHttpsUrl('git@github.com:acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(githubHttpsUrl('ssh://git@github.com/acme/shop')).toBe('https://github.com/acme/shop.git');
    expect(githubHttpsUrl('git@gitlab.com:acme/shop.git')).toBeNull();
    expect(githubHttpsUrl('https://github.com/acme/shop.git')).toBeNull();
  });

  it("has a site's repo keep it in its own .git/config, and leaves it alone when it is off", async () => {
    const fake = fakeExec({ git: { stdout: '' } });
    expect(await keepGithubHttps(fake.exec, '/var/www/shop', 'git@github.com:acme/shop.git')).toBe('');
    expect(fake.calls).toHaveLength(0);
    useGithubHttps('gh');
    expect(await keepGithubHttps(fake.exec, '/var/www/shop', 'git@github.com:acme/shop.git')).toContain('origin is https://github.com/acme/shop.git');
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual([
      '-C /var/www/shop remote set-url origin https://github.com/acme/shop.git',
      '-C /var/www/shop config --replace-all credential.https://github.com.helper ',
      "-C /var/www/shop config --add credential.https://github.com.helper !'gh' auth git-credential",
    ]);
    expect(await keepGithubHttps(fake.exec, '/var/www/blog', 'git@gitlab.com:acme/blog.git')).toBe('');
  });
});

describe('GitLab over HTTPS through glab, when SSH is refused', () => {
  const REFUSED = { code: 128, stdout: '', stderr: 'git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n' };

  it('tries once more over HTTPS through glab when glab is signed in there, and remembers the host', async () => {
    const kept: string[][] = [];
    useGitlabHttps([], 'glab', (hosts) => kept.push(hosts));
    const { useGlabSignedIn } = await import('../src/sites/git.js');
    useGlabSignedIn(async (host) => (host === 'gitlab.com' ? '/home/alex/.local/bin/glab' : null));
    const envs: Array<Record<string, string>> = [];
    let tries = 0;
    const r = await withHttpsFallback(fakeExec().exec, 'git@gitlab.com:acme/shop.git', async () => {
      envs.push(remoteGit());
      return ++tries === 1 ? REFUSED : { code: 0, stdout: 'ok', stderr: '' };
    });
    expect(r.code).toBe(0);
    expect(tries).toBe(2);
    expect(envs[0]?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(envs[1]).toMatchObject({ GIT_CONFIG_KEY_1: 'credential.https://gitlab.com.helper', GIT_CONFIG_VALUE_1: "!'/home/alex/.local/bin/glab' auth git-credential", GIT_CONFIG_VALUE_2: 'git@gitlab.com:' });
    expect(gitlabHttpsHosts()).toEqual(['gitlab.com']);
    expect(kept).toEqual([['gitlab.com']]);
  });

  it('leaves GitHub, other errors and hosts without glab alone', async () => {
    const { useGlabSignedIn } = await import('../src/sites/git.js');
    useGlabSignedIn(async () => null);
    let tries = 0;
    await withHttpsFallback(fakeExec().exec, 'git@git.wandworks.test:acme/shop.git', async () => (tries++, REFUSED));
    useGlabSignedIn(async () => 'glab');
    await withHttpsFallback(fakeExec().exec, 'git@github.com:acme/shop.git', async () => (tries++, REFUSED));
    await withHttpsFallback(fakeExec().exec, 'git@gitlab.com:acme/shop.git', async () => (tries++, { code: 128, stdout: '', stderr: 'fatal: repository not found' }));
    expect(tries).toBe(3);
    expect(gitlabHttpsHosts()).toEqual([]);
  });

  it("gives a GitLab site's repo the HTTPS address and glab", async () => {
    useGitlabHttps(['gitlab.com'], '/opt/glab');
    const fake = fakeExec({ git: { stdout: '' } });
    expect(await keepGithubHttps(fake.exec, '/var/www/shop', 'git@gitlab.com:acme/web/shop.git')).toBe('note: origin is https://gitlab.com/acme/web/shop.git, with the GitLab CLI giving git the sign-in');
    expect(fake.calls[2]?.args).toEqual(['-C', '/var/www/shop', 'config', '--add', 'credential.https://gitlab.com.helper', "!'/opt/glab' auth git-credential"]);
  });

  it("reads the host of an SSH address and git's real reason", () => {
    expect(sshHost('git@GitLab.com:acme/shop.git')).toBe('gitlab.com');
    expect(sshHost('ssh://git@git.wandworks.test:2222/acme/shop')).toBe('git.wandworks.test');
    expect(sshHost('https://gitlab.com/acme/shop.git')).toBeNull();
    expect(gitReason(REFUSED.stderr, 'x')).toMatch(/^git@gitlab.com: Permission denied \(publickey\)\.: no SSH key here/);
    expect(gitReason('remote: Repository not found.\nfatal: repository not found', 'x')).toBe('remote: Repository not found.');
    expect(gitReason('', 'cannot read it')).toBe('cannot read it');
  });
});

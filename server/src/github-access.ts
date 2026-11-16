import type { ExecResult, Executor } from './exec.js';
import type { JobRuntime, JobStep } from './jobs.js';
import { GH_ENV, ghBinary, ghStatus } from './repo-hosts/github.js';

/**
 * Signing the GitHub CLI in from the panel, with GitHub's device sign-in: gh
 * prints a one-time code and github.com/login/device, the job shows both, you
 * approve in your browser, and gh keeps its own sign-in. The panel never sees
 * the token. Then, when git over SSH cannot reach GitHub, GitHub repos clone
 * over HTTPS through gh (sites/git.ts).
 */
export const DEVICE_PAGE = 'https://github.com/login/device';

/** A device code lasts 15 minutes; the sign-in waits that long for you. */
const SIGN_IN_MS = 15 * 60_000;

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/**
 * The one-time code in what gh prints: "! First copy your one-time code: ABCD-1234"
 * (gh 2.45), "! One-time code (ABCD-1234) copied to clipboard" (gh 2.104).
 */
export function deviceCode(text: string): string | null {
  return /one-time code(?::\s*|\s*\()([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(text)?.[1] ?? null;
}

/** What gh said, without the code (it is shown once, in the job, and kept nowhere). */
const withoutCode = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim() && !/one-time code|Open this URL|Press Enter/i.test(l))
    .join('\n')
    .trim();

/** True when git over SSH signs in to GitHub with this machine's keys. */
export async function sshReachesGithub(exec: Executor): Promise<boolean> {
  const r = await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', 'git@github.com'], { timeoutMs: 10_000 });
  return /successfully authenticated/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * A gh command that goes through GitHub's device sign-in (auth login, auth
 * refresh): the job shows the one-time code and the page while gh waits for
 * your approval, up to 15 minutes. The code lands in no output.
 */
export async function deviceFlow(exec: Executor, job: JobRuntime, args: string[], done: string): Promise<ExecResult> {
  let said = '';
  let shown = false;
  // BROWSER=true: gh opens nothing itself; the job shows the page and the code.
  const r = await exec(ghBinary(), args, {
    timeoutMs: SIGN_IN_MS,
    env: { ...GH_ENV, BROWSER: 'true' },
    onStderr: (chunk) => {
      said += chunk;
      const code = deviceCode(said);
      if (code && !shown) {
        shown = true;
        job.progress(0.5, `Open ${DEVICE_PAGE} and enter ${code}`);
      }
    },
  });
  if (r.code !== 0) return failed(withoutCode(r.stderr) || (shown ? 'it was not approved within 15 minutes: start it again' : 'gh did not start the sign-in'));
  return ok(done);
}

export function planGithubSignIn(ctx: { exec: Executor; cloneOverHttps: () => void }): JobStep[] {
  let user: string | undefined;
  return [
    {
      id: 'sign-in',
      label: 'Sign in to GitHub in your browser',
      run: async (job) => {
        const before = await ghStatus(ctx.exec);
        if (!before.installed) return failed('the GitHub CLI (gh) is not installed: install it first');
        if (before.signedIn) {
          user = before.user;
          return ok(`gh is signed in already, as ${before.user}`);
        }
        return deviceFlow(ctx.exec, job, ['auth', 'login', '--hostname', 'github.com', '--web'], 'gh is signed in');
      },
    },
    {
      id: 'clone',
      label: 'Check the sign-in and how GitHub repos clone',
      run: async () => {
        const now = await ghStatus(ctx.exec);
        if (!now.signedIn) return failed(`gh is not signed in: ${now.problem ?? 'no answer'}`);
        user = now.user;
        if (await sshReachesGithub(ctx.exec)) return ok(`signed in as ${user}; GitHub repos keep cloning over SSH, which works with your key`);
        ctx.cloneOverHttps();
        return ok(`signed in as ${user}; GitHub repos clone over HTTPS now, with gh giving git the sign-in (no SSH key needed)`);
      },
    },
  ];
}

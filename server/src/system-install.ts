import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_INSTALLS, type SystemInstall, WP_CLI_RELEASE } from '@devmagic-panel/shared';
import { type ExecResult, type Executor, runRoot } from './exec.js';
import type { JobStep } from './jobs.js';
import { download as defaultDownload, type Downloader, sha256File } from './mailpit.js';
import { progressNote } from './sites/db.js';
import type { HeldPassword } from './update-install.js';

/**
 * What Machine checks installs with your sudo password, typed in the panel:
 * apt packages from a fixed list (from the sources apt already has, never a
 * new one), and WP-CLI, a file from its pinned release. The password goes to
 * sudo's stdin only, with -k so sudo neither uses nor keeps a cached sign-in;
 * the job holds it until its last sudo, and lets go at once when a step
 * fails. dmp-root and its passwordless rule are not involved.
 */
export const APT_PACKAGES: Record<Exclude<SystemInstall, 'wp-cli'>, string> = {
  nginx: 'nginx',
  composer: 'composer',
  unzip: 'unzip',
  git: 'git',
  phpmyadmin: 'phpmyadmin',
};

/**
 * phpMyAdmin's own questions, answered before apt asks them: Apache (its
 * /phpmyadmin alias, which the panel's PHP-FPM setup reads), and no control
 * database of its own (dpkg-reconfigure phpmyadmin adds one later).
 */
export const PHPMYADMIN_ANSWERS = ['phpmyadmin phpmyadmin/reconfigure-webserver multiselect apache2', 'phpmyadmin phpmyadmin/dbconfig-install boolean false'];

export const SYSTEM_INSTALL_LABELS: Record<SystemInstall, string> = {
  nginx: 'nginx',
  composer: 'Composer',
  unzip: 'unzip',
  git: 'git',
  'wp-cli': 'WP-CLI',
  phpmyadmin: 'phpMyAdmin',
};

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** sudo with the password on stdin: -k (no cached sign-in used or kept), -S (stdin), -p '' (no prompt text). */
const sudo = (exec: Executor, password: string, args: string[], timeoutMs: number, onStdout?: (chunk: string) => void) =>
  exec('sudo', ['-k', '-S', '-p', '', ...args], { input: `${password}\n`, timeoutMs, ...(onStdout ? { onStdout } : {}) });

const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=a', 'apt-get', '-y', '-q', '-o', 'DPkg::Lock::Timeout=300', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

/** The job lets go of the password when a step fails, so a retry asks for it again. */
function holding(held: HeldPassword, step: JobStep): JobStep {
  return {
    ...step,
    run: async (job) => {
      try {
        const out = await step.run(job);
        if ((Array.isArray(out) ? out : [out]).some((r) => r.code !== 0)) held.value = undefined;
        return out;
      } catch (error) {
        held.value = undefined;
        throw error;
      }
    },
  };
}

export function planSystemInstall(
  ctx: {
    exec: Executor;
    tmpDir: string;
    download?: Downloader;
    /** Under PHP-FPM (mod_php off): the version sites run and dmp-root, to give phpMyAdmin its pool after it is installed. */
    fpm?: { version: string; dmpRoot: string };
  },
  items: readonly SystemInstall[],
  password: string | HeldPassword,
  wpCli: { version: string; url: string; sha256: string } = WP_CLI_RELEASE,
): JobStep[] {
  const held: HeldPassword = typeof password === 'string' ? { value: password } : password;
  const wanted = SYSTEM_INSTALLS.filter((i) => items.includes(i));
  const packages = wanted.filter((i): i is Exclude<SystemInstall, 'wp-cli'> => i !== 'wp-cli').map((i) => APT_PACKAGES[i]);
  const gone = () => failed('the password was let go of when a step failed: Retry asks for it again');
  const steps: JobStep[] = [
    {
      id: 'password',
      label: 'Check your sudo password',
      run: async () => {
        if (held.value === undefined) return gone();
        const r = await sudo(ctx.exec, held.value, ['true'], 30_000);
        if (r.code !== 0) return failed(/incorrect password|Sorry, try again|authentication failure/i.test(r.stderr) ? 'sudo did not take that password: nothing was installed' : `sudo refused: ${r.stderr.trim() || 'no answer'}`);
        return ok('sudo takes it');
      },
    },
  ];
  if (packages.length) {
    steps.push({
      id: 'apt',
      label: `Install ${packages.join(', ')} with apt`,
      weight: 4,
      run: async (job) => {
        if (held.value === undefined) return gone();
        if (packages.includes('phpmyadmin')) {
          // The answers from a file only you can read, given to debconf as root; the password stays on stdin alone.
          mkdirSync(ctx.tmpDir, { recursive: true, mode: 0o700 });
          const answers = join(ctx.tmpDir, 'phpmyadmin.debconf');
          writeFileSync(answers, `${PHPMYADMIN_ANSWERS.join('\n')}\n`, { mode: 0o600 });
          try {
            const set = await sudo(ctx.exec, held.value, ['debconf-set-selections', answers], 60_000);
            if (set.code !== 0) return { ...set, stderr: `could not answer phpMyAdmin's questions: ${set.stderr.trim()}` };
          } finally {
            rmSync(answers, { force: true });
          }
        }
        let lines = 0;
        const follow = (chunk: string) => {
          lines += chunk.split('\n').length - 1;
          const last = chunk.trim().split('\n').at(-1);
          if (last) job.progress(Math.min(0.95, lines / 120), last.slice(0, 120));
        };
        let r = await sudo(ctx.exec, held.value, [...APT, 'install', '--', ...packages], 30 * 60_000, follow);
        if (r.code !== 0 && /Unable to locate package|has no installation candidate/i.test(`${r.stdout}${r.stderr}`)) {
          // A fresh system whose package lists were never read: read them once, then again.
          const update = await sudo(ctx.exec, held.value, [...APT, 'update'], 10 * 60_000, follow);
          if (update.code !== 0) return update;
          r = await sudo(ctx.exec, held.value, [...APT, 'install', '--', ...packages], 30 * 60_000, follow);
        }
        if (r.code !== 0) return { ...r, stderr: r.stderr.trim() || 'apt-get could not install them' };
        return ok(`installed ${packages.join(', ')}`);
      },
    });
  }
  if (wanted.includes('wp-cli')) {
    const part = join(ctx.tmpDir, `wp-cli-${wpCli.version}.phar.part`);
    const phar = join(ctx.tmpDir, `wp-cli-${wpCli.version}.phar`);
    steps.push({
      id: 'wp-cli',
      label: `Install WP-CLI ${wpCli.version} as /usr/local/bin/wp`,
      weight: 2,
      run: async (job) => {
        if (held.value === undefined) return gone();
        mkdirSync(ctx.tmpDir, { recursive: true, mode: 0o700 });
        const started = Date.now();
        await (ctx.download ?? defaultDownload)(wpCli.url, part, (done, total) => total && job.progress(done / total, progressNote(done, total, started)));
        const actual = sha256File(part);
        if (actual !== wpCli.sha256) {
          rmSync(part, { force: true });
          return failed(`checksum mismatch: expected ${wpCli.sha256}, got ${actual}; the download was deleted`);
        }
        renameSync(part, phar);
        try {
          const r = await sudo(ctx.exec, held.value, ['install', '-m', '0755', '-o', 'root', '-g', 'root', phar, '/usr/local/bin/wp'], 60_000);
          if (r.code !== 0) return r;
        } finally {
          rmSync(phar, { force: true });
        }
        const version = await ctx.exec('/usr/local/bin/wp', ['--version'], { timeoutMs: 30_000 });
        return version.code === 0 ? ok(`/usr/local/bin/wp: ${version.stdout.trim()}`) : failed(`/usr/local/bin/wp does not run: ${(version.stderr || version.stdout).trim()}`);
      },
    });
  }
  if (wanted.includes('phpmyadmin') && ctx.fpm) {
    const fpm = ctx.fpm;
    steps.push({
      id: 'phpmyadmin-pool',
      label: `Give phpMyAdmin its PHP-FPM pool (PHP ${fpm.version}) and check every site answers`,
      run: () => runRoot(ctx.exec, fpm.dmpRoot, ['php-switch-fpm', fpm.version], 180_000),
    });
  }
  steps.push({
    id: 'done',
    label: 'Let go of your password',
    run: async () => {
      held.value = undefined;
      return ok('the job holds your password no more');
    },
  });
  return steps.map((step) => holding(held, step));
}

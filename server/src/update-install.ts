import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstalledRelease, InstallStatus } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import type { RunStore } from './store.js';

/**
 * panel.installRelease: a release's install.sh --from-panel, in a transient
 * user unit of its own so the panel's restart in the middle of it does not
 * stop it. The sudo password goes to install.sh's stdin through a FIFO that
 * systemd opens for it (no shell, nothing on disk: a FIFO holds no data), and
 * install.sh keeps it in memory only. install.sh writes update-status.json; the
 * panel that runs afterwards (the new one, or this one when nothing restarted)
 * reads it and finishes the run in run history.
 */

export interface InstallContext {
  exec: Executor;
  /** The panel's data folder: releases/, current, update-status.json. */
  dataDir: string;
  store: RunStore;
  /** Where the FIFO's folder goes: $XDG_RUNTIME_DIR (tmpfs, only yours), else the temp folder. */
  runtimeDir?: string;
  /** Writes the password into the FIFO once install.sh opened it; tests swap in a fake. */
  handOver?: (fifo: string, text: string) => Promise<void>;
  /** How often and how long the job looks at the status file; tests make it quick. */
  poll?: { delayMs?: number; maxMs?: number };
  now?: () => Date;
}

/** What a running install leaves for the next panel: its run and its unit. */
interface PendingInstall {
  runId: number;
  unit: string;
  release: string;
}

export const statusFile = (dataDir: string) => join(dataDir, 'update-status.json');
const pendingFile = (dataDir: string) => join(dataDir, 'update-run.json');
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr: `${stderr}\n` });

/**
 * The last install from the Updates page, while it is still news: an update
 * or switch from the panel since writes no update-status.json, so without this
 * the page would go on saying "Installed v1.1.2" over the v1.1.3 that came
 * after it. A finished install shows while the release it put in runs and was
 * installed no later than it ended; one under way always shows.
 */
export function installStillNews<T extends Pick<InstallStatus, 'release' | 'state' | 'finished'>>(last: T | undefined, releases: Pick<InstalledRelease, 'name' | 'current' | 'installedAt'>[]): T | undefined {
  if (!last || last.state === 'running') return last;
  const running = releases.find((r) => r.current);
  if (!running) return last;
  if (last.state === 'done' && running.name !== last.release) return undefined;
  const ended = Date.parse(last.finished);
  // The release folder is written a little before install.sh ends; a minute covers that.
  if (Number.isFinite(ended) && Date.parse(running.installedAt) > ended + 60_000) return undefined;
  return last;
}

/** install.sh's update-status.json, when it is there and reads as one. */
export function readInstallStatus(dataDir: string): InstallStatus | undefined {
  try {
    const raw = JSON.parse(readFileSync(statusFile(dataDir), 'utf8')) as Partial<InstallStatus>;
    if (typeof raw.release !== 'string' || !['running', 'done', 'failed'].includes(raw.state ?? '')) return undefined;
    return {
      release: raw.release,
      previous: raw.previous ?? '',
      state: raw.state as InstallStatus['state'],
      step: raw.step ?? '',
      message: raw.message ?? '',
      rolledBack: raw.rolledBack === true,
      started: raw.started ?? '',
      finished: raw.finished ?? '',
      log: raw.log ?? '',
    };
  } catch {
    return undefined;
  }
}

function readPending(dataDir: string): PendingInstall | undefined {
  try {
    const raw = JSON.parse(readFileSync(pendingFile(dataDir), 'utf8')) as Partial<PendingInstall>;
    return typeof raw.runId === 'number' && typeof raw.unit === 'string' && typeof raw.release === 'string' ? (raw as PendingInstall) : undefined;
  } catch {
    return undefined;
  }
}

const unitActive = async (exec: Executor, unit: string) => (await exec('systemctl', ['--user', 'is-active', '--quiet', unit])).code === 0;

/** An install that is still running: its unit is active. */
export async function installRunning(ctx: Pick<InstallContext, 'exec' | 'dataDir'>): Promise<boolean> {
  const pending = readPending(ctx.dataDir);
  return pending ? unitActive(ctx.exec, pending.unit) : false;
}

/** What the run history keeps of an install that ended. */
function outcome(status: InstallStatus): { code: number; output: string } {
  if (status.state === 'done') return { code: 0, output: `${status.release} installed${status.previous ? `, replacing ${status.previous}` : ''}; log: ${status.log}` };
  const back = status.rolledBack ? ` Everything was put back: ${status.previous || 'the release before'} runs as before.` : '';
  return { code: 1, output: `${status.message}.${back} Log: ${status.log}` };
}

/**
 * The status of an install for the Updates page, and its run finished in run
 * history once it ended, unless a job of this panel still follows it (`followed`). An install whose unit is gone while its status still
 * says running was interrupted (a reboot, say): it is safe to run again.
 */
export async function settleInstall(ctx: Pick<InstallContext, 'exec' | 'dataDir' | 'store'>, followed: (runId: number) => boolean = () => false): Promise<(InstallStatus & { interrupted?: true }) | undefined> {
  const status = readInstallStatus(ctx.dataDir);
  const pending = readPending(ctx.dataDir);
  if (!status) return undefined;
  // A job of this panel still follows it: that job finishes the run.
  if (pending && followed(pending.runId)) return status;
  const active = status.state === 'running' && pending ? await unitActive(ctx.exec, pending.unit) : false;
  const interrupted = status.state === 'running' && !active;
  if (pending && !active && (status.state !== 'running' || interrupted)) {
    const { code, output } = interrupted ? { code: 1, output: `The install of ${status.release} was interrupted at ${status.step}; run it again, every step is safe to repeat. Log: ${status.log}` } : outcome(status);
    ctx.store.finish(pending.runId, code, output);
    rmSync(pendingFile(ctx.dataDir), { force: true });
  }
  return interrupted ? { ...status, interrupted: true } : status;
}

/** Writes into a FIFO once its reader opened it, trying for up to ten seconds. */
export async function handOverFifo(fifo: string, text: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    let fd: number;
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return;
  }
  throw new Error('the installer did not start reading its input');
}

const lastLogLine = (file: string) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
  } catch {
    return '';
  }
};

/**
 * The job: start install.sh in its unit and give it the password, then follow
 * its status until it ends. When the update succeeds the panel restarts in the
 * middle of the second step; the panel that comes up finishes the run.
 */
export function planInstallRelease(ctx: InstallContext, release: { name: string; dir: string }, password: string, runId: number): JobStep[] {
  const now = ctx.now ?? (() => new Date());
  const unit = `devmagic-panel-install-${now().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const { delayMs = 1000, maxMs = 90 * 60_000 } = ctx.poll ?? {};
  // Held only until it is handed over: jobs stay in memory, and a retry must not reuse it.
  let secret: string | undefined = password;
  return [
    {
      id: 'start',
      label: `Start ${release.name}'s installer in the background with your sudo password`,
      run: async () => {
        if (secret === undefined) return failed('the password was used once and is gone: start the install again from the Updates page');
        rmSync(statusFile(ctx.dataDir), { force: true });
        const dir = mkdtempSync(join(ctx.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'devmagic-panel-update-'));
        const fifo = join(dir, 'password');
        try {
          const made = await ctx.exec('mkfifo', ['-m', '600', fifo]);
          if (made.code !== 0) return made;
          writeFileSync(pendingFile(ctx.dataDir), `${JSON.stringify({ runId, unit, release: release.name } satisfies PendingInstall)}\n`, { mode: 0o600 });
          const started = await ctx.exec('systemd-run', [
            '--user', '--quiet', '--collect', `--unit=${unit}`,
            `--property=StandardInput=file:${fifo}`,
            '--property=StandardOutput=null', '--property=StandardError=null',
            '--', join(release.dir, 'install.sh'), '--from-panel',
          ]);
          if (started.code !== 0) {
            rmSync(pendingFile(ctx.dataDir), { force: true });
            return started;
          }
          const text = `${secret}\n`;
          secret = undefined;
          try {
            await (ctx.handOver ?? handOverFifo)(fifo, text);
          } catch (error) {
            await ctx.exec('systemctl', ['--user', 'stop', unit]);
            rmSync(pendingFile(ctx.dataDir), { force: true });
            return failed(`could not give the installer your password: ${(error as Error).message}`);
          }
          return ok(`install.sh --from-panel runs as ${unit}`);
        } finally {
          secret = undefined;
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'install',
      label: `Install ${release.name}: root scripts, system steps, then the restart`,
      weight: 10,
      run: async (job) => {
        const started = Date.now();
        for (;;) {
          const status = readInstallStatus(ctx.dataDir);
          if (status && status.state !== 'running') {
            // This job finishes the run itself; the next panel has nothing left to do.
            rmSync(pendingFile(ctx.dataDir), { force: true });
            const { code, output } = outcome(status);
            return code === 0 ? ok(output) : failed(output);
          }
          if (status) job.progress(0.5, `${status.step}: ${lastLogLine(status.log)}`);
          if (!(await unitActive(ctx.exec, unit))) {
            // It may have written its last status just before it ended.
            const last = readInstallStatus(ctx.dataDir);
            if (last && last.state !== 'running') continue;
            rmSync(pendingFile(ctx.dataDir), { force: true });
            return failed(`the installer stopped without finishing${last ? ` (at ${last.step})` : ''}; its log: ${last?.log || 'not written'}`);
          }
          if (Date.now() - started > maxMs) return failed(`the installer still runs after ${Math.round(maxMs / 60_000)} minutes; it goes on as ${unit}, and the Updates page shows how it ended`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      },
    },
  ];
}


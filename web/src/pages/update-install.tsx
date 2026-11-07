import type { JobView, UpdateStatus } from '@devmagic-panel/shared';
import { CircleAlert, CircleCheck, KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { settled, StepList } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { SecretInput } from '@/components/ui/secret-input';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { waitForRestart } from '@/lib/restart';
import { expectRestart } from '@/lib/session-watch';
import { lastLine } from '@/lib/site-actions';

/**
 * The sudo password for one install from the Updates page: sent once with
 * panel.installRelease, which hands it to install.sh's stdin. Never saved by
 * the panel, never offered to the browser to remember, cleared once sent.
 */
export function InstallForm({ release, verb, onStarted, onCancel }: { release: string; verb: string; onStarted: (jobId: string) => void; onCancel?: () => void }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `install-secret-${release}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const jobId = await api.startJob('panel.installRelease', { release, password: secret });
      setSecret('');
      onStarted(jobId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={(e) => void submit(e)} autoComplete="off">
      <div className="grid gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">Your sudo password</label>
        <div className="sm:max-w-xs">
          <SecretInput id={id} value={secret} onChange={(e) => setSecret(e.target.value)} disabled={busy} />
        </div>
        <p className="text-xs text-muted-foreground">
          The password you log in to this computer with. It goes to {release}&apos;s installer once, for this install, and the panel never saves it. Leave it empty if sudo asks you for none.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          {verb}
        </Button>
        {onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

/**
 * An install this page started: its steps until the panel restarts in the
 * middle of it (on success), then a wait for the new panel, which shows how
 * it ended. A failure before the restart shows here with what was put back.
 */
export function InstallProgress({ jobId, release, onAgain }: { jobId: string; release: string; onAgain: () => void }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (restarting || (job && settled(job))) return;
    // The panel stops answering once install.sh restarts it: that is the restart, not an error.
    const timer = window.setTimeout(() => api.job(jobId).then(setJob, () => setRestarting(true)), job ? 700 : 0);
    return () => window.clearTimeout(timer);
  }, [job, jobId, restarting]);

  const installing = job?.steps.find((s) => s.id === 'install')?.status === 'running';
  useEffect(() => {
    if (installing) expectRestart();
  }, [installing]);
  useEffect(() => {
    if (!restarting) return;
    expectRestart();
    return waitForRestart(api.health, () => window.location.assign('/update'), { maxMs: 5 * 60_000 });
  }, [restarting]);

  const failedStep = job?.steps.find((s) => s.status === 'failed');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Installing {release}</CardTitle>
        {job?.status === 'failed' ? <CircleAlert className="size-4 text-danger" /> : job?.status === 'done' ? <CircleCheck className="size-4 text-success" /> : <LoaderCircle className="size-4 animate-spin text-primary" />}
      </CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        {restarting ? (
          <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />The panel is restarting on {release}; this page reloads once it answers and shows how the install ended.</p>
        ) : (
          <>
            <p className="text-muted-foreground">{job?.steps.some((s) => s.id === 'download') && `The panel downloads ${release} and checks it first. `}install.sh keeps the root scripts, config.env and sudoers rule, puts the new root scripts in place, restarts the panel and checks it answers. If a step fails, it puts everything back. Other changes wait until it ends.</p>
            {job && <StepList steps={job.steps} open={open} setOpen={setOpen} />}
          </>
        )}
        {job?.status === 'done' && <p className="text-success">{lastLine(job.steps.at(-1)?.output ?? '') || `${release} is installed.`}</p>}
        {job?.status === 'failed' && (
          <div className="grid gap-2">
            <p role="alert" className="text-danger">{lastLine(failedStep?.output ?? '')}</p>
            <Button className="justify-self-start" variant="outline" onClick={onAgain}><KeyRound />Try again</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

const DAY_MS = 86_400_000;

/**
 * How the last install from this page went, read from install.sh's status
 * file: done (for a day), failed with what was put back, interrupted with a
 * way to run it again, or still running (the panel restarted in the middle).
 */
export function LastInstall({ install, onAgain, onRefresh }: { install: NonNullable<UpdateStatus['install']>; onAgain: (release: string) => void; onRefresh: () => void }) {
  const running = install.state === 'running' && !install.interrupted;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(onRefresh, 2000);
    return () => window.clearInterval(timer);
  }, [running, onRefresh]);

  if (running) {
    return (
      <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
        <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
        {install.release} is still installing ({install.step}).
      </p>
    );
  }
  if (install.interrupted) {
    return (
      <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
        <TriangleAlert className="size-4 shrink-0 text-warning" />
        <div className="grid gap-2">
          <p>The install of {install.release} was interrupted at <b>{install.step}</b> (a restart of this computer, say). Every step is safe to repeat. Its log: <code className="font-mono text-xs break-all">{install.log}</code></p>
          <Button className="justify-self-start" variant="outline" size="sm" onClick={() => onAgain(install.release)}><KeyRound />Run it again</Button>
        </div>
      </div>
    );
  }
  if (install.state === 'failed') {
    return (
      <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm">
        <CircleAlert className="size-4 shrink-0 text-danger" />
        <div className="grid gap-1">
          <p className="font-medium">The install of {install.release} failed at {install.step}{install.finished ? `, ${timeAgo(install.finished)}` : ''}.</p>
          <p>{install.message}.</p>
          <p className="text-muted-foreground">
            {install.rolledBack ? `Everything it changed was put back: ${install.previous || 'the release before'} runs as before.` : 'Not everything could be put back.'} Its log: <code className="font-mono text-xs break-all">{install.log}</code>
          </p>
        </div>
      </div>
    );
  }
  if (!install.finished || Date.now() - Date.parse(install.finished) > DAY_MS) return null;
  return (
    <p className="flex gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
      <CircleCheck className="size-4 shrink-0 text-success" />
      <span>
        Installed {install.release}{install.previous ? `, replacing ${install.previous}` : ''}, {timeAgo(install.finished)}. Anything it recommends but did not install shows on the <Link href="/environment" className="font-medium hover:underline">Environment</Link> page.
      </span>
    </p>
  );
}

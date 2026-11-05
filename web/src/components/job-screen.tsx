import type { JobView } from '@devmagic-panel/shared';
import { ArrowRight, CircleX, ExternalLink, LoaderCircle, LogIn, RotateCcw, SkipForward, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { settled, StepList } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { draftHref } from '@/lib/drafts';
import { stepsSkipped } from '@/lib/jobs';
import { waitForRestart } from '@/lib/restart';
import { Link, navigate } from '@/lib/router';
import { expectRestart } from '@/lib/session-watch';
import { lastLine, openWpAdmin } from '@/lib/site-actions';
import { cn } from '@/lib/utils';

/** Jobs an install from an organization starts on its way: their target is the install draft. */
const INSTALL_STEP_JOBS = ['org.readRepo', 'org.checkAccess', 'dump.download', 'dump.useDownloaded'];

/**
 * A job's progress, from its id: the overall bar, each step with its own
 * progress, and retry or undo when it fails. Polls until the job settles; the
 * server keeps working if the page closes, so it can be opened again any time.
 */
export function JobScreen({ jobId, wordpress }: { jobId: string; wordpress?: boolean }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (settled(job)) return;
    const timer = window.setTimeout(() => api.job(jobId).then(setJob, (err: Error) => setError(err.message)), job ? 700 : 0);
    return () => window.clearTimeout(timer);
  }, [job, jobId]);

  // A finished update or switch restarts the panel a few seconds later; once the new one answers, the Updates page shows its version.
  // A download for a terminal install restarts nothing.
  const updated = (job?.kind === 'panel.update' || job?.kind === 'panel.switchRelease') && job.status === 'done' && job.steps.some((s) => s.id === 'restart');
  useEffect(() => {
    if (!updated) return;
    expectRestart();
    return waitForRestart(api.health, () => window.location.assign('/update'));
  }, [updated]);

  async function act(fn: (id: string) => Promise<JobView>) {
    setError(null);
    try {
      setJob(await fn(jobId));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!job) {
    return error ? (
      <p role="alert" className="text-sm text-danger">
        {error === 'unknown job' ? (
          <>The panel no longer holds this job: it restarted since, or the job is older than the last 20. Its output is in <Link href="/runs" className="underline">Run history</Link>.</>
        ) : (
          error
        )}
      </p>
    ) : <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading the job...</p>;
  }

  const install = job.kind === 'site.create';
  const domain = job.target ?? '';
  const steps = job.steps;
  const failed = steps.find((s) => s.status === 'failed');
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const skipped = steps.filter((s) => s.status === 'skipped');
  const skippedText = stepsSkipped(skipped.length);
  const showUndo = job.undo.length > 0;
  const percent = Math.round(job.progress * 100);

  return (
    <div className="grid max-w-3xl gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {job.status === 'queued' && `Waiting to start ${install ? `setting up ${domain}` : job.title}`}
            {job.status === 'running' && (install ? `Setting up ${domain}` : job.title)}
            {job.status === 'done' && (install ? `${domain} is ready${skipped.length ? `, ${skippedText}` : ''}` : updated ? `${job.kind === 'panel.switchRelease' ? 'Switched' : 'Updated'}: the panel is restarting` : `${job.title}: done`)}
            {job.status === 'failed' && !showUndo && (install ? 'The install stopped' : `${job.title} stopped`)}
            {job.status === 'failed' && showUndo && 'Undo did not finish'}
            {job.status === 'undoing' && 'Undoing'}
            {job.status === 'undone' && 'Everything was undone'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {job.status === 'queued' ? 'Two installs run at once; this one starts when one of them finishes.' : `${doneCount} of ${steps.length} steps done${skipped.length ? `, ${skippedText}` : ''}${job.status === 'running' ? `, ${percent}%` : ''}`}
          </p>
        </div>
        {INSTALL_STEP_JOBS.includes(job.kind ?? '') && /^[0-9a-f-]{36}$/.test(domain) && (
          <Button variant="outline" onClick={() => navigate(draftHref(domain))}>Back to the install<ArrowRight /></Button>
        )}
        {job.status === 'done' && install && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => window.open(`https://${domain}`, '_blank', 'noopener')}><ExternalLink />Open site</Button>
            {(wordpress ?? steps.some((s) => s.id === 'core')) && <Button variant="outline" onClick={() => void openWpAdmin(domain)}><LogIn />wp-admin</Button>}
            <Button onClick={() => navigate(`/sites/${encodeURIComponent(domain)}`)}>Go to site<ArrowRight /></Button>
          </div>
        )}
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={cn('h-full rounded-full transition-all duration-500', failed ? 'bg-danger' : 'bg-primary')} style={{ width: `${percent}%` }} />
      </div>

      <StepList steps={steps} open={open} setOpen={setOpen} />

      {job.status === 'failed' && failed && !showUndo && (
        <div className="rounded-xl border border-danger/30 bg-danger/6 p-4">
          <p className="flex items-center gap-2 text-sm font-medium"><CircleX className="size-4 text-danger" />{failed.label} failed</p>
          {failed.output && <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-danger">{lastLine(failed.output)}</pre>}
          <p className="mt-2 text-sm text-muted-foreground">
            Fix the cause, then retry. Steps already done are kept.
            {job.undoable.length > 0 ? ` Undo everything takes back, newest first: ${job.undoable.join('; ')}.` : ' This job made nothing that can be taken back, so there is no undo.'}
          </p>
          {failed.skippable && (
            <p className="mt-2 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
              <span className="font-medium">The site works without this step.</span> Skip it and the install goes on; the site's page keeps what is left to do: {failed.skippable}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void act(api.retryJob)}><RotateCcw />Retry from this step</Button>
            {failed.skippable && <Button variant="outline" onClick={() => void act(api.skipJob)}><SkipForward />Skip and continue</Button>}
            {job.undoable.length > 0 && <Button variant="outline" onClick={() => void act(api.undoJob)}><Trash2 />Undo everything</Button>}
          </div>
        </div>
      )}

      {showUndo && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Undo</p>
          <StepList steps={job.undo} open={open} setOpen={setOpen} />
          {job.status === 'undone' && install && (
            <p className="text-sm text-muted-foreground">
              Removed what this install created.{' '}
              <button type="button" className="font-medium text-foreground hover:underline" onClick={() => window.location.assign('/sites/new')}>Start again</button>
            </p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

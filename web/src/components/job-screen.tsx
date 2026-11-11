import type { JobView } from '@devmagic-panel/shared';
import { ArrowRight, CircleX, ExternalLink, LogIn, RotateCcw, SkipForward, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { settled, StepList, useFollowed } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { draftHref } from '@/lib/drafts';
import { stepsSkipped } from '@/lib/jobs';
import { waitForRestart } from '@/lib/restart';
import { navigate } from '@/lib/router';
import { expectRestart } from '@/lib/session-watch';
import { lastLine, openWpAdmin } from '@/lib/site-actions';
import { loadThroughRestart } from '@/lib/startup';
import { cn } from '@/lib/utils';
import { Notice } from '@/components/ui/notice';
import { TextLink } from '@/components/ui/text-link';
import { Bar, ListSkeleton, Reading } from '@/components/skeletons';

/** Jobs an install from an organization starts on its way: their target is the install draft. */
const INSTALL_STEP_JOBS = ['org.readProject', 'org.readRepo', 'org.checkAccess', 'dump.download', 'dump.useDownloaded'];

/**
 * A job's progress, from its id: the overall bar, each step with its own
 * progress, and retry or undo when it fails. Polls until the job settles; the
 * server keeps working if the page closes, so it can be opened again any time.
 */
/** Wide: the page's whole width, on a job's own page like a run's; otherwise as wide as the wizard it follows. */
export function JobScreen({ jobId, wordpress, wide = false }: { jobId: string; wordpress?: boolean; wide?: boolean }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useFollowed(jobId);

  useEffect(() => {
    if (settled(job)) return;
    let live = true;
    const timer = window.setTimeout(() => {
      loadThroughRestart(() => api.job(jobId), { stopped: () => !live }).then(
        (view) => live && setJob(view),
        (err: Error) => live && setError(err.message),
      );
    }, job ? 700 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
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
      <Notice tone={error === 'unknown job' ? 'info' : 'danger'}>
        {error === 'unknown job' ? (
          <>The panel no longer holds this job: it restarted since, or the job is older than the last 20. Its output is in <TextLink href="/activity/runs" tone="plain" className="underline">Run history</TextLink>.</>
        ) : (
          error
        )}
      </Notice>
    ) : (
      <div className="grid gap-4" aria-busy="true">
        <Bar className="h-7 w-80 max-w-full" />
        <Reading>Reading the job...</Reading>
        <ListSkeleton rows={4} />
      </div>
    );
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
    <div className={cn('grid gap-5', !wide && 'max-w-3xl')}>
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
        {job.kind?.startsWith('panel.') && !updated && job.status !== 'running' && job.status !== 'queued' && (
          <Button variant="outline" onClick={() => navigate('/update')}>Back to Updates<ArrowRight /></Button>
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
        <div className="grid gap-3">
          <Notice tone="danger" icon={false}>
            <p className="flex items-center gap-2 font-medium text-foreground"><CircleX className="size-4 text-danger" />{failed.label} failed</p>
            {failed.output && <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-danger">{lastLine(failed.output)}</pre>}
            <p className="mt-2 text-muted-foreground">
              Fix the cause, then retry. Steps already done are kept.
              {job.undoable.length > 0 ? ` Undo everything takes back, newest first: ${job.undoable.join('; ')}.` : ' This job made nothing that can be taken back, so there is no undo.'}
            </p>
          </Notice>
          {failed.skippable && (
            <Notice tone="warning">
              <span className="font-medium">The site works without this step.</span> Skip it and the install goes on; the site's page keeps what is left to do: {failed.skippable}
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
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
              <Button variant="soft" size="xs" className="ml-1" onClick={() => window.location.assign('/sites/new')}>Start again</Button>
            </p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

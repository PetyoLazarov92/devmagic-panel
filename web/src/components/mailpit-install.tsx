import { Download, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { settled, StepList, useJob } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { lastLine } from '@/lib/site-actions';
import { Spinner } from '@/components/ui/spinner';

/**
 * Installs Mailpit (the pinned release, checksum checked, as a user service)
 * or starts the copy the panel installed, and shows the steps while it runs.
 */
export function MailpitInstall({ offer, onDone, size = 'sm' }: { offer: 'install' | 'start'; onDone: () => void; size?: 'sm' | 'default' }) {
  const job = useJob();
  const [open, setOpen] = useState<string | null>(null);
  const running = job.job !== null && !settled(job.job);
  const failed = job.job?.steps.find((s) => s.status === 'failed');

  useEffect(() => {
    if (job.job?.status === 'done') onDone();
  }, [job.job?.status, onDone]);

  return (
    <div className="grid gap-2">
      <Button size={size} className="justify-self-start" disabled={running} onClick={() => void job.follow(api.startJob('mailpit.install', {}))}>
        {running ? <Spinner /> : offer === 'install' ? <Download /> : <Play />}
        {offer === 'install' ? 'Install Mailpit' : 'Start Mailpit'}
      </Button>
      {job.job && running && <StepList steps={job.job.steps} open={open} setOpen={setOpen} />}
      {failed?.output && <p className="text-xs text-danger">{lastLine(failed.output)}</p>}
      {job.error && <p role="alert" className="text-xs text-danger">{job.error}</p>}
    </div>
  );
}

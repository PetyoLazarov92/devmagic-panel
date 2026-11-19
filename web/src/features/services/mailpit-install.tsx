import { Download, Play } from 'lucide-react';
import { useEffect } from 'react';
import { settled, useJob } from '@/features/jobs/job-steps';
import { JobBox } from '@/features/jobs/job-box';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';

/**
 * Installs Mailpit (the pinned release, checksum checked, as a user service)
 * or starts the copy the panel installed, and shows the steps while it runs.
 */
export function MailpitInstall({ offer, onDone, size = 'sm' }: { offer: 'install' | 'start'; onDone: () => void; size?: 'sm' | 'default' }) {
  const job = useJob({ kinds: ['mailpit.install'] });
  const running = job.job !== null && !settled(job.job);

  useEffect(() => {
    if (job.job?.status === 'done') onDone();
  }, [job.job?.status, onDone]);

  return (
    <div className="grid gap-2">
      <Button size={size} className="justify-self-start" disabled={running} onClick={() => void job.follow(api.startJob('mailpit.install', {}))}>
        {running ? <Spinner /> : offer === 'install' ? <Download /> : <Play />}
        {offer === 'install' ? 'Install Mailpit' : 'Start Mailpit'}
      </Button>
      {job.job && <JobBox job={job.job} onRetry={() => void job.retry()} onDismiss={job.clear} />}
      {job.error && <p role="alert" className="text-xs text-danger">{job.error}</p>}
    </div>
  );
}

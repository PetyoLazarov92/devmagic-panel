import { useEffect } from 'react';
import { JobScreen } from '@/features/jobs/job-screen';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { markJobSeen } from '@/lib/seen-jobs';

/** A job on its own page, so an install can be followed again after leaving the wizard. */
export function JobPage({ id }: { id: string }) {
  // Opening a failed job is what the header badge asks for; it stops asking.
  useEffect(() => markJobSeen(id), [id]);
  return (
    <div className="grid gap-4 pt-4">
      <Breadcrumbs items={[{ label: 'Activity', href: '/activity' }, { label: 'Job' }]} />
      <JobScreen jobId={id} wide />
    </div>
  );
}

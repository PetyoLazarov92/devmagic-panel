import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { JobScreen } from '@/components/job-screen';
import { Link } from '@/lib/router';
import { markJobSeen } from '@/lib/seen-jobs';

/** A job on its own page, so an install can be followed again after leaving the wizard. */
export function JobPage({ id }: { id: string }) {
  // Opening a failed job is what the header badge asks for; it stops asking.
  useEffect(() => markJobSeen(id), [id]);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 pt-4">
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All jobs
      </Link>
      <JobScreen jobId={id} />
    </div>
  );
}

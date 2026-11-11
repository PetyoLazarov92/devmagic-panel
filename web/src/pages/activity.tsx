import { PageHeader } from '@/components/layout/page';
import { Tabs } from '@/components/ui/tabs';
import { navigate } from '@/lib/router';
import { JobsPage } from '@/features/jobs/jobs-list';
import { RunsPage } from '@/features/jobs/runs-list';

export type ActivityTab = 'jobs' | 'runs';

/** What the panel did: the jobs since it started (running ones first) and the history of every action it ran. */
export function ActivityPage({ tab }: { tab: ActivityTab }) {
  return (
    <div className="pt-4">
      <PageHeader title="Activity" intro="The jobs running and done since the panel started, and every action it ran with its output." />
      <Tabs
        className="mt-6"
        value={tab}
        onChange={(t) => navigate(t === 'runs' ? '/activity/runs' : '/activity')}
        items={[
          { value: 'jobs', label: 'Jobs' },
          { value: 'runs', label: 'Run history' },
        ]}
      />
      {tab === 'jobs' ? <JobsPage bare /> : <RunsPage bare />}
    </div>
  );
}

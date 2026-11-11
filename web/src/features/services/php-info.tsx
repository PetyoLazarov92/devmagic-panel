import type { PhpFpmFinding, PhpVersion } from '@devmagic-panel/shared';
import { Info, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/features/jobs/job-box';
import { settled, useJob } from '@/features/jobs/job-steps';
import { InfoTables } from '@/features/services/php-bits';
import { ScopeLabel } from '@/components/layout/scope-label';
import { StatusDot } from '@/components/layout/site-bits';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { ReadingBlock } from '@/components/layout/skeletons';
import { Section, errorBox } from './php-shared';

export function SapiPicker({ value, onChange, cli }: { value: 'web' | 'cli'; onChange: (v: 'web' | 'cli') => void; cli: boolean }) {
  return (
    <div className="inline-flex rounded-lg border p-0.5 text-xs" role="radiogroup" aria-label="Which PHP">
      {(['web', 'cli'] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          disabled={s === 'cli' && !cli}
          onClick={() => onChange(s)}
          className={cn('rounded-md px-3 py-1', value === s ? 'bg-primary/12 font-medium text-primary' : 'text-muted-foreground hover:text-foreground disabled:opacity-50')}
        >
          {s === 'web' ? 'Web' : 'Command line'}
        </button>
      ))}
    </div>
  );
}

/** phpinfo() for one version, from the PHP itself: sections per extension, with a filter. */
export function InfoSection({ version }: { version: PhpVersion }) {
  const [sapi, setSapi] = useState<'web' | 'cli'>('web');
  return (
    <Section title="PHP info" icon={<ScopeLabel>{`PHP ${version.version}`}</ScopeLabel>} hint={`What phpinfo() shows for PHP ${version.version}, for the web or the command line, asked from PHP itself.`}>
      {() => (
        <div className="grid gap-4">
          <SapiPicker value={sapi} onChange={setSapi} cli={version.sapis.includes('cli')} />
          <InfoView key={sapi} version={version.version} sapi={sapi} />
        </div>
      )}
    </Section>
  );
}

export function InfoView({ version, sapi }: { version: string; sapi: 'web' | 'cli' }) {
  const { data, error, loading } = useAsync(() => api.phpInfo(version, sapi), [version, sapi]);
  const [filter, setFilter] = useState('');
  if (loading && !data) return <ReadingBlock lines={6}>Asking PHP...</ReadingBlock>;
  if (error) return errorBox(error);
  if (!data) return null;
  return <InfoTables info={data} filter={filter} onFilter={setFilter} />;
}


/** What changes for sites once they run on PHP-FPM, checked before any site moves. */
export function FpmCheckSection() {
  return (
    <Section compact title="Before sites move to PHP-FPM" icon={<ShieldCheck className="size-4 text-muted-foreground" />} hint="For every site: php_value lines, .user.ini files, phpMyAdmin, and differences between Apache's and FPM's settings per version.">
      {() => <FpmCheckView />}
    </Section>
  );
}

export function FpmCheckView() {
  const { data, error, loading, reload } = useAsync(() => api.phpFpmCheck(), []);
  const runner = useJob();
  const done = useRef<string | null>(null);
  const { job } = runner;
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    reload();
  }, [job, reload]);
  if (loading && !data) return <ReadingBlock lines={4}>Checking your sites and Apache config...</ReadingBlock>;
  if (error) return errorBox(error);
  if (!data) return null;
  const mismatched = [...new Set(data.filter((f) => f.status === 'warn' && f.version).map((f) => f.version as string))];
  return (
    <div className="grid gap-4">
      <ul className="grid gap-3">
        {data.map((f: PhpFpmFinding, i) => (
          <li key={`${f.id}-${i}`} className="flex gap-3">
            {f.status === 'info' ? <Info className="mt-0.5 size-4 shrink-0 text-primary" /> : <StatusDot status={f.status} className="mt-1.5" />}
            <div className="min-w-0">
              <p>{f.text}</p>
              {f.files && f.files.length > 0 && (
                <ul className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground">
                  {f.files.slice(0, 20).map((file) => <li key={file} className="[overflow-wrap:anywhere]">{file}</li>)}
                  {f.files.length > 20 && <li>and {f.files.length - 20} more</li>}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
      {mismatched.length > 0 && !job && (
        <div className="flex flex-wrap items-center gap-2">
          {mismatched.map((v) => (
            <Button key={v} variant="outline" onClick={() => void runner.follow(api.startJob('php.matchFpm', { version: v }))}>
              Make PHP-FPM {v} match Apache
            </Button>
          ))}
          <p className="w-full text-xs text-muted-foreground">Gives FPM the same modules, the panel&apos;s settings and Xdebug, and Apache&apos;s php.ini (FPM&apos;s own is saved, and Undo puts it back).</p>
        </div>
      )}
      {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
      {runner.error && errorBox(runner.error)}
    </div>
  );
}

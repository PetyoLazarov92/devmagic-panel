import type { Site } from '@devmagic-panel/shared';
import { LogSkeleton } from '@/components/layout/skeletons';
import { LogView } from '@/components/layout/log-view';
import { Segmented } from '@/components/ui/segmented';
import { runWithToast } from '@/lib/site-actions';
import { api } from '@/lib/api';
import { navigate, useQueryParam } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { siteTarget } from '@/lib/site-ref';
import { tabHref } from './site-shared';
import { DebugSettings } from './overview';

export function LogsTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const source = useQueryParam('log') === 'apache' ? 'apache' : 'debug';
  const setSource = (next: 'debug' | 'apache') => navigate(tabHref(site, 'logs', next === 'apache' ? '&log=apache' : ''), { scroll: false });
  const log = useAsync(() => api.logs(site.domain, source, site.path), [site.domain, site.path, source]);
  return (
    <div className="grid gap-3">
      {site.core.kind !== 'none' && <DebugSettings site={site} onChanged={onChanged} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Log" value={source} onChange={setSource} options={[['debug', 'debug.log'], ['apache', site.server === 'nginx' ? 'nginx errors' : 'Apache errors']]} />
        {log.data && <p className="font-mono text-xs break-all text-muted-foreground">{log.data.file}</p>}
      </div>
      {log.data?.shared && (
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          This site writes to Apache&apos;s shared error log, so only lines that mention its folder or domains are shown.
        </p>
      )}
      {log.data && !log.data.exists && <p className="text-sm text-muted-foreground">The log file does not exist yet.</p>}
      {log.error && <p role="alert" className="text-sm text-danger">{log.error}</p>}
      {log.loading && !log.data ? (
        <LogSkeleton />
      ) : (
        <LogView
          lines={log.data?.lines ?? []}
          files={{ domain: site.domain, ...(site.path ? { path: site.path } : {}), docroot: site.docroot }}
          {...(source === 'debug' && log.data?.exists
            ? { onClear: () => void runWithToast('site.clearDebugLog', siteTarget(site), 'debug.log cleared').then(() => log.reload()) }
            : {})}
        />
      )}
    </div>
  );
}

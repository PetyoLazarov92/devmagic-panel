import type { VersionCompat } from '@devmagic-panel/shared';
import { ScanSearch, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { ScopeLabel } from '@/components/scope-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/field';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';
import { siteHref } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { ListSkeleton } from '@/components/skeletons';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
type Row = VersionCompat['sites'][number];
/** Errors first, then sites not checked yet, then the rest; by name within each. */
const rank = (r: Row) => (r.scan?.errors ? 0 : r.scan ? 2 : 1);

/**
 * A version's page: every site's code checked against it, one site after
 * another, with the last result per site. The list for moving sites to the
 * version; each switch still reads the site's own logs.
 */
export function SitesCompatCard({ version }: { version: string }) {
  const report = useAsync(() => api.phpVersionCompat(version), [version]);
  const [all, setAll] = useState(false);
  const runner = useJob();
  const { job } = runner;
  const busy = job !== null && !settled(job);
  const done = useRef<string | null>(null);

  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    report.reload();
  }, [job, report]);

  const [deleting, setDeleting] = useState(false);
  // Every site's kept scan of this version, and the scanner's cache for them; a check makes them again.
  async function removeAll() {
    setDeleting(true);
    const result = await api.runAction('php.deleteCompat', { version }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: `Scans of PHP ${version} deleted`, detail: lastLine(result.output) } : { tone: 'danger', title: 'Could not delete the scans', detail: lastLine(result.output) });
    setDeleting(false);
    report.reload();
  }

  const data = report.data;
  const rows = [...(data?.sites ?? [])].sort((a, b) => rank(a) - rank(b) || a.host.localeCompare(b.host));
  const blocked = data ? !data.installed && !data.composer : false;
  const withErrors = rows.filter((r) => r.scan?.errors).length;
  const unchecked = rows.filter((r) => !r.scan).length;

  return (
    <Card>
      <CardHeader><CardTitle>Sites&apos; code on PHP {version}</CardTitle><ScopeLabel>every site</ScopeLabel></CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        <p className="text-xs text-muted-foreground">
          Checks every site&apos;s themes and plugins for what PHP {version} removed (errors) or deprecated (warnings), one site after another. A hint for moving sites to this version: the scanner has false alarms, and a site&apos;s switch still opens it and reads its logs.
        </p>
        {data && !data.cli ? (
          <p className="text-xs text-muted-foreground">PHP {version} has no command line, which the scanner runs on: install php{version}-cli first.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="soft" disabled={busy || blocked || !data || rows.length === 0} onClick={() => void runner.follow(api.startJob('php.checkCompatAll', { version, scope: all ? 'all' : 'active' }))}>
              <ScanSearch />Check all sites
            </Button>
            <Checkbox id={`compat-all-${version}`} checked={all} onChange={setAll} disabled={busy} label="Include inactive plugins and themes" />
            {rows.some((r) => r.scan) && (
              <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || deleting} onClick={() => void removeAll()}><Trash2 />Delete all scans of PHP {version}</Button>
            )}
          </div>
        )}
        {blocked && (
          <p className="flex gap-2 text-xs text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            <span>The scanner is fetched once with Composer, which is not installed: run <code className="font-mono">./install.sh</code>, which offers it, or <code className="font-mono">sudo apt install composer</code>.</span>
          </p>
        )}
        {(job || runner.error) && (
          <div className="grid gap-3">
            {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
            {runner.error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{runner.error}</p>}
          </div>
        )}
        {report.error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{report.error}</p>}
        {report.loading && !data && <ListSkeleton rows={3} />}
        {data && rows.length === 0 && <p className="text-xs text-muted-foreground">There is no WordPress site on this machine yet.</p>}
        {rows.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {withErrors ? `${plural(withErrors, 'site')} with errors` : 'No site with errors'} on PHP {version}{unchecked ? `, ${unchecked} not checked yet` : ''}. Runs now is the PHP each site runs today, which the findings do not depend on.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Site</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">Runs now</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">Found on PHP {version}</th>
                    <th className="px-3 py-2 font-medium">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.host} className="border-t align-top">
                      <td className="px-3 py-2">
                        <Link href={`${siteHref(r)}?tab=php`} className="font-medium whitespace-nowrap hover:underline">{r.host}</Link>
                      </td>
                      <td className={cn('px-3 py-2 whitespace-nowrap', r.runs === version ? 'font-medium' : 'text-muted-foreground')}>{r.runs ? `PHP ${r.runs}` : ''}</td>
                      <td className="px-3 py-2">
                        {r.scan ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={r.scan.errors ? 'danger' : 'success'}>{plural(r.scan.errors, 'error')}</Badge>
                            {r.scan.warnings > 0 && <Badge tone="warning">{plural(r.scan.warnings, 'warning')}</Badge>}
                            {r.scan.failed > 0 && <Badge tone="danger">{r.scan.failed} not scanned</Badge>}
                            {r.scan.withErrors.length > 0 && <span className="text-xs text-muted-foreground">in {r.scan.withErrors.join(', ')}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">not checked</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.scan ? <>{timeAgo(r.scan.checkedAt)}{r.scan.stale && <span className="block text-warning">may be out of date</span>}</> : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

import { HTACCESS_STATUS_LABEL, type HtaccessReport, type HtaccessRule, type HtaccessRuleStatus, type Site } from '@devmagic-panel/shared';
import { Check, Copy, FileCode2, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { Notice } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { onHtaccessChanged } from '@/lib/htaccess-notices';
import { useQueryParam } from '@/lib/router';
import { cn } from '@/lib/utils';

const TONE: Record<HtaccessRuleStatus, 'neutral' | 'success' | 'warning' | 'primary'> = {
  covered: 'neutral',
  translated: 'success',
  local: 'neutral',
  php: 'primary',
  manual: 'warning',
};

/** The order rules are filtered in: what needs a look first. */
const FILTERS: Array<HtaccessRuleStatus | 'all'> = ['all', 'translated', 'manual', 'php', 'local', 'covered'];

/** The checksums of a report's files, by folder: what a review hands back. */
export const reviewedSums = (report: HtaccessReport) => Object.fromEntries(report.files.map((f) => [f.folder, f.sha256]));

/** How many rules of each status a report has. */
export function ruleCounts(report: HtaccessReport): Record<HtaccessRuleStatus, number> {
  const counts = { covered: 0, translated: 0, local: 0, php: 0, manual: 0 };
  for (const r of report.rules) counts[r.status]++;
  return counts;
}

/**
 * A site's .htaccess rules as nginx sees them, file by file: what each
 * becomes, or why it stays out. With onSkip, each translated rule has a tick
 * to leave it out; with applied, each says whether the nginx file has it.
 */
export function HtaccessReview({ report, skip, onSkip, applied }: { report: HtaccessReport; skip?: string[]; onSkip?: (skip: string[]) => void; applied?: string[] }) {
  const counts = ruleCounts(report);
  const [filter, setFilter] = useState<HtaccessRuleStatus | 'all'>('all');
  const shown = report.rules.filter((r) => filter === 'all' || r.status === filter);
  const byFile = useMemo(() => {
    const out = new Map<string, HtaccessRule[]>();
    for (const r of shown) out.set(r.file, [...(out.get(r.file) ?? []), r]);
    return [...out];
  }, [shown]);

  if (report.rules.length === 0) return <p className="text-sm text-muted-foreground">No .htaccess rules here: nothing for nginx to miss.</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show rules">
        {FILTERS.filter((f) => f === 'all' || counts[f] > 0).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs', filter === f ? 'border-primary/50 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
          >
            {f === 'all' ? `All ${report.rules.length}` : `${HTACCESS_STATUS_LABEL[f]} ${counts[f]}`}
          </button>
        ))}
      </div>
      {byFile.map(([file, rules]) => (
        <section key={file} className="grid gap-1.5">
          <h4 className="font-mono text-xs text-muted-foreground">{file === '/' ? '' : file}/.htaccess</h4>
          <ul className="divide-y rounded-lg border">
            {rules.map((r) => <RuleRow key={r.id} rule={r} skip={skip} onSkip={onSkip} applied={applied} />)}
          </ul>
        </section>
      ))}
      {report.partial && <ScanLimits report={report} />}
    </div>
  );
}

/** Which limit the read reached, and what that leaves out; a report from before says it the short way. */
function ScanLimits({ report }: { report: HtaccessReport }) {
  const n = (v: number) => v.toLocaleString('en-US');
  const lines: string[] = [];
  if (report.foldersStopped) {
    lines.push(`The site has more than ${n(report.foldersStopped.limit)} folders, so the panel stopped reading at ${report.foldersStopped.at}: an .htaccess in a folder after it is not listed here. Caches and the year folders of uploads are not counted.`);
  }
  if (report.rulesStopped) {
    lines.push(`One nginx file takes ${n(report.rulesStopped.limit)} rules: the ${n(report.rulesStopped.left)} after them are marked to do by hand.`);
  }
  if (!lines.length) lines.push('The panel read so many folders or rules that it stopped; some may be missing here.');
  return (
    <div className="grid gap-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
      {lines.map((l) => <p key={l}>{l}</p>)}
    </div>
  );
}

function RuleRow({ rule, skip, onSkip, applied }: { rule: HtaccessRule; skip?: string[] | undefined; onSkip?: ((skip: string[]) => void) | undefined; applied?: string[] | undefined }) {
  const lines = rule.source.split('\n');
  const ticked = !skip?.includes(rule.id);
  const tick = onSkip && rule.status === 'translated';
  const on = applied && rule.rule ? applied.includes(rule.rule) : undefined;
  return (
    <li className="grid gap-1 px-3 py-2 text-sm">
      <div className="flex items-start gap-2.5">
        {tick ? (
          <input
            type="checkbox"
            aria-label={`Apply: ${lines[0]}`}
            checked={ticked}
            onChange={(e) => onSkip(e.target.checked ? (skip ?? []).filter((id) => id !== rule.id) : [...(skip ?? []), rule.id])}
            className="mt-1 accent-[var(--primary)]"
          />
        ) : null}
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[rule.status]}>{HTACCESS_STATUS_LABEL[rule.status]}</Badge>
            {rule.section && <span className="text-xs text-muted-foreground">{rule.section}</span>}
            <span className="text-xs text-muted-foreground">line {rule.line}</span>
            {on !== undefined && <span className={cn('text-xs', on ? 'text-success' : 'text-warning')}>{on ? 'On nginx' : 'Not on nginx yet'}</span>}
          </div>
          {lines.length > 1 ? (
            <details className="group">
              <summary className="cursor-pointer truncate font-mono text-xs">{lines[0]} <span className="text-muted-foreground">(+{lines.length - 1} lines)</span></summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted/50 px-2 py-1 font-mono text-xs">{rule.source}</pre>
            </details>
          ) : (
            <code className="truncate font-mono text-xs" title={rule.source}>{rule.source}</code>
          )}
          {rule.nginx && <code className="overflow-x-auto whitespace-nowrap font-mono text-xs text-success">→ {rule.nginx}</code>}
          {rule.note && <p className="text-xs text-muted-foreground">{rule.note}</p>}
        </div>
      </div>
    </li>
  );
}

/**
 * The .htaccess rules of a site on nginx, on its Server and PHP tab: what
 * the panel translated into its nginx file, what nginx leaves out and why,
 * the nginx to copy to a host's own settings, and a review to apply them
 * again when an .htaccess changed.
 */
export function HtaccessCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const report = useAsync(() => api.htaccess(site.domain), [site.domain]);
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const job = useJob();
  const done = useRef<string | null>(null);
  const busy = job.job !== null && !settled(job.job);
  useEffect(() => {
    if (!job.job || !settled(job.job) || done.current === job.job.id) return;
    done.current = job.job.id;
    if (job.job.status === 'done') toast({ tone: 'success', title: `${job.job.title}: done` });
    report.reload();
    onChanged();
  }, [job.job, onChanged]);
  // A change the panel noticed while this page is open: read the files again.
  useEffect(() => onHtaccessChanged((domain) => domain === site.domain && report.reload()), [site.domain]);

  const data = report.data;
  const counts = data ? ruleCounts(data) : null;
  const applied = data?.applied?.rules ?? [];
  const translated = data ? [...new Set(data.rules.filter((r) => r.status === 'translated' && r.rule).map((r) => r.rule as string))] : [];
  const added = translated.filter((r) => !applied.includes(r)).length;
  const removed = applied.filter((r) => !translated.includes(r)).length;
  const recorded = Object.keys(data?.applied?.sums ?? {}).length > 0;
  const [putting, setPutting] = useState(false);
  const notNow = async () => {
    if (!data) return;
    setPutting(true);
    const r = await api.runAction('site.dismissHtaccessChange', { domain: site.domain, sums: reviewedSums(data) }).catch(() => null);
    setPutting(false);
    if (!r?.ok) toast({ tone: 'danger', title: 'Could not put the change off' });
    report.reload();
    onChanged();
  };
  // Opened from a notice's Review (?review=htaccess): the review opens once the files are read.
  const asked = useQueryParam('review') === 'htaccess';
  const opened = useRef(false);
  useEffect(() => {
    if (asked && data && !opened.current && (data.pending || data.changed)) {
      opened.current = true;
      setSkip([]);
      setOpen(true);
    }
  }, [asked, data]);
  const review = () => {
    // Every translated rule starts ticked: the review is where one is left out.
    setSkip([]);
    setOpen(true);
  };
  const apply = () => {
    if (!data) return;
    setOpen(false);
    void job.follow(api.startJob('site.applyHtaccessRules', { domain: site.domain, sums: reviewedSums(data), skip }));
  };
  const toApply = data ? data.rules.filter((r) => r.status === 'translated' && !skip.includes(r.id)).length : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>.htaccess rules</CardTitle>
        <FileCode2 className="size-4 text-muted-foreground" />
      </CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        {report.loading && !data && <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Reading the .htaccess files</p>}
        {report.error && <p role="alert" className="text-danger">{report.error}</p>}
        {data && counts && (
          <>
            {data.pending && (
              <Notice
                tone={data.dismissed ? 'info' : 'warning'}
                action={
                  <>
                    {!data.dismissed && <Button size="sm" variant="ghost" disabled={busy || putting} onClick={() => void notNow()}>Not now</Button>}
                    <Button size="sm" disabled={busy} onClick={review}>Review and apply</Button>
                  </>
                }
              >
                {recorded
                  ? `An .htaccess changed since its rules were applied: ${[added ? `${added} rule${added === 1 ? '' : 's'} to add` : '', removed ? `${removed} to take out` : ''].filter(Boolean).join(' and ')} on nginx.`
                  : `${counts.translated} rule${counts.translated === 1 ? '' : 's'} the panel can translate ${counts.translated === 1 ? 'is' : 'are'} not on nginx yet.`}
                {data.dismissed && ' You put it off, so Aura and the notices stay quiet until a file changes again.'}
              </Notice>
            )}
            {!data.pending && data.changed && (
              <Notice tone="info" action={<Button size="sm" variant="outline" disabled={busy} onClick={review}>Review</Button>}>
                An .htaccess changed, but none of the rules nginx gets did (WordPress&apos;s own rules, caches or comments). Review and apply records the files as they are now.
              </Notice>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground">
                nginx reads no .htaccess. {applied.length} rule{applied.length === 1 ? ' is' : 's are'} in the site&apos;s nginx file
                {counts.manual > 0 && `, ${counts.manual} not translated`}. Read {timeAgo(data.checkedAt)}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={report.loading} onClick={report.reload}>
                  <RefreshCw className={cn(report.loading && 'animate-spin')} />
                  Check again
                </Button>
                <Button size="sm" variant="outline" disabled={!data.nginx} title="The nginx of the translated rules, for a host's own nginx settings" onClick={() => void navigator.clipboard?.writeText(data.nginx).then(() => setCopied(true))}>
                  {copied ? <Check /> : <Copy />}
                  Copy nginx rules
                </Button>
              </div>
            </div>
            <HtaccessReview report={data} applied={applied} />
          </>
        )}
        {(job.job || job.error) && (
          <div className="grid gap-3">
            {job.job && <JobBox job={job.job} onRetry={() => void job.retry()} />}
            {job.error && <p role="alert" className="text-danger">{job.error}</p>}
          </div>
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Apply ${site.domain}'s .htaccess rules on nginx`} description="Untick a rule to leave it out. dmp-root checks every rule, nginx -t runs before the reload, the site is checked after, and Undo on the job puts the rules back as they were." size="lg">
        {data && (
          <div className="grid gap-4">
            <HtaccessReview report={data} skip={skip} onSkip={setSkip} applied={applied} />
            <p className="text-xs text-muted-foreground">On a host that runs nginx only, a change to .htaccess does nothing there either: add it to the host&apos;s own nginx rules (Copy nginx rules).</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={apply}>{toApply ? `Apply ${toApply} rule${toApply === 1 ? '' : 's'}` : 'Apply with no rules'}</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

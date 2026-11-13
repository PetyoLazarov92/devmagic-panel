import type { CompatComponent, CompatScan, Site, SiteCompat } from '@devmagic-panel/shared';
import { COMPAT_ISSUE_LIMIT } from '@devmagic-panel/shared';
import { ChevronRight, ScanSearch, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/features/jobs/job-box';
import { settled, useJob } from '@/features/jobs/job-steps';
import { ScopeLabel } from '@/components/layout/scope-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, Select } from '@/components/ui/field';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Notice } from '@/components/layout/page';
import { scrollToCard } from '@/lib/scroll-to';

const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const STALE_MS = 7 * 86_400_000;
const KIND: Record<CompatComponent['kind'], string> = { theme: 'theme', plugin: 'plugin', 'mu-plugin': 'must-use', dropin: 'drop-in', vendor: 'Composer' };

/** What the site's PHP form asks the card for: show a version's findings, or check it now. */
export interface CompatAsk {
  version: string;
  check: boolean;
  /** Counts up, so asking twice for the same thing still reaches the card. */
  n: number;
}

/** A scan older than a week, or of another commit than the site's repo is on now. */
export const scanStale = (scan: CompatScan, commit: string | undefined) => Boolean((scan.commit && commit && scan.commit !== commit) || Date.now() - Date.parse(scan.checkedAt) > STALE_MS);

/** The site's scans, loaded once for its PHP form and this card. */
export function useSiteCompat(site: Site) {
  const target = siteTarget(site);
  return useAsync(() => api.sitePhpCompat(target.domain, target.path), [site.domain, site.path]);
}

/**
 * What the last scan says about the version picked for a switch, under the
 * version picker: findings, not checked yet, or out of date, with Show and
 * Check that act on the card below. Never stops the switch.
 */
export function CompatHint({ compat, version, onAsk }: { compat: SiteCompat | undefined; version: string; onAsk: (ask: Omit<CompatAsk, 'n'>) => void }) {
  if (!compat) return null;
  const link = 'font-medium text-foreground hover:underline';
  if (!compat.versions.includes(version)) return <p className="text-xs text-muted-foreground">PHP {version} has no command line, so its code cannot be checked before the switch; the switch still opens the site and reads its logs.</p>;
  const scan = compat.scans.find((s) => s.version === version);
  if (!scan) {
    return (
      <p className="flex gap-2 text-xs text-muted-foreground">
        <ScanSearch className="size-4 shrink-0" />
        <span>Not checked against PHP {version} yet. <button type="button" className={link} onClick={() => onAsk({ version, check: true })}>Check its code</button> before you apply, or apply and let the switch read the site&apos;s logs.</span>
      </p>
    );
  }
  const hit = scan.components.filter((c) => c.errors > 0).map((c) => c.title);
  const stale = scanStale(scan, compat.commit);
  return (
    <p className={scan.errors ? 'flex gap-2 text-xs text-warning' : 'flex gap-2 text-xs text-muted-foreground'}>
      {scan.errors > 0 ? <TriangleAlert className="size-4 shrink-0" /> : <ScanSearch className="size-4 shrink-0" />}
      <span>
        PHP {version}: {scan.errors ? `${plural(scan.errors, 'error')} in ${hit.join(', ')}` : 'no errors'}{scan.warnings ? `, ${plural(scan.warnings, 'warning')}` : ''}, checked {timeAgo(scan.checkedAt)}{stale ? ', may be out of date' : ''}.{' '}
        {(scan.errors > 0 || scan.warnings > 0) && <><button type="button" className={link} onClick={() => onAsk({ version, check: false })}>Show them</button>{' or '}</>}
        <button type="button" className={link} onClick={() => onAsk({ version, check: true })}>{scan.errors > 0 || scan.warnings > 0 ? 'check again' : 'Check again'}</button>.
        {scan.errors > 0 ? ' You can still apply: the scanner has false alarms, and the switch reads the site\'s logs.' : ''}
      </span>
    </p>
  );
}

/**
 * A site's compatibility card: scan its themes and plugins against a PHP
 * version, and the last scan per version. A hint only: it never blocks a
 * switch, which checks the site itself.
 */
export function CompatCard({ site, current, compat, ask }: { site: Site; current: string | undefined; compat: ReturnType<typeof useSiteCompat>; ask: CompatAsk | null }) {
  if (compat.loading && !compat.data) return <CardsSkeleton reading="Reading the compatibility scans..." cards={[4]} columns={1} />;
  if (compat.error) return <Notice>{compat.error}</Notice>;
  if (!compat.data) return null;
  return <CompatView site={site} compat={compat.data} current={current} ask={ask} onChanged={compat.reload} />;
}

function CompatView({ site, compat, current, ask, onChanged }: { site: Site; compat: SiteCompat; current: string | undefined; ask: CompatAsk | null; onChanged: () => void }) {
  const target = siteTarget(site);
  // The next version up from the one the site runs is what you are about to try.
  const versions = [...compat.versions].sort((a, b) => (newer(a, b) ? -1 : 1));
  const [version, setVersion] = useState(() => versions.filter((v) => current && newer(v, current)).at(-1) ?? versions[0] ?? '');
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState<string | undefined>(compat.scans[0]?.version);
  const runner = useJob();
  const { job } = runner;
  const busy = job !== null && !settled(job);
  const done = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const handled = useRef(0);

  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    setShown(version);
    onChanged();
  }, [job, onChanged, version]);

  const blocked = !compat.installed && !compat.composer;
  // The kept scans of one version, or with none all of the site's; a check makes them again.
  async function remove(version: string | undefined) {
    const result = await api.runAction('php.deleteCompat', { ...target, ...(version ? { version } : {}) }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: version ? `PHP ${version} scan deleted` : 'All scans of this site deleted' } : { tone: 'danger', title: 'Could not delete the scans', detail: lastLine(result.output) });
    setShown(undefined);
    onChanged();
  }
  const start = (v: string) => void runner.follow(api.startJob('php.checkCompat', { ...target, version: v, scope: all ? 'all' : 'active' }));

  // Show or Check from the hint under the version picker.
  useEffect(() => {
    if (!ask || ask.n === handled.current) return;
    handled.current = ask.n;
    setVersion(ask.version);
    if (compat.scans.some((s) => s.version === ask.version)) setShown(ask.version);
    // Check again says why when it cannot start, instead of only scrolling to the card.
    if (ask.check && busy) toast({ tone: 'info', title: 'A check is running', detail: 'Check again once it finishes.' });
    else if (ask.check && blocked) toast({ tone: 'info', title: 'The compatibility check is not installed', detail: 'The card below says what it needs.' });
    else if (ask.check) start(ask.version);
    scrollToCard(card.current);
  });

  const scan = compat.scans.find((s) => s.version === shown) ?? compat.scans[0];

  return (
    <div ref={card} className="scroll-mt-24">
    <Card>
      <CardHeader title="Compatibility" meta={<ScopeLabel>this site</ScopeLabel>} />
      <CardBody>
        <p className="text-xs text-muted-foreground">
          Scans the code of the site&apos;s themes and plugins for what a PHP version removed (errors) or deprecated (warnings), before you switch. It is a hint: the scanner is an alpha with some false alarms, and it cannot see code that only runs at run time. It never stops a switch.
        </p>
        {compat.versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No PHP version has a command line, which the scanner runs on.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="compat-version" className="text-xs font-medium">Check against</label>
              <Select id="compat-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy} wrapClassName="w-40">
                {versions.map((v) => <option key={v} value={v}>{`PHP ${v}${v === current ? ' (now)' : ''}`}</option>)}
              </Select>
            </div>
            <Button variant="soft" disabled={busy || blocked || !version} onClick={() => start(version)}>
              <ScanSearch />Check
            </Button>
            <Checkbox id="compat-all" checked={all} onChange={setAll} disabled={busy} label="Include inactive plugins and themes" />
          </div>
        )}
        {blocked && (
          <p className="flex gap-2 text-xs text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            <span>The scanner is fetched once with Composer, which is not installed: run <code className="font-mono">./install.sh</code>, which offers it, or <code className="font-mono">sudo apt install composer</code>.</span>
          </p>
        )}
        {!compat.installed && compat.composer && <p className="text-xs text-muted-foreground">The first check fetches the scanner (about 8 MB) with Composer into the panel&apos;s data folder. Nothing goes into the site.</p>}
        {(job || runner.error) && (
          <div className="grid gap-3">
            {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
            {runner.error && <Notice>{runner.error}</Notice>}
          </div>
        )}
      </CardBody>
      {scan && (
        <div className="grid gap-3 border-t px-5 py-4 text-sm">
          {compat.scans.length > 1 && (
            <Tabs size="sm" label="Scanned versions" value={scan.version} onChange={setShown} items={compat.scans.map((s) => ({ value: s.version, label: `PHP ${s.version}${s.errors ? ` · ${plural(s.errors, 'error')}` : ''}` }))} />
          )}
          <ScanView scan={scan} commit={compat.commit} busy={busy} onDelete={(all) => void remove(all ? undefined : scan.version)} />
        </div>
      )}
    </Card>
    </div>
  );
}

function ScanView({ scan, commit, busy, onDelete }: { scan: CompatScan; commit: string | undefined; busy: boolean; onDelete: (all: boolean) => void }) {
  const stale = scanStale(scan, commit);
  const found = scan.components.filter((c) => c.errors || c.warnings || c.failed);
  const clean = scan.components.filter((c) => !c.errors && !c.warnings && !c.failed);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">PHP {scan.version}</span>
        <Badge tone={scan.errors ? 'danger' : 'success'}>{plural(scan.errors, 'error')}</Badge>
        <Badge tone={scan.warnings ? 'warning' : 'neutral'}>{plural(scan.warnings, 'warning')}</Badge>
        <span className="text-xs text-muted-foreground">
          in {plural(scan.files, 'file')}, {scan.scope === 'all' ? 'all themes and plugins' : 'active ones'}, checked {timeAgo(scan.checkedAt)}
        </span>
      </div>
      {stale && <p className="text-xs text-warning">May be out of date: {scan.commit && commit && scan.commit !== commit ? 'the site\'s repo is on another commit now' : 'checked more than a week ago'}. Check again to be sure.</p>}
      {found.length === 0 && <p className="text-xs text-muted-foreground">Nothing found in the code it scanned. The switch still checks the site itself answers.</p>}
      {found.map((c) => <ComponentRow key={`${c.kind}-${c.name}`} component={c} />)}
      {clean.length > 0 && <p className="text-xs text-muted-foreground">Nothing found in: {clean.map((c) => c.title).join(', ')}.</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{scan.tool}</p>
        <span className="flex gap-1">
          <Button variant="soft" size="sm" disabled={busy} onClick={() => onDelete(false)}><Trash2 />Delete this scan</Button>
          <Button variant="soft" size="sm" disabled={busy} onClick={() => onDelete(true)}>Delete all of this site&apos;s</Button>
        </span>
      </div>
    </div>
  );
}

function ComponentRow({ component: c }: { component: CompatComponent }) {
  const total = c.errors + c.warnings;
  return (
    <details className="group/c rounded-lg border" open={c.errors > 0}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open/c:rotate-90" />
        <span className="font-medium">{c.title}</span>
        <span className="text-xs text-muted-foreground">{KIND[c.kind]}{c.version ? ` ${c.version}` : ''}{c.status === 'inactive' ? ', inactive' : ''}</span>
        {c.errors > 0 && <Badge tone="danger">{plural(c.errors, 'error')}</Badge>}
        {c.warnings > 0 && <Badge tone="warning">{plural(c.warnings, 'warning')}</Badge>}
        {c.failed && <Badge tone="danger">not scanned</Badge>}
        {c.update && <Badge tone="primary">{c.update} available</Badge>}
      </summary>
      <div className="grid gap-2 border-t px-4 py-3 text-xs">
        {c.failed && <p className="text-danger">The scanner could not read it: {c.failed}</p>}
        {c.update && total > 0 && <p className="text-muted-foreground">Version {c.update} is available: update it first and check again, it may already be fixed.</p>}
        {c.requiresPhp && <p className="text-muted-foreground">It says it needs PHP {c.requiresPhp} or newer.</p>}
        <ul className="grid gap-2">
          {c.issues.map((i, n) => (
            <li key={n} className="grid gap-0.5">
              <span className="font-mono [overflow-wrap:anywhere]"><span className={i.type === 'error' ? 'text-danger' : 'text-warning'}>{i.type}</span> {i.file}:{i.line}</span>
              <span className="text-muted-foreground">{i.message}</span>
            </li>
          ))}
        </ul>
        {total > c.issues.length && <p className="text-muted-foreground">Showing the first {c.issues.length} of {total}, errors first (the panel keeps at most {COMPAT_ISSUE_LIMIT}).</p>}
      </div>
    </details>
  );
}

import type { CoreSecurity, CoresReport } from '@devmagic-panel/shared';
import { coreVersion } from '@devmagic-panel/shared';
import { Download, Layers, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { settled, StepList, useJob } from '@/components/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { ReleaseListLink } from '@/components/release-link';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { lastLine, runWithToast } from '@/lib/site-actions';
import { siteFromName, siteHref as siteRefHref, siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { CheckAgain, Notice, PageHeader } from '@/components/page';
import { CardSkeleton, ListSkeleton, Reading } from '@/components/skeletons';
import { Spinner } from '@/components/ui/spinner';

const STATUS: Record<CoreSecurity, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  latest: { label: 'latest', tone: 'success' },
  // WordPress.org's word: a newer branch exists, but this release has no known security issues.
  outdated: { label: 'outdated', tone: 'warning' },
  insecure: { label: 'security issues', tone: 'danger' },
};

function StatusBadge({ status }: { status: CoreSecurity | undefined }) {
  if (!status) return null;
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

// Sites come by name: local.shop.com, or local.spellbook.example/learn under a path.
const siteHref = (name: string) => siteRefHref(siteFromName(name));

/** The newest installed core without known security issues; sites on older cores are offered a switch to it. */
function bestCore(report: CoresReport): string | undefined {
  return report.cores.find((c) => c.status !== 'insecure')?.version;
}

export function CoresPage() {
  // Check again asks WordPress.org now; other reloads (after a download) take the panel's copy.
  const fresh = useRef(false);
  const { data: report, error, loading, reload } = useAsync(() => {
    const ask = fresh.current;
    fresh.current = false;
    return api.coresReport(ask);
  }, []);
  const checkAgain = () => {
    fresh.current = true;
    reload();
  };
  const adding = useJob();
  const lastJob = useRef<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [insecure, setInsecure] = useState<string | null>(null);

  // Refresh the list once a download settles.
  const { job } = adding;
  useEffect(() => {
    if (!job || !settled(job) || lastJob.current === job.id) return;
    lastJob.current = job.id;
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title} done` });
    reload();
  }, [job, reload]);

  const busy = job !== null && !settled(job);
  const best = report ? bestCore(report) : undefined;

  async function switchSite(domain: string, version: string) {
    setSwitching(domain);
    const result = await runWithToast('core.switch', { ...siteTarget(siteFromName(domain)), version }, `${domain} switched to WordPress ${version}`);
    setSwitching(null);
    if (result?.ok) reload();
  }

  return (
    <div className="pt-4">
      <PageHeader title="WP Cores" intro={<>Shared WordPress releases{report?.coresDir ? <> in <span className="font-mono">{report.coresDir}</span></> : ''}, linked into sites by wpcore. Status comes from WordPress.org.</>} actions={<CheckAgain onClick={checkAgain} loading={loading} />} />

      {error && <Notice className="mt-6">{error}</Notice>}
      {!report && loading && (
        <div className="mt-6 grid gap-3" aria-busy="true">
          <Reading>Reading the cores folder...</Reading>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[1fr_22rem]">
            <ListSkeleton rows={4} />
            <CardSkeleton lines={3} />
          </div>
        </div>
      )}

      {report && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Installed</CardTitle>
                {report.latest && <span className="text-xs text-muted-foreground">Latest release: {report.latest}</span>}
              </CardHeader>
              {report.cores.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">{report.ready ? 'No cores yet.' : 'wpcore is not set up yet. The installer creates its config and cores folder.'}</p>
              ) : (
                <ul className="divide-y">
                  {report.cores.map((core) => (
                    <li key={core.version} className="grid gap-2 px-5 py-3.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-base font-medium">{core.version}</span>
                        <StatusBadge status={core.status} />
                        <span className="text-xs text-muted-foreground">{core.sites.length === 0 ? 'no sites' : `${core.sites.length} site${core.sites.length === 1 ? '' : 's'}`}</span>
                        <span className="flex-1" />
                        {core.sites.length === 0 && (
                          <Button size="sm" variant="soft" onClick={() => setRemoving(core.version)} disabled={busy}>
                            <Trash2 />
                            Remove
                          </Button>
                        )}
                      </div>
                      {core.sites.length > 0 && (
                        <ul className="grid gap-1.5 pl-1">
                          {[...new Set(core.sites)].map((domain) => (
                            <li key={domain} className="flex flex-wrap items-center gap-2">
                              <Link href={siteHref(domain)} className="font-mono text-dense hover:underline">{domain}</Link>
                              {best && best !== core.version && core.status !== 'latest' && (
                                <Button size="sm" variant="outline" disabled={switching !== null} onClick={() => void switchSite(domain, best)}>
                                  {switching === domain ? <Spinner /> : <Layers />}
                                  Switch to {best}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {report.standalone.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Sites with their own copy</CardTitle></CardHeader>
                <ul className="divide-y">
                  {report.standalone.filter((s, i, all) => all.findIndex((o) => o.domain === s.domain) === i).map((s) => (
                    <li key={s.domain} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
                      <Link href={siteHref(s.domain)} className="font-mono text-dense hover:underline">{s.domain}</Link>
                      <span className="font-mono text-dense text-muted-foreground">{s.version}</span>
                      <StatusBadge status={s.status} />
                    </li>
                  ))}
                </ul>
                <p className="border-t px-5 py-3 text-xs text-muted-foreground">
                  wpcore does not manage these. Update them in the site folder with <code className="font-mono">wp core update</code>.
                </p>
              </Card>
            )}
          </div>

          <div className="grid content-start gap-4">
            <AddCard
              report={report}
              busy={busy}
              onAdd={(version) => (report.insecure.includes(version) ? setInsecure(version) : void adding.follow(api.startJob('core.add', { version })))}
            />
            {(job || adding.error) && <AddProgress job={job} error={adding.error} />}
          </div>
        </div>
      )}

      <InsecureDialog
        version={insecure}
        onClose={() => setInsecure(null)}
        onConfirm={(version) => {
          setInsecure(null);
          void adding.follow(api.startJob('core.add', { version, confirmInsecure: version }));
        }}
      />

      <RemoveDialog
        version={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          reload();
        }}
      />
    </div>
  );
}

function AddCard({ report, busy, onAdd }: { report: CoresReport; busy: boolean; onAdd: (version: string) => void }) {
  const [other, setOther] = useState('');
  const otherValid = coreVersion.safeParse(other.trim()).success;
  return (
    <Card>
      <CardHeader><CardTitle>Add a release</CardTitle><Download className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        {report.available.length > 0 ? (
          <ul className="grid gap-2">
            {report.available.map((r) => (
              <li key={r.version} className="flex items-center gap-2">
                <span className="font-mono">{r.version}</span>
                <StatusBadge status={r.status} />
                <span className="flex-1" />
                <Button size="sm" variant="outline" disabled={busy || !report.ready} onClick={() => onAdd(r.version)}><Plus />Add</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{report.latest ? 'The newest release of each recent branch is installed.' : 'WordPress.org could not be reached, so there is no release list. You can still add a version by number.'}</p>
        )}
        <div className="flex items-end gap-2 border-t pt-4">
          <Field className="flex-1" label="Other version" htmlFor="core-other" hint={<ReleaseListLink />}>
            <Input id="core-other" value={other} onChange={(e) => setOther(e.target.value)} placeholder="6.8.11" className="font-mono text-dense" spellCheck={false} />
          </Field>
          <Button variant="outline" className="h-10" disabled={busy || !otherValid || !report.ready} onClick={() => onAdd(other.trim())}><Plus />Add</Button>
        </div>
        <p className="text-xs text-muted-foreground">Downloaded from wordpress.org by wpcore, without wp-content. A release with known security issues asks you to confirm first, for testing only.</p>
      </div>
    </Card>
  );
}

function AddProgress({ job, error }: { job: ReturnType<typeof useJob>['job']; error: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const failed = job?.steps.find((s) => s.status === 'failed');
  return (
    <div className="grid gap-2">
      {job && <StepList steps={job.steps} open={open} setOpen={setOpen} />}
      {failed?.output && <p className="text-sm text-danger">{lastLine(failed.output)}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function InsecureDialog({ version, onClose, onConfirm }: { version: string | null; onClose: () => void; onConfirm: (version: string) => void }) {
  const [typed, setTyped] = useState('');
  const close = () => {
    setTyped('');
    onClose();
  };
  return (
    <Dialog
      open={version !== null}
      onClose={close}
      title={`Add WordPress ${version ?? ''} anyway?`}
      description="WordPress.org lists known security issues in this release. Use it only to test on this machine, and switch sites back to a patched core afterwards."
    >
      <ConfirmField id="core-insecure-confirm" expected={version ?? ''} value={typed} onChange={setTyped} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="soft" onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          disabled={typed !== version}
          onClick={() => {
            setTyped('');
            if (version) onConfirm(version);
          }}
        >
          <Plus />
          Add for testing
        </Button>
      </div>
    </Dialog>
  );
}

function RemoveDialog({ version, onClose, onRemoved }: { version: string | null; onClose: () => void; onRemoved: () => void }) {
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const close = () => {
    setTyped('');
    onClose();
  };
  async function remove() {
    if (!version) return;
    setRunning(true);
    const result = await runWithToast('core.remove', { version, confirm: typed }, `WordPress ${version} removed`);
    setRunning(false);
    setTyped('');
    if (result?.ok) onRemoved();
  }
  return (
    <Dialog open={version !== null} onClose={close} title={`Remove WordPress ${version ?? ''}?`} description="No site uses this core. Its folder is deleted; you can add the release again any time.">
      <ConfirmField id="core-confirm" expected={version ?? ''} value={typed} onChange={setTyped} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="soft" onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={typed !== version || running} onClick={() => void remove()}>
          {running ? <Spinner /> : <Trash2 />}
          Remove
        </Button>
      </div>
    </Dialog>
  );
}

import type { ArchiveReason, TrashEntry } from '@devmagic-panel/shared';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { settled, StepList, useJob } from '@/components/job-steps';
import { installLabel } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { bytes, dateTime } from '@/lib/format';
import { Link, navigate } from '@/lib/router';
import { lastLine, runWithToast } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useReloadWhileBusy } from '@/lib/jobs';
import { cn } from '@/lib/utils';
import { CheckAgain, EmptyState, Notice } from '@/components/page';
import { CardSkeleton, Reading } from '@/components/skeletons';
import { Spinner } from '@/components/ui/spinner';

const daysLeft = (e: TrashEntry) => Math.max(0, Math.ceil((new Date(e.purgeAt).getTime() - Date.now()) / 86_400_000));

const REASONS: Record<ArchiveReason, { label: string; tone: 'neutral' | 'warning' }> = {
  deleted: { label: 'removed', tone: 'neutral' },
  reinstall: { label: 'replaced by a reinstall', tone: 'warning' },
  restore: { label: 'replaced by a restore', tone: 'warning' },
};

/** Whether an archived copy matches what is typed in the Sites page's filter. */
export const removedMatches = (e: Pick<TrashEntry, 'domain'>, query: string) => !query.trim() || e.domain.toLowerCase().includes(query.trim().toLowerCase());

/**
 * Archived copies of sites from the last two weeks, by site and newest first:
 * removed sites, and sites a reinstall or a restore replaced. Each holds the
 * folder, vhost, certificate and database, so it can be put back; when the
 * site exists again, it goes to the archive first. Copies go for good when
 * purged. The Sites page's Removed filter (/sites?show=removed), once the
 * Archive page.
 */
export function RemovedSites({ entries, error, loading, reload, query }: { entries: TrashEntry[] | null; error: string | null; loading: boolean; reload: () => void; query: string }) {
  const [deleting, setDeleting] = useState<TrashEntry | null>(null);
  useReloadWhileBusy(Boolean(entries?.some((e) => e.busy)), reload);
  // One card per site, sites by their newest copy.
  const groups = useMemo(() => {
    const by = new Map<string, TrashEntry[]>();
    for (const e of (entries ?? []).filter((x) => removedMatches(x, query))) by.set(e.domain, [...(by.get(e.domain) ?? []), e]);
    return [...by.values()].map((list) => list.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))).sort((a, b) => (b[0]?.deletedAt ?? '').localeCompare(a[0]?.deletedAt ?? ''));
  }, [entries, query]);

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">Removed sites, and sites a reinstall or a restore replaced, are kept for 14 days with their folder, vhost, certificate and database, then deleted for good.</p>
        <CheckAgain size="sm" onClick={reload} loading={loading} />
      </div>

      {error && <Notice className="mt-4">{error}</Notice>}
      {!entries && loading && (
        <div className="mt-4 grid gap-3" aria-busy="true">
          <Reading>Reading the removed sites...</Reading>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={2} />
        </div>
      )}
      {entries && entries.length === 0 && (
        <EmptyState className="mt-4" icon={Archive} title="No removed sites">
          A site you remove, reinstall or restore over shows up here for 14 days, ready to put back.
        </EmptyState>
      )}
      {entries && entries.length > 0 && groups.length === 0 && (
        <EmptyState className="mt-4" icon={Archive} title={`No removed site matches ${query.trim()}.`} />
      )}
      <div className="mt-4 grid gap-4">
        {groups.map((list) => (
          <Card key={list[0]?.domain}>
            <CardHeader
              title={<span className="block truncate font-mono" title={list[0]?.domain}>{list[0]?.domain}</span>}
              meta={<Badge>{list.length === 1 ? '1 copy' : `${list.length} copies`}</Badge>}
            />
            <div className="divide-y">
              {list.map((e) => <TrashRow key={e.id} entry={e} onDelete={() => setDeleting(e)} onRestored={reload} />)}
            </div>
          </Card>
        ))}
      </div>

      <DeleteDialog
        entry={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          reload();
        }}
      />
    </div>
  );
}

function TrashRow({ entry, onDelete, onRestored }: { entry: TrashEntry; onDelete: () => void; onRestored: () => void }) {
  const job = useJob();
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Held from the click on, and while any job works on this domain (its restore, started here or elsewhere).
  const running = starting || (job.job !== null && !settled(job.job)) || Boolean(entry.busy);

  async function restore(replaceCurrent: boolean) {
    setConfirming(false);
    setStarting(true);
    try {
      await job.follow(api.startJob('trash.restore', { id: entry.id, replaceCurrent }));
    } finally {
      setStarting(false);
    }
  }
  const failed = job.job?.steps.find((s) => s.status === 'failed');

  useEffect(() => {
    if (job.job?.status !== 'done') return;
    toast({ tone: 'success', title: `${entry.domain} is back` });
    navigate(`/sites/${encodeURIComponent(entry.domain)}`);
    onRestored();
  }, [job.job?.status, entry.domain, onRestored]);

  const left = daysLeft(entry);
  const reason = REASONS[entry.reason];
  const contents = ['folder', 'vhost', 'certificate', ...(entry.hasDump ? [`database${entry.dbName ? ` ${entry.dbName}` : ''}`] : [])].join(', ');
  return (
    <div className="grid gap-3 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{dateTime(entry.deletedAt)}</span>
            <Badge tone={reason.tone}>{reason.label}</Badge>
          </p>
          <p className="text-xs text-muted-foreground">
            {bytes(entry.sizeBytes)}: {contents}. {entry.install ? `${installLabel(entry.install)}. ` : entry.panelMade ? 'Made by the panel. ' : 'Made outside the panel. '}
            <span className={cn(left <= 2 && 'text-warning')}>{left === 0 ? 'Purged at the next check.' : `Deleted for good in ${left} day${left === 1 ? '' : 's'}.`}</span>
          </p>
        </div>
        {entry.busy && !job.job && (
          <Link href={entry.busy.jobId ? `/jobs/${encodeURIComponent(entry.busy.jobId)}` : '/activity'} className="text-xs font-medium text-warning hover:underline">
            Busy: {entry.busy.title}
          </Link>
        )}
        <Button size="sm" disabled={running} onClick={() => (entry.replaces ? setConfirming(true) : void restore(false))}>
          {running ? <Spinner /> : <ArchiveRestore />}
          Restore
        </Button>
        <Button size="sm" variant="soft" disabled={running} onClick={onDelete}><Trash2 />Delete now</Button>
      </div>
      {job.job && (running || failed) && <StepList steps={job.job.steps} open={open} setOpen={setOpen} />}
      {failed?.output && <p className="text-xs text-danger">{lastLine(failed.output)}</p>}
      {job.error && <p role="alert" className="text-xs text-danger">{job.error}</p>}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Replace the current ${entry.domain}?`}
        description={
          entry.replaces?.refusal
            ? `${entry.domain} exists, and the panel cannot archive it first: ${entry.replaces.refusal}`
            : `${entry.domain} exists now. It goes to the archive first, with its database, then the copy from ${dateTime(entry.deletedAt)} comes back. Undo on the job puts the current one back.`
        }
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button disabled={Boolean(entry.replaces?.refusal)} onClick={() => void restore(true)}>
            <ArchiveRestore />
            Archive it and restore
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function DeleteDialog({ entry, onClose, onDeleted }: { entry: TrashEntry | null; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => {
    setTyped('');
    onClose();
  };
  async function remove() {
    if (!entry) return;
    setBusy(true);
    const result = await runWithToast('trash.delete', { id: entry.id, confirm: typed }, `The copy of ${entry.domain} is deleted for good`);
    setBusy(false);
    setTyped('');
    if (result?.ok) onDeleted();
  }
  return (
    <Dialog
      open={entry !== null}
      onClose={close}
      title={`Delete this copy of ${entry?.domain ?? ''} for good?`}
      description={`The copy from ${entry ? dateTime(entry.deletedAt) : ''} goes now instead of at the end of the 14 days. It cannot be restored afterwards.`}
    >
      <ConfirmField id="trash-confirm" expected={entry?.domain ?? ''} value={typed} onChange={setTyped} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="soft" onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={typed !== entry?.domain || busy} onClick={() => void remove()}>
          {busy ? <Spinner /> : <Trash2 />}
          Delete for good
        </Button>
      </div>
    </Dialog>
  );
}

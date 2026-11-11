import type { JobView, Site } from '@devmagic-panel/shared';
import { siteRepos } from '@devmagic-panel/shared';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { navigate } from '@/lib/router';
import { loadThroughRestart } from '@/lib/startup';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

export function RemoveDialog({ site, open, onClose }: { site: Site; open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = useAsync(() => (open ? api.removal(site.domain) : Promise.resolve(null)), [open, site.domain]);
  const items = [
    `The folder ${site.docroot}`,
    'Its vhost and certificate',
    site.db ? `Database ${site.db.name}${site.panelMade ? ' and its user' : ''}` : null,
    site.panelMade ? 'Its /etc/hosts line' : null,
  ].filter(Boolean) as string[];
  // Work that exists only in this copy: it is in the archive, but worth a look before removing.
  const unsaved = siteRepos(site).flatMap(({ git: g, label }) => {
    const where = label === 'Site' ? 'the site' : label;
    return [
      g.dirty > 0 ? `${g.dirty} uncommitted change${g.dirty === 1 ? '' : 's'} in ${where}` : null,
      g.upstream === null ? `branch ${g.branch} in ${where} is not pushed` : g.ahead > 0 ? `${g.ahead} commit${g.ahead === 1 ? '' : 's'} in ${where} not pushed` : null,
    ].filter(Boolean) as string[];
  });
  const days = info.data?.trashDays ?? 14;
  const tight = info.data?.sizeBytes !== undefined && info.data.freeBytes !== undefined && info.data.freeBytes < info.data.sizeBytes * 1.2;

  // Follow the removal until it settles; then go back to the list.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') {
      if (job?.status === 'done') {
        toast({ tone: 'success', title: `${site.domain} removed`, detail: `It is kept in Removed sites for ${days} days, to restore.`, action: { label: 'Show', run: () => navigate('/sites?show=removed') } });
        navigate('/sites');
      }
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      loadThroughRestart(() => api.job(job.id), { stopped: () => !live }).then(
        (view) => live && setJob(view),
        (err: Error) => live && setError(err.message),
      );
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [job, site.domain, days]);

  async function remove() {
    setError(null);
    try {
      setJob(await api.job(await api.removeSite(site.domain)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function retry() {
    if (!job) return;
    try {
      setJob(await api.retryJob(job.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const running = job?.status === 'running';
  const failed = job?.steps.find((s) => s.status === 'failed');

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (running) return;
        setTyped('');
        onClose();
      }}
      title={`Remove ${site.domain}?`}
      description={`Everything below is archived first and kept in Removed sites, on the Sites page, for ${days} days, where you can restore it. Then it is removed:`}
    >
      {!job ? (
        <>
          <ul className="grid gap-1 text-sm">
            {items.map((item) => (
              <li key={item} className="flex items-start gap-2"><Trash2 className="mt-0.5 size-3.5 shrink-0 text-danger" />{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {info.data?.sizeBytes !== undefined ? `The archive takes about ${bytes(info.data.sizeBytes)} before compression` : 'Measuring the folder...'}
            {info.data?.freeBytes !== undefined ? `; ${bytes(info.data.freeBytes)} free.` : '.'}
            {!site.panelMade && ' Made outside the panel: hosts lines outside the panel\'s block stay as they are.'}
          </p>
          {tight && <p role="alert" className="mt-2 text-sm text-danger">There may not be enough free disk space for the archive.</p>}
          {unsaved.length > 0 && (
            <Notice tone="warning" size="inline" icon={false} className="mt-3 text-sm">
              <p className="font-medium">Work that is only in this copy</p>
              <ul className="mt-1 list-disc pl-5 text-xs">{unsaved.map((u) => <li key={u}>{u}</li>)}</ul>
              <p className="mt-1 text-xs text-muted-foreground">It stays in the archive, but push it first if you can.</p>
            </Notice>
          )}
          <ConfirmField className="mt-4" id="confirm-domain" expected={site.domain} value={typed} onChange={setTyped} />
        </>
      ) : (
        <ol className="grid gap-1.5 text-sm">
          {job.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              {s.status === 'running' ? <Spinner className="size-4 text-primary" /> : s.status === 'done' ? <Check className="size-4 text-success" /> : s.status === 'failed' ? <X className="size-4 text-danger" /> : <span className="size-4 rounded-full border-2 border-muted-foreground/30" />}
              <span className={cn(s.status === 'pending' && 'text-muted-foreground', s.status === 'failed' && 'text-danger')}>{s.label}</span>
            </li>
          ))}
        </ol>
      )}
      {failed?.output && <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-danger">{lastLine(failed.output)}</pre>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        {!running && (
          <Button variant="soft" onClick={() => { setTyped(''); setJob(null); onClose(); }}>
            {job ? 'Close' : 'Cancel'}
          </Button>
        )}
        {!job && (
          <Button variant="danger" disabled={typed !== site.domain} onClick={() => void remove()}>
            <Trash2 />
            Archive and remove
          </Button>
        )}
        {job?.status === 'failed' && (
          <Button onClick={() => void retry()}>
            <RefreshCw />
            Retry from the failed step
          </Button>
        )}
      </div>
    </Dialog>
  );
}

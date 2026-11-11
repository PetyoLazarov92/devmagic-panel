import type { Site, TakeoverPreview } from '@devmagic-panel/shared';
import { FileCode2, Hand, ShieldCheck, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JobFooter } from '@/features/jobs/job-box';
import { useJob } from '@/features/jobs/job-steps';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { KeyValue } from '@/components/ui/key-value';
import { Notice } from '@/components/ui/notice';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { useQueryParam } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';

/**
 * A site made by hand: the panel leaves its vhost as it is, so domains,
 * nginx and sites under a path are not changed from here. Taking it over
 * gives it the panel's vhost (same names, folder and paths; the originals
 * kept), and Give back puts its own back. A site taken over says so, and when.
 */
export function TakeoverCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const takenOver = site.install?.takenOver;
  // ?takeover=1 in the address, from a hint elsewhere, opens the dialog at once.
  const asked = useQueryParam('takeover') === '1';
  const [open, setOpen] = useState<'take' | 'give' | null>(asked && !takenOver && !site.vhostManaged && !site.path ? 'take' : null);
  const job = useJob();
  useEffect(() => {
    if (job.job?.status === 'done') onChanged();
  }, [job.job?.status]);
  if (site.path || (site.vhostManaged && !takenOver)) return null;
  return (
    <Card id="takeover">
      <CardHeader title={takenOver ? 'Taken over' : 'Made by hand'} meta={<Hand className="size-4 text-muted-foreground" />} />
      <CardBody className="gap-3">
        {takenOver ? (
          <>
            <p>
              Made by hand, managed by the panel since {shortDate(takenOver.at)}.
              {takenOver.dropped > 0 && ` ${takenOver.dropped} line${takenOver.dropped === 1 ? '' : 's'} of its vhost were left out; the kept copy has them.`}
            </p>
            <p className="text-xs text-muted-foreground">Give back puts its own vhost ({takenOver.files.join(', ')}) back in place of the panel's, and its own lines in /etc/hosts where they were. The site and its certificate stay.</p>
            {site.server !== 'apache' ? (
              <>
                <Button variant="outline" className="w-fit" disabled><Undo2 />Give back</Button>
                <p className="text-xs text-muted-foreground">
                  It runs on {site.server === 'nginx' ? 'nginx' : 'nginx in front of Apache'}, and its own vhost is for Apache alone: move it back to Apache on{' '}
                  <TextLink href={`${siteHref(site)}?tab=php`}>Server and PHP</TextLink> first, then give it back.
                </p>
              </>
            ) : (
              <Button variant="outline" className="w-fit" onClick={() => setOpen('give')}><Undo2 />Give back</Button>
            )}
          </>
        ) : (
          <>
            <p>Its vhost was set up outside the panel, so the panel leaves it as it is: its domains, its web server (nginx), sites under a path on it and its removal to the trash are not done from here.</p>
            <p className="text-xs text-muted-foreground">Take it over to manage it like the panel's own sites. Its vhost files are kept, to give back any time; nothing in the site's folder changes.</p>
            <Button className="w-fit" onClick={() => setOpen('take')}><ShieldCheck />Take over...</Button>
          </>
        )}
      </CardBody>
      <JobFooter job={job.job} error={job.error} onRetry={() => void job.retry()} />
      {open === 'take' && <TakeOverDialog site={site} onClose={() => setOpen(null)} onStart={(input) => { setOpen(null); void job.follow(api.startJob('site.takeOver', input)); }} />}
      {open === 'give' && <GiveBackDialog site={site} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onChanged(); }} />}
    </Card>
  );
}

function TakeOverDialog({ site, onClose, onStart }: { site: Site; onClose: () => void; onStart: (input: Record<string, unknown>) => void }) {
  const [preview, setPreview] = useState<TakeoverPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    api.takeoverPreview(site.domain).then(setPreview, (err: Error) => setError(err.message));
  }, [site.domain]);
  const blocked = !preview || preview.problems.length > 0 || (preview.extra.length > 0 && !drop) || confirm !== site.domain;
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      closeOnBackdrop={false}
      title={`Take over ${site.domain}?`}
      description="The panel writes its own vhost with the same names, folder and sites under a path, issues the certificate from its CA and puts the hosts line in its block. Its own vhost files are kept, to give back; Undo on the job does that too."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={blocked} onClick={() => onStart({ domain: site.domain, confirm, dropLines: drop })}><ShieldCheck />Take over</Button>
        </>
      }
    >
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!preview && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Reading its vhost...</p>}
      {preview && (
        <div className="grid gap-4 text-sm">
          {preview.problems.length > 0 && (
            <Notice tone="danger" size="inline" className="text-sm">
              <div className="grid gap-1">
                <p className="font-medium">It cannot be taken over now</p>
                <ul className="list-disc pl-5 text-muted-foreground">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            </Notice>
          )}
          <KeyValue
            labelWidth="md"
            className="gap-y-2"
            rows={[
              { label: 'Its vhost files', value: <span className="font-mono text-dense">{preview.files.join(', ') || 'none'}</span> },
              { label: 'Names', value: <span className="font-mono text-dense">{preview.names.join(' ') || 'none'}</span> },
              { label: 'Folder', value: <span className="font-mono text-dense">{preview.docroot ?? 'not usable'}<span className="font-sans text-xs text-muted-foreground"> (stays where it is)</span></span> },
              ...(preview.mounts.length > 0 ? [{ label: 'Sites under a path', value: <span className="font-mono text-dense">{preview.mounts.map((m) => m.replace('=', ' from ')).join(', ')}</span> }] : []),
            ]}
          />
          {preview.extra.length > 0 && (
            <Notice tone="warning" size="inline" icon={false} className="py-2.5 text-sm">
              <div className="grid gap-2">
                <p className="flex items-center gap-2 font-medium"><FileCode2 className="size-4 text-warning" />Lines the panel's vhost does not have ({preview.extra.length})</p>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{preview.extra.join('\n')}</pre>
                <p className="text-xs text-muted-foreground">PHP settings (php_value) can go into the site's own PHP settings on its PHP tab afterwards; rewrite rules into its .htaccess.</p>
                <Checkbox id="drop-lines" checked={drop} onChange={setDrop} label="Leave these lines out; they stay in the kept files" />
              </div>
            </Notice>
          )}
          {preview.hostsLines.length > 0 && (
            <div className="grid gap-1.5 rounded-lg border px-3 py-2.5">
              <p className="font-medium">Its line{preview.hostsLines.length === 1 ? '' : 's'} in /etc/hosts</p>
              <pre className="overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{preview.hostsLines.join('\n')}</pre>
              <p className="text-xs text-muted-foreground">Written by hand outside the panel's block: {preview.hostsLines.length === 1 ? 'it moves' : 'they move'} into the takeover record, so the panel's line decides where the site goes and it can move to nginx. Give back puts {preview.hostsLines.length === 1 ? 'it' : 'them'} back where {preview.hostsLines.length === 1 ? 'it was' : 'they were'}.</p>
            </div>
          )}
          {preview.hostsShared.length > 0 && (
            <Notice tone="warning" size="inline" icon={false} className="py-2.5 text-sm">
              <div className="grid gap-1.5">
                <p className="font-medium">A line in /etc/hosts it shares</p>
                <pre className="overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{preview.hostsShared.join('\n')}</pre>
                <p className="text-xs text-muted-foreground">It names other hosts too, so it stays as it is, and the site stays on Apache until you take {site.domain} off it by hand.</p>
              </div>
            </Notice>
          )}
          {preview.problems.length === 0 && <ConfirmField id="takeover-confirm" expected={site.domain} value={confirm} onChange={setConfirm} />}
        </div>
      )}
    </Dialog>
  );
}

function GiveBackDialog({ site, onClose, onDone }: { site: Site; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runAction('site.giveBack', { domain: site.domain, confirm });
      if (!r.ok) throw new Error(r.output.trim().split('\n').at(-1) || 'It was not given back');
      toast({ tone: 'success', title: `${site.domain} has its own vhost again` });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Give ${site.domain} its own vhost back?`} description="Its vhost files from before the takeover go back in place of the panel's, checked against their checksums. The site, its certificate and its hosts line stay; the panel leaves its vhost as it is again.">
      <div className="grid gap-3">
        <ConfirmField id="giveback-confirm" expected={site.domain} value={confirm} onChange={setConfirm} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || confirm !== site.domain} onClick={() => void go()}>
            {busy && <Spinner />}
            Give back
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

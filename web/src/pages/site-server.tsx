import type { Site } from '@devmagic-panel/shared';
import { ArrowLeftRight, LoaderCircle, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { toast } from '@/lib/toast';

const LABEL = { apache: 'Apache', nginx: 'nginx' } as const;

/**
 * The web server a site runs on, on its Domains and SSL tab, and the move to
 * the other one (site.setServer). Both answer on ports 80 and 443, each on
 * its own address; the hosts line decides, so nothing is proxied.
 */
export function ServerCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const job = useJob();
  const done = useRef<string | null>(null);
  const busy = job.job !== null && !settled(job.job);
  useEffect(() => {
    if (!job.job || !settled(job.job) || done.current === job.job.id) return;
    done.current = job.job.id;
    if (job.job.status === 'done') toast({ tone: 'success', title: `${job.job.title}: done` });
    onChanged();
  }, [job.job, onChanged]);

  const move = site.move;
  const target = site.server === 'nginx' ? 'apache' : 'nginx';
  const ignored = site.server === 'apache' ? (move?.ignored ?? []) : [];
  const refusal = move?.refusal;
  const start = () => {
    setOpen(false);
    void job.follow(api.startJob('site.setServer', { domain: site.domain, server: target, acceptIgnored: accepted }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Web server</CardTitle>
        <Server className="size-4 text-muted-foreground" />
      </CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="grid gap-1">
            <p className="flex items-center gap-2">
              <Badge tone={site.server === 'nginx' ? 'primary' : 'neutral'}>{LABEL[site.server]}</Badge>
              <span className="text-muted-foreground">
                {site.server === 'nginx'
                  ? `PHP through PHP-FPM${move?.php ? ` ${move.php}` : ''}; .htaccess is not read`
                  : 'with .htaccess, as most WordPress hosts run it'}
              </span>
            </p>
            {refusal && <p className="text-xs text-muted-foreground">{refusal}{/set it up on Services, nginx/.test(refusal) && <> (<Link href="/services/nginx" className="text-primary hover:underline">open nginx</Link>)</>}.</p>}
          </div>
          <Button variant="outline" disabled={busy || Boolean(refusal)} onClick={() => { setAccepted(false); setOpen(true); }}>
            {busy ? <LoaderCircle className="animate-spin" /> : <ArrowLeftRight />}
            Move to {LABEL[target]}
          </Button>
        </div>
        {(job.job || job.error) && (
          <div className="grid gap-3">
            {job.job && <JobBox job={job.job} onRetry={() => void job.retry()} />}
            {job.error && <p role="alert" className="text-danger">{job.error}</p>}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Move ${site.domain} to ${LABEL[target]}?`}
        description={
          target === 'nginx'
            ? `The panel writes the site's nginx file with WordPress's rules, runs its PHP through PHP-FPM${move?.php ? ` ${move.php}` : ''}, points its hosts line at nginx, checks it answers, then removes the Apache vhost. Its folder, database and certificate stay. Undo on the job moves it back.`
            : 'The panel writes the Apache vhost again, takes the site off nginx, points its hosts line at Apache and checks it answers. Undo on the job moves it back to nginx.'
        }
      >
        <div className="grid gap-4 text-sm">
          {ignored.length > 0 && (
            <div className="grid gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2">
              <p className="flex gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                nginx does not read .htaccess. These rules in it would do nothing there:
              </p>
              <ul className="list-disc pl-9 text-muted-foreground">
                {ignored.map((name) => <li key={name}>{name}</li>)}
              </ul>
              <Checkbox id="server-accept-ignored" checked={accepted} onChange={setAccepted} label="Move it anyway; I know these rules do nothing on nginx" />
            </div>
          )}
          <p className="text-xs text-muted-foreground">A browser may keep the old server for up to a minute; reload the page if it does.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={ignored.length > 0 && !accepted} onClick={start}>Move to {LABEL[target]}</Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

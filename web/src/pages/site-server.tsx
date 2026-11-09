import { SITE_SERVER_LABEL, SITE_SERVERS, type Site, type SiteServer } from '@devmagic-panel/shared';
import { ArrowLeftRight, Info, LoaderCircle, Server, TriangleAlert } from 'lucide-react';
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
import { useAsync } from '@/lib/use-async';
import { HtaccessReview, reviewedSums, ruleCounts } from '@/pages/site-htaccess';
import { cn } from '@/lib/utils';

/** The badge tone of each web server: both nginx modes stand out from plain Apache. */
export const SERVER_TONE: Record<SiteServer, 'neutral' | 'primary'> = { apache: 'neutral', 'nginx-apache': 'primary', nginx: 'primary' };

/** One line on what each web server means for the site, and the hosts it is like. */
const ABOUT: Record<SiteServer, { what: string; like: string }> = {
  apache: { what: 'Apache answers and reads every .htaccess.', like: 'Like most shared hosts.' },
  'nginx-apache': { what: 'nginx answers and passes requests to Apache, which still reads every .htaccess.', like: 'Like hosts that put nginx in front of Apache.' },
  nginx: { what: 'nginx answers and runs PHP through PHP-FPM. The fastest; .htaccess is not read.', like: 'Like hosts that run nginx only.' },
};

/** What the site runs on now, in one line under the badge. */
function currentLine(site: Site): string {
  const front = site.move?.front;
  if (site.server === 'nginx') return `PHP through PHP-FPM${site.move?.php ? ` ${site.move.php}` : ''}; .htaccess is not read`;
  if (site.server === 'apache') return 'Reads .htaccess, as most WordPress hosts run it';
  if (front?.static === false) return 'Every request goes through Apache, which reads .htaccess';
  const folders = front?.apachePaths.length ?? 0;
  return `nginx serves images, CSS, JS and fonts; the rest goes to Apache, which reads .htaccess${folders ? ` (and ${folders} folder${folders === 1 ? '' : 's'} with ${folders === 1 ? 'its' : 'their'} own)` : ''}`;
}

/** What the move does, step by step, for the dialog. */
function moveText(from: SiteServer, to: SiteServer, php: string | undefined): string {
  const fpm = `PHP-FPM${php ? ` ${php}` : ''}`;
  if (from === to) return 'The panel writes the nginx file again with these settings, checks nginx accepts it, reloads nginx and checks the site answers.';
  if (to === 'nginx') {
    return `The panel writes the site's nginx file with WordPress's rules, runs its PHP through ${fpm}, points its hosts line at nginx, checks it answers, then removes the Apache vhost. Its folder, database and certificate stay. Undo on the job moves it back.`;
  }
  if (to === 'nginx-apache') {
    return `${from === 'nginx' ? 'The panel writes the Apache vhost again, then puts' : 'The panel puts'} nginx in front of it: nginx answers with the site's certificate and passes requests to Apache over HTTPS, the hosts line points at nginx, and the site is checked. PHP runs as it does on Apache. Undo on the job moves it back.`;
  }
  return from === 'nginx'
    ? 'The panel writes the Apache vhost again, takes the site off nginx, points its hosts line at Apache and checks it answers. Undo on the job moves it back to nginx.'
    : 'The panel takes nginx out from in front of Apache and points the hosts line back at Apache, which answers as it did. Undo on the job puts nginx back.';
}

/**
 * The web server a site runs on, first on its Server and PHP tab, and the
 * move to another (site.setServer): Apache, nginx in front of Apache, or nginx
 * with PHP-FPM. Apache and nginx answer on ports 80 and 443, each on its own
 * address; the hosts line decides which one gets the site.
 */
export function ServerCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<SiteServer>(site.server);
  const [staticFiles, setStaticFiles] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [skip, setSkip] = useState<string[]>([]);
  // Moving to nginx alone: the .htaccess rules as the panel would translate them, read when the dialog opens.
  const reviewing = open && target === 'nginx' && site.server !== 'nginx';
  const htaccess = useAsync(() => (reviewing ? api.htaccess(site.domain) : Promise.resolve(null)), [reviewing, site.domain]);
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
  const refusals = move?.refusals ?? {};
  const front = move?.front;
  const report = reviewing ? (htaccess.data ?? null) : null;
  const left = report ? ruleCounts(report).manual + ruleCounts(report).php : 0;
  const staticRules = target === 'nginx-apache' && staticFiles ? (front?.staticRules ?? []) : [];
  const anyOpen = SITE_SERVERS.some((s) => s !== site.server && !refusals[s]) || site.server === 'nginx-apache';
  // The same server: only nginx in front of Apache has settings to change.
  const unchanged = target === site.server && (target !== 'nginx-apache' || staticFiles === (front?.static ?? true));
  const blocked = Boolean(target !== site.server && refusals[target]) || unchanged || (reviewing && (!report || (left > 0 && !accepted)));
  const nginxRefusal = refusals.nginx ?? refusals['nginx-apache'];

  const openDialog = () => {
    setTarget(site.server);
    setStaticFiles(front?.static ?? true);
    setAccepted(false);
    setSkip([]);
    setOpen(true);
  };
  const start = () => {
    setOpen(false);
    void job.follow(
      api.startJob('site.setServer', {
        domain: site.domain,
        server: target,
        static: staticFiles,
        acceptIgnored: accepted,
        ...(report ? { htaccess: { sums: reviewedSums(report), skip } } : {}),
      }),
    );
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
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={SERVER_TONE[site.server]}>{SITE_SERVER_LABEL[site.server]}</Badge>
              <span className="text-muted-foreground">{currentLine(site)}</span>
            </p>
            {!anyOpen && nginxRefusal && (
              <p className="text-xs text-muted-foreground">
                {nginxRefusal}
                {/set it up on Services, nginx/.test(nginxRefusal) && <> (<Link href="/services/nginx" className="text-primary hover:underline">open nginx</Link>)</>}.
              </p>
            )}
          </div>
          <Button variant="outline" disabled={busy || !anyOpen} onClick={openDialog}>
            {busy ? <LoaderCircle className="animate-spin" /> : <ArrowLeftRight />}
            Change
          </Button>
        </div>
        {(job.job || job.error) && (
          <div className="grid gap-3">
            {job.job && <JobBox job={job.job} onRetry={() => void job.retry()} />}
            {job.error && <p role="alert" className="text-danger">{job.error}</p>}
          </div>
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Web server for ${site.domain}`} description="Pick the setup the site runs on in production, so it behaves the same here." size="lg">
        <div className="grid gap-4 text-sm">
          <fieldset className="grid gap-2 md:grid-cols-3">
            <legend className="sr-only">Web server</legend>
            {SITE_SERVERS.map((server) => {
              const why = server === site.server ? undefined : refusals[server];
              return (
                <label
                  key={server}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3',
                    target === server && 'border-primary/50 bg-primary/5',
                    why && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input type="radio" name="site-server" checked={target === server} disabled={Boolean(why)} onChange={() => setTarget(server)} className="accent-[var(--primary)]" />
                    <span className="font-medium">{SITE_SERVER_LABEL[server]}</span>
                    {server === site.server && <Badge>Now</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{server === 'nginx' && move?.php ? ABOUT.nginx.what.replace('PHP-FPM', `PHP-FPM ${move.php}`) : ABOUT[server].what}</span>
                  <span className="text-xs text-muted-foreground">{ABOUT[server].like}</span>
                  {why && <span className="text-xs text-warning">{why}</span>}
                </label>
              );
            })}
          </fieldset>

          {target === 'nginx-apache' && (
            <div className="grid gap-2 rounded-lg border px-3 py-2.5">
              <Checkbox
                id="server-static"
                checked={staticFiles}
                onChange={setStaticFiles}
                label="nginx serves images, CSS, JS and fonts itself"
                hint={
                  front?.apachePaths.length
                    ? `Faster. These folders have an .htaccess of their own and still go to Apache: ${front.apachePaths.join(', ')}.`
                    : 'Faster. A file that is missing still goes to Apache, and so would a folder with an .htaccess of its own.'
                }
              />
              {staticRules.length > 0 && (
                <div className="grid gap-1.5 rounded-md border border-warning/30 bg-warning/8 px-3 py-2">
                  <p className="flex gap-2 text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    These .htaccess rules would not run for the files nginx serves:
                  </p>
                  <ul className="list-disc pl-9 text-xs text-muted-foreground">
                    {staticRules.map((rule) => <li key={rule}><code>{rule}</code></li>)}
                  </ul>
                  <p className="pl-6 text-xs text-muted-foreground">Untick it to send every request through Apache, so they all run.</p>
                </div>
              )}
            </div>
          )}

          {reviewing && (
            <div className="grid gap-3 rounded-lg border px-3 py-2.5">
              <p className="font-medium">.htaccess rules on nginx</p>
              <p className="text-xs text-muted-foreground">nginx reads no .htaccess. The panel writes the translated rules into the site&apos;s nginx file; untick one to leave it out.</p>
              {htaccess.loading && !report && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Reading the .htaccess files</p>}
              {htaccess.error && <p role="alert" className="text-xs text-danger">{htaccess.error}</p>}
              {report && <div className="max-h-80 overflow-y-auto pr-1"><HtaccessReview report={report} skip={skip} onSkip={setSkip} /></div>}
              {report && left > 0 && (
                <div className="grid gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2">
                  <p className="flex gap-2 text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    {left} rule{left === 1 ? '' : 's'} would do nothing on nginx (not translated, or PHP settings for the PHP tab).
                  </p>
                  {!refusals['nginx-apache'] && <p className="pl-6 text-xs text-muted-foreground">To keep every rule working with nginx, pick nginx + Apache instead.</p>}
                  <Checkbox id="server-accept-ignored" checked={accepted} onChange={setAccepted} label="Move it anyway; I know those rules do nothing on nginx" />
                </div>
              )}
            </div>
          )}

          {!unchanged && (
            <p className="flex gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{moveText(site.server, target, move?.php)} A browser may keep the old server for up to a minute; reload the page if it does.</span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={blocked} onClick={start}>
              {target === site.server ? 'Save' : `Move to ${SITE_SERVER_LABEL[target]}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

import type { NginxConfig, NginxReport } from '@devmagic-panel/shared';
import { ArrowRightLeft, Check, Copy, FileCode2, LoaderCircle, Power, RefreshCw, ScrollText, Server, Split, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { LogView } from '@/components/log-view';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { runRestarting } from '@/lib/restarting';
import { toast } from '@/lib/toast';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { CardsSkeleton, LogSkeleton } from '@/components/skeletons';
import { Notice } from '@/components/page';

type ConfigFilter = 'all' | 'enabled' | 'managed';
const FILTERS: Array<{ value: ConfigFilter; label: string; test: (c: NginxConfig) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'enabled', label: 'Enabled', test: (c) => c.enabled },
  { value: 'managed', label: "The panel's", test: (c) => c.managed },
];

const INSTALL_COMMAND = 'sudo apt install nginx';

/**
 * The Services page's nginx tab: nginx next to Apache, each on its own
 * address on ports 80 and 443. Setting it up and turning it off are jobs
 * (Apache restarts, and every site is checked afterwards); the rest is
 * nginx -t, Reload, the configs in sites-available and nginx's error log.
 */
export function NginxTab({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const report = useAsync(() => api.nginx(), [refresh]);
  const installed = report.data?.installed ?? false;
  const log = useAsync(() => (installed ? api.nginxLog() : Promise.resolve(null)), [refresh, installed]);
  const job = useJob();
  const jobDone = useRef<string | null>(null);
  const jobBusy = job.job !== null && !settled(job.job);
  useEffect(() => onLoading(report.loading), [report.loading, onLoading]);
  useEffect(() => {
    if (!job.job || !settled(job.job) || jobDone.current === job.job.id) return;
    jobDone.current = job.job.id;
    if (job.job.status === 'done') toast({ tone: 'success', title: `${job.job.title}: done` });
    report.reload();
  }, [job.job, report.reload]);

  const data = report.data;
  if (report.loading && !data) return <CardsSkeleton reading="Reading nginx's setup and configs..." cards={[{ lines: 3, wide: true }, 4, 5, { lines: 6, wide: true }, { lines: 6, wide: true }]} />;
  if (report.error) return <Notice>{report.error}</Notice>;
  if (!data) return null;

  const start = (id: 'nginx.setup' | 'nginx.teardown') => void job.follow(api.startJob(id, {}));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
      <SetupCard report={data} busy={jobBusy} onStart={start}>
        {(job.job || job.error) && (
          <div className="grid gap-3 text-sm">
            {job.job && <JobBox job={job.job} onRetry={() => void job.retry()} />}
            {job.error && <p role="alert" className="text-danger">{job.error}</p>}
          </div>
        )}
      </SetupCard>

      {data.setUp && <SitesCard key={job.job?.status ?? 'none'} busy={jobBusy} onStart={(server, acceptIgnored) => void job.follow(api.startJob('sites.setServerAll', { server, acceptIgnored }))} />}

      {data.installed && (
        <>
          <ConfigtestCard report={data} onReloaded={report.reload} />
          <GlanceCard report={data} />
          <ConfigsCard report={data} />
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Error log</CardTitle><ScrollText className="size-4 text-muted-foreground" /></CardHeader>
            <div className="grid gap-3 p-5">
              <p className="font-mono text-xs break-all text-muted-foreground">{log.data?.file ?? data.errorLog}</p>
              {log.data && !log.data.exists && <p className="text-sm text-muted-foreground">The log file does not exist, or the panel cannot read it.</p>}
              {log.error && <p role="alert" className="text-sm text-danger">{log.error}</p>}
              {log.loading && !log.data ? <LogSkeleton /> : <LogView lines={log.data?.lines ?? []} />}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** nginx next to Apache: how to install it, what setting it up does, and the way back. */
function SetupCard({ report, busy, onStart, children }: { report: NginxReport; busy: boolean; onStart: (id: 'nginx.setup' | 'nginx.teardown') => void; children?: ReactNode }) {
  const [confirm, setConfirm] = useState<'nginx.setup' | 'nginx.teardown' | null>(null);
  const [copied, setCopied] = useState(false);
  const { nginx, apache } = report.addresses;
  const conflicts = report.configs.filter((c) => c.conflict);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>nginx next to Apache</CardTitle>
        {report.setUp ? <Badge tone="success">Set up</Badge> : report.installed ? <Badge tone="warning">Not set up</Badge> : <Split className="size-4 text-muted-foreground" />}
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        {!report.installed && (
          <>
            <p>
              nginx is not installed. Both servers can run side by side on ports 80 and 443, each on its own address: Apache on <code className="font-mono">{apache}</code>, nginx on <code className="font-mono">{nginx}</code>. Install it once in a terminal (sudo asks for your password), then check again and set it up here. It does not start while Apache holds port 80.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">{INSTALL_COMMAND}</code>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => setCopied(true))}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </>
        )}

        {report.installed && !report.setUp && (
          <>
            <p>Setting nginx up runs it next to Apache, both on ports 80 and 443:</p>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>Apache moves from every address to <code className="font-mono">{apache}</code>, and nginx answers on <code className="font-mono">{nginx}</code>. A site goes to the server its line in the hosts file points at.</li>
              <li>Every site, the panel and phpMyAdmin stay on Apache, and the panel checks each site answers afterwards.</li>
              <li>Debian&apos;s default nginx site goes off: it listens on every address, where Apache is.</li>
              <li>Other devices on your network no longer reach Apache: it answers on this computer only.</li>
            </ul>
          </>
        )}

        {report.setUp && (
          <p>
            nginx answers on <code className="font-mono">{nginx}</code> and Apache on <code className="font-mono">{apache}</code>, both on ports 80 and 443. A site moves to nginx, and back, on its Domains and SSL tab. Turning nginx off, once every site is back on Apache, puts Apache back on every address and stops nginx; it stays installed.
          </p>
        )}

        {conflicts.length > 0 && (
          <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>
              {conflicts.map((c) => `${c.file} ${c.conflict}`).join('; ')}. Make {conflicts.length === 1 ? 'it' : 'them'} listen on <code className="font-mono">{nginx}</code>, or turn {conflicts.length === 1 ? 'it' : 'them'} off, before nginx can run next to Apache.
            </p>
          </div>
        )}

        {report.installed && (
          <div className="flex flex-wrap gap-2">
            {!report.setUp && (
              <Button disabled={busy || conflicts.length > 0} onClick={() => setConfirm('nginx.setup')}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Power />}
                Set up nginx
              </Button>
            )}
            {report.setUp && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => onStart('nginx.setup')} title="Writes the panel's nginx settings again, as after an update">
                  {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                  Write settings again
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm('nginx.teardown')}>
                  <Power />
                  Turn nginx off
                </Button>
              </>
            )}
          </div>
        )}
        {children}
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'nginx.setup' ? 'Set nginx up next to Apache?' : 'Turn nginx off?'}
        description={
          confirm === 'nginx.setup'
            ? `Apache restarts on ${apache} and nginx starts on ${nginx}. The panel drops for a moment while Apache restarts, then checks every site answers. Undo on the job turns nginx off again.`
            : 'Apache restarts on every address and nginx stops. The panel drops for a moment, then checks every site answers. Undo on the job sets nginx up again.'
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            onClick={() => {
              const id = confirm;
              setConfirm(null);
              if (id) onStart(id);
            }}
          >
            {confirm === 'nginx.setup' ? 'Set up nginx' : 'Turn nginx off'}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function ConfigtestCard({ report, onReloaded }: { report: NginxReport; onReloaded: () => void }) {
  const [reloading, setReloading] = useState(false);
  const test = report.configtest;
  return (
    <Card>
      <CardHeader><CardTitle>Configuration</CardTitle><Server className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        <p className="flex items-center gap-2">
          <StatusDot status={test.ok === null ? 'warn' : test.ok ? 'ok' : 'fail'} />
          <span className="font-medium">{test.ok === null ? 'nginx -t could not run' : test.ok ? 'nginx -t passes' : 'nginx -t fails'}</span>
          <span className="text-xs text-muted-foreground">· {timeAgo(report.checkedAt)}</span>
        </p>
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{test.output}</pre>
        {test.ok === null && /unknown command/.test(test.output) && <p className="text-xs text-muted-foreground">The root scripts are older than this panel: run install.sh again, or install the update from the Updates page.</p>}
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={reloading || test.ok === false || report.server.state !== 'running'}
            title={test.ok === false ? 'Fix the configuration first: nginx only reloads after nginx -t passes' : report.server.state !== 'running' ? 'nginx is not running' : undefined}
            onClick={() => {
              setReloading(true);
              void runRestarting('nginx.reload', {}, 'nginx reloaded', () => {
                setReloading(false);
                onReloaded();
              });
            }}
          >
            {reloading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Reload nginx
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** How long nginx has run: up 12 minutes, up 5 hours, up 3 days. */
function upFor(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `up ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `up ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `up ${Math.floor(hours / 24)} days`;
}

function GlanceCard({ report }: { report: NginxReport }) {
  const { server } = report;
  const enabled = report.configs.filter((c) => c.enabled).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>nginx</CardTitle>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={server.state === 'running' ? 'ok' : report.setUp ? 'fail' : 'warn'} />
          {server.state === 'missing' ? 'not installed' : server.state}
          {server.since && ` · ${upFor(server.since)}`}
        </span>
      </CardHeader>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-5 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd>{server.version ?? 'unknown'}</dd>
        <dt className="text-muted-foreground">nginx on</dt>
        <dd>{report.setUp ? <code className="font-mono text-[13px]">{report.addresses.nginx}:80, :443</code> : 'not set up'}</dd>
        <dt className="text-muted-foreground">Apache on</dt>
        <dd>{report.setUp ? <code className="font-mono text-[13px]">{report.addresses.apache}:80, :443</code> : 'every address'}</dd>
        <dt className="text-muted-foreground">PHP</dt>
        <dd>through PHP-FPM only</dd>
        <dt className="text-muted-foreground">Configs</dt>
        <dd>{report.configs.length} in sites-available, {enabled} enabled</dd>
      </dl>
    </Card>
  );
}

function ConfigsCard({ report }: { report: NginxReport }) {
  const [filter, setFilter] = useState<ConfigFilter>('all');
  const shown = report.configs.filter(FILTERS.find((f) => f.value === filter)?.test ?? (() => true));
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>Configs</CardTitle><FileCode2 className="size-4 text-muted-foreground" /></CardHeader>
      <div className="flex flex-wrap gap-1.5 px-5 pt-4" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
          >
            {f.label} <span className="tabular-nums">{report.configs.filter(f.test).length}</span>
          </button>
        ))}
      </div>
      <ul className="mt-2 divide-y">
        {shown.map((c) => (
          <li key={c.file} className="grid gap-1 px-5 py-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.names[0] ?? c.file}</span>
              <Badge tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'Enabled' : 'Not enabled'}</Badge>
              <Badge tone={c.managed ? 'primary' : 'neutral'}>{c.managed ? "The panel's" : 'By hand'}</Badge>
              {c.conflict && <Badge tone="warning">{c.conflict}</Badge>}
            </p>
            <p className="text-xs break-words text-muted-foreground">
              <span className="font-mono">{c.file}</span>
              {c.names.length > 1 && <> · also {c.names.slice(1).join(', ')}</>}
              {c.listens.length > 0 && <> · listens on <span className="font-mono">{c.listens.join(', ')}</span></>}
            </p>
          </li>
        ))}
        {shown.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No configs here.</li>}
      </ul>
    </Card>
  );
}

/**
 * Sites on nginx and on Apache, the default web server for new sites, and
 * moving every site that can at once (sites.setServerAll): a job, each site
 * checked as it moves, Undo moves every site back.
 */
function SitesCard({ busy, onStart }: { busy: boolean; onStart: (server: 'apache' | 'nginx', acceptIgnored: boolean) => void }) {
  const sites = useAsync(() => api.sites(), []);
  const { newSiteServer } = usePreferences();
  const [confirm, setConfirm] = useState<'apache' | 'nginx' | null>(null);
  const [accepted, setAccepted] = useState(false);
  const own = (sites.data ?? []).filter((s) => !s.path);
  const on = (server: 'apache' | 'nginx') => own.filter((s) => s.server === server);
  // What a move of every site to one server does to each site there is not yet.
  const plan = (server: 'apache' | 'nginx') => {
    const candidates = own.filter((s) => s.server !== server);
    const stay = candidates.filter((s) => s.move?.refusal).map((s) => ({ site: s, why: s.move?.refusal as string }));
    const ignored = candidates.filter((s) => !s.move?.refusal && server === 'nginx' && (s.move?.ignored.length ?? 0) > 0);
    const move = candidates.filter((s) => !s.move?.refusal && !ignored.includes(s));
    return { stay, ignored, move };
  };
  const current = confirm ? plan(confirm) : null;
  const moving = current ? current.move.length + (accepted ? current.ignored.length : 0) : 0;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Sites</CardTitle>
        <span className="text-xs text-muted-foreground">{sites.data ? `${on('nginx').length} on nginx, ${on('apache').length} on Apache` : 'reading'}</span>
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium">New sites</legend>
          <div className="flex flex-wrap gap-4">
            {(['apache', 'nginx'] as const).map((server) => (
              <label key={server} className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="new-site-server" checked={newSiteServer === server} onChange={() => savePreferences({ newSiteServer: server })} className="accent-[var(--primary)]" />
                {server === 'nginx' ? 'nginx' : 'Apache'}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">What the new site wizard picks; you can pick the other one there. A site under a path runs on its parent&apos;s server.</p>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !sites.data || plan('nginx').move.length + plan('nginx').ignored.length === 0} onClick={() => { setAccepted(false); setConfirm('nginx'); }}>
            <ArrowRightLeft />
            Move every site to nginx
          </Button>
          <Button variant="outline" disabled={busy || !sites.data || on('nginx').length === 0} onClick={() => { setAccepted(false); setConfirm('apache'); }}>
            <ArrowRightLeft />
            Move every site to Apache
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">One site moves at a time, on its Domains and SSL tab.</p>
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'nginx' ? 'Move every site to nginx?' : 'Move every site to Apache?'}
        description="Each site moves as it does from its Domains and SSL tab, one after the other, and is checked before the next. Undo on the job moves every site back."
      >
        {current && (
          <div className="grid gap-3 text-sm">
            {current.move.length > 0 && <p>Moving: {current.move.map((s) => s.domain).join(', ')}</p>}
            {current.ignored.length > 0 && (
              <div className="grid gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2">
                <p className="text-warning">nginx would not read the .htaccess rules of {current.ignored.map((s) => `${s.domain} (${s.move?.ignored.join(', ')})`).join('; ')}.</p>
                <Checkbox id="move-all-accept" checked={accepted} onChange={setAccepted} label="Move these too; I know those rules do nothing on nginx" />
              </div>
            )}
            {current.stay.length > 0 && (
              <div className="grid gap-1 text-muted-foreground">
                <p>Staying where they are:</p>
                <ul className="list-disc pl-5 text-xs">
                  {current.stay.map(({ site, why }) => <li key={site.domain}>{site.domain}: {why}</li>)}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                disabled={moving === 0}
                onClick={() => {
                  const server = confirm;
                  setConfirm(null);
                  if (server) onStart(server, accepted);
                }}
              >
                Move {moving} site{moving === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

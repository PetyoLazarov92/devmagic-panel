import type { ApacheModule, ApacheReport, ApacheVhost } from '@devmagic-panel/shared';
import { FileCode2, Lock, LoaderCircle, Puzzle, RefreshCw, ScrollText, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogView } from '@/components/log-view';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { shortDate, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { runRestarting } from '@/lib/restarting';
import { CardsSkeleton, LogSkeleton } from '@/components/skeletons';

type VhostFilter = 'all' | 'enabled' | 'disabled' | 'managed';
const FILTERS: Array<{ value: VhostFilter; label: string; test: (v: ApacheVhost) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'enabled', label: 'Enabled', test: (v) => v.enabled },
  { value: 'disabled', label: 'Not enabled', test: (v) => !v.enabled },
  { value: 'managed', label: "The panel's", test: (v) => v.managed },
];

function certNote(expiresAt: string, now = Date.now()): { text: string; tone: string } {
  const days = Math.floor((new Date(expiresAt).getTime() - now) / 86_400_000);
  if (days < 0) return { text: `certificate ran out ${shortDate(expiresAt)}`, tone: 'text-danger' };
  if (days < 30) return { text: `certificate runs out ${shortDate(expiresAt)}`, tone: 'text-warning' };
  return { text: `certificate until ${shortDate(expiresAt)}`, tone: '' };
}

/**
 * The Services page's Apache tab, read only but for Reload: the configtest,
 * the enabled modules, every vhost file in sites-available, and Apache's own
 * error log.
 */
export function ApacheTab({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const report = useAsync(() => api.apache(), [refresh]);
  const log = useAsync(() => api.apacheLog(), [refresh]);
  const [filter, setFilter] = useState<VhostFilter>('all');
  const [reloading, setReloading] = useState(false);
  useEffect(() => onLoading(report.loading), [report.loading, onLoading]);

  const data = report.data;
  if (report.loading && !data) return <CardsSkeleton reading="Reading Apache's configuration and vhosts..." cards={[4, 4, 5, 3]} />;
  if (report.error) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{report.error}</p>;
  if (!data) return null;

  const shown = data.vhosts.filter(FILTERS.find((f) => f.value === filter)?.test ?? (() => true));
  const test = data.configtest;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Configuration</CardTitle><Server className="size-4 text-muted-foreground" /></CardHeader>
        <div className="grid gap-3 p-5 text-sm">
          <p className="flex items-center gap-2">
            <StatusDot status={test.ok === null ? 'warn' : test.ok ? 'ok' : 'fail'} />
            <span className="font-medium">{test.ok === null ? 'configtest could not run' : test.ok ? 'configtest passes' : 'configtest fails'}</span>
            <span className="text-xs text-muted-foreground">· {timeAgo(data.checkedAt)}</span>
          </p>
          <pre className="max-h-40 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{test.output}</pre>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={reloading || test.ok === false}
              title={test.ok === false ? 'Fix the configuration first: Apache only reloads after its configtest passes' : undefined}
              onClick={() => {
                setReloading(true);
                void runRestarting('apache.reload', {}, 'Apache reloaded', () => {
                  setReloading(false);
                  report.reload();
                });
              }}
            >
              {reloading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Reload Apache
            </Button>
          </div>
        </div>
      </Card>

      <GlanceCard report={data} />

      <ModulesCard modules={data.modules} onChanged={report.reload} />

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Vhosts</CardTitle><FileCode2 className="size-4 text-muted-foreground" /></CardHeader>
        <div className="flex flex-wrap gap-1.5 px-5 pt-4" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
            >
              {f.label} <span className="tabular-nums">{data.vhosts.filter(f.test).length}</span>
            </button>
          ))}
        </div>
        <ul className="mt-2 divide-y">
          {shown.map((v) => {
            const cert = v.certExpiresAt ? certNote(v.certExpiresAt) : null;
            return (
              <li key={v.file} className="grid gap-1 px-5 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  {v.site ? (
                    <Link href={`/sites/${encodeURIComponent(v.site)}`} className="font-medium hover:underline">{v.names[0]}</Link>
                  ) : (
                    <span className="font-medium">{v.names[0] ?? v.file}</span>
                  )}
                  <Badge tone={v.enabled ? 'success' : 'neutral'}>{v.enabled ? 'Enabled' : 'Not enabled'}</Badge>
                  <Badge tone={v.managed ? 'primary' : 'neutral'}>{v.managed ? "The panel's" : 'By hand'}</Badge>
                </p>
                <p className="text-xs break-words text-muted-foreground">
                  <span className="font-mono">{v.file}</span>
                  {v.names.length > 1 && <> · also {v.names.slice(1).join(', ')}</>}
                  {v.docroot && <> · <span className="font-mono">{v.docroot}</span></>}
                  {v.mounts.length > 0 && <> · serves {v.mounts.join(', ')}</>}
                  {cert && <> · <span className={cert.tone}>{cert.text}</span></>}
                </p>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No vhosts here.</li>}
        </ul>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Error log</CardTitle><ScrollText className="size-4 text-muted-foreground" /></CardHeader>
        <div className="grid gap-3 p-5">
          <p className="font-mono text-xs break-all text-muted-foreground">{log.data?.file ?? data.errorLog}</p>
          {log.data && !log.data.exists && <p className="text-sm text-muted-foreground">The log file does not exist, or the panel cannot read it.</p>}
          {log.error && <p role="alert" className="text-sm text-danger">{log.error}</p>}
          {log.loading && !log.data ? <LogSkeleton /> : <LogView lines={log.data?.lines ?? []} />}
        </div>
      </Card>
    </div>
  );
}

/** How long Apache has run: up 12 minutes, up 5 hours, up 3 days. */
function upFor(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `up ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `up ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `up ${Math.floor(hours / 24)} days`;
}

/** Apache at a glance: what you would otherwise look up in a terminal. */
function GlanceCard({ report }: { report: ApacheReport }) {
  const { server } = report;
  const enabled = report.vhosts.filter((v) => v.enabled).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apache</CardTitle>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={server.state === 'running' ? 'ok' : server.state === 'stopped' ? 'fail' : 'warn'} />
          {server.state === 'missing' ? 'not installed' : server.state}
          {server.since && ` · ${upFor(server.since)}`}
        </span>
      </CardHeader>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-5 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd>{server.version ?? 'unknown'}</dd>
        <dt className="text-muted-foreground">Workers</dt>
        <dd>{server.mpm ? <><span className="font-mono text-[13px]">{server.mpm}</span>{server.php && server.mpm === 'mpm_prefork' && <span className="text-xs text-muted-foreground"> · mod_php needs it</span>}</> : 'unknown'}</dd>
        <dt className="text-muted-foreground">PHP</dt>
        <dd>{server.php ? `mod_php ${server.php}` : 'not loaded'}</dd>
        <dt className="text-muted-foreground">Listens on</dt>
        <dd>{server.ports.length ? server.ports.join(', ') : 'unknown'}</dd>
        <dt className="text-muted-foreground">Sites</dt>
        <dd>{report.vhosts.length} vhosts, {enabled} enabled</dd>
      </dl>
    </Card>
  );
}

type ModuleFilter = 'all' | 'on' | 'off';

/** Every module in mods-available with a switch, as PHP modules have; the ones the panel keeps as they are show why. */
function ModulesCard({ modules, onChanged }: { modules: ApacheModule[]; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModuleFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const on = modules.filter((m) => m.enabled).length;
  const count = (f: ModuleFilter) => modules.filter((m) => f === 'all' || m.enabled === (f === 'on')).length;
  const shown = modules.filter((m) => (filter === 'all' || m.enabled === (filter === 'on')) && m.name.includes(query.trim().toLowerCase()));

  function toggle(m: ApacheModule, enabled: boolean) {
    setBusy(m.name);
    void runRestarting('apache.setModule', { module: m.name, enabled }, `${m.name} ${enabled ? 'on' : 'off'}`, () => {
      setBusy(null);
      onChanged();
    });
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Apache modules</CardTitle>
        {modules.length > 0 ? <span className="text-xs text-muted-foreground">{on} of {modules.length} on</span> : <Puzzle className="size-4 text-muted-foreground" />}
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        {modules.length === 0 ? (
          <p className="text-muted-foreground">No modules found in mods-available.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="min-w-0 flex-[1_1_20rem] text-xs text-muted-foreground">
                Every module in mods-available. A switch runs <code className="font-mono">a2enmod</code> or <code className="font-mono">a2dismod</code> and a configtest; when the configtest fails the change is taken back. Then Apache restarts.
              </p>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <div className="flex gap-1.5" role="group" aria-label="Show">
                  {(['all', 'on', 'off'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                      className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
                    >
                      {f === 'all' ? 'All' : f === 'on' ? 'On' : 'Off'} <span className="tabular-nums">{count(f)}</span>
                    </button>
                  ))}
                </div>
                <Input aria-label="Filter modules" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full sm:w-44" />
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="text-muted-foreground">No module matches {query}.</p>
            ) : (
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((m) => (
                  <li key={m.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <div className="min-w-0">
                      <code className="font-mono text-[13px]">{m.name}</code>
                      {m.locked && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Lock className="size-3 shrink-0" />
                          {m.locked}
                        </p>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {busy === m.name && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
                      <Switch
                        checked={m.enabled}
                        label={m.locked ? `${m.name} (${m.locked.toLowerCase()}, stays ${m.enabled ? 'on' : 'off'})` : m.name}
                        disabled={busy !== null || Boolean(m.locked)}
                        onChange={(enabled) => toggle(m, enabled)}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

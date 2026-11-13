import type { ApacheModule, ApacheReport, ApacheVhost } from '@devmagic-panel/shared';
import { isLocalName } from '@devmagic-panel/shared';
import { ExternalLink, FileCode2, Lock, Puzzle, RefreshCw, ScrollText, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogView } from '@/components/layout/log-view';
import { siteUrl, StatusDot } from '@/components/layout/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { FilterChips } from '@/components/ui/filter-chips';
import { KeyValue } from '@/components/ui/key-value';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { shortDate, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { runRestarting } from '@/lib/restarting';
import { CardsSkeleton, LogSkeleton } from '@/components/layout/skeletons';
import { Notice } from '@/components/layout/page';
import { Spinner } from '@/components/ui/spinner';

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
  if (report.loading && !data) return <CardsSkeleton reading="Reading Apache's configuration and vhosts..." cards={[4, 5, { lines: 8, wide: true }, { lines: 6, wide: true }]} />;
  if (report.error) return <Notice>{report.error}</Notice>;
  if (!data) return null;

  const shown = data.vhosts.filter(FILTERS.find((f) => f.value === filter)?.test ?? (() => true));
  const test = data.configtest;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Configuration" meta={<Server className="size-4 text-muted-foreground" />} />
        <CardBody className="gap-3">
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
              {reloading ? <Spinner /> : <RefreshCw />}
              Reload Apache
            </Button>
          </div>
        </CardBody>
      </Card>

      <GlanceCard report={data} />

      <ModulesCard modules={data.modules} onChanged={report.reload} />

      <Card className="lg:col-span-2">
        <CardHeader title="Vhosts" meta={<FileCode2 className="size-4 text-muted-foreground" />} />
        <FilterChips
          label="Show"
          value={filter}
          onChange={setFilter}
          className="px-5 pt-4"
          options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: data.vhosts.filter(f.test).length }))}
        />
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
                  {v.enabled && v.names[0] && isLocalName(v.names[0]) && (
                    <a href={siteUrl(v.names[0])} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" title={`Open ${v.names[0]}`} aria-label={`Open ${v.names[0]}`}>
                      <ExternalLink className="size-3.5" />
                    </a>
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
        <CardHeader title="Error log" meta={<ScrollText className="size-4 text-muted-foreground" />} />
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
      <CardHeader
        title="Apache"
        meta={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={server.state === 'running' ? 'ok' : server.state === 'stopped' ? 'fail' : 'warn'} />
            {server.state === 'missing' ? 'not installed' : server.state}
            {server.since && ` · ${upFor(server.since)}`}
          </span>
        }
      />
      <CardBody>
        <KeyValue
          labelWidth="sm"
          rows={[
            { label: 'Version', value: server.version ?? 'unknown' },
            { label: 'Workers', value: server.mpm ? <><span className="font-mono text-dense">{server.mpm}</span>{server.php && server.mpm === 'mpm_prefork' && <span className="text-xs text-muted-foreground"> · mod_php needs it</span>}</> : 'unknown' },
            { label: 'PHP', value: server.php ? `mod_php ${server.php}` : 'not loaded' },
            { label: 'Listens on', value: server.ports.length ? server.ports.join(', ') : 'unknown' },
            { label: 'Sites', value: `${report.vhosts.length} vhosts, ${enabled} enabled` },
          ]}
        />
      </CardBody>
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
      <CardHeader title="Apache modules" meta={modules.length > 0 ? <span className="text-xs text-muted-foreground">{on} of {modules.length} on</span> : <Puzzle className="size-4 text-muted-foreground" />} />
      <CardBody>
        {modules.length === 0 ? (
          <p className="text-muted-foreground">No modules found in mods-available.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="min-w-0 flex-[1_1_20rem] text-xs text-muted-foreground">
                Every module in mods-available. A switch runs <code className="font-mono">a2enmod</code> or <code className="font-mono">a2dismod</code> and a configtest; when the configtest fails the change is taken back. Then Apache restarts.
              </p>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <FilterChips
                  label="Show"
                  value={filter}
                  onChange={setFilter}
                  options={(['all', 'on', 'off'] as const).map((f) => ({ value: f, label: f === 'all' ? 'All' : f === 'on' ? 'On' : 'Off', count: count(f) }))}
                />
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
                      <code className="font-mono text-dense">{m.name}</code>
                      {m.locked && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Lock className="size-3 shrink-0" />
                          {m.locked}
                        </p>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {busy === m.name && <Spinner className="size-4 text-muted-foreground" />}
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
      </CardBody>
    </Card>
  );
}

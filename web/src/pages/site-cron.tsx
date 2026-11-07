import type { Site, WpCronEvent, WpCronReport } from '@devmagic-panel/shared';
import { CalendarClock, LoaderCircle, Play, Search, Stethoscope, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ScopeLabel } from '@/components/scope-label';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { runWithToast } from '@/lib/site-actions';
import { siteName, siteTarget } from '@/lib/site-ref';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { runCronChange, TaskList, type UndoOf } from '@/pages/services-cron';
import { CardsSkeleton } from '@/components/skeletons';

type EventFilter = 'all' | 'site' | 'core';
const FILTERS: Array<{ value: EventFilter; label: string; test: (e: WpCronEvent) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'site', label: 'From plugins and the theme', test: (e) => !e.core },
  { value: 'core', label: "WordPress's own", test: (e) => e.core },
];

const at = (time: number) => new Date(time * 1000).toISOString();
const every = (seconds: number) => (seconds % 86400 === 0 ? `${seconds / 86400} day${seconds === 86400 ? '' : 's'}` : seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);
const argsText = (args: unknown[]) => (args.length ? JSON.stringify(args) : '');

/**
 * A site's Cron tab: how its WP-Cron runs (page loads or cron), its
 * scheduled events with Run now and Delete, its intervals, and the panel's
 * cron tasks for it.
 */
export function CronTab({ site, report, onReload }: { site: Site; report: { data: WpCronReport | null | undefined; error: string | null; loading: boolean }; onReload: (url?: string) => void }) {
  const [url, setUrl] = useState<string | undefined>(report.data?.url);
  const [filter, setFilter] = useState<EventFilter>('all');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<WpCronEvent | null>(null);
  const target = { ...siteTarget(site), ...(url ? { url } : {}) };
  const data = report.data;

  if (report.loading && !data) return <CardsSkeleton reading="Reading the site's scheduled events with WP-CLI..." cards={[6]} columns={1} />;
  if (report.error && !data) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{report.error}</p>;
  if (!data) return null;

  const q = query.trim().toLowerCase();
  const events = data.events.filter((e) => FILTERS.find((f) => f.value === filter)?.test(e) ?? true).filter((e) => !q || e.hook.toLowerCase().includes(q) || argsText(e.args).toLowerCase().includes(q));
  const pick = (next: string) => {
    const value = next || undefined;
    setUrl(value);
    onReload(value);
  };

  return (
    <div className="grid gap-4">
      {site.network && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Events of</span>
          <Select aria-label="Network site" value={url ?? ''} onChange={(e) => pick(e.target.value)} wrapClassName="min-w-64">
            <option value="">the main site</option>
            {site.network.sites.map((s) => <option key={s.id} value={s.url}>{s.url}{s.title ? ` (${s.title})` : ''}</option>)}
          </Select>
        </div>
      )}

      <HowItRuns site={site} data={data} url={url} onChanged={() => onReload(url)} />

      <Card>
        <CardHeader><CardTitle>Scheduled events</CardTitle><ScopeLabel>{url ?? 'this site'}</ScopeLabel></CardHeader>
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <div className="relative min-w-0 flex-[1_1_14rem]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search events" className="pl-9" placeholder="Search hooks and arguments" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
              >
                {f.label} <span className="tabular-nums">{data.events.filter(f.test).length}</span>
              </button>
            ))}
          </div>
        </div>
        {data.overdue > 0 && (
          <p className="mx-5 mt-3 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
            {data.overdue} event{data.overdue === 1 ? ' is' : 's are'} more than 10 minutes late.{' '}
            {data.task?.enabled
              ? 'The cron task that runs WP-Cron here may be failing or late: its last run above says more.'
              : data.disabled
                ? 'DISABLE_WP_CRON is true and nothing of the panel runs WP-Cron: turn on Run WP-Cron from cron above.'
                : 'Page loads start WP-Cron, so a site nobody opened falls behind; if it is open, Check WP-Cron above says why it does not start.'}
          </p>
        )}
        <ul className="mt-3 divide-y border-t">
          {events.map((e) => (
            <li key={`${e.time}-${e.hook}-${e.sig}`} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
              <div className="grid min-w-0 flex-[1_1_18rem] gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium break-all">{e.hook}</span>
                  {e.core && <Badge>WordPress</Badge>}
                </p>
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span title={dateTime(at(e.time))} className={cn('inline-flex items-center gap-1', e.overdue && 'font-medium text-warning')}>
                    <CalendarClock className="size-3.5" />
                    {e.overdue ? `late: was due ${timeAgo(at(e.time))}` : `next ${timeAgo(at(e.time))}`}
                  </span>
                  <span>{e.recurrence ? `${data.schedules.find((s) => s.name === e.recurrence)?.display ?? e.recurrence}${e.interval ? ` (every ${every(e.interval)})` : ''}` : 'once'}</span>
                </p>
                {e.args.length > 0 && <ArgsLine args={e.args} />}
              </div>
              <Menu
                label={`Actions for ${e.hook}`}
                items={[
                  { label: 'Run now', icon: <Play className="size-4" />, onSelect: () => void runWithToast('wpcron.run', { ...target, hook: e.hook }, `Ran ${e.hook}`).then(() => onReload(url)) },
                  { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setDeleting(e) },
                ]}
              />
            </li>
          ))}
          {events.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">{data.events.length === 0 ? 'No events are scheduled.' : 'No event matches.'}</li>}
        </ul>
      </Card>

      <Card>
        <CardHeader><CardTitle>The panel&apos;s cron tasks for this site</CardTitle><ScopeLabel>your crontab</ScopeLabel></CardHeader>
        <p className="px-5 pt-3 text-xs text-muted-foreground">
          Commands cron runs for {siteName(site)}, besides WP-Cron. <Link href="/services/cron" className="font-medium text-foreground hover:underline">Services, Cron</Link> lists every task.
        </p>
        <TaskList tasks={data.tasks} site={siteTarget(site)} onChanged={() => onReload(url)} empty="None. Add a WP-CLI command (like action-scheduler run) or a PHP file of the site." />
      </Card>

      <Card>
        <CardHeader><CardTitle>Intervals</CardTitle><ScopeLabel>this site</ScopeLabel></CardHeader>
        <p className="px-5 pt-3 text-xs text-muted-foreground">The recurrences WordPress and the site&apos;s plugins define. Read only.</p>
        <ul className="mt-2 grid gap-x-6 px-5 pb-4 text-sm sm:grid-cols-2">
          {data.schedules.map((s) => (
            <li key={s.name} className="flex justify-between gap-3 border-b py-1.5">
              <span><span className="font-mono text-xs">{s.name}</span> <span className="text-muted-foreground">{s.display}</span></span>
              <span className="text-xs text-muted-foreground tabular-nums">{every(s.interval)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete the event ${deleting?.hook ?? ''}?`}
        description={`Only this one, ${deleting ? (deleting.overdue ? 'late' : `next ${timeAgo(at(deleting.time))}`) : ''}${deleting?.args.length ? `, with ${argsText(deleting.args)}` : ''}. A plugin that schedules it may schedule it again. Undo in the notice puts it back.`}
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              const e = deleting;
              setDeleting(null);
              if (e) void runCronChange('wpcron.delete', { ...target, hook: e.hook, time: e.time, sig: e.sig }, `Deleted ${e.hook}`, () => onReload(url), (backup) => (backup ? { id: 'wpcron.undo', input: { ...target, backup } } : null));
            }}
          >
            Delete event
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function ArgsLine({ args }: { args: unknown[] }) {
  const [open, setOpen] = useState(false);
  const text = argsText(args);
  const long = text.length > 90;
  return (
    <p className="font-mono text-xs break-all text-muted-foreground">
      {open || !long ? text : `${text.slice(0, 90)}...`}
      {long && (
        <button type="button" className="ml-2 font-sans font-medium text-foreground hover:underline" onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'All of it'}</button>
      )}
    </p>
  );
}

/** Page loads or cron, the switch between them, and wp cron test. */
function HowItRuns({ site, data, url, onChanged }: { site: Site; data: WpCronReport; url: string | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; output: string } | null>(null);
  const fromCron = Boolean(data.task?.enabled);
  const last = data.task?.last;

  const flip = async (on: boolean) => {
    setBusy(true);
    // Undo takes back both: the task and DISABLE_WP_CRON. A constant that was true before stays; then only the task goes.
    const undo: UndoOf = (backup) => (on && data.disabled ? (backup ? { id: 'cron.undo', input: { backup } } : null) : { id: 'cron.setSiteWpCron', input: { ...siteTarget(site), fromCron: !on } });
    await runCronChange('cron.setSiteWpCron', { ...siteTarget(site), fromCron: on }, on ? 'WP-Cron runs from cron' : 'WP-Cron runs on page loads again', onChanged, undo);
    setBusy(false);
  };

  let state: { status: 'ok' | 'warn'; text: string };
  if (fromCron) state = { status: 'ok', text: `From cron: ${data.task?.describe.toLowerCase() ?? ''}` };
  else if (data.disabled) state = { status: 'warn', text: "Not at all: DISABLE_WP_CRON is true and no task of the panel runs it, so events only run when something else starts them" };
  else if (data.alternate) state = { status: 'ok', text: 'On page loads, through a redirect (ALTERNATE_WP_CRON)' };
  else state = { status: 'ok', text: 'On page loads, when someone opens the site' };

  return (
    <Card>
      <CardHeader><CardTitle>How WP-Cron runs here</CardTitle><ScopeLabel>this site</ScopeLabel></CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        <p className="flex items-center gap-2"><StatusDot status={state.status} />{state.text}</p>
        {last && (
          <p className="text-xs text-muted-foreground">
            Last run from cron {timeAgo(last.startedAt)}: {last.status === 'ok' ? 'ran well' : last.status}. <Link href="/services/cron" className="font-medium text-foreground hover:underline">History</Link>
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3">
          <Switch checked={fromCron} onChange={(on) => setConfirming(on)} label="Run WP-Cron from cron instead of page loads" disabled={busy} />
          <div className="grid min-w-0 flex-1 gap-1">
            <p className="font-medium">Run WP-Cron from cron instead of page loads</p>
            <p className="text-xs text-muted-foreground">
              Page loads run WP-Cron well while you work on a site. From cron, every 5 minutes, its events also run on a site nobody opens, when you test scheduled work. This adds a task to your crontab and sets DISABLE_WP_CRON in wp-config.php.
            </p>
            {data.configTracked && <p className="text-xs text-warning">wp-config.php is tracked by git here: the change to DISABLE_WP_CRON shows in git status.</p>}
          </div>
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                setTest(await api.wpCronTest(site.domain, site.path, url));
              } catch (error) {
                setTest({ ok: false, output: (error as Error).message });
              }
              setTesting(false);
            }}
          >
            {testing ? <LoaderCircle className="animate-spin" /> : <Stethoscope />}
            Check WP-Cron
          </Button>
          <span className="text-xs text-muted-foreground">Whether WordPress can start WP-Cron by itself, through its loopback request.</span>
        </div>
        {test && <p className={cn('rounded-lg border px-3 py-2 font-mono text-xs whitespace-pre-wrap', test.ok ? 'border-success/30 bg-success/8' : 'border-danger/30 bg-danger/8 text-danger')} role={test.ok ? 'status' : 'alert'}>{test.output || (test.ok ? 'WP-Cron can start.' : 'WP-Cron cannot start.')}</p>}
      </div>
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Run the WP-Cron of ${siteName(site)} from cron?` : `Run the WP-Cron of ${siteName(site)} on page loads again?`}
        description={
          confirming
            ? `A task runs its due events every 5 minutes, and DISABLE_WP_CRON goes into wp-config.php as true, so page loads stop running it.${data.configTracked ? ' wp-config.php is tracked by git, so git status shows the change.' : ''} Undo in the notice takes back both.`
            : 'The task leaves your crontab and DISABLE_WP_CRON leaves wp-config.php, so page loads run WP-Cron again.'
        }
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            onClick={() => {
              const on = confirming === true;
              setConfirming(null);
              void flip(on);
            }}
          >
            {confirming ? 'Run from cron' : 'Run on page loads'}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

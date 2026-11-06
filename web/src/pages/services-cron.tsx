import type { ActionId, CronReport, CronRunView, CronTask, CronTaskKind, CronTaskView, Site } from '@devmagic-panel/shared';
import { cronSchedule, cronTask, CRON_PRESETS, describeSchedule, nextRuns, WP_CLI_SCHEDULED } from '@devmagic-panel/shared';
import { CalendarClock, ChevronRight, History, LoaderCircle, Pencil, Play, Plus, Server, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { AnsiText } from '@/components/ansi-text';
import { JobBox } from '@/components/job-box';
import { useJob } from '@/components/job-steps';
import { SaveBar } from '@/components/save-bar';
import { ScopeLabel } from '@/components/scope-label';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { dateTime, duration, timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/output';
import { Link } from '@/lib/router';
import { siteHref } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';

/** What Undo runs for a change: by default the crontab as it was, from the copy saved before it. */
export type UndoOf = (backup: string | undefined) => { id: ActionId; input: Record<string, unknown> } | null;
const crontabUndo: UndoOf = (backup) => (backup ? { id: 'cron.undo', input: { backup } } : null);

/** Runs a cron change and offers Undo in its notice. Answers whether it went well. */
export async function runCronChange(id: ActionId, input: Record<string, unknown>, label: string, onDone: () => void, undo: UndoOf = crontabUndo): Promise<boolean> {
  try {
    const result = await api.runAction(id, input);
    if (!result.ok) {
      toast({ tone: 'danger', title: `${label} failed`, detail: lastLine(result.output) });
      onDone();
      return false;
    }
    const back = undo(result.data?.backup);
    toast({
      tone: 'success',
      title: label,
      ...(back
        ? {
            action: {
              label: 'Undo',
              run: () =>
                void api.runAction(back.id, back.input).then(
                  (r) => {
                    toast(r.ok ? { tone: 'success', title: 'Put back' } : { tone: 'danger', title: 'Undo failed', detail: lastLine(r.output) });
                    onDone();
                  },
                  (error: Error) => toast({ tone: 'danger', title: 'Undo failed', detail: error.message }),
                ),
            },
          }
        : {}),
    });
    onDone();
    return true;
  } catch (error) {
    toast({ tone: 'danger', title: `${label} failed`, detail: (error as Error).message });
    return false;
  }
}

const KIND_LABEL: Record<CronTaskKind, string> = {
  'wp-cron': 'WP-Cron',
  'wp-cli': 'WP-CLI',
  'php-script': 'PHP file',
  url: 'Local URL',
  program: 'Program',
};

/** What a task runs, in one line. */
export function taskSummary(task: CronTask): string {
  switch (task.kind) {
    case 'wp-cron':
      return 'wp cron event run --due-now';
    case 'wp-cli':
      return `wp ${task.command.join(' ')}`;
    case 'php-script':
      return `php ${task.file}`;
    case 'url':
      return task.url;
    case 'program':
      return [task.program, ...task.args.map((a) => (/[\s'"$]/.test(a) ? JSON.stringify(a) : a))].join(' ');
  }
}

const runTone = (run?: CronRunView) => (!run ? null : run.status === 'ok' ? 'ok' : run.status === 'failed' ? 'fail' : 'warn');
const RUN_WORD = { ok: 'ran well', failed: 'failed', skipped: 'skipped', running: 'running' } as const;

/** One task of the panel: what, when, its last run, the switch and its menu; History opens under it. */
function TaskRow({ task, showSite, busy, onToggle, onEdit, onRun, onRemove }: {
  task: CronTaskView;
  showSite: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onRun: () => void;
  onRemove: () => void;
}) {
  const [history, setHistory] = useState(false);
  const last = task.last;
  const tone = runTone(last);
  return (
    <li className="grid gap-2 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-[1_1_18rem] gap-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{task.title}</span>
            <Badge>{KIND_LABEL[task.task.kind]}</Badge>
            {showSite && task.site && (
              <Link href={`${siteHref(task.site)}?tab=cron`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">{task.site.domain}{task.site.path ?? ''}</Link>
            )}
            {!task.enabled && <Badge tone="neutral">Off</Badge>}
          </p>
          <p className="font-mono text-xs break-all text-muted-foreground">{taskSummary(task.task)}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span title={task.schedule} className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />{task.describe}</span>
            {task.next[0] && <span title={dateTime(task.next[0])}>next {timeAgo(task.next[0])}</span>}
            {last && tone && (
              <span className="inline-flex items-center gap-1.5" title={dateTime(last.startedAt)}>
                <StatusDot status={tone} />
                {RUN_WORD[last.status]} {timeAgo(last.startedAt)}
                {last.durationMs !== null && last.status !== 'skipped' && <> in {duration(last.durationMs)}</>}
                {last.status === 'failed' && last.exitCode !== null && <> (exit {last.exitCode})</>}
              </span>
            )}
            {!last && <span>has not run yet</span>}
          </p>
          {task.problem && <p className="text-xs text-warning">{task.problem}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={task.enabled} onChange={onToggle} label={`${task.title}: ${task.enabled ? 'on' : 'off'}`} disabled={busy} />
          <Menu
            label={`Actions for ${task.title}`}
            items={[
              { label: 'Run now', icon: <Play className="size-4" />, onSelect: onRun, disabled: busy },
              { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit, disabled: busy },
              { label: history ? 'Hide history' : 'History', icon: <History className="size-4" />, onSelect: () => setHistory((h) => !h) },
              { label: 'Remove', icon: <Trash2 className="size-4" />, danger: true, onSelect: onRemove, disabled: busy },
            ]}
          />
        </div>
      </div>
      {history && <RunHistory id={task.id} />}
    </li>
  );
}

/** A task's runs, newest first; a run opens to its output. */
function RunHistory({ id }: { id: string }) {
  const runs = useAsync(() => api.cronRuns(id), [id]);
  const [open, setOpen] = useState<number | null>(null);
  const output = useAsync(() => (open === null ? Promise.resolve(null) : api.cronRun(open)), [open]);
  if (runs.loading && !runs.data) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Reading the runs...</p>;
  if (runs.error) return <p role="alert" className="text-xs text-danger">{runs.error}</p>;
  const list = runs.data ?? [];
  if (list.length === 0) return <p className="text-xs text-muted-foreground">No runs kept yet. The panel keeps the last 100, and failed ones for 14 days.</p>;
  return (
    <div className="grid gap-2">
      <ol className="divide-y rounded-lg border">
        {list.slice(0, 30).map((run) => (
          <li key={run.id}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/60" aria-expanded={open === run.id} onClick={() => setOpen(open === run.id ? null : run.id)}>
              <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open === run.id ? 'rotate-90' : ''}`} />
              <StatusDot status={runTone(run) ?? 'warn'} />
              <span className="font-medium">{RUN_WORD[run.status]}</span>
              <span className="text-muted-foreground">{dateTime(run.startedAt)}</span>
              {run.durationMs !== null && run.status !== 'skipped' && <span className="text-muted-foreground">{duration(run.durationMs)}</span>}
              {run.trigger === 'manual' && <Badge>Run now</Badge>}
              {run.exitCode !== null && run.exitCode !== 0 && <span className="ml-auto text-danger">exit {run.exitCode}</span>}
            </button>
            {open === run.id && (
              <div className="px-3 pb-3">
                {output.loading && !output.data ? (
                  <p className="text-xs text-muted-foreground">Reading the output...</p>
                ) : output.data?.output ? (
                  <pre className="max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"><AnsiText text={output.data.output} /></pre>
                ) : (
                  <p className="text-xs text-muted-foreground">It printed nothing.</p>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void runCronChange('cron.clearRuns', { id }, 'History cleared', runs.reload, () => null)}
        >
          Clear this history
        </Button>
      </div>
    </div>
  );
}

interface FormState {
  title: string;
  kind: CronTaskKind;
  site: string;
  command: string;
  file: string;
  url: string;
  program: string;
  args: string;
  schedule: string;
  timeout: string;
}

const siteValue = (s: { domain: string; path?: string | undefined }) => `${s.domain}${s.path ?? ''}`;

function formFrom(task: CronTaskView | null, site?: { domain: string; path?: string }): FormState {
  const t = task?.task;
  return {
    title: task?.title ?? '',
    kind: t?.kind ?? 'wp-cron',
    site: t && 'domain' in t ? siteValue(t) : site ? siteValue(site) : '',
    command: t?.kind === 'wp-cli' ? t.command.join(' ') : '',
    file: t?.kind === 'php-script' ? t.file : '',
    url: t?.kind === 'url' ? t.url : '',
    program: t?.kind === 'program' ? t.program : '',
    args: t?.kind === 'program' ? t.args.join('\n') : '',
    schedule: task?.schedule ?? '*/5 * * * *',
    timeout: String(task?.timeoutMinutes ?? 10),
  };
}

/** The task the form describes, checked with the registry's schema; a string says what is wrong. */
function taskFrom(f: FormState, sites: Array<{ domain: string; path?: string }>): CronTask | string {
  const picked = sites.find((s) => siteValue(s) === f.site);
  const site = picked ? { domain: picked.domain, ...(picked.path ? { path: picked.path } : {}) } : null;
  let raw: unknown;
  if (f.kind === 'url') raw = { kind: 'url', url: f.url.trim() };
  else if (f.kind === 'program') raw = { kind: 'program', program: f.program.trim(), args: f.args.split('\n').filter((a) => a !== '') };
  else {
    if (!site) return 'Pick the site';
    if (f.kind === 'wp-cron') raw = { kind: 'wp-cron', ...site };
    else if (f.kind === 'wp-cli') raw = { kind: 'wp-cli', ...site, command: f.command.trim().replace(/^wp\s+/, '').split(/\s+/).filter(Boolean) };
    else raw = { kind: 'php-script', ...site, file: f.file.trim().replace(/^\/+/, '') };
  }
  const parsed = cronTask.safeParse(raw);
  return parsed.success ? parsed.data : (parsed.error.issues[0]?.message ?? 'Check the fields');
}

/**
 * Adds or changes a task of the panel. Inline, saved through the SaveBar;
 * with a site given, the task is for that site only.
 */
export function TaskForm({ task, site, onClose, onSaved }: { task: CronTaskView | null; site?: { domain: string; path?: string }; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [form, setForm] = useState<FormState>(() => formFrom(task, site));
  const [saving, setSaving] = useState(false);
  const all = useAsync(() => (site ? Promise.resolve([] as Site[]) : api.sites()), [site?.domain, site?.path]);
  const sites = site ? [site] : (all.data ?? []).filter((s) => s.core.kind !== 'none').map((s) => ({ domain: s.domain, ...(s.path ? { path: s.path } : {}) }));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const scheduleCheck = cronSchedule.safeParse(form.schedule);
  const scheduleError = scheduleCheck.success ? undefined : scheduleCheck.error.issues[0]?.message;
  const built = taskFrom(form, sites);
  const timeout = Number(form.timeout);
  const error = !form.title.trim()
    ? 'Give the task a name'
    : typeof built === 'string'
      ? built
      : scheduleError ?? (!Number.isInteger(timeout) || timeout < 1 || timeout > 60 ? 'The time limit is 1 to 60 minutes' : undefined);
  const preset = CRON_PRESETS.find((p) => p.schedule === form.schedule.trim().replace(/\s+/g, ' '));
  const siteBased = form.kind === 'wp-cron' || form.kind === 'wp-cli' || form.kind === 'php-script';

  // A new WP-Cron task names itself after its site until you name it.
  useEffect(() => {
    if (task || form.title) return;
    if (form.kind === 'wp-cron' && form.site) set('title', `WP-Cron for ${form.site}`);
  }, [form.kind, form.site, form.title, task]);

  async function save() {
    if (error || typeof built === 'string') return;
    setSaving(true);
    const input = { title: form.title.trim(), schedule: form.schedule.trim().replace(/\s+/g, ' '), task: built, enabled: task?.enabled ?? true, timeoutMinutes: timeout };
    const ok = await runCronChange(task ? 'cron.update' : 'cron.add', task ? { id: task.id, ...input } : input, task ? `Changed ${input.title}` : `Added ${input.title}`, onSaved);
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <div className="grid gap-4 border-b bg-muted/30 px-5 py-4">
      <p className="text-sm font-medium">{task ? `Change ${task.title}` : 'A new task'}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-title`}>
          <Input id={`${id}-title`} value={form.title} maxLength={80} onChange={(e) => set('title', e.target.value)} placeholder="Sync orders every night" />
        </Field>
        <Field label="What it runs" htmlFor={`${id}-kind`}>
          <Select id={`${id}-kind`} value={form.kind} onChange={(e) => set('kind', e.target.value as CronTaskKind)}>
            <option value="wp-cron">A site&apos;s WP-Cron (its due events)</option>
            <option value="wp-cli">A WP-CLI command on a site</option>
            <option value="php-script">A PHP file in a site</option>
            <option value="url">A local URL</option>
            <option value="program">Advanced: a program with arguments</option>
          </Select>
        </Field>
        {siteBased && !site && (
          <Field label="Site" htmlFor={`${id}-site`}>
            <Select id={`${id}-site`} value={form.site} onChange={(e) => set('site', e.target.value)}>
              <option value="">{all.loading ? 'Reading the sites...' : 'Pick a site'}</option>
              {sites.map((s) => <option key={siteValue(s)} value={siteValue(s)}>{siteValue(s)}</option>)}
            </Select>
          </Field>
        )}
        {form.kind === 'wp-cli' && (
          <Field
            label="WP-CLI command"
            htmlFor={`${id}-command`}
            className="sm:col-span-2"
            hint={
              <span className="flex flex-wrap items-center gap-1.5">
                One of these, or a command of the site&apos;s own (a plugin&apos;s or the theme&apos;s):
                {WP_CLI_SCHEDULED.map((c) => (
                  <button key={c.join(' ')} type="button" className="rounded-full border px-2 py-0.5 font-mono hover:bg-muted" onClick={() => set('command', `${c.join(' ')}${c[0] === 'cron' ? ' acme_hook' : c[0] === 'transient' ? ' --expired' : ''}`)}>
                    {c.join(' ')}
                  </button>
                ))}
              </span>
            }
          >
            <Input id={`${id}-command`} className="font-mono" value={form.command} onChange={(e) => set('command', e.target.value)} placeholder="action-scheduler run --batch-size=25" />
          </Field>
        )}
        {form.kind === 'php-script' && (
          <Field label="PHP file in the site" htmlFor={`${id}-file`} hint="Relative to the site's folder. It runs with the site's PHP on the command line." className="sm:col-span-2">
            <Input id={`${id}-file`} className="font-mono" value={form.file} onChange={(e) => set('file', e.target.value)} placeholder="wp-content/cron/sync-orders.php" />
          </Field>
        )}
        {form.kind === 'url' && (
          <Field label="Address" htmlFor={`${id}-url`} hint="On a local name only. curl opens it, trusting the panel's certificates." className="sm:col-span-2">
            <Input id={`${id}-url`} className="font-mono" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://local.acme.com/?acme-feed=refresh" />
          </Field>
        )}
        {form.kind === 'program' && (
          <>
            <Field label="Program" htmlFor={`${id}-program`} hint="Its full path. It runs as you, with no shell: no pipes, redirects or $VARIABLES. Put those in a script of your own." className="sm:col-span-2">
              <Input id={`${id}-program`} className="font-mono" value={form.program} onChange={(e) => set('program', e.target.value)} placeholder="/home/alex/bin/sync.sh" />
            </Field>
            <Field label="Arguments" htmlFor={`${id}-args`} hint="One per line, passed exactly as written." className="sm:col-span-2">
              <Textarea id={`${id}-args`} className="font-mono" rows={3} value={form.args} onChange={(e) => set('args', e.target.value)} />
            </Field>
          </>
        )}
        <Field label="When" htmlFor={`${id}-preset`}>
          <Select id={`${id}-preset`} value={preset?.schedule ?? 'custom'} onChange={(e) => e.target.value !== 'custom' && set('schedule', e.target.value)}>
            {CRON_PRESETS.map((p) => <option key={p.schedule} value={p.schedule}>{p.label}</option>)}
            <option value="custom">Custom</option>
          </Select>
        </Field>
        <Field
          label="Schedule"
          htmlFor={`${id}-schedule`}
          hint={scheduleError ? <span className="text-danger">{scheduleError}</span> : <ScheduleHint schedule={form.schedule} />}
        >
          <Input id={`${id}-schedule`} className="font-mono" value={form.schedule} onChange={(e) => set('schedule', e.target.value)} aria-invalid={Boolean(scheduleError)} />
        </Field>
        <Field label="Time limit, minutes" htmlFor={`${id}-timeout`} hint="A run that takes longer is stopped. A run never starts while the last one still runs.">
          <Input id={`${id}-timeout`} type="number" min={1} max={60} value={form.timeout} onChange={(e) => set('timeout', e.target.value)} />
        </Field>
      </div>
      <SaveBar
        changes={1}
        saving={saving}
        label={task ? 'Save task' : 'Add task'}
        error={error}
        note="Saved into the panel's block of your crontab; lines of your own stay as they are."
        onSave={() => void save()}
        onDiscard={onClose}
      />
    </div>
  );
}

/** The schedule in words and its next three runs. */
function ScheduleHint({ schedule }: { schedule: string }) {
  const next = nextRuns(schedule, new Date(), 3);
  return (
    <span>
      {describeSchedule(schedule)}
      {next.length > 0 && <>. Next: {next.map((d) => dateTime(d.toISOString())).join(', ')}</>}
    </span>
  );
}

/** Asks before a task goes; Undo is in the toast after. */
function RemoveTask({ task, onClose, onRemoved }: { task: CronTaskView | null; onClose: () => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={task !== null} onClose={onClose} title={`Remove the task ${task?.title ?? ''}?`} description="It leaves the panel's block of your crontab and stops running. Its run history stays 14 days. Undo in the notice puts it back.">
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            if (!task) return;
            setBusy(true);
            await runCronChange('cron.remove', { id: task.id }, `Removed ${task.title}`, onRemoved);
            setBusy(false);
            onClose();
          }}
        >
          {busy && <LoaderCircle className="animate-spin" />}
          Remove task
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * The panel's tasks with Add, the form, the job of a Run now at the top,
 * and a row each. With a site, only that site's tasks and new ones for it.
 */
export function TaskList({ tasks, site, onChanged, empty }: { tasks: CronTaskView[]; site?: { domain: string; path?: string }; onChanged: () => void; empty: ReactNode }) {
  const [editing, setEditing] = useState<CronTaskView | 'new' | null>(null);
  const [removing, setRemoving] = useState<CronTaskView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runner = useJob();
  const { job } = runner;
  const settledJob = job && job.status !== 'running' && job.status !== 'queued';
  useEffect(() => {
    if (settledJob) onChanged();
  }, [settledJob, onChanged]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
        <Button size="sm" variant="outline" disabled={editing !== null} onClick={() => setEditing('new')}><Plus />Add a task</Button>
      </div>
      {(job || runner.error) && (
        <div className="px-5 pt-4">
          {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
          {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
        </div>
      )}
      <ul className="mt-3 divide-y border-t">
        {editing === 'new' && <li><TaskForm task={null} {...(site ? { site } : {})} onClose={() => setEditing(null)} onSaved={onChanged} /></li>}
        {tasks.map((t) =>
          editing !== 'new' && editing?.id === t.id ? (
            <li key={t.id}><TaskForm task={t} {...(site ? { site } : {})} onClose={() => setEditing(null)} onSaved={onChanged} /></li>
          ) : (
            <TaskRow
              key={t.id}
              task={t}
              showSite={!site}
              busy={busy === t.id}
              onToggle={async (on) => {
                setBusy(t.id);
                await runCronChange('cron.setEnabled', { id: t.id, enabled: on }, `${t.title} is ${on ? 'on' : 'off'}`, onChanged);
                setBusy(null);
              }}
              onEdit={() => setEditing(t)}
              onRun={() => void runner.follow(api.startJob('cron.runNow', { id: t.id }))}
              onRemove={() => setRemoving(t)}
            />
          ),
        )}
        {tasks.length === 0 && editing !== 'new' && <li className="px-5 py-4 text-sm text-muted-foreground">{empty}</li>}
      </ul>
      <RemoveTask task={removing} onClose={() => setRemoving(null)} onRemoved={onChanged} />
    </>
  );
}

const DAEMON = { running: { status: 'ok', text: 'cron is running' }, stopped: { status: 'fail', text: 'cron is stopped: nothing here runs until it starts (sudo systemctl start cron)' }, missing: { status: 'warn', text: 'cron is not installed: sudo apt install cron' } } as const;

/** The Services page's Cron tab: cron itself, the panel's tasks, your own lines, and system cron read only. */
export function CronTab({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const report = useAsync(() => api.cron(), [refresh]);
  useEffect(() => onLoading(report.loading), [report.loading, onLoading]);
  const data = report.data;
  if (report.loading && !data) return <div className="h-64 animate-pulse rounded-xl border bg-card" />;
  if (report.error) return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{report.error}</p>;
  if (!data) return null;
  const daemon = DAEMON[data.daemon];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader><CardTitle>Cron</CardTitle><ScopeLabel>this computer</ScopeLabel></CardHeader>
        <div className="grid gap-2 p-5 text-sm">
          <p className="flex items-center gap-2"><StatusDot status={daemon.status} />{daemon.text}</p>
          <p className="text-muted-foreground">Schedules run in the time zone {data.timeZone}. Tasks of the panel run as you, through its runner: no shell, one run at a time, output kept.</p>
          {data.problems.map((p) => <p key={p} role="alert" className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-warning">{p}</p>)}
        </div>
      </Card>

      {data.allowed && (
        <Card>
          <CardHeader><CardTitle>The panel&apos;s tasks</CardTitle><ScopeLabel>your crontab</ScopeLabel></CardHeader>
          <TaskList tasks={data.tasks} onChanged={report.reload} empty="No tasks yet. Add one, or turn on Run WP-Cron from cron on a site's Cron tab." />
        </Card>
      )}

      <ReadOnlyCard title="Lines of your own" scope="your crontab" note="Written by hand with crontab -e. The panel shows them and never changes them.">
        {data.hand.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y">
            {data.hand.map((l) => (
              <li key={l.line} className="grid gap-1 px-5 py-3 text-sm">
                <p className="font-mono text-xs break-all">{l.command}</p>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span title={l.schedule} className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />{l.describe}</span>
                  {l.next[0] && <span title={dateTime(l.next[0])}>next {timeAgo(l.next[0])}</span>}
                  <span>line {l.line}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </ReadOnlyCard>

      {data.unreadable.length > 0 && (
        <ReadOnlyCard title="Lines in the panel's block it cannot read" scope="your crontab" note="Changed by hand since the panel wrote them. They stay as they are; fix or remove them with crontab -e.">
          <ul className="divide-y">{data.unreadable.map((l) => <li key={l} className="px-5 py-2 font-mono text-xs break-all">{l}</li>)}</ul>
        </ReadOnlyCard>
      )}

      <SystemCron system={data.system} />
    </div>
  );
}

function ReadOnlyCard({ title, scope, note, children }: { title: string; scope: string; note: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><ScopeLabel>{scope}</ScopeLabel></CardHeader>
      <p className="px-5 pt-3 text-xs text-muted-foreground">{note}</p>
      <div className="mt-2">{children}</div>
    </Card>
  );
}

/** /etc/crontab, /etc/cron.d, the cron.daily-style folders and systemd timers, read only and folded. */
function SystemCron({ system }: { system: CronReport['system'] }) {
  const count = system.files.reduce((n, f) => n + f.lines.length, 0) + system.timers.length;
  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform [details[open]_&]:rotate-90" />
          System cron and timers
          <span className="text-xs font-normal text-muted-foreground">{count} entries, read only</span>
          <Server className="ml-auto size-4 text-muted-foreground" />
        </summary>
        <div className="grid gap-5 border-t px-5 py-4 text-sm">
          <p className="text-xs text-muted-foreground">Run by root or system accounts. Writing them would let anything that runs as you become root, so the panel only shows them.</p>
          {system.files.map((f) => (
            <div key={f.file} className="grid gap-1.5">
              <p className="font-mono text-xs font-medium">{f.file}</p>
              {f.lines.length === 0 && <p className="text-xs text-muted-foreground">No entries.</p>}
              {f.lines.map((l, i) => (
                <p key={i} className="grid gap-0.5 text-xs">
                  <span className="font-mono break-all">{l.command}</span>
                  <span className="text-muted-foreground"><span title={l.schedule}>{l.describe}</span> · as {l.user}</span>
                </p>
              ))}
            </div>
          ))}
          {system.folders.map((f) => (
            <p key={f.folder} className="text-xs"><span className="font-mono font-medium">{f.folder}</span>: <span className="text-muted-foreground">{f.scripts.join(', ') || 'empty'}</span></p>
          ))}
          {system.timers.length > 0 && (
            <div className="grid gap-1.5">
              <p className="text-xs font-medium">systemd timers</p>
              <ul className="grid gap-1 text-xs">
                {system.timers.map((t) => (
                  <li key={t.unit} className="flex flex-wrap gap-x-3">
                    <span className="font-mono">{t.unit}</span>
                    <span className="text-muted-foreground">runs {t.activates}</span>
                    {t.next && <span className="text-muted-foreground" title={dateTime(t.next)}>next {timeAgo(t.next)}</span>}
                    {t.last && <span className="text-muted-foreground" title={dateTime(t.last)}>last {timeAgo(t.last)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

import { type DeveloperReport, RUN_KEEP_DAYS, RUN_KEEP_MAX } from '@devmagic-panel/shared';
import { Activity, FileText, FolderTree, History, LoaderCircle, RefreshCw, ScrollText, Settings2, Trash2, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AnsiText } from '@/components/ansi-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { PathTree } from '@/components/path-tree';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { setDeveloper } from '@/lib/developer';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link, navigate } from '@/lib/router';
import { runWithToast } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const UNINSTALL_TONE = { remove: 'neutral', ask: 'warning', keep: 'success' } as const;
const UNINSTALL_LABEL = { remove: 'removed', ask: 'asks you', keep: 'kept' } as const;

/** The hidden Developer options: what is installed where, and the logs to read when something went wrong. */
export function DeveloperPage() {
  const { data: report, error, loading, reload } = useAsync(() => api.developer(), []);

  function turnOff() {
    setDeveloper(false);
    toast({ tone: 'info', title: 'Developer options are off', detail: 'Tap the version seven times to turn them on again.' });
    navigate('/sites');
  }

  return (
    <div className="pt-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="text-2xl font-semibold tracking-tight">Developer options</h1>
          <p className="mt-1 text-sm text-muted-foreground">Versions, the installer's logs, and every file the panel put on this machine. For when something needs a closer look.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
            Check again
          </Button>
          <span className="flex items-center gap-2 text-sm">
            <Switch checked label="Developer options" onChange={(on) => !on && turnOff()} />
            On
          </span>
        </div>
      </div>

      {error && <p role="alert" className="mt-6 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{error}</p>}
      {!report && loading && <p className="mt-10 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Reading...</p>}

      {report && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Versions report={report} />
          <Settings report={report} />
          <Server report={report} />
          <Logs report={report} />
          <InstalledFiles report={report} />
          <PanelFiles report={report} />
          <RunHistory />
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Versions({ report }: { report: DeveloperReport }) {
  return (
    <Card>
      <CardHeader><CardTitle>Versions</CardTitle><Wrench className="size-4 text-muted-foreground" /></CardHeader>
      <dl className="grid gap-2 p-5 text-sm">
        <Row label="Panel">
          v{report.version}{report.commit && <span className="ml-2 font-mono text-xs text-muted-foreground">{report.commit}</span>}
          <Link href="/update" className="ml-2 text-xs text-primary hover:underline">Check for updates</Link>
        </Row>
        <Row label="Node">{report.node}</Row>
        <Row label="Runs from"><span className="font-mono text-[13px]">{report.repo}</span></Row>
        <Row label="After logout">
          {report.linger === null ? 'unknown' : report.linger ? 'keeps running' : 'stops, with any running job'}
          {report.linger === false && <span className="block text-xs text-muted-foreground">Run ./install.sh again and say yes to keeping it running.</span>}
        </Row>
      </dl>
    </Card>
  );
}

/** The running server and the services it needs: what runs now, and what starts at boot. */
function Server({ report }: { report: DeveloperReport }) {
  const { server } = report;
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>Server and services</CardTitle><Activity className="size-4 text-muted-foreground" /></CardHeader>
      <dl className="grid gap-2 border-b p-5 text-sm sm:grid-cols-2">
        <Row label="Process">PID {server.pid}, port {server.port}</Row>
        <Row label="Running for">{timeAgo(server.startedAt).replace(/ ago$/, '')}<span className="ml-2 text-xs text-muted-foreground">since {shortDate(server.startedAt)}</span></Row>
        <Row label="Memory">{bytes(server.memoryBytes)}</Row>
        <Row label="Jobs">{server.runningJobs === 0 ? 'none running' : <Link href="/jobs" className="text-primary hover:underline">{server.runningJobs} running</Link>}</Row>
        <Row label="Node binary"><span className="font-mono text-[13px] break-all">{server.nodePath}</span></Row>
      </dl>
      <ul className="divide-y text-sm">
        {report.services.map((s) => (
          <li key={s.unit} className="grid gap-1 px-5 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
            <span className="font-medium">{s.label}</span>
            <span className="font-mono text-[13px] text-muted-foreground">{s.scope === 'user' ? 'systemctl --user ' : ''}{s.unit}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={s.active === 'active' ? 'success' : s.active === 'failed' ? 'danger' : 'warning'}>{s.active}{s.since ? `, ${timeAgo(s.since).replace(/ ago$/, '')}` : ''}</Badge>
              {s.enabled && <Badge tone={s.enabled === 'enabled' ? 'neutral' : 'warning'}>{s.enabled === 'enabled' ? 'starts at boot' : s.enabled}</Badge>}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">
        {report.linger
          ? 'Lingering is on, so the panel and Mailpit start when the computer does, before you log in.'
          : 'Your user services start when you log in and stop when you log out. Run ./install.sh again and say yes to keeping the panel running to change that.'}
      </p>
    </Card>
  );
}

function Settings({ report }: { report: DeveloperReport }) {
  return (
    <Card>
      <CardHeader><CardTitle>config.env</CardTitle><Settings2 className="size-4 text-muted-foreground" /></CardHeader>
      <dl className="grid gap-1.5 p-5 font-mono text-xs">
        {report.config.map((c) => (
          <div key={c.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-4">
            <dt className="text-muted-foreground">{c.key}</dt>
            <dd className="min-w-0 break-all">{c.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The panel's startup journal and the installer's logs, one at a time. */
function Logs({ report }: { report: DeveloperReport }) {
  const [shown, setShown] = useState<string>('startup');
  const log = useAsync(() => (shown === 'startup' ? api.developerStartup() : api.developerLog(shown)), [shown]);
  const choices = [{ name: 'startup', label: 'Startup', detail: 'the panel service' }, ...report.logs.map((l) => ({ name: l.name, label: l.name.startsWith('update') ? 'Update' : 'Install', detail: `${shortDate(l.modifiedAt)} · ${timeAgo(l.modifiedAt)} · ${bytes(l.sizeBytes)}` }))];
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>Logs</CardTitle><ScrollText className="size-4 text-muted-foreground" /></CardHeader>
      <div className="grid gap-4 p-5 md:grid-cols-[15rem_minmax(0,1fr)]">
        {/* As tall as the log beside it at most, scrolling the rest; shorter when they stack on a phone. */}
        <ul className="grid h-fit max-h-60 gap-1 overflow-y-auto pr-1 text-sm md:max-h-[30rem]">
          {choices.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => setShown(c.name)}
                aria-pressed={shown === c.name}
                className={cn('grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-muted', shown === c.name && 'bg-muted')}
              >
                <span className="flex items-center gap-2 font-medium"><FileText className="size-3.5 text-muted-foreground" />{c.label}</span>
                <span className="truncate text-xs text-muted-foreground">{c.detail}</span>
              </button>
            </li>
          ))}
          {report.logs.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">No install logs yet: install.sh writes one from v0.5.0 on.</li>}
        </ul>
        <pre className="max-h-[30rem] min-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {log.loading && !log.data ? 'Reading...' : log.error ? log.error : log.data?.text ? <AnsiText text={log.data.text} /> : 'Empty.'}
        </pre>
      </div>
    </Card>
  );
}

function InstalledFiles({ report }: { report: DeveloperReport }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>What install.sh put on this machine</CardTitle><FolderTree className="size-4 text-muted-foreground" /></CardHeader>
      <p className="border-b px-5 py-2.5 text-xs text-muted-foreground">
        To remove the panel, run <code className="font-mono text-[12px]">./install.sh --uninstall --dry-run</code> in {report.repo} to see what goes, then without <code className="font-mono text-[12px]">--dry-run</code>.
        It asks before anything marked "asks you".
      </p>
      {report.installedFiles === null ? (
        <p className="p-5 text-sm text-muted-foreground">
          No list yet: this install is older than v0.5.0. Run <code className="font-mono text-[13px]">./install.sh</code> once more and it writes
          <code className="ml-1 font-mono text-[13px]">/var/lib/devmagic-panel/installed-files</code>.
        </p>
      ) : (
        <PathTree listed={report.installedFiles} badge={(f) => (f.onUninstall ? <Badge tone={UNINSTALL_TONE[f.onUninstall]}>{UNINSTALL_LABEL[f.onUninstall]}</Badge> : null)} />
      )}
    </Card>
  );
}

function PanelFiles({ report }: { report: DeveloperReport }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>Files the panel makes as it runs</CardTitle><FolderTree className="size-4 text-muted-foreground" /></CardHeader>
      <PathTree listed={report.panelFiles} />
    </Card>
  );
}

/** How much Run history there is, and a way to clear it before it prunes itself. */
function RunHistory() {
  const { data, reload } = useAsync(() => api.runs(), []);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => {
    setOpen(false);
    setTyped('');
  };
  async function clear() {
    setBusy(true);
    const result = await runWithToast('history.clear', { confirm: typed }, 'Run history cleared');
    setBusy(false);
    if (result?.ok) {
      close();
      reload();
    }
  }
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle>Run history</CardTitle><History className="size-4 text-muted-foreground" /></CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
        <p className="text-muted-foreground">
          {data ? `${data.total.toLocaleString()} runs kept. ` : ''}Runs older than {RUN_KEEP_DAYS} days, and any beyond the newest {RUN_KEEP_MAX.toLocaleString()}, go by themselves every hour.
        </p>
        <Button size="sm" variant="outline" disabled={!data || data.total === 0} onClick={() => setOpen(true)}><Trash2 />Clear run history</Button>
      </div>
      <Dialog open={open} onClose={close} title="Clear run history?" description="Every finished run goes, with what it printed. Runs still going stay. Nothing on the machine changes.">
        <ConfirmField id="history-confirm" expected="clear" value={typed} onChange={setTyped} />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={typed !== 'clear' || busy} onClick={() => void clear()}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Clear
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

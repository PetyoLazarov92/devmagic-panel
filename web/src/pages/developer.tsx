import { type DeveloperReport, RUN_KEEP_DAYS, RUN_KEEP_MAX } from '@devmagic-panel/shared';
import { Activity, FileText, FolderTree, History, ScrollText, Settings2, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { AnsiText } from '@/components/layout/ansi-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PathTree } from '@/features/site/path-tree';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { KeyValue } from '@/components/ui/key-value';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { setDeveloper } from '@/lib/developer';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { navigate } from '@/lib/router';
import { runWithToast } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { CheckAgain, Notice, PageHeader } from '@/components/layout/page';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Spinner } from '@/components/ui/spinner';
import { TextLink } from '@/components/ui/text-link';

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
      <PageHeader
        title="Developer options"
        intro="Versions, the installer's logs, and every file the panel put on this machine. For when something needs a closer look."
        actions={
          <>
            <span className="flex items-center gap-2 text-sm">
              <Switch checked label="Developer options" onChange={(on) => !on && turnOff()} />
              On
            </span>
            <CheckAgain onClick={reload} loading={loading} />
          </>
        }
      />

      {error && <Notice className="mt-6">{error}</Notice>}
      {!report && loading && <CardsSkeleton className="mt-6" reading="Reading the versions, settings and logs..." cards={[4, 4, 4, 5]} />}

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

function Versions({ report }: { report: DeveloperReport }) {
  return (
    <Card>
      <CardHeader title="Versions" meta={<Wrench className="size-4 text-muted-foreground" />} />
      <CardBody>
        <KeyValue
          labelWidth="sm"
          rows={[
            {
              label: 'Panel',
              value: (
                <>
                  v{report.version}{report.commit && <span className="ml-2 font-mono text-xs text-muted-foreground">{report.commit}</span>}
                  <TextLink href="/update" className="ml-2 text-xs">Check for updates</TextLink>
                </>
              ),
            },
            { label: 'Node', value: report.node },
            { label: 'Runs from', value: <span className="font-mono text-dense">{report.repo}</span> },
            {
              label: 'After logout',
              value: (
                <>
                  {report.linger === null ? 'unknown' : report.linger ? 'keeps running' : 'stops, with any running job'}
                  {report.linger === false && <span className="block text-xs text-muted-foreground">Run ./install.sh again and say yes to keeping it running.</span>}
                </>
              ),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** The running server and the services it needs: what runs now, and what starts at boot. */
function Server({ report }: { report: DeveloperReport }) {
  const { server } = report;
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Server and services" meta={<Activity className="size-4 text-muted-foreground" />} />
      <CardBody className="border-b">
        {/* Two facts a row from sm up: each pair takes a label and a value column. */}
        <KeyValue
          labelWidth="sm"
          className="sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,7rem)_minmax(0,1fr)]"
          rows={[
            { label: 'Process', value: `PID ${server.pid}, port ${server.port}` },
            { label: 'Running for', value: <>{timeAgo(server.startedAt).replace(/ ago$/, '')}<span className="ml-2 text-xs text-muted-foreground">since {shortDate(server.startedAt)}</span></> },
            { label: 'Memory', value: bytes(server.memoryBytes) },
            { label: 'Jobs', value: server.runningJobs === 0 ? 'none running' : <TextLink href="/activity">{server.runningJobs} running</TextLink> },
            { label: 'Node binary', value: <span className="font-mono text-dense">{server.nodePath}</span> },
          ]}
        />
      </CardBody>
      <ul className="divide-y text-sm">
        {report.services.map((s) => (
          <li key={s.unit} className="grid gap-1 px-5 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
            <span className="font-medium">{s.label}</span>
            <span className="font-mono text-dense text-muted-foreground">{s.scope === 'user' ? 'systemctl --user ' : ''}{s.unit}</span>
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
      <CardHeader title="config.env" meta={<Settings2 className="size-4 text-muted-foreground" />} />
      <CardBody>
        <KeyValue dense className="font-mono" rows={report.config.map((c) => ({ key: c.key, label: c.key, value: c.value }))} />
      </CardBody>
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
      <CardHeader title="Logs" meta={<ScrollText className="size-4 text-muted-foreground" />} />
      <CardBody className="md:grid-cols-[15rem_minmax(0,1fr)]">
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
      </CardBody>
    </Card>
  );
}

function InstalledFiles({ report }: { report: DeveloperReport }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="What install.sh put on this machine" meta={<FolderTree className="size-4 text-muted-foreground" />} />
      <p className="border-b px-5 py-2.5 text-xs text-muted-foreground">
        To remove the panel, run <code className="font-mono text-xs">./install.sh --uninstall --dry-run</code> in {report.repo} to see what goes, then without <code className="font-mono text-xs">--dry-run</code>.
        It asks before anything marked "asks you".
      </p>
      {report.installedFiles === null ? (
        <p className="p-5 text-sm text-muted-foreground">
          No list yet: this install is older than v0.5.0. Run <code className="font-mono text-dense">./install.sh</code> once more and it writes
          <code className="ml-1 font-mono text-dense">/var/lib/devmagic-panel/installed-files</code>.
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
      <CardHeader title="Files the panel makes as it runs" meta={<FolderTree className="size-4 text-muted-foreground" />} />
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
      <CardHeader title="Run history" meta={<History className="size-4 text-muted-foreground" />} />
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          {data ? `${data.total.toLocaleString()} runs kept. ` : ''}Runs older than {RUN_KEEP_DAYS} days, and any beyond the newest {RUN_KEEP_MAX.toLocaleString()}, go by themselves every hour.
        </p>
        <Button size="sm" variant="outline" disabled={!data || data.total === 0} onClick={() => setOpen(true)}><Trash2 />Clear run history</Button>
      </CardBody>
      <Dialog open={open} onClose={close} title="Clear run history?" description="Every finished run goes, with what it printed. Runs still going stay. Nothing on the machine changes.">
        <ConfirmField id="history-confirm" expected="clear" value={typed} onChange={setTyped} />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={typed !== 'clear' || busy} onClick={() => void clear()}>
            {busy ? <Spinner /> : <Trash2 />}
            Clear
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

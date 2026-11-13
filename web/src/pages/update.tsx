import type { ChangelogSection, InstalledRelease, UpdateStatus, UpdateWay } from '@devmagic-panel/shared';
import { UPDATE_WAY_LABELS, UPDATE_WAYS } from '@devmagic-panel/shared';
import { Check, ChevronRight, CircleArrowUp, Copy, History, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { shareUpdate } from '@/components/layout/update-indicator';
import { api } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { navigate } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { InstallForm, InstallProgress, LastInstall } from '@/features/updates/update-install';
import { CheckAgain, Notice, PageHeader } from '@/components/layout/page';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Spinner } from '@/components/ui/spinner';

/** The installer's command, for a terminal instead of the password field: folded, as the way most people never need. */
function TerminalWay({ command }: { command: string }) {
  return (
    <details className="group text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        Or in a terminal, where the installer asks for the password itself
      </summary>
      <div className="mt-2"><Command command={command} /></div>
    </details>
  );
}

/** **bold** and `code` in a changelog line; anything else stays text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') ? <code key={i} className="font-mono text-dense">{part.slice(1, -1)}</code>
    : part,
  );
}

/** A command to run in a terminal, with a copy button. */
function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted p-3">
      <code className="min-w-0 flex-1 font-mono text-dense break-all">{command}</code>
      <IconButton icon={copied ? Check : Copy} label="Copy the command" className="size-7 shrink-0" onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))} />
    </div>
  );
}

/** New releases, the way they reach the panel, and the releases installed here. */
export function UpdatePage() {
  const [refresh, setRefresh] = useState(0);
  // Check again asks GitHub; a tick only reads the panel's own state again (an install that runs).
  const [tick, setTick] = useState(0);
  const asked = useRef(0);
  const { data: status, error, loading } = useAsync(() => {
    const again = refresh !== asked.current;
    asked.current = refresh;
    return api.update(again);
  }, [refresh, tick]);
  useEffect(() => {
    if (status) shareUpdate(status);
  }, [status]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState<InstalledRelease | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [howTo, setHowTo] = useState<string | null>(null);
  // An install this page started, and the release a password is asked for (a switch, or running one again).
  const [installing, setInstalling] = useState<{ jobId: string; release: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const started = (release: string) => (jobId: string) => {
    setAsking(null);
    setInstalling({ jobId, release });
  };

  async function start(id: 'panel.update' | 'panel.switchRelease', input: Record<string, string>) {
    setStarting(true);
    setStartError(null);
    try {
      const jobId = await api.startJob(id, input);
      navigate(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      setStartError((err as Error).message);
      setStarting(false);
    }
  }

  const downloaded = status?.latest ? status.releases.find((r) => r.name === status.latest && !r.current) : undefined;
  const hasNews = Boolean(status && ((status.available && status.latest) || status.changelog.length > 0));

  return (
    <div className="pt-4">
      <PageHeader
        title="Updates"
        intro={
          <>
            New releases of the panel, from its GitHub repository.
            {status && <> You run v{status.current}{status.release && status.release !== `v${status.current}` ? ` (${status.release})` : ''}; checked {timeAgo(status.checkedAt)}.</>}
          </>
        }
        actions={<CheckAgain onClick={() => setRefresh((n) => n + 1)} loading={loading} />}
      />

      {error && <Notice className="mt-6">{error}</Notice>}
      {!status && loading && <CardsSkeleton className="mt-6" reading="Looking for releases..." columns={1} cards={[4, 3]} />}

      {status?.latest && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={`Update to ${status.latest}?`}
          description={`The panel downloads ${status.latest}${status.packageBytes ? ` (${bytes(status.packageBytes)})` : ''}, checks it, switches to it and restarts, so this page reconnects after a few seconds. It waits until running installs finish. The release you run now stays: switch back to it under Installed releases.`}
        >
          {status.installerChanged && (
            <p className="text-sm">
              Afterwards, run <code className="font-mono text-dense break-all">{status.command}</code> in a terminal for the installer's part.
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="soft" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              disabled={starting}
              onClick={() => {
                setConfirming(false);
                void start('panel.update', { version: status.latest as string });
              }}
            >
              <CircleArrowUp />
              Update now
            </Button>
          </div>
        </Dialog>
      )}

      <Dialog
        open={switching !== null}
        onClose={() => setSwitching(null)}
        title={`Switch to ${switching?.name ?? ''}?`}
        description="The panel points current at that release and restarts, so this page reconnects after a few seconds. The release you run now stays installed."
      >
        {switching?.changes && switching.changes.kind !== 'running' && (
          <div className="mt-4 grid gap-2">
            <p className="text-sm font-medium">{switching.changes.kind === 'adds' ? 'It adds' : 'It undoes'}</p>
            <div className="max-h-72 overflow-y-auto rounded-md border">
              <Sections sections={switching.changes.sections} />
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setSwitching(null)}>Cancel</Button>
          <Button
            disabled={starting}
            onClick={() => {
              const name = switching?.name as string;
              setSwitching(null);
              void start('panel.switchRelease', { release: name });
            }}
          >
            <History />
            Switch now
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={`Install ${asking ?? ''}?`}
        description={`Its installer puts ${asking ?? 'its'} root scripts in place, switches the panel to it and restarts it, so this page reconnects by itself. If a step fails, it puts everything back.`}
      >
        {asking && <div className="mt-4"><InstallForm release={asking} verb={`Install ${asking}`} onStarted={started(asking)} onCancel={() => setAsking(null)} /></div>}
        {asking && status?.releases.find((r) => r.name === asking)?.changes?.kind === 'removes' && (
          <p className="mt-3 text-xs text-muted-foreground">
            An older release does not know what newer ones added. What they set up keeps working (a site&apos;s own PHP, PHP-FPM for every site), but {asking} may not show or change it.
          </p>
        )}
      </Dialog>

      {status && (
        <div className="mt-6 grid gap-4">
          {installing && <InstallProgress key={installing.jobId} jobId={installing.jobId} release={installing.release} onAgain={() => {
            // The newest release has its form on the page; any other gets the dialog.
            if (installing.release !== status.latest) setAsking(installing.release);
            setInstalling(null);
            setTick((n) => n + 1);
          }} />}
          {!installing && status.install && <LastInstall install={status.install} onAgain={setAsking} onRefresh={() => setTick((n) => n + 1)} />}
          {status.error && <Notice>{status.error}</Notice>}
          {status.notice && (
            <Notice tone="warning">{status.notice}</Notice>
          )}
          {!status.available && !status.error && (
            <Notice tone="success">{status.reason ?? 'You have the latest version.'}</Notice>
          )}

          {/* Wide: the release to install and what it brings on the left, the installed ones and how updates arrive on the right. */}
          {/* Nothing new: the two cards are a pair as in Settings, one height, each footer at its bottom, so opening a release's changes grows both.
              A release to install: the notes on the left reach down to meet the right column; opened past it, only they grow,
              and the right column keeps its size and stays in view. */}
          <div className={cn('grid items-stretch gap-4', hasNews ? '@5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : '@4xl:grid-cols-2')}>
          {hasNews && (
          <div className="flex min-w-0 flex-col gap-4 [&>:last-child]:flex-1">
          {status.available && status.latest && (
            <Card>
              <CardHeader title={<>{status.latest} is out</>} meta={<CircleArrowUp className="size-4 text-primary" />} />
              <CardBody className="gap-3">
                {status.mode === 'panel' && (
                  <>
                    <p className="text-muted-foreground">
                      The panel downloads {status.latest}{status.packageBytes ? ` (${bytes(status.packageBytes)})` : ''}, checks its checksum, unpacks it next
                      to the installed releases, switches to it and restarts. Nothing is built here. The page reconnects by itself.
                    </p>
                    {status.installerChanged && (
                      <Notice tone="warning" size="inline">
                        This release changes the installer too. The panel works after the update as it is; for the installer's own part, run{' '}
                        <code className="font-mono text-dense break-all">{status.command}</code> in a terminal afterwards (it asks for your password).
                      </Notice>
                    )}
                    <Button className="justify-self-start" disabled={starting} onClick={() => setConfirming(true)}>
                      {starting ? <Spinner /> : <CircleArrowUp />}
                      Update to {status.latest}
                    </Button>
                  </>
                )}
                {status.mode === 'terminal' && status.command && (
                  downloaded?.fromPanel ? (
                    <>
                      <p>
                        {status.latest} is downloaded and checked. It changes the root scripts, so it installs with your sudo password: its installer puts them in place, switches the panel to {status.latest} and restarts it. If a step fails, it puts everything back.
                      </p>
                      {!installing && <InstallForm release={status.latest} verb={`Install ${status.latest}`} onStarted={started(status.latest)} />}
                      <TerminalWay command={status.command} />
                    </>
                  ) : downloaded ? (
                    <>
                      <p>{status.latest} is downloaded and checked. Its installer is older than installing from this page, so run it in a terminal: it installs the root scripts with your password, switches the panel to {status.latest} and restarts it.</p>
                      <Command command={status.command} />
                    </>
                  ) : (
                    <>
                      <p>
                        {status.latest} changes the root scripts, so it installs with your sudo password. The panel downloads {status.latest}{status.packageBytes ? ` (${bytes(status.packageBytes)})` : ''} and checks it, then its installer puts the root scripts in place, switches the panel to it and restarts it. If a step fails, it puts everything back.
                      </p>
                      {!installing && <InstallForm release={status.latest} verb={`Install ${status.latest}`} onStarted={started(status.latest)} />}
                      {!installing && (
                        <p className="text-xs text-muted-foreground">
                          Rather use a terminal?{' '}
                          <button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={starting} onClick={() => void start('panel.update', { version: status.latest as string })}>
                            Only download {status.latest}
                          </button>
                          , then run its installer, which asks for the password itself.
                        </p>
                      )}
                    </>
                  )
                )}
                {status.mode === 'blocked' && <p className="text-warning">{status.reason}</p>}
                {startError && <p role="alert" className="text-danger">{startError}</p>}
              </CardBody>
            </Card>
          )}

          {status.changelog.length > 0 && <WhatIsNew key={status.latest} current={status.current} changelog={status.changelog} />}
          </div>
          )}

          <div className={cn('grid min-w-0 content-start gap-4 @5xl:sticky @5xl:top-4 @5xl:self-start', !hasNews && 'contents')}>
          {status.releases.length > 0 && (
            <Card className="flex flex-col">
              <CardHeader title="Installed releases" meta={<History className="size-4 text-muted-foreground" />} />
              <ul className="divide-y">
                {status.releases.map((r) => (
                  <li key={r.name} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2 px-5 py-3">
                    <span className="font-mono text-dense font-medium">{r.name}</span>
                    {r.current && <Badge tone="success">running</Badge>}
                    <span className="text-xs text-muted-foreground">installed {timeAgo(r.installedAt)}</span>
                    {r.changes && (
                      <Button size="xs" variant="soft" aria-expanded={opened === r.name} onClick={() => setOpened(opened === r.name ? null : r.name)} className="text-muted-foreground hover:text-foreground">
                        <ChevronRight className={cn('transition-transform', opened === r.name && 'rotate-90')} />
                        {changesLabel(r.changes)}
                      </Button>
                    )}
                    <span className="flex-1" />
                    {!r.current && r.mode === 'panel' && (
                      <Button size="sm" variant="outline" disabled={starting} onClick={() => setSwitching(r)}>
                        <History />
                        Switch to it
                      </Button>
                    )}
                    {!r.current && r.mode === 'terminal' && (
                      <>
                        {r.fromPanel && (
                          <Button size="sm" variant="outline" disabled={installing !== null} onClick={() => setAsking(r.name)}>
                            <History />
                            Switch to it
                          </Button>
                        )}
                        <Button size="sm" variant={r.fromPanel ? 'soft' : 'outline'} aria-expanded={howTo === r.name} onClick={() => setHowTo(howTo === r.name ? null : r.name)}>
                          {r.fromPanel ? 'In a terminal' : 'How to switch'}
                        </Button>
                      </>
                    )}
                  </div>
                  {howTo === r.name && r.command && (
                    <div className="grid gap-2 border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground">
                      <p>
                        {r.name} has other root scripts (dmp-root) than the installed ones, which only its installer may put in place, with your sudo password.{' '}
                        {r.fromPanel ? 'Switch to it asks for it here, or run the installer in a terminal, where it asks itself.' : 'Its installer is older than installing from this page (v0.25.0), so run it in a terminal: it asks for the password itself.'}
                      </p>
                      <Command command={r.command} />
                      {r.changes?.kind === 'removes' && (
                        <p>
                          An older release does not know what newer ones added. What they set up keeps working (a site&apos;s own PHP, PHP-FPM for every site), but {r.name} may not show or change it. To come back, run the newer release&apos;s install.sh the same way, or update from this page.
                        </p>
                      )}
                    </div>
                  )}
                  {opened === r.name && r.changes && <div className="border-t bg-muted/30"><Sections sections={r.changes.sections} /></div>}
                  </li>
                ))}
              </ul>
              <p className="mt-auto border-t px-5 py-3 text-xs text-muted-foreground">
                The running release and the newest others stay, three in all. Switching restarts the panel; a release with other root scripts than the installed ones switches through its own <code className="font-mono">install.sh</code>, with your sudo password.
              </p>
            </Card>
          )}

          <AccessCard status={status} />
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What each release since the running one changes, newest first: the newest
 * open, the ones before it closed with how many changes each has.
 */
function WhatIsNew({ current, changelog }: { current: string; changelog: UpdateStatus['changelog'] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(changelog.slice(0, 1).map((c) => c.version)));
  const toggle = (version: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  const several = changelog.length > 1;
  return (
    <Card>
      <CardHeader
        title={`What is new since v${current.replace(/^v/, '')}`}
        meta={several && <span className="text-xs whitespace-nowrap text-muted-foreground">{changelog.length} releases</span>}
        actions={
          several && (
            <Button size="sm" variant="soft" onClick={() => setOpen(open.size === changelog.length ? new Set() : new Set(changelog.map((c) => c.version)))}>
              {open.size === changelog.length ? 'Collapse all' : 'Expand all'}
            </Button>
          )
        }
      />
      <ul className="divide-y">
        {changelog.map((section) => {
          const isOpen = open.has(section.version);
          const heading = (
            <>
              <span className="font-mono text-dense font-medium group-hover:text-primary">{section.version}</span>
              {section.date && <span className="text-xs text-muted-foreground">{section.date}</span>}
              {!isOpen && <span className="ml-auto text-xs text-muted-foreground">{section.items.length === 1 ? '1 change' : `${section.items.length} changes`}</span>}
            </>
          );
          return (
            <li key={section.version}>
              {several ? (
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(section.version)} className="group flex w-full items-center gap-2 px-5 py-3 text-left">
                  <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                  {heading}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-5 pt-3">{heading}</div>
              )}
              {isOpen && (
                <ul className={cn('grid list-disc gap-1.5 pr-5 pb-4 text-sm', several ? 'pl-15' : 'pt-2 pl-9')}>
                  {section.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** What a row's toggle says: what the running release changed, or what a switch to the release adds or undoes. */
function changesLabel(changes: NonNullable<InstalledRelease['changes']>): string {
  const n = changes.sections.length;
  if (changes.kind === 'running') return 'What it changed';
  return `${changes.kind === 'adds' ? 'Adds' : 'Undoes'} ${n === 1 ? '1 release' : `${n} releases`}`;
}

/** Changelog sections, each version with its date and items. */
function Sections({ sections }: { sections: readonly ChangelogSection[] }) {
  return (
    <ul className="divide-y">
      {sections.map((section) => (
        <li key={section.version} className="px-5 py-3">
          <p className="flex items-center gap-2">
            <span className="font-mono text-dense font-medium">{section.version}</span>
            {section.date && <span className="text-xs text-muted-foreground">{section.date}</span>}
          </p>
          <ul className="mt-1.5 grid list-disc gap-1.5 pl-5 text-sm">
            {section.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

const WAY_HINTS: Record<UpdateWay, string> = {
  https: 'Works when the repository is public. Nothing to set up.',
  gh: 'Install the GitHub CLI and sign in once with gh auth login.',
  git: 'Works when your SSH key can read the repository, the same key git uses for your sites.',
};

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The ways to the releases: the one that worked, and why the ones tried before it did not. */
function AccessCard({ status }: { status: UpdateStatus }) {
  if (!status.source && !status.access) return null;
  return (
    <Card className="flex flex-col">
      <CardHeader title="How updates arrive" meta={<Badge tone={status.source ? 'success' : 'danger'}>{status.source ? UPDATE_WAY_LABELS[status.source] : 'no access'}</Badge>} />
      <ul className="divide-y">
        {UPDATE_WAYS.map((way) => {
          const problem = status.access?.find((a) => a.way === way)?.problem;
          const used = status.source === way;
          return (
            <li key={way} className="flex items-start gap-3 px-5 py-3 text-sm">
              {used ? <Check className="mt-0.5 size-4 shrink-0 text-success" /> : problem ? <X className="mt-0.5 size-4 shrink-0 text-danger" /> : <span className="size-4 shrink-0" />}
              <div className="min-w-0">
                <p className="font-medium">
                  {capital(UPDATE_WAY_LABELS[way])}
                  {used && <span className="font-normal text-muted-foreground"> · used now</span>}
                </p>
                <p className="text-muted-foreground break-words">{problem ?? WAY_HINTS[way]}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-auto border-t px-5 py-3 text-xs text-muted-foreground">
        The panel tries them in this order and keeps the first that can read the repository. Any one of them is enough, and none needs a token.
      </p>
    </Card>
  );
}

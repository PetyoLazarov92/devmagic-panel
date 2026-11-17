import type { CheckFix, CheckGroup, CheckResult, EnvironmentReport } from '@devmagic-panel/shared';
import { JobLine, settled, startedJobId, useJob } from '@/features/jobs/job-steps';
import { lastLine } from '@/lib/site-actions';
import { GithubKeys } from './github-keys';
import { InstallMissing } from './install-missing';
import { CHECK_GROUP_LABELS } from '@devmagic-panel/shared';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Info, KeyRound, SquareTerminal, Wrench } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { type CheckShow, openAfterCheck, parseShow, showOptions, shownGroups } from '@/lib/environment';
import { FilterChips } from '@/components/ui/filter-chips';
import { useQueryParam } from '@/lib/router';
import { cn } from '@/lib/utils';
import { CheckAgain, Notice } from '@/components/layout/page';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { Spinner } from '@/components/ui/spinner';
import { SecretInput } from '@/components/ui/secret-input';
import { reportModeEvent } from '@/lib/modes';
import { TextLink } from '@/components/ui/text-link';

const statusIcon = {
  ok: <CircleCheck className="size-4.5 text-success" aria-label="OK" />,
  info: <Info className="size-4.5 text-muted-foreground" aria-label="Optional, not set up" />,
  warn: <CircleAlert className="size-4.5 text-warning" aria-label="Warning" />,
  fail: <CircleX className="size-4.5 text-danger" aria-label="Failing" />,
};

interface FixState {
  key: string;
  phase: 'confirm' | 'password' | 'running' | 'job' | 'done' | 'failed';
  output?: string;
}

/** What a closed group says beside its title. */
function summaryOf(checks: CheckResult[]): string {
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const info = checks.filter((c) => c.status === 'info').length;
  if (!warn && !fail && !info) return checks.length === 1 ? 'Passes' : `All ${checks.length} pass`;
  const passing = checks.length - warn - fail - info;
  return [fail ? `${fail} failing` : '', warn ? (warn === 1 ? '1 warning' : `${warn} warnings`) : '', !warn && !fail && passing ? `${passing} pass` : '', info ? `${info} optional to set up` : ''].filter(Boolean).join(', ');
}

/**
 * The machine's checks, with groups that all pass closed: Aura's Machine
 * checks tab (/aura/machine). The panel's settings are on their own page.
 */
export function MachineChecks() {
  const tab = 'checks' as const;
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [open, setOpen] = useState<ReadonlySet<CheckGroup>>(new Set());
  // A filter: only the checks of one status, in their groups, each of those groups open (?show=warn from a link).
  const [show, setShow] = useState<CheckShow>(parseShow(useQueryParam('show')));
  const showRef = useRef(show);
  showRef.current = show;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fix, setFix] = useState<FixState | null>(null);
  const runner = useJob();
  const [terminal, setTerminal] = useState<{ busy: boolean; ok?: boolean; said?: string } | null>(null);
  async function openShell() {
    terminalAt.current = Date.now();
    setTerminal({ busy: true });
    try {
      const r = await api.runAction('machine.openTerminal', {});
      setTerminal({ busy: false, ok: r.ok, said: lastLine(r.output) });
    } catch (err) {
      setTerminal({ busy: false, ok: false, said: (err as Error).message });
    }
  }
  const [cardBusy, setCardBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.environment();
      setReport(next);
      // A filter on (from the address, or picked before Check again) keeps its groups open too.
      setOpen((prev) => new Set([...openAfterCheck(prev, next), ...(showRef.current === 'all' ? [] : shownGroups(next, showRef.current).map((g) => g.group))]));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A terminal this page opened (a sign-in): coming back to the tab checks again, for 15 minutes.
  const terminalAt = useRef(0);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - terminalAt.current < 15 * 60_000) void load();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [load]);

  async function runFix(key: string, f: CheckFix) {
    if (f.action === 'machine.openTerminal') terminalAt.current = Date.now();
    setFix({ key, phase: 'running' });
    try {
      const result = await api.runAction(f.action, f.input);
      const jobId = result.ok ? startedJobId(result.output) : null;
      if (jobId) {
        // A job (an install, a sign-in): followed here until it ends, the buttons locked meanwhile.
        setFix({ key, phase: 'job' });
        reportModeEvent('auraFix');
        await runner.follow(Promise.resolve(jobId));
        return;
      }
      setFix({ key, phase: result.ok ? 'done' : 'failed', output: result.output });
      if (result.ok) {
        reportModeEvent('auraFix');
        void load();
      }
    } catch (err) {
      setFix({ key, phase: 'failed', output: (err as Error).message });
    }
  }

  // The fix's job ended: how, in its row, and the checks read again.
  const ended = runner.job && settled(runner.job) ? runner.job : null;
  useEffect(() => {
    if (!ended) return;
    const failedStep = ended.steps.find((s) => s.status === 'failed');
    setFix((now) => (now?.phase === 'job' ? { key: now.key, phase: ended.status === 'done' ? 'done' : 'failed', output: lastLine(failedStep?.output ?? ended.steps.at(-1)?.output ?? '') || (ended.status === 'done' ? 'Done.' : `It ended ${ended.status}.`) } : now));
    runner.clear();
    void load();
  }, [ended, runner, load]);
  const fixBusy = fix?.phase === 'running' || fix?.phase === 'job';
  const busy = fixBusy || cardBusy;

  function startFix(check: CheckResult, f: CheckFix, index: number) {
    const key = `${check.id}:${index}`;
    if (f.needsPassword || f.secret) {
      setFix({ key, phase: 'password' });
      return;
    }
    if (f.confirm && fix?.key !== key) {
      setFix({ key, phase: 'confirm' });
      return;
    }
    void runFix(key, f);
  }

  const options = report ? showOptions(report) : [];
  // A filter that has nothing left after Check again (the warnings fixed, say) goes back to All.
  const showing: CheckShow = options.some((o) => o.value === show) ? show : 'all';
  const groups = report ? shownGroups(report, showing) : [];
  function pickShow(next: CheckShow) {
    setShow(next);
    if (!report) return;
    // A filter opens every group it shows; All goes back to opening only those with a problem.
    setOpen(next === 'all' ? openAfterCheck(new Set(), report) : new Set(shownGroups(report, next).map((g) => g.group)));
  }
  function toggle(group: CheckGroup) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  return (
    <div>
      <p className="mt-5 text-sm text-muted-foreground">What this machine needs for local WordPress sites: the panel's install, Apache, nginx, certificates, MySQL, PHP and tools, with one-click fixes where possible.</p>

      {terminal?.said && (
        <p className={cn('mt-3 text-sm', terminal.ok ? 'text-muted-foreground' : 'text-danger')} role={terminal.ok ? undefined : 'alert'}>
          {terminal.said}
        </p>
      )}
      {tab === 'checks' && report && <InstallMissing report={report} locked={fixBusy} onBusy={setCardBusy} onChanged={() => void load()} />}

      {tab === 'checks' && (report || error) && (
        <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          {report && (
            <>
              <FilterChips label="Show" value={showing} onChange={pickShow} options={options} />
              <span className="text-xs text-muted-foreground">
                Checked {new Date(report.checkedAt).toLocaleTimeString()} in {(report.durationMs / 1000).toFixed(1)} s
              </span>
            </>
          )}
          <div className="ml-auto flex flex-wrap gap-1">
            {report && (
              <>
                <Button size="sm" variant="soft" disabled={groups.every((g) => open.has(g.group))} onClick={() => setOpen(new Set(groups.map((g) => g.group)))}>Expand all</Button>
                <Button size="sm" variant="soft" disabled={!groups.some((g) => open.has(g.group))} onClick={() => setOpen(new Set())}>Collapse all</Button>
                <Button size="sm" variant="soft" disabled={terminal?.busy} onClick={() => void openShell()} title="A terminal in your home folder: Windows Terminal in this distro under WSL, your desktop's terminal on Ubuntu">
                  {terminal?.busy ? <Spinner /> : <SquareTerminal />}
                  Open terminal
                </Button>
              </>
            )}
            <CheckAgain size="sm" onClick={() => void load()} loading={loading} />
          </div>
        </div>
      )}

      {tab === 'checks' && error && (
        <Notice className="mt-5">{error}</Notice>
      )}

      {tab === 'checks' && !report && loading && (
        <CardsSkeleton className="mt-4" reading="Checking this machine..." columns={1} cards={[3, 4, 2, 3]} />
      )}

      {tab === 'checks' && (
        <div className="mt-4 grid gap-4">
          {groups.map(({ group, checks, status }) => {
            const isOpen = open.has(group);
            return (
              <Card key={group}>
                <h2>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(group)}
                    className={cn('group flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left', isOpen && 'border-b')}
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight group-hover:text-primary">
                      <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                      {CHECK_GROUP_LABELS[group]}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
                      {!isOpen && summaryOf(checks)}
                      {statusIcon[status]}
                    </span>
                  </button>
                </h2>
                {isOpen && (
                  <ul className="divide-y">
                    {checks.map((check) => (
                      <li key={check.id} className="px-5 py-3">
                        <div className="flex min-w-0 gap-3">
                          <span className="mt-0.5 shrink-0">{statusIcon[check.status]}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              {check.label}
                              {check.optional && <Badge>optional</Badge>}
                              {check.recommended && <Badge>recommended</Badge>}
                            </div>
                            <p className="mt-0.5 text-sm break-words text-muted-foreground">{check.detail}</p>
                            {check.id === 'access.github' && <GithubKeys onChanged={() => void load()} />}
                            {check.status !== 'ok' && check.fixes && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {check.fixes.map((f, i) => {
                                  const running = fix?.key === `${check.id}:${i}` && fix.phase === 'running';
                                  return (
                                    <Button
                                      key={i}
                                      size="sm"
                                      variant="outline"
                                      disabled={busy}
                                      onClick={() => startFix(check, f, i)}
                                    >
                                      {running ? <Spinner /> : <Wrench />}
                                      {f.label}
                                    </Button>
                                  );
                                })}
                              </div>
                            )}
                            {check.fixes?.map((f, i) => {
                              const key = `${check.id}:${i}`;
                              if (fix?.key !== key) return null;
                              if (fix.phase === 'job') {
                                if (runner.error) return <p key={key} className="mt-2 text-sm text-danger">{runner.error}</p>;
                                return runner.job ? <JobLine key={key} job={runner.job} /> : null;
                              }
                              if (fix.phase === 'password') {
                                return <PasswordFix key={key} fix={f} onRun={(secret) => void runFix(key, { ...f, input: { ...f.input, [f.secret?.field ?? 'password']: secret } })} onCancel={() => setFix(null)} />;
                              }
                              if (fix.phase === 'confirm') {
                                return (
                                  <Notice key={key} tone="warning" size="inline" className="mt-2">
                                    <p>{f.confirm}</p>
                                    <div className="mt-2 flex gap-2">
                                      <Button size="sm" variant="danger" onClick={() => void runFix(key, f)}>
                                        {f.label}
                                      </Button>
                                      <Button size="sm" variant="soft" onClick={() => setFix(null)}>
                                        Cancel
                                      </Button>
                                    </div>
                                  </Notice>
                                );
                              }
                              if (!fix.output) return null;
                              return (
                                <pre
                                  key={key}
                                  className={cn(
                                    'mt-2 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap',
                                    fix.phase === 'failed' && 'text-danger',
                                  )}
                                >
                                  {fix.output}
                                </pre>
                              );
                            })}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A fix that takes your sudo password: what it does, the password field and
 * the button. The password goes with that one run and is cleared from the page.
 */
function PasswordFix({ fix, onRun, onCancel }: { fix: CheckFix; onRun: (password: string) => void; onCancel: () => void }) {
  const [secret, setSecret] = useState('');
  const id = useId();
  function submit(event: FormEvent) {
    event.preventDefault();
    const password = secret;
    setSecret('');
    onRun(password);
  }
  return (
    <Notice tone="info" size="inline" className="mt-2">
      <form className="grid gap-2" onSubmit={submit} autoComplete="off">
        {fix.confirm && <p>{fix.confirm}</p>}
        <label htmlFor={id} className="text-sm font-medium">
          {fix.secret?.label ?? 'Your sudo password'}
        </label>
        <div className="sm:max-w-xs">
          <SecretInput id={id} value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
        </div>
        <p className="text-xs text-muted-foreground">{fix.secret ? fix.secret.hint : 'The password you log in to this computer with. Leave it empty if sudo asks you for none.'}</p>
        {fix.secret?.link && (
          <TextLink href={fix.secret.link.href} className="text-xs">
            {fix.secret.link.text}
          </TextLink>
        )}
        <div className="flex gap-2">
          <Button size="sm" type="submit">
            <KeyRound />
            {fix.label.replace(/ with (your password|a token)$/, '')}
          </Button>
          <Button size="sm" variant="soft" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Notice>
  );
}

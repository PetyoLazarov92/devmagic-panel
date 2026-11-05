import type { CheckFix, CheckGroup, CheckResult, EnvironmentReport } from '@devmagic-panel/shared';
import { CHECK_GROUP_LABELS } from '@devmagic-panel/shared';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, LoaderCircle, RefreshCw, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AssistantCard } from '@/components/assistant-card';
import { PanelPasswordCard } from '@/components/panel-password-card';
import { ClaudeDefaultsCard } from '@/components/claude-defaults-card';
import { LocalConstantsCard } from '@/components/local-constants-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { groupsOf, openAfterCheck, problemCount } from '@/lib/environment';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';

const statusIcon = {
  ok: <CircleCheck className="size-4.5 text-success" aria-label="OK" />,
  warn: <CircleAlert className="size-4.5 text-warning" aria-label="Warning" />,
  fail: <CircleX className="size-4.5 text-danger" aria-label="Failing" />,
};

interface FixState {
  key: string;
  phase: 'confirm' | 'running' | 'done' | 'failed';
  output?: string;
}

export type EnvironmentTab = 'checks' | 'settings';

/** What a closed group says beside its title. */
function summaryOf(checks: CheckResult[]): string {
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  if (!warn && !fail) return checks.length === 1 ? 'Passes' : `All ${checks.length} pass`;
  return [fail ? `${fail} failing` : '', warn ? (warn === 1 ? '1 warning' : `${warn} warnings`) : ''].filter(Boolean).join(', ');
}

/**
 * The machine's checks, with groups that all pass closed, and on their own
 * tab (/environment/settings) the panel's settings, so they never move while
 * the checks run.
 */
export function EnvironmentPage({ tab }: { tab: EnvironmentTab }) {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [open, setOpen] = useState<ReadonlySet<CheckGroup>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fix, setFix] = useState<FixState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.environment();
      setReport(next);
      setOpen((prev) => openAfterCheck(prev, next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runFix(key: string, f: CheckFix) {
    setFix({ key, phase: 'running' });
    try {
      const result = await api.runAction(f.action, f.input);
      setFix({ key, phase: result.ok ? 'done' : 'failed', output: result.output });
      if (result.ok) void load();
    } catch (err) {
      setFix({ key, phase: 'failed', output: (err as Error).message });
    }
  }

  function startFix(check: CheckResult, f: CheckFix, index: number) {
    const key = `${check.id}:${index}`;
    if (f.confirm && fix?.key !== key) {
      setFix({ key, phase: 'confirm' });
      return;
    }
    void runFix(key, f);
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  report?.checks.forEach((c) => counts[c.status]++);

  const problems = report ? problemCount(report) : null;
  const groups = report ? groupsOf(report) : [];
  function toggle(group: CheckGroup) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  return (
    <div className="pt-4">
      <h1 className="text-2xl font-semibold tracking-tight">Environment</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {tab === 'checks'
          ? 'What this machine needs for local WordPress sites, and one-click fixes where possible.'
          : 'The AI assistant, and the defaults Claude Code uses for organization installs.'}
      </p>

      <Tabs
        className="mt-6"
        value={tab}
        onChange={(t) => navigate(t === 'settings' ? '/environment/settings' : '/environment')}
        items={[
          { value: 'checks', label: 'Checks', ...(problems?.count ? { count: problems.count, tone: problems.tone } : {}) },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'settings' && (
        <div className="mt-5 grid gap-4">
          <PanelPasswordCard />
          <AssistantCard />
          <ClaudeDefaultsCard />
          <LocalConstantsCard />
        </div>
      )}

      {tab === 'checks' && (report || error) && (
        <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          {report && (
            <>
              <Badge tone="success">{counts.ok} passing</Badge>
              {counts.warn > 0 && <Badge tone="warning">{counts.warn === 1 ? '1 warning' : `${counts.warn} warnings`}</Badge>}
              {counts.fail > 0 && <Badge tone="danger">{counts.fail} failing</Badge>}
              <span className="text-xs text-muted-foreground">
                Checked {new Date(report.checkedAt).toLocaleTimeString()} in {(report.durationMs / 1000).toFixed(1)} s
              </span>
            </>
          )}
          <div className="ml-auto flex flex-wrap gap-1">
            {report && (
              <>
                <Button size="sm" variant="ghost" disabled={open.size === groups.length} onClick={() => setOpen(new Set(groups.map((g) => g.group)))}>Expand all</Button>
                <Button size="sm" variant="ghost" disabled={open.size === 0} onClick={() => setOpen(new Set())}>Collapse all</Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn(loading && 'animate-spin')} />
              Check again
            </Button>
          </div>
        </div>
      )}

      {tab === 'checks' && error && (
        <p role="alert" className="mt-5 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {tab === 'checks' && !report && loading && (
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> Checking this machine...
        </div>
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
                            {check.status !== 'ok' && check.fixes && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {check.fixes.map((f, i) => {
                                  const running = fix?.key === `${check.id}:${i}` && fix.phase === 'running';
                                  return (
                                    <Button
                                      key={i}
                                      size="sm"
                                      variant="outline"
                                      disabled={fix?.phase === 'running'}
                                      onClick={() => startFix(check, f, i)}
                                    >
                                      {running ? <LoaderCircle className="animate-spin" /> : <Wrench />}
                                      {f.label}
                                    </Button>
                                  );
                                })}
                              </div>
                            )}
                            {check.fixes?.map((f, i) => {
                              const key = `${check.id}:${i}`;
                              if (fix?.key !== key) return null;
                              if (fix.phase === 'confirm') {
                                return (
                                  <div key={key} className="mt-2 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
                                    <p>{f.confirm}</p>
                                    <div className="mt-2 flex gap-2">
                                      <Button size="sm" variant="danger" onClick={() => void runFix(key, f)}>
                                        {f.label}
                                      </Button>
                                      <Button size="sm" variant="ghost" onClick={() => setFix(null)}>
                                        Cancel
                                      </Button>
                                    </div>
                                  </div>
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

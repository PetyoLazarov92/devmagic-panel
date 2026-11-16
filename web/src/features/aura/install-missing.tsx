import type { EnvironmentReport, JobView } from '@devmagic-panel/shared';
import { Download, KeyRound } from 'lucide-react';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/field';
import { SecretInput } from '@/components/ui/secret-input';
import { Spinner } from '@/components/ui/spinner';
import { JobLine, settled, startedJobId, useJob } from '@/features/jobs/job-steps';
import { api } from '@/lib/api';
import { installRuns, missingInstalls, pickedAtFirst, showsInstallCard } from '@/lib/install-missing';
import { lastLine } from '@/lib/site-actions';
import { cn } from '@/lib/utils';

const HIDDEN_KEY = 'dmp.aura.installMissing';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'hidden';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, 'hidden');
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // A browser without storage shows the card each time.
  }
}

interface Ended {
  id: string;
  title: string;
  ok: boolean;
  line: string;
}

/**
 * The top of Machine checks on a machine that misses tools: every install
 * offered below, ticked when the panel needs or recommends it, installed
 * together on one click. The ones that need your sudo password go in one job,
 * so the password is asked once. Each job is followed here until it ends.
 */
export function InstallMissing({ report, locked, onBusy, onChanged }: { report: EnvironmentReport; locked: boolean; onBusy: (busy: boolean) => void; onChanged: () => void }) {
  const missing = useMemo(() => missingInstalls(report), [report]);
  const [hidden, setHidden] = useState(readHidden);
  const [picked, setPicked] = useState<Set<string>>(() => pickedAtFirst(missing));
  const [secret, setSecret] = useState('');
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState<string[]>([]);
  const [ended, setEnded] = useState<Ended[]>([]);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  // A newer report: keep the picks that are still missing.
  useEffect(() => {
    setPicked((now) => new Set(missing.filter((m) => now.has(m.key)).map((m) => m.key)));
  }, [missing]);

  const busy = starting || running.length > 0;
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => onBusyRef.current(busy), [busy]);
  // The last job ended: the checks read again.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running.length > 0) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      onChangedRef.current();
    }
  }, [running]);

  if (running.length === 0 && ended.length === 0 && !showsInstallCard(missing)) return null;

  const chosen = missing.filter((m) => picked.has(m.key));
  const withPassword = chosen.filter((m) => m.fix.needsPassword);

  if (hidden && !busy) {
    return (
      <p className="mt-5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {missing.length === 1 ? '1 tool' : `${missing.length} tools`} can be installed from here.
        <Button size="xs" variant="soft" onClick={() => (setHidden(false), writeHidden(false))}>
          Show
        </Button>
      </p>
    );
  }

  async function install(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    setEnded([]);
    const password = secret;
    setSecret('');
    const ids: string[] = [];
    const problems: string[] = [];
    // Without a password: each its own job. With it: one job for all, the password once.
    for (const run of installRuns(chosen, password)) {
      try {
        const r = await api.runAction(run.action, run.input);
        const job = r.ok ? startedJobId(r.output) : null;
        if (job) ids.push(job);
        else if (!r.ok) problems.push(`${run.what}: ${lastLine(r.output)}`);
      } catch (err) {
        problems.push(`${run.what}: ${(err as Error).message}`);
      }
    }
    setRunning(ids);
    if (problems.length) setError(problems.join('\n'));
    setStarting(false);
    if (ids.length === 0) onChanged();
  }

  function jobEnded(view: JobView) {
    const failedStep = view.steps.find((s) => s.status === 'failed');
    setEnded((now) => (now.some((e) => e.id === view.id) ? now : [...now, { id: view.id, title: view.title, ok: view.status === 'done', line: lastLine(failedStep?.output ?? view.steps.at(-1)?.output ?? '') }]));
    setRunning((now) => now.filter((j) => j !== view.id));
  }

  return (
    <Card className="mt-5">
      <CardHeader
        title="Install what is missing"
        description="Ticked: what the panel needs or recommends. Nothing installs until you click Install."
        actions={
          <Button size="sm" variant="soft" disabled={busy} onClick={() => (setHidden(true), writeHidden(true))}>
            Hide this
          </Button>
        }
      />
      <CardBody>
        <form className="grid gap-4" onSubmit={(e) => void install(e)} autoComplete="off">
          <ul className="grid gap-3">
            {missing.map((m) => (
              <li key={m.key}>
                <Checkbox
                  id={`${id}-${m.key}`}
                  checked={picked.has(m.key)}
                  disabled={busy}
                  onChange={(on) =>
                    setPicked((now) => {
                      const next = new Set(now);
                      if (on) next.add(m.key);
                      else next.delete(m.key);
                      return next;
                    })
                  }
                  label={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.label}</span>
                      <Badge tone={m.kind === 'required' ? 'danger' : m.kind === 'recommended' ? 'primary' : 'neutral'}>{m.kind}</Badge>
                      {m.fix.needsPassword && <Badge>sudo password</Badge>}
                    </span>
                  }
                  hint={m.detail}
                />
              </li>
            ))}
          </ul>
          {withPassword.length > 0 && !busy && (
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-secret`} className="text-sm font-medium">
                Your sudo password, for {withPassword.map((m) => m.label).join(', ')}
              </label>
              <div className="sm:max-w-xs">
                <SecretInput id={`${id}-secret`} value={secret} onChange={(e) => setSecret(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">The password you log in to this computer with (under Windows, the Linux password from the setup). It goes to sudo once, for this install, and the panel never saves it.</p>
            </div>
          )}
          {running.map((job) => (
            <FollowJob key={job} id={job} onEnd={jobEnded} />
          ))}
          {ended.length > 0 && running.length === 0 && (
            <ul className="grid gap-1 text-sm">
              {ended.map((e) => (
                <li key={e.id} className={cn(e.ok ? 'text-success' : 'text-danger')}>
                  {e.title}: {e.ok ? e.line || 'done' : e.line || 'it failed'}
                </li>
              ))}
            </ul>
          )}
          {error && <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-danger">{error}</pre>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || locked || chosen.length === 0}>
              {busy ? <Spinner /> : withPassword.length ? <KeyRound /> : <Download />}
              {chosen.length === 0 ? 'Install' : `Install ${chosen.length === 1 ? (chosen[0]?.label ?? '') : `${chosen.length} tools`}`}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/** One job the card started, followed until it ends. */
function FollowJob({ id, onEnd }: { id: string; onEnd: (view: JobView) => void }) {
  const runner = useJob();
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const follow = runner.follow;
  useEffect(() => {
    void follow(Promise.resolve(id));
    // Started once per job id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const job = runner.job;
  useEffect(() => {
    if (job && settled(job)) onEndRef.current(job);
  }, [job]);
  if (runner.error) return <p className="text-sm text-danger">{runner.error}</p>;
  if (!job || settled(job)) return null;
  return <JobLine job={job} />;
}

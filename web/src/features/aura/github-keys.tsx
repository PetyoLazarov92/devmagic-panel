import type { ActionId, SshKey, SshKeysReport } from '@devmagic-panel/shared';
import { ChevronRight, Copy, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { JobLine, settled, startedJobId, useJob } from '@/features/jobs/job-steps';
import { lastLine } from '@/lib/site-actions';

/**
 * Under GitHub access in Machine checks: the SSH keys here and (under WSL) in
 * Windows, each tested alone against GitHub, with what the panel can do with
 * each. Read when opened: the tests take a few seconds.
 */
export function GithubKeys({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<SshKeysReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ at: string; ok: boolean; output: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const runner = useJob();
  const ended = runner.job && settled(runner.job) ? runner.job : null;
  useEffect(() => {
    if (!ended) return;
    const failedStep = ended.steps.find((s) => s.status === 'failed');
    setResult((now) => ({ at: now?.at ?? '', ok: ended.status === 'done', output: lastLine(failedStep?.output ?? ended.steps.at(-1)?.output ?? '') || (ended.status === 'done' ? 'Done.' : `It ended ${ended.status}.`) }));
    runner.clear();
    onChanged();
    void load();
    // load is read fresh each render; the job ending is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);
  const locked = busy !== null || (runner.job !== null && !settled(runner.job));

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.sshKeys());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !report) void load();
  }

  async function run(at: string, id: ActionId, input: Record<string, unknown>) {
    setBusy(at);
    setResult(null);
    try {
      const r = await api.runAction(id, input);
      const jobId = r.ok ? startedJobId(r.output) : null;
      if (jobId) {
        // Followed here until it ends, every button of the card locked meanwhile.
        await runner.follow(Promise.resolve(jobId));
        return;
      }
      setResult({ at, ok: r.ok, output: r.output });
      if (r.ok) {
        onChanged();
        void load();
      }
    } catch (err) {
      setResult({ at, ok: false, output: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function copy(key: SshKey) {
    if (!key.publicKey) return;
    void navigator.clipboard?.writeText(key.publicKey).then(() => setCopied(key.name));
  }

  const here = report?.keys.filter((k) => k.where === 'here') ?? [];
  const windows = report?.keys.filter((k) => k.where === 'windows') ?? [];

  return (
    <div className="mt-2">
      <Button size="xs" variant="soft" onClick={toggle} aria-expanded={open}>
        <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
        SSH keys for GitHub
      </Button>
      {open && (
        <div className="mt-2 grid gap-3 rounded-md border p-3">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Testing each key against GitHub...
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {report && !loading && (
            <>
              <p className="text-xs text-muted-foreground">
                {report.way === 'https'
                  ? 'GitHub repos clone over HTTPS through the GitHub CLI now; using a key below switches back to SSH.'
                  : report.chosen
                    ? `GitHub repos clone over SSH with ${report.chosen}.`
                    : "GitHub repos clone over SSH with ssh's own choice of your keys."}{' '}
                The panel never reads a private key: it tests each one by its file, alone.
              </p>
              <KeyGroup title="In this distro (~/.ssh)" empty="No keys here yet." keys={here} report={report} busy={busy} locked={locked} copied={copied} run={run} copy={copy} />
              {report.windows === 'read' && <KeyGroup title="In Windows (%USERPROFILE%\.ssh)" empty="No keys in Windows' .ssh." keys={windows} report={report} busy={busy} locked={locked} copied={copied} run={run} copy={copy} />}
              {report.windows === 'unreachable' && <p className="text-xs text-muted-foreground">Windows' keys cannot be read right now (WSL's interop is off); Check again in a minute.</p>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={locked} onClick={() => void run('make', 'github.makeSshKey', {})}>
                  {busy === 'make' ? <Spinner /> : <KeyRound />}
                  Make a new key
                </Button>
                {report.chosen && report.way === 'ssh' && (
                  <Button size="sm" variant="soft" disabled={locked} onClick={() => void run('default', 'github.cloneWith', { way: 'ssh' })}>
                    Use ssh's own choice
                  </Button>
                )}
                <Button size="sm" variant="soft" disabled={loading} onClick={() => void load()}>
                  Check again
                </Button>
              </div>
              {runner.job && !settled(runner.job) && <JobLine job={runner.job} />}
              {runner.error && <p className="text-sm text-danger">{runner.error}</p>}
              {result && !(runner.job && !settled(runner.job)) && <Outcome result={result} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function KeyGroup({
  title,
  empty,
  keys,
  report,
  busy,
  locked,
  copied,
  run,
  copy,
}: {
  title: string;
  empty: string;
  keys: SshKey[];
  report: SshKeysReport;
  busy: string | null;
  locked: boolean;
  copied: string | null;
  run: (at: string, id: ActionId, input: Record<string, unknown>) => Promise<void>;
  copy: (key: SshKey) => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      {keys.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{empty}</p>}
      <ul className="mt-1 grid gap-2">
        {keys.map((key) => {
          const at = `${key.where}:${key.name}`;
          const chosen = key.where === 'here' && report.way === 'ssh' && report.chosen === key.name;
          return (
            <li key={at} className="rounded-md bg-muted/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-medium">{key.name}</span>
                <span className="text-xs text-muted-foreground">
                  {key.type} {key.bits}
                </span>
                {chosen && <Badge tone="primary">used for GitHub</Badge>}
                {key.windowsForGithub && <Badge>Windows uses it for github.com</Badge>}
                {key.copiedAs && <Badge>copied here as {key.copiedAs}</Badge>}
              </div>
              <p className="mt-0.5 font-mono text-2xs break-all text-muted-foreground">
                {key.fingerprint}
                {key.comment ? ` ${key.comment}` : ''}
              </p>
              <p className={cn('mt-1 text-xs', key.github ? 'text-success' : key.passphrase ? 'text-muted-foreground' : 'text-warning')}>
                {key.passphrase
                  ? key.where === 'windows'
                    ? 'Has a passphrase, which the panel cannot type: it can use it only from Windows, through its ssh-agent (a later step).'
                    : 'Has a passphrase, which the panel cannot type.'
                  : key.github
                    ? `GitHub knows this key as ${key.github}.`
                    : 'Not on GitHub: add it, then the panel can clone with it.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {key.where === 'here' && !key.passphrase && !chosen && (
                  <Button size="sm" variant="outline" disabled={locked} onClick={() => void run(at, 'github.cloneWith', { way: 'ssh', key: key.name })}>
                    {busy === at ? <Spinner /> : null}
                    Use for GitHub
                  </Button>
                )}
                {key.where === 'here' && !key.passphrase && key.github === null && (
                  <>
                    <Button size="sm" variant="outline" disabled={locked} onClick={() => void run(`${at}:add`, 'github.addSshKey', { key: key.name })}>
                      {busy === `${at}:add` ? <Spinner /> : null}
                      Add to GitHub
                    </Button>
                    <Button size="sm" variant="soft" onClick={() => copy(key)} disabled={!key.publicKey}>
                      <Copy />
                      {copied === key.name ? 'Copied' : 'Copy public key'}
                    </Button>
                    <TextLink href="https://github.com/settings/ssh/new" className="self-center text-xs">
                      GitHub's add key page
                    </TextLink>
                  </>
                )}
                {key.where === 'windows' && !key.passphrase && !key.copiedAs && (
                  <Button size="sm" variant="outline" disabled={locked} onClick={() => void run(at, 'github.copyWindowsKey', { name: key.name })}>
                    {busy === at ? <Spinner /> : null}
                    Copy into this distro
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Outcome({ result }: { result: { ok: boolean; output: string } }) {
  return <pre className={cn('max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap', result.ok ? 'text-success' : 'text-danger')}>{result.output}</pre>;
}

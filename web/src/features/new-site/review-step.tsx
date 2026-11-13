import { addressSummary, repoTarget, mountFolder, sameRepo } from '@devmagic-panel/shared';
import { allRows, repoKindLabel } from '@/lib/project-repos';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { JobScreen } from '@/features/jobs/job-screen';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { KeyValue, type KeyValueRow } from '@/components/ui/key-value';
import { Notice } from '@/components/ui/notice';
import { TextLink } from '@/components/ui/text-link';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { type CreateSiteInput, previewSteps } from '@/lib/plan';
import { navigate } from '@/lib/router';
import { Spinner } from '@/components/ui/spinner';
import { type Setter, type WizardState } from './wizard-shared';
import { addressesFor, networkFor } from './wizard-state';

export function ReviewStep({ state, set, input, dbName, cores }: { state: WizardState; set: Setter; input: CreateSiteInput; dbName: string; cores: string[] | undefined }) {
  const network = useMemo(() => networkFor(state), [state]);
  const addresses = useMemo(() => addressesFor(input, state, network), [input, state, network]);
  const steps = useMemo(() => previewSteps(input, dbName, state.upload?.name, cores, addresses), [input, dbName, state.upload?.name, cores, addresses]);
  const summary = addressSummary(addresses, input.network?.layout);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="h-fit">
        <CardBody className="gap-3 p-5">
          <KeyValue labelWidth="sm" className="gap-y-3" rows={reviewRows(input, state, network, summary, dbName)} />
          {input.repos.length > 0 && (
            <div className="border-t pt-3">
              <span className="flex items-center gap-2.5 font-medium">
                <Switch checked={state.remember} label="Remember these answers for this repo" onChange={(on) => set('remember', on)} />
                Remember these answers for this repo
              </span>
              <p className="mt-1 text-xs text-muted-foreground">The next install of it fills itself from them. See or forget them in <TextLink href="/settings">Settings</TextLink>.</p>
            </div>
          )}
        </CardBody>
      </Card>
      <div>
        <p className="text-sm font-medium">The panel will run {steps.length} steps</p>
        <ol className="mt-3 grid gap-1.5 text-sm">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-3">
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">If a step fails, the run stops. You can retry from that step or undo everything it created.</p>
      </div>
    </div>
  );
}

/** What the install is about to do, as label and value: the rows the answers call for. */
export function reviewRows(input: CreateSiteInput, state: WizardState, network: ReturnType<typeof networkFor>, summary: string | null | undefined, dbName: string): KeyValueRow[] {
  const when = (on: unknown, label: string, value: ReactNode): KeyValueRow[] => (on ? [{ label, value }] : []);
  // What each repo is (a theme or plugin by its header), next to where it goes.
  const rows = allRows(state);
  const kindOf = (r: CreateSiteInput['repos'][number]) => {
    const row = rows.find((x) => sameRepo(x.url, r.url));
    return repoKindLabel(row?.helpers, row?.kind, { dir: r.dir, folder: r.folder });
  };
  return [
    ...(input.path
      ? [
          { label: 'Address', value: <span className="font-mono">https://{input.domain}{input.path}/</span> },
          { label: 'Folder', value: <span className="font-mono">/var/www/{mountFolder(input.domain, input.path)}</span> },
        ]
      : [{ label: 'Primary domain', value: <span className="font-mono">{input.domain}</span> }]),
    ...when(input.aliases.length > 0, 'Aliases', input.aliases.map((a) => <span key={a} className="block font-mono">{a}</span>)),
    ...input.repos.map((r, i) => ({
      key: `${r.url}|${repoTarget(r)}`,
      label: input.repos.length > 1 ? (i === 0 ? 'Main repo' : 'Repo') : 'Repo',
      value: (
        <>
          <span className="font-mono break-all">{r.url}</span> <span className="text-muted-foreground">({r.branch}) into </span>
          <span className="font-mono break-all">{repoTarget(r) || 'the site root'}</span>
          {kindOf(r) && <span className="block text-xs text-muted-foreground">{kindOf(r)}</span>}
        </>
      ),
    })),
    ...when(state.upload, 'Dump', state.upload && <>{state.upload.name} <span className="text-muted-foreground">({bytes(state.upload.size)})</span></>),
    ...when(input.replace.length > 0, 'Replace', input.replace.map((r) => <span key={r.from} className="block font-mono text-dense">{r.from} → {r.to}</span>)),
    ...when(
      network,
      'Network',
      network && (
        <>
          {network.rows.length} sites, {network.layout === 'keep' ? 'each where the dump has it' : network.layout === 'subdirectory' ? `subdirectory network on ${input.domain}` : 'subdomain network'}
          {network.moves.length === 0
            ? <span className="text-muted-foreground">, nothing moves</span>
            : network.moves.map((m) => {
                const name = network.rows.find((r) => r.site.id === m.id)?.site.name;
                return <span key={m.id} className="block font-mono text-dense" title={name}>{m.from.domain}{m.from.path} → {m.to.domain}{m.to.path}</span>;
              })}
        </>
      ),
    ),
    ...when(state.upload, 'Search and replace', summary ?? <span className="text-muted-foreground">skipped: every address in the dump already answers here on https</span>),
    ...when(input.core, 'WordPress', input.core && (input.core.mode === 'repo' ? `the repo's own${input.core.version ? `, ${input.core.version}` : ''}` : `${input.core.version ?? ''} · ${input.core.mode === 'wpcore' ? 'shared core' : 'own copy'}`)),
    ...when(input.core, 'Database', <span className="font-mono">{dbName}</span>),
    ...when(
      input.admin,
      'Admin',
      input.admin && (input.source !== 'repo'
        ? input.admin.user
        : input.admin.ifExists === 'keep' && input.admin.ifMissing === 'skip'
          ? <span className="text-muted-foreground">none added; the database's users stay</span>
          : <>
              {input.admin.user}
              <span className="text-muted-foreground">
                {input.admin.ifExists === 'keep' ? ': left as it is when the database has it' : ': gets this password and the admin role when the database has it'}
                {input.admin.ifMissing === 'create' ? ', created when it does not' : ', not created when it does not'}
              </span>
            </>),
    ),
    ...when(input.uploadsFrom, 'Uploads', <>missing files load from {input.uploadsFrom}</>),
    ...when(input.repos.length > 0 && state.inspection.status === 'found', 'Settings', 'from your last install of this repo'),
    ...when(input.repos.length > 0 && state.inspection.status === 'claude', 'Settings', 'filled by Claude, reviewed by you'),
  ];
}

// ── Install ──────────────────────────────────────────────────


export function RunScreen({ input, onBack }: { input: CreateSiteInput; onBack: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The job's own page shows the progress, so it can be found again from the header after leaving.
    api.createSite(input).then((id) => {
      setJobId(id);
      navigate(`/jobs/${encodeURIComponent(id)}`);
    }, (err: Error) => setError(err.message));
    // Starts once per mount; StrictMode's second mount is skipped by the ref.
  }, []);

  if (error) {
    return (
      <Notice tone="danger" className="max-w-3xl">
        <p className="font-medium">The install did not start</p>
        <p className="mt-1 text-foreground">{error}</p>
        <Button variant="outline" className="mt-3 text-foreground" onClick={onBack}>Back to the answers</Button>
      </Notice>
    );
  }
  if (!jobId) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Starting the install...</p>;
  return <JobScreen jobId={jobId} wordpress={input.source !== 'empty'} />;
}

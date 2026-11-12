import type { OrgStatus, RcloneRemotes, RemoteEntry, ServerSignIn, ServerTables, Site, SnapshotInfo, TrashEntry, UploadResult } from '@devmagic-panel/shared';
import { defaultLeftOut, isWpCliCommand, knownLeftOut, splitSshHost } from '@devmagic-panel/shared';
import { TablesPicker } from '@/features/database/tables-picker';
import { ChevronRight, CircleAlert, Cloud, FileArchive, FolderOpen, Globe, HardDrive, HardDriveDownload, KeyRound, RefreshCw, Server, ShieldCheck, Sparkles, Table2, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { CopyChoice, findings } from '@/features/database/copy-choice';
import { DumpFactsCard } from '@/features/new-site/dump-facts';
import { settled, StepList, useJob } from '@/features/jobs/job-steps';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChips } from '@/components/ui/filter-chips';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { Segmented } from '@/components/ui/segmented';
import { Checkbox, Select } from '@/components/ui/field';
import { TextLink } from '@/components/ui/text-link';
import { api, isMockup } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { asideUploads } from '@/lib/org-repos';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { WizardState } from './wizard-shared';
import { applyOrgAnswers, PrefillSummary } from './org';
import { Spinner } from '@/components/ui/spinner';

type SetState = (update: (s: WizardState) => WizardState) => void;

/** Where the dump comes from. */
export type DumpSource = 'claude' | 'upload' | 'downloads' | 'cloud' | 'url' | 'server' | 'local' | 'none';

/** A Drive file's page, where it opens and downloads in the browser. */
const driveUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

/**
 * The wizard with a dump in: every address it uses mapped to a local name,
 * and, when Claude read the repo, the build and notes from its docs.
 */
export function withDump(state: WizardState, upload: UploadResult, cores: string[]): WizardState {
  if (state.org?.read.facts && state.org.repo) return { ...applyOrgAnswers(state, upload, cores), noDump: false };
  // Every address the dump uses with its local name; a dump that suggests none puts its own address in the first row.
  const host = upload.facts.hosts[0];
  const domains = upload.suggestions.replace.length
    ? upload.suggestions.replace.map((r) => ({ prod: r.from, local: r.to }))
    : host
      ? state.domains.map((d, i) => (i === 0 ? { ...d, prod: host } : d))
      : state.domains;
  return { ...state, upload, noDump: false, domains };
}

/** The dump a job brought in, from its output: "upload <id>". */
const uploadOf = (output: string) => /\bupload ([0-9a-f-]{36})\b/.exec(output)?.[1];

/**
 * The Database step: where the dump comes from. The dumps Claude found in
 * Drive when it read the links; an upload; your Downloads folder; any
 * rclone remote, or a Google Drive link; a public https:// address; or no
 * dump at all, for a fresh install on the repo's code. Every way ends the
 * same: a file in the panel's uploads, checked by its first bytes and read
 * for its facts.
 */
export function DatabaseStep({ state, setState, status, cores, draftId, saveNow }: {
  state: WizardState;
  setState: SetState;
  status: OrgStatus | null;
  cores: string[];
  draftId: string;
  saveNow: () => Promise<unknown>;
}) {
  const found = state.org?.access.report?.dumps ?? [];
  const source: DumpSource = state.dumpSource ?? (found.length ? 'claude' : 'upload');
  const setClean = (cleanCopy: boolean) => setState((s) => ({ ...s, cleanCopy }));
  const setSource = (dumpSource: DumpSource) => setState((s) => ({ ...s, dumpSource, noDump: dumpSource === 'none' }));
  const job = useJob();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = job.job !== null && !settled(job.job);

  // Back from another page while a dump came in: follow its download, or take the dump it brought.
  useEffect(() => {
    if (state.upload || !draftId) return;
    let live = true;
    void (async () => {
      const draft = await api.draft(draftId).catch(() => null);
      const noted = draft?.jobs?.dump;
      const view = noted ? await api.job(noted.id).catch(() => null) : null;
      if (!live || !draft) return;
      if (view && !settled(view)) return void job.follow(Promise.resolve(view.id));
      const aside = asideUploads(state.org);
      const kept = draft.attached?.filter((u) => !aside.includes(u)).at(-1);
      if (kept) api.uploadInfo(kept).then((up) => live && setState((s) => (s.upload ? s : withDump(s, up, cores))), () => undefined);
    })();
    return () => {
      live = false;
    };
  }, []);

  // A dump job that finished hands its upload to the wizard.
  useEffect(() => {
    if (!job.job || job.job.status !== 'done') return;
    const id = uploadOf(job.job.steps.map((s) => s.output ?? '').join('\n'));
    if (!id) return;
    api.uploadInfo(id).then((upload) => setState((s) => withDump(s, upload, cores)), (err: Error) => setError(err.message));
  }, [job.job?.status]);

  // Each download runs as a job noted on the draft, so the draft is saved first.
  const start = async (id: Parameters<typeof api.startJob>[0], input: Record<string, unknown>) => {
    setError(null);
    await saveNow().catch(() => undefined);
    void job.follow(api.startJob(id, { ...input, draftId }));
  };

  function another() {
    const previous = state.upload?.id;
    if (previous) void api.deleteUpload(previous).catch(() => undefined);
    setState((s) => {
      if (!s.org) return { ...s, upload: null };
      const { prefill: _old, ...org } = s.org;
      return { ...s, upload: null, org };
    });
  }

  if (state.upload) {
    return (
      <div className="grid max-w-4xl gap-4">
        {state.org?.prefill ? (
          <PrefillSummary prefill={state.org.prefill} upload={state.upload} onChange={another} />
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm font-medium">
              <FileArchive className="size-4 text-success" />
              {state.upload.name} ({bytes(state.upload.size)}) is in; the next steps are filled from it.
              <Button variant="soft" size="sm" onClick={another}>Pick another dump</Button>
            </p>
            <DumpFactsCard facts={state.upload.facts} />
          </>
        )}
        <div className="rounded-lg border bg-card px-4 py-3">
          <CopyChoice id="clean-copy" clean={Boolean(state.cleanCopy)} onChange={setClean} removed={findings(state.upload)} keeps="the WordPress step's admin" />
        </div>
      </div>
    );
  }

  const options: Array<{ value: DumpSource; title: string; text: string; icon: ReactNode; show: boolean }> = [
    { value: 'claude', title: 'Found by Claude', text: `${found.length} ${found.length === 1 ? 'dump' : 'dumps'} in Google Drive, from the linked docs`, icon: <Sparkles />, show: found.length > 0 },
    { value: 'upload', title: 'Upload', text: '.sql, .sql.gz or .zip from this computer', icon: <Upload />, show: true },
    { value: 'downloads', title: 'Downloads folder', text: 'A dump you downloaded in the browser', icon: <FolderOpen />, show: true },
    { value: 'cloud', title: 'Cloud drive', text: 'Google Drive, Dropbox, OneDrive, S3, SFTP and more, through rclone', icon: <Cloud />, show: true },
    { value: 'url', title: 'Public URL', text: 'Any https:// address that serves the file', icon: <Globe />, show: true },
    { value: 'server', title: 'A server over SSH', text: 'A dump file there, or a fresh export with WP-CLI', icon: <Server />, show: true },
    { value: 'local', title: 'This machine', text: "Another site's database, a snapshot, or a deleted site", icon: <HardDrive />, show: true },
    { value: 'none', title: 'No database', text: 'A fresh WordPress on the repo code', icon: <HardDriveDownload />, show: true },
  ];

  return (
    <div className="grid max-w-5xl gap-5">
      <div role="radiogroup" aria-label="Where the dump comes from" className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.filter((o) => o.show).map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={source === o.value}
            onClick={() => setSource(o.value)}
            className={cn('flex items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:border-primary/50 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground', source === o.value && 'border-primary bg-primary/6 shadow-[0_0_0_1px_var(--primary)] [&>svg]:text-primary')}
          >
            {o.icon}
            <span className="grid gap-0.5">
              <span className="font-medium">{o.title}</span>
              <span className="text-xs text-muted-foreground">{o.text}</span>
            </span>
          </button>
        ))}
      </div>

      <Card className="p-4 text-sm">
        {source === 'claude' && <ClaudeDumps found={found} status={status} working={working} onDownload={(d) => void start('dump.download', { fileId: d.fileId, name: d.name, ...(d.sizeBytes !== null ? { sizeBytes: d.sizeBytes } : {}) })} />}
        {source === 'upload' && <UploadDump onUpload={(up) => setState((s) => withDump(s, up, cores))} />}
        {source === 'downloads' && <FromDownloads working={working} onUse={(file) => void start('dump.useDownloaded', { file })} />}
        {source === 'cloud' && <FromCloud working={working} onRemote={(remote, entry) => void start('dump.fromRemote', { remote, path: entry.path, ...(entry.sizeBytes !== null ? { sizeBytes: entry.sizeBytes } : {}) })} onDriveLink={(link) => void start('dump.download', { link })} />}
        {source === 'url' && <FromUrl working={working} onFetch={(url) => void start('dump.fetch', { url })} />}
        {source === 'server' && (
          <FromServer
            working={working}
            clean={Boolean(state.cleanCopy)}
            setClean={setClean}
            onTake={(input) => {
              // An export names the WordPress folder there: missing plugins can be copied from it later. The password stays in memory only.
              setState((s) => ({ ...s, serverFrom: input.mode === 'export' ? { host: input.host, folder: input.path, ...(input.wpCli ? { wpCli: input.wpCli } : {}) } : null, serverSecret: input.password ?? null, serverHas: null }));
              void start('dump.fromServer', input);
            }}
          />
        )}
        {source === 'local' && <FromThisMachine working={working} onTake={(input) => void start('dump.fromLocal', input)} />}
        {source === 'none' && (
          <p className="text-muted-foreground">
            The install makes empty tables and installs WordPress on the repo's code, with the admin from the WordPress step. Nothing is imported, so no address is replaced and no plugin is turned off.
          </p>
        )}
        {job.job && <div className="mt-4 border-t pt-3"><StepList steps={job.job.steps} open={openStep} setOpen={setOpenStep} /></div>}
        {(job.error || error) && <p role="alert" className="mt-3 text-danger">{job.error ?? error}</p>}
      </Card>
    </div>
  );
}

function ClaudeDumps({ found, status, working, onDownload }: {
  found: Array<{ fileId: string; name: string; sizeBytes: number | null; modifiedAt: string | null; foundIn: string }>;
  status: OrgStatus | null;
  working: boolean;
  onDownload: (d: { fileId: string; name: string; sizeBytes: number | null }) => void;
}) {
  const [chosen, setChosen] = useState(found[0]?.fileId ?? null);
  const dump = found.find((d) => d.fileId === chosen);
  return (
    <div className="grid gap-3">
      <ul role="radiogroup" aria-label="Dumps Claude found" className="grid gap-2">
        {found.map((d) => (
          <li key={d.fileId}>
            <button type="button" role="radio" aria-checked={chosen === d.fileId} onClick={() => setChosen(d.fileId)} className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-left', chosen === d.fileId && 'border-primary ring-3 ring-primary/15')}>
              <FileArchive className="size-4 text-muted-foreground" />
              <span className="font-mono text-dense">{d.name}</span>
              <span className="text-xs text-muted-foreground">{[d.sizeBytes !== null ? bytes(d.sizeBytes) : null, d.modifiedAt ? shortDate(d.modifiedAt) : null, d.foundIn].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {dump && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {status?.rclone.remote ? (
            <Button disabled={working} onClick={() => onDownload(dump)}>
              {working ? <Spinner /> : <FileArchive />}
              Download it with rclone
            </Button>
          ) : (
            <span className="text-muted-foreground">rclone has no Google Drive remote, so download it in the browser and pick it under Downloads folder.</span>
          )}
          <TextLink href={driveUrl(dump.fileId)}>Open in Google Drive</TextLink>
        </div>
      )}
    </div>
  );
}

function UploadDump({ onUpload }: { onUpload: (up: UploadResult) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    setProgress(0);
    try {
      onUpload(await api.upload(f, setProgress));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={progress !== null}
        onClick={() => file.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void pick(e.dataTransfer.files[0]);
        }}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:cursor-progress"
      >
        {progress !== null ? (
          <>
            <Spinner className="size-6 text-primary" />
            <span className="font-medium">{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Reading the dump...'}</span>
          </>
        ) : (
          <>
            <Upload className="size-6 text-muted-foreground" />
            <span><span className="font-medium">Drop a dump here</span> or click to choose</span>
            <span className="text-xs text-muted-foreground">.sql, .sql.gz or .zip, up to 20 GB. It stays on this machine.{isMockup ? ' Mockup: any file works.' : ''}</span>
          </>
        )}
      </button>
      <input ref={file} type="file" accept=".sql,.gz,.zip" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} tabIndex={-1} />
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    </div>
  );
}

function FromDownloads({ working, onUse }: { working: boolean; onUse: (file: string) => void }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.downloads>> | null>(null);
  const [loading, setLoading] = useState(true);
  const read = () => {
    setLoading(true);
    api.downloads().then(setList, () => setList([])).finally(() => setLoading(false));
  };
  useEffect(read, []);
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 font-medium">
        Dumps from the last three days
        <Button variant="soft" size="sm" onClick={read}><RefreshCw className={cn(loading && 'animate-spin')} />Look again</Button>
      </p>
      {list && list.length === 0 && <p className="text-muted-foreground">No .sql, .sql.gz or .zip there yet. Download one in the browser, then look again.</p>}
      <ul className="grid gap-1.5">
        {(list ?? []).map((d) => (
          <li key={d.file} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-dense">{d.name}</span>
            <span className="text-xs text-muted-foreground">{bytes(d.sizeBytes)} · {timeAgo(d.modifiedAt)}</span>
            <Button size="sm" variant="outline" disabled={working} onClick={() => onUse(d.file)}>Use this file</Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Your file stays where it is; the panel takes a link or a copy.</p>
    </div>
  );
}

/** rclone's remotes: browse one for a dump, or paste a Google Drive link. */
function FromCloud({ working, onRemote, onDriveLink }: { working: boolean; onRemote: (remote: string, entry: RemoteEntry) => void; onDriveLink: (link: string) => void }) {
  const [remotes, setRemotes] = useState<RcloneRemotes | null>(null);
  const [remote, setRemote] = useState('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  useEffect(() => {
    api.rcloneRemotes().then((r) => {
      setRemotes(r);
      setRemote((now) => now || r.remotes[0]?.name || '');
    }, (err: Error) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!remote) return;
    setEntries(null);
    setError(null);
    api.remoteList(remote, path).then(setEntries, (err: Error) => setError(err.message));
  }, [remote, path]);

  if (!remotes) return <p className="flex items-center gap-2 text-muted-foreground"><Spinner className="size-4" />Asking rclone for its remotes...</p>;
  if (!remotes.installed || remotes.remotes.length === 0) {
    return (
      <div className="grid gap-2">
        <p className="flex items-center gap-2 font-medium"><CircleAlert className="size-4 text-warning" />{remotes.installed ? 'rclone has no remote yet' : 'rclone is not installed'}</p>
        <p className="text-muted-foreground">
          rclone reaches Google Drive, Dropbox, OneDrive, S3, SFTP, WebDAV and more, each with its own sign-in that the panel never reads.{' '}
          {remotes.installed ? <>Add one in a terminal with <code className="font-mono text-foreground">rclone config</code>, then come back.</> : <>Install it with <code className="font-mono text-foreground">sudo apt install rclone</code>, add a remote with <code className="font-mono text-foreground">rclone config</code>, then come back.</>}{' '}
          Aura's <TextLink href="/aura/machine">Machine checks</TextLink> show where it stands. Until then, download the file in the browser and use Downloads folder.
        </p>
      </div>
    );
  }
  const drive = remotes.remotes.find((r) => r.type === 'drive');
  const parts = path ? path.split('/') : [];
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Remote</span>
          <FilterChips
            label="Remote"
            value={remote}
            onChange={(name) => { setRemote(name); setPath(''); }}
            options={remotes.remotes.map((r) => ({ value: r.name, label: `${r.name} (${r.type})` }))}
          />
        </div>
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 font-mono text-xs">
          <Button variant="ghost" size="xs" className="h-6 px-1 text-primary" onClick={() => setPath('')}>{remote}:</Button>
          {parts.map((p, i) => (
            <span key={`${p}${i}`} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-muted-foreground" />
              <Button variant="ghost" size="xs" className="h-6 px-1 text-primary" onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{p}</Button>
            </span>
          ))}
        </nav>
        {error && <p role="alert" className="text-danger">{error}</p>}
        {!entries && !error && <p className="flex items-center gap-2 text-muted-foreground"><Spinner className="size-4" />Reading the folder...</p>}
        {entries && (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {entries.length === 0 && <li className="text-muted-foreground">No folders or dumps here.</li>}
            {entries.map((e) => (
              <li key={e.path} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/50">
                {e.dir ? (
                  <Button variant="ghost" size="xs" className="-mx-2 gap-2 text-sm" onClick={() => setPath(e.path)}><FolderOpen className="text-muted-foreground" />{e.name}/</Button>
                ) : (
                  <>
                    <FileArchive className="size-4 text-muted-foreground" />
                    <span className="font-mono text-dense">{e.name}</span>
                    <span className="text-xs text-muted-foreground">{[e.sizeBytes !== null ? bytes(e.sizeBytes) : null, e.modifiedAt ? shortDate(e.modifiedAt) : null].filter(Boolean).join(' · ')}</span>
                    <Button size="sm" variant="outline" disabled={working} onClick={() => onRemote(remote, e)}>Download</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-2 border-t pt-3">
        <label htmlFor="drive-link" className="font-medium">Or paste a link to a Google Drive file</label>
        <div className="flex gap-2">
          <Input id="drive-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/file/d/.../view" className="font-mono text-dense" spellCheck={false} disabled={!drive} />
          <Button variant="outline" disabled={!drive || working || !/^https:\/\/(drive|docs)\.google\.com\//.test(link.trim())} onClick={() => onDriveLink(link.trim())}>Download</Button>
        </div>
        <p className="text-xs text-muted-foreground">{drive ? `Through ${drive.name}, with your own Google sign-in in rclone; the file keeps its name.` : 'Needs an rclone remote of type drive: add one with rclone config.'}</p>
      </div>
    </div>
  );
}

function FromUrl({ working, onFetch }: { working: boolean; onFetch: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const ok = /^https:\/\/[^\s@/]+\/\S*$/.test(url.trim());
  return (
    <div className="grid gap-3">
      <label htmlFor="dump-url" className="font-medium">The dump's address</label>
      <div className="flex gap-2">
        <Input id="dump-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://files.spellbook.example/backups/spellbook.sql.gz" className="font-mono text-dense" spellCheck={false} aria-invalid={url.trim() !== '' && !ok ? true : undefined} />
        <Button disabled={!ok || working} onClick={() => onFetch(url.trim())}>
          {working ? <Spinner /> : <HardDriveDownload />}
          Download
        </Button>
      </div>
      {url.trim() !== '' && !ok && <p className="text-xs text-danger">An https:// address, with no user name or password in it.</p>}
      <ul className="grid gap-1 text-xs text-muted-foreground">
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />Only https://, never an address on this computer or a private network, and at most five redirects, each checked again.</li>
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />The free space and the 20 GB limit are checked before and while it downloads, and it stops unless it starts like SQL, a gzip or a zip.</li>
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />Signed links work; the part after ? is never kept or shown. A link that needs a sign-in does not: download it in the browser and use Downloads folder.</li>
      </ul>
    </div>
  );
}

/** A dump from a server over SSH: your own ssh config and agent, a fixed read-only command. */
/** A copy from a server over SSH: a dump file there, or an export now with the rows of some tables left out. */
export function FromServer({ working, clean, setClean, onTake, initial, takeLabel, exportOnly, actions, more }: {
  working: boolean;
  /** Clean the copy after the import; undefined where the caller has no such step. */
  clean?: boolean;
  setClean?: (on: boolean) => void;
  onTake: (input: { host: string; mode: 'file' | 'export'; path: string; excludeRows: string[]; password?: string; wpCli?: string }) => void;
  initial?: { host: string; path: string; excludeRows: string[]; wpCli?: string | undefined };
  takeLabel?: string;
  /** Only an export with WP-CLI, as Refresh from production runs it. */
  exportOnly?: boolean;
  /** More buttons beside the one that takes it, like Cancel. */
  actions?: ReactNode;
  /** More fields of the caller's, above the buttons. */
  more?: ReactNode;
}) {
  const uid = useId();
  const [host, setHost] = useState(initial?.host ?? '');
  // The server's password, when it asks for one: for the runs started from here, kept only when you save it for the host.
  const [secret, setSecret] = useState('');
  // WP-CLI's command there, when it is not wp.
  const [wpCli, setWpCli] = useState(initial?.wpCli ?? '');
  const wpCliOk = wpCli.trim() === '' || isWpCliCommand(wpCli.trim());
  const [mode, setMode] = useState<'export' | 'file'>('export');
  const command = mode === 'export' && wpCli.trim() ? { wpCli: wpCli.trim() } : {};
  const [path, setPath] = useState(initial?.path ?? '');
  const [found, setFound] = useState<ServerTables | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>(initial?.excludeRows ?? []);
  const hostOk = splitSshHost(host.trim()) !== null;
  const pathOk = /^\/[A-Za-z0-9._/-]+$/.test(path.trim()) && !path.split('/').includes('..') && (mode === 'export' || /\.(sql|sql\.gz|zip)$/i.test(path.trim()));
  // Another server or folder has other tables.
  const where = `${host.trim()}|${path.trim()}`;
  const [readFor, setReadFor] = useState('');
  const tables = found && readFor === where ? found : null;
  const readTables = async () => {
    setReading(true);
    setReadError(null);
    try {
      const answer = await api.serverTables(host.trim(), path.trim(), secret || undefined, command.wpCli);
      setFound(answer);
      setReadFor(where);
      setLeftOut(initial && initial.host === host.trim() && initial.path === path.trim() && initial.excludeRows.length ? initial.excludeRows : defaultLeftOut(answer, Boolean(clean)));
    } catch (error) {
      setReadError((error as Error).message);
    } finally {
      setReading(false);
    }
  };
  const preset = (cleaned: boolean) => {
    setClean?.(cleaned);
    if (tables) setLeftOut(cleaned ? [...new Set([...leftOut, ...tables.logs, ...tables.personal])] : leftOut.filter((t) => !tables.personal.includes(t)));
  };
  // Tables not read again keep what was saved for this server and folder.
  const same = initial !== undefined && initial.host === host.trim() && initial.path === path.trim();
  const excludeRows = mode !== 'export' ? [] : tables ? leftOut.filter((t) => tables.tables.some((x) => x.name === t)) : same ? initial.excludeRows : [];
  return (
    <div className="@container grid gap-3">
      <div className="grid gap-3 @xl:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <label htmlFor={`${uid}-host`} className="font-medium">Host</label>
          <Input id={`${uid}-host`} value={host} onChange={(e) => setHost(e.target.value)} placeholder="staging-spellbook or alex@www.spellbook.example" className="font-mono text-dense" spellCheck={false} aria-invalid={host.trim() !== '' && !hostOk ? true : undefined} />
          <p className="text-xs text-muted-foreground">An alias from your ~/.ssh/config, or user@host. Another port goes after it: user@host:2222.</p>
          <ServerPassword id={`${uid}-secret`} host={host.trim()} value={secret} onChange={setSecret} />
        </div>
        <div className={cn('grid content-start gap-1.5', exportOnly && 'hidden')}>
          <span className="font-medium">What to take</span>
          <Segmented label="What to take" value={mode} onChange={setMode} options={[['export', 'Export now with WP-CLI'], ['file', 'A dump file there']]} className="h-10 justify-self-start" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${uid}-path`} className="font-medium">{mode === 'export' ? 'The WordPress folder on the server' : 'The dump on the server'}</label>
        {/* The path gets the whole width, as long ones are usual; its buttons sit under it. */}
        <Input id={`${uid}-path`} value={path} onChange={(e) => setPath(e.target.value)} placeholder={mode === 'export' ? '/var/www/spellbook/public' : '/home/alex/backups/spellbook.sql.gz'} className="font-mono text-dense" spellCheck={false} aria-invalid={path.trim() !== '' && !pathOk ? true : undefined} />
        {mode === 'export' && (
          <details className="text-xs" open={wpCli !== '' ? true : undefined}>
            <summary className="cursor-pointer font-medium text-primary">WP-CLI has another name on the server?</summary>
            <div className="mt-2 grid gap-1.5">
              <label htmlFor={`${uid}-wpcli`} className="text-sm font-medium text-foreground">WP-CLI command</label>
              <Input id={`${uid}-wpcli`} value={wpCli} onChange={(e) => setWpCli(e.target.value)} placeholder="wp" className="font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={!wpCliOk ? true : undefined} />
              <p className={wpCliOk ? 'text-muted-foreground' : 'text-danger'}>
                {wpCliOk ? 'Empty means wp. Some hosts name it wp-cli, or keep it at a path like ~/bin/wp.' : 'A program name or path only, like wp-cli or ~/bin/wp: no spaces or options.'}
              </p>
            </div>
          </details>
        )}
        {mode === 'export' && (
          <Button variant="outline" className="justify-self-start" disabled={!hostOk || !pathOk || !wpCliOk || reading || working} onClick={() => void readTables()}>
            {reading ? <Spinner /> : <Table2 />}
            {tables ? 'Read the tables again' : 'Choose tables to leave out'}
          </Button>
        )}
        {path.trim() !== '' && !pathOk && <p className="text-xs text-danger">An absolute path with letters, digits and . _ - / only{mode === 'file' ? ', ending in .sql, .sql.gz or .zip' : ''}.</p>}
        {readError && <p role="alert" className="text-xs text-danger">{readError}</p>}
        {!tables && same && excludeRows.length > 0 && <p className="text-xs text-muted-foreground">The rows of {excludeRows.length} table{excludeRows.length === 1 ? '' : 's'} stay on the server, as saved: {excludeRows.join(', ')}.</p>}
      </div>
      {setClean && (
        <div className="grid gap-1.5">
          <span className="font-medium">The copy</span>
          <Segmented label="The copy" value={clean ? 'clean' : 'whole'} onChange={(v) => preset(v === 'clean')} options={[['whole', 'As it is'], ['clean', 'Cleaned']]} className="justify-self-start" />
          <p className="text-xs text-muted-foreground">
            {clean
              ? 'After the import: every user but one, WooCommerce orders and customer data, reviews, form entries, logs and payment, mail and API keys go, with SQL here. Ticking the personal-data tables below keeps their rows on the server as well.'
              : 'Every user, order and key comes as production has it; only the tables you tick stay behind.'}
          </p>
        </div>
      )}
      {mode === 'export' && tables && (
        <div className="grid gap-1.5">
          <span className="font-medium">Leave out the rows of</span>
          {tables.tables.length === 0 && <p className="text-xs text-muted-foreground">WP-CLI listed no tables there.</p>}
          <TablesPicker found={tables} value={leftOut} onChange={setLeftOut} />
        </div>
      )}
      {more}
      <ul className="grid gap-1 text-xs text-muted-foreground">
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />Your SSH key through your agent, or the server's password for this run only, unless you save it for the host; a host not in your known_hosts is refused, not trusted on the fly.</li>
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />{mode === 'export' ? 'Runs only wp db export (and wp db size for the tables) on the server: it reads, writes no file there, and the database password stays there. Compressed on the way.' : 'Copies the file with sftp; nothing runs on the server.'}</li>
      </ul>
      {/* The button that takes it comes last, once everything above is chosen. */}
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button disabled={!hostOk || !pathOk || !wpCliOk || working || reading} onClick={() => onTake({ host: host.trim(), mode, path: path.trim(), excludeRows, ...(secret ? { password: secret } : {}), ...command })}>
          {working ? <Spinner /> : <Server />}
          {takeLabel ?? (mode === 'export' ? 'Export' : 'Copy')}
        </Button>
        {actions}
      </div>
    </div>
  );
}

/**
 * How the server signs you in, and the field for its password only when it
 * would ask for one. Asked once you stop typing a host (`auto`, the wizard);
 * for a site's saved server only the last answer is shown, so opening a view
 * connects to nothing, and Check connection asks again. The server keeps an
 * answer for an hour. A password typed here goes with this run only, unless
 * you save it for the host: then the panel keeps it (secrets.json, 0600) and
 * never shows it back, an empty field uses it, and a new one replaces it.
 * SecretInput keeps it from the browser's and every password manager's saved passwords.
 */
export function ServerPassword({ id, host, value, onChange, auto = true }: { id: string; host: string; value: string; onChange: (value: string) => void; auto?: boolean }) {
  const ok = splitSshHost(host) !== null;
  const [answer, setAnswer] = useState<{ host: string; signIn: ServerSignIn | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!ok) return;
    let live = true;
    // Once you stop typing the host; for a saved server, the last answer at once, without connecting.
    const timer = window.setTimeout(() => {
      api.serverSignIn(host, auto ? {} : { last: true }).then(
        (signIn) => live && setAnswer({ host, signIn }),
        () => live && setAnswer({ host, signIn: null }),
      );
    }, auto ? 700 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [host, ok, auto]);
  // A password typed for one host never goes to another.
  useEffect(() => {
    if (value !== '') onChange('');
  }, [host]);
  if (!ok) return null;

  const check = () => {
    setChecking(true);
    api.serverSignIn(host, { fresh: true }).then(
      (signIn) => setAnswer({ host, signIn }),
      () => setAnswer({ host, signIn: null }),
    ).finally(() => setChecking(false));
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.saveSshPassword(host, value);
      onChange('');
      setAnswer((a) => (a && a.host === host && a.signIn ? { host, signIn: { ...a.signIn, saved: true } } : a));
      toast({ tone: 'success', title: `Password saved for ${host}`, detail: 'Runs that sign in there use it until you replace it or forget it.' });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save the password', detail: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const forget = async () => {
    setSaving(true);
    try {
      await api.forgetSshPassword(host);
      setAnswer((a) => (a && a.host === host && a.signIn ? { host, signIn: { ...a.signIn, saved: false } } : a));
      toast({ tone: 'success', title: `Password forgotten for ${host}` });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not forget the password', detail: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const known = answer?.host === host ? answer : null;
  if (!known) return auto ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3.5" />Checking how {host} signs you in...</p> : null;
  const how = known.signIn?.how;
  const saved = known.signIn?.saved === true;
  const when = known.signIn?.checkedAt ? ` Checked ${timeAgo(known.signIn.checkedAt)}.` : '';
  const checkButton = (
    <Button size="xs" variant="soft" disabled={checking} onClick={check}>
      {checking ? <Spinner /> : <RefreshCw />}
      {how === 'unchecked' ? 'Check connection' : 'Check again'}
    </Button>
  );
  const status =
    how === 'key' ? <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5 shrink-0 text-success" />Your SSH key signs in to {host}: no password is needed.{when}</span>
    : how === 'password' ? <span>{host} asks for a password: your SSH key does not sign in there.{when}</span>
    : how === 'unchecked' ? <span>Not checked in the last hour how {host} signs you in.</span>
    : how === 'refused' || how === 'unknown' ? <span role="alert" className="flex items-start gap-1.5 text-warning"><CircleAlert className="mt-px size-3.5 shrink-0" />{known.signIn?.problem}</span>
    : <span>The panel could not check how {host} signs you in: give its password only if it asks for one.</span>;
  // The field shows when the server asks for a password, when the panel could not tell, and while one is saved.
  const field = how === 'password' || how === undefined || saved || (how === 'unchecked' && !auto);
  return (
    <div className="grid gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground">
        {status}
        {checkButton}
      </div>
      {field && (
        <div className="grid gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-foreground">Password on the server</label>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-48 flex-1">
              <SecretInput id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? 'Saved: type to replace' : undefined} />
            </div>
            {value !== '' && (
              <Button variant="outline" className="h-10" disabled={saving} onClick={() => void save()}>
                {saving ? <Spinner /> : <KeyRound />}
                {saved ? 'Replace saved' : `Save for ${host}`}
              </Button>
            )}
            {saved && value === '' && (
              <Button variant="soft" className="h-10" disabled={saving} onClick={() => void forget()}>Forget password</Button>
            )}
          </div>
          <p className="text-muted-foreground">
            {saved
              ? `A password is saved for ${host}: leave this empty to use it. The panel never shows it back.`
              : 'Used for this run\'s connections and not saved, unless you save it for the host. Nothing is written on the server.'}
          </p>
        </div>
      )}
    </div>
  );
}

type LocalView = 'site' | 'snapshot' | 'archive';

/** A dump from this machine: another site's database, one of its snapshots, or a deleted site's dump. */
function FromThisMachine({ working, onTake, exclude }: { working: boolean; onTake: (input: Record<string, unknown>) => void; exclude?: { domain: string; path?: string | undefined } | undefined }) {
  const [view, setView] = useState<LocalView>('site');
  const [sites, setSites] = useState<Site[] | null>(null);
  const [trash, setTrash] = useState<TrashEntry[] | null>(null);
  const [picked, setPicked] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  useEffect(() => {
    api.sites().then((list) => setSites(list.filter((s) => s.core.kind !== 'none' && !(exclude && s.domain === exclude.domain && (s.path ?? '') === (exclude.path ?? '')))), () => setSites([]));
    api.trash().then((list) => setTrash(list.filter((t) => t.hasDump)), () => setTrash([]));
  }, []);
  const site = (sites ?? []).find((s) => `${s.domain}${s.path ?? ''}` === picked);
  useEffect(() => {
    setSnapshots(null);
    if (view === 'snapshot' && site) api.snapshots(site.domain, site.path).then(setSnapshots, () => setSnapshots([]));
  }, [view, picked]);
  const ref = site ? { domain: site.domain, ...(site.path ? { path: site.path } : {}) } : null;
  const [found, setFound] = useState<{ key: string; tables: ServerTables } | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const tables = found?.key === picked ? found.tables : null;
  // The site's tables from the MySQL server, as the Database tab reads them.
  const readTables = async () => {
    if (!site?.db) return;
    setReading(true);
    try {
      const overview = await api.dbOverview(site.db.name);
      const list = overview.tables.filter((t) => !t.view).map((t) => ({ name: t.name, bytes: t.dataBytes + t.indexBytes })).sort((a, b) => b.bytes - a.bytes);
      const answer = { tables: list, ...knownLeftOut(list.map((t) => t.name)) };
      setFound({ key: picked, tables: answer });
      setLeftOut(defaultLeftOut(answer, false));
    } catch {
      setFound(null);
    } finally {
      setReading(false);
    }
  };
  return (
    <div className="grid gap-3">
      <Segmented label="From" value={view} onChange={setView} options={[['site', 'Another site'], ['snapshot', 'A snapshot'], ['archive', 'A deleted site']]} className="justify-self-start" />
      {view !== 'archive' && (
        <div className="flex flex-wrap items-end gap-2">
          <Select aria-label="Site" value={picked} onChange={(e) => setPicked(e.target.value)} wrapClassName="min-w-64">
            <option value="">{sites === null ? 'Reading the sites...' : 'Pick a site'}</option>
            {(sites ?? []).map((s) => <option key={`${s.domain}${s.path ?? ''}`} value={`${s.domain}${s.path ?? ''}`}>{s.domain}{s.path ?? ''}</option>)}
          </Select>
          {view === 'site' && site?.db && (
            <Button variant="outline" disabled={working || reading} onClick={() => void readTables()}>
              {reading ? <Spinner /> : <Table2 />}
              Choose tables
            </Button>
          )}
          {view === 'site' && (
            <Button disabled={!ref || working} onClick={() => ref && onTake({ kind: 'site', ...ref, excludeRows: tables ? leftOut : [] })}>
              {working ? <Spinner /> : <HardDrive />}
              Export its database
            </Button>
          )}
        </div>
      )}
      {view === 'site' && <p className="text-xs text-muted-foreground">A copy of the site's database now, with WP-CLI; the site stays as it is. Handy for a second copy that tests another branch.</p>}
      {view === 'site' && tables && <TablesPicker found={tables} value={leftOut} onChange={setLeftOut} />}
      {view === 'snapshot' && site && (
        <ul className="grid gap-1.5">
          {snapshots === null && <li className="text-muted-foreground">Reading its snapshots...</li>}
          {snapshots?.length === 0 && <li className="text-muted-foreground">This site has no snapshots.</li>}
          {(snapshots ?? []).map((snap) => (
            <li key={snap.name} className="flex flex-wrap items-center gap-2">
              <FileArchive className="size-4 text-muted-foreground" />
              <span className="font-mono text-dense">{snap.label ?? snap.name}</span>
              <span className="text-xs text-muted-foreground">{bytes(snap.sizeBytes)} · {timeAgo(snap.createdAt)}</span>
              <Button size="sm" variant="outline" disabled={working || !ref} onClick={() => ref && onTake({ kind: 'snapshot', ...ref, snapshot: snap.name })}>Use it</Button>
            </li>
          ))}
        </ul>
      )}
      {view === 'archive' && (
        <ul className="grid gap-1.5">
          {trash === null && <li className="text-muted-foreground">Reading the deleted sites...</li>}
          {trash?.length === 0 && <li className="text-muted-foreground">No deleted site with a database dump.</li>}
          {(trash ?? []).map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              <FileArchive className="size-4 text-muted-foreground" />
              <span className="font-mono text-dense">{t.domain}</span>
              <span className="text-xs text-muted-foreground">{t.reason === 'deleted' ? 'deleted' : 'archived'} {timeAgo(t.deletedAt)}</span>
              <Button size="sm" variant="outline" disabled={working} onClick={() => onTake({ kind: 'archive', id: t.id })}>Use its dump</Button>
            </li>
          ))}
          <li className="text-xs text-muted-foreground">A copy of the dump; the deleted site stays restorable as it was.</li>
        </ul>
      )}
    </div>
  );
}

type PickerSource = Exclude<DumpSource, 'claude' | 'none'>;
const PICKER_SOURCES: Array<[PickerSource, string]> = [
  ['upload', 'Upload from this computer'],
  ['downloads', 'Downloads folder'],
  ['cloud', 'Cloud drive or Drive link'],
  ['url', 'Public URL'],
  ['server', 'A server over SSH'],
  ['local', 'This machine'],
];

/**
 * Every way the wizard brings a dump in, for a site that exists: an upload,
 * the Downloads folder, a cloud drive, a public URL, a server over SSH with
 * tables left out, or this machine. Each ends as an upload, handed to onUpload.
 */
export function DumpSourcePicker({ busy, onUpload, exclude }: { busy: boolean; onUpload: (upload: UploadResult) => void; exclude?: { domain: string; path?: string | undefined } }) {
  const [source, setSource] = useState<PickerSource>('upload');
  const job = useJob();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = busy || (job.job !== null && !settled(job.job));
  useEffect(() => {
    if (!job.job || job.job.status !== 'done') return;
    const id = uploadOf(job.job.steps.map((s) => s.output ?? '').join('\n'));
    if (id) api.uploadInfo(id).then(onUpload, (err: Error) => setError(err.message));
  }, [job.job?.status]);
  const start = (id: Parameters<typeof api.startJob>[0], input: Record<string, unknown>) => {
    setError(null);
    void job.follow(api.startJob(id, input));
  };
  return (
    <div className="grid gap-3 text-sm">
      <Select aria-label="Where the dump comes from" value={source} onChange={(e) => setSource(e.target.value as PickerSource)} wrapClassName="w-fit min-w-64">
        {PICKER_SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      {source === 'upload' && <UploadDump onUpload={onUpload} />}
      {source === 'downloads' && <FromDownloads working={working} onUse={(file) => start('dump.useDownloaded', { file })} />}
      {source === 'cloud' && <FromCloud working={working} onRemote={(remote, entry) => start('dump.fromRemote', { remote, path: entry.path, ...(entry.sizeBytes !== null ? { sizeBytes: entry.sizeBytes } : {}) })} onDriveLink={(link) => start('dump.download', { link })} />}
      {source === 'url' && <FromUrl working={working} onFetch={(url) => start('dump.fetch', { url })} />}
      {source === 'server' && <FromServer working={working} onTake={(input) => start('dump.fromServer', input)} />}
      {source === 'local' && <FromThisMachine working={working} exclude={exclude} onTake={(input) => start('dump.fromLocal', input)} />}
      {job.job && job.job.status !== 'done' && <div className="border-t pt-3"><StepList steps={job.job.steps} open={openStep} setOpen={setOpenStep} /></div>}
      {(job.error || error) && <p role="alert" className="text-danger">{job.error ?? error}</p>}
    </div>
  );
}

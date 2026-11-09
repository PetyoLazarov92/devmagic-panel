import type { OrgStatus, RcloneRemotes, RemoteEntry, Site, SnapshotInfo, TrashEntry, UploadResult } from '@devmagic-panel/shared';
import { ChevronRight, CircleAlert, Cloud, ExternalLink, FileArchive, FolderOpen, Globe, HardDrive, HardDriveDownload, LoaderCircle, RefreshCw, Server, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { DumpFactsCard } from '@/components/dump-facts';
import { settled, StepList, useJob } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/field';
import { api, isMockup } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link } from '@/lib/router';
import { asideUploads } from '@/lib/org-repos';
import { cn } from '@/lib/utils';
import type { WizardState } from './new-site';
import { applyOrgAnswers, PrefillSummary } from './new-site-org';

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
              <Button variant="ghost" size="sm" onClick={another}>Pick another dump</Button>
            </p>
            <DumpFactsCard facts={state.upload.facts} />
          </>
        )}
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

      <div className="rounded-xl border bg-card p-4 text-sm">
        {source === 'claude' && <ClaudeDumps found={found} status={status} working={working} onDownload={(d) => void start('dump.download', { fileId: d.fileId, name: d.name, ...(d.sizeBytes !== null ? { sizeBytes: d.sizeBytes } : {}) })} />}
        {source === 'upload' && <UploadDump onUpload={(up) => setState((s) => withDump(s, up, cores))} />}
        {source === 'downloads' && <FromDownloads working={working} onUse={(file) => void start('dump.useDownloaded', { file })} />}
        {source === 'cloud' && <FromCloud working={working} onRemote={(remote, entry) => void start('dump.fromRemote', { remote, path: entry.path, ...(entry.sizeBytes !== null ? { sizeBytes: entry.sizeBytes } : {}) })} onDriveLink={(link) => void start('dump.download', { link })} />}
        {source === 'url' && <FromUrl working={working} onFetch={(url) => void start('dump.fetch', { url })} />}
        {source === 'server' && <FromServer working={working} onTake={(input) => void start('dump.fromServer', input)} />}
        {source === 'local' && <FromThisMachine working={working} onTake={(input) => void start('dump.fromLocal', input)} />}
        {source === 'none' && (
          <p className="text-muted-foreground">
            The install makes empty tables and installs WordPress on the repo's code, with the admin from the WordPress step. Nothing is imported, so no address is replaced and no plugin is turned off.
          </p>
        )}
        {job.job && <div className="mt-4 border-t pt-3"><StepList steps={job.job.steps} open={openStep} setOpen={setOpenStep} /></div>}
        {(job.error || error) && <p role="alert" className="mt-3 text-danger">{job.error ?? error}</p>}
      </div>
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
              <span className="font-mono text-[13px]">{d.name}</span>
              <span className="text-xs text-muted-foreground">{[d.sizeBytes !== null ? bytes(d.sizeBytes) : null, d.modifiedAt ? shortDate(d.modifiedAt) : null, d.foundIn].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {dump && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {status?.rclone.remote ? (
            <Button disabled={working} onClick={() => onDownload(dump)}>
              {working ? <LoaderCircle className="animate-spin" /> : <FileArchive />}
              Download it with rclone
            </Button>
          ) : (
            <span className="text-muted-foreground">rclone has no Google Drive remote, so download it in the browser and pick it under Downloads folder.</span>
          )}
          <a href={driveUrl(dump.fileId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            Open in Google Drive <ExternalLink className="size-3" />
          </a>
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
            <LoaderCircle className="size-6 animate-spin text-primary" />
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
        <Button variant="ghost" size="sm" onClick={read}><RefreshCw className={cn(loading && 'animate-spin')} />Look again</Button>
      </p>
      {list && list.length === 0 && <p className="text-muted-foreground">No .sql, .sql.gz or .zip there yet. Download one in the browser, then look again.</p>}
      <ul className="grid gap-1.5">
        {(list ?? []).map((d) => (
          <li key={d.file} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px]">{d.name}</span>
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

  if (!remotes) return <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Asking rclone for its remotes...</p>;
  if (!remotes.installed || remotes.remotes.length === 0) {
    return (
      <div className="grid gap-2">
        <p className="flex items-center gap-2 font-medium"><CircleAlert className="size-4 text-warning" />{remotes.installed ? 'rclone has no remote yet' : 'rclone is not installed'}</p>
        <p className="text-muted-foreground">
          rclone reaches Google Drive, Dropbox, OneDrive, S3, SFTP, WebDAV and more, each with its own sign-in that the panel never reads.{' '}
          {remotes.installed ? <>Add one in a terminal with <code className="font-mono text-foreground">rclone config</code>, then come back.</> : <>Install it with <code className="font-mono text-foreground">sudo apt install rclone</code>, add a remote with <code className="font-mono text-foreground">rclone config</code>, then come back.</>}{' '}
          Aura's <Link href="/aura/machine" className="text-primary hover:underline">Machine checks</Link> show where it stands. Until then, download the file in the browser and use Downloads folder.
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
          {remotes.remotes.map((r) => (
            <button key={r.name} type="button" onClick={() => { setRemote(r.name); setPath(''); }} className={cn('rounded-md border px-2.5 py-1 text-xs', remote === r.name ? 'border-primary bg-primary/8 font-medium' : 'text-muted-foreground hover:border-primary/50')}>
              {r.name} <span className="text-muted-foreground">({r.type})</span>
            </button>
          ))}
        </div>
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 font-mono text-xs">
          <button type="button" className="text-primary hover:underline" onClick={() => setPath('')}>{remote}:</button>
          {parts.map((p, i) => (
            <span key={`${p}${i}`} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-muted-foreground" />
              <button type="button" className="text-primary hover:underline" onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{p}</button>
            </span>
          ))}
        </nav>
        {error && <p role="alert" className="text-danger">{error}</p>}
        {!entries && !error && <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Reading the folder...</p>}
        {entries && (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {entries.length === 0 && <li className="text-muted-foreground">No folders or dumps here.</li>}
            {entries.map((e) => (
              <li key={e.path} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/50">
                {e.dir ? (
                  <button type="button" className="flex items-center gap-2 font-medium hover:underline" onClick={() => setPath(e.path)}><FolderOpen className="size-4 text-muted-foreground" />{e.name}/</button>
                ) : (
                  <>
                    <FileArchive className="size-4 text-muted-foreground" />
                    <span className="font-mono text-[13px]">{e.name}</span>
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
          <Input id="drive-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/file/d/.../view" className="font-mono text-[13px]" spellCheck={false} disabled={!drive} />
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
        <Input id="dump-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://files.spellbook.example/backups/spellbook.sql.gz" className="font-mono text-[13px]" spellCheck={false} aria-invalid={url.trim() !== '' && !ok ? true : undefined} />
        <Button disabled={!ok || working} onClick={() => onFetch(url.trim())}>
          {working ? <LoaderCircle className="animate-spin" /> : <HardDriveDownload />}
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
function FromServer({ working, onTake }: { working: boolean; onTake: (input: { host: string; mode: 'file' | 'export'; path: string }) => void }) {
  const [host, setHost] = useState('');
  const [mode, setMode] = useState<'export' | 'file'>('export');
  const [path, setPath] = useState('');
  const hostOk = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host.trim());
  const pathOk = /^\/[A-Za-z0-9._/-]+$/.test(path.trim()) && !path.split('/').includes('..') && (mode === 'export' || /\.(sql|sql\.gz|zip)$/i.test(path.trim()));
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <label htmlFor="ssh-host" className="font-medium">Host</label>
          <Input id="ssh-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="staging-spellbook or alex@www.spellbook.example" className="font-mono text-[13px]" spellCheck={false} aria-invalid={host.trim() !== '' && !hostOk ? true : undefined} />
          <p className="text-xs text-muted-foreground">An alias from your ~/.ssh/config, or user@host.</p>
        </div>
        <div className="grid content-start gap-1.5">
          <span className="font-medium">What to take</span>
          <Segmented label="What to take" value={mode} onChange={setMode} options={[['export', 'Export now with WP-CLI'], ['file', 'A dump file there']]} className="h-10 justify-self-start" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="ssh-path" className="font-medium">{mode === 'export' ? 'The WordPress folder on the server' : 'The dump on the server'}</label>
        <div className="flex gap-2">
          <Input id="ssh-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={mode === 'export' ? '/var/www/spellbook/public' : '/home/alex/backups/spellbook.sql.gz'} className="font-mono text-[13px]" spellCheck={false} aria-invalid={path.trim() !== '' && !pathOk ? true : undefined} />
          <Button disabled={!hostOk || !pathOk || working} onClick={() => onTake({ host: host.trim(), mode, path: path.trim() })}>
            {working ? <LoaderCircle className="animate-spin" /> : <Server />}
            {mode === 'export' ? 'Export' : 'Copy'}
          </Button>
        </div>
        {path.trim() !== '' && !pathOk && <p className="text-xs text-danger">An absolute path with letters, digits and . _ - / only{mode === 'file' ? ', ending in .sql, .sql.gz or .zip' : ''}.</p>}
      </div>
      <ul className="grid gap-1 text-xs text-muted-foreground">
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />Your SSH key through your agent; never a password, and a host not in your known_hosts is refused, not trusted on the fly.</li>
        <li className="flex items-start gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />{mode === 'export' ? 'Runs only wp db export on the server (it reads, it changes nothing), and the server needs WP-CLI as wp.' : 'Copies the file with sftp; nothing runs on the server.'}</li>
      </ul>
    </div>
  );
}

type LocalView = 'site' | 'snapshot' | 'archive';

/** A dump from this machine: another site's database, one of its snapshots, or a deleted site's dump. */
function FromThisMachine({ working, onTake }: { working: boolean; onTake: (input: Record<string, unknown>) => void }) {
  const [view, setView] = useState<LocalView>('site');
  const [sites, setSites] = useState<Site[] | null>(null);
  const [trash, setTrash] = useState<TrashEntry[] | null>(null);
  const [picked, setPicked] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  useEffect(() => {
    api.sites().then((list) => setSites(list.filter((s) => s.core.kind !== 'none')), () => setSites([]));
    api.trash().then((list) => setTrash(list.filter((t) => t.hasDump)), () => setTrash([]));
  }, []);
  const site = (sites ?? []).find((s) => `${s.domain}${s.path ?? ''}` === picked);
  useEffect(() => {
    setSnapshots(null);
    if (view === 'snapshot' && site) api.snapshots(site.domain, site.path).then(setSnapshots, () => setSnapshots([]));
  }, [view, picked]);
  const ref = site ? { domain: site.domain, ...(site.path ? { path: site.path } : {}) } : null;
  return (
    <div className="grid gap-3">
      <Segmented label="From" value={view} onChange={setView} options={[['site', 'Another site'], ['snapshot', 'A snapshot'], ['archive', 'A deleted site']]} className="justify-self-start" />
      {view !== 'archive' && (
        <div className="flex flex-wrap items-end gap-2">
          <Select aria-label="Site" value={picked} onChange={(e) => setPicked(e.target.value)} wrapClassName="min-w-64">
            <option value="">{sites === null ? 'Reading the sites...' : 'Pick a site'}</option>
            {(sites ?? []).map((s) => <option key={`${s.domain}${s.path ?? ''}`} value={`${s.domain}${s.path ?? ''}`}>{s.domain}{s.path ?? ''}</option>)}
          </Select>
          {view === 'site' && (
            <Button disabled={!ref || working} onClick={() => ref && onTake({ kind: 'site', ...ref })}>
              {working ? <LoaderCircle className="animate-spin" /> : <HardDrive />}
              Export its database
            </Button>
          )}
        </div>
      )}
      {view === 'site' && <p className="text-xs text-muted-foreground">A copy of the site's database now, with WP-CLI; the site stays as it is. Handy for a second copy that tests another branch.</p>}
      {view === 'snapshot' && site && (
        <ul className="grid gap-1.5">
          {snapshots === null && <li className="text-muted-foreground">Reading its snapshots...</li>}
          {snapshots?.length === 0 && <li className="text-muted-foreground">This site has no snapshots.</li>}
          {(snapshots ?? []).map((snap) => (
            <li key={snap.name} className="flex flex-wrap items-center gap-2">
              <FileArchive className="size-4 text-muted-foreground" />
              <span className="font-mono text-[13px]">{snap.label ?? snap.name}</span>
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
              <span className="font-mono text-[13px]">{t.domain}</span>
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

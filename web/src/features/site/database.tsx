import { Tabs } from '@/components/ui/tabs';
import type { CleanCopyInfo, CleanPreview, KeptDatabaseInfo, Site, SnapshotInfo, UploadResult } from '@devmagic-panel/shared';
import { isLocalName } from '@devmagic-panel/shared';
import { Archive, Camera, ChevronDown, Download, Eraser, FileArchive, PackageCheck, RefreshCw, Replace, RotateCcw, Search, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { DatabaseBrowser, type DbLocation, rowsSeedState } from '@/features/database/db-browser';
import { JobFooter } from '@/features/jobs/job-box';
import { settled, useJob, useResumeJob } from '@/features/jobs/job-steps';
import { SqlRunner, sqlSeed } from '@/features/database/sql-runner';
import { WordpressDbView } from '@/features/database/wordpress-db';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { cleanupFindings, CopyChoice, findings } from '@/features/database/copy-choice';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { SecretInput } from '@/components/ui/secret-input';
import { Segmented } from '@/components/ui/segmented';
import { api, cleanCopyUrl, isMockup, snapshotUrl } from '@/lib/api';
import { forgetProduction } from '@/lib/production';
import { bytes, timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { navigate, useQueryParam } from '@/lib/router';
import { siteHref, siteName, siteTarget } from '@/lib/site-ref';
import { databaseHref, databaseView, type DbView } from '@/lib/database-href';
import { useAsync } from '@/lib/use-async';
import { ViewBar } from '@/components/layout/page';
import { DumpSourcePicker, FromServer, ServerPassword } from '../new-site/database';
import { ReadingBlock } from '@/components/layout/skeletons';

type JobKind = 'snapshot' | 'restore' | 'import' | 'preview' | 'replace' | 'clean' | 'cleanCurrent' | 'export' | 'restoreKept' | 'refresh';

const JOB_ACTIONS = {
  snapshot: 'db.snapshot', restore: 'db.restore', import: 'db.import', preview: 'db.searchReplace', replace: 'db.searchReplace',
  clean: 'db.cleanCopy', cleanCurrent: 'db.cleanCurrent', export: 'db.exportClean', restoreKept: 'db.restoreKept', refresh: 'site.refreshFromProduction',
} as const;

/** The kind of job each action starts, to show a running one in its card again. */
const KIND_OF: Partial<Record<string, JobKind>> = {
  'db.snapshot': 'snapshot', 'db.restore': 'restore', 'db.import': 'import', 'db.searchReplace': 'replace',
  'db.cleanCopy': 'clean', 'db.cleanCurrent': 'cleanCurrent', 'db.exportClean': 'export', 'db.restoreKept': 'restoreKept', 'site.refreshFromProduction': 'refresh',
};

export { databaseHref } from '@/lib/database-href';

/**
 * A site's database: its tables to browse, read only, and the backups and
 * tools that change it. Each view and table is in the address, so Back and a
 * reload keep the place.
 */
export function DatabaseTab({ site }: { site: Site }) {
  const wordpress = site.core.kind !== 'none';
  const requested = useQueryParam('view');
  // Slow queries moved to the Performance tab: an old link goes on there.
  useEffect(() => {
    if (requested === 'queries') navigate(`${siteHref(site)}?tab=performance`, { replace: true, scroll: false });
  }, [requested, site]);
  const table = useQueryParam('table');
  const view = databaseView(requested, table, wordpress);
  const show = useQueryParam('show') === 'structure' ? 'structure' : 'rows';
  const blogParam = Number(useQueryParam('blog'));
  const blog = Number.isInteger(blogParam) && blogParam > 1 ? blogParam : 1;
  if (!site.db) {
    return <Card><p className="px-5 py-4 text-sm text-muted-foreground">This site has no database in wp-config.php.</p></Card>;
  }
  const go = (next: DbView, location?: DbLocation, nextBlog = 1) => navigate(databaseHref(site, next, location, nextBlog), { scroll: false });
  // What needs a look first, then the rows, then SQL on them, then upkeep.
  const views: Array<[DbView, string]> = [...(wordpress ? [['overview', 'Overview'] as [DbView, string]] : []), ['tables', 'Tables'], ['sql', 'SQL'], ['tools', 'Backups and tools']];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Tabs className="lg:hidden" size="sm" label="Database" value={view} onChange={(v) => go(v)} items={views.map(([value, label]) => ({ value, label }))} />
      {view === 'tools' ? (
        <DatabaseTools site={site} />
      ) : view === 'sql' ? (
        <SqlRunner key={site.db.name} database={site.db.name} canWrite seed={sqlSeed()} />
      ) : view === 'overview' ? (
        <WordpressDbView site={site} blog={blog} onBlog={(b) => go('overview', undefined, b)} onTable={(t, seed) => navigate(databaseHref(site, 'tables', { table: t, show: 'rows' }), { scroll: false, state: seed ? rowsSeedState({ ...seed, table: t }) : null })} />
      ) : (
        <DatabaseBrowser key={site.db.name} database={site.db.name} location={{ table, show }} onNavigate={(location) => go('tables', location)} />
      )}
    </div>
  );
}

/**
 * Snapshots, search and replace, and dump import for one site. A restore and
 * a replace take a snapshot of the current database first, so it can be
 * restored; an import is swapped in from a side database, with Undo until it
 * ends.
 */
function DatabaseTools({ site }: { site: Site }) {
  const list = useAsync(() => api.snapshots(site.domain, site.path), [site.domain, site.path]);
  const copies = useAsync(() => api.cleanCopies(site.domain, site.path), [site.domain, site.path]);
  const kept = useAsync(() => api.keptDatabases(site.domain, site.path), [site.domain, site.path]);
  const preview = useAsync(() => api.cleanPreview(site.domain, site.path), [site.domain, site.path]);
  const runner = useJob();
  const [kind, setKind] = useState<JobKind | null>(null);
  // A job still running since before you came back shows in its card again (search and replace's preview has its own place).
  useResumeJob(runner, `${site.domain}${site.path ?? ''}`, KIND_OF, setKind);
  const busy = runner.job !== null && !settled(runner.job);
  const lastDone = useRef<string | null>(null);

  // Snapshots change with every job; refresh the list once one settles.
  const { job } = runner;
  useEffect(() => {
    if (!job || !settled(job) || lastDone.current === job.id) return;
    lastDone.current = job.id;
    list.reload();
    copies.reload();
    kept.reload();
    preview.reload();
    if (job.status === 'done' && kind !== 'preview') toast({ tone: 'success', title: doneTitle(kind) });
  }, [job, kind, list, copies, kept, preview]);

  function start(next: JobKind, input: Record<string, unknown>) {
    setKind(next);
    void runner.follow(api.startJob(JOB_ACTIONS[next], { ...siteTarget(site), ...input }));
  }

  if (!site.db) {
    return <Card><p className="px-5 py-4 text-sm text-muted-foreground">This site has no database in wp-config.php.</p></Card>;
  }

  // A job is the footer of the card that started it.
  const jobIn = (card: JobCardSlot) => (JOB_CARD[kind ?? 'replace'] === card ? <JobFooter job={runner.job} error={runner.error} onRetry={() => void runner.retry()} onStop={() => void runner.stop()} /> : null);

  const reading = list.loading || copies.loading || kept.loading || preview.loading;
  const readAgain = () => {
    list.reload();
    copies.reload();
    kept.reload();
    preview.reload();
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ViewBar
        onCheck={readAgain}
        loading={reading}
        note={<>Snapshots, imports and copies of <span className="font-mono">{site.db.name}</span>. Each job that changes it saves it first, so Undo or a snapshot puts it back.</>}
      />
      {/* In pairs of a kind, each pair as tall as each other: going back (snapshots, kept tables),
          bringing a database in across the row, cleaning (this one, copies to share), then search and replace. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-2">
        <SnapshotsCard site={site} snapshots={list.data ?? []} loading={list.loading} busy={busy} start={start} onDeleted={list.reload} footer={jobIn('snapshots')} />
        <KeptCard site={site} kept={kept.data ?? []} loading={kept.loading} busy={busy} start={start} onDeleted={kept.reload} footer={jobIn('kept')} />
        <ImportCard site={site} busy={busy} start={start} footer={jobIn('import')} className="@3xl:col-span-2" />
        <CleanCurrentCard site={site} preview={preview.data} error={preview.error} busy={busy} start={start} footer={jobIn('cleanCurrent')} />
        <CleanCopiesCard site={site} copies={copies.data ?? []} loading={copies.loading} busy={busy} start={start} onDeleted={copies.reload} footer={jobIn('copies')} />
        <SearchReplaceCard site={site} busy={busy} start={start} preview={kind === 'preview' ? runner.job : null} footer={jobIn('replace')} className="@3xl:col-span-2" />
      </div>
    </div>
  );
}

type JobCardSlot = 'snapshots' | 'import' | 'cleanCurrent' | 'replace' | 'copies' | 'kept';
const JOB_CARD: Record<JobKind, JobCardSlot> = {
  snapshot: 'snapshots', restore: 'snapshots', import: 'import', clean: 'import', cleanCurrent: 'cleanCurrent', preview: 'replace', replace: 'replace', export: 'copies', restoreKept: 'kept', refresh: 'import',
};

function doneTitle(kind: JobKind | null): string {
  if (kind === 'snapshot') return 'Snapshot saved';
  if (kind === 'restore') return 'Snapshot restored';
  if (kind === 'import') return 'Dump imported';
  if (kind === 'clean') return 'Dump imported and cleaned';
  if (kind === 'cleanCurrent') return 'Database cleaned';
  if (kind === 'export') return 'Clean copy saved';
  if (kind === 'restoreKept') return 'Tables put back';
  if (kind === 'refresh') return 'Database refreshed from production';
  return 'Search and replace done';
}

type Start = (kind: JobKind, input: Record<string, unknown>) => void;

// ── snapshots ────────────────────────────────────────────────

function SnapshotsCard({ footer, site, snapshots, loading, busy, start, onDeleted }: { footer: ReactNode; 
  site: Site;
  snapshots: SnapshotInfo[];
  loading: boolean;
  busy: boolean;
  start: Start;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState('');
  const [restoring, setRestoring] = useState<SnapshotInfo | null>(null);
  const [deleting, setDeleting] = useState<SnapshotInfo | null>(null);
  const labelValid = label === '' || /^[a-z0-9-]{1,40}$/.test(label);

  async function remove(snapshot: SnapshotInfo) {
    const result = await api.runAction('db.deleteSnapshot', { ...siteTarget(site), snapshot: snapshot.name }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: 'Snapshot deleted' } : { tone: 'danger', title: 'Could not delete the snapshot', detail: lastLine(result.output) });
    setDeleting(null);
    onDeleted();
  }

  return (
    <Card>
      <CardHeader title="Snapshots" meta={<Camera className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          Database {site.db?.name} · {bytes(site.db?.sizeBytes ?? 0)}. Snapshots are gzipped exports in ~/devmagic-panel-backups/snapshots/{site.path ? `${site.domain}@${site.path.slice(1).replaceAll('/', '@')}` : site.domain}. Restore and replace take one first; an import goes into a side database and is swapped in, so the tables from before come back with Undo until it ends.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-40 flex-1" label="Label (optional)" htmlFor="snapshot-label" hint={labelValid ? undefined : <span className="text-danger">Lowercase letters, digits and dashes</span>}>
            <Input id="snapshot-label" value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} placeholder="before-plugin-update" className="font-mono text-dense" spellCheck={false} />
          </Field>
          <Button disabled={busy || !labelValid} onClick={() => start('snapshot', label ? { label } : {})}>
            <Camera />
            Take snapshot
          </Button>
        </div>

        {snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loading ? 'Loading snapshots...' : 'No snapshots yet.'}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {snapshots.map((s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    {timeAgo(s.createdAt)}
                    {s.label && <Badge>{s.label}</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={s.name}>{bytes(s.sizeBytes)} · {s.name}</p>
                </div>
                <div className="flex gap-1">
                  <ButtonLink
                    size="icon"
                    variant="ghost"
                    href={snapshotUrl(site.domain, s.name, site.path)}
                    download
                    title="Download"
                    aria-label={`Download ${s.name}`}
                    onClick={(e) => {
                      if (!isMockup) return;
                      e.preventDefault();
                      toast({ tone: 'info', title: 'Mockup: this downloads the .sql.gz file' });
                    }}
                  >
                    <Download />
                  </ButtonLink>
                  <Button size="icon" variant="ghost" title="Restore" aria-label={`Restore ${s.name}`} disabled={busy} onClick={() => setRestoring(s)}><RotateCcw /></Button>
                  <Button size="icon" variant="ghost" title="Delete" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => setDeleting(s)}><Trash2 /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={restoring !== null}
        title="Restore this snapshot?"
        description={restoring ? `The current database of ${siteName(site)} is saved as a new snapshot first, then ${restoring.name} is imported over it.` : ''}
        domain={site.domain}
        action="Restore"
        onClose={() => setRestoring(null)}
        onConfirm={(confirm) => {
          if (restoring) start('restore', { snapshot: restoring.name, confirm });
          setRestoring(null);
        }}
      />
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this snapshot?" description={deleting ? `${deleting.name} (${bytes(deleting.sizeBytes)}) is deleted for good.` : ''}>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => deleting && void remove(deleting)}><Trash2 />Delete</Button>
        </div>
      </Dialog>
      {footer}
    </Card>
  );
}

function ConfirmDialog({ open, title, description, domain, action, onClose, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  domain: string;
  action: string;
  onClose: () => void;
  onConfirm: (confirm: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const close = () => {
    setTyped('');
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={title} description={description}>
      <ConfirmField id="db-confirm" expected={domain} value={typed} onChange={setTyped} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="soft" onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          disabled={typed !== domain}
          onClick={() => {
            onConfirm(typed);
            setTyped('');
          }}
        >
          {action}
        </Button>
      </div>
    </Dialog>
  );
}

// ── search and replace ──────────────────────────────────────

/** The total wp-cli prints at the end of a search and replace. */
function replacementCount(output: string | undefined): number | null {
  const m = /(\d+) replacements? (?:to be made|made)/i.exec(output ?? '') ?? /Made (\d+) replacements?/i.exec(output ?? '');
  return m ? Number(m[1]) : null;
}

function SearchReplaceCard({ footer, site, busy, start, preview, className }: { footer: ReactNode; site: Site; busy: boolean; start: Start; preview: ReturnType<typeof useJob>['job']; className?: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [previewed, setPreviewed] = useState<{ from: string; to: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const valid = (v: string) => v.length >= 3 && !v.startsWith('-') && !/[\r\n]/.test(v);
  const ready = valid(from) && valid(to) && from !== to;
  const output = preview?.steps[0]?.output;
  const count = preview?.status === 'done' ? replacementCount(output) : null;
  const canRun = previewed !== null && previewed.from === from && previewed.to === to && preview?.status === 'done';

  return (
    <Card className={className}>
      <CardHeader title="Search and replace" meta={<Replace className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          Runs <code className="font-mono">wp search-replace</code> on every table of the site, serialized data included; guid columns are skipped. Preview first: it only counts.
        </p>
        {/* Across the row: the two fields and the buttons on one line. */}
        <div className="grid gap-3 sm:grid-cols-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @3xl:items-end">
          <Field label="Find" htmlFor="sr-from">
            <Input id="sr-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="https://staging.example.com" className="font-mono text-dense" spellCheck={false} />
          </Field>
          <Field label="Replace with" htmlFor="sr-to">
            <Input id="sr-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={`https://${siteName(site)}`} className="font-mono text-dense" spellCheck={false} />
          </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2 @3xl:col-span-1">
          <Button
            variant="outline"
            disabled={busy || !ready}
            onClick={() => {
              setPreviewed({ from, to });
              start('preview', { from, to, dryRun: true });
            }}
          >
            <Search />
            Preview
          </Button>
          <Button variant="danger" disabled={busy || !canRun || count === 0} onClick={() => setConfirming(true)}>
            <Replace />
            {count !== null ? `Replace ${count}` : 'Replace'}
          </Button>
        </div>
        </div>
        {preview && previewed && (
          <div className="grid gap-2">
            <p className="text-sm">
              {preview.status === 'running' && 'Counting...'}
              {count !== null && (count === 0 ? 'Nothing to replace.' : `${count} replacement${count === 1 ? '' : 's'} to make.`)}
            </p>
            {output && <pre className="max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre">{output}</pre>}
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title={`Replace ${from}?`}
        description={`A snapshot of ${siteName(site)}'s database is taken first, then ${from} becomes ${to} everywhere.`}
        domain={site.domain}
        action="Replace"
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setPreviewed(null);
          start('replace', { from, to, dryRun: false });
        }}
      />
      {footer}
    </Card>
  );
}

// ── dumps: import and prepare ───────────────────────────────

/** A dump chosen and uploaded for this site, with each production host it uses paired with a local name. */
function useDumpUpload(site: Site) {
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [pairs, setPairs] = useState<Array<{ from: string; to: string }>>([]);
  const names = [site.domain, ...site.aliases, ...(site.network?.sites.map((s) => new URL(s.url).hostname) ?? [])].filter((n, i, all) => all.indexOf(n) === i);

  /** A dump that is in, from any source. */
  function take(result: UploadResult) {
    setUpload(result);
    // Each production host goes to its suggested local name when the site serves it, otherwise to the main domain.
    // Hosts that are already local names need no replacing.
    setPairs(result.facts.hosts.filter((from) => !isLocalName(from)).map((from) => {
      const suggested = result.suggestions.replace.find((r) => r.from === from)?.to;
      return { from, to: suggested && names.includes(suggested) ? suggested : site.domain };
    }));
  }

  const reset = () => {
    setUpload(null);
    setPairs([]);
  };
  return { upload, take, pairs, setPairs, replace: pairs.filter((p) => p.to !== ''), names, reset };
}

type DumpUpload = ReturnType<typeof useDumpUpload>;

/** The dump for an import: from any source the new site wizard has, or the one that is in, with a way to pick another. */
function DumpChooser({ dump, busy, site }: { dump: DumpUpload; busy: boolean; site: Site }) {
  if (dump.upload) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FileArchive className="size-4 text-success" />
        <span>{dump.upload.name} · {bytes(dump.upload.size)}</span>
        <Button variant="soft" size="sm" disabled={busy} onClick={dump.reset}>Pick another dump</Button>
      </div>
    );
  }
  return <DumpSourcePicker busy={busy} onUpload={dump.take} exclude={siteTarget(site)} />;
}

function ReplacePairs({ dump }: { dump: DumpUpload }) {
  if (dump.pairs.length === 0) return null;
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Replace production domains</p>
      {dump.pairs.map((p, i) => (
        <div key={p.from} className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <span className="truncate font-mono text-dense" title={p.from}>{p.from}</span>
          <span className="hidden text-muted-foreground sm:inline">to</span>
          <Select aria-label={`Local name for ${p.from}`} value={p.to} onChange={(e) => dump.setPairs((all) => all.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}>
            {dump.names.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="">keep as is</option>
          </Select>
        </div>
      ))}
    </div>
  );
}

/**
 * Import a database: a copy from production with the settings saved for the
 * site, or a dump from any source, as it is or cleaned. Either way it goes
 * into a side database and is swapped in, with the tables from before kept.
 */
function ImportCard({ footer, site, busy, start, className }: { footer: ReactNode; site: Site; busy: boolean; start: Start; className?: string }) {
  const dump = useDumpUpload(site);
  const { upload, replace } = dump;
  const [copy, setCopy] = useState<'whole' | 'clean'>('whole');
  const [bare, setBare] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const admins = upload ? (upload.facts.multisite ? upload.facts.superAdmins : upload.facts.admins) : undefined;
  const [user, setUser] = useState<KeepUser>(defaultKeepUser(undefined));
  const uploadId = upload?.id;
  // A new dump gets the default user for its administrators.
  const adminsKey = admins?.join(',');
  useEffect(() => setUser(defaultKeepUser(adminsKey?.split(','))), [uploadId, adminsKey]);
  const clean = copy === 'clean';
  const db = site.db?.name ?? 'the database';
  // Only a dump read to its end that makes nothing RENAME TABLE cannot move is cleaned in a side database.
  const blocked = clean && upload && upload.facts.storedObjects !== false
    ? upload.facts.storedObjects ? 'This dump makes views, triggers or routines, which cannot be cleaned in a side database. Import it as it is.' : 'This dump was not read to its end, so it is not known to be safe to clean in a side database. Take it again.'
    : null;

  return (
    <Card className={className}>
      <CardHeader title="Import a database" meta={<FileArchive className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          Replaces {db} with a copy from production or a dump, as it is or cleaned. The copy goes into a side database and is swapped in at once; production domains become this site&apos;s, and the tables from before are kept for 7 days.
        </p>
        {/* The two ways in side by side once the card has the room, one under the other before. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-2 @3xl:gap-6">
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <ProductionRefresh site={site} busy={busy} start={start} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4 border-t pt-4 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-6">
          <p className="text-sm font-medium">From a dump</p>
          <DumpChooser dump={dump} busy={busy} site={site} />

          {upload && (
            <>
              <KeyValue
                labelWidth="sm"
                rows={[
                  { label: 'Table prefix', value: <span className="font-mono text-dense">{upload.facts.tablePrefix ?? 'unknown'}</span> },
                  { label: 'Multisite', value: upload.facts.multisite ? 'yes' : 'no' },
                ]}
              />
              <CopyChoice id="import-copy" clean={clean} onChange={(on) => setCopy(on ? 'clean' : 'whole')} removed={findings(upload)} />
              <ReplacePairs dump={dump} />
              {replace.length > 0 && (
                <Checkbox
                  id="import-bare"
                  checked={bare}
                  onChange={setBare}
                  label="Replace every mention, not only URLs"
                  hint="URLs only (//host) is the default, so email addresses and plain text keep the production domain."
                />
              )}
              {clean && <KeepUserFields id="import-user" admins={admins} multisite={upload.facts.multisite} value={user} onChange={setUser} />}
              <p className="text-xs text-muted-foreground">http:// on this site&apos;s local domains becomes https:// after the import.</p>
              {blocked ? (
                <p role="alert" className="text-sm text-warning">{blocked}</p>
              ) : (
                <Button variant="danger" className="justify-self-start" disabled={busy || (clean && keepUserProblem(user) !== null)} onClick={() => setConfirming(true)}>
                  {clean ? <ShieldCheck /> : <Upload />}
                  {clean ? `Import into ${db}, cleaned` : `Import into ${db}`}
                </Button>
              )}
            </>
          )}
        </div>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title={`Import ${upload?.name ?? 'the dump'}${clean ? ', cleaned' : ''}?`}
        description={clean
          ? `The dump is imported into a side database and cleaned there, so no WordPress code runs on it and nothing can send mail. Then it replaces ${db} at once: the tables it replaces are kept for 7 days under Kept databases, where Put back swaps them in again.`
          : `The dump goes into a side database first and its tables are then swapped into ${db} at once, so ${siteName(site)} keeps working until it is in. The tables it replaces are kept for 7 days under Kept databases, where Put back swaps them in again. When that cannot be done (an empty database, triggers or views, too little disk), a snapshot is taken and the dump imported straight in.`}
        domain={site.domain}
        action="Import"
        onClose={() => setConfirming(false)}
        onConfirm={(confirm) => {
          setConfirming(false);
          if (!upload) return;
          const pairs = { replace, replaceBare: replace.length > 0 && bare };
          if (clean) start('clean', { uploadId: upload.id, ...pairs, user, confirm });
          else start('import', { uploadId: upload.id, ...pairs, confirm });
          dump.reset();
          setBare(false);
          setCopy('whole');
        }}
      />
      {footer}
    </Card>
  );
}

/** The one user a clean-up leaves, as its actions take it: keep, an administrator already there, or a new login. */
interface KeepUser {
  keep?: string;
  login: string;
  password: string;
}

/** The panel's rule: admin when it is one of the administrators, otherwise a new admin / admin. */
const defaultKeepUser = (admins: readonly string[] | undefined): KeepUser =>
  admins?.includes('admin') ? { keep: 'admin', login: 'admin', password: 'admin' } : { login: 'admin', password: 'admin' };

const WP_LOGIN = /^[\w.@+ -]{1,60}$/;
/** Why the user cannot be sent yet, or null when it can. */
const keepUserProblem = (user: KeepUser): string | null =>
  !user.keep && !WP_LOGIN.test(user.login) ? 'A login of letters, digits, spaces and _ . @ + -' : user.password === '' ? 'A password for the user' : null;

/** Which user stays after a clean-up: an administrator already there, or a new one, with the password to sign in with. */
function KeepUserFields({ id, admins, multisite, value, onChange }: {
  id: string;
  /** The administrators (a network's super admins) by login; undefined when they are not known. */
  admins: readonly string[] | undefined;
  multisite: boolean;
  value: KeepUser;
  onChange: (user: KeepUser) => void;
}) {
  const problem = keepUserProblem(value);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={KEEP_LABEL} htmlFor={`${id}-keep`}>
        <Select
          id={`${id}-keep`}
          value={value.keep ?? ''}
          onChange={(e) => onChange(e.target.value ? { ...value, keep: e.target.value } : { login: value.login, password: value.password })}
        >
          {(admins ?? []).map((a) => <option key={a} value={a}>{a} ({multisite ? 'super admin' : 'administrator'})</option>)}
          <option value="">A new user</option>
        </Select>
      </Field>
      {/* An existing user has the password beside it; a new user's login and password share the row under the choice. */}
      {!value.keep && (
        <Field label="Login" htmlFor={`${id}-login`} className="sm:col-start-1">
          <Input id={`${id}-login`} value={value.login} autoComplete="off" onChange={(e) => onChange({ ...value, login: e.target.value })} />
        </Field>
      )}
      <Field label={PASSWORD_LABEL} htmlFor={`${id}-secret`}>
        <SecretInput id={`${id}-secret`} value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} />
      </Field>
      {problem && <p className="text-xs text-danger sm:col-span-2">{problem}</p>}
      <p className="text-xs text-muted-foreground sm:col-span-2">{keepHint(multisite)}{value.keep ? ` The password replaces ${value.keep}'s, for this local copy only.` : ''}</p>
    </div>
  );
}

/** The same words wherever a clean-up asks which user stays. */
const KEEP_LABEL = 'Keep this user';
const PASSWORD_LABEL = 'Password';
const keepHint = (multisite: boolean) =>
  `Every other user goes. Their posts and links become this user's, as wp user delete --reassign does; comments stay as they are.${multisite ? ' On a network this user is a super admin and an administrator of every site.' : ''}`;

/** Clean this database: the clean-up of a cleaned import on the database the site has now. */
/** Below this, what the copy leaves out is not worth a line. */
const LEFT_OUT_SHOWN = 100 * 1024 ** 2;

function CleanCurrentCard({ footer, site, preview, error, busy, start }: { footer: ReactNode;  site: Site; preview: CleanPreview | null | undefined; error: string | null | undefined; busy: boolean; start: Start }) {
  const [confirming, setConfirming] = useState(false);
  const [user, setUser] = useState<KeepUser>(defaultKeepUser(undefined));
  const adminsKey = preview?.admins.join(',');
  // The default user for the administrators the database has now.
  useEffect(() => setUser(defaultKeepUser(adminsKey ? adminsKey.split(',') : undefined)), [adminsKey]);
  const db = site.db?.name ?? 'the database';

  return (
    <Card>
      <CardHeader title="Clean this database" meta={<Eraser className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          Cleans the database the site has now, like a production database you imported as it is, the way a cleaned import does. It is copied beside the site and cleaned there while the site keeps working, then swapped in; your current tables are kept for 7 days. Mail plugins are turned off and one administrator stays, the author of every post. Addresses are not replaced.
        </p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!preview && !error && <ReadingBlock lines={4}>Reading {db}...</ReadingBlock>}
        {preview?.blocked && <p role="alert" className="text-sm text-warning">{preview.blocked}</p>}
        {preview && !preview.blocked && (
          <>
            <div className="grid gap-2.5">
              <p className="text-sm font-medium">Removed from {db} <span className="font-normal text-muted-foreground">({bytes(preview.sizeBytes)})</span></p>
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {cleanupFindings(preview.tables, preview.prefix).map((f) => <li key={f} className="before:mr-2 before:text-primary before:content-['–']">{f}</li>)}
              </ul>
              {(preview.leftOutBytes ?? 0) >= LEFT_OUT_SHOWN && <p className="text-xs text-muted-foreground">The {bytes(preview.leftOutBytes ?? 0)} in the tables it empties is not copied, so the copy needs less room.</p>}
            </div>
            <KeepUserFields id="clean-user" admins={preview.admins} multisite={preview.multisite} value={user} onChange={setUser} />
            <Button variant="danger" className="justify-self-start" disabled={busy || keepUserProblem(user) !== null} onClick={() => setConfirming(true)}>
              <Eraser />
              Clean {db}
            </Button>
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title={`Clean ${db}?`}
        description={`${db} is copied into a side database and cleaned there, so no WordPress code runs on it and nothing can send mail. Then the clean copy replaces it at once: the tables it replaces are kept for 7 days under Kept databases, where Put back swaps them in again.`}
        domain={site.domain}
        action="Clean"
        onClose={() => setConfirming(false)}
        onConfirm={(confirm) => {
          setConfirming(false);
          start('cleanCurrent', { user, confirm });
        }}
      />
      {footer}
    </Card>
  );
}

// ── clean copies ────────────────────────────────────────────

/** A site's key as its folders name it: local.shop.com, or local.shop.com@learn. */
const folderKey = (site: Site) => (site.path ? `${site.domain}@${site.path.slice(1).replaceAll('/', '@')}` : site.domain);

function LeftoverBadge({ copy }: { copy: CleanCopyInfo }) {
  const found = copy.leftoverEmails;
  if (!found) return null;
  if (found.total === 0) return <Badge tone="success">no emails left</Badge>;
  return <Badge tone="warning">{found.total.toLocaleString('en-US')} email{found.total === 1 ? '' : 's'} left</Badge>;
}

function CleanCopiesCard({ footer, site, copies, loading, busy, start, onDeleted }: { footer: ReactNode; 
  site: Site;
  copies: CleanCopyInfo[];
  loading: boolean;
  busy: boolean;
  start: Start;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState<CleanCopyInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function remove(copy: CleanCopyInfo) {
    const result = await api.runAction('db.deleteCleanCopy', { ...siteTarget(site), name: copy.name }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: 'Clean copy deleted' } : { tone: 'danger', title: 'Could not delete the clean copy', detail: lastLine(result.output) });
    setDeleting(null);
    onDeleted();
  }

  return (
    <Card>
      <CardHeader title="Clean copies" meta={<PackageCheck className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          A gzipped export of this site's database to share with the team, in ~/devmagic-panel-backups/clean/{folderKey(site)}. Check the site and set up its test modes first. The export counts the email addresses left in it, so anything private a cleanup missed shows.
        </p>
        <Button className="justify-self-start" disabled={busy} onClick={() => start('export', {})}>
          <PackageCheck />
          Export clean copy
        </Button>
        {copies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loading ? 'Loading clean copies...' : 'No clean copies yet.'}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {copies.map((c) => {
              const found = c.leftoverEmails;
              const expandable = Boolean(found && found.total > 0);
              return (
                <li key={c.name} className="grid grid-cols-[minmax(0,1fr)] gap-2 px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        {timeAgo(c.createdAt)}
                        <LeftoverBadge copy={c} />
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground" title={c.name}>{bytes(c.sizeBytes)} · {c.name}</p>
                    </div>
                    <div className="flex gap-1">
                      {expandable && (
                        <Button size="icon" variant="ghost" title="Where they are" aria-label={`Where the emails left in ${c.name} are`} aria-expanded={open === c.name} onClick={() => setOpen(open === c.name ? null : c.name)}>
                          <ChevronDown className={open === c.name ? 'rotate-180 transition-transform' : 'transition-transform'} />
                        </Button>
                      )}
                      <ButtonLink
                        size="icon"
                        variant="ghost"
                        href={cleanCopyUrl(site.domain, c.name, site.path)}
                        download
                        title="Download"
                        aria-label={`Download ${c.name}`}
                        onClick={(e) => {
                          if (!isMockup) return;
                          e.preventDefault();
                          toast({ tone: 'info', title: 'Mockup: this downloads the .sql.gz file' });
                        }}
                      >
                        <Download />
                      </ButtonLink>
                      <Button size="icon" variant="ghost" title="Delete" aria-label={`Delete ${c.name}`} disabled={busy} onClick={() => setDeleting(c)}><Trash2 /></Button>
                    </div>
                  </div>
                  {expandable && open === c.name && found && (
                    <div className="grid gap-1 rounded-md bg-muted px-3 py-2 text-xs">
                      <p className="text-muted-foreground">Check these before sharing it:</p>
                      {found.tables.map((t) => (
                        <p key={t.table} className="flex flex-wrap gap-x-2">
                          <span className="font-mono">{t.table}</span>
                          <span>{t.count.toLocaleString('en-US')}</span>
                          <span className="text-muted-foreground">{t.samples.join(', ')}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this clean copy?" description={deleting ? `${deleting.name} (${bytes(deleting.sizeBytes)}) is deleted for good.` : ''}>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => deleting && void remove(deleting)}><Trash2 />Delete</Button>
        </div>
      </Dialog>
      {footer}
    </Card>
  );
}

// ── kept databases ──────────────────────────────────────────

const daysLeft = (k: KeptDatabaseInfo) => Math.max(0, Math.ceil((new Date(k.purgeAt).getTime() - Date.now()) / 86_400_000));

function KeptCard({ footer, site, kept, loading, busy, start, onDeleted }: { footer: ReactNode; 
  site: Site;
  kept: KeptDatabaseInfo[];
  loading: boolean;
  busy: boolean;
  start: Start;
  onDeleted: () => void;
}) {
  const [restoring, setRestoring] = useState<KeptDatabaseInfo | null>(null);
  const [deleting, setDeleting] = useState<KeptDatabaseInfo | null>(null);

  async function remove(k: KeptDatabaseInfo) {
    const result = await api.runAction('db.deleteKept', { ...siteTarget(site), name: k.name }).catch((err: Error) => ({ ok: false, output: err.message }));
    toast(result.ok ? { tone: 'success', title: 'Kept database dropped' } : { tone: 'danger', title: 'Could not drop the kept database', detail: lastLine(result.output) });
    setDeleting(null);
    onDeleted();
  }

  return (
    <Card>
      <CardHeader title="Kept databases" meta={<Archive className="size-4 text-muted-foreground" />} />
      <CardBody className="grid-cols-[minmax(0,1fr)]">
        <p className="text-xs text-muted-foreground">
          Your tables from before an import or a clean. Put back swaps them in at once, and what it takes out is kept the same way. Each goes 7 days after it was made.
        </p>
        {kept.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loading ? 'Loading kept databases...' : 'No kept databases.'}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {kept.map((k) => {
              const left = daysLeft(k);
              return (
                <li key={k.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      {timeAgo(k.createdAt)}
                      <Badge tone={left <= 1 ? 'warning' : 'neutral'}>{left === 0 ? 'goes today' : `goes in ${left} day${left === 1 ? '' : 's'}`}</Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">{k.reason}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={k.name}>{k.sizeBytes !== undefined ? `${bytes(k.sizeBytes)} · ` : ''}{k.name}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" title="Put back" aria-label={`Put back ${k.name}`} disabled={busy} onClick={() => setRestoring(k)}><RotateCcw /></Button>
                    <Button size="icon" variant="ghost" title="Delete" aria-label={`Delete ${k.name}`} disabled={busy} onClick={() => setDeleting(k)}><Trash2 /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={restoring !== null}
        title="Put back these tables?"
        description={restoring ? `The tables kept ${timeAgo(restoring.createdAt)} go back into ${site.db?.name ?? 'the database'} at once, and the ones they take out, with any the swap brought in, are kept for 7 days in their place.` : ''}
        domain={site.domain}
        action="Put back"
        onClose={() => setRestoring(null)}
        onConfirm={(confirm) => {
          if (restoring) start('restoreKept', { name: restoring.name, confirm });
          setRestoring(null);
        }}
      />
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="Drop this kept database?" description={deleting ? `${deleting.name}${deleting.sizeBytes !== undefined ? ` (${bytes(deleting.sizeBytes)})` : ''} is dropped for good.` : ''}>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="soft" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => deleting && void remove(deleting)}><Trash2 />Drop</Button>
        </div>
      </Dialog>
      {footer}
    </Card>
  );
}

/**
 * From production, the top of Import a database: the server and folder saved
 * for the site, the tables whose rows stay there and whether the copy is
 * cleaned, then one button. Reads only on the server; here it imports as a
 * dump does, from a side database.
 */
function ProductionRefresh({ site, busy, start }: { site: Site; busy: boolean; start: Start }) {
  const saved = useAsync(() => api.productionSettings(site.domain, site.path), [site.domain, site.path]);
  const settings = saved.data ?? null;
  const [editing, setEditing] = useState(false);
  const [clean, setClean] = useState(false);
  const [keep, setKeep] = useState('');
  const [password, setPassword] = useState('admin');
  // The server's own password, when it asks for one: for the next refresh only, never saved with the settings.
  const [serverSecret, setServerSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setClean(settings?.clean ?? false);
    setKeep(settings?.keep ?? '');
  }, [settings]);
  const user = keep.trim() ? { keep: keep.trim(), login: keep.trim(), password } : { login: 'admin', password };
  const save = async (input: { host: string; path: string; excludeRows: string[]; wpCli?: string }) => {
    setError(null);
    try {
      await api.saveProductionSettings(site.domain, site.path, { host: input.host, folder: input.path, excludeRows: input.excludeRows, ...(input.wpCli ? { wpCli: input.wpCli } : {}), clean, ...(clean && keep.trim() ? { keep: keep.trim() } : {}) });
      saved.reload();
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const keepProblem = keep.trim() && !WP_LOGIN.test(keep.trim()) ? 'A login of letters, digits, spaces and _ . @ + -' : null;
  const db = site.db?.name ?? 'the database';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-muted-foreground" />
        <p className="font-medium">From production</p>
      </div>
      {saved.loading && <p className="text-muted-foreground">Reading the saved settings...</p>}
      {!saved.loading && !settings && !editing && (
        <>
          <p className="text-xs text-muted-foreground">Save the SSH server and the WordPress folder there once, and one button copies production&apos;s database from then on. It only reads there, with WP-CLI.</p>
          <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => setEditing(true)}>Set up production</Button>
        </>
      )}
      {editing && (
        <>
          <p className="text-xs text-muted-foreground">Copies production&apos;s database over SSH with WP-CLI, reading only: nothing is written there, and its database password stays there.</p>
          <FromServer
            working={busy}
            exportOnly
            clean={clean}
            setClean={setClean}
            takeLabel="Save"
            {...(settings ? { initial: { host: settings.host, path: settings.folder, excludeRows: settings.excludeRows, wpCli: settings.wpCli } } : {})}
            onTake={(input) => void save(input)}
            actions={<Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>}
            more={error && <p role="alert" className="text-danger">{error}</p>}
          />
        </>
      )}
      {!editing && settings && (
        <>
          <KeyValue
            labelWidth="sm"
            rows={[
              { label: 'From', value: <span className="block truncate font-mono text-dense" title={`${settings.host}:${settings.folder}`}>{settings.host}:{settings.folder}</span> },
              ...(settings.wpCli ? [{ label: 'WP-CLI', value: <span className="block truncate font-mono text-dense">{settings.wpCli}</span> }] : []),
              { label: 'Rows left out', value: settings.excludeRows.length ? `${settings.excludeRows.length} table${settings.excludeRows.length === 1 ? '' : 's'}` : 'none' },
              { label: 'The copy', value: settings.clean ? 'cleaned' : 'as it is' },
            ]}
          />
          {/* The one user a cleaned copy keeps and its password, together, where the refresh starts. */}
          {settings.clean && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={KEEP_LABEL} htmlFor="refresh-keep">
                <Input id="refresh-keep" value={keep} onChange={(e) => setKeep(e.target.value)} placeholder="admin" autoComplete="off" spellCheck={false} aria-invalid={keepProblem ? true : undefined} />
              </Field>
              <Field label={PASSWORD_LABEL} htmlFor="refresh-secret">
                <SecretInput id="refresh-secret" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {keepProblem && <p className="text-xs text-danger sm:col-span-2">{keepProblem}</p>}
              <p className="text-xs text-muted-foreground sm:col-span-2">An administrator's login on production, or empty for a new user, admin. {keepHint(Boolean(site.network))} The password is for this local copy only and is not saved.</p>
            </div>
          )}
          <ServerPassword id="refresh-server-secret" host={settings.host} value={serverSecret} onChange={setServerSecret} />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy || (settings.clean && (password === '' || keepProblem !== null))} onClick={() => setConfirming(true)}>
              <RefreshCw />
              Refresh {db} now
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Change</Button>
            <Button variant="soft" disabled={busy} title={`Forget ${settings.host}: the site has no saved server again`} onClick={() => void forgetProduction(site, () => saved.reload())}>Forget</Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Refresh ${db} from ${settings?.host ?? 'production'}?`}
        description={settings?.clean
          ? `The export is imported into a side database and cleaned there, then replaces ${db} at once: the tables it replaces are kept for 7 days under Kept databases, where Put back swaps them in again.`
          : `The export goes into a side database and its tables are swapped into ${db} at once: the tables it replaces are kept for 7 days under Kept databases, where Put back swaps them in again.`}
        domain={site.domain}
        action="Refresh"
        onClose={() => setConfirming(false)}
        onConfirm={(confirm) => {
          setConfirming(false);
          // The administrator you keep is remembered for the next refresh; its password never is.
          if (settings && settings.clean && keep.trim() !== (settings.keep ?? '')) {
            const { keep: _old, ...rest } = settings;
            void api.saveProductionSettings(site.domain, site.path, { ...rest, ...(keep.trim() ? { keep: keep.trim() } : {}) }).then(() => saved.reload(), () => undefined);
          }
          start('refresh', { user, confirm, ...(serverSecret ? { password: serverSecret } : {}) });
          setServerSecret('');
        }}
      />
    </div>
  );
}

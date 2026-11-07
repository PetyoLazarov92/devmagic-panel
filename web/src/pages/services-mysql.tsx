import type { ActionId, MysqlBackup, MysqlProcess, UploadResult, MysqlDatabase, MysqlDatabaseKind, MysqlReport, MysqlSiteRef, MysqlUser, MysqlUserKind } from '@devmagic-panel/shared';
import { Archive, ArrowLeft, Database, Gauge, KeyRound, LoaderCircle, OctagonX, RotateCcw, Table2, Trash2, Upload, Users, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DatabaseBrowser, type DbLocation } from '@/components/db-browser';
import { MysqlSettingsCard } from '@/components/mysql-settings';
import { SlowQueries } from '@/components/slow-queries';
import { SqlRunner, sqlSeed, sqlSeedState } from '@/components/sql-runner';
import { Segmented } from '@/components/ui/segmented';
import { settled, StepList, useJob } from '@/components/job-steps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { JobBox } from '@/components/job-box';
import { Dialog } from '@/components/ui/dialog';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { api } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { lastLine, runWithToast } from '@/lib/site-actions';
import { siteHref, siteName } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { CardSkeleton, Reading, TableSkeleton } from '@/components/skeletons';
import { CheckAgain, Notice } from '@/components/page';

const DB_KIND: Record<MysqlDatabaseKind, { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' }> = {
  site: { label: 'Site', tone: 'success' },
  kept: { label: 'Kept for a site', tone: 'primary' },
  unused: { label: 'Not used by a site', tone: 'neutral' },
  system: { label: "MySQL's own", tone: 'neutral' },
};

const USER_KIND: Record<MysqlUserKind, { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' }> = {
  site: { label: 'Site', tone: 'success' },
  panel: { label: "The panel's account", tone: 'primary' },
  leftover: { label: 'Left behind', tone: 'warning' },
  other: { label: 'Not used by a site', tone: 'neutral' },
  system: { label: "MySQL's own", tone: 'neutral' },
};

type DbFilter = 'all' | MysqlDatabaseKind;
const DB_FILTERS: Array<{ value: DbFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'site', label: 'Sites' },
  { value: 'unused', label: 'Not used by a site' },
  { value: 'kept', label: 'Kept' },
  { value: 'system', label: "MySQL's own" },
];

const account = (u: Pick<MysqlUser, 'user' | 'host'>) => `${u.user}@${u.host}`;

function SiteLinks({ sites, tab }: { sites?: MysqlSiteRef[]; tab?: string }) {
  if (!sites?.length) return null;
  return (
    <>
      {sites.map((s, i) => (
        <span key={siteName(s)}>
          {i > 0 && ', '}
          <Link href={`${siteHref(s)}${tab ? `?tab=${tab}` : ''}`} className="font-medium text-foreground hover:underline">{siteName(s)}</Link>
        </span>
      ))}
    </>
  );
}

/**
 * The Services page's MySQL tab: the server, every database and every
 * account, with what each is to the panel. A site's database and user stay
 * with the site; the rest can be analyzed, optimized or deleted, and
 * deletions are saved first so the job's Undo puts them back.
 */
export function MysqlTab({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const database = useQueryParam('db');
  return database ? <MysqlDatabaseView database={database} onLoading={onLoading} /> : <MysqlOverview refresh={refresh} onLoading={onLoading} />;
}

/** The browser's address for a database no site's tab holds: /services/mysql?db=reports&table=t&show=structure. */
export function mysqlDatabaseHref(database: string, location: DbLocation = { table: null, show: 'rows' }, sql = false): string {
  const q = new URLSearchParams({ db: database });
  if (sql) q.set('view', 'sql');
  else if (location.table) q.set('table', location.table);
  if (location.table && location.show === 'structure') q.set('show', 'structure');
  return `/services/mysql?${q.toString()}`;
}

/** Where a database opens: a site's in the site's Database tab, any other here. */
function browseHref(d: MysqlDatabase): string {
  const site = d.kind === 'site' ? d.sites?.[0] : undefined;
  return site ? `${siteHref(site)}?tab=database` : mysqlDatabaseHref(d.name);
}

/** One database's tables, rows and structure, read only, under the MySQL tab. */
function MysqlDatabaseView({ database, onLoading }: { database: string; onLoading: (loading: boolean) => void }) {
  const table = useQueryParam('table');
  const show = useQueryParam('show') === 'structure' ? 'structure' : 'rows';
  const sql = useQueryParam('view') === 'sql';
  // MySQL's own databases and the ones kept for a site are only read.
  const overview = useAsync(() => api.dbOverview(database), [database]);
  const canWrite = Boolean(overview.data && overview.data.kind !== 'system' && overview.data.kind !== 'kept');
  useEffect(() => onLoading(false), [onLoading]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/services/mysql" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />All databases
        </Link>
        <Segmented label="Database" value={sql ? 'sql' : 'tables'} onChange={(v) => navigate(mysqlDatabaseHref(database, undefined, v === 'sql'), { scroll: false })} options={[['tables', 'Tables'], ['sql', 'SQL']]} />
      </div>
      {sql ? (
        <SqlRunner key={`${database}-${canWrite}`} database={database} placeholder="SELECT * FROM a_table LIMIT 50" canWrite={canWrite} initialSql={sqlSeed()} />
      ) : (
        <DatabaseBrowser key={database} database={database} location={{ table, show }} onNavigate={(location) => navigate(mysqlDatabaseHref(database, location), { scroll: false })} />
      )}
    </div>
  );
}

function MysqlOverview({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const report = useAsync(() => api.mysql(), [refresh]);
  const runner = useJob();
  const [filter, setFilter] = useState<DbFilter>('all');
  const [dropping, setDropping] = useState<MysqlDatabase | null>(null);
  const [optimizing, setOptimizing] = useState<MysqlDatabase | null>(null);
  const [droppingUsers, setDroppingUsers] = useState<MysqlUser[] | null>(null);
  const [resetting, setResetting] = useState<MysqlUser | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const busy = runner.job !== null && !settled(runner.job);
  const lastDone = useRef<string | null>(null);
  const jobCard = useRef<HTMLDivElement>(null);

  useEffect(() => onLoading(report.loading), [report.loading, onLoading]);
  const { job } = runner;
  // A job started from far down the page shows at the top of the tab: it comes into view.
  const jobId = job?.id;
  useEffect(() => {
    if (jobId) jobCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [jobId]);
  useEffect(() => {
    if (!job || !settled(job) || lastDone.current === job.id) return;
    lastDone.current = job.id;
    report.reload();
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title}: done` });
  }, [job, report]);

  function start(id: ActionId, input: Record<string, unknown>) {
    void runner.follow(api.startJob(id, input));
  }

  async function analyze(database?: string) {
    setAnalyzing(database ?? '*');
    await runWithToast('mysql.analyze', database ? { database } : {}, database ? `${database} analyzed` : 'Every database analyzed');
    setAnalyzing(null);
    report.reload();
  }

  const data: MysqlReport | undefined = report.data;
  if (report.loading && !data) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Reading>Reading MySQL's databases and users...</Reading>
        <CardSkeleton lines={3} />
        <TableSkeleton columns={5} rows={8} />
      </div>
    );
  }
  if (report.error) return <Notice>{report.error}</Notice>;
  if (!data) return null;
  if (!data.server) {
    return (
      <div className="grid gap-4">
        <Notice tone="warning" action={<Link href="/environment" className="font-medium hover:underline">Environment</Link>}>
          {data.error ?? 'MySQL cannot be read.'}
        </Notice>
        {data.backups.length > 0 && <BackupsCard backups={data.backups} dir={data.backupsDir} onDeleted={report.reload} />}
      </div>
    );
  }

  const databases = data.databases.filter((d) => (filter === 'all' ? d.kind !== 'system' : d.kind === filter));
  const count = (f: DbFilter) => data.databases.filter((d) => (f === 'all' ? d.kind !== 'system' : d.kind === f)).length;
  const leftovers = data.users.filter((u) => u.kind === 'leftover');

  const dbMenu = (d: MysqlDatabase): MenuItem[] => {
    const browse = { label: 'Browse tables', icon: <Table2 />, onSelect: () => navigate(browseHref(d)) };
    if (d.kind === 'system') return [browse];
    const site = d.sites?.[0];
    return [
      ...(d.kind === 'site' ? [] : [browse]),
      ...(site ? [{ label: d.kind === 'kept' ? 'Open the site it is kept for' : "Open the site's Database tab", icon: <Database />, onSelect: () => navigate(`${siteHref(site)}?tab=database${d.kind === 'kept' ? '&view=tools' : ''}`) }] : []),
      { label: 'Analyze', icon: <Gauge />, disabled: analyzing !== null, onSelect: () => void analyze(d.name) },
      { label: 'Optimize...', icon: <Wand2 />, disabled: busy, onSelect: () => setOptimizing(d) },
      ...(d.kind === 'unused' ? [{ label: 'Delete...', icon: <Trash2 />, danger: true, disabled: busy, onSelect: () => setDropping(d) }] : []),
    ];
  };

  const userMenu = (u: MysqlUser): MenuItem[] => [
    ...(u.kind === 'site' && u.sites?.length === 1 ? [{ label: 'Reset password...', icon: <KeyRound />, onSelect: () => setResetting(u) }] : []),
    ...(u.kind === 'leftover' || u.kind === 'other' ? [{ label: 'Delete...', icon: <Trash2 />, danger: true, disabled: busy, onSelect: () => setDroppingUsers([u]) }] : []),
  ];

  return (
    <div className="grid gap-4">
      {(runner.job || runner.error) && (
        <div ref={jobCard} className="scroll-mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{runner.job?.title ?? 'Job'}</CardTitle>
              {busy && <LoaderCircle className="size-4 animate-spin text-primary" />}
            </CardHeader>
            <div className="grid gap-3 p-5">
              {runner.job && <JobSteps steps={runner.job.steps} />}
              {runner.job?.status === 'failed' && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex-1 text-sm text-danger">{lastLine(runner.job.steps.find((s) => s.status === 'failed')?.output ?? '')}</p>
                  <Button variant="outline" onClick={() => void runner.retry()}><RotateCcw />Retry</Button>
                </div>
              )}
              {runner.job && settled(runner.job) && runner.job.undoable.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  To take it back, use Undo on <Link href={`/jobs/${encodeURIComponent(runner.job.id)}`} className="font-medium text-foreground hover:underline">the job&apos;s page</Link>.
                </p>
              )}
              {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{data.server.product} server</CardTitle><Database className="size-4 text-muted-foreground" /></CardHeader>
        <div className="flex flex-wrap items-end gap-4 p-5">
          <dl className="grid flex-1 grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="break-all">{data.server.version}</dd>
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd className="font-mono text-[13px] break-all">{data.server.account}</dd>
            {data.server.datadir && (
              <>
                <dt className="text-muted-foreground">Data folder</dt>
                <dd className="font-mono text-[13px] break-all">{data.server.datadir}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Size</dt>
            <dd>{bytes(data.server.totalBytes)} in {data.databases.length} databases, read {timeAgo(data.checkedAt)}</dd>
          </dl>
          <Button variant="outline" disabled={analyzing !== null} onClick={() => void analyze()} title="ANALYZE TABLE on every table, so sizes and row counts are current">
            {analyzing === '*' ? <LoaderCircle className="animate-spin" /> : <Gauge />}
            Analyze all
          </Button>
        </div>
      </Card>

      <MysqlSettingsCard />

      <ProcessesCard refresh={refresh} />

      <Card>
        <CardHeader><CardTitle>Slow queries</CardTitle><Gauge className="size-4 text-muted-foreground" /></CardHeader>
        <div className="p-5">
          <SlowQueries inCard onExplain={(sql, database) => database && navigate(mysqlDatabaseHref(database, undefined, true), { state: sqlSeedState(sql) })} />
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Databases</CardTitle><Database className="size-4 text-muted-foreground" /></CardHeader>
        <div className="flex flex-wrap gap-1.5 px-5 pt-4" role="group" aria-label="Show">
          {DB_FILTERS.filter((f) => f.value === 'all' || count(f.value) > 0).map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted', filter === f.value ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground')}
            >
              {f.label} <span className="tabular-nums">{count(f.value)}</span>
            </button>
          ))}
        </div>
        <ul className="mt-2 divide-y">
          {databases.map((d) => (
            <li key={d.name} className="flex items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={browseHref(d)} className="font-mono text-[13px] break-all hover:underline">{d.name}</Link>
                  <Badge tone={DB_KIND[d.kind].tone}>{DB_KIND[d.kind].label}</Badge>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {bytes(d.sizeBytes)} in {d.tables} {d.tables === 1 ? 'table' : 'tables'}
                  {d.sites?.length ? <>{' · '}<SiteLinks sites={d.sites} tab="database" /></> : null}
                </p>
              </div>
              {analyzing === d.name && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
              {dbMenu(d).length > 0 && <Menu items={dbMenu(d)} label={`Actions for ${d.name}`} />}
            </li>
          ))}
          {databases.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No databases here.</li>}
        </ul>
      </Card>

      <ImportDumpCard databases={data.databases} onDone={report.reload} />

      <Card>
        <CardHeader><CardTitle>Users</CardTitle><Users className="size-4 text-muted-foreground" /></CardHeader>
        {data.usersError && <p role="alert" className="mx-5 mt-4 text-sm text-danger">{data.usersError}</p>}
        {leftovers.length > 0 && (
          <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/6 px-4 py-3 text-sm">
            <p className="min-w-0 flex-[1_1_18rem]">
              {leftovers.length === 1 ? '1 user has' : `${leftovers.length} users have`} access to no database that exists, like a site&apos;s user left after its database went. A new install that needs the name takes the next free one.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDroppingUsers(leftovers)}>
              <Trash2 />
              Delete {leftovers.length === 1 ? 'it' : `all ${leftovers.length}`}
            </Button>
          </div>
        )}
        <ul className="mt-2 divide-y">
          {data.users.map((u) => (
            <li key={account(u)} className="flex items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] break-all">{account(u)}</span>
                  <Badge tone={USER_KIND[u.kind].tone}>{USER_KIND[u.kind].label}</Badge>
                </p>
                <p className="mt-0.5 text-xs break-words text-muted-foreground">
                  {u.global ? 'Rights on every database' : u.databases.length ? <>Access to <span className="font-mono">{u.databases.join(', ')}</span></> : 'Access to no database'}
                  {u.missing.length > 0 && <>{'; had access to '}<span className="font-mono">{u.missing.join(', ')}</span>{u.missing.length === 1 ? ', which is gone' : ', which are gone'}</>}
                  {u.sites?.length ? <>{' · used by '}<SiteLinks sites={u.sites} /></> : null}
                </p>
              </div>
              {userMenu(u).length > 0 && <Menu items={userMenu(u)} label={`Actions for ${account(u)}`} />}
            </li>
          ))}
        </ul>
      </Card>

      <BackupsCard backups={data.backups} dir={data.backupsDir} onDeleted={report.reload} />

      <DropDatabaseDialog database={dropping} onClose={() => setDropping(null)} onConfirm={(d) => start('mysql.dropDatabase', { database: d.name })} />
      <OptimizeDialog database={optimizing} onClose={() => setOptimizing(null)} onConfirm={(d) => start('mysql.optimize', { database: d.name })} />
      <DropUsersDialog users={droppingUsers} onClose={() => setDroppingUsers(null)} onConfirm={(list) => start('mysql.dropUsers', { accounts: list.map((u) => ({ user: u.user, host: u.host })) })} />
      <ResetUserDialog user={resetting} onClose={() => setResetting(null)} onDone={report.reload} />
    </div>
  );
}

/** What deleted databases and users left for Undo: listed with when each goes, and deleted sooner on request. */
function BackupsCard({ backups, dir, onDeleted }: { backups: MysqlBackup[]; dir: string; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState<MysqlBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const total = backups.reduce((n, b) => n + b.sizeBytes, 0);

  async function remove(backup: MysqlBackup) {
    setBusy(true);
    const result = await runWithToast('mysql.deleteBackup', { name: backup.name }, `${backup.subject}: saved copy deleted`);
    setBusy(false);
    setDeleting(null);
    if (result?.ok) onDeleted();
  }

  return (
    <Card>
      <CardHeader><CardTitle>Saved copies</CardTitle><Archive className="size-4 text-muted-foreground" /></CardHeader>
      <p className="px-5 pt-4 text-xs text-muted-foreground">
        What deleted databases and users left for Undo, in <span className="font-mono break-all">{dir}</span>. Each goes 14 days after it was saved{backups.length > 0 ? `; ${bytes(total)} now` : ''}.
      </p>
      {backups.length === 0 ? (
        <p className="px-5 pt-2 pb-4 text-sm text-muted-foreground">Nothing saved. Deleting a database or a user here saves it first.</p>
      ) : (
        <ul className="mt-2 divide-y">
          {backups.map((b) => (
            <li key={b.name} className="flex items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] break-all">{b.subject}</span>
                  <Badge>{b.kind === 'database' ? 'Database' : b.subject.includes(',') ? 'Users' : 'User'}</Badge>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {bytes(b.sizeBytes)} · saved {timeAgo(b.savedAt)} · goes {shortDate(b.purgeAt)} · <span className="font-mono break-all">{b.name}</span>
                </p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Delete the saved copy ${b.name}`} disabled={busy} onClick={() => setDeleting(b)}>
                <Trash2 />
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete the saved copy of ${deleting?.subject ?? ''}?`}
        description={`${deleting?.name ?? ''} goes now instead of on ${deleting ? shortDate(deleting.purgeAt) : ''}. Undo on the job that deleted ${deleting?.kind === 'database' ? 'the database' : 'the users'} cannot put ${deleting?.kind === 'database' ? 'it' : 'them'} back afterwards.`}
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => deleting && void remove(deleting)}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Delete for good
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function JobSteps({ steps }: { steps: Parameters<typeof StepList>[0]['steps'] }) {
  const [open, setOpen] = useState<string | null>(null);
  return <StepList steps={steps} open={open} setOpen={setOpen} />;
}

function DropDatabaseDialog({ database, onClose, onConfirm }: { database: MysqlDatabase | null; onClose: () => void; onConfirm: (d: MysqlDatabase) => void }) {
  const [typed, setTyped] = useState('');
  const close = () => {
    setTyped('');
    onClose();
  };
  return (
    <Dialog
      open={database !== null}
      onClose={close}
      title={`Delete ${database?.name ?? ''}?`}
      description={`No site on this machine uses it, but another project might. It is exported to the panel's MySQL backups first (${bytes(database?.sizeBytes ?? 0)} of tables) and kept 14 days, so Undo on the job puts it back.`}
    >
      <ConfirmField id="mysql-drop-confirm" expected={database?.name ?? ''} value={typed} onChange={setTyped} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          disabled={typed !== database?.name}
          onClick={() => {
            if (database) onConfirm(database);
            close();
          }}
        >
          <Trash2 />
          Export and delete
        </Button>
      </div>
    </Dialog>
  );
}

function OptimizeDialog({ database, onClose, onConfirm }: { database: MysqlDatabase | null; onClose: () => void; onConfirm: (d: MysqlDatabase) => void }) {
  return (
    <Dialog
      open={database !== null}
      onClose={onClose}
      title={`Optimize ${database?.name ?? ''}?`}
      description={`Rebuilds each of its ${database?.tables ?? 0} tables, which gives the space of deleted rows back to the disk, as after cleared logs. On ${bytes(database?.sizeBytes ?? 0)} this can take a while, and each table is busy while it is rebuilt.`}
    >
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => {
            if (database) onConfirm(database);
            onClose();
          }}
        >
          <Wand2 />
          Optimize
        </Button>
      </div>
    </Dialog>
  );
}

function DropUsersDialog({ users, onClose, onConfirm }: { users: MysqlUser[] | null; onClose: () => void; onConfirm: (list: MysqlUser[]) => void }) {
  const list = users ?? [];
  return (
    <Dialog
      open={users !== null}
      onClose={onClose}
      title={list.length === 1 ? `Delete ${account(list[0] as MysqlUser)}?` : `Delete ${list.length} users?`}
      description="No site on this machine signs in with them. Each account and its rights are saved to the panel's MySQL backups first and kept 14 days, so Undo on the job makes them again."
    >
      {list.length > 1 && (
        <ul className="mt-3 max-h-48 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[13px]">
          {list.map((u) => <li key={account(u)}>{account(u)}</li>)}
        </ul>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm(list);
            onClose();
          }}
        >
          <Trash2 />
          Save and delete
        </Button>
      </div>
    </Dialog>
  );
}

function ResetUserDialog({ user, onClose, onDone }: { user: MysqlUser | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const site = user?.sites?.[0];
  async function reset() {
    if (!site) return;
    setBusy(true);
    const result = await runWithToast('mysql.resetSiteUser', { domain: site.domain, ...(site.path ? { path: site.path } : {}) }, `${user?.user ?? 'The user'} has a new password`);
    setBusy(false);
    if (result?.ok) {
      onClose();
      onDone();
    }
  }
  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title={`Reset ${user?.user ?? ''}?`}
      description={`${user?.user ?? ''} gets a new password, written to the wp-config.php of ${site ? siteName(site) : 'its site'} first. Anything else that signs in as ${user?.user ?? 'it'} with the old one stops working.`}
    >
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void reset()}>
          {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          Reset password
        </Button>
      </div>
    </Dialog>
  );
}


/**
 * What MySQL runs now, the longest first, without idle connections unless
 * asked; Stop ends one statement (KILL QUERY) and leaves its connection.
 */
function ProcessesCard({ refresh }: { refresh: number }) {
  const [tick, setTick] = useState(0);
  const list = useAsync(() => api.mysqlProcesses(), [refresh, tick]);
  const [idle, setIdle] = useState(false);
  const [stopping, setStopping] = useState<MysqlProcess | null>(null);
  const all = list.data ?? [];
  const shown = all.filter((p) => idle || (p.command !== 'Sleep' && p.command !== 'Daemon'));
  const hidden = all.length - shown.length;
  const own = (p: MysqlProcess) => p.user === 'system user' || p.user === 'event_scheduler' || p.command === 'Daemon';

  async function stop(p: MysqlProcess) {
    setStopping(null);
    await runWithToast('mysql.killQuery', { id: p.id }, `Statement ${p.id} stopped`);
    setTick((n) => n + 1);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Processes</CardTitle>
        <div className="flex items-center gap-1">
          <CheckAgain size="sm" onClick={() => setTick((n) => n + 1)} loading={list.loading} />
        </div>
      </CardHeader>
      {list.error && <p role="alert" className="mx-5 mt-4 text-sm text-danger">{list.error}</p>}
      <div className="flex flex-wrap items-center gap-3 px-5 pt-3 text-xs text-muted-foreground">
        <span className="flex-1">{shown.length ? 'What MySQL runs now, the longest first.' : 'MySQL runs no statement now.'}</span>
        {(hidden > 0 || idle) && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={idle} onChange={(e) => setIdle(e.target.checked)} />
            Show idle connections and MySQL&apos;s own{hidden > 0 ? ` (${hidden})` : ''}
          </label>
        )}
      </div>
      <ul className={cn('mt-2 divide-y', !shown.length && 'pb-2')}>
        {shown.map((p) => (
          <li key={p.id} className="grid gap-1 px-5 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
              <span className="font-medium">{p.user}</span>
              {p.db && <span className="font-mono text-[13px] text-muted-foreground">{p.db}</span>}
              <Badge tone={p.command === 'Query' && p.seconds >= 10 ? 'warning' : 'neutral'}>{p.command} · {p.seconds >= 60 ? `${Math.floor(p.seconds / 60)} min ${p.seconds % 60} s` : `${p.seconds} s`}</Badge>
              {p.state && <span className="text-xs text-muted-foreground">{p.state}</span>}
              {p.command === 'Query' && !own(p) && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setStopping(p)}><OctagonX />Stop</Button>
              )}
            </div>
            {p.info && <p className="truncate font-mono text-xs text-muted-foreground" title={p.info}>{p.info}</p>}
          </li>
        ))}
      </ul>
      <Dialog open={stopping !== null} onClose={() => setStopping(null)} title={`Stop statement ${stopping?.id ?? ''}?`} description="MySQL ends the statement; a change it was making is rolled back on InnoDB tables, and its connection stays. The page or job that ran it gets an error.">
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setStopping(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => stopping && void stop(stopping)}><OctagonX />Stop the statement</Button>
        </div>
      </Dialog>
    </Card>
  );
}

const NAME = /^[A-Za-z0-9_$-]{1,64}$/;

/**
 * An uploaded dump into a new database, or into one no site uses after it is
 * saved to the MySQL backups. A site's database imports on its own Database
 * tab, where the panel also replaces production addresses.
 */
function ImportDumpCard({ databases, onDone }: { databases: MysqlDatabase[]; onDone: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'replace'>('new');
  const [name, setName] = useState('');
  const unused = databases.filter((d) => d.kind === 'unused');
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState('');
  const runner = useJob();
  const { job } = runner;
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    onDone();
    if (job.status === 'done') toast({ tone: 'success', title: `${job.title}: done` });
  }, [job, onDone]);
  const busy = job !== null && !settled(job);
  const database = mode === 'new' ? name.trim() : target;
  const taken = mode === 'new' && databases.some((d) => d.name === database);
  const ready = Boolean(upload) && NAME.test(database) && !taken && (mode === 'new' || confirm === database) && !busy;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const result = await api.upload(file, setProgress);
      setUpload(result);
      if (!name) setName(file.name.replace(/\.(sql|gz|zip)$/gi, '').replace(/\.(sql|gz)$/gi, '').replace(/[^A-Za-z0-9_$-]+/g, '_').slice(0, 64));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  function start() {
    if (!upload) return;
    void runner.follow(api.startJob('mysql.importDump', { database, uploadId: upload.id, mode, ...(mode === 'replace' ? { confirm } : {}) }));
  }

  return (
    <>
      <Card>
        <CardHeader><CardTitle>Import a dump</CardTitle><Upload className="size-4 text-muted-foreground" /></CardHeader>
        <div className="grid gap-4 p-5">
          <p className="text-sm text-muted-foreground">
            A .sql, .sql.gz or .zip into a new database, or into one no site uses. Its own CREATE DATABASE and USE lines are left out, so it changes no other database. For a site, use Import a dump on the site&apos;s Database tab, which also replaces production addresses.
          </p>
          <input ref={fileInput} id="mysql-import-file" type="file" accept=".sql,.gz,.zip" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy || progress !== null} onClick={() => fileInput.current?.click()}>
              {progress !== null ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : upload ? 'Choose another dump' : 'Choose a dump'}
            </Button>
            {upload && <span className="text-sm">{upload.name} · {bytes(upload.size)}</span>}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {upload && (
            <>
              <Segmented label="Into" value={mode} onChange={(m) => (setMode(m), setConfirm(''))} options={[['new', 'A new database'], ['replace', 'A database no site uses']]} className="justify-self-start" />
              {mode === 'new' ? (
                <Field label="Name of the new database" htmlFor="mysql-import-name" hint={taken ? `${database} is there already: pick A database no site uses to replace it` : 'Letters, digits, underscores, dollar signs and hyphens, up to 64 characters'}>
                  <Input id="mysql-import-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" aria-invalid={taken || (name !== '' && !NAME.test(name.trim()))} />
                </Field>
              ) : unused.length ? (
                <div className="grid gap-3">
                  <Field label="Database to replace" htmlFor="mysql-import-target" hint="Saved to the MySQL backups first (14 days), then emptied; Undo on the job puts it back.">
                    <Select id="mysql-import-target" value={target} onChange={(e) => (setTarget(e.target.value), setConfirm(''))}>
                      <option value="">Pick one</option>
                      {unused.map((d) => <option key={d.name} value={d.name}>{d.name} ({bytes(d.sizeBytes)})</option>)}
                    </Select>
                  </Field>
                  {target && <ConfirmField id="mysql-import-confirm" expected={target} value={confirm} onChange={setConfirm} />}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No database here is free of sites to replace: import into a new one.</p>
              )}
              <div>
                <Button disabled={!ready} onClick={start}>
                  {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
                  {mode === 'replace' ? `Save ${target || 'it'} and import` : `Import into ${database || 'the new database'}`}
                </Button>
              </div>
            </>
          )}
          {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
          {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
        </div>
      </Card>
    </>
  );
}

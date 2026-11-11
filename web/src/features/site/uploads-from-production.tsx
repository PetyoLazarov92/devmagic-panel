import { type ProductionSettings, type Site, type UploadsCompare, type UploadsFolder, type UploadsHere, type UploadsKind, FILE_TRASH_DAYS, isWpCliCommand, splitSshHost, UPLOADS_LISTED } from '@devmagic-panel/shared';
import { CloudDownload, GitCompareArrows, HardDrive, Server } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { JobFooter } from '@/features/jobs/job-box';
import { useJob } from '@/features/jobs/job-steps';
import { EmptyState, Notice } from '@/components/layout/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { forgetProduction } from '@/lib/production';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { siteTarget } from '@/lib/site-ref';
import { ServerPassword } from '@/features/new-site/database';
import { Spinner } from '@/components/ui/spinner';

/**
 * Uploads from production, the Files tab's second view: what the site's own
 * server has in wp-content/uploads next to what is here, folder by folder,
 * and a copy of the folders you tick. One way only: the server is read, and
 * here files are only added. A file that changed on production comes only
 * when you switch that on, and the one it replaces goes to the file trash.
 */

/** What stays on the server whatever you tick. */
const NEVER = 'PHP files, links, .htaccess, database dumps, and the cache and backup folders of plugins';
/** The room the copy leaves free, as the server checks it. */
const SPARE = 1024 ** 3;

const GROUPS: ReadonlyArray<{ kind: UploadsKind; title: string; about: string }> = [
  { kind: 'media', title: 'Media', about: 'What the media library holds, by month.' },
  { kind: 'generated', title: 'Generated and rebuildable', about: 'Styles and converted images that plugins make again on their own.' },
  { kind: 'private', title: 'Private data', about: 'Form entries, order files, paid downloads and members\' files: what real people sent or bought.' },
  { kind: 'other', title: 'Other folders', about: 'Folders of plugins the panel does not know, and the files right in uploads.' },
];

const count = (n: number, one: string) => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2026/11 as November 2026, a dot as the files right in uploads, a folder by its name. */
function folderLabel(f: UploadsFolder): string {
  const key = f.key.replace(/^sites\/\d+\//, '');
  const month = /^(\d{4})\/(\d{2})$/.exec(key);
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`;
  return key === '.' ? 'Files right in uploads' : key;
}

function ServerForm({ site, saved, onSaved, onCancel }: { site: Site; saved: ProductionSettings | null; onSaved: (s: ProductionSettings) => void; onCancel?: () => void }) {
  const [host, setHost] = useState(saved?.host ?? '');
  const [folder, setFolder] = useState(saved?.folder ?? '');
  const [wpCli, setWpCli] = useState(saved?.wpCli ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostOk = splitSshHost(host.trim()) !== null;
  const folderOk = /^\/[A-Za-z0-9._/-]+$/.test(folder.trim()) && !folder.split('/').includes('..');
  const wpCliOk = wpCli.trim() === '' || isWpCliCommand(wpCli.trim());
  const save = () => {
    setSaving(true);
    setError(null);
    // The other settings Refresh from production keeps for the site stay as they are.
    const { wpCli: _was, ...kept } = saved ?? { excludeRows: [], clean: false };
    void api.saveProductionSettings(site.domain, site.path, { ...kept, host: host.trim(), folder: folder.trim(), ...(wpCli.trim() ? { wpCli: wpCli.trim() } : {}) } as ProductionSettings)
      .then(onSaved, (e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };
  return (
    <div className="grid gap-2.5 text-left">
      <div className="grid gap-1.5">
        <label htmlFor="uploads-server-host" className="text-xs font-medium">SSH host</label>
        <Input id="uploads-server-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="deploy@www.spellbook.example, or an alias from ~/.ssh/config" className="font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={host.trim() !== '' && !hostOk ? true : undefined} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="uploads-server-folder" className="text-xs font-medium">WordPress folder on the server</label>
        <Input id="uploads-server-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/var/www/spellbook" className="font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={folder.trim() !== '' && !folderOk ? true : undefined} />
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer font-medium text-primary">WP-CLI has another name on the server?</summary>
        <Input aria-label="WP-CLI command on the server" value={wpCli} onChange={(e) => setWpCli(e.target.value)} placeholder="wp" className="mt-2 font-mono text-dense" autoComplete="off" spellCheck={false} aria-invalid={!wpCliOk ? true : undefined} />
      </details>
      <p className="text-xs text-muted-foreground">Saved for this site, with no password. Refresh from production and Missing plugins use the same server and folder.</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!hostOk || !folderOk || !wpCliOk || saving} onClick={save}>{saving && <Spinner />}Save the server</Button>
        {onCancel && <Button variant="soft" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

export function UploadsFromProduction({ site }: { site: Site }) {
  const [production, setProduction] = useState<ProductionSettings | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [here, setHere] = useState<UploadsHere | null>(null);
  const [compare, setCompare] = useState<UploadsCompare | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [originalsOnly, setOriginalsOnly] = useState(false);
  const [maxMb, setMaxMb] = useState('');
  const [changed, setChanged] = useState(false);
  const copy = useJob();

  const readHere = () => void api.uploadsHere(site.domain, site.path).then(setHere, () => setHere(null));
  useEffect(() => {
    setProduction(undefined);
    setCompare(null);
    setError(null);
    setEditing(false);
    void api.productionSettings(site.domain, site.path).then(setProduction, () => setProduction(null));
    readHere();
  }, [site.domain, site.path]);

  const run = () => {
    if (!production) return;
    setComparing(true);
    setError(null);
    void api.compareUploads(site.domain, site.path, { host: production.host, folder: production.folder, ...(production.wpCli ? { wpCli: production.wpCli } : {}), ...(secret ? { password: secret } : {}) })
      .then((c) => {
        setCompare(c);
        // Only media with something new starts ticked.
        setTicked(new Set(c.folders.filter((f) => f.kind === 'media' && f.newFiles > 0).map((f) => f.key)));
        setChanged(false);
      }, (e: Error) => setError(e.message))
      .finally(() => setComparing(false));
  };
  // A finished or stopped copy changed what is here: read both sides again.
  const status = copy.job?.status;
  useEffect(() => {
    if (status !== 'done' && status !== 'failed') return;
    readHere();
    if (compare) run();
  }, [status]);

  const folders = compare?.folders ?? [];
  const media = useMemo(() => folders.filter((f) => f.kind === 'media' && !f.site), [folders]);
  const picked = folders.filter((f) => ticked.has(f.key));
  const files = picked.reduce((n, f) => n + f.newFiles - (originalsOnly ? f.newResizedFiles : 0), 0);
  const size = picked.reduce((n, f) => n + f.newBytes - (originalsOnly ? f.newResizedBytes : 0), 0);
  const changedFiles = changed ? picked.reduce((n, f) => n + f.changedFiles, 0) : 0;
  const changedBytes = changed ? picked.reduce((n, f) => n + f.changedBytes, 0) : 0;
  const max = Number(maxMb);
  const maxOk = maxMb.trim() === '' || (Number.isInteger(max) && max >= 1 && max <= 100_000);
  const fits = !compare || size + changedBytes + SPARE <= compare.freeBytes;
  const running = status === 'running' || status === 'queued';
  const tick = (keys: readonly string[], on: boolean) => setTicked((t) => {
    const next = new Set(t);
    for (const k of keys) (on ? next.add(k) : next.delete(k));
    return next;
  });
  const lastMonths = (n: number) => setTicked(new Set(media.slice(0, n).filter((f) => f.newFiles > 0).map((f) => f.key)));

  if (production === undefined) return <p className="text-sm text-muted-foreground" role="status">Reading the site's server...</p>;
  if (!production) {
    return (
      <EmptyState icon={Server} title="Name the site's server first" action={<div className="w-[min(28rem,80vw)]"><ServerForm site={site} saved={null} onSaved={setProduction} /></div>}>
        The panel compares wp-content/uploads on the server production runs on with what is here, over SSH, and copies the folders you choose. It only reads there: nothing is written or deleted on the server.
      </EmptyState>
    );
  }

  const start = () => void copy.follow(api.startJob('site.copyUploads', {
    ...siteTarget(site),
    host: production.host,
    folder: production.folder,
    ...(production.wpCli ? { wpCli: production.wpCli } : {}),
    folders: picked.filter((f) => f.newFiles > 0 || (changed && f.changedFiles > 0)).map((f) => f.key),
    ...(originalsOnly ? { originalsOnly: true } : {}),
    ...(maxMb.trim() ? { maxFileMb: max } : {}),
    ...(changed ? { changed: true } : {}),
    ...(secret ? { password: secret } : {}),
  }));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><HardDrive className="size-4 text-muted-foreground" aria-hidden />Here</span>} />
          <CardBody>
            <KeyValue
              rows={[
                { label: 'Uploads', value: here ? (here.exists ? `${count(here.files, 'file')}, ${bytes(here.bytes)}` : 'No uploads folder yet') : 'Reading...' },
                { label: 'Free space', value: here ? bytes(here.freeBytes) : 'Reading...' },
                { label: 'Last copy', value: here?.last ? <><time dateTime={here.last.at} title={dateTime(here.last.at)}>{timeAgo(here.last.at)}</time> from {here.last.host}</> : 'None yet' },
                { label: 'Missing ones', value: site.uploadsFrom ? `Load from ${site.uploadsFrom.host} when a page asks for them, so pages show their pictures without a copy` : 'Show as broken pictures until they are copied' },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={<span className="flex items-center gap-2"><Server className="size-4 text-muted-foreground" aria-hidden />The site&apos;s server</span>}
            actions={!editing && (
              <span className="flex gap-1">
                <Button size="sm" variant="soft" onClick={() => setEditing(true)}>Change</Button>
                <Button size="sm" variant="soft" title={`Forget ${production.host}: the site has no saved server again`} onClick={() => void forgetProduction(site, (now) => { setProduction(now); setCompare(null); setSecret(''); })}>Forget</Button>
              </span>
            )}
          />
          <CardBody className="gap-3">
            {editing ? (
              <ServerForm site={site} saved={production} onCancel={() => setEditing(false)} onSaved={(s) => { setProduction(s); setEditing(false); setCompare(null); setSecret(''); }} />
            ) : (
              <>
                <code className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">{production.host}:{compare?.dir ?? `${production.folder}/wp-content/uploads`}</code>
                <ServerPassword id="uploads-server-secret" host={production.host} value={secret} onChange={setSecret} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button variant={compare ? 'outline' : 'default'} disabled={comparing || running} onClick={run}>
                    {comparing ? <Spinner /> : <GitCompareArrows />}
                    {compare ? 'Compare again' : 'Compare'}
                  </Button>
                  {compare && <span className="text-muted-foreground">{count(compare.files, 'file')}, {bytes(compare.bytes)} on the server</span>}
                </div>
                <p className="text-xs text-muted-foreground">Compare lists the files on the server and reads the ones here. Nothing is copied, and nothing is written or deleted on the server.</p>
              </>
            )}
          </CardBody>
        </Card>
      </div>
      {error && <Notice>{error}</Notice>}

      {compare && (
        <Card>
          <CardHeader
            title="What to bring"
            actions={
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="soft" onClick={() => setTicked(new Set(folders.filter((f) => f.kind === 'media' && f.newFiles > 0).map((f) => f.key)))}>All media</Button>
                {[3, 12].map((n) => media.length > n && <Button key={n} size="sm" variant="soft" onClick={() => lastMonths(n)}>Last {n} months</Button>)}
                <Button size="sm" variant="soft" onClick={() => setTicked(new Set())}>Nothing</Button>
              </div>
            }
          />
          <CardBody className="gap-5">
            {GROUPS.map((group) => {
              const rows = folders.filter((f) => f.kind === group.kind);
              if (rows.length === 0) return null;
              const fresh = rows.filter((f) => f.newFiles > 0 || f.changedFiles > 0);
              const all = fresh.length > 0 && fresh.every((f) => ticked.has(f.key));
              const id = `uploads-group-${group.kind}`;
              return (
                <section key={group.kind} aria-labelledby={id} className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <input type="checkbox" aria-label={`All of ${group.title}`} disabled={fresh.length === 0} checked={all} onChange={(e) => tick(fresh.map((f) => f.key), e.target.checked)} className="size-4 shrink-0 accent-[var(--primary)]" />
                    <h3 id={id} className="font-medium">{group.title}</h3>
                    <span className="text-xs text-muted-foreground">{group.about}</span>
                  </div>
                  {group.kind === 'private' && rows.some((f) => ticked.has(f.key)) && (
                    <Notice tone="warning">These folders hold what real people sent or bought. Bring them only when the work needs them, and keep this computer's disk in mind: they stay here until you delete them.</Notice>
                  )}
                  <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
                    {rows.map((f) => {
                      const nothing = f.newFiles === 0 && f.changedFiles === 0;
                      const fid = `uploads-${f.key.replace(/[^\w-]/g, '-')}`;
                      return (
                        <li key={f.key} className="flex items-start gap-2.5">
                          <input id={fid} type="checkbox" disabled={nothing} checked={ticked.has(f.key) && !nothing} onChange={(e) => tick([f.key], e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                          <label htmlFor={fid} className="grid min-w-0 gap-0.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className={group.kind === 'media' ? '' : 'font-mono text-xs [overflow-wrap:anywhere]'}>{folderLabel(f)}</span>
                              {f.site !== undefined && <Badge>site {f.site}</Badge>}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {nothing ? `All ${count(f.files, 'file')} here` : [f.newFiles > 0 ? `${count(f.newFiles, 'new file')}, ${bytes(f.newBytes)}` : '', f.changedFiles > 0 ? `${f.changedFiles.toLocaleString('en')} changed` : ''].filter(Boolean).join(', ')}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            <p className="text-xs text-muted-foreground">Never copied: {NEVER}.{compare.unusual > 0 && ` ${count(compare.unusual, 'folder')} on the server ${compare.unusual === 1 ? 'has' : 'have'} a name the panel does not take, and ${compare.unusual === 1 ? 'is' : 'are'} left there.`}</p>

            <div className="grid gap-3 border-t pt-4">
              <label className="flex items-start gap-2.5">
                <Switch checked={originalsOnly} onChange={setOriginalsOnly} label="Originals only" />
                <span className="grid gap-0.5"><span className="font-medium">Originals only</span><span className="text-xs text-muted-foreground">Leaves resized copies like photo-300x200.jpg on the server. WordPress makes them again with <code className="font-mono">wp media regenerate</code>; until then pages ask for sizes that are not here.</span></span>
              </label>
              <label className="flex flex-wrap items-center gap-2.5">
                <span className="font-medium">Skip files larger than</span>
                <Input value={maxMb} onChange={(e) => setMaxMb(e.target.value)} inputMode="numeric" placeholder="no limit" aria-label="Skip files larger than, in MB" aria-invalid={!maxOk ? true : undefined} className="h-8 w-24 text-xs" />
                <span className="text-muted-foreground">MB</span>
              </label>
              {compare.changedFiles > 0 && (
                <div className="grid gap-2">
                  <label className="flex items-start gap-2.5">
                    <Switch checked={changed} onChange={setChanged} label="Also bring files that changed on production" />
                    <span className="grid gap-0.5">
                      <span className="font-medium">Also bring the {count(compare.changedFiles, 'file')} that changed on production</span>
                      <span className="text-xs text-muted-foreground">They are here too, and newer on the server. Off, they stay as they are here. On, the ones in the folders you ticked are replaced, and each file here goes to the file trash first: Changes you can undo on Browse puts it back for {FILE_TRASH_DAYS} days.</span>
                    </span>
                  </label>
                  <details className="text-xs">
                    <summary className="cursor-pointer font-medium text-primary">See {compare.changedFiles > UPLOADS_LISTED ? `the first ${UPLOADS_LISTED} of them` : 'them'}</summary>
                    <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto rounded-lg border bg-background px-3 py-2 font-mono text-xs">
                      {compare.changed.map((c) => <li key={c.file} className="flex flex-wrap justify-between gap-x-4 [overflow-wrap:anywhere]"><span>{c.file}</span><span className="text-muted-foreground">{bytes(c.bytes)}, changed <time dateTime={c.changedAt} title={dateTime(c.changedAt)}>{timeAgo(c.changedAt)}</time></span></li>)}
                    </ul>
                  </details>
                </div>
              )}
              {compare.onlyHereFiles > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-primary">{count(compare.onlyHereFiles, 'file')} only here</summary>
                  <p className="mt-2 text-muted-foreground">Uploaded here, or deleted on production since. They stay: the panel never deletes a file here to match the server, and never sends one there.</p>
                  <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto rounded-lg border bg-background px-3 py-2 font-mono text-xs">
                    {compare.onlyHere.map((f) => <li key={f} className="[overflow-wrap:anywhere]">{f}</li>)}
                    {compare.onlyHereFiles > compare.onlyHere.length && <li className="font-sans text-muted-foreground">and {(compare.onlyHereFiles - compare.onlyHere.length).toLocaleString('en')} more</li>}
                  </ul>
                </details>
              )}
            </div>

            <div className="grid gap-2 border-t pt-4">
              {!fits && (
                <Notice tone="warning">This needs {bytes(size + changedBytes)} and the disk has {bytes(compare.freeBytes)} free. The panel keeps 1 GB to spare, so it would refuse: tick fewer folders.</Notice>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button disabled={files + changedFiles === 0 || !fits || !maxOk || running || comparing} onClick={start}>
                  {running ? <Spinner /> : <CloudDownload />}
                  {files + changedFiles === 0 ? 'Nothing to bring' : `Bring ${count(files + changedFiles, 'file')}`}
                </Button>
                {files + changedFiles > 0 && (
                  <span className="text-muted-foreground">
                    {maxMb.trim() && maxOk ? 'At most ' : ''}{bytes(size + changedBytes)} from {production.host}{changedFiles > 0 ? `, ${changedFiles.toLocaleString('en')} of them replacing a file here` : ''}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Files are only added here: one that is here already is left as it is{changed ? ', unless it changed on production' : ''}. Stop keeps what came, and a new run brings the rest.</p>
            </div>
          </CardBody>
          <JobFooter job={copy.job} error={copy.error} onRetry={() => void copy.retry()} onStop={() => void copy.stop()} stopNote="What came so far is kept, and a new run brings the rest." />
        </Card>
      )}
    </div>
  );
}

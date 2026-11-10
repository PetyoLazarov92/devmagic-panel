import { type ActionId, type FileEntry, type FileListing, type FileTrashEntry, type FileView, type Site, FILE_CHANGED, FILE_TRASH_DAYS, FILE_TRASH_MAX, isFileName, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { ArrowDown, ArrowUp, ChevronRight, FileArchive, PackageOpen, Upload, Copy, CopyPlus, Download, File, FileCode, FileImage, FilePlus, FileText, Folder, FolderGit2, FolderInput, FolderOpen, FolderPlus, Link2, LoaderCircle, Lock, Pencil, Save, Search, TextCursorInput, Trash2, X } from 'lucide-react';
import { type DragEvent, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { EditorBoundary } from '@/components/editor-boundary';
import { DeleteDialog, FileTrashCard, FolderPicker, NameDialog } from '@/components/file-dialogs';
import { EmptyState, Notice, ViewBar } from '@/components/page';
import { LogSkeleton, TableSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { Switch } from '@/components/ui/switch';
import { api, fileUrl, isMockup, zipUrl } from '@/lib/api';
import { loadFileEditor } from '@/lib/file-editor-load';
import { filesHref } from '@/lib/file-links';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { lastLine } from '@/lib/output';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

/**
 * A site's files: one folder at a time, or one file in the folder's place.
 * The folder and the file are in the address (?tab=files&dir=... or
 * &file=...&line=42), so Back, a reload and a link from a log all land there.
 * Every change is an action of the registry (file.write, file.delete, ...),
 * and a delete goes to the file trash, where Undo finds it.
 */

const FileEditor = lazy(loadFileEditor);

type SiteId = Pick<Site, 'domain' | 'path'>;

/** Folders that are there but nobody browses: shown only when asked. */
const HIDDEN = new Set(['.git', 'node_modules']);
const CODE = /\.(php|js|jsx|ts|tsx|css|scss|json|html?|twig|xml|ya?ml|sh|sql|inc)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i;

/** The last folder read per site and folder, shown at once when you come back to it. */
const lastLists = new Map<string, { listing: FileListing; at: string }>();

const copyPath = (path: string) =>
  void navigator.clipboard?.writeText(path).then(
    () => toast({ tone: 'success', title: 'Path copied', detail: path }),
    () => toast({ tone: 'danger', title: 'The path could not be copied', detail: path }),
  );

const mockDownload = (e: { preventDefault: () => void }) => {
  if (!isMockup) return;
  e.preventDefault();
  toast({ tone: 'info', title: 'Mockup: this downloads the file' });
};

function download(site: SiteId, file: string) {
  if (isMockup) return toast({ tone: 'info', title: 'Mockup: this downloads the file' });
  const a = document.createElement('a');
  a.href = fileUrl(site.domain, file, site.path);
  a.download = nameOf(file);
  a.click();
}

/** The archives the tab unpacks, by their ending. */
const ARCHIVE = /.\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i;

/** Files and folders of one folder as one zip, made by the server for this download. */
function downloadZip(site: SiteId, files: readonly string[]) {
  if (isMockup) return toast({ tone: 'info', title: 'Mockup: this downloads them as one zip' });
  const a = document.createElement('a');
  a.href = zipUrl(site.domain, files, site.path);
  a.download = '';
  a.click();
}

const siteInput = (site: SiteId) => ({ domain: site.domain, ...(site.path ? { path: site.path } : {}) });

/** Runs one of the Files actions; a refusal comes back as its message. */
async function fileAction(site: SiteId, id: ActionId, input: Record<string, unknown>): Promise<{ ok: true; data?: { hash?: string; trashId?: string } } | { ok: false; error: string }> {
  try {
    const result = await api.runAction(id, { ...siteInput(site), ...input });
    return result.ok ? { ok: true, ...(result.data ? { data: result.data } : {}) } : { ok: false, error: lastLine(result.output) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Why a delete is asked about first, when it is: what breaks, or what goes with it. */
function deleteRisk(dir: string, entries: readonly FileEntry[]): string | undefined {
  for (const e of entries) {
    if (e.note === 'panel') return `${e.name} is one of the two files the panel adds to a site: what it does (the login button, or Local mode) stops for this site without it.`;
    if (e.note === 'repo') return `${e.name} is a git repo: commits and branches that were never pushed go with it.`;
    if (dir === '' && e.name === 'wp-config.php') return "WordPress cannot start without wp-config.php: it holds the database's name and password.";
    if (dir === '' && (e.name === 'index.php' || e.name === '.htaccess')) return `The site's addresses stop working without ${e.name}.`;
    if (dir === '' && e.name === 'wp-content') return "wp-content holds the site's themes, plugins and uploads.";
    if (dir === 'wp-content' && ['themes', 'plugins', 'uploads', 'mu-plugins'].includes(e.name)) return `This is the site's ${e.name} folder, with everything in it.`;
  }
  return undefined;
}

type Asking =
  | { kind: 'new'; what: 'file' | 'dir' }
  | { kind: 'rename'; name: string }
  | { kind: 'move' | 'copy'; paths: string[] }
  | { kind: 'delete'; paths: string[]; why: string };

export function FilesTab({ site }: { site: Site }) {
  const file = useQueryParam('file');
  const dir = useQueryParam('dir') ?? '';
  const line = Number(useQueryParam('line')) || undefined;
  const edit = useQueryParam('edit') === '1';
  return file !== null ? <FileViewer key={file} site={site} file={file} line={line} edit={edit} /> : <FolderView site={site} dir={dir} />;
}

/** Where you are: the site's folder, then each folder down to this one. */
function Breadcrumb({ site, path }: { site: SiteId; path: string }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
      {parts.length === 0 ? (
        <span className="flex items-center gap-1.5 font-medium"><FolderOpen className="size-4 text-muted-foreground" aria-hidden />Site folder</span>
      ) : (
        <Link href={filesHref(site)} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><FolderOpen className="size-4" aria-hidden />Site folder</Link>
      )}
      {parts.map((part, i) => {
        const here = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <Fragment key={here}>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {last ? (
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]" aria-current="page">{part}</span>
            ) : (
              <Link href={filesHref(site, { dir: here })} className="text-muted-foreground [overflow-wrap:anywhere] hover:text-foreground">{part}</Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

type SortKey = 'name' | 'size' | 'changed';
interface Sort {
  key: SortKey;
  down: boolean;
}

const isFolder = (e: FileEntry) => e.kind === 'dir' || (e.kind === 'link' && e.targetKind === 'dir');

/** Folders first always; then by the column picked. */
export function sortEntries(entries: readonly FileEntry[], sort: Sort): FileEntry[] {
  const value = (e: FileEntry) => (sort.key === 'size' ? (e.sizeBytes ?? -1) : sort.key === 'changed' ? Date.parse(e.modifiedAt ?? '') || 0 : 0);
  return [...entries].sort((a, b) => {
    const folders = Number(isFolder(b)) - Number(isFolder(a));
    if (folders) return folders;
    const by = sort.key === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : value(a) - value(b) || a.name.localeCompare(b.name);
    return sort.down ? -by : by;
  });
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  const cls = 'size-4 shrink-0';
  if (entry.kind === 'link') return <Link2 className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  if (entry.kind === 'dir') return entry.note === 'repo' ? <FolderGit2 className={cn(cls, 'text-primary')} aria-hidden /> : <Folder className={cn(cls, 'text-primary')} aria-hidden />;
  if (IMAGE.test(entry.name)) return <FileImage className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  if (CODE.test(entry.name)) return <FileCode className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  return entry.kind === 'file' ? <FileText className={cn(cls, 'text-muted-foreground')} aria-hidden /> : <File className={cn(cls, 'text-muted-foreground')} aria-hidden />;
}

/** What a row says next to its name: only what changes what you can do with it. */
function EntryLabels({ entry, listing }: { entry: FileEntry; listing: FileListing }) {
  const core = entry.kind === 'link' && entry.outside && entry.targetKind === 'dir';
  return (
    <>
      {entry.note === 'repo' && <Badge tone="primary">repo</Badge>}
      {entry.note === 'panel' && <Badge title="One of the two files the panel adds to a site">the panel's file</Badge>}
      {core && <Badge title={`A link to ${entry.target}`}>shared core, read only</Badge>}
      {entry.kind === 'link' && !core && <Badge title={`A link to ${entry.target}`}>{entry.targetKind === 'missing' ? 'link to nothing' : entry.outside ? 'link out of the site' : 'link'}</Badge>}
      {entry.kind !== 'link' && !entry.writable && !listing.readOnly && (
        <Badge tone="warning" title="Another account owns it (often www-data), so you can read it here and not change it"><Lock className="size-3" aria-hidden />read only</Badge>
      )}
    </>
  );
}

function FolderView({ site, dir }: { site: Site; dir: string }) {
  const key = `${site.domain}${site.path ?? ''}|${dir}`;
  const { data, error, loading, reload } = useAsync(async () => {
    const listing = await api.files(site.domain, dir, site.path);
    const read = { listing, at: new Date().toISOString() };
    lastLists.set(key, read);
    return read;
  }, [key]);
  // The folder asked for, never the one before it: a late answer for another folder is not shown.
  const read = data?.listing.dir === dir ? data : lastLists.get(key);
  const listing = read?.listing;

  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'name', down: false });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQuery('');
    setPicked(new Set());
  }, [key]);
  const trash = useAsync(() => api.fileTrash(site.domain, site.path), [site.domain, site.path]);

  const canChange = Boolean(listing?.writable) && !listing?.readOnly;
  // A link out of the site (a shared core's wp-admin) is the site's wiring: nothing here renames or deletes it.
  const changeable = (e: FileEntry) => canChange && !(e.kind === 'link' && e.outside);
  const pathOf = (name: string) => joinPath(dir, name);
  const refresh = () => {
    reload();
    trash.reload();
  };

  /** Runs a change, says how it went, and reads the folder again. */
  const change = async (id: ActionId, input: Record<string, unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    const result = await fileAction(site, id, input);
    setBusy(false);
    if (result.ok) toast({ tone: 'success', title: done });
    else toast({ tone: 'danger', title: 'Nothing changed', detail: result.error });
    refresh();
    return result.ok;
  };
  const restore = async (id: string, what: string) => {
    await change('file.restore', { id }, `${what} is back`);
  };
  const remove = async (paths: string[]) => {
    setBusy(true);
    const result = await fileAction(site, 'file.delete', { files: paths });
    setBusy(false);
    const what = paths.length === 1 ? nameOf(paths[0] ?? '') : `${paths.length} entries`;
    if (result.ok) {
      const id = result.data?.trashId;
      toast({ tone: 'success', title: `Deleted ${what}`, detail: `Kept for ${FILE_TRASH_DAYS} days.`, ...(id ? { action: { label: 'Undo', run: () => void restore(id, what) } } : {}) });
      setPicked(new Set());
    } else {
      toast({ tone: 'danger', title: 'Nothing was deleted', detail: result.error });
    }
    refresh();
  };
  const askDelete = (names: string[]) => {
    const entries = (listing?.entries ?? []).filter((e) => names.includes(e.name));
    const why = deleteRisk(dir, entries);
    const paths = names.map(pathOf);
    if (why) setAsking({ kind: 'delete', paths, why });
    else void remove(paths);
  };
  const compress = (picks: string[]) =>
    void change('file.compress', { files: picks.map(pathOf) }, picks.length === 1 ? `Packed ${picks[0]} into a zip` : `Packed ${picks.length} entries into a zip`).then((made) => made && setPicked(new Set()));

  // Uploads go to the panel one at a time, then one action puts them all in this folder.
  const [sending, setSending] = useState<{ name: string; at: number; of: number; part: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const drags = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = async (list: File[]) => {
    if (!canChange || sending || list.length === 0) return;
    const fits = list.filter((f) => isFileName(f.name) && f.size <= FILE_TRASH_MAX);
    const skipped = list.filter((f) => !fits.includes(f)).map((f) => f.name);
    if (fits.length > 200) return void toast({ tone: 'danger', title: 'That is more than 200 files', detail: 'Pack them into a zip, upload it and choose Extract.' });
    if (fits.length === 0) return void toast({ tone: 'danger', title: 'Nothing was uploaded', detail: `Larger than 1 GB, or a name the tab does not take: ${skipped.join(', ')}` });
    const here = new Set(names);
    const staged: { id: string; name: string }[] = [];
    try {
      for (const [i, file] of fits.entries()) {
        const step = { name: file.name, at: i + 1, of: fits.length };
        setSending({ ...step, part: 0 });
        const { id } = await api.stageFile(file, (part) => setSending({ ...step, part }));
        staged.push({ id, name: file.name });
      }
    } catch (e) {
      setSending(null);
      return void toast({ tone: 'danger', title: 'The upload stopped', detail: `${(e as Error).message}. Nothing was put in the folder.` });
    }
    const result = await fileAction(site, 'file.upload', { dir, uploads: staged });
    setSending(null);
    const taken = staged.filter((u) => here.has(u.name)).map((u) => u.name);
    const placed = staged.length - taken.length;
    const notes = [
      ...(taken.length ? [`Already here and left as ${taken.length === 1 ? 'it is' : 'they are'}: ${taken.join(', ')}.`] : []),
      ...(skipped.length ? [`Left out (over 1 GB, or a name the tab does not take): ${skipped.join(', ')}.`] : []),
    ];
    if (result.ok) toast({ tone: taken.length || skipped.length ? 'info' : 'success', title: placed === 1 ? `Uploaded ${staged.find((u) => !here.has(u.name))?.name ?? '1 file'}` : `Uploaded ${placed} files`, ...(notes.length ? { detail: notes.join(' ') } : {}) });
    else toast({ tone: 'danger', title: 'Nothing was uploaded', detail: result.error });
    refresh();
  };
  const hasFiles = (e: DragEvent) => canChange && Array.from(e.dataTransfer.types).includes('Files');
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drags.current = 0;
    setDropping(false);
    // A dropped folder has no bytes a browser can send as one file.
    const folders = Array.from(e.dataTransfer.items).filter((item) => item.webkitGetAsEntry?.()?.isDirectory).length;
    if (folders > 0) return void toast({ tone: 'info', title: 'Folders are not uploaded as they are', detail: 'Pack the folder into a zip, upload it and choose Extract.' });
    void upload(Array.from(e.dataTransfer.files));
  };

  const duplicate = (name: string) => void change('file.copy', { files: [pathOf(name)], to: dir }, `Copied ${name}`);

  const names = useMemo(() => (listing?.entries ?? []).map((e) => e.name), [listing]);
  const hiddenCount = listing?.entries.filter((e) => HIDDEN.has(e.name)).length ?? 0;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortEntries((listing?.entries ?? []).filter((e) => (hidden || !HIDDEN.has(e.name)) && (!q || e.name.toLowerCase().includes(q))), sort);
  }, [listing, query, hidden, sort]);
  const { shown, footer } = useShowMore(rows, { step: 100, reset: `${key}|${query}|${sort.key}|${sort.down}` });

  // Only what is listed now can be selected: a filter never leaves a hidden row ticked.
  const pickable = useMemo(() => rows.filter((e) => Boolean(listing?.writable) && !listing?.readOnly && !(e.kind === 'link' && e.outside)).map((e) => e.name), [rows, listing]);
  const pickedRows = useMemo(() => pickable.filter((name) => picked.has(name)), [pickable, picked]);
  const toggle = (name: string, on: boolean) =>
    setPicked((was) => {
      const next = new Set(was);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const hrefOf = (e: FileEntry) => {
    const path = joinPath(dir, e.name);
    if (e.kind === 'link' && e.targetKind === 'missing') return undefined;
    // A link out of the site opens only where it leads into a shared core; the server refuses the rest.
    return isFolder(e) ? filesHref(site, { dir: path }) : e.kind === 'other' ? undefined : filesHref(site, { file: path });
  };
  const menuOf = (e: FileEntry): MenuItem[] => {
    const path = joinPath(dir, e.name);
    const href = hrefOf(e);
    const can = changeable(e);
    return [
      ...(href ? [{ label: 'Open', icon: isFolder(e) ? <FolderOpen /> : <FileText />, onSelect: () => navigate(href, { scroll: false }) }] : []),
      ...(e.kind === 'file' && e.writable && can ? [{ label: 'Edit', icon: <Pencil />, onSelect: () => navigate(filesHref(site, { file: path, edit: true }), { scroll: false }) }] : []),
      ...(e.kind === 'file' ? [{ label: 'Download', icon: <Download />, onSelect: () => download(site, path) }] : []),
      ...(e.kind === 'dir' ? [{ label: 'Download as zip', icon: <Download />, onSelect: () => downloadZip(site, [path]) }] : []),
      ...(e.kind === 'file' && ARCHIVE.test(e.name) && canChange ? [{ label: 'Extract', icon: <PackageOpen />, onSelect: () => void change('file.extract', { file: path }, `Unpacked ${e.name} into a new folder`) }] : []),
      { label: 'Copy path', icon: <Copy />, onSelect: () => copyPath(`${listing?.root ?? site.docroot}/${path}`) },
      ...(can
        ? [
            { label: 'Rename', icon: <TextCursorInput />, onSelect: () => setAsking({ kind: 'rename', name: e.name }) },
            { label: 'Duplicate', icon: <CopyPlus />, onSelect: () => duplicate(e.name) },
            { label: 'Move to', icon: <FolderInput />, onSelect: () => setAsking({ kind: 'move', paths: [path] }) },
            { label: 'Copy to', icon: <Copy />, onSelect: () => setAsking({ kind: 'copy', paths: [path] }) },
            ...(ARCHIVE.test(e.name) ? [] : [{ label: 'Compress', icon: <FileArchive />, onSelect: () => compress([e.name]) }]),
            { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => askDelete([e.name]) },
          ]
        : []),
    ];
  };
  const header = (label: string, k: SortKey, className?: string) => (
    <th scope="col" aria-sort={sort.key === k ? (sort.down ? 'descending' : 'ascending') : 'none'} className={cn('px-3 py-2.5 font-medium', className)}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key: k, down: s.key === k ? !s.down : k !== 'name' }))}>
        {label}
        {sort.key === k && (sort.down ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div
      className={cn('relative grid gap-4 rounded-xl', dropping && 'outline-2 outline-offset-4 outline-primary outline-dashed')}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        drags.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        drags.current = Math.max(0, drags.current - 1);
        if (drags.current === 0) setDropping(false);
      }}
      onDrop={drop}
    >
      <ViewBar
        onCheck={reload}
        loading={loading}
        checkedAt={read?.at}
        actions={
          hiddenCount > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={hidden} onChange={setHidden} label="Show .git and node_modules" />
              Show hidden ({hiddenCount})
            </label>
          )
        }
      >
        <Breadcrumb site={site} path={dir} />
      </ViewBar>

      {listing && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter this folder" aria-label="Filter this folder by name" className="h-8 pl-8 text-xs" />
          </div>
          <ul className="flex flex-wrap gap-1.5" aria-label="Places of this site">
            {listing.shortcuts.map((s) => {
              const here = s.kind === 'dir' && s.path === dir;
              return (
                <li key={s.path}>
                  <Link
                    href={filesHref(site, s.kind === 'dir' ? { dir: s.path } : { file: s.path })}
                    aria-current={here ? 'page' : undefined}
                    className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground', here && 'border-primary bg-primary/10 text-foreground')}
                  >
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          {canChange && (
            <div className="ml-auto flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label={`Files to upload into ${dir || 'the site folder'}`}
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void upload(list);
                }}
              />
              <Button size="sm" variant="outline" disabled={sending !== null} title="Or drop files on the list" onClick={() => fileInput.current?.click()}><Upload />Upload</Button>
              <Button size="sm" variant="outline" onClick={() => setAsking({ kind: 'new', what: 'file' })}><FilePlus />New file</Button>
              <Button size="sm" variant="outline" onClick={() => setAsking({ kind: 'new', what: 'dir' })}><FolderPlus />New folder</Button>
            </div>
          )}
        </div>
      )}

      {error && (!listing || !loading) && <Notice action={dir ? <ButtonLink size="sm" variant="outline" href={filesHref(site, { dir: parentOf(dir) })} onClick={(e) => (e.preventDefault(), navigate(filesHref(site, { dir: parentOf(dir) }), { scroll: false }))}>Go up</ButtonLink> : undefined}>{error}</Notice>}
      {listing?.readOnly && <Notice tone="info">{listing.readOnly}</Notice>}
      {listing && listing.more > 0 && <Notice tone="info">This folder is very long: the first {listing.entries.length.toLocaleString('en-US')} entries are listed, {listing.more.toLocaleString('en-US')} more are not.</Notice>}

      {dropping && <p role="status" className="rounded-lg border border-dashed border-primary bg-primary/5 px-4 py-3 text-center text-sm font-medium">Drop to upload into {dir || 'the site folder'}. A name that is already here is left as it is.</p>}
      {sending && (
        <div role="status" className="grid gap-1.5 rounded-lg border bg-card px-4 py-3 text-sm">
          <p className="flex flex-wrap justify-between gap-x-4"><span className="min-w-0 [overflow-wrap:anywhere]">Uploading <span className="font-medium">{sending.name}</span></span><span className="text-xs text-muted-foreground tabular-nums">{sending.of > 1 ? `${sending.at} of ${sending.of}, ` : ''}{Math.round(sending.part * 100)}%</span></p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(((sending.at - 1 + sending.part) / sending.of) * 100)}%` }} /></div>
        </div>
      )}
      {!listing && loading && <TableSkeleton columns={4} rows={8} />}
      {listing && rows.length === 0 && (
        <EmptyState icon={query ? Search : Folder} title={query ? 'Nothing here by that name' : listing.entries.length > 0 ? 'Only hidden folders here' : 'This folder is empty'}>
          {query ? 'The filter looks at the names in this folder only.' : listing.entries.length > 0 ? 'Switch on Show hidden to see .git and node_modules.' : undefined}
        </EmptyState>
      )}
      {pickedRows.length > 0 && (
        <div role="region" aria-label="Selected entries" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-card px-4 py-2 text-sm shadow-md">
          <p className="mr-auto font-medium">{pickedRows.length} selected</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking({ kind: 'move', paths: pickedRows.map(pathOf) })}><FolderInput />Move to</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking({ kind: 'copy', paths: pickedRows.map(pathOf) })}><Copy />Copy to</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => downloadZip(site, pickedRows.map(pathOf))}><Download />Download</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => compress(pickedRows)}><FileArchive />Compress</Button>
          <Button size="sm" variant="outline" disabled={busy} className="text-danger" onClick={() => askDelete(pickedRows)}><Trash2 />Delete</Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Clear the selection" onClick={() => setPicked(new Set())}><X /></Button>
        </div>
      )}
      {listing && rows.length > 0 && (
        <div className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', loading && 'opacity-70')}>
          <table className="w-full table-fixed text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {canChange && (
                  <th scope="col" className="w-9 py-2.5 pl-4">
                    <input
                      type="checkbox"
                      aria-label="Select everything listed"
                      className="size-4 align-middle accent-[var(--primary)]"
                      checked={pickable.length > 0 && pickedRows.length === pickable.length}
                      ref={(el) => {
                        if (el) el.indeterminate = pickedRows.length > 0 && pickedRows.length < pickable.length;
                      }}
                      onChange={(e) => setPicked(new Set(e.target.checked ? pickable : []))}
                    />
                  </th>
                )}
                {header('Name', 'name', canChange ? 'pl-2' : 'pl-4')}
                {header('Size', 'size', 'w-20 text-right sm:w-24 [&>button]:flex-row-reverse')}
                {header('Changed', 'changed', 'hidden w-32 sm:table-cell')}
                <th scope="col" className="hidden w-24 px-3 py-2.5 font-medium md:table-cell">Permissions</th>
                <th scope="col" className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {dir !== '' && !query && (
                <tr className="hover:bg-muted/40">
                  <td colSpan={canChange ? 6 : 5} className="px-4 py-2">
                    <Link href={filesHref(site, { dir: parentOf(dir) })} className="flex items-center gap-2.5 text-muted-foreground hover:text-foreground">
                      <Folder className="size-4 shrink-0" aria-hidden />
                      <span aria-hidden>..</span>
                      <span className="sr-only">Up to {parentOf(dir) || 'the site folder'}</span>
                    </Link>
                  </td>
                </tr>
              )}
              {shown.map((e) => {
                const href = hrefOf(e);
                return (
                  <tr key={e.name} className={cn('hover:bg-muted/40', picked.has(e.name) && 'bg-primary/5')}>
                    {canChange && (
                      <td className="py-2 pl-4">
                        {changeable(e) ? (
                          <input type="checkbox" aria-label={`Select ${e.name}`} className="size-4 align-middle accent-[var(--primary)]" checked={picked.has(e.name)} onChange={(ev) => toggle(e.name, ev.target.checked)} />
                        ) : (
                          // A row that cannot change keeps its box, so the names line up; it is off and says why.
                          <input type="checkbox" disabled checked={false} readOnly aria-label={`${e.name} cannot be selected`} title="Read only: it cannot be moved, copied or deleted here" className="size-4 cursor-not-allowed align-middle opacity-40" />
                        )}
                      </td>
                    )}
                    <td className={cn('py-2 pr-3', canChange ? 'pl-2' : 'pl-4')}>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <EntryIcon entry={e} />
                        {href ? (
                          <Link href={href} className="min-w-0 font-medium [overflow-wrap:anywhere] hover:text-primary hover:underline">{e.name}</Link>
                        ) : (
                          <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{e.name}</span>
                        )}
                        <EntryLabels entry={e} listing={listing} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{e.sizeBytes === undefined ? '' : bytes(e.sizeBytes)}</td>
                    <td className="hidden px-3 py-2 text-xs whitespace-nowrap text-muted-foreground sm:table-cell">
                      {e.modifiedAt && <time dateTime={e.modifiedAt} title={dateTime(e.modifiedAt)}>{timeAgo(e.modifiedAt)}</time>}
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-xs text-muted-foreground md:table-cell">{e.kind === 'link' ? '' : e.mode}</td>
                    <td className="px-2 py-1 text-right"><Menu items={menuOf(e)} label={`Actions for ${e.name}`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ShowMore {...footer} noun={query ? 'matches' : 'entries'} />
        </div>
      )}

      <FileTrashCard entries={trash.data ?? []} onRestore={(entry: FileTrashEntry) => restore(entry.id, entry.items.length === 1 ? nameOf(entry.items[0] ?? '') : `${entry.items.length} entries`)} />

      <NameDialog
        open={asking?.kind === 'new'}
        title={asking?.kind === 'new' && asking.what === 'dir' ? 'New folder' : 'New file'}
        description={`In ${dir || 'the site folder'}`}
        label="Name"
        initial=""
        action="Create"
        taken={names}
        onClose={() => setAsking(null)}
        onSubmit={async (name) => {
          const what = asking?.kind === 'new' ? asking.what : 'file';
          const made = await change('file.create', { dir, name, kind: what }, `Made ${name}`);
          // A new file opens in the editor, since writing it is what comes next.
          if (made && what === 'file') navigate(filesHref(site, { file: pathOf(name), edit: true }), { scroll: false });
          return made;
        }}
      />
      <NameDialog
        open={asking?.kind === 'rename'}
        title="Rename"
        label="New name"
        initial={asking?.kind === 'rename' ? asking.name : ''}
        action="Rename"
        taken={names}
        onClose={() => setAsking(null)}
        onSubmit={(name) => change('file.rename', { file: pathOf(asking?.kind === 'rename' ? asking.name : ''), name }, `Renamed to ${name}`)}
      />
      <FolderPicker
        site={site}
        open={asking?.kind === 'move' || asking?.kind === 'copy'}
        title={asking?.kind === 'copy' ? 'Copy to' : 'Move to'}
        verb={asking?.kind === 'copy' ? 'Copy here' : 'Move here'}
        start={dir}
        moving={asking?.kind === 'move' || asking?.kind === 'copy' ? asking.paths : []}
        sameFolder={asking?.kind === 'copy'}
        onClose={() => setAsking(null)}
        onPick={async (to) => {
          if (asking?.kind !== 'move' && asking?.kind !== 'copy') return false;
          const what = asking.paths.length === 1 ? nameOf(asking.paths[0] ?? '') : `${asking.paths.length} entries`;
          const done = await change(asking.kind === 'copy' ? 'file.copy' : 'file.move', { files: asking.paths, to }, `${asking.kind === 'copy' ? 'Copied' : 'Moved'} ${what} to ${to || 'the site folder'}`);
          if (done) setPicked(new Set());
          return done;
        }}
      />
      <DeleteDialog
        open={asking?.kind === 'delete'}
        items={asking?.kind === 'delete' ? asking.paths : []}
        why={asking?.kind === 'delete' ? asking.why : ''}
        onClose={() => setAsking(null)}
        onDelete={() => remove(asking?.kind === 'delete' ? asking.paths : [])}
      />
    </div>
  );
}

function FileViewer({ site, file, line, edit }: { site: Site; file: string; line: number | undefined; edit: boolean }) {
  const { data, error, loading, reload } = useAsync(async () => ({ view: await api.fileView(site.domain, file, site.path), at: new Date().toISOString() }), [site.domain, site.path, file]);
  const view = data?.view.path === file ? data.view : undefined;
  const full = `${site.docroot}/${file}`;
  const up = filesHref(site, { dir: parentOf(file) });
  const canEdit = view?.kind === 'text' && view.writable && !view.readOnly;
  const editing = edit && canEdit;

  // What is on disk as the editor knows it, and what is typed. A read of the file replaces both only while nothing is typed.
  const [base, setBase] = useState<{ text: string; hash: string | undefined } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ changed: boolean; text: string } | null>(null);
  const dirty = base !== null && draft !== base.text;
  const dirtyNow = useRef(false);
  dirtyNow.current = dirty;
  useEffect(() => {
    if (view?.kind !== 'text' || dirtyNow.current) return;
    setBase({ text: view.text ?? '', hash: view.hash });
    setDraft(view.text ?? '');
    setProblem(null);
  }, [view]);
  // Typed text is not lost to a reload or a closed tab without a word.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (force = false) => {
    if (!base || saving || !dirtyNow.current) return;
    const content = draft;
    setSaving(true);
    setProblem(null);
    const result = await fileAction(site, 'file.write', { file, content, ...(base.hash ? { hash: base.hash } : {}), ...(view?.eol ? { eol: view.eol } : {}), ...(force ? { force: true } : {}) });
    setSaving(false);
    if (result.ok) {
      setBase({ text: content, hash: result.data?.hash });
      toast({ tone: 'success', title: `Saved ${nameOf(file)}`, key: 'file-save' });
      // The file is read again, so its size and date follow, and the view outside the editor shows what was saved.
      reload();
    } else {
      setProblem({ changed: result.error.includes(FILE_CHANGED), text: result.error });
    }
  };
  // Cancel drops what is typed and leaves the editor; with something typed it asks once, on the button itself.
  const [sure, setSure] = useState(false);
  useEffect(() => setSure(false), [draft]);
  const cancel = () => {
    if (dirty && !sure) return setSure(true);
    if (base) setDraft(base.text);
    setProblem(null);
    setSure(false);
    setEdit(false);
  };
  /** Takes the file as it is on disk now, dropping what is typed. */
  const takeDisk = () => {
    dirtyNow.current = false;
    setBase(null);
    setProblem(null);
    reload();
  };
  const setEdit = (on: boolean) => navigate(filesHref(site, { file, ...(on ? { edit: true } : {}), ...(line ? { line } : {}) }), { replace: true });
  const plain = <TextView text={draft} line={line} name={nameOf(file)} />;

  return (
    <div className="grid gap-4">
      <ViewBar
        {...(editing ? {} : { onCheck: reload })}
        loading={loading}
        checkedAt={view ? data?.at : undefined}
        actions={
          <>
            {canEdit && !editing && <Button size="sm" onClick={() => setEdit(true)}><Pencil />Edit</Button>}
            {editing && (
              <>
                <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}Save</Button>
                <Button size="sm" variant="outline" disabled={saving} onClick={cancel}>{dirty ? (sure ? 'Drop what you typed?' : 'Cancel') : 'Close'}</Button>
              </>
            )}
            <ButtonLink size="sm" variant="outline" href={fileUrl(site.domain, file, site.path)} download={nameOf(file)} onClick={mockDownload}><Download />Download</ButtonLink>
            <Menu items={[{ label: 'Copy path', icon: <Copy />, onSelect: () => copyPath(full) }]} label={`More for ${nameOf(file)}`} />
          </>
        }
        note={view && <FileFacts view={view} />}
      >
        <Breadcrumb site={site} path={file} />
      </ViewBar>

      {error && !loading && <Notice action={<ButtonLink size="sm" variant="outline" href={up} onClick={(e) => (e.preventDefault(), navigate(up, { scroll: false }))}>Open its folder</ButtonLink>}>{error}</Notice>}
      {view?.readOnly && <Notice tone="info">{view.readOnly}</Notice>}
      {view?.note === 'panel' && <Notice tone="info">This is one of the two files the panel adds to a site. The panel writes it again when it changes, so edits here do not last.</Notice>}
      {view && !view.writable && !view.readOnly && <Notice tone="info">Another account owns this file (often www-data), so you can read it here and not change it.</Notice>}
      {editing && file === 'wp-config.php' && <Notice tone="warning">WordPress reads this file on every request: a mistake here takes the site down until it is fixed.</Notice>}
      {problem && !problem.changed && <Notice>{problem.text}</Notice>}
      {problem?.changed && (
        <Notice
          tone="warning"
          action={
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={saving} onClick={takeDisk}>Reload from disk</Button>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(true)}>Save anyway</Button>
            </span>
          }
        >
          This file changed on disk since you opened it, by an editor, git or WordPress. Reload from disk drops what you typed here; Save anyway replaces what is on disk.
        </Notice>
      )}

      {!view && loading && <LogSkeleton lines={14} />}
      {view?.kind === 'text' && !editing && <TextView text={base?.text ?? view.text ?? ''} line={line} name={nameOf(file)} />}
      {view?.kind === 'text' && editing && base && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs focus-within:border-primary/60">
          <EditorBoundary fallback={plain}>
            <Suspense fallback={plain}>
              <FileEditor value={draft} onChange={setDraft} onSave={() => void save()} name={nameOf(file)} label={`${nameOf(file)}, editing`} line={line} />
            </Suspense>
          </EditorBoundary>
        </div>
      )}
      {editing && (
        <p className="text-xs text-muted-foreground" role="status">
          {dirty ? 'Not saved yet. ' : ''}Nothing is written to the file until you press Save, or Ctrl+S. Cancel leaves it as it is on disk. Ctrl+F finds in the file.
        </p>
      )}
      {view?.kind === 'image' && (
        <div className="grid place-items-center overflow-hidden rounded-xl border bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-4">
          <img src={fileUrl(site.domain, file, site.path, true)} alt={nameOf(file)} className="max-h-[70vh] max-w-full rounded shadow-sm" />
        </div>
      )}
      {(view?.kind === 'binary' || view?.kind === 'large') && (
        <EmptyState
          icon={File}
          title={view.kind === 'large' ? 'Too large to open here' : 'Not a text file'}
          action={<ButtonLink size="sm" href={fileUrl(site.domain, file, site.path)} download={nameOf(file)} onClick={mockDownload}><Download />Download</ButtonLink>}
        >
          {view.kind === 'large' ? `Text opens here up to 2 MB, and this file is ${bytes(view.sizeBytes)}. Download it to read it.` : 'Text and images (png, jpg, gif, webp) open here. Download this one to open it with its own program.'}
        </EmptyState>
      )}
    </div>
  );
}

function FileFacts({ view }: { view: FileView }) {
  return (
    <>
      {bytes(view.sizeBytes)}, changed <time dateTime={view.modifiedAt} title={dateTime(view.modifiedAt)}>{timeAgo(view.modifiedAt)}</time>, permissions <span className="font-mono">{view.mode}</span>
      {view.eol === 'crlf' ? ', Windows line ends' : ''}.
    </>
  );
}

/** A file's text with line numbers, the line asked for marked and in view. */
function TextView({ text, line, name }: { text: string; line: number | undefined; name: string }) {
  const lines = useMemo(() => {
    const all = text.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    return all;
  }, [text]);
  const marked = useRef<HTMLDivElement>(null);
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' });
  }, [line, text]);
  const width = `${String(lines.length).length + 1}ch`;
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div role="region" aria-label={`${name}, read only`} tabIndex={0} className="max-h-[70vh] overflow-auto py-2 font-mono text-xs leading-5">
        <div className="w-max min-w-full">
          {lines.map((l, i) => {
            const here = line === i + 1;
            return (
              <div key={i} ref={here ? marked : undefined} className={cn('flex', here && 'bg-warning/15')}>
                <span aria-hidden style={{ width }} className={cn('sticky left-0 shrink-0 border-r bg-card pr-2 pl-3 text-right text-muted-foreground select-none box-content', here && 'bg-warning/25 font-semibold text-foreground')}>{i + 1}</span>
                <span className="pr-4 pl-3 whitespace-pre">{l || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

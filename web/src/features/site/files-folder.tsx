import { type ActionId, type FileEntry, type FileGitState, type FileGitStatus, type FileListing, type FileTrashEntry, type Site, FILE_TRASH_DAYS, FILE_TRASH_MAX, isFileName, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { ArrowDown, ArrowUp, CloudDownload, FileArchive, PackageOpen, Upload, Copy, CopyPlus, Download, File, FileCode, FileImage, FilePlus, FileText, Folder, FolderGit2, FolderInput, FolderOpen, FolderPlus, GitBranch, KeyRound, Link2, Lock, Pencil, Search, TextCursorInput, Trash2, X } from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlaces } from '@/features/site/file-places';
import { DeleteDialog, FileTrashCard, FolderPicker, NameDialog, PermissionsDialog } from '@/features/site/file-dialogs';
import { EmptyState, Notice, ViewBar } from '@/components/layout/page';
import { TableSkeleton } from '@/components/layout/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextLink } from '@/components/ui/text-link';
import { api, isMockup, zipUrl } from '@/lib/api';
import { filesHref, uploadsHref } from '@/lib/file-links';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { Link, navigate } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Breadcrumb, CODE, type Find, GIT_LABEL, IMAGE, type SiteId, type Sort, type SortKey, copyPath, download, fileAction, isFolder } from './files-shared';
import { FindResults } from './files-find';

/** Folders that are there but nobody browses: shown only when asked. */
export const HIDDEN = new Set(['.git', 'node_modules']);

/** The last folder read per site and folder, shown at once when you come back to it. */
export const lastLists = new Map<string, { listing: FileListing; at: string }>();

/** The archives the tab unpacks, by their ending. */
export const ARCHIVE = /.\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i;

/** Files and folders of one folder as one zip, made by the server for this download. */
export function downloadZip(site: SiteId, files: readonly string[]) {
  if (isMockup) return toast({ tone: 'info', title: 'Mockup: this downloads them as one zip' });
  const a = document.createElement('a');
  a.href = zipUrl(site.domain, files, site.path);
  a.download = '';
  a.click();
}

/** Why a delete is asked about first, when it is: what breaks, or what goes with it. */
export function deleteRisk(dir: string, entries: readonly FileEntry[]): string | undefined {
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

export type Asking =
  | { kind: 'new'; what: 'file' | 'dir' }
  | { kind: 'rename'; name: string }
  | { kind: 'move' | 'copy'; paths: string[] }
  | { kind: 'chmod'; paths: string[]; folder: boolean; mode?: string }
  | { kind: 'delete'; paths: string[]; why: string };

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

export function EntryIcon({ entry }: { entry: FileEntry }) {
  const cls = 'size-4 shrink-0';
  if (entry.kind === 'link') return <Link2 className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  if (entry.kind === 'dir') return entry.note === 'repo' ? <FolderGit2 className={cn(cls, 'text-primary')} aria-hidden /> : <Folder className={cn(cls, 'text-primary')} aria-hidden />;
  if (IMAGE.test(entry.name)) return <FileImage className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  if (CODE.test(entry.name)) return <FileCode className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  return entry.kind === 'file' ? <FileText className={cn(cls, 'text-muted-foreground')} aria-hidden /> : <File className={cn(cls, 'text-muted-foreground')} aria-hidden />;
}

/** What a row says next to its name: only what changes what you can do with it. */
export function EntryLabels({ entry, listing }: { entry: FileEntry; listing: FileListing }) {
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

export function GitLabel({ state, folder }: { state: FileGitState | undefined; folder: boolean }) {
  if (!state) return null;
  const label = GIT_LABEL[state];
  // A folder that is not new as a whole only says something in it changed.
  if (folder && state !== 'new') return <Badge tone="warning" title="Something in this folder changed since the last commit">changes inside</Badge>;
  return <Badge tone={label.tone} title={label.title}>{label.text}</Badge>;
}

export function FolderView({ site, dir, find }: { site: Site; dir: string; find: Find | null }) {
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

  const [query, setQuery] = useState(find?.q ?? '');
  // The box filters the names of this folder as you type, or looks further down when you press Enter.
  const [mode, setMode] = useState<'filter' | 'name' | 'text'>(find?.where ?? 'filter');
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'name', down: false });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  // What each folder holds, measured when asked: counting everything below can take a while.
  const [sizes, setSizes] = useState<Readonly<Record<string, number | 'busy'>>>({});
  const box = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  useEffect(() => {
    setSizes({});
    // Another folder starts with an empty box; the first one keeps the search its address has.
    if (!first.current) {
      setQuery('');
      setMode('filter');
    }
    first.current = false;
    setPicked(new Set());
  }, [key]);
  const filter = mode === 'filter' && !find ? query : '';
  const look = () => {
    const q = query.trim();
    if (mode === 'filter') return;
    if (q.length < 2) return void toast({ tone: 'info', title: 'Type at least 2 characters to look for' });
    navigate(filesHref(site, { dir, find: { q, where: mode } }), { scroll: false });
  };
  // What git says about this folder: nothing outside a repo, and nothing when git is not there.
  const git = useAsync(async () => ({ key, status: await api.fileGit(site.domain, dir, site.path).catch((): FileGitStatus => ({ entries: {} })) }), [key]);
  const gitStatus = git.data?.key === key ? git.data.status : undefined;
  const gitChanges = Object.keys(gitStatus?.entries ?? {}).length;
  const trash = useAsync(() => api.fileTrash(site.domain, site.path), [site.domain, site.path]);

  const canChange = Boolean(listing?.writable) && !listing?.readOnly;
  // A link out of the site (a shared core's wp-admin) is the site's wiring: nothing here renames or deletes it.
  const changeable = (e: FileEntry) => canChange && !(e.kind === 'link' && e.outside);
  const pathOf = (name: string) => joinPath(dir, name);
  const refresh = () => {
    setSizes({});
    reload();
    trash.reload();
    git.reload();
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

  const measure = (name: string) => {
    setSizes((was) => ({ ...was, [name]: 'busy' }));
    const drop = () => setSizes(({ [name]: _gone, ...rest }) => rest);
    api.fileSize(site.domain, pathOf(name), site.path).then(
      // An answer for a folder left in the meantime finds no 'busy' to replace.
      (size) => setSizes((was) => (was[name] === 'busy' ? { ...was, [name]: size.bytes } : was)),
      (e: Error) => {
        drop();
        toast({ tone: 'danger', title: `${name} was not measured`, detail: e.message });
      },
    );
  };
  // A slash goes to the box from anywhere on the tab, as in a code host's file list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (!box.current) return;
      e.preventDefault();
      box.current.focus();
      box.current.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const duplicate = (name: string) => void change('file.copy', { files: [pathOf(name)], to: dir }, `Copied ${name}`);

  const names = useMemo(() => (listing?.entries ?? []).map((e) => e.name), [listing]);
  const hiddenCount = listing?.entries.filter((e) => HIDDEN.has(e.name)).length ?? 0;
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return sortEntries((listing?.entries ?? []).filter((e) => (hidden || !HIDDEN.has(e.name)) && (!q || e.name.toLowerCase().includes(q))), sort);
  }, [listing, filter, hidden, sort]);
  const { shown, footer } = useShowMore(rows, { step: 100, reset: `${key}|${filter}|${sort.key}|${sort.down}` });

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
            ...(e.kind === 'file' || e.kind === 'dir' ? [{ label: 'Permissions', icon: <KeyRound />, onSelect: () => setAsking({ kind: 'chmod', paths: [path], folder: e.kind === 'dir', ...(e.mode ? { mode: e.mode } : {}) }) }] : []),
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
      {listing && <FilePlaces site={site} places={listing.shortcuts} dir={dir} />}
      <ViewBar
        onCheck={refresh}
        loading={loading}
        checkedAt={read?.at}
        note={
          gitStatus?.repo !== undefined && (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" aria-hidden />
              Repo {nameOf(gitStatus.repo) || 'of the site folder'}{gitStatus.branch ? `, on ${gitStatus.branch}` : ''}: {gitChanges === 0 ? 'nothing changed here since the last commit.' : `${gitChanges} changed here since the last commit.`}
            </span>
          )
        }
        actions={
          <>
            {hiddenCount > 0 && !find && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={hidden} onChange={setHidden} label="Show .git and node_modules" />
                Show hidden ({hiddenCount})
              </label>
            )}
            {canChange && (
              <>
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
              </>
            )}
          </>
        }
      >
        <Breadcrumb site={site} path={dir} />
      </ViewBar>

      {site.core.kind !== 'none' && (dir === 'wp-content/uploads' || dir.startsWith('wp-content/uploads/')) && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          <CloudDownload className="size-4 shrink-0" aria-hidden />
          Missing files that production has?
          <TextLink href={uploadsHref(site)}>Copy from the server</TextLink>
        </p>
      )}

      {listing && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <form
            className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              look();
            }}
          >
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={box}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-keyshortcuts="/"
                title="Press / to come here, Escape to clear"
                onKeyDown={(e) => {
                  if (e.key !== 'Escape' || (!query && !find)) return;
                  // Escape empties the box and leaves the results, back to the folder as it is listed.
                  e.preventDefault();
                  setQuery('');
                  if (find) navigate(filesHref(site, { dir }), { scroll: false });
                }}
                placeholder={mode === 'filter' ? 'Filter this folder' : mode === 'name' ? 'A name, then Enter' : 'Text in files, then Enter'}
                aria-label={mode === 'filter' ? 'Filter this folder by name' : mode === 'name' ? 'Find files and folders by name, here and in the folders below' : 'Find text in the files here and in the folders below'}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Segmented
              label="What the box looks at"
              className="text-xs"
              value={mode}
              onChange={(v) => {
                setMode(v);
                // Back to the filter leaves the results; the folder is listed again.
                if (v === 'filter' && find) navigate(filesHref(site, { dir }), { scroll: false });
              }}
              options={[['filter', 'This folder'], ['name', 'Names below'], ['text', 'Text in files']]}
            />
            {mode !== 'filter' && <Button type="submit" size="sm" variant="outline">Find</Button>}
          </form>
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
      {find && listing && <FindResults site={site} dir={dir} find={find} />}
      {!find && listing && rows.length === 0 && (
        <EmptyState icon={filter ? Search : Folder} title={filter ? 'Nothing here by that name' : listing.entries.length > 0 ? 'Only hidden folders here' : 'This folder is empty'}>
          {filter ? 'The filter looks at the names in this folder only. Names below looks in the folders under it too.' : listing.entries.length > 0 ? 'Switch on Show hidden to see .git and node_modules.' : undefined}
        </EmptyState>
      )}
      {!find && pickedRows.length > 0 && (
        <Card role="region" aria-label="Selected entries" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 border-primary/40 px-4 py-2 text-sm shadow-md">
          <p className="mr-auto font-medium">{pickedRows.length} selected</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking({ kind: 'move', paths: pickedRows.map(pathOf) })}><FolderInput />Move to</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking({ kind: 'copy', paths: pickedRows.map(pathOf) })}><Copy />Copy to</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => downloadZip(site, pickedRows.map(pathOf))}><Download />Download</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => compress(pickedRows)}><FileArchive />Compress</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking({ kind: 'chmod', paths: pickedRows.map(pathOf), folder: (listing?.entries ?? []).some((e) => e.kind === 'dir' && pickedRows.includes(e.name)) })}><KeyRound />Permissions</Button>
          <Button size="sm" variant="outline" disabled={busy} className="text-danger" onClick={() => askDelete(pickedRows)}><Trash2 />Delete</Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Clear the selection" onClick={() => setPicked(new Set())}><X /></Button>
        </Card>
      )}
      {!find && listing && rows.length > 0 && (
        <Card className={cn('overflow-hidden', loading && 'opacity-70')}>
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
              {dir !== '' && !filter && (
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
                          <TextLink href={href} tone="plain" className="inline min-w-0 font-medium [overflow-wrap:anywhere]">{e.name}</TextLink>
                        ) : (
                          <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{e.name}</span>
                        )}
                        <EntryLabels entry={e} listing={listing} />
                        <GitLabel state={gitStatus?.entries[e.name]} folder={isFolder(e)} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {e.sizeBytes !== undefined ? (
                        bytes(e.sizeBytes)
                      ) : e.kind !== 'dir' ? (
                        ''
                      ) : sizes[e.name] === 'busy' ? (
                        <Spinner className="ml-auto size-3.5" label={`Measuring ${e.name}`} />
                      ) : sizes[e.name] !== undefined ? (
                        <span title="Everything below it counted">{bytes(sizes[e.name] as number)}</span>
                      ) : (
                        <button type="button" className="rounded hover:text-foreground hover:underline" aria-label={`Measure ${e.name}`} title="Count what this folder holds" onClick={() => measure(e.name)}>Measure</button>
                      )}
                    </td>
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
          <ShowMore {...footer} noun={filter ? 'matches' : 'entries'} />
        </Card>
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
      <PermissionsDialog
        open={asking?.kind === 'chmod'}
        items={asking?.kind === 'chmod' ? asking.paths : []}
        folder={asking?.kind === 'chmod' && asking.folder}
        current={asking?.kind === 'chmod' ? asking.mode : undefined}
        onClose={() => setAsking(null)}
        onSubmit={async (mode) => {
          if (asking?.kind !== 'chmod') return false;
          const what = asking.paths.length === 1 ? nameOf(asking.paths[0] ?? '') : `${asking.paths.length} entries`;
          const done = await change('file.chmod', { files: asking.paths, mode }, `${what} set to ${mode}`);
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

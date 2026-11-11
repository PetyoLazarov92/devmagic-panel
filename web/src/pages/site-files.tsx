import { Tabs } from '@/components/ui/tabs';
import { type ActionId, type FileDiff, type FileEntry, type FileGitState, type FileGitStatus, type FileListing, type FileMatch, type FileTrashEntry, type FileView, type Site, FILE_CHANGED, FILE_TRASH_DAYS, FILE_TRASH_MAX, isFileName, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { ArrowDown, ArrowUp, ChevronRight, CloudDownload, FileArchive, PackageOpen, Upload, Copy, CopyPlus, Download, File, FileCode, FileImage, FilePlus, FileText, Folder, FolderGit2, FolderInput, FolderOpen, FolderPlus, GitBranch, GitCompare, KeyRound, Link2, Lock, Pencil, Save, Search, TextCursorInput, Trash2, X } from 'lucide-react';
import { type DragEvent, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from '@/components/diff-view';
import { FilePlaces } from '@/components/file-places';
import { EditorBoundary } from '@/components/editor-boundary';
import { DeleteDialog, FileTrashCard, FolderPicker, NameDialog, PermissionsDialog } from '@/components/file-dialogs';
import { EmptyState, Notice, ViewBar } from '@/components/page';
import { LogSkeleton, TableSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextLink } from '@/components/ui/text-link';
import { UploadsFromProduction } from '@/components/uploads-from-production';
import { api, fileUrl, isMockup, zipUrl } from '@/lib/api';
import { loadFileEditor } from '@/lib/file-editor-load';
import { filesHref, uploadsHref } from '@/lib/file-links';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { lastLine } from '@/lib/output';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

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
async function fileAction(site: SiteId, id: ActionId, input: Record<string, unknown>): Promise<{ ok: true; data?: { hash?: string; trashId?: string; warning?: string } } | { ok: false; error: string }> {
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
  | { kind: 'chmod'; paths: string[]; folder: boolean; mode?: string }
  | { kind: 'delete'; paths: string[]; why: string };

export function FilesTab({ site }: { site: Site }) {
  const file = useQueryParam('file');
  const dir = useQueryParam('dir') ?? '';
  const line = Number(useQueryParam('line')) || undefined;
  const edit = useQueryParam('edit') === '1';
  const wordpress = site.core.kind !== 'none';
  const uploads = useQueryParam('view') === 'uploads' && wordpress;
  const q = useQueryParam('find');
  const where = useQueryParam('in') === 'text' ? 'text' : 'name';
  const find = useMemo(() => (q ? { q, where } as const : null), [q, where]);
  if (file !== null) return <FileViewer key={file} site={site} file={file} line={line} edit={edit} />;
  return (
    <div className="grid gap-4">
      {wordpress && (
        <Tabs
          size="sm"
          label="What the Files tab shows"
          value={uploads ? 'uploads' : 'browse'}
          onChange={(v) => navigate(v === 'uploads' ? uploadsHref(site) : filesHref(site, { dir }), { scroll: false })}
          items={[{ value: 'browse', label: 'Browse' }, { value: 'uploads', label: 'Uploads from production' }]}
        />
      )}
      {uploads ? <UploadsFromProduction site={site} /> : <FolderView site={site} dir={dir} find={find} />}
    </div>
  );
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

/** What git says about an entry, in a word. Colour is never the only sign: each has its word. */
const GIT_LABEL: Record<FileGitState, { text: string; tone: 'warning' | 'success' | 'danger' | 'primary'; title: string }> = {
  modified: { text: 'modified', tone: 'warning', title: 'Changed since the last commit' },
  new: { text: 'new', tone: 'success', title: 'Not in git yet' },
  added: { text: 'added', tone: 'success', title: 'New, and staged for the next commit' },
  renamed: { text: 'renamed', tone: 'primary', title: 'Renamed since the last commit' },
  deleted: { text: 'deleted', tone: 'danger', title: 'Deleted since the last commit' },
  conflict: { text: 'conflict', tone: 'danger', title: 'A merge left this file with both sides in it' },
};

function GitLabel({ state, folder }: { state: FileGitState | undefined; folder: boolean }) {
  if (!state) return null;
  const label = GIT_LABEL[state];
  // A folder that is not new as a whole only says something in it changed.
  if (folder && state !== 'new') return <Badge tone="warning" title="Something in this folder changed since the last commit">changes inside</Badge>;
  return <Badge tone={label.tone} title={label.title}>{label.text}</Badge>;
}

type Find = { q: string; where: 'name' | 'text' };

/** A line of a file with each place the text was found marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false });
    parts.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="rounded-xs bg-warning/30 text-foreground">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** What a search under a folder found, in the folder's place: names, or the lines of text files, file by file. */
function FindResults({ site, dir, find }: { site: Site; dir: string; find: Find }) {
  const key = `${site.domain}${site.path ?? ''}|${dir}|${find.where}|${find.q}`;
  const { data, error, loading, reload } = useAsync(async () => ({ key, result: await api.fileFind(site.domain, dir, find.q, find.where, site.path) }), [key]);
  const result = data?.key === key ? data.result : undefined;
  const short = (path: string) => (dir ? path.slice(dir.length + 1) : path);
  const groups = useMemo(() => {
    const byFile = new Map<string, FileMatch[]>();
    for (const m of result?.matches ?? []) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
    return [...byFile];
  }, [result]);
  const place = dir || 'the site folder';
  return (
    <section aria-label="Search results" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-sm" role="status">
          {loading && !result ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground"><Spinner className="size-4" />Looking in {place}</span>
          ) : result ? (
            <>
              <span className="font-medium">{find.where === 'text' ? `${result.matches.length} ${result.matches.length === 1 ? 'line' : 'lines'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}` : `${result.matches.length} ${result.matches.length === 1 ? 'name' : 'names'}`}</span>
              <span className="text-muted-foreground"> with <span className="font-mono text-foreground">{find.q}</span> in {place}{result.more ? ', and more that are not listed: look in a folder further down, or for a longer text' : ''}.</span>
            </>
          ) : null}
        </p>
        <span className="ml-auto flex gap-2">
          {result && <Button size="sm" variant="soft" disabled={loading} onClick={reload}>Look again</Button>}
          <ButtonLink size="sm" variant="outline" href={filesHref(site, { dir })} onClick={(e) => (e.preventDefault(), navigate(filesHref(site, { dir }), { scroll: false }))}><X />Back to the folder</ButtonLink>
        </span>
      </div>
      {error && !loading && <Notice>{error}</Notice>}
      {result && result.matches.length === 0 && (
        <EmptyState icon={Search} title={find.where === 'text' ? 'No file here has that text' : 'Nothing here by that name'}>
          {find.where === 'text' ? 'Text files are read whatever the case of the letters. .git, node_modules and minified files are left out.' : 'Names are matched whatever the case of the letters. What is inside .git and node_modules is left out.'}
        </EmptyState>
      )}
      {result && result.matches.length > 0 && (
        <Card className={cn('overflow-hidden', loading && 'opacity-70')}>
          <ul className="divide-y text-sm">
            {groups.map(([path, matches]) => {
              const folder = matches[0]?.kind === 'dir';
              return (
                <li key={path} className="px-4 py-2">
                  <TextLink href={folder ? filesHref(site, { dir: path }) : filesHref(site, { file: path })} tone="plain" className="flex min-w-0 gap-2.5 font-medium">
                    {folder ? <Folder className="size-4 shrink-0 text-primary" aria-hidden /> : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{find.where === 'name' ? <Marked text={short(path)} q={find.q} /> : short(path)}</span>
                  </TextLink>
                  {find.where === 'text' && (
                    <ul className="mt-1 grid gap-0.5 pl-6.5">
                      {matches.map((m) => (
                        <li key={m.line}>
                          <Link href={filesHref(site, { file: path, ...(m.line ? { line: m.line } : {}) })} className="flex min-w-0 gap-3 rounded px-1 font-mono text-xs leading-5 hover:bg-muted">
                            <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{m.line}</span>
                            <span className="min-w-0 truncate"><Marked text={m.text ?? ''} q={find.q} /></span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}

function FolderView({ site, dir, find }: { site: Site; dir: string; find: Find | null }) {
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
  // What PHP said about the file as it was saved, until the next save.
  const [warning, setWarning] = useState<string | null>(null);
  // What git says about this file, and its changes since the last commit when asked.
  const git = useAsync(async () => ({ file, status: await api.fileGit(site.domain, parentOf(file), site.path).catch((): FileGitStatus => ({ entries: {} })) }), [site.domain, site.path, file]);
  const gitState = git.data?.file === file ? git.data.status.entries[nameOf(file)] : undefined;
  const [changes, setChanges] = useState<{ diff?: FileDiff; error?: string; loading?: boolean } | null>(null);
  const showChanges = async () => {
    if (changes) return setChanges(null);
    setChanges({ loading: true });
    try {
      setChanges({ diff: await api.fileDiff(site.domain, file, site.path) });
    } catch (e) {
      setChanges({ error: (e as Error).message });
    }
  };
  // What is on disk next to what is typed, when a save found the file changed.
  const [compared, setCompared] = useState<{ diff?: FileDiff; error?: string; loading?: boolean } | null>(null);
  const compare = async () => {
    setCompared({ loading: true });
    try {
      setCompared({ diff: await api.fileCompare(site.domain, site.path, { file, content: draft, ...(view?.eol ? { eol: view.eol } : {}) }) });
    } catch (e) {
      setCompared({ error: (e as Error).message });
    }
  };
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
    setCompared(null);
    const result = await fileAction(site, 'file.write', { file, content, ...(base.hash ? { hash: base.hash } : {}), ...(view?.eol ? { eol: view.eol } : {}), ...(force ? { force: true } : {}) });
    setSaving(false);
    if (result.ok) {
      setBase({ text: content, hash: result.data?.hash });
      setWarning(result.data?.warning ?? null);
      toast(result.data?.warning ? { tone: 'info', title: `Saved ${nameOf(file)}, with a syntax error`, detail: result.data.warning, key: 'file-save' } : { tone: 'success', title: `Saved ${nameOf(file)}`, key: 'file-save' });
      // The file is read again, so its size and date follow, and the view outside the editor shows what was saved.
      reload();
      git.reload();
      setChanges(null);
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
    setCompared(null);
    setSure(false);
    setEdit(false);
  };
  /** Takes the file as it is on disk now, dropping what is typed. */
  const takeDisk = () => {
    dirtyNow.current = false;
    setBase(null);
    setProblem(null);
    setCompared(null);
    setWarning(null);
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
            {gitState && gitState !== 'new' && gitState !== 'deleted' && !editing && (
              <Button size="sm" variant="outline" aria-pressed={changes !== null} onClick={() => void showChanges()}><GitCompare />{changes ? 'Hide changes' : 'Changes'}</Button>
            )}
            {canEdit && !editing && <Button size="sm" onClick={() => setEdit(true)}><Pencil />Edit</Button>}
            {editing && (
              <>
                <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Spinner /> : <Save />}Save</Button>
                <Button size="sm" variant="outline" disabled={saving} onClick={cancel}>{dirty ? (sure ? 'Drop what you typed?' : 'Cancel') : 'Close'}</Button>
              </>
            )}
            <ButtonLink size="sm" variant="outline" href={fileUrl(site.domain, file, site.path)} download={nameOf(file)} onClick={mockDownload}><Download />Download</ButtonLink>
            <Menu items={[{ label: 'Copy path', icon: <Copy />, onSelect: () => copyPath(full) }]} label={`More for ${nameOf(file)}`} />
          </>
        }
        note={view && <><FileFacts view={view} />{gitState ? ` In git: ${GIT_LABEL[gitState].title.toLowerCase()}.` : ''}</>}
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
              <Button size="sm" variant="outline" disabled={saving || compared?.loading} onClick={() => void compare()}>{compared?.loading ? <Spinner /> : <GitCompare />}See the difference</Button>
              <Button size="sm" variant="outline" disabled={saving} onClick={takeDisk}>Reload from disk</Button>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(true)}>Save anyway</Button>
            </span>
          }
        >
          This file changed on disk since you opened it, by an editor, git or WordPress. Reload from disk drops what you typed here; Save anyway replaces what is on disk.
        </Notice>
      )}
      {problem?.changed && compared?.error && <Notice>{compared.error}</Notice>}
      {problem?.changed && compared?.diff && <DiffView diff={compared.diff} label="From what is on disk to what you typed" same="What is on disk now is the same as what you typed." />}
      {warning && (
        <Notice
          tone="warning"
          action={(() => {
            const at = Number(/on line (\d+)$/.exec(warning)?.[1]) || undefined;
            return at ? <Button size="sm" variant="outline" onClick={() => navigate(filesHref(site, { file, line: at, edit: canEdit }), { replace: true })}>Go to line {at}</Button> : undefined;
          })()}
        >
          The file is saved, and PHP cannot read it: {warning}. A page that loads this file fails until it is fixed.
        </Notice>
      )}
      {changes?.error && <Notice>{changes.error}</Notice>}
      {changes?.loading && <LogSkeleton lines={6} />}
      {changes?.diff && !editing && <DiffView diff={changes.diff} label="Changes since the last commit" same="Nothing in this file changed since the last commit." />}

      {!view && loading && <LogSkeleton lines={14} />}
      {view?.kind === 'text' && !editing && <TextView text={base?.text ?? view.text ?? ''} line={line} name={nameOf(file)} />}
      {view?.kind === 'text' && editing && base && (
        <Card className="overflow-hidden focus-within:border-primary/60">
          <EditorBoundary fallback={plain}>
            <Suspense fallback={plain}>
              <FileEditor value={draft} onChange={setDraft} onSave={() => void save()} name={nameOf(file)} label={`${nameOf(file)}, editing`} line={line} />
            </Suspense>
          </EditorBoundary>
        </Card>
      )}
      {editing && (
        <p className="text-xs text-muted-foreground" role="status">
          {dirty ? 'Not saved yet. ' : ''}Nothing is written to the file until you press Save, or Ctrl+S. Cancel leaves it as it is on disk. Ctrl+F finds in the file.
        </p>
      )}
      {view?.kind === 'image' && (
        <Card className="grid place-items-center overflow-hidden bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-4">
          <img src={fileUrl(site.domain, file, site.path, true)} alt={nameOf(file)} className="max-h-[70vh] max-w-full rounded shadow-sm" />
        </Card>
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
    <Card className="overflow-hidden">
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
    </Card>
  );
}

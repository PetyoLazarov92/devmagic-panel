import { type FileEntry, type FileListing, type FileView, type Site, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { ArrowDown, ArrowUp, ChevronRight, Copy, Download, File, FileCode, FileImage, FileText, Folder, FolderGit2, FolderOpen, Link2, Lock, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Notice, ViewBar } from '@/components/page';
import { LogSkeleton, TableSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { ShowMore, useShowMore } from '@/components/ui/show-more';
import { Switch } from '@/components/ui/switch';
import { api, fileUrl, isMockup } from '@/lib/api';
import { filesHref } from '@/lib/file-links';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

/**
 * A site's files: one folder at a time, or one file in the folder's place.
 * The folder and the file are in the address (?tab=files&dir=... or
 * &file=...&line=42), so Back, a reload and a link from a log all land there.
 */

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

export function FilesTab({ site }: { site: Site }) {
  const file = useQueryParam('file');
  const dir = useQueryParam('dir') ?? '';
  const line = Number(useQueryParam('line')) || undefined;
  return file !== null ? <FileViewer site={site} file={file} line={line} /> : <FolderView site={site} dir={dir} />;
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
  useEffect(() => setQuery(''), [key]);

  const hiddenCount = listing?.entries.filter((e) => HIDDEN.has(e.name)).length ?? 0;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortEntries((listing?.entries ?? []).filter((e) => (hidden || !HIDDEN.has(e.name)) && (!q || e.name.toLowerCase().includes(q))), sort);
  }, [listing, query, hidden, sort]);
  const { shown, footer } = useShowMore(rows, { step: 100, reset: `${key}|${query}|${sort.key}|${sort.down}` });

  const hrefOf = (e: FileEntry) => {
    const path = joinPath(dir, e.name);
    if (e.kind === 'link' && e.targetKind === 'missing') return undefined;
    // A link out of the site opens only where it leads into a shared core; the server refuses the rest.
    return isFolder(e) ? filesHref(site, { dir: path }) : e.kind === 'other' ? undefined : filesHref(site, { file: path });
  };
  const menuOf = (e: FileEntry): MenuItem[] => {
    const path = joinPath(dir, e.name);
    const href = hrefOf(e);
    return [
      ...(href ? [{ label: 'Open', icon: isFolder(e) ? <FolderOpen /> : <FileText />, onSelect: () => navigate(href, { scroll: false }) }] : []),
      ...(e.kind === 'file' ? [{ label: 'Download', icon: <Download />, onSelect: () => download(site, path) }] : []),
      { label: 'Copy path', icon: <Copy />, onSelect: () => copyPath(`${listing?.root ?? site.docroot}/${path}`) },
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
    <div className="grid gap-4">
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
        </div>
      )}

      {error && (!listing || !loading) && <Notice action={dir ? <ButtonLink size="sm" variant="outline" href={filesHref(site, { dir: parentOf(dir) })} onClick={(e) => (e.preventDefault(), navigate(filesHref(site, { dir: parentOf(dir) }), { scroll: false }))}>Go up</ButtonLink> : undefined}>{error}</Notice>}
      {listing?.readOnly && <Notice tone="info">{listing.readOnly}</Notice>}
      {listing && listing.more > 0 && <Notice tone="info">This folder is very long: the first {listing.entries.length.toLocaleString('en-US')} entries are listed, {listing.more.toLocaleString('en-US')} more are not.</Notice>}

      {!listing && loading && <TableSkeleton columns={4} rows={8} />}
      {listing && rows.length === 0 && (
        <EmptyState icon={query ? Search : Folder} title={query ? 'Nothing here by that name' : listing.entries.length > 0 ? 'Only hidden folders here' : 'This folder is empty'}>
          {query ? 'The filter looks at the names in this folder only.' : listing.entries.length > 0 ? 'Switch on Show hidden to see .git and node_modules.' : undefined}
        </EmptyState>
      )}
      {listing && rows.length > 0 && (
        <div className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', loading && 'opacity-70')}>
          <table className="w-full table-fixed text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {header('Name', 'name', 'pl-4')}
                {header('Size', 'size', 'w-20 text-right sm:w-24 [&>button]:flex-row-reverse')}
                {header('Changed', 'changed', 'hidden w-32 sm:table-cell')}
                <th scope="col" className="hidden w-24 px-3 py-2.5 font-medium md:table-cell">Permissions</th>
                <th scope="col" className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {dir !== '' && !query && (
                <tr className="hover:bg-muted/40">
                  <td colSpan={5} className="px-4 py-2">
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
                  <tr key={e.name} className="hover:bg-muted/40">
                    <td className="py-2 pr-3 pl-4">
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
    </div>
  );
}

function FileViewer({ site, file, line }: { site: Site; file: string; line: number | undefined }) {
  const { data, error, loading, reload } = useAsync(async () => ({ view: await api.fileView(site.domain, file, site.path), at: new Date().toISOString() }), [site.domain, site.path, file]);
  const view = data?.view.path === file ? data.view : undefined;
  const full = `${site.docroot}/${file}`;
  const up = filesHref(site, { dir: parentOf(file) });

  return (
    <div className="grid gap-4">
      <ViewBar
        onCheck={reload}
        loading={loading}
        checkedAt={view ? data?.at : undefined}
        actions={
          <>
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

      {!view && loading && <LogSkeleton lines={14} />}
      {view?.kind === 'text' && <TextView text={view.text ?? ''} line={line} name={nameOf(file)} />}
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

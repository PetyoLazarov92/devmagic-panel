import { type FileListing, type FileMode, type FileTrashEntry, type Site, FILE_MODES, FILE_MODE_WORDS, FILE_TRASH_DAYS, FOLDER_MODES, isFileName, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';
import { ChevronRight, Folder, FolderOpen, LoaderCircle, Undo2 } from 'lucide-react';
import { type FormEvent, Fragment, useEffect, useId, useState } from 'react';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogList } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { bytes, dateTime, timeAgo } from '@/lib/format';

type SiteId = Pick<Site, 'domain' | 'path'>;

/** One name to type: a new file or folder, or another name for one that is there. */
export function NameDialog({ open, title, description, label, initial, action, taken, onSubmit, onClose }: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initial: string;
  action: string;
  /** Names in the folder already, to say so before the server does. */
  taken: readonly string[];
  /** True closes the dialog; false keeps it open (the toast says why). */
  onSubmit: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);

  const problem = name === '' || name === initial
    ? undefined
    : !isFileName(name)
      ? 'A name has no slash, and no space at its start or end.'
      : taken.includes(name)
        ? `${name} is already in this folder.`
        : undefined;
  const ready = name !== '' && name !== initial && !problem && !busy;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    const done = await onSubmit(name);
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="sm">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">{label}</label>
          <Input
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            // A name with an ending is selected up to its dot, so typing replaces the name and keeps the ending.
            onFocus={(e) => {
              const dot = initial.lastIndexOf('.');
              e.target.setSelectionRange(0, dot > 0 ? dot : initial.length);
            }}
          />
          {problem && <p id={`${id}-problem`} role="alert" className="text-xs text-danger">{problem}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{busy && <LoaderCircle className="animate-spin" />}{action}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Picks a folder of the site: one folder's folders at a time, like the tab itself. */
export function FolderPicker({ site, open, title, verb, start, moving, sameFolder, onPick, onClose }: {
  site: SiteId;
  open: boolean;
  title: string;
  /** What the button says: Move here, Copy here. */
  verb: string;
  /** The folder it opens on. */
  start: string;
  /** The paths on their way: a folder never goes into itself, and for a move its own folder is no change. */
  moving: readonly string[];
  /** Whether the folder they are in now counts as a place (a copy does, a move does not). */
  sameFolder: boolean;
  onPick: (dir: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(start);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDir(start);
  }, [open, start]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(undefined);
    api.files(site.domain, dir, site.path).then(
      (l) => current && setListing(l),
      (e: Error) => current && (setListing(null), setError(e.message)),
    );
    return () => {
      current = false;
    };
  }, [open, site.domain, site.path, dir]);

  const here = listing?.dir === dir ? listing : null;
  const folders = (here?.entries ?? []).filter((e) => e.kind === 'dir' && e.name !== '.git' && e.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const inside = moving.some((p) => dir === p || dir.startsWith(`${p}/`));
  const reason = !here
    ? undefined
    : !here.writable
      ? (here.readOnly ?? 'Another account owns this folder, so nothing can be put here.')
      : inside
        ? 'A folder cannot go into itself.'
        : !sameFolder && moving.every((p) => parentOf(p) === dir)
          ? 'It is in this folder already.'
          : undefined;
  const parts = dir ? dir.split('/') : [];
  const pick = async () => {
    setBusy(true);
    const done = await onPick(dir);
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      expandable
      description={moving.length === 1 ? nameOf(moving[0] ?? '') : `${moving.length} entries`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void pick()} disabled={!here || Boolean(reason) || busy}>{busy && <LoaderCircle className="animate-spin" />}{verb}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <nav aria-label="Folder to put it in" className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
          <button type="button" onClick={() => setDir('')} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground aria-[current]:font-medium aria-[current]:text-foreground" aria-current={parts.length === 0 ? 'page' : undefined}>
            <FolderOpen className="size-4" aria-hidden />Site folder
          </button>
          {parts.map((part, i) => {
            const to = parts.slice(0, i + 1).join('/');
            return (
              <Fragment key={to}>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <button type="button" onClick={() => setDir(to)} className="text-muted-foreground [overflow-wrap:anywhere] hover:text-foreground aria-[current]:font-medium aria-[current]:text-foreground" aria-current={i === parts.length - 1 ? 'page' : undefined}>{part}</button>
              </Fragment>
            );
          })}
        </nav>
        {error && <Notice>{error}</Notice>}
        <DialogList className="max-h-64">
          <ul className="min-h-24 divide-y rounded-lg border text-sm">
            {dir !== '' && (
              <li>
                <button type="button" onClick={() => setDir(parentOf(dir))} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                  <Folder className="size-4 shrink-0" aria-hidden /><span aria-hidden>..</span><span className="sr-only">Up to {parentOf(dir) || 'the site folder'}</span>
                </button>
              </li>
            )}
            {!here && !error && <li className="px-3 py-2 text-muted-foreground">Reading the folder...</li>}
            {here && folders.length === 0 && <li className="px-3 py-2 text-muted-foreground">No folders in here.</li>}
            {folders.map((f) => {
              const path = joinPath(dir, f.name);
              const own = moving.includes(path);
              return (
                <li key={f.name}>
                  <button type="button" disabled={own} onClick={() => setDir(path)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50">
                    <Folder className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{f.name}</span>
                    <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogList>
        {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      </div>
    </Dialog>
  );
}

/** The few permissions a site's files need, by number with what each means; never one that lets everyone write. */
export function PermissionsDialog({ open, items, folder, current, onSubmit, onClose }: {
  open: boolean;
  items: readonly string[];
  /** A folder is among them: only the modes a folder can be opened with are offered. */
  folder: boolean;
  /** What a single entry has now. */
  current: string | undefined;
  onSubmit: (mode: FileMode) => Promise<boolean>;
  onClose: () => void;
}) {
  const id = useId();
  const modes = folder ? FOLDER_MODES : FILE_MODES;
  const [mode, setMode] = useState<FileMode>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // What it has now is the row that is picked, so the list shows the state and Set waits for another one.
    if (open) setMode(current !== undefined && (modes as readonly string[]).includes(current) ? (current as FileMode) : undefined);
  }, [open, current, modes]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mode || busy) return;
    setBusy(true);
    const done = await onSubmit(mode);
    setBusy(false);
    if (done) onClose();
  };
  const known = current !== undefined && (modes as readonly string[]).includes(current);
  return (
    <Dialog open={open} onClose={onClose} title="Permissions" description={items.length === 1 ? nameOf(items[0] ?? '') : `${items.length} entries`}>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 text-sm">
        {current !== undefined && !known && (
          <p className="text-muted-foreground">
            Now <span className="font-mono text-foreground">{current}</span>, which is not one of these.
          </p>
        )}
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 font-medium">Set to</legend>
          {modes.map((m) => (
            <label key={m} htmlFor={`${id}-${m}`} className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 has-checked:border-primary has-checked:bg-primary/5">
              <input id={`${id}-${m}`} type="radio" name={id} value={m} checked={mode === m} onChange={() => setMode(m)} className="size-4 shrink-0 accent-[var(--primary)]" />
              <span className="font-mono">{m}</span>
              <span className="min-w-0 text-balance text-muted-foreground">{FILE_MODE_WORDS[m]}</span>
              {m === current && <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">now</span>}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-pretty text-muted-foreground">{folder ? 'Only the folder changes, not what is in it.' : 'Nothing here lets everyone write.'}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!mode || mode === current || busy}>{busy && <LoaderCircle className="animate-spin" />}Set</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Asked only for a delete that breaks the site or is not what it looks like; the rest go straight to the trash with Undo. */
export function DeleteDialog({ open, items, why, onDelete, onClose }: { open: boolean; items: readonly string[]; why: string; onDelete: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await onDelete();
    setBusy(false);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={items.length === 1 ? `Delete ${nameOf(items[0] ?? '')}?` : `Delete ${items.length} entries?`} size="sm">
      <div className="grid gap-4 text-sm">
        <p>{why}</p>
        <p className="text-muted-foreground">It is kept for {FILE_TRASH_DAYS} days, and Undo puts it back.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}Delete</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** What the Files tab deleted in the last days, each with the button that puts it back. */
export function FileTrashCard({ entries, onRestore }: { entries: readonly FileTrashEntry[]; onRestore: (entry: FileTrashEntry) => Promise<void> }) {
  const [busy, setBusy] = useState<string>();
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes you can undo</CardTitle>
        <span className="text-xs text-muted-foreground">Kept for {FILE_TRASH_DAYS} days</span>
      </CardHeader>
      <ul className="divide-y text-sm">
        {shown.map((entry) => {
          const [first, ...rest] = entry.items;
          return (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-[1_1_14rem]">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {entry.reason === 'replaced' ? 'Replaced' : 'Deleted'} <span className="font-mono text-xs">{first}</span>
                  {rest.length > 0 && <span className="font-normal text-muted-foreground" title={rest.join('\n')}> and {rest.length} more</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  <time dateTime={entry.deletedAt} title={dateTime(entry.deletedAt)}>{timeAgo(entry.deletedAt)}</time>, {bytes(entry.sizeBytes)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() => {
                  setBusy(entry.id);
                  void onRestore(entry).finally(() => setBusy(undefined));
                }}
              >
                {busy === entry.id ? <LoaderCircle className="animate-spin" /> : <Undo2 />}Put back
              </Button>
            </li>
          );
        })}
      </ul>
      {entries.length > shown.length && (
        <div className="border-t px-5 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show all {entries.length}</Button>
        </div>
      )}
    </Card>
  );
}

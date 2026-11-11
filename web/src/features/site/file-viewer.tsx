import { type FileDiff, type FileGitStatus, type FileView, type Site, FILE_CHANGED, nameOf, parentOf } from '@devmagic-panel/shared';
import { Copy, Download, File, GitCompare, Pencil, Save } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from '@/features/site/diff-view';
import { EditorBoundary } from '@/components/layout/editor-boundary';
import { EmptyState, Notice, ViewBar } from '@/components/layout/page';
import { LogSkeleton } from '@/components/layout/skeletons';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Menu } from '@/components/ui/menu';
import { api, fileUrl, isMockup } from '@/lib/api';
import { loadFileEditor } from '@/lib/file-editor-load';
import { filesHref } from '@/lib/file-links';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Breadcrumb, GIT_LABEL, copyPath, download, fileAction } from './files-shared';

/**
 * A site's files: one folder at a time, or one file in the folder's place.
 * The folder and the file are in the address (?tab=files&dir=... or
 * &file=...&line=42), so Back, a reload and a link from a log all land there.
 * Every change is an action of the registry (file.write, file.delete, ...),
 * and a delete goes to the file trash, where Undo finds it.
 */

export const FileEditor = lazy(loadFileEditor);

export const mockDownload = (e: { preventDefault: () => void }) => {
  if (!isMockup) return;
  e.preventDefault();
  toast({ tone: 'info', title: 'Mockup: this downloads the file' });
};

export function FileViewer({ site, file, line, edit }: { site: Site; file: string; line: number | undefined; edit: boolean }) {
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

export function FileFacts({ view }: { view: FileView }) {
  return (
    <>
      {bytes(view.sizeBytes)}, changed <time dateTime={view.modifiedAt} title={dateTime(view.modifiedAt)}>{timeAgo(view.modifiedAt)}</time>, permissions <span className="font-mono">{view.mode}</span>
      {view.eol === 'crlf' ? ', Windows line ends' : ''}.
    </>
  );
}

/** A file's text with line numbers, the line asked for marked and in view. */
export function TextView({ text, line, name }: { text: string; line: number | undefined; name: string }) {
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

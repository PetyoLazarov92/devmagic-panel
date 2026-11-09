import type { ActionId, DbCell, DbColumnHead, DbRow, RowChangeInfo } from '@devmagic-panel/shared';
import { History, LoaderCircle, RotateCcw, TriangleAlert, Wand2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EditorBoundary } from '@/components/editor-boundary';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import { shortDate, timeAgo } from '@/lib/format';
import { useRowDialogFull } from '@/lib/preferences';
import { fixSerializedLengths, looksSerialized, lostPropertyMarks, needsExactEditor, parseJsonValue, parsePhpSerialized, type PropertyName, withNulMarks } from '@/lib/php-serialized';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { FieldsSkeleton } from '@/components/skeletons';

// Loaded only when a value with control characters is edited.
const ValueEditor = lazy(() => import('@/components/value-editor'));

/** Runs a row action; an answer the server refused comes back as a message, never thrown. */
async function runRow(id: ActionId, input: Record<string, unknown>): Promise<{ ok: true; change?: string; output: string } | { ok: false; error: string }> {
  try {
    const r = await api.runAction(id, input);
    return r.ok ? { ok: true, output: r.output, ...(r.data?.backup ? { change: r.data.backup } : {}) } : { ok: false, error: lastLine(r.output) || 'MySQL refused the change' };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** A toast for a row change, with Undo while its saved copy is there. */
export function toastRowChange(title: string, database: string, table: string, change: string | undefined, after: () => void) {
  toast({
    tone: 'success',
    title,
    ...(change
      ? {
          action: {
            label: 'Undo',
            run: () =>
              void runRow('mysql.undoRowChange', { database, table, change }).then((r) => {
                toast(r.ok ? { tone: 'success', title: 'Undone' } : { tone: 'danger', title: 'Not undone', detail: r.error });
                after();
              }),
          },
        }
      : {}),
  });
}

interface Field {
  value: string;
  isNull: boolean;
  /** For a new row: a field left alone gets the column's default. */
  touched: boolean;
}

/** Whether a column is written by the editor; the others show why not. */
function lockedWhy(c: DbColumnHead, mode: EditorMode, primaryKey: readonly string[]): string | null {
  if (c.generated) return 'computed by MySQL';
  if (c.binary) return 'binary: change it in phpMyAdmin';
  if (mode === 'edit' && primaryKey.includes(c.name)) return 'the key that finds the row';
  if (mode !== 'edit' && c.autoIncrement) return 'MySQL numbers it';
  return null;
}

export type EditorMode = 'edit' | 'duplicate' | 'add';

const text = (cell: DbCell): string | null => (cell === null ? null : typeof cell === 'string' ? cell : cell.head);

/**
 * Edits a row, or adds one (empty, or a copy of a row). Long values load in
 * full first. A change is saved only while the row still holds what this
 * dialog read; a PHP serialized or JSON value that no longer reads is
 * flagged, with a fix for serialized lengths.
 */
export function RowEditor({ mode, database, table, columns, primaryKey, row, onClose, onDone }: {
  mode: EditorMode;
  database: string;
  table: string;
  columns: DbColumnHead[];
  primaryKey: string[];
  row: DbRow | null;
  onClose: () => void;
  onDone: (title: string, change?: string) => void;
}) {
  const [original, setOriginal] = useState<Array<string | null> | null>(mode === 'add' ? columns.map(() => null) : null);
  const [fields, setFields] = useState<Field[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keptOpen, setKeptOpen] = useState(false);
  const formId = useId();
  const fullScreen = useRowDialogFull();

  // The full values first: a long one shows only its start on the page.
  useEffect(() => {
    if (mode === 'add') {
      setFields(columns.map(() => ({ value: '', isNull: false, touched: false })));
      return;
    }
    if (!row) return;
    let live = true;
    void (async () => {
      try {
        const full = await Promise.all(
          row.cells.map(async (cell, i) => {
            const column = columns[i] as DbColumnHead;
            if (cell === null || typeof cell === 'string' || column.binary) return text(cell);
            if (!row.key) throw new Error('This row has no key to read its full values by');
            const v = await api.dbCell(database, table, { column: column.name, key: row.key });
            if (v.cut) throw new Error(`${column.name} is over a megabyte: change it in phpMyAdmin`);
            return text(v.value);
          }),
        );
        if (!live) return;
        setOriginal(full);
        setFields(full.map((v, i) => ({ value: v ?? '', isNull: v === null, touched: mode === 'duplicate' && lockedWhy(columns[i] as DbColumnHead, mode, primaryKey) === null })));
      } catch (err) {
        if (live) setLoadError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, row, columns, database, table, primaryKey]);

  const set = (i: number, next: Partial<Field>) => setFields((f) => f.map((x, j) => (j === i ? { ...x, ...next, touched: true } : x)));
  const valueOf = (f: Field) => (f.isNull ? null : f.value);

  async function save() {
    if (!original) return;
    setSaving(true);
    setError(null);
    const editable = columns.map((c) => lockedWhy(c, mode, primaryKey) === null);
    let result;
    if (mode === 'edit') {
      const changed = columns.flatMap((c, i) => (editable[i] && valueOf(fields[i] as Field) !== original[i] ? [c.name] : []));
      if (!changed.length) {
        setSaving(false);
        setError('Nothing changed');
        return;
      }
      const at = (name: string) => columns.findIndex((c) => c.name === name);
      result = await runRow('mysql.updateRow', {
        database,
        table,
        rowKey: row?.key,
        rowValues: Object.fromEntries(changed.map((n) => [n, valueOf(fields[at(n)] as Field)])),
        rowWas: Object.fromEntries(changed.map((n) => [n, original[at(n)] ?? null])),
      });
    } else {
      const given = columns.flatMap((c, i) => (editable[i] && (fields[i] as Field).touched ? [[c.name, valueOf(fields[i] as Field)] as const] : []));
      if (!given.length) {
        setSaving(false);
        setError('Fill in at least one column');
        return;
      }
      result = await runRow('mysql.insertRow', { database, table, rowValues: Object.fromEntries(given) });
    }
    setSaving(false);
    if (!result.ok) return setError(result.error);
    onDone(mode === 'edit' ? 'Row changed' : 'Row added', result.change);
  }

  // Anything typed would be lost: a copy differs from the row it came from,
  // a new row from its empty fields.
  const changed = original !== null && fields.some((f, i) => (mode === 'add' ? f.touched : valueOf(f) !== (original[i] ?? null)));

  const title = mode === 'edit' ? `Change a row of ${table}` : mode === 'duplicate' ? `Add a copy of a row to ${table}` : `Add a row to ${table}`;
  const ready = fields.length > 0 && original !== null;
  return (
    <Dialog
      open
      onClose={onClose}
      closeOnBackdrop={false}
      closeOnEscape={!changed}
      onKeptOpen={() => setKeptOpen(true)}
      title={title}
      description={mode === 'edit' ? 'Saved only while the row still holds what you see here. Undo in the toast, or under Changes you can undo, puts it back for 14 days.' : 'Columns you leave alone get their default. Undo deletes the row again.'}
      size="xl"
      fullScreen={fullScreen}
      footer={
        <>
          {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
          {!error && keptOpen && changed && <p role="status" className="mr-auto text-sm text-muted-foreground">Not saved yet: Cancel discards what you typed.</p>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {ready && <Button type="submit" form={formId} disabled={saving}>{saving && <LoaderCircle className="animate-spin" />}{mode === 'edit' ? 'Save the row' : 'Add the row'}</Button>}
        </>
      }
    >
      {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
      {!loadError && fields.length === 0 && <FieldsSkeleton fields={4} />}
      {ready && (
        <form
          id={formId}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {columns.map((c, i) => (
            <FieldRow key={c.name} column={c} field={fields[i] as Field} original={original[i] ?? null} locked={lockedWhy(c, mode, primaryKey)} mode={mode} tall={fullScreen.on} onChange={(next) => set(i, next)} />
          ))}
        </form>
      )}
    </Dialog>
  );
}

const lostName = (p: PropertyName) => (p.visibility === 'private' ? `${p.name} (private to ${p.owner})` : `${p.name} (protected)`);

function FieldRow({ column, field, original, locked, mode, tall, onChange }: { column: DbColumnHead; field: Field; original: string | null; locked: string | null; mode: EditorMode; tall: boolean; onChange: (next: Partial<Field>) => void }) {
  const id = `field-${column.name}`;
  // A value that was PHP serialized or JSON and no longer reads would reach WordPress as plain text.
  // A new value counts too once it starts like a serialized array or object.
  const broken = useMemo(() => {
    if (field.isNull || field.value === original) return null;
    const wasSerialized = original !== null && parsePhpSerialized(original) !== null;
    if ((wasSerialized || looksSerialized(field.value)) && !parsePhpSerialized(field.value)) return 'serialized';
    if (original !== null && parseJsonValue(original) !== undefined && parseJsonValue(field.value) === undefined) return 'json';
    return null;
  }, [field, original]);
  // \0 typed around a property name is two characters, not the NUL byte PHP writes there.
  const marked = useMemo(() => (field.isNull ? null : withNulMarks(field.value)), [field]);
  // Protected and private properties keep NUL bytes around their names; one deleted makes a new public property.
  const lost = useMemo(() => (field.isNull || original === null || field.value === original || !parsePhpSerialized(original) ? [] : lostPropertyMarks(original, field.value)), [field, original]);
  // A plain text box hides NUL bytes and turns \r\n into \n: such a value is edited where both show and stay.
  const exact = !column.numeric && (needsExactEditor(original ?? '') || needsExactEditor(field.value));
  // Full screen has room for longer values before a box scrolls.
  const lines = Math.min(tall ? 30 : 10, Math.max(1, field.value.split('\n').length, Math.ceil(field.value.length / (tall ? 160 : 90))));
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono font-medium text-foreground">{column.name}</span>
        <span className="font-mono">{column.type}</span>
        {locked && <Badge>{locked}</Badge>}
        {mode === 'add' && !locked && !field.touched && <Badge>default</Badge>}
      </label>
      {locked ? (
        <p className="rounded-md bg-muted/60 px-3 py-2 font-mono text-[13px] break-all text-muted-foreground">{original === null ? (mode === 'edit' ? 'NULL' : ' ') : original}</p>
      ) : (
        <div className="flex items-start gap-2">
          {exact && !field.isNull ? (
            <EditorBoundary fallback={<p className="flex-1 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">This value has characters a plain text box would change, and its editor did not load. Reload the page, or change it in phpMyAdmin.</p>}>
              <Suspense fallback={<div className="h-20 flex-1 animate-pulse rounded-md bg-muted" />}>
                <ValueEditor id={id} value={field.value} onChange={(value) => onChange({ value })} />
              </Suspense>
            </EditorBoundary>
          ) : column.numeric ? (
            <Input id={id} value={field.isNull ? '' : field.value} disabled={field.isNull} inputMode="decimal" onChange={(e) => onChange({ value: e.target.value })} className="font-mono text-[13px]" />
          ) : (
            <Textarea id={id} value={field.isNull ? '' : field.value} disabled={field.isNull} rows={lines} spellCheck={false} onChange={(e) => onChange({ value: e.target.value })} className="min-h-9 font-mono text-[13px]" />
          )}
          {column.nullable && (
            <label className="flex shrink-0 items-center gap-1.5 pt-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={field.isNull} onChange={(e) => onChange({ isNull: e.target.checked })} />
              NULL
            </label>
          )}
        </div>
      )}
      {exact && !field.isNull && field.value.includes('\0') && (
        <p className="text-xs text-muted-foreground">
          <code className="rounded-sm bg-foreground/10 px-0.5">\0</code> is a NUL byte. PHP keeps them around the names of protected and private properties: leave them where they are.
        </p>
      )}
      {lost.length > 0 && (
        <p role="alert" className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-label="Warning" />
          <span>
            No longer protected or private: {lost.map(lostName).join(', ')}. A NUL byte around the name was deleted, or the property taken out, so PHP would read a new public property. Put the <code className="rounded-sm bg-foreground/10 px-0.5">\0</code> back, or Cancel.
          </span>
        </p>
      )}
      {marked !== null && (
        <p className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-label="Warning" />
          <span className="flex-1">
            A typed <code className="rounded-sm bg-foreground/10 px-0.5">\0</code> is a backslash and a zero. Around a property name PHP needs a NUL byte, which makes it protected (<code className="rounded-sm bg-foreground/10 px-0.5">\0*\0name</code>) or private (<code className="rounded-sm bg-foreground/10 px-0.5">\0Class\0name</code>).
          </span>
          <Button size="sm" variant="outline" onClick={() => onChange({ value: marked })}><Wand2 />Turn \0 into NUL bytes</Button>
        </p>
      )}
      {broken && marked === null && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <TriangleAlert className="size-3.5" aria-label="Warning" />
          {broken === 'serialized' ? 'No longer a whole PHP serialized value (a string length does not add up): WordPress would read it as plain text.' : 'No longer valid JSON.'}
          {/* Counting again would make a property that lost its NUL bytes a public one without a word: not offered then. */}
          {broken === 'serialized' && lost.length === 0 && fixSerializedLengths(field.value) && (
            <Button size="sm" variant="outline" onClick={() => onChange({ value: fixSerializedLengths(field.value) as string })}><Wand2 />Count the lengths again</Button>
          )}
        </p>
      )}
    </div>
  );
}

/** Asks before deleting rows; each is saved first, so Undo puts it back. */
export function DeleteRowsDialog({ count, table, onClose, onConfirm, busy }: { count: number; table: string; onClose: () => void; onConfirm: () => void; busy: boolean }) {
  return (
    <Dialog open onClose={onClose} title={count === 1 ? `Delete this row of ${table}?` : `Delete ${count} rows of ${table}?`} description={`${count === 1 ? 'The row is' : 'Each row is'} saved first, so Undo in the toast, or under Changes you can undo, puts ${count === 1 ? 'it' : 'them'} back for 14 days.`}>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>{busy && <LoaderCircle className="animate-spin" />}{count === 1 ? 'Delete the row' : `Delete ${count} rows`}</Button>
      </div>
    </Dialog>
  );
}

export async function deleteRowsNow(database: string, table: string, keys: string[][]) {
  return runRow('mysql.deleteRows', { database, table, rowKeys: keys });
}

const KIND: Record<RowChangeInfo['kind'], (n: number) => string> = {
  update: () => 'Changed a row',
  insert: () => 'Added a row',
  delete: (n) => (n === 1 ? 'Deleted a row' : `Deleted ${n} rows`),
};

/** The table's row changes saved for Undo, newest first, until their copy goes after 14 days. */
export function RowChangesCard({ database, table, refresh, onUndone }: { database: string; table: string; refresh: number; onUndone: () => void }) {
  const list = useAsync(() => api.rowChanges(database, table), [database, table, refresh]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const items = list.data ?? [];
  if (!items.length) return null;

  async function undo(change: string) {
    setUndoing(change);
    const r = await runRow('mysql.undoRowChange', { database, table, change });
    setUndoing(null);
    toast(r.ok ? { tone: 'success', title: 'Undone' } : { tone: 'danger', title: 'Not undone', detail: r.error });
    list.reload();
    onUndone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes you can undo</CardTitle>
        <History className="size-4 text-muted-foreground" />
      </CardHeader>
      <p className="px-5 pt-3 text-xs text-muted-foreground">Each one is undone only while the rows still hold what it left. The newest first.</p>
      <ul className="mt-2 divide-y">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-sm">
            <span className="font-medium">{KIND[c.kind](c.rows)}</span>
            <span className="flex-1 text-xs text-muted-foreground">{timeAgo(c.savedAt)}, kept until {shortDate(c.purgeAt)}</span>
            <Button size="sm" variant="outline" disabled={undoing !== null} onClick={() => void undo(c.id)}>
              {undoing === c.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}Undo
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

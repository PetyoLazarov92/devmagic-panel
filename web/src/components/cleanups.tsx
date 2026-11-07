import type { CleanupInfo } from '@devmagic-panel/shared';
import { History, LoaderCircle, RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmField } from '@/components/ui/confirm-field';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { bytes, shortDate, timeAgo } from '@/lib/format';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';

const number = (n: number) => n.toLocaleString('en-US');

/** What a clean-up removed, in a few words: "18,451 rows of wp_posts, 940 of wp_postmeta". */
export function removed(c: Pick<CleanupInfo, 'kind' | 'tables'>): string {
  if (c.kind === 'sql') return c.tables.length ? `saved ${c.tables.map((t) => t.table).join(', ')}` : 'saved what was there';
  if (c.kind === 'drop') return `table ${c.tables[0]?.table ?? ''}`;
  if (c.kind === 'empty') return `every row of ${c.tables[0]?.table ?? ''}`;
  if (c.kind === 'fix') return `saved ${c.tables[0]?.table ?? ''} whole`;
  if (c.kind === 'autoload') return `${number(c.tables[0]?.rows ?? 0)} ${c.tables[0]?.rows === 1 ? 'option' : 'options'} of ${c.tables[0]?.table ?? ''}`;
  return c.tables.map((t, i) => `${number(t.rows)} ${i === 0 ? (t.rows === 1 ? 'row of ' : 'rows of ') : 'of '}${t.table}`).join(', ');
}

/**
 * The clean-ups saved for a database, or one site of it, newest first, with
 * Undo until their copy goes after 14 days. Hidden while there are none.
 */
export function CleanupsCard({ database, site, refresh, onUndone }: { database: string; site?: string; refresh: number; onUndone: () => void }) {
  const list = useAsync(() => api.cleanups(database, site), [database, site, refresh]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const items = list.data ?? [];
  if (!items.length) return null;

  async function undo(c: CleanupInfo) {
    setUndoing(c.id);
    try {
      const r = await api.runAction('mysql.undoCleanup', { database, cleanup: c.id });
      toast(r.ok ? { tone: 'success', title: 'Undone', detail: lastLine(r.output) } : { tone: 'danger', title: 'Not undone', detail: lastLine(r.output) });
    } catch (error) {
      toast({ tone: 'danger', title: 'Not undone', detail: (error as Error).message });
    }
    setUndoing(null);
    list.reload();
    onUndone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes you can undo</CardTitle>
        <History className="size-4 text-muted-foreground" />
      </CardHeader>
      <p className="px-5 pt-3 text-xs text-muted-foreground">Clean-ups and SQL that wrote, saved first. Undo puts back what a clean-up removed, next to rows made since, and puts back the tables SQL changed as they were before it.</p>
      <ul className="mt-2 divide-y">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.title}</p>
              <p className="text-xs text-muted-foreground">
                {removed(c)} · {timeAgo(c.savedAt)}, {bytes(c.bytes)} saved until {shortDate(c.purgeAt)}
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={undoing !== null} onClick={() => void undo(c)}>
              {undoing === c.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}Undo
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Asks before a clean-up: the title asks the question, the description says
 * what is saved and what Undo does. A table's name is typed to empty or
 * delete it; rows a clean-up finds need only the button.
 */
export function ConfirmCleanup({ title, description, action, typed, onClose, onConfirm }: {
  title: string;
  description: ReactNode;
  action: string;
  /** Text to type before the button works, like the table's name. */
  typed?: string;
  onClose: () => void;
  onConfirm: (confirm: string) => void;
}) {
  const [value, setValue] = useState('');
  const ready = typed === undefined || value === typed;
  return (
    <Dialog open onClose={onClose} title={title} description={description}>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onConfirm(value);
        }}
      >
        {typed !== undefined && <ConfirmField id="confirm-cleanup" expected={typed} value={value} onChange={setValue} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={!ready}>{action}</Button>
        </div>
      </form>
    </Dialog>
  );
}

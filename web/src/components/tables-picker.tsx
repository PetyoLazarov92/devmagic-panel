import type { ServerTables } from '@devmagic-panel/shared';
import { useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { bytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The tables of a database, biggest first, each with a tick to leave its
 * rows out of the copy: its structure still comes, empty, so nothing misses
 * a table. Known logs and personal data are marked; the ticks are the
 * caller's state.
 */
export function TablesPicker({ found, value, onChange }: { found: ServerTables; value: readonly string[]; onChange: (next: string[]) => void }) {
  const uid = useId();
  const [all, setAll] = useState(false);
  const ticked = new Set(value);
  const logs = new Set(found.logs);
  const personal = new Set(found.personal);
  const left = found.tables.filter((t) => ticked.has(t.name)).reduce((n, t) => n + t.bytes, 0);
  const total = found.tables.reduce((n, t) => n + t.bytes, 0);
  // The marked and ticked ones and the biggest twelve; the rest on request.
  const shown = all ? found.tables : found.tables.filter((t, i) => i < 12 || ticked.has(t.name) || logs.has(t.name) || personal.has(t.name));
  const toggle = (name: string, on: boolean) => onChange(on ? [...value, name] : value.filter((t) => t !== name));
  const tickAll = (names: string[]) => onChange([...new Set([...value, ...names])]);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {found.tables.length} tables, {bytes(total)}; {value.length ? `the rows of ${value.length} (${bytes(left)}) stay on the server` : 'every row comes'}.
        </span>
        {found.logs.length > 0 && <Button size="sm" variant="soft" onClick={() => tickAll(found.logs)}>Tick the logs</Button>}
        {found.personal.length > 0 && <Button size="sm" variant="soft" onClick={() => tickAll(found.personal)}>Tick personal data</Button>}
        {value.length > 0 && <Button size="sm" variant="soft" onClick={() => onChange([])}>Untick all</Button>}
      </div>
      <ul className="grid max-h-72 gap-px overflow-y-auto rounded-lg border bg-border">
        {shown.map((t) => {
          const id = `${uid}-${t.name}`;
          return (
            <li key={t.name} className={cn('flex items-center gap-2.5 bg-card px-3 py-1.5', ticked.has(t.name) && 'bg-muted/50')}>
              <input id={id} type="checkbox" checked={ticked.has(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} className="size-4 shrink-0 accent-[var(--primary)]" />
              <label htmlFor={id} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <code className="truncate font-mono text-xs">{t.name}</code>
                {logs.has(t.name) && <Badge>log</Badge>}
                {personal.has(t.name) && <Badge tone="warning">personal data</Badge>}
              </label>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{bytes(t.bytes)}</span>
            </li>
          );
        })}
      </ul>
      {!all && shown.length < found.tables.length && (
        <Button size="sm" variant="soft" className="w-fit" onClick={() => setAll(true)}>Show all {found.tables.length} tables</Button>
      )}
      <p className="text-xs text-muted-foreground">
        A ticked table comes empty, with its structure. Only whole tables: personal data in users, comments or options still comes, and the clean step handles those here.
      </p>
    </div>
  );
}

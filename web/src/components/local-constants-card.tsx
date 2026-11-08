import type { ConstantValue, LocalConstant } from '@devmagic-panel/shared';
import { localConstants } from '@devmagic-panel/shared';
import { Check, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';

type Kind = 'boolean' | 'number' | 'text';
interface Row {
  name: string;
  kind: Kind;
  text: string;
}

const kindOf = (value: ConstantValue): Kind => (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text');
const rowOf = (c: LocalConstant): Row => ({ name: c.name, kind: kindOf(c.value), text: String(c.value) });
const valueOf = (row: Row): ConstantValue => (row.kind === 'boolean' ? row.text === 'true' : row.kind === 'number' ? Number(row.text) : row.text);

/**
 * The constants every local site should have, like WP_ENVIRONMENT_TYPE local:
 * new installs write them into wp-config.php, Aura asks for the ones a site
 * lacks, and each site's Debug settings show them.
 */
export function LocalConstantsCard() {
  const saved = useAsync(() => api.localConstants(), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [state, setState] = useState<'saving' | 'saved' | null>(null);
  useEffect(() => {
    if (saved.data) setRows(saved.data.map(rowOf));
  }, [saved.data]);

  const list = (rows ?? []).filter((r) => r.name !== '').map((r) => ({ name: r.name, value: valueOf(r) }));
  const check = localConstants.safeParse(list);
  const problem = check.success ? null : (check.error.issues[0]?.message ?? 'Not a valid list');
  const changed = saved.data !== undefined && JSON.stringify(list) !== JSON.stringify(saved.data);
  const update = (i: number, row: Partial<Row>) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...row } : r)));

  async function save() {
    if (!check.success) return;
    setState('saving');
    try {
      const next = await api.saveLocalConstants(check.data);
      saved.reload();
      setRows(next.map(rowOf));
      setState('saved');
    } catch (err) {
      setState(null);
      toast({ tone: 'danger', title: 'Not saved', detail: (err as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local constants</CardTitle>
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        <p className="text-xs text-muted-foreground">
          Constants every local site should have in wp-config.php. New installs write them, over the repo's own value; Aura lists the sites that lack one, with a fix; each site's Debug settings show them.
        </p>
        {saved.error && <p role="alert" className="text-danger">{saved.error}</p>}
        {rows && (
          <ul className="grid gap-2">
            {rows.map((row, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Input value={row.name} onChange={(e) => update(i, { name: e.target.value.trim() })} placeholder="WANDWORKS_DEV" aria-label="Constant name" className="h-8 w-56 font-mono text-[13px]" />
                <Select value={row.kind} onChange={(e) => { const kind = e.target.value as Kind; update(i, { kind, text: kind === 'boolean' ? 'true' : '' }); }} aria-label="Kind" className="h-8">
                  <option value="boolean">true or false</option>
                  <option value="number">number</option>
                  <option value="text">text</option>
                </Select>
                {row.kind === 'boolean' ? (
                  <Select value={row.text} onChange={(e) => update(i, { text: e.target.value })} aria-label="Value" className="h-8">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </Select>
                ) : (
                  <Input value={row.text} onChange={(e) => update(i, { text: e.target.value })} placeholder={row.kind === 'number' ? '256' : 'local'} aria-label="Value" className="h-8 w-48 font-mono text-[13px]" />
                )}
                <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${row.name || 'this constant'}`} onClick={() => setRows((rs) => (rs ?? []).filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!rows || rows.length >= 20} onClick={() => setRows((rs) => [...(rs ?? []), { name: '', kind: 'boolean', text: 'true' }])}>
            <Plus />
            Add a constant
          </Button>
          {changed && (
            <Button size="sm" disabled={problem !== null || state === 'saving'} onClick={() => void save()}>
              {state === 'saving' ? <LoaderCircle className="animate-spin" /> : <Check />}
              Save
            </Button>
          )}
          {changed && problem && <span className="text-xs text-danger">{problem}</span>}
          {!changed && state === 'saved' && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5 text-success" />Saved</span>}
        </div>
      </div>
    </Card>
  );
}

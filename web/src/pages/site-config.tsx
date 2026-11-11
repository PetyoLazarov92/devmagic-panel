import type { ConstantValue, LocalConstant, Site, SiteConstant, SiteSalts } from '@devmagic-panel/shared';
import { constantName, constantValue, editableConstant } from '@devmagic-panel/shared';
import { Check, KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { runWithToast } from '@/lib/site-actions';
import { siteTarget } from '@/lib/site-ref';
import { useAsync } from '@/lib/use-async';
import { ScopeLabel } from '@/components/scope-label';

type Kind = 'boolean' | 'number' | 'text';
type Setter = (name: string, value: ConstantValue | null) => Promise<boolean>;

/** A value as PHP writes it: text quoted, true, false and numbers as they are. */
export function shownValue(value: ConstantValue): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** Text from a field as a value of the kind picked, or why it is not one. */
function typed(kind: Kind, text: string): { value: ConstantValue } | { error: string } {
  const value = kind === 'boolean' ? text === 'true' : kind === 'number' ? Number(text) : text;
  if (kind === 'number' && (text.trim() === '' || !Number.isInteger(value))) return { error: 'A whole number' };
  const ok = constantValue.safeParse(value);
  return ok.success ? { value: ok.data } : { error: ok.error.issues[0]?.message ?? 'Not a value' };
}

export async function setConstant(site: Site, name: string, value: ConstantValue | null): Promise<boolean> {
  const label = value === null ? `${name} removed` : `${name} set to ${shownValue(value)}`;
  const r = await runWithToast('site.setConstant', { ...siteTarget(site), name, value }, label);
  return r?.ok === true;
}

/**
 * The local constants from Settings, each on one row laid out the same way:
 * the name, what the site has, and on the right a switch for true or false,
 * else a button to set the value Settings asks for.
 */
export function LocalConstants({ site, list, busy, onSet }: { site: Site; list: LocalConstant[]; busy: boolean; onSet: (name: string, value: ConstantValue) => void }) {
  if (list.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {list.map((c) => {
        const now = site.constants?.find((s) => s.name === c.name);
        const same = now?.value === c.value;
        return (
          <li key={c.name} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <code className="truncate font-mono text-dense" title={c.name}>{c.name}</code>
            <span className="grid min-w-0 text-xs">
              {now === undefined ? <span className="text-muted-foreground">not set</span> : now.value !== undefined ? <code className="truncate font-mono text-dense">{shownValue(now.value)}</code> : <span className="text-muted-foreground">set by code</span>}
              {!same && <span className="text-warning">Settings asks for {shownValue(c.value)}</span>}
            </span>
            {typeof c.value === 'boolean' ? (
              <Switch checked={now?.value === true} onChange={(v) => onSet(c.name, v)} label={c.name} disabled={busy} />
            ) : same ? (
              <Check className="size-4 text-success" aria-label="As Settings asks" />
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onSet(c.name, c.value)}>Set</Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One constant's row: its value to change in place, or why it cannot be. */
function ConstantRow({ constant, busy, onSet }: { constant: SiteConstant; busy: boolean; onSet: Setter }) {
  const { name, value } = constant;
  const editable = editableConstant(name) && value !== undefined;
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const kind: Kind = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text';
  const next = typed(kind, text);
  const changed = 'value' in next && next.value !== value;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5 text-sm">
      <code className="min-w-0 basis-56 truncate font-mono lg:basis-72 text-dense font-medium" title={name}>{name}</code>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {constant.hidden ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3.5 shrink-0" />hidden: edit wp-config.php by hand</span>
        ) : constant.code !== undefined ? (
          <span className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono text-dense text-muted-foreground" title={constant.code}>{constant.code}</code>
            <Badge>code</Badge>
          </span>
        ) : !editable ? (
          <span className="flex min-w-0 items-center gap-1.5" title="Left to the install">
            <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Left to the install" />
            <code className="truncate font-mono text-dense">{shownValue(value as ConstantValue)}</code>
          </span>
        ) : kind === 'boolean' ? (
          <span className="flex items-center gap-2">
            <Switch checked={value === true} onChange={(v) => void onSet(name, v)} label={name} disabled={busy} />
            <code className="font-mono text-dense text-muted-foreground">{String(value)}</code>
          </span>
        ) : (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if ('value' in next && changed) void onSet(name, next.value);
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={name} className="h-8 min-w-0 max-w-md font-mono text-dense" inputMode={kind === 'number' ? 'numeric' : undefined} />
            {changed && <Button size="sm" type="submit" disabled={busy}>Save</Button>}
            {'error' in next && <span className="text-xs text-danger">{next.error}</span>}
          </form>
        )}
      </div>
      {editableConstant(name) && !constant.hidden && (
        <Button size="icon" variant="ghost" className="size-8" title={`Remove ${name}`} aria-label={`Remove ${name}`} disabled={busy} onClick={() => void onSet(name, null)}>
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

/** A new constant: its name, kind and value. */
function AddConstant({ site, busy, onSet }: { site: Site; busy: boolean; onSet: Setter }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('boolean');
  const [text, setText] = useState('true');
  const named = constantName.safeParse(name);
  const exists = site.constants?.some((c) => c.name === name);
  const problem = !name ? null : !named.success ? 'A name like WANDWORKS_FLAG' : !editableConstant(name) ? 'The panel does not set this one' : exists ? 'Already there: change it above' : null;
  const next = typed(kind, text);
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t px-5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && name && 'value' in next) {
          void onSet(name, next.value).then((ok) => {
            if (ok) setName('');
          });
        }
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="NEW_CONSTANT" aria-label="Constant name" className="h-8 w-56 font-mono text-dense" />
      <Select value={kind} onChange={(e) => { const k = e.target.value as Kind; setKind(k); setText(k === 'boolean' ? 'true' : ''); }} aria-label="Kind" className="h-8">
        <option value="boolean">true or false</option>
        <option value="number">number</option>
        <option value="text">text</option>
      </Select>
      {kind === 'boolean' ? (
        <Select value={text} onChange={(e) => setText(e.target.value)} aria-label="Value" className="h-8">
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'number' ? '256' : 'value'} aria-label="Value" className="h-8 w-48 font-mono text-dense" />
      )}
      <Button size="sm" type="submit" disabled={busy || !name || problem !== null || 'error' in next}>
        <Plus />
        Add
      </Button>
      {problem && <span className="text-xs text-danger">{problem}</span>}
      {!problem && name && 'error' in next && <span className="text-xs text-danger">{next.error}</span>}
    </form>
  );
}

/** The keys WordPress would not take from wp-config.php, and the button text for writing them. */
export function saltsSummary(salts: SiteSalts) {
  const bad = salts.names.filter((n) => salts.missing.includes(n) || salts.placeholder.includes(n) || salts.duplicate.includes(n));
  const onlyMissing = bad.every((n) => salts.missing.includes(n));
  return { bad, ok: salts.names.length - bad.length, fixLabel: onlyMissing ? 'Add missing keys and salts' : 'Fix keys and salts' };
}

/** The confirmation before writing keys: the bad ones (whoever is logged in, once) or all of them (everyone). */
export function SaltsConfirm({ mode, onClose, onConfirm }: { mode: 'missing' | 'all' | null; onClose: () => void; onConfirm: (only: 'missing' | 'all') => void }) {
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title={mode === 'all' ? 'Make all keys and salts new?' : 'Write the keys WordPress does not use?'}
      description={
        mode === 'all'
          ? 'wp config shuffle-salts writes new keys and salts into wp-config.php. Every login cookie they signed stops working, so everyone is logged out of this site, you too.'
          : 'For a key that is missing, left at the placeholder or copying another, WordPress made its own and kept it in the database. Writing new ones into wp-config.php replaces those, so whoever is logged in on this site is logged out once.'
      }
    >
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => {
            if (mode) onConfirm(mode);
            onClose();
          }}
        >
          <KeyRound />
          {mode === 'all' ? 'Make all new' : 'Write them'}
        </Button>
      </div>
    </Dialog>
  );
}

/** How many of the keys its WordPress asks for wp-config.php sets usably, what is wrong with the rest, and the legacy ones. */
function SaltKeys({ salts, busy, onRun, onRemoveLegacy }: { salts: SiteSalts; busy: boolean; onRun: (only: 'missing' | 'all') => void; onRemoveLegacy: () => void }) {
  const [confirming, setConfirming] = useState<'missing' | 'all' | null>(null);
  const { bad, ok, fixLabel } = saltsSummary(salts);
  const problems = [
    salts.missing.length > 0 ? `missing ${salts.missing.join(', ')}` : null,
    salts.placeholder.length > 0 ? `still the placeholder: ${salts.placeholder.join(', ')}` : null,
    salts.duplicate.length > 0 ? `copying another key: ${salts.duplicate.join(', ')}` : null,
  ].filter(Boolean);
  return (
    <div className="grid gap-2 border-b px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">
          Keys and salts: {ok} of {salts.names.length} set
          {problems.length > 0 && <span className="block text-xs text-warning">{problems.join(' · ')}</span>}
        </span>
        {bad.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming('missing')}>{fixLabel}</Button>}
        <Button size="sm" variant="soft" disabled={busy} onClick={() => setConfirming('all')}>Make all new</Button>
      </div>
      {salts.legacy.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs text-muted-foreground">
          <span className="flex-1">
            Legacy <code className="font-mono">{salts.legacy.join(', ')}</code>: {bad.length > 0 ? 'WordPress still reads them until the keys above are fixed' : 'unused now that every key is set'}
          </span>
          {bad.length === 0 && <Button size="sm" variant="soft" disabled={busy} onClick={onRemoveLegacy}>Remove</Button>}
        </div>
      )}
      <SaltsConfirm mode={confirming} onClose={() => setConfirming(null)} onConfirm={onRun} />
    </div>
  );
}

/** Every constant wp-config.php defines, to change, add or remove one by one through wp config. */
export function ConfigTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const locals = useAsync(() => api.localConstants(), []);
  const [busy, setBusy] = useState(false);
  const run: Setter = async (name, value) => {
    setBusy(true);
    const ok = await setConstant(site, name, value);
    setBusy(false);
    if (ok) onChanged();
    return ok;
  };
  const runSalts = async (id: 'site.shuffleSalts' | 'site.removeLegacySalts', input: Record<string, unknown>, label: string) => {
    setBusy(true);
    const r = await runWithToast(id, { ...siteTarget(site), ...input }, label);
    setBusy(false);
    if (r?.ok) onChanged();
  };
  const constants = site.constants ?? [];
  const missing = (locals.data ?? []).filter((c) => constants.find((s) => s.name === c.name)?.value !== c.value);

  return (
    <div className="grid gap-4">
      {missing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Local constants</CardTitle>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge tone="warning">{missing.length === 1 ? '1 to set' : `${missing.length} to set`}</Badge>
              <ScopeLabel>this site</ScopeLabel>
            </div>
          </CardHeader>
          <div className="grid gap-3 p-5">
            <p className="text-xs text-muted-foreground">The constants every local site should have, from Settings. New installs get them.</p>
            <LocalConstants site={site} list={missing} busy={busy} onSet={(name, value) => void run(name, value)} />
          </div>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>wp-config.php</CardTitle>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">{constants.length === 1 ? '1 constant' : `${constants.length} constants`}</span>
            <ScopeLabel>this site</ScopeLabel>
          </div>
        </CardHeader>
        <p className="border-b px-5 py-3 text-xs text-muted-foreground">
          Changes go through wp config set, which changes a constant where it is, inside an if too, or adds it. Secrets stay hidden, and the database settings, keys and a network's layout are left to the install.
        </p>
        {site.salts && (
          <SaltKeys
            salts={site.salts}
            busy={busy}
            onRun={(only) => void runSalts('site.shuffleSalts', { only }, only === 'all' ? 'Keys and salts made new' : 'Keys and salts written')}
            onRemoveLegacy={() => void runSalts('site.removeLegacySalts', {}, 'Legacy keys removed')}
          />
        )}
        {constants.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">wp-config.php defines no constants the panel can read.</p>}
        <ul className="divide-y">
          {constants.map((c) => (
            <ConstantRow key={c.name} constant={c} busy={busy} onSet={run} />
          ))}
        </ul>
        <AddConstant site={site} busy={busy} onSet={run} />
      </Card>
    </div>
  );
}

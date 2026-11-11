import type { PhpInfo, PhpIniKey, PhpIniSetting } from '@devmagic-panel/shared';
import { phpIniValueError } from '@devmagic-panel/shared';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { cn } from '@/lib/utils';

/** Pieces the PHP tab of Services and a site's PHP tab share. */

/** The value a setting has when the field is left empty, and where it comes from. */
export interface Inherited {
  value: string;
  from: string;
}

/**
 * Where an empty setting's value comes from: what the panel or the files set
 * (from), else what PHP itself uses (its info), which is PHP's built-in
 * default when no file sets it.
 */
export function inheritedValue(key: string, set: string | undefined, from: string, info: PhpInfo | undefined): Inherited | undefined {
  if (set !== undefined && set !== '') return { value: set, from };
  const live = info?.ini[key]?.local;
  return live === undefined ? undefined : { value: live === '' ? 'no value' : live, from: "PHP's built-in default" };
}

/** One setting the panel manages: empty inherits, and the field says the value it then gets and from where. */
export function SettingField({ name, setting, value, inherited, own, onChange }: {
  name: PhpIniKey;
  setting: PhpIniSetting;
  value: string;
  inherited?: Inherited | undefined;
  /** The badge on a value set here: whose it is. */
  own: string;
  onChange: (v: string) => void;
}) {
  const id = `ini-${name.replace('.', '-')}`;
  const error = value ? phpIniValueError(name, value) : undefined;
  const options = setting.kind === 'flag' ? ['On', 'Off'] : setting.kind === 'choice' ? (setting.choices ?? []) : null;
  const inherit = inherited ? `Inherit: ${inherited.value} (${inherited.from})` : 'Inherit';
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
        <code className="font-mono text-dense">{name}</code>
        {value && <Badge tone="primary">{own}</Badge>}
      </label>
      {options ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} wrapClassName="w-full">
          <option value="">{inherit}</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : (
        <Input id={id} value={value} placeholder={inherit} onChange={(e) => onChange(e.target.value.trim())} aria-invalid={error ? true : undefined} className={cn(error && 'border-danger')} />
      )}
      <p className={cn('text-xs', error ? 'text-danger' : 'text-muted-foreground')}>{error ?? setting.hint}</p>
    </div>
  );
}

/** The settings of a PHP info, one table per extension, like phpinfo()'s sections. */
export function InfoTables({ info, filter, onFilter, marked }: { info: PhpInfo; filter: string; onFilter: (f: string) => void; marked?: Set<string> }) {
  const needle = filter.trim().toLowerCase();
  const grouped = new Set(Object.values(info.groups).flat());
  const sections: Array<[string, string[]]> = [
    ...Object.entries(info.groups).sort(([a], [b]) => (a === 'Core' ? -1 : b === 'Core' ? 1 : a.localeCompare(b))),
    ['Other', Object.keys(info.ini).filter((k) => !grouped.has(k)).sort()],
  ];
  const shown = sections
    .map(([name, keys]): [string, string[]] => [name, keys.filter((k) => info.ini[k] && (!needle || k.toLowerCase().includes(needle) || info.ini[k]?.local.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)))])
    .filter(([, keys]) => keys.length > 0);

  return (
    <div className="grid gap-4">
      <KeyValue
        dense
        labelWidth="md"
        rows={[
          { label: 'PHP', value: <>{info.version} <span className="text-muted-foreground">({info.sapi})</span></> },
          { label: 'Loaded php.ini', value: <span className="font-mono">{info.iniFile || 'none'}</span> },
          { label: 'Extra ini files', value: <span className="font-mono">{info.scannedFiles.length > 0 ? info.scannedFiles.map((f) => f.split('/').at(-1)).join(', ') : 'none'}</span> },
          { label: 'Extensions', value: Object.keys(info.extensions).sort((a, b) => a.localeCompare(b)).join(', ') },
          ...(info.zendExtensions.length > 0 ? [{ label: 'Zend extensions', value: info.zendExtensions.join(', ') }] : []),
        ]}
      />
      <Input aria-label="Filter settings" placeholder="Filter settings, like upload" value={filter} onChange={(e) => onFilter(e.target.value)} className="w-full sm:max-w-xs" />
      {shown.length === 0 && <p className="text-muted-foreground">No setting matches {filter}.</p>}
      {shown.map(([name, keys]) => (
        <details key={name} open={Boolean(needle) || name === 'Core'} className="group/s rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/s:rotate-90" />
            {name}
            <span className="font-normal text-muted-foreground">{keys.length}</span>
          </summary>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr><th className="px-3 py-1.5 font-medium">Directive</th><th className="px-3 py-1.5 font-medium">Value</th><th className="px-3 py-1.5 font-medium">From the ini files</th></tr>
              </thead>
              <tbody className="divide-y">
                {keys.map((k) => {
                  const v = info.ini[k] as { local: string; master: string };
                  const mark = marked?.has(k);
                  return (
                    <tr key={k} className={cn(mark && 'bg-primary/6')}>
                      <td className="px-3 py-1 font-mono">{k}{mark && <Badge tone="primary" className="ml-2">this site</Badge>}</td>
                      <td className={cn('px-3 py-1 font-mono [overflow-wrap:anywhere]', v.local !== v.master && 'text-primary')}>{v.local === '' ? <span className="text-muted-foreground">no value</span> : v.local}</td>
                      <td className="px-3 py-1 font-mono text-muted-foreground [overflow-wrap:anywhere]">{v.master === '' ? 'no value' : v.master}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}


import type { PhpVersion, PhpXdebug } from '@devmagic-panel/shared';
import { XDEBUG_MODES, XDEBUG_STARTS } from '@devmagic-panel/shared';
import { Bug } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { KeyValue } from '@/components/ui/key-value';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { ReadingBlock } from '@/components/layout/skeletons';
import { Spinner } from '@/components/ui/spinner';
import { type Mode, Section, errorBox } from './php-shared';

export const START_LABEL: Record<(typeof XDEBUG_STARTS)[number], string> = {
  trigger: 'When asked',
  yes: 'On every request',
};

export const START_HINT: Record<(typeof XDEBUG_STARTS)[number], ReactNode> = {
  trigger: <>When the Xdebug browser extension, or an <code className="font-mono">XDEBUG_TRIGGER</code> cookie, query parameter or variable, asks for it. Other requests stay fast.</>,
  yes: 'Xdebug starts for every request, which makes each one slower.',
};

export const MODE_HINT: Record<Mode, string> = {
  debug: 'Step debugging in your IDE',
  develop: 'Better error pages and var_dump',
  profile: 'Cachegrind files for profiling',
  trace: 'A trace file of every call',
  gcstats: "Garbage collection runs, to the panel's profiles folder",
  coverage: 'Code coverage for tests',
};

export function XdebugCard({ version, busy, applying, onApply }: {
  version: PhpVersion;
  busy: boolean;
  applying: boolean;
  onApply: (input: Record<string, unknown>, label: string) => void;
}) {
  const xdebug: PhpXdebug = version.xdebug;
  const known = XDEBUG_MODES.filter((m) => xdebug.modes?.includes(m));
  const knownModes = known.length > 0 ? known.join(',') : 'debug';
  const knownStart = XDEBUG_STARTS.find((s) => s === xdebug.startWithRequest) ?? 'trigger';
  const [modes, setModes] = useState<Mode[]>(knownModes.split(',') as Mode[]);
  const [start, setStart] = useState<(typeof XDEBUG_STARTS)[number]>(knownStart);
  useEffect(() => {
    setModes(knownModes.split(',') as Mode[]);
    setStart(knownStart);
  }, [knownModes, knownStart]);
  const chosen = XDEBUG_MODES.filter((m) => modes.includes(m));
  const changed = xdebug.enabled && chosen.length > 0 && (chosen.join(',') !== knownModes || start !== knownStart);
  const toggle = (m: Mode, on: boolean) => setModes((list) => (on ? [...list, m] : list.filter((x) => x !== m)));
  const reason = xdebug.reason;
  const applies = version.apache ? 'Switching restarts Apache.' : 'Switching reloads its PHP-FPM.';

  return (
    <Card>
      <CardHeader title="Xdebug" meta={xdebug.installed ? <Badge tone={xdebug.enabled ? 'success' : 'neutral'}>{xdebug.enabled ? 'on' : 'off'}</Badge> : <Bug className="size-4 text-muted-foreground" />} />
      <CardBody>
        {reason ? (
          <p className="text-muted-foreground">{reason}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Xdebug for PHP {version.version} on the web</p>
                <p className="text-xs text-muted-foreground">Your IDE listens on port 9003. Each version has its own Xdebug; the command line keeps its own setting. {applies}</p>
              </div>
              <span className="flex items-center gap-2">
                {applying && <Spinner className="size-4 text-muted-foreground" />}
                <Switch
                  checked={xdebug.enabled}
                  label="Xdebug"
                  disabled={busy}
                  onChange={(on) => onApply({ enabled: on, modes: chosen.length > 0 ? chosen : ['debug'], startWithRequest: start }, on ? 'Xdebug on' : 'Xdebug off')}
                />
              </span>
            </div>
            <fieldset className="grid gap-2" disabled={busy}>
              <legend className="mb-1 text-sm font-medium">Modes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {XDEBUG_MODES.map((m) => (
                  <Checkbox key={m} id={`xdebug-${m}`} checked={modes.includes(m)} onChange={(on) => toggle(m, on)} label={<code className="font-mono text-dense">{m}</code>} hint={MODE_HINT[m]} />
                ))}
              </div>
              {chosen.length === 0 && <p className="text-xs text-danger">Pick at least one mode.</p>}
            </fieldset>
            <Field label="Start" htmlFor="xdebug-start" hint={START_HINT[start]}>
              <Select id="xdebug-start" value={start} onChange={(e) => setStart(e.target.value as typeof start)} disabled={busy} wrapClassName="w-full sm:max-w-60">
                {XDEBUG_STARTS.map((s) => <option key={s} value={s}>{START_LABEL[s]}</option>)}
              </Select>
            </Field>
            {changed && (
              <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => onApply({ enabled: true, modes: chosen, startWithRequest: start }, 'Xdebug settings applied')}>
                {version.apache ? 'Apply and restart Apache' : 'Apply and reload PHP-FPM'}
              </Button>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** xdebug_info() for one version on the web: its release, the modes in effect and every Xdebug setting. */
export function XdebugInfoSection({ version }: { version: PhpVersion }) {
  return (
    <Section title="Xdebug info" icon={<Bug className="size-4 text-muted-foreground" />} hint={`What xdebug_info() shows for PHP ${version.version} on the web. Each version has its own Xdebug and settings.`}>
      {() => <XdebugInfoView version={version} />}
    </Section>
  );
}

export function XdebugInfoView({ version }: { version: PhpVersion }) {
  const { data, error, loading } = useAsync(() => (version.xdebug.installed ? api.phpInfo(version.version, 'web') : Promise.resolve(undefined)), [version.version]);
  if (!version.xdebug.installed) return <p className="text-muted-foreground">{version.xdebug.reason}</p>;
  if (loading && !data) return <ReadingBlock lines={6}>Asking PHP...</ReadingBlock>;
  if (error) return errorBox(error);
  if (!data) return null;
  if (!data.xdebug) return <p className="text-muted-foreground">Xdebug is installed for PHP {version.version} but not loaded on the web: turn it on in the Xdebug card.</p>;
  const keys = (data.groups.xdebug ?? Object.keys(data.ini).filter((k) => k.startsWith('xdebug.'))).sort();
  const features = ['develop', 'coverage', 'debug', 'gcstats', 'profile', 'trace'];
  return (
    <div className="grid gap-4">
      <KeyValue
        dense
        labelWidth="md"
        rows={[
          { label: 'Xdebug', value: data.xdebug.version },
          { label: 'Modes in effect', value: data.xdebug.modes.length > 0 ? data.xdebug.modes.join(', ') : 'off' },
        ]}
      />
      <ul className="grid gap-1 text-xs sm:grid-cols-3">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span aria-hidden className={cn('size-2 rounded-full', data.xdebug?.modes.includes(f) ? 'bg-success' : 'bg-muted-foreground/30')} />
            <code className="font-mono">{f}</code>
            <span className="text-muted-foreground">{data.xdebug?.modes.includes(f) ? 'on' : 'off'}</span>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-3 py-1.5 font-medium">Setting</th><th className="px-3 py-1.5 font-medium">Value</th></tr></thead>
          <tbody className="divide-y">
            {keys.map((k) => (
              <tr key={k}><td className="px-3 py-1 font-mono">{k}</td><td className="px-3 py-1 font-mono [overflow-wrap:anywhere]">{data.ini[k]?.local || <span className="text-muted-foreground">no value</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

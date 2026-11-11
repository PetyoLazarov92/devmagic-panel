import { Fold } from '@/components/ui/fold';
import type { PhpIniDiff, PhpIniKey, PhpSettings, PhpVersion } from '@devmagic-panel/shared';
import { PHP_INI_KEYS, PHP_INI_SETTINGS, phpIniValueError } from '@devmagic-panel/shared';
import { FileDiff, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/features/jobs/job-box';
import { settled, useJob } from '@/features/jobs/job-steps';
import { inheritedValue, SettingField } from '@/features/services/php-bits';
import { SaveBar } from '@/components/layout/save-bar';
import { ScopeLabel } from '@/components/layout/scope-label';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { runRestarting } from '@/lib/restarting';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { ReadingBlock } from '@/components/layout/skeletons';
import { SAPI_LABEL, errorBox } from './php-shared';
import { SapiPicker } from './php-info';

/**
 * What each part's php.ini changes from the one its package ships, and the
 * extra ini files it loads, with the job that moves the changes into the
 * panel's settings and puts the packaged php.ini back.
 */
export function IniChangesCard({ version, onMoved }: { version: string; onMoved: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.phpIni(version), [version]);
  const runner = useJob();
  const done = useRef<string | null>(null);
  const changed = (data?.sapis ?? []).some((d) => d.changes.length > 0);
  const busy = runner.job !== null && !settled(runner.job);
  const { job } = runner;
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    reload();
    onMoved();
    if (job.status === 'done') toast({ tone: 'success', title: `PHP ${version}: php.ini changes moved into the panel's settings` });
  }, [job, reload, onMoved, version]);

  return (
    <Card className="lg:col-span-2">
      <CardHeader title="php.ini changes" meta={<FileDiff className="size-4 text-muted-foreground" />} />
      <CardBody className="gap-5">
        {loading && !data && <ReadingBlock lines={5}>Comparing with the packaged php.ini...</ReadingBlock>}
        {error && errorBox(error)}
        {data?.sapis.length === 0 && <p className="text-muted-foreground">PHP {version} has no php.ini to compare.</p>}
        {data?.sapis.map((d) => <IniDiff key={d.sapi} diff={d} />)}
        {(changed || job) && (
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-4">
            {changed && !job && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-[1_1_20rem] text-xs text-muted-foreground">
                  Move these into the panel&apos;s settings for PHP {version}, then put the packaged php.ini back: nothing changes for your sites, PHP updates stop asking about a changed php.ini, and PHP-FPM gets the same values. Undo on the job puts it all back.
                </p>
                <Button variant="outline" disabled={busy} onClick={() => void runner.follow(api.startJob('php.adoptIni', { version }))}>
                  <Settings2 />
                  Move into the panel&apos;s settings
                </Button>
              </div>
            )}
            {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
            {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export const GROUPS = ['Limits', 'Errors', 'OPcache', 'Other'] as const;

/**
 * The panel's own settings for a version: one form for the web (every site
 * on it, Apache's mod_php and PHP-FPM together) and one for the command line.
 * An empty field leaves the setting to php.ini, whose value shows as the hint.
 */
export function SettingsCard({ version }: { version: PhpVersion }) {
  const { data, error, loading, reload } = useAsync(() => api.phpSettings(version.version), [version.version]);
  const [scope, setScope] = useState<'web' | 'cli'>('web');
  const current = data?.scopes.find((x) => x.scope === scope) ?? data?.scopes[0];
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Settings" meta={<ScopeLabel>{`PHP ${version.version}`}</ScopeLabel>} />
      <CardBody>
        {loading && !data && <ReadingBlock fields={4}>Reading the settings...</ReadingBlock>}
        {error && errorBox(error)}
        {data && data.scopes.length === 0 && <p className="text-muted-foreground">PHP {version.version} has no part to set.</p>}
        {data && current && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-[1_1_20rem] text-xs text-muted-foreground">
                {current.scope === 'web'
                  ? `For every site on PHP ${version.version}, in the panel's own 99-devmagic-panel.ini (php.ini is never changed). A site can override some of them on its Server and PHP tab.`
                  : `For WP-CLI, Composer and anything you run with php${version.version}, in the command line's own 99-devmagic-panel.ini.`}{' '}
                An empty field inherits: it shows the value PHP then uses and where it comes from.
              </p>
              {data.scopes.length > 1 && <SapiPicker value={current.scope} onChange={setScope} cli />}
            </div>
            <SettingsForm key={`${version.version}-${current.scope}`} version={version} settings={current} onSaved={reload} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** How many settings a form changes against what is saved. */
export function changedCount(values: Partial<Record<string, string>>, saved: Partial<Record<string, string>>): number {
  return PHP_INI_KEYS.filter((k) => (values[k] || undefined) !== (saved[k] || undefined)).length;
}

export function SettingsForm({ version, settings, onSaved }: { version: PhpVersion; settings: PhpSettings['scopes'][number]; onSaved: () => void }) {
  const [values, setValues] = useState<Partial<Record<PhpIniKey, string>>>(settings.panel);
  const [saving, setSaving] = useState(false);
  // What PHP itself uses for a setting no file sets: its built-in default.
  const info = useAsync(() => api.phpInfo(version.version, settings.scope === 'web' ? 'web' : 'cli').catch(() => undefined), [version.version, settings.scope]);
  const error = PHP_INI_KEYS.map((k) => (values[k] ? phpIniValueError(k, values[k] as string) : undefined)).find(Boolean);
  const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ''));
  const changes = changedCount(values, settings.panel);
  const set = (key: PhpIniKey, value: string) => setValues((v) => ({ ...v, [key]: value }));

  async function save() {
    setSaving(true);
    await runRestarting('php.setIni', { version: version.version, scope: settings.scope, values: cleaned }, `PHP ${version.version} ${settings.scope === 'web' ? 'web' : 'command line'} settings saved`, onSaved);
    setSaving(false);
  }

  return (
    <div className="grid gap-3">
      {GROUPS.map((group) => {
        const keys = PHP_INI_KEYS.filter((k) => PHP_INI_SETTINGS[k].group === group);
        const own = keys.filter((k) => settings.panel[k]).length;
        // Limits, and every group with a value set here, start open; the rest fold, so the card fits the window.
        return (
          <Fold key={group} title={group} note={own > 0 ? `${own} set here` : `${keys.length} settings`} defaultOpen={group === 'Limits' || own > 0}>
            <fieldset aria-label={group} className="grid gap-x-6 gap-y-3 sm:grid-cols-2" disabled={saving}>
              {keys.map((key) => (
                <SettingField key={key} name={key} setting={PHP_INI_SETTINGS[key]} value={values[key] ?? ''} own="set here" inherited={inheritedValue(key, settings.files[key], 'php.ini', info.data)} onChange={(v) => set(key, v)} />
              ))}
            </fieldset>
          </Fold>
        );
      })}
      <SaveBar
        changes={changes}
        saving={saving}
        error={error}
        label={settings.scope === 'web' ? (version.apache ? 'Save and restart Apache' : 'Save and reload PHP-FPM') : 'Save'}
        note={settings.scope === 'web' ? `For every site on PHP ${version.version}` : `For php${version.version} on the command line`}
        onSave={() => void save()}
        onDiscard={() => setValues(settings.panel)}
      />
    </div>
  );
}

export function IniDiff({ diff }: { diff: PhpIniDiff }) {
  return (
    <section className="grid gap-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 font-medium">
        {SAPI_LABEL[diff.sapi]}
        <code className="font-mono text-xs font-normal text-muted-foreground">{diff.file}</code>
      </h3>
      {!diff.original ? (
        <p className="text-xs text-muted-foreground">The packaged php.ini is missing, so there is nothing to compare with.</p>
      ) : diff.changes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Same as the packaged php.ini.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr><th className="px-3 py-2 font-medium">Setting</th><th className="px-3 py-2 font-medium">Packaged</th><th className="px-3 py-2 font-medium">Yours</th></tr>
            </thead>
            <tbody className="divide-y">
              {diff.changes.map((c) => (
                <tr key={c.key}>
                  <td className="px-3 py-1.5 font-mono">{c.key}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{c.original ?? <em className="not-italic">not set</em>}</td>
                  <td className="px-3 py-1.5 font-mono">{c.current ?? <em className="not-italic text-muted-foreground">removed</em>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff.extraFiles.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also loads{' '}
          {diff.extraFiles.map((f, i) => (
            <span key={f.name}>
              {i > 0 && ', '}
              <code className="font-mono">{f.name}</code>
              {f.panel ? ' (the panel\'s)' : ''}
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}

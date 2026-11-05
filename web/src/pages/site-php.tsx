import type { PhpIniKey, Site, SitePhp } from '@devmagic-panel/shared';
import { PHP_INI_KEYS, PHP_INI_SETTINGS, phpIniValueError } from '@devmagic-panel/shared';
import { ChevronRight, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { InfoTables, inheritedValue, SettingField } from '@/components/php-bits';
import { SaveBar } from '@/components/save-bar';
import { ScopeLabel } from '@/components/scope-label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { siteName, siteTarget } from '@/lib/site-ref';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { changedCount } from '@/pages/services-php';
import { type CompatAsk, CompatCard, CompatHint, useSiteCompat } from '@/pages/site-compat';

const errorBox = (text: string) => <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{text}</p>;
const older = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) < 0;
const GROUPS = ['Limits', 'Errors', 'OPcache', 'Other'] as const;

/**
 * A site's PHP tab: one card for its PHP (the version and the settings of its
 * own, both through its own PHP-FPM pool), applied through the save bar with
 * the job under the card, and PHP info from the PHP that serves it.
 */
export function PhpTab({ site }: { site: Site }) {
  const target = siteTarget(site);
  const php = useAsync(() => api.sitePhp(target.domain, target.path), [site.domain, site.path]);
  // Above the form, which starts over with what the job left: its steps and Undo stay in view.
  const runner = useJob();
  if (php.loading && !php.data) return <div className="h-64 animate-pulse rounded-xl border bg-card" />;
  if (php.error) return errorBox(php.error);
  if (!php.data) return null;
  return <PhpForm key={JSON.stringify(php.data)} site={site} php={php.data} runner={runner} onChanged={php.reload} />;
}

function PhpForm({ site, php, runner, onChanged }: { site: Site; php: SitePhp; runner: ReturnType<typeof useJob>; onChanged: () => void }) {
  const target = siteTarget(site);
  const [version, setVersion] = useState(php.version ?? '');
  const [values, setValues] = useState<Partial<Record<PhpIniKey, string>>>(php.values);
  const done = useRef<string | null>(runner.job && settled(runner.job) ? runner.job.id : null);
  const { job } = runner;
  const busy = job !== null && !settled(job);
  const effective = version || php.defaultVersion;
  // What a setting left empty gets: the version's own settings, its php.ini, else PHP's built-in default.
  const base = useAsync(() => (effective ? api.phpSettings(effective) : Promise.resolve(undefined)), [effective]);
  const info = useAsync(() => (effective ? api.phpInfo(effective, 'web').catch(() => undefined) : Promise.resolve(undefined)), [effective]);
  const web = base.data?.scopes.find((x) => x.scope === 'web');
  const report = useAsync(() => api.php(), []);
  const modules = report.data?.versions.find((x) => x.version === effective)?.modules.filter((m) => m.fpm ?? m.apache2).map((m) => m.name) ?? [];
  const noFpm = report.data?.versions.filter((x) => !x.sapis.includes('fpm') && x.version !== php.defaultVersion).map((x) => x.version) ?? [];
  // The last compatibility scan of the version picked, shared with the card below.
  const compat = useSiteCompat(site);
  const [ask, setAsk] = useState<CompatAsk | null>(null);
  const runsNow = php.version ?? php.defaultVersion;
  const picked = effective && effective !== runsNow ? effective : undefined;
  const pickedScan = picked ? compat.data?.scans.find((s) => s.version === picked) : undefined;

  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    if (job.status === 'done') toast({ tone: 'success', title: `${siteName(site)}: PHP updated` });
    onChanged();
  }, [job, onChanged, site]);

  const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== '')) as Partial<Record<PhpIniKey, string>>;
  const changes = (version !== (php.version ?? '') ? 1 : 0) + changedCount(values, php.values);
  const error = PHP_INI_KEYS.map((k) => (cleaned[k] ? phpIniValueError(k, cleaned[k] as string) : undefined)).find(Boolean);
  const tooOld = php.requires && effective && older(effective, php.requires.version);
  const own = Object.keys(cleaned).length;
  const ownPool = Boolean(version) || own > 0;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader><CardTitle>PHP for this site</CardTitle><ScopeLabel>this site</ScopeLabel></CardHeader>
        <div className="grid gap-5 p-5 text-sm">
          {php.refused ? (
            <p className="text-muted-foreground">{php.refused}</p>
          ) : (
            <>
              <div className="grid gap-2">
                <label htmlFor="site-php-version" className="font-medium">Version</label>
                <Select id="site-php-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy} wrapClassName="w-full sm:max-w-sm">
                  <option value="">{php.defaultVersion ? `PHP ${php.defaultVersion} (default)` : 'The default'}</option>
                  {php.choices.map((v) => <option key={v} value={v}>{`PHP ${v} (own)`}</option>)}
                </Select>
                <p className="text-xs text-muted-foreground">
                  The default is the PHP every site without its own runs, set on the PHP tab of Services; own gives the site its own PHP-FPM pool on that version. {php.version ? `Now: its own PHP ${php.version}.` : 'Now: the default.'} WP-CLI the panel runs for it uses the same version.
                </p>
                {noFpm.length > 0 && php.choices.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Not listed: PHP {noFpm.join(', ')}, which {noFpm.length === 1 ? 'has' : 'have'} no PHP-FPM. Install it on the <Link href={`/services/php/${noFpm[0]}`} className="font-medium text-foreground hover:underline">PHP tab</Link> first.
                  </p>
                )}
                {php.choices.length === 0 && (
                  <p className="text-xs text-muted-foreground">No version has PHP-FPM yet, so the site cannot have its own PHP: install PHP-FPM with <code className="font-mono">./install.sh</code> or on the <Link href="/services/php" className="font-medium text-foreground hover:underline">PHP tab</Link>.</p>
                )}
                {picked && <CompatHint compat={compat.data} version={picked} onAsk={(a) => setAsk((x) => ({ ...a, n: (x?.n ?? 0) + 1 }))} />}
                {php.requires && (
                  <p className={tooOld ? 'flex gap-2 text-xs text-warning' : 'text-xs text-muted-foreground'}>
                    {tooOld && <TriangleAlert className="size-4 shrink-0" />}
                    <span>Its code asks for PHP {php.requires.version} or newer ({php.requires.sources.join(', ')}).{tooOld ? ` PHP ${effective} is older: the site may break.` : ''}</span>
                  </p>
                )}
              </div>

              <details className="group/own rounded-lg border" open={own > 0}>
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-open/own:rotate-90" />
                  <span className="font-medium">Settings of its own</span>
                  <Badge tone={own > 0 ? 'primary' : 'neutral'}>{own > 0 ? `${own} set` : 'none'}</Badge>
                </summary>
                <div className="grid gap-5 border-t px-4 py-4">
                  <p className="text-xs text-muted-foreground">
                    An empty field inherits PHP {effective ?? ''}&apos;s value, shown with where it comes from; change those for every site on the <Link href={`/services/php/${effective ?? ''}/settings`} className="font-medium text-foreground hover:underline">PHP tab</Link>. A value here gives the site its own PHP, on the version above.
                  </p>
                  {GROUPS.map((group) => (
                    <fieldset key={group} className="grid gap-x-6 gap-y-3 sm:grid-cols-2" disabled={busy}>
                      <legend className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</legend>
                      {PHP_INI_KEYS.filter((k) => PHP_INI_SETTINGS[k].group === group).map((key) => (
                        <SettingField
                          key={key}
                          name={key}
                          setting={PHP_INI_SETTINGS[key]}
                          value={values[key] ?? ''}
                          own="this site's"
                          inherited={web?.panel[key] ? { value: web.panel[key] as string, from: `PHP ${effective} settings` } : inheritedValue(key, web?.files[key], 'php.ini', info.data)}
                          onChange={(v) => setValues((x) => ({ ...x, [key]: v }))}
                        />
                      ))}
                    </fieldset>
                  ))}
                </div>
              </details>

              <p className="text-xs text-muted-foreground">
                Modules belong to the version, so the site has PHP {effective ?? ''}&apos;s: <span className="font-mono [overflow-wrap:anywhere]">{report.loading && !report.data ? '...' : modules.join(', ') || 'none found'}</span>. <Link href={`/services/php/${effective ?? ''}/modules`} className="font-medium text-foreground hover:underline">Switch them</Link> for every site on it.
              </p>
            </>
          )}
        </div>
        {(job || runner.error) && (
          <div className="grid gap-3 border-t px-5 py-4 text-sm">
            {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
            {runner.error && errorBox(runner.error)}
          </div>
        )}
      </Card>

      {!php.refused && (
        <SaveBar
          changes={busy ? 0 : changes}
          saving={false}
          error={error}
          label="Apply"
          note={ownPool ? `The site gets its own PHP: PHP ${effective}${own ? ` with ${Object.keys(cleaned).join(', ')}` : ''}. The panel checks it answers, opens the home page and wp-admin and reads its logs for new PHP errors; Undo on the job puts it back.${pickedScan?.errors ? ` The last check of its code found ${pickedScan.errors} error${pickedScan.errors === 1 ? '' : 's'} on PHP ${picked}.` : ''}` : `The site goes back to the default and its own PHP goes.${pickedScan?.errors ? ` The last check of its code found ${pickedScan.errors} error${pickedScan.errors === 1 ? '' : 's'} on PHP ${picked}.` : ''}`}
          onSave={() => void runner.follow(api.startJob('site.setPhp', { ...target, version: version || null, values: cleaned }))}
          onDiscard={() => {
            setVersion(php.version ?? '');
            setValues(php.values);
          }}
        />
      )}

      <CompatCard site={site} current={runsNow} compat={compat} ask={ask} />

      <SiteInfo site={site} marked={new Set(Object.keys(php.values))} />
    </div>
  );
}

/** phpinfo() from the PHP that serves the site, with the settings it sets itself marked. */
function SiteInfo({ site, marked }: { site: Site; marked: Set<string> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group rounded-xl border bg-card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">PHP info</span>
          <span className="block text-xs text-muted-foreground">What phpinfo() shows for this site, asked from the PHP that serves it when opened.</span>
        </span>
        <Info className="size-4 text-muted-foreground" />
      </summary>
      {open && <div className="border-t px-5 py-4 text-sm"><SiteInfoView site={site} marked={marked} /></div>}
    </details>
  );
}

function SiteInfoView({ site, marked }: { site: Site; marked: Set<string> }) {
  const target = siteTarget(site);
  const { data, error, loading } = useAsync(() => api.sitePhpInfo(target.domain, target.path), [site.domain, site.path]);
  const [filter, setFilter] = useState('');
  if (loading && !data) return <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Asking PHP...</p>;
  if (error) return errorBox(error);
  if (!data) return null;
  return <InfoTables info={data} filter={filter} onFilter={setFilter} marked={marked} />;
}

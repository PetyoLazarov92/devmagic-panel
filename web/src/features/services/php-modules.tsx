import type { PhpVersion } from '@devmagic-panel/shared';
import { ChevronRight, Puzzle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { errorBox } from './php-shared';

/** What the common modules are for, in a few words. */
export const MODULE_HINT: Record<string, string> = {
  bcmath: 'Arbitrary precision math',
  curl: 'HTTP requests to other servers',
  exif: 'Photo metadata, like orientation',
  gd: 'Image resizing (GD)',
  imagick: 'Image resizing (ImageMagick)',
  intl: 'Locale-aware dates, numbers and sorting',
  mbstring: 'Multibyte (UTF-8) strings',
  mysqli: 'MySQL, as WordPress uses it',
  opcache: 'Caches compiled PHP: much faster pages',
  redis: 'Redis object cache',
  soap: 'SOAP web services',
  sockets: 'Low-level network sockets',
  xml: 'XML, as WordPress uses it',
  zip: 'Zip files: plugin and theme uploads',
};

/**
 * The modules installed for one version, each with a switch that turns it
 * on or off for every part of that version together. Modules WordPress needs
 * stay on.
 */
export function PhpModulesCard({ version, busy, aptBusy, onSwitch, onPackage }: {
  version: PhpVersion;
  busy: string | null;
  aptBusy: boolean;
  onSwitch: (module: string, enabled: boolean) => void;
  onPackage: (name: string, how: 'install' | 'remove') => void;
}) {
  const [filter, setFilter] = useState('');
  // A version with only the command line shows its modules there.
  const web = (m: PhpVersion['modules'][number]) => m.apache2 ?? m.fpm ?? m.cli ?? false;
  const hasWeb = version.sapis.includes('apache2') || version.sapis.includes('fpm');
  const modules = version.modules.filter((m) => m.name.includes(filter.trim().toLowerCase()));
  const on = version.modules.filter(web).length;

  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Modules" meta={version.modules.length > 0 ? <span className="text-xs text-muted-foreground">{on} of {version.modules.length} on</span> : <Puzzle className="size-4 text-muted-foreground" />} />
      <CardBody>
        {version.modules.length === 0 ? (
          <p className="text-muted-foreground">No modules found for PHP {version.version}.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="min-w-0 flex-[1_1_20rem] text-xs text-muted-foreground">
                Modules belong to the version: every site on PHP {version.version} gets the same ones.{' '}
                {hasWeb
                  ? `A switch turns one on or off for the web and the command line (WP-CLI) together, then ${version.apache ? 'restarts Apache' : 'reloads PHP-FPM'}.`
                  : `PHP ${version.version} has only the command line, so a switch is for WP-CLI and scripts on it.`}{' '}
                More modules are below, from apt.
              </p>
              <Input aria-label="Filter modules" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full sm:w-48" />
            </div>
            {modules.length === 0 ? (
              <p className="text-muted-foreground">No module matches {filter}.</p>
            ) : (
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
                {modules.map((m) => {
                  const key = `module:${m.name}`;
                  const isOn = web(m);
                  const differs = m.cli !== undefined && m.cli !== isOn;
                  const locked = m.required && isOn;
                  // Its package went and left the ini: it can go off, and comes back on once installed.
                  const gone = m.missing === true;
                  return (
                    <li key={m.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono text-dense">{m.name}</code>
                          {m.required && <Badge tone="neutral">WordPress needs it</Badge>}
                        </p>
                        {gone ? (
                          <p className="flex flex-wrap items-center gap-x-2 text-xs text-warning">
                            <span>Package not installed{isOn ? ': PHP warns on every start' : ''}</span>
                            <Button size="xs" variant="soft" disabled={aptBusy} onClick={() => onPackage(m.name, 'install')} className="text-foreground">
                              Install php{version.version}-{m.name}
                            </Button>
                          </p>
                        ) : (differs || MODULE_HINT[m.name]) && (
                          <p className={cn('truncate text-xs', differs ? 'text-warning' : 'text-muted-foreground')}>
                            {differs ? (isOn ? 'On for the web only, off for the command line' : 'On for the command line only, off for the web') : MODULE_HINT[m.name]}
                          </p>
                        )}
                      </div>
                      <span className="flex shrink-0 items-center gap-2">
                        {busy === key && <Spinner className="size-4 text-muted-foreground" />}
                        <Switch
                          checked={isOn}
                          label={locked ? `${m.name} (WordPress needs it, stays on)` : m.name}
                          disabled={busy !== null || locked || (gone && !isOn)}
                          onChange={(enabled) => onSwitch(m.name, enabled)}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <PackagesSection version={version.version} busy={aptBusy} onPackage={onPackage} />
      </CardBody>
    </Card>
  );
}

/** The version's module packages apt has: install one, or remove one the version can do without. */
export function PackagesSection({ version, busy, onPackage }: { version: string; busy: boolean; onPackage: (name: string, how: 'install' | 'remove') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group/p rounded-lg border" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/p:rotate-90" />
        More modules from apt for PHP {version}
      </summary>
      {open && <PackagesList version={version} busy={busy} onPackage={onPackage} />}
    </details>
  );
}

export const CORE_PACKAGES = new Set(['common', 'cli', 'fpm', 'mysql', 'xml']);

export function PackagesList({ version, busy, onPackage }: { version: string; busy: boolean; onPackage: (name: string, how: 'install' | 'remove') => void }) {
  const { data, error, loading } = useAsync(() => api.phpPackages(version), [version, busy]);
  const [filter, setFilter] = useState('');
  if (loading && !data) return <p className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />Asking apt...</p>;
  if (error) return <div className="border-t p-3">{errorBox(error)}</div>;
  if (!data) return null;
  const shown = data.filter((p) => p.name.includes(filter.trim().toLowerCase()));
  return (
    <div className="grid gap-3 border-t p-3">
      <Input aria-label="Filter packages" placeholder="Filter, like redis" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full sm:max-w-xs" />
      <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => (
          <li key={p.name} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/50">
            <code className="font-mono">php{version}-{p.name}</code>
            {p.installed ? (
              CORE_PACKAGES.has(p.name) ? <span className="text-muted-foreground">needed</span> : (
                <Button size="sm" variant="soft" disabled={busy} onClick={() => onPackage(p.name, 'remove')}>Remove</Button>
              )
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onPackage(p.name, 'install')}>Install</Button>
            )}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="text-xs text-muted-foreground">No package matches {filter}.</p>}
    </div>
  );
}

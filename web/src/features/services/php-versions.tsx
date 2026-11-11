import type { PhpReport, PhpVersion } from '@devmagic-panel/shared';
import { Check, Copy, Download, Plus, RefreshCw, Server, SquareTerminal, Star, Trash2 } from 'lucide-react';
import { type ReactNode, type RefObject, useState } from 'react';
import { ScopeLabel } from '@/components/layout/scope-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { Notice } from '@/components/layout/page';
import { scrollToCard } from '@/lib/scroll-to';
import { Spinner } from '@/components/ui/spinner';
import { PHP_SECTIONS, type PhpSection, SAPI_LABEL, sectionId } from './php-shared';
import { FpmCheckSection } from './php-info';

export const SECTION_LABEL: Record<PhpSection, string> = { settings: 'Settings', modules: 'Modules', sites: 'Sites', xdebug: 'Xdebug', ini: 'php.ini', info: 'Info' };

/** Which sites a version serves, in words. */
export function sitesOf(v: PhpVersion, report: PhpReport): string {
  const own = v.sites.length > 0 ? `${v.sites.length} with their own PHP` : '';
  const rest = v.version === report.defaultVersion ? 'every site without its own PHP' : '';
  return [rest, own].filter(Boolean).join(', and ') || 'no site';
}

/** A version's sites, short, for its tile. */
export function tileSites(v: PhpVersion, report: PhpReport): string {
  if (v.version === report.defaultVersion) return v.sites.length ? `every site, ${v.sites.length} own` : 'every site';
  if (!v.sapis.includes('fpm') && !v.sapis.includes('apache2')) return 'command line only';
  return v.sites.length ? `${v.sites.length} site${v.sites.length === 1 ? '' : 's'}, own PHP` : 'no site yet';
}

/**
 * PHP on this machine, for every site: the default and how it runs (with the
 * switch to PHP-FPM and back), a tile per installed version (picking one
 * shows it below) with Add a version as the last tile, and the check before
 * sites move to PHP-FPM. Jobs started here show under it.
 */
export function MachineCard({ report, picked, busy, cliBusy, tilesRef, onPick, onStart, onCli, children }: {
  report: PhpReport;
  picked: string;
  busy: boolean;
  cliBusy: boolean;
  tilesRef: RefObject<HTMLDivElement | null>;
  onPick: (version: string) => void;
  onStart: (id: 'php.install' | 'php.switchToFpm' | 'php.switchToModPhp', input: Record<string, unknown>) => void;
  onCli: (version: string) => void;
  children?: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const how = report.mode === 'fpm' ? 'through PHP-FPM; mod_php is off' : report.mode === 'mod_php' ? "through Apache's mod_php" : '';
  const canAdd = report.available.length > 0 || !report.sources.php;
  return (
    <Card>
      <CardHeader title="PHP on this machine" meta={<ScopeLabel>all sites</ScopeLabel>} />
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-[1_1_22rem]">
            {report.defaultVersion ? <>Sites without their own PHP run on <strong className="font-medium">PHP {report.defaultVersion}</strong> {how}.</> : 'Apache runs no PHP for sites without their own.'}
            {report.mode === 'mod_php' && ' A site with its own PHP runs on PHP-FPM.'}
          </p>
          <ModeSwitch report={report} busy={busy} onSwitch={(id, version) => onStart(id, { version })} />
        </div>
        <CliMismatch report={report} busy={busy || cliBusy} onCli={onCli} />

        <div ref={tilesRef} className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]" role="radiogroup" aria-label="PHP version">
          {report.versions.map((v) => {
            const on = v.version === picked;
            return (
              <button
                key={v.version}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(v.version)}
                className={cn('grid gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors', on ? 'border-primary bg-primary/8 ring-1 ring-primary/40' : 'bg-card hover:bg-muted/60')}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('text-base font-semibold', on && 'text-primary')}>PHP {v.version}</span>
                  {v.version === report.defaultVersion && <Badge tone="primary">default</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {v.patch ?? 'unknown'}
                  {' · '}
                  {v.update ? <span className="text-warning">{v.update} available</span> : 'up to date'}
                </span>
                <span className="text-xs text-muted-foreground">{tileSites(v, report)}</span>
              </button>
            );
          })}
          {canAdd && (
            <button
              type="button"
              aria-expanded={adding}
              onClick={() => setAdding((x) => !x)}
              className={cn('flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground', adding && 'border-primary text-foreground')}
            >
              <Plus className="size-4" />
              Add a version
            </button>
          )}
        </div>
        {adding && <AddVersion report={report} busy={busy} onInstall={(version) => onStart('php.install', { version })} />}
        {report.mode !== 'fpm' && <FpmCheckSection />}
      </CardBody>
      {children}
    </Card>
  );
}

/**
 * When php on the command line is another version than sites run on the web:
 * WP-CLI and Composer in a terminal (and the panel's WP-CLI for sites without
 * their own PHP) run on it. apt points it at the newest version it installs.
 */
export function CliMismatch({ report, busy, onCli }: { report: PhpReport; busy: boolean; onCli: (version: string) => void }) {
  const cli = report.versions.find((x) => x.cli);
  const web = report.versions.find((x) => x.version === report.defaultVersion);
  if (!cli || !web || cli.version === web.version || !web.sapis.includes('cli')) return null;
  const noMysqli = !cli.modules.some((m) => m.name === 'mysqli' && m.cli);
  return (
    <Notice
      tone="warning"
      size="inline"
      action={
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onCli(web.version)}>
          {busy ? <Spinner /> : <SquareTerminal />}Use PHP {web.version} for the command line
        </Button>
      }
    >
      php on the command line is PHP {cli.version}, while sites run on PHP {web.version}: WP-CLI and Composer run on PHP {cli.version}
      {noMysqli ? `, which has no mysqli, so WP-CLI cannot reach a database` : ''}. apt points php at the newest version it installs.
    </Notice>
  );
}

/** The picked version: its release, parts and sites, with Update and, when nothing uses it, Remove. */
export function VersionHeader({ report, version: v, busy, onUpgrade, onRemove, onInstallFpm, onCli, onMakeDefault }: {
  report: PhpReport;
  version: PhpVersion;
  busy: boolean;
  onUpgrade: () => void;
  onRemove: () => void;
  onInstallFpm: () => void;
  onCli: () => void;
  onMakeDefault: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [defaulting, setDefaulting] = useState(false);
  // The default moves through PHP-FPM: from mod_php the first time, from another FPM version after that.
  const canDefault = v.version !== report.defaultVersion && v.sapis.includes('fpm');
  const cliOnly = !v.sapis.includes('fpm') && !v.sapis.includes('apache2');
  const cliVersion = report.versions.find((x) => x.cli)?.version;
  const removable = !v.apache && v.version !== cliVersion && v.sites.length === 0 && v.version !== report.defaultVersion;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-[1_1_20rem]">
        <h2 id="php-version-heading" className="text-lg font-semibold tracking-tight">PHP {v.version}</h2>
        <p className="text-sm text-muted-foreground">
          {v.patch ?? 'unknown release'} · {v.sapis.map((s) => SAPI_LABEL[s]).join(', ')}{v.cli ? ' (php)' : ''} · {sitesOf(v, report)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {v.update && <Button size="sm" variant="outline" disabled={busy} onClick={onUpgrade}><RefreshCw />Update to {v.update.replace(/^a new build of /, '')}</Button>}
        {canDefault && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDefaulting(true)}><Star />Make default</Button>}
        {v.sapis.includes('cli') && !v.cli && <Button size="sm" variant="outline" disabled={busy} onClick={onCli}><SquareTerminal />Use for the command line</Button>}
        {removable && <Button size="sm" variant="soft" className="text-danger" disabled={busy} onClick={() => setRemoving(true)}><Trash2 />Remove PHP {v.version}</Button>}
      </div>
      {cliOnly && (
        <Notice tone="info" className="w-full" action={<Button size="sm" variant="outline" disabled={busy} onClick={onInstallFpm}><Server />Install PHP-FPM {v.version}</Button>}>
          PHP {v.version} has only the command line: no PHP-FPM, so no site can run on it yet. apt adds a version like this when a package without a version (php-imagick, php-xdebug) follows the newest PHP your apt sources have.
        </Notice>
      )}
      <Dialog
        open={defaulting}
        onClose={() => setDefaulting(false)}
        title={`Make PHP ${v.version} the default?`}
        description={
          report.mode === 'fpm'
            ? `Every site without its own PHP, new sites included, moves from PHP ${report.defaultVersion ?? ''} to PHP ${v.version} through PHP-FPM, and phpMyAdmin with them. Sites with their own PHP keep it. The panel checks every site afterwards; Undo puts them back on PHP ${report.defaultVersion ?? ''}.`
            : `Every site without its own PHP, new sites included, moves from ${report.defaultVersion ? `mod_php ${report.defaultVersion}` : 'mod_php'} to PHP ${v.version} through PHP-FPM, and phpMyAdmin gets a pool of its own. mod_php goes off and Apache moves to mpm_event. Sites with their own PHP keep it. The panel checks every site afterwards; Undo turns mod_php back on.`
        }
      >
        <div className="grid gap-4 text-sm">
          <ul className="grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
            <li>PHP {v.version} has its own settings and modules: check its Settings and Modules below first, as values set for PHP {report.defaultVersion ?? 'the old default'} do not carry over.</li>
            {report.mode !== 'fpm' && <li>Refused while Before sites move to PHP-FPM lists php_value lines.</li>}
            {!v.cli && <li>php on the command line stays PHP {report.versions.find((x) => x.cli)?.version ?? 'as it is'}: click Use for the command line afterwards, so WP-CLI matches.</li>}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => setDefaulting(false)}>Cancel</Button>
            <Button
              onClick={() => {
                setDefaulting(false);
                onMakeDefault();
              }}
            >
              Make PHP {v.version} the default
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={removing} onClose={() => setRemoving(false)} title={`Remove PHP ${v.version}?`} description={`Every package of PHP ${v.version} goes. Its settings stay in /etc/php/${v.version}, so a reinstall gets them back, and Undo on the job installs it again.`}>
        <div className="flex justify-end gap-2">
          <Button variant="soft" onClick={() => setRemoving(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              setRemoving(false);
              onRemove();
            }}
          >
            Remove PHP {v.version}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** The slim strip that sticks to the top once the tiles scroll away: the versions, and a link to each section. */
export function VersionStrip({ report, picked, shown, onPick }: { report: PhpReport; picked: string; shown: boolean; onPick: (version: string) => void }) {
  return (
    <div className={cn('sticky top-2 z-20 -mb-6 h-0 transition-opacity', shown ? 'opacity-100' : 'pointer-events-none opacity-0')} aria-hidden={!shown}>
      <nav aria-label="PHP versions and sections" className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/95 px-3 py-2 text-sm shadow-md backdrop-blur">
        {report.versions.map((v) => (
          <Button
            key={v.version}
            size="xs"
            variant="outline"
            tabIndex={shown ? 0 : -1}
            onClick={() => onPick(v.version)}
            className={cn(v.version === picked ? 'border-primary bg-primary/8 text-primary hover:bg-primary/12' : 'text-muted-foreground hover:text-foreground')}
          >
            PHP {v.version}
          </Button>
        ))}
        <span className="ml-auto flex flex-wrap gap-3 text-xs">
          {PHP_SECTIONS.map((sec) => (
            <a key={sec} href={`#${sectionId(sec)}`} tabIndex={shown ? 0 : -1} className="text-muted-foreground hover:text-foreground hover:underline" onClick={(e) => { e.preventDefault(); scrollToCard(sectionId(sec)); }}>
              {SECTION_LABEL[sec]}
            </a>
          ))}
        </span>
      </nav>
    </div>
  );
}

/**
 * The last switch: mod_php off, Apache on mpm_event and every site without
 * its own PHP on one version through PHP-FPM, or back to mod_php.
 */
export function ModeSwitch({ report, busy, onSwitch }: { report: PhpReport; busy: boolean; onSwitch: (id: 'php.switchToFpm' | 'php.switchToModPhp', version: string) => void }) {
  const fpm = report.versions.filter((v) => v.sapis.includes('fpm')).map((v) => v.version);
  const toFpm = report.mode !== 'fpm';
  const choices = toFpm ? fpm : report.modPhp;
  const suggested = choices.includes(report.defaultVersion ?? '') ? (report.defaultVersion as string) : (choices[0] ?? '');
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(suggested);
  if (choices.length === 0) return toFpm ? <p className="text-xs text-muted-foreground">Install PHP-FPM for a version to run every site on it.</p> : null;
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => { setVersion(suggested); setOpen(true); }}>
        {toFpm ? 'Run every site on PHP-FPM' : 'Run sites on mod_php again'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={toFpm ? 'Run every site on PHP-FPM?' : 'Run sites on mod_php again?'}
        description={
          toFpm
            ? "mod_php goes off and Apache moves to mpm_event. Every site without its own PHP runs on the version you pick through PHP-FPM, phpMyAdmin through a pool of its own, and no vhost can send PHP source. The panel checks every site afterwards; Undo on the job turns mod_php back on."
            : 'mod_php of the version you pick goes back on, with mpm_prefork, for every site without its own PHP. Sites with their own PHP keep it. The panel checks every site afterwards; Undo runs them on PHP-FPM again.'
        }
      >
        <div className="grid gap-4">
          <label htmlFor="mode-version" className="grid gap-1.5 text-sm">
            <span className="font-medium">PHP version</span>
            <Select id="mode-version" value={version} onChange={(e) => setVersion(e.target.value)} wrapClassName="w-full">
              {choices.map((v) => <option key={v} value={v}>PHP {v}</option>)}
            </Select>
          </label>
          {toFpm && <p className="text-xs text-muted-foreground">It is refused while Before sites move to PHP-FPM lists php_value lines, or while PHP-FPM {version} differs from Apache&apos;s PHP {version}.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!version}
              onClick={() => {
                setOpen(false);
                onSwitch(toFpm ? 'php.switchToFpm' : 'php.switchToModPhp', version);
              }}
            >
              {toFpm ? `Run on PHP-FPM ${version}` : `Turn mod_php ${version} on`}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** The versions apt can install, or how to give apt the PPA they come from. */
export function AddVersion({ report, busy, onInstall }: { report: PhpReport; busy: boolean; onInstall: (version: string) => void }) {
  const [copied, setCopied] = useState(false);
  const command = 'sudo add-apt-repository ppa:ondrej/php && sudo apt update';
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 p-4">
      <p className="font-medium">Add a PHP version</p>
      <div className="grid gap-4 text-sm">
        {report.available.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {report.available.map((v) => (
              <Button key={v} variant="outline" disabled={busy} onClick={() => onInstall(v)}>
                <Download />
                Install PHP {v}
              </Button>
            ))}
            <p className="w-full text-xs text-muted-foreground">With PHP-FPM, the command line and the common modules. No site changes until you give one this version on its Server and PHP tab.</p>
          </div>
        )}
        {!report.sources.php && (
          <div className="grid gap-2">
            {report.sources.distro === 'debian' ? (
              <p className="text-xs text-muted-foreground">
                Debian ships one PHP version. The others come from packages.sury.org: add it once as its README says (<code className="font-mono">https://packages.sury.org/php/README.txt</code>), then check again.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Ubuntu (and Linux Mint) ships one PHP version. The others come from the ondrej/php PPA, kept by a Debian PHP maintainer. Adding it changes what apt trusts, so the panel leaves it to you: run this once in a terminal (sudo asks for your password), then check again.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">{command}</code>
                  <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

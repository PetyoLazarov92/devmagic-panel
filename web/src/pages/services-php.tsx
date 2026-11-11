import type { PhpFpmFinding, PhpIniDiff, PhpIniKey, PhpReport, PhpSettings, PhpVersion, PhpXdebug } from '@devmagic-panel/shared';
import { PHP_INI_KEYS, PHP_INI_SETTINGS, phpIniValueError, XDEBUG_MODES, XDEBUG_STARTS } from '@devmagic-panel/shared';
import { Bug, Check, ChevronRight, Code2, Copy, Download, FileDiff, Info, Plus, Puzzle, RefreshCw, Server, Settings2, ShieldCheck, SquareTerminal, Star, Trash2 } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { JobBox } from '@/components/job-box';
import { settled, useJob } from '@/components/job-steps';
import { InfoTables, inheritedValue, SettingField } from '@/components/php-bits';
import { SaveBar } from '@/components/save-bar';
import { ScopeLabel } from '@/components/scope-label';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { runRestarting } from '@/lib/restarting';
import { Link, navigate } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { SitesCompatCard } from '@/pages/php-compat-sites';
import { CardsSkeleton, ReadingBlock } from '@/components/skeletons';
import { Notice } from '@/components/page';
import { scrollToCard } from '@/lib/scroll-to';
import { Spinner } from '@/components/ui/spinner';

const SAPI_LABEL = { apache2: 'Apache (mod_php)', fpm: 'PHP-FPM', cli: 'Command line' } as const;

const START_LABEL: Record<(typeof XDEBUG_STARTS)[number], string> = {
  trigger: 'When asked',
  yes: 'On every request',
};

const START_HINT: Record<(typeof XDEBUG_STARTS)[number], ReactNode> = {
  trigger: <>When the Xdebug browser extension, or an <code className="font-mono">XDEBUG_TRIGGER</code> cookie, query parameter or variable, asks for it. Other requests stay fast.</>,
  yes: 'Xdebug starts for every request, which makes each one slower.',
};

type Mode = (typeof XDEBUG_MODES)[number];

const MODE_HINT: Record<Mode, string> = {
  debug: 'Step debugging in your IDE',
  develop: 'Better error pages and var_dump',
  profile: 'Cachegrind files for profiling',
  trace: 'A trace file of every call',
  gcstats: "Garbage collection runs, to the panel's profiles folder",
  coverage: 'Code coverage for tests',
};

const errorBox = (text: string) => <Notice>{text}</Notice>;

/** The sections of one version, in page order; /services/php/8.3/modules opens the version scrolled to one. */
export const PHP_SECTIONS = ['settings', 'modules', 'sites', 'xdebug', 'ini', 'info'] as const;
export type PhpSection = (typeof PHP_SECTIONS)[number];
const SECTION_LABEL: Record<PhpSection, string> = { settings: 'Settings', modules: 'Modules', sites: 'Sites', xdebug: 'Xdebug', ini: 'php.ini', info: 'Info' };
const sectionId = (section: PhpSection) => `php-${section}`;

/**
 * The Services page's PHP tab: PHP on this machine (the default for sites,
 * how they run, a tile per installed version, adding one, the check before
 * PHP-FPM), then everything of the version picked, one section under the
 * other. A slim strip with the versions and the sections sticks to the top
 * once the tiles scroll away.
 */
export function PhpTab({ refresh, onLoading, version: wanted, section }: { refresh: number; onLoading: (loading: boolean) => void; version?: string; section?: PhpSection }) {
  const { data: report, error, loading, reload } = useAsync(() => api.php(), [refresh]);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped when the php.ini changes moved, so the settings read again.
  const [moved, setMoved] = useState(0);
  // Installs, updates, removals and the switch: shown under the machine card, or under the version's header for its own.
  const machine = useJob();
  const machineDone = useRef<string | null>(null);
  const machineBusy = machine.job !== null && !settled(machine.job);
  const [jobAt, setJobAt] = useState<'machine' | 'version'>('machine');
  // The strip shows once the tiles are out of view.
  const tiles = useRef<HTMLDivElement>(null);
  const [tilesGone, setTilesGone] = useState(false);
  useEffect(() => onLoading(loading), [loading, onLoading]);
  useEffect(() => {
    if (!machine.job || !settled(machine.job) || machineDone.current === machine.job.id) return;
    machineDone.current = machine.job.id;
    if (machine.job.status === 'done') toast({ tone: 'success', title: `${machine.job.title}: done` });
    reload();
  }, [machine.job, reload]);
  useEffect(() => {
    const el = tiles.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => setTilesGone(entry ? !entry.isIntersecting && entry.boundingClientRect.top < 0 : false));
    watch.observe(el);
    return () => watch.disconnect();
  }, [report]);
  // An address with a section opens the version scrolled to it.
  useEffect(() => {
    if (!report || !section) return;
    // After the page settles: the sections above it load their own data and grow first.
    const timer = window.setTimeout(() => scrollToCard(sectionId(section)), 600);
    return () => window.clearTimeout(timer);
  }, [report, section, wanted]);
  const start = (at: 'machine' | 'version', id: 'php.install' | 'php.upgrade' | 'php.remove' | 'php.package' | 'php.switchToFpm' | 'php.switchToModPhp', input: Record<string, unknown>) => {
    setJobAt(at);
    void machine.follow(api.startJob(id, input));
  };

  if (!report && loading) return <CardsSkeleton reading="Asking PHP for its versions and modules..." cards={[4, 4, 5, 3]} />;
  if (error) return errorBox(error);
  if (!report) return null;
  if (report.versions.length === 0) return errorBox('No PHP is installed: install.sh puts PHP and the modules WordPress needs in place.');

  const current = report.versions.find((v) => v.version === wanted) ?? report.versions.find((v) => v.version === report.defaultVersion) ?? (report.versions[0] as PhpVersion);
  const pick = (version: string) => navigate(`/services/php/${version}`, { scroll: false });
  const jobBox = (machine.job || machine.error) && (
    <div className="grid gap-3 text-sm">
      {machine.job && <JobBox job={machine.job} onRetry={() => void machine.retry()} />}
      {machine.error && errorBox(machine.error)}
    </div>
  );

  async function run(key: string, id: Parameters<typeof runRestarting>[0], input: Record<string, unknown>, label: string) {
    setBusy(key);
    await runRestarting(id, input, label, reload);
    setBusy(null);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <MachineCard
        report={report}
        picked={current.version}
        busy={machineBusy}
        cliBusy={busy === 'cli'}
        tilesRef={tiles}
        onPick={pick}
        onStart={(id, input) => start('machine', id, input)}
        onCli={(version) => void run('cli', 'php.setCli', { version }, `php on the command line is PHP ${version}`)}
      >
        {jobAt === 'machine' && jobBox && <div className="border-t px-5 py-4">{jobBox}</div>}
      </MachineCard>

      <VersionStrip report={report} picked={current.version} shown={tilesGone} onPick={pick} />

      <section className="grid grid-cols-[minmax(0,1fr)] gap-4" aria-labelledby="php-version-heading">
        <VersionHeader
          report={report}
          version={current}
          busy={machineBusy || busy !== null}
          onUpgrade={() => start('version', 'php.upgrade', { version: current.version })}
          onRemove={() => start('version', 'php.remove', { version: current.version })}
          onInstallFpm={() => start('version', 'php.package', { version: current.version, name: 'fpm', how: 'install' })}
          onCli={() => void run('cli', 'php.setCli', { version: current.version }, `php on the command line is PHP ${current.version}`)}
          onMakeDefault={() => start('version', 'php.switchToFpm', { version: current.version })}
        />
        {jobAt === 'version' && jobBox && <Card><CardBody>{jobBox}</CardBody></Card>}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          <div id={sectionId('settings')} className="scroll-mt-20 lg:col-span-2">
            <SettingsCard key={`settings-${current.version}-${refresh}-${moved}`} version={current} />
          </div>
          <div id={sectionId('modules')} className="scroll-mt-20 lg:col-span-2">
            <PhpModulesCard
              version={current}
              busy={busy}
              aptBusy={machineBusy}
              onPackage={(name, how) => start('version', 'php.package', { version: current.version, name, how })}
              onSwitch={(module, enabled) => void run(`module:${module}`, 'php.setModule', { version: current.version, module, enabled }, `${module} ${enabled ? 'on' : 'off'} for PHP ${current.version}`)}
            />
          </div>
          <div id={sectionId('sites')} className="scroll-mt-20 lg:col-span-2">
            <SitesCompatCard key={`sites-${current.version}-${refresh}`} version={current.version} />
          </div>
          <div id={sectionId('xdebug')} className="scroll-mt-20 [&>*]:h-full">
            <XdebugCard
              key={`xdebug-${current.version}`}
              version={current}
              busy={busy !== null}
              applying={busy === 'xdebug'}
              onApply={(input, label) => void run('xdebug', 'php.setXdebug', { version: current.version, ...input }, label)}
            />
          </div>
          <div id={sectionId('ini')} className="scroll-mt-20 [&>*]:h-full">
            <IniChangesCard
              key={`ini-${current.version}-${refresh}`}
              version={current.version}
              onMoved={() => {
                setMoved((n) => n + 1);
                reload();
              }}
            />
          </div>
          <div id={sectionId('info')} className="grid scroll-mt-20 gap-4 lg:col-span-2">
            <InfoSection key={`info-${current.version}-${refresh}`} version={current} />
            <XdebugInfoSection key={`xinfo-${current.version}-${refresh}`} version={current} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** Which sites a version serves, in words. */
function sitesOf(v: PhpVersion, report: PhpReport): string {
  const own = v.sites.length > 0 ? `${v.sites.length} with their own PHP` : '';
  const rest = v.version === report.defaultVersion ? 'every site without its own PHP' : '';
  return [rest, own].filter(Boolean).join(', and ') || 'no site';
}

/** A version's sites, short, for its tile. */
function tileSites(v: PhpVersion, report: PhpReport): string {
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
function MachineCard({ report, picked, busy, cliBusy, tilesRef, onPick, onStart, onCli, children }: {
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
function CliMismatch({ report, busy, onCli }: { report: PhpReport; busy: boolean; onCli: (version: string) => void }) {
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
function VersionHeader({ report, version: v, busy, onUpgrade, onRemove, onInstallFpm, onCli, onMakeDefault }: {
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
function VersionStrip({ report, picked, shown, onPick }: { report: PhpReport; picked: string; shown: boolean; onPick: (version: string) => void }) {
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
function ModeSwitch({ report, busy, onSwitch }: { report: PhpReport; busy: boolean; onSwitch: (id: 'php.switchToFpm' | 'php.switchToModPhp', version: string) => void }) {
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
function AddVersion({ report, busy, onInstall }: { report: PhpReport; busy: boolean; onInstall: (version: string) => void }) {
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

function XdebugCard({ version, busy, applying, onApply }: {
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

/** What the common modules are for, in a few words. */
const MODULE_HINT: Record<string, string> = {
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
function PhpModulesCard({ version, busy, aptBusy, onSwitch, onPackage }: {
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
function PackagesSection({ version, busy, onPackage }: { version: string; busy: boolean; onPackage: (name: string, how: 'install' | 'remove') => void }) {
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

const CORE_PACKAGES = new Set(['common', 'cli', 'fpm', 'mysql', 'xml']);

function PackagesList({ version, busy, onPackage }: { version: string; busy: boolean; onPackage: (name: string, how: 'install' | 'remove') => void }) {
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

/**
 * What each part's php.ini changes from the one its package ships, and the
 * extra ini files it loads, with the job that moves the changes into the
 * panel's settings and puts the packaged php.ini back.
 */
function IniChangesCard({ version, onMoved }: { version: string; onMoved: () => void }) {
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

const GROUPS = ['Limits', 'Errors', 'OPcache', 'Other'] as const;

/**
 * The panel's own settings for a version: one form for the web (every site
 * on it, Apache's mod_php and PHP-FPM together) and one for the command line.
 * An empty field leaves the setting to php.ini, whose value shows as the hint.
 */
function SettingsCard({ version }: { version: PhpVersion }) {
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

function SettingsForm({ version, settings, onSaved }: { version: PhpVersion; settings: PhpSettings['scopes'][number]; onSaved: () => void }) {
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
    <div className="grid gap-5">
      {GROUPS.map((group) => (
        <fieldset key={group} className="grid gap-x-6 gap-y-3 sm:grid-cols-2" disabled={saving}>
          <legend className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</legend>
          {PHP_INI_KEYS.filter((k) => PHP_INI_SETTINGS[k].group === group).map((key) => (
            <SettingField key={key} name={key} setting={PHP_INI_SETTINGS[key]} value={values[key] ?? ''} own="set here" inherited={inheritedValue(key, settings.files[key], 'php.ini', info.data)} onChange={(v) => set(key, v)} />
          ))}
        </fieldset>
      ))}
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

function IniDiff({ diff }: { diff: PhpIniDiff }) {
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

/** A section that loads only once opened, like the info pages: PHP runs for each. */
function Section({ title, icon, hint, children, defaultOpen = false, compact = false }: { title: string; icon: ReactNode; hint: string; children: (open: boolean) => ReactNode; defaultOpen?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const box = (
    <details open={defaultOpen} className={cn('group', compact && 'rounded-lg border')} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className={cn('flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden', compact ? 'px-4 py-3' : 'px-5 py-4')}>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
        {icon}
      </summary>
      {open && <div className={cn('border-t text-sm', compact ? 'px-4 py-3' : 'px-5 py-4')}>{children(open)}</div>}
    </details>
  );
  // A compact one sits inside a card; the others are cards of their own.
  return compact ? box : <Card className="lg:col-span-2">{box}</Card>;
}

function SapiPicker({ value, onChange, cli }: { value: 'web' | 'cli'; onChange: (v: 'web' | 'cli') => void; cli: boolean }) {
  return (
    <div className="inline-flex rounded-lg border p-0.5 text-xs" role="radiogroup" aria-label="Which PHP">
      {(['web', 'cli'] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          disabled={s === 'cli' && !cli}
          onClick={() => onChange(s)}
          className={cn('rounded-md px-3 py-1', value === s ? 'bg-primary/12 font-medium text-primary' : 'text-muted-foreground hover:text-foreground disabled:opacity-50')}
        >
          {s === 'web' ? 'Web' : 'Command line'}
        </button>
      ))}
    </div>
  );
}

/** phpinfo() for one version, from the PHP itself: sections per extension, with a filter. */
function InfoSection({ version }: { version: PhpVersion }) {
  const [sapi, setSapi] = useState<'web' | 'cli'>('web');
  return (
    <Section title="PHP info" icon={<ScopeLabel>{`PHP ${version.version}`}</ScopeLabel>} hint={`What phpinfo() shows for PHP ${version.version}, for the web or the command line, asked from PHP itself.`}>
      {() => (
        <div className="grid gap-4">
          <SapiPicker value={sapi} onChange={setSapi} cli={version.sapis.includes('cli')} />
          <InfoView key={sapi} version={version.version} sapi={sapi} />
        </div>
      )}
    </Section>
  );
}

function InfoView({ version, sapi }: { version: string; sapi: 'web' | 'cli' }) {
  const { data, error, loading } = useAsync(() => api.phpInfo(version, sapi), [version, sapi]);
  const [filter, setFilter] = useState('');
  if (loading && !data) return <ReadingBlock lines={6}>Asking PHP...</ReadingBlock>;
  if (error) return errorBox(error);
  if (!data) return null;
  return <InfoTables info={data} filter={filter} onFilter={setFilter} />;
}

/** xdebug_info() for one version on the web: its release, the modes in effect and every Xdebug setting. */
function XdebugInfoSection({ version }: { version: PhpVersion }) {
  return (
    <Section title="Xdebug info" icon={<Bug className="size-4 text-muted-foreground" />} hint={`What xdebug_info() shows for PHP ${version.version} on the web. Each version has its own Xdebug and settings.`}>
      {() => <XdebugInfoView version={version} />}
    </Section>
  );
}

function XdebugInfoView({ version }: { version: PhpVersion }) {
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


/** What changes for sites once they run on PHP-FPM, checked before any site moves. */
function FpmCheckSection() {
  return (
    <Section compact title="Before sites move to PHP-FPM" icon={<ShieldCheck className="size-4 text-muted-foreground" />} hint="For every site: php_value lines, .user.ini files, phpMyAdmin, and differences between Apache's and FPM's settings per version.">
      {() => <FpmCheckView />}
    </Section>
  );
}

function FpmCheckView() {
  const { data, error, loading, reload } = useAsync(() => api.phpFpmCheck(), []);
  const runner = useJob();
  const done = useRef<string | null>(null);
  const { job } = runner;
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    reload();
  }, [job, reload]);
  if (loading && !data) return <ReadingBlock lines={4}>Checking your sites and Apache config...</ReadingBlock>;
  if (error) return errorBox(error);
  if (!data) return null;
  const mismatched = [...new Set(data.filter((f) => f.status === 'warn' && f.version).map((f) => f.version as string))];
  return (
    <div className="grid gap-4">
      <ul className="grid gap-3">
        {data.map((f: PhpFpmFinding, i) => (
          <li key={`${f.id}-${i}`} className="flex gap-3">
            {f.status === 'info' ? <Info className="mt-0.5 size-4 shrink-0 text-primary" /> : <StatusDot status={f.status} className="mt-1.5" />}
            <div className="min-w-0">
              <p>{f.text}</p>
              {f.files && f.files.length > 0 && (
                <ul className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground">
                  {f.files.slice(0, 20).map((file) => <li key={file} className="[overflow-wrap:anywhere]">{file}</li>)}
                  {f.files.length > 20 && <li>and {f.files.length - 20} more</li>}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
      {mismatched.length > 0 && !job && (
        <div className="flex flex-wrap items-center gap-2">
          {mismatched.map((v) => (
            <Button key={v} variant="outline" onClick={() => void runner.follow(api.startJob('php.matchFpm', { version: v }))}>
              Make PHP-FPM {v} match Apache
            </Button>
          ))}
          <p className="w-full text-xs text-muted-foreground">Gives FPM the same modules, the panel&apos;s settings and Xdebug, and Apache&apos;s php.ini (FPM&apos;s own is saved, and Undo puts it back).</p>
        </div>
      )}
      {job && <JobBox job={job} onRetry={() => void runner.retry()} />}
      {runner.error && errorBox(runner.error)}
    </div>
  );
}

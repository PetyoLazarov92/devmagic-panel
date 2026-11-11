import type { PhpVersion } from '@devmagic-panel/shared';
import { useEffect, useRef, useState } from 'react';
import { JobBox } from '@/features/jobs/job-box';
import { settled, useJob } from '@/features/jobs/job-steps';
import { Card, CardBody } from '@/components/ui/card';
import { api } from '@/lib/api';
import { runRestarting } from '@/lib/restarting';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { SitesCompatCard } from '@/features/services/php-compat-sites';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { scrollToCard } from '@/lib/scroll-to';
import { type PhpSection, errorBox, sectionId } from './php-shared';
import { MachineCard, VersionHeader, VersionStrip } from './php-versions';
import { IniChangesCard, SettingsCard } from './php-settings';
import { PhpModulesCard } from './php-modules';
import { XdebugCard, XdebugInfoSection } from './php-xdebug';
import { InfoSection } from './php-info';
export { PHP_SECTIONS } from './php-shared';
export type { PhpSection } from './php-shared';
export { changedCount } from './php-settings';

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

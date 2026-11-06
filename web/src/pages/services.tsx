import type { ServicesReport } from '@devmagic-panel/shared';
import { ArrowRight, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { StatusDot } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { MailpitInstall } from '@/components/mailpit-install';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { runRestarting } from '@/lib/restarting';
import { Link, navigate } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { ApacheTab } from '@/pages/services-apache';
import { CronTab } from '@/pages/services-cron';
import { MysqlTab } from '@/pages/services-mysql';
import { PHP_SECTIONS, type PhpSection, PhpTab } from '@/pages/services-php';

const STATE_DOT = { running: 'ok', stopped: 'fail', missing: 'warn' } as const;

export type ServicesTab = 'overview' | 'php' | 'mysql' | 'apache' | 'cron';
const TAB_HREF: Record<ServicesTab, string> = { overview: '/services', php: '/services/php', mysql: '/services/mysql', apache: '/services/apache', cron: '/services/cron' };
const TAB_INTRO: Record<ServicesTab, string> = {
  overview: 'What your sites run on. Apache is only reloaded or restarted after its configtest passes.',
  php: 'PHP on this machine first, for every site: the default, how sites run and a tile per installed version. Below, everything of the version you pick: settings, modules, Xdebug, php.ini changes and PHP info.',
  mysql: "Every database and user on the MySQL server, read with the panel's admin account. A site's database and user go with the site; the rest can be deleted here, saved first for 14 days.",
  apache: "Every vhost file in sites-available, the enabled modules, a configtest and Apache's own error log.",
  cron: "Your crontab: the panel's tasks, which it adds, changes and runs, and the lines you wrote yourself, which it leaves as they are. System cron is shown read only. For a site's WP-Cron events, open its Cron tab.",
};

/** The Services page: an overview of what sites run on, and a tab each for MySQL and Apache, each with its own address. */
export function ServicesPage({ tab = 'overview', phpVersion, phpSection }: { tab?: ServicesTab; phpVersion?: string; phpSection?: PhpSection }) {
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const onLoading = useCallback((value: boolean) => setLoading(value), []);
  return (
    <div className="pt-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="mt-1 text-sm text-muted-foreground">{TAB_INTRO[tab]}</p>
        </div>
        <Button variant="outline" onClick={() => setRefresh((n) => n + 1)} disabled={loading}>
          <RefreshCw className={cn(loading && 'animate-spin')} />
          Check again
        </Button>
      </div>

      <Tabs
        className="mt-6"
        value={tab}
        onChange={(next) => navigate(TAB_HREF[next], { scroll: false })}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'php', label: 'PHP' },
          { value: 'mysql', label: 'MySQL' },
          { value: 'apache', label: 'Apache' },
          { value: 'cron', label: 'Cron' },
        ]}
      />

      <div className="mt-5">
        {tab === 'overview' && <ServicesOverview refresh={refresh} onLoading={onLoading} />}
        {tab === 'php' && <PhpTab refresh={refresh} onLoading={onLoading} {...(phpVersion ? { version: phpVersion } : {})} {...(phpSection ? { section: phpSection } : {})} />}
        {tab === 'mysql' && <MysqlTab refresh={refresh} onLoading={onLoading} />}
        {tab === 'apache' && <ApacheTab refresh={refresh} onLoading={onLoading} />}
        {tab === 'cron' && <CronTab refresh={refresh} onLoading={onLoading} />}
      </div>
    </div>
  );
}

function ServicesOverview({ refresh, onLoading }: { refresh: number; onLoading: (loading: boolean) => void }) {
  const { data: report, error, loading, reload } = useAsync(() => api.services(), [refresh]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => onLoading(loading), [loading, onLoading]);

  async function run(key: string, id: Parameters<typeof runRestarting>[0], input: Record<string, unknown>, label: string) {
    setBusy(key);
    await runRestarting(id, input, label, reload);
    setBusy(null);
  }

  return (
    <div>
      {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">{error}</p>}
      {!report && loading && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Checking services...</p>}

      {report && (
        <div className="grid gap-4 sm:grid-cols-2">
          {report.services.map((s) => {
            const link = SERVICE_LINK[s.id];
            return (
              <ServiceCard
                key={s.id}
                title={s.label}
                // Mailpit is optional: down is a warning, not a failure.
                status={(s.id === 'mailpit' || s.id === 'cron') && s.state !== 'running' ? 'warn' : STATE_DOT[s.state]}
                state={s.state === 'missing' ? 'not installed' : s.state}
                facts={[s.detail]}
                link={link}
                actions={
                  <>
                    {s.id === 'apache' && (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('apache.reload', 'apache.reload', {}, 'Apache reloaded')}>
                        {busy === 'apache.reload' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                        Reload
                      </Button>
                    )}
                    {s.offer && <MailpitInstall offer={s.offer} onDone={reload} />}
                    {s.canRestart && (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(s.id, 'service.restart', { service: s.id }, `${s.label} restarted`)}>
                        {busy === s.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                        Restart
                      </Button>
                    )}
                  </>
                }
              />
            );
          }).flatMap((card, i) => (i === 0 ? [card, <PhpServiceCard key="php" php={report.php} />] : [card]))}
        </div>
      )}
    </div>
  );
}

const SERVICE_LINK: Record<ServicesReport['services'][number]['id'], { href: string; label: string }> = {
  apache: { href: '/services/apache', label: 'Open Apache' },
  mysql: { href: '/services/mysql', label: 'Open MySQL' },
  mailpit: { href: '/mail', label: 'Open Mail' },
  cron: { href: '/services/cron', label: 'Open Cron' },
};

/** One service on the Overview: its state, a fact or two, its buttons, and the way to its tab. */
function ServiceCard({ title, status, state, facts, actions, link }: {
  title: string;
  status: 'ok' | 'warn' | 'fail';
  state: string;
  facts: string[];
  actions?: ReactNode;
  link: { href: string; label: string };
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><StatusDot status={status} />{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{state}</span>
      </CardHeader>
      <div className="grid flex-1 content-start gap-1 px-5 py-4 text-sm">
        {facts.map((f) => <p key={f} className="truncate text-muted-foreground" title={f}>{f}</p>)}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
        {actions}
        <Link href={link.href} className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
          {link.label}
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </Card>
  );
}

/** PHP on the Overview: the version sites run, how, and the command line's; the PHP tab has the rest. */
function PhpServiceCard({ php }: { php: ServicesReport['php'] }) {
  const version = php.apache ?? php.fpm;
  return (
    <ServiceCard
      title="PHP"
      status={version ? 'ok' : 'warn'}
      state={version ? `PHP ${version}` : 'not loaded'}
      facts={[
        version ? `Default for sites: PHP ${version} (${php.apache ? 'mod_php' : 'PHP-FPM'})` : 'Apache runs no PHP for sites',
        php.cli ? `Command line: PHP ${php.cli}` : 'No command line PHP',
      ]}
      link={{ href: '/services/php', label: 'Open PHP' }}
    />
  );
}

/** A PHP tab section from the address, or the default one. */
export const phpSectionOf = (value: string | undefined): PhpSection | undefined => (PHP_SECTIONS as readonly string[]).includes(value ?? '') ? (value as PhpSection) : undefined;

import { Code2, ExternalLink, FolderOpen, LogIn, Network, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SitePageSkeleton } from '@/components/layout/skeletons';
import { JobScreen } from '@/features/jobs/job-screen';
import { IssueRow, NetworkBadge, siteSubtitle, siteUrl, openInVSCode, StatusDot } from '@/components/layout/site-bits';
import { Button } from '@/components/ui/button';
import { Menu } from '@/components/ui/menu';
import { Notice } from '@/components/ui/notice';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { SectionLayout } from '@/components/ui/section-nav';
import { CheckAgain } from '@/components/layout/page';
import { openWpAdmin } from '@/lib/site-actions';
import { api } from '@/lib/api';
import { Link, navigate, useQueryParam } from '@/lib/router';
import { useReloadWhileBusy } from '@/lib/jobs';
import { useAsync } from '@/lib/use-async';
import { ConfigTab, saltsSummary } from '@/features/site/config';
import { CronTab } from '@/features/site/cron';
import { DatabaseTab } from '@/features/site/database';
import { PerformanceTab } from '@/features/site/performance';
import { FilesTab } from '@/features/site/files';
import { PluginsTab } from '@/features/site/plugins';
import { siteHref, siteName } from '@/lib/site-ref';
import { sectionViews, siteTabItems, type Tab, type TabCounts, uncoveredNames } from '@/lib/site-tabs';
import { Spinner } from '@/components/ui/spinner';
import { tabHref } from '@/features/site/site-shared';
import { Overview } from '@/features/site/overview';
import { LogsTab } from '@/features/site/logs';
import { NetworkCard } from '@/features/site/network';
import { ServerAndPhpTab } from '@/features/site/server-and-php';
import { DomainsTab } from '@/features/site/domains';
import { RemoveDialog } from '@/features/site/remove-dialog';

/** A tab's address: the site's page with ?tab=, nothing for Overview. Not a path segment, which a site under that path would own. */
/** A tab's name, for the breadcrumbs. */
const tabLabel = (site: Parameters<typeof siteTabItems>[0], tab: Tab): string => {
  const label = siteTabItems(site).find((t) => t.value === tab)?.label;
  return typeof label === 'string' ? label : tab;
};

/** A site's page; with a path, the WordPress install under that path of the domain. */
export function SiteDetailPage({ domain, path }: { domain: string; path?: string }) {
  const { data: site, error, loading, reload } = useAsync(() => api.site(domain, path), [domain, path]);
  const logs = useAsync(() => api.logs(domain, 'debug', path), [domain, path]);
  // The WordPress installs under paths of this domain, linked from the parent's page.
  const all = useAsync(() => (path ? Promise.resolve([]) : api.sites()), [domain, path]);
  const under = (all.data ?? []).filter((s) => s.domain === domain && s.path);
  const requested = useQueryParam('tab');
  const viewParam = useQueryParam('view');
  const tableParam = useQueryParam('table');
  const [removing, setRemoving] = useState(false);
  // The WordPress site's WP-Cron, for the Cron tab and its count; url picks a network site.
  const [cronUrl, setCronUrl] = useState<string | undefined>(undefined);
  const wordpress = Boolean(site && site.core.kind !== 'none' && !site.installing);
  const wpCron = useAsync(() => (wordpress ? api.wpCron(domain, path, cronUrl) : Promise.resolve(null)), [domain, path, cronUrl, wordpress]);
  const reloadCron = (url?: string) => (url === cronUrl ? wpCron.reload() : setCronUrl(url));
  useReloadWhileBusy(Boolean(site?.installing || site?.busy), reload);
  // The tab is in the address, so a reload or a link opens it; one this site lacks shows Overview.
  const tab: Tab = site && siteTabItems(site).some((t) => t.value === requested) ? (requested as Tab) : 'overview';
  // The constants every local site should have, from Settings, for the Config tab's count.
  const locals = useAsync(() => api.localConstants(), []);
  const setTab = (next: Tab) => navigate(tabHref({ domain, ...(path ? { path } : {}) }, next), { scroll: false });
  useEffect(() => {
    if (site && requested !== null && requested !== tab) navigate(tabHref({ domain, ...(path ? { path } : {}) }, tab), { replace: true });
  }, [site, requested, tab, domain, path]);

  if (loading && !site) {
    return <SitePageSkeleton />;
  }
  if (error || !site) {
    return (
      <div className="pt-10 text-sm">
        <p className="text-danger" role="alert">{error ?? `No site called ${domain}${path ?? ''}.`}</p>
        <Link href="/sites" className="mt-3 inline-block font-medium hover:underline">Back to sites</Link>
      </div>
    );
  }

  // Nothing is offered on a site that is still being installed: its page is the install's progress.
  if (site.installing) {
    return (
      <div className="grid gap-4 pt-2">
        <Breadcrumbs items={[{ label: 'Sites', href: '/sites' }, { label: siteName(site) }]} />
        <Notice tone="warning" action={<CheckAgain size="sm" onClick={reload} />}>
          {siteName(site)} is still being installed. Its actions open once the install finishes.
        </Notice>
        <JobScreen jobId={site.installing} />
      </div>
    );
  }

  const problems = (logs.data?.lines ?? []).filter((l) => l.level === 'fatal' || l.level === 'error').length;
  // Late events, and the panel's cron tasks for the site whose last run failed.
  const cronProblems = wpCron.data ? wpCron.data.overdue + [wpCron.data.task, ...wpCron.data.tasks].filter((t) => t?.last?.status === 'failed').length : 0;
  // Local constants wp-config.php does not have yet, and keys and salts to fix as one.
  const configProblems = site.constants
    ? (locals.data ?? []).filter((c) => site.constants?.find((s) => s.name === c.name)?.value !== c.value).length + (site.salts && saltsSummary(site.salts).bad.length > 0 ? 1 : 0)
    : 0;
  const views = sectionViews(site, tab, { view: viewParam, table: tableParam });
  const counts: TabCounts = { logs: problems, cron: cronProblems, config: configProblems, domains: site.path ? 0 : uncoveredNames(site).length };

  return (
    <div className="pt-2">
      <Breadcrumbs
        items={[
          { label: 'Sites', href: '/sites' },
          ...(site.path ? [{ label: site.domain, href: `/sites/${encodeURIComponent(site.domain)}` }] : []),
          ...(tab === 'overview'
            ? [{ label: site.path ?? siteName(site) }]
            : [
                { label: site.path ?? siteName(site), href: tabHref(site, 'overview') },
                ...(views ? [{ label: tabLabel(site, tab), href: tabHref(site, tab) }, { label: views.items.find((v) => v.value === views.value)?.label ?? '' }] : [{ label: tabLabel(site, tab) }]),
              ]),
        ]}
      />

      {site.busy && (
        <Notice tone="warning" icon={false} className="mt-3">
          <span className="flex items-center gap-2">
            <Spinner className="size-4 shrink-0 text-warning" />
            <span>
              Busy: {site.busy.title}. Its actions wait until that finishes.{' '}
              {site.busy.jobId && <Link href={`/jobs/${encodeURIComponent(site.busy.jobId)}`} className="font-medium hover:underline">See progress</Link>}
            </span>
          </span>
        </Notice>
      )}

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusDot status={site.health} />
            <h1 className="truncate text-2xl font-semibold tracking-tight" title={siteName(site)}>{siteName(site)}</h1>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5.5 text-sm text-muted-foreground">
            {siteSubtitle(site) && <span>{siteSubtitle(site)}</span>}
            <NetworkBadge site={site} />
          </p>
          {under.length > 0 && (
            <p className="mt-1 pl-5.5 text-sm text-muted-foreground">
              Also on this domain:{' '}
              {under.map((s, i) => (
                <span key={s.path}>
                  {i > 0 && ', '}
                  <Link href={siteHref(s)} className="font-mono text-dense text-foreground hover:underline">{s.path}</Link>
                  {s.title && <> ({s.title})</>}
                </span>
              ))}
            </p>
          )}
          {site.path && (
            <p className="mt-1 pl-5.5 text-sm text-muted-foreground">
              Under <Link href={`/sites/${encodeURIComponent(site.domain)}`} className="font-mono text-dense text-foreground hover:underline">{site.domain}</Link>: its own folder, database and git; the vhost, certificate and hosts line are there.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => window.open(siteUrl(site.domain, site.path), '_blank', 'noopener')}>
            <ExternalLink />
            Open site
          </Button>
          <Button onClick={() => void openWpAdmin(site)}>
            <LogIn />
            wp-admin
          </Button>
          <Menu
            items={[
              ...(site.network ? [{ label: 'Network Admin', icon: <Network />, onSelect: () => void openWpAdmin(site, { to: 'network' }) }] : []),
              { label: 'VS Code', icon: <Code2 />, onSelect: () => openInVSCode(site.docroot) },
              { label: 'Copy folder path', icon: <FolderOpen />, onSelect: () => void navigator.clipboard?.writeText(site.docroot) },
              site.removable
                ? { label: 'Remove site', icon: <Trash2 />, danger: true, onSelect: () => setRemoving(true) }
                : { label: site.path ? 'Remove site (goes with its parent)' : 'Remove site (not in the usual layout)', icon: <Trash2 />, disabled: true, onSelect: () => undefined },
            ]}
          />
        </div>
      </header>

      {site.issues.length > 0 && (
        <Notice tone={site.health === 'fail' ? 'danger' : 'warning'} icon={false} className="mt-5 text-foreground">
          <div className="grid gap-1.5">
            {site.issues.map((issue) => <IssueRow key={issue.text} issue={issue} onFixed={reload} />)}
          </div>
        </Notice>
      )}

      <SectionLayout className="mt-6" label={`${siteName(site)} sections`} value={tab} onChange={setTab} items={siteTabItems(site, counts)} views={views}>
        {tab === 'overview' && <Overview site={site} onChanged={reload} onOpen={setTab} cron={wpCron} logErrors={logs.loading && !logs.data ? undefined : problems} />}
        {tab === 'logs' && <LogsTab site={site} onChanged={reload} />}
        {tab === 'files' && <FilesTab site={site} />}
        {tab === 'network' && <NetworkCard site={site} />}
        {tab === 'plugins' && <PluginsTab site={site} />}
        {tab === 'php' && <ServerAndPhpTab site={site} onChanged={reload} />}
        {tab === 'cron' && <CronTab site={site} report={wpCron} onReload={reloadCron} />}
        {tab === 'database' && <DatabaseTab site={site} />}
        {tab === 'performance' && <PerformanceTab site={site} />}
        {tab === 'config' && <ConfigTab site={site} onChanged={reload} />}
        {tab === 'domains' && <DomainsTab site={site} onChanged={reload} />}
      </SectionLayout>

      {!site.path && <RemoveDialog site={site} open={removing} onClose={() => setRemoving(false)} />}
    </div>
  );
}

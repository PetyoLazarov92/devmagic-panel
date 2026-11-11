import type { Site } from '@devmagic-panel/shared';
import { Check, ExternalLink, LogIn, Network, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ListSkeleton } from '@/components/layout/skeletons';
import { settled, StepList, useJob } from '@/features/jobs/job-steps';
import { NETWORK_TYPE_LABEL, siteUrl } from '@/components/layout/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { FilterChips } from '@/components/ui/filter-chips';
import { openWpAdmin } from '@/lib/site-actions';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';
import { siteTarget } from '@/lib/site-ref';
import { Spinner } from '@/components/ui/spinner';
import { type NetworkSite } from './site-shared';

export type NetworkFilter = 'all' | 'active' | 'archived' | 'deleted';

export const isActive = (s: NetworkSite) => !s.archived && !s.spam;

export function NetworkCard({ site }: { site: Site }) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const [admins, setAdmins] = useState(false);
  const network = site.network;
  if (!network) return null;
  const type = network.type;
  const deleted = network.deleted ?? [];
  const archived = network.sites.filter((s) => !isActive(s)).length;
  const shown = network.sites.filter((s) => (filter === 'all' ? true : filter === 'active' ? isActive(s) : filter === 'archived' ? !isActive(s) : false));
  const filters = [
    { value: 'all' as const, label: 'All', count: network.sites.length },
    { value: 'active' as const, label: 'Active', count: network.sites.length - archived },
    { value: 'archived' as const, label: 'Archived or spam', count: archived },
    { value: 'deleted' as const, label: 'Deleted', count: deleted.length },
  ];
  return (
    <Card>
      <CardHeader
        title="Network"
        meta={
          <span className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {network.sites.length > 0 && `${network.sites.length} sites · `}
              {NETWORK_TYPE_LABEL[type]}
            </span>
            <Network className="size-4 text-muted-foreground" />
          </span>
        }
      />
      {network.sites.length === 0 && (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          wp-config.php marks this as a network. Listing its sites needs the MySQL admin account: set it up under Aura, Machine checks.
        </p>
      )}
      {network.sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          {(archived > 0 || deleted.length > 0) && (
            <FilterChips label="Sites to show" value={filter} onChange={setFilter} options={filters.filter((f) => f.value === 'all' || f.count > 0)} />
          )}
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdmins(true)}>
            <ShieldCheck />
            Super admins
          </Button>
        </div>
      )}
      {filter === 'deleted' ? (
        <ul className="divide-y">
          {deleted.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5 text-sm">
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">#{s.id}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{s.url}</span>
              <Badge tone="danger" title="Deleted in Network Admin and still in its sites table; its tables may be gone">deleted</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y">
          {shown.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5 text-sm">
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">#{s.id}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.title}
                  {s.archived && <Badge tone="warning" title="Archived in Network Admin: visitors see that it is archived; a super admin can still open its wp-admin">archived</Badge>}
                  {s.spam && <Badge tone="danger" title="Marked as spam in Network Admin">spam</Badge>}
                  {s.hidden && <Badge title="Public is off: search engines are asked not to index it">hidden from search</Badge>}
                  {s.served === false && <Badge tone="warning" title="Its host is not in this site's vhost or /etc/hosts, so it does not open here">not served here</Badge>}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{s.url}</span>
              </span>
              <span className="flex gap-2">
                <ButtonLink size="sm" variant="soft" href={s.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open
                </ButtonLink>
                <Button size="sm" variant="soft" onClick={() => void openWpAdmin(site, { siteUrl: s.url })}>
                  <LogIn />
                  wp-admin
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">
        {type === 'subdirectory'
          ? 'Subdirectory network: every site is under a path of one domain, so one name in the certificate and the hosts block covers them all.'
          : `${NETWORK_TYPE_LABEL[type]} network: every site on a host of its own needs that host in this site's vhost, certificate and hosts block.`}
        {' '}New sites go {network.mode === 'subdomain' ? 'on subdomains' : 'under paths'} (SUBDOMAIN_INSTALL is {network.mode === 'subdomain' ? 'on' : 'off'} in wp-config.php).
        {' '}Search and replace runs with --network.
      </p>
      <SuperAdminsDialog site={site} open={admins} onClose={() => setAdmins(false)} />
    </Card>
  );
}

/** A network's super admins, each with how many sites they have a role on, and a button that gives one the administrator role on the rest. */
export function SuperAdminsDialog({ site, open, onClose }: { site: Site; open: boolean; onClose: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const list = useAsync(() => (open ? api.networkAdmins(site.domain, site.path) : Promise.resolve(null)), [open, refresh, site.domain, site.path]);
  const runner = useJob();
  const [open_, setOpen] = useState<string | null>(null);
  const lastDone = useRef<string | null>(null);
  const { job } = runner;
  const busy = job !== null && !settled(job);
  useEffect(() => {
    if (!job || !settled(job) || lastDone.current === job.id) return;
    lastDone.current = job.id;
    setRefresh((n) => n + 1);
  }, [job]);
  const data = list.data;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Super admins"
      description="A super admin manages every site of the network, but My Sites and plugins that look for the administrator role only see the sites where they have one. Make administrator adds that role where they have no role yet; roles they have stay, and Undo on the job takes them off the sites it added them to."
    >
      <div className="mt-4 grid gap-3">
        {list.loading && !data && <ListSkeleton rows={2} />}
        {list.error && <p role="alert" className="text-sm text-danger">{list.error}</p>}
        {data && data.admins.length === 0 && <p className="text-sm text-muted-foreground">This network has no super admins WP-CLI can find.</p>}
        {data && data.admins.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {data.admins.map((a) => (
              <li key={a.login} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.login}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.member >= data.sites ? `A role on all ${data.sites} sites` : `A role on ${a.member} of ${data.sites} sites`}
                  </span>
                </span>
                {a.member < data.sites ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void runner.follow(api.startJob('network.addAdmin', { ...siteTarget(site), user: a.login }))}>
                    {busy && job?.title.includes(` ${a.login} `) ? <Spinner /> : <ShieldCheck />}
                    Make administrator on {data.sites - a.member} more
                  </Button>
                ) : (
                  <Check className="size-4 text-success" />
                )}
              </li>
            ))}
          </ul>
        )}
        {job && <StepList steps={job.steps} open={open_} setOpen={setOpen} />}
        {job && settled(job) && job.undoable.length > 0 && (
          <p className="text-xs text-muted-foreground">
            To take it back, use Undo on <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-foreground hover:underline">the job&apos;s page</Link>.
          </p>
        )}
        {runner.error && <p role="alert" className="text-sm text-danger">{runner.error}</p>}
        <div className="flex justify-end">
          <Button variant="soft" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

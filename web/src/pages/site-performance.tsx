import type { Site } from '@devmagic-panel/shared';
import { Gauge } from 'lucide-react';
import { ProfilesCard } from '@/components/profiles-card';
import { ScopeLabel } from '@/components/scope-label';
import { SlowQueries } from '@/components/slow-queries';
import { CardsSkeleton } from '@/components/skeletons';
import { sqlSeedState } from '@/components/sql-runner';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { navigate } from '@/lib/router';
import { siteTarget } from '@/lib/site-ref';
import { useAsync } from '@/lib/use-async';
import { databaseHref } from '@/pages/site-database';

/**
 * Why a site is slow, in one place: Xdebug's profiles of its pages (where the
 * PHP time goes, by plugin and function) and the queries that cost its
 * database the most time.
 */
export function PerformanceTab({ site }: { site: Site }) {
  const target = siteTarget(site);
  const wordpress = site.core.kind !== 'none';
  const php = useAsync(() => (wordpress ? api.sitePhp(target.domain, target.path) : Promise.resolve(null)), [site.domain, site.path, wordpress]);
  const report = useAsync(() => (wordpress ? api.php() : Promise.resolve(null)), [wordpress]);
  const version = php.data ? (php.data.version ?? php.data.defaultVersion) : undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <p className="text-sm text-muted-foreground">Where a slow page spends its time: the PHP that runs for it, function by function, and the queries its database answers.</p>
      {wordpress &&
        (php.loading && !php.data ? (
          <CardsSkeleton reading="Reading the site's PHP version..." cards={[3]} columns={1} />
        ) : (
          <ProfilesCard site={site} version={version} xdebug={report.data?.versions.find((x) => x.version === version)?.xdebug} onXdebug={report.reload} />
        ))}
      {site.db && (
        <Card>
          <CardHeader>
            <CardTitle>Slow queries</CardTitle>
            <span className="flex items-center gap-2">
              <ScopeLabel>this site</ScopeLabel>
              <Gauge className="size-4 text-muted-foreground" />
            </span>
          </CardHeader>
          <div className="p-5">
            <SlowQueries inCard database={site.db.name} onExplain={(sql) => navigate(databaseHref(site, 'sql'), { scroll: false, state: sqlSeedState(sql) })} />
          </div>
        </Card>
      )}
    </div>
  );
}

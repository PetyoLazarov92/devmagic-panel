import type { Site } from '@devmagic-panel/shared';
import { Card, CardBody } from '@/components/ui/card';
import { TextLink } from '@/components/ui/text-link';
import { PhpTab } from '@/features/site/php';
import { ServerCard } from '@/features/site/server';
import { HtaccessCard } from '@/features/site/htaccess';
import { siteHref } from '@/lib/site-ref';
import { SERVER_NAME } from './site-shared';

/**
 * How the site is served: its web server first (Apache or nginx, and moving
 * it), then its PHP. A site under a path runs on its domain's server, so it
 * names it and links to where it changes.
 */
export function ServerAndPhpTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  return (
    <div className="grid gap-4">
      {site.path ? (
        <Card>
          <CardBody className="py-3.5">
            <p className="text-muted-foreground">
              Runs on <span className="font-medium text-foreground">{SERVER_NAME[site.server]}</span> with {site.domain}, like every site under it.{' '}
              <TextLink href={`${siteHref({ domain: site.domain })}?tab=php`}>Change it on {site.domain}</TextLink>
            </p>
          </CardBody>
        </Card>
      ) : (
        <ServerCard site={site} onChanged={onChanged} />
      )}
      {!site.path && site.server === 'nginx' && <HtaccessCard site={site} onChanged={onChanged} />}
      {site.core.kind !== 'none' && <PhpTab site={site} />}
    </div>
  );
}

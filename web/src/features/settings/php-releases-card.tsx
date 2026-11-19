import { Tag } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { TextLink } from '@/components/ui/text-link';
import { savePreferences, usePreferences } from '@/lib/preferences';

/**
 * Whether the panel reads php.net's list of PHP releases, so the PHP tab and
 * Machine checks say when one is out that apt's sources do not have yet: on
 * unless you switch it off. Only release versions come back; nothing is sent.
 */
export function PhpReleasesCard() {
  const { checkPhpReleases: on } = usePreferences();
  return (
    <Card>
      <CardHeader title="PHP releases" meta={<Tag className="size-4 text-muted-foreground" />} />
      <CardBody>
        <label className="flex items-start gap-3">
          <Switch checked={on} onChange={(v) => savePreferences({ checkPhpReleases: v })} label={on ? "Stop reading PHP's releases from php.net" : "Read PHP's releases from php.net"} />
          <span className="grid gap-1">
            <span className="font-medium">Compare your PHP with php.net&apos;s releases</span>
            <span className="text-xs text-muted-foreground">
              Twice a day the panel reads <TextLink href="https://www.php.net/releases/">php.net&apos;s list of releases</TextLink>, versions only, and nothing of yours is sent. Services, PHP and Machine checks then say when a release, a security fix above all, is out before apt&apos;s sources have it.
            </span>
          </span>
        </label>
      </CardBody>
    </Card>
  );
}

import type { Site } from '@devmagic-panel/shared';
import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { TextLink } from '@/components/ui/text-link';
import { runWithToast } from '@/lib/site-actions';
import { shortDate } from '@/lib/format';
import { takeoverHref } from '@/lib/site-ref';
import { Spinner } from '@/components/ui/spinner';

export function DomainsTab({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const names = [site.domain, ...site.aliases];
  const inCert = new Set(site.cert?.names ?? []);
  const missingHosts = new Set(site.notInHosts ?? []);
  const allCovered = names.every((n) => inCert.has(n));
  const [reissuing, setReissuing] = useState(false);

  async function reissue() {
    setReissuing(true);
    await runWithToast('cert.reissue', { domain: site.domain }, `Certificate reissued for ${site.domain}`);
    setReissuing(false);
    onChanged();
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Certificate" meta={<ShieldCheck className="size-4 text-muted-foreground" />} />
        <CardBody className="flex flex-wrap items-center justify-between">
          <div className="grid gap-1">
            <p>
              {site.cert?.issuer === 'legacy' ? (
                <Badge tone="warning">Old LocalhostCA</Badge>
              ) : (
                <Badge tone="success">devmagic-panel CA</Badge>
              )}
              <span className="ml-2 text-muted-foreground">valid until {site.cert ? shortDate(site.cert.expiresAt) : 'unknown'}</span>
            </p>
            <p className="text-muted-foreground">
              Covers {inCert.size} of {names.length} names{allCovered ? '' : ', reissue to cover all of them'}.
            </p>
          </div>
          <Button variant={allCovered && site.cert?.issuer !== 'legacy' ? 'outline' : 'default'} disabled={reissuing} onClick={() => void reissue()}>
            {reissuing ? <Spinner /> : <RefreshCw />}
            Reissue certificate
          </Button>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 font-medium">Domain</th>
              <th className="px-3 py-2.5 text-center font-medium">In cert</th>
              <th className="px-3 py-2.5 text-center font-medium">In hosts</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {names.map((name, i) => (
              <tr key={name}>
                <td className="px-5 py-2.5 font-mono text-dense">
                  {name}
                  {i === 0 && <Badge className="ml-2 font-sans">primary</Badge>}
                </td>
                <td className="px-3 py-2.5 text-center"><Yes ok={inCert.has(name)} /></td>
                <td className="px-3 py-2.5 text-center"><Yes ok={!missingHosts.has(name)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {site.vhostManaged ? (
        <p className="text-xs text-muted-foreground">
          One certificate, one {site.server === 'nginx' ? 'nginx site' : 'vhost'} and one hosts line cover all of these names. Add or remove domains and the panel updates all three together.
        </p>
      ) : (
        <Notice tone="info" icon={false} className="py-2.5">
          This vhost was set up outside the panel, so the panel leaves <code className="font-mono text-dense">{site.domain}-ssl.conf</code> as it is.
          It still reissues the certificate and keeps the hosts line in its block. To change the domains, edit the vhost by hand, or{' '}
          <TextLink href={takeoverHref(site)}>take it over</TextLink> and the panel manages them like its own sites'.
        </Notice>
      )}
    </div>
  );
}

export function Yes({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="mx-auto size-4 text-success" aria-label="Yes" />
  ) : (
    <X className="mx-auto size-4 text-danger" aria-label="No" />
  );
}

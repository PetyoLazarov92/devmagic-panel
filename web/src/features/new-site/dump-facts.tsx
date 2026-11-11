import type { DumpFacts } from '@devmagic-panel/shared';
import { DUMP_SCAN_GB, networkType } from '@devmagic-panel/shared';
import type { ReactNode } from 'react';
import { Card, CardBody } from '@/components/ui/card';
import { KeyValue, type KeyValueRow } from '@/components/ui/key-value';
import { cn } from '@/lib/utils';

/** A network in WordPress's words: how many sites, and subdirectory, subdomain or a mix. */
export function networkSummary(facts: DumpFacts): string {
  if (!facts.multisite) return 'no';
  const sites = facts.sites ?? [];
  if (sites.length === 0) return 'yes';
  const count = `${sites.length} site${sites.length === 1 ? '' : 's'}`;
  const type = networkType(sites);
  if (type === null) return `1 site on ${sites[0]?.domain ?? ''}`;
  if (type === 'subdirectory') return `subdirectory, ${count} on ${sites[0]?.domain ?? ''}`;
  if (type === 'subdomain') return `subdomain, ${count}`;
  const underPath = sites.filter((s) => s.id !== 1 && s.path !== '/').length;
  return `mixed, ${count}: ${sites.length - 1 - underPath} subdomain, ${underPath} subdirectory`;
}

/** The first few names and how many more. */
const someOf = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

/**
 * What the panel read from a dump without importing it, the same in every
 * install that takes one: a long value is cut with its full text on hover,
 * so the card never grows past its column.
 */
export function DumpFactsCard({ facts, className, children }: { facts: DumpFacts | null; className?: string; children?: ReactNode }) {
  const admins = facts ? (facts.multisite ? facts.superAdmins : facts.admins) : undefined;
  const rows: KeyValueRow[] = facts
    ? [
        { label: 'Table prefix', value: <code className="font-mono">{facts.tablePrefix ?? 'not found'}</code> },
        { label: 'Site URL', value: <code className="block truncate font-mono" title={facts.home ?? facts.siteUrl}>{facts.home ?? facts.siteUrl ?? 'not found'}</code> },
        { label: 'Domains', value: facts.hosts.length },
        { label: 'Multisite', value: networkSummary(facts) },
        { label: facts.multisite ? 'Super admins' : 'Admins', key: 'admins', value: admins === undefined ? 'not read' : admins.length ? someOf(admins) : 'none' },
        { label: 'DB version', value: facts.dbVersion ?? 'not found' },
      ]
    : [];
  return (
    <Card className={cn('h-fit min-w-0 bg-muted/40', className)}>
      <CardBody compact>
        <p className="font-medium">Found in the dump</p>
        {facts ? (
          <>
            <KeyValue rows={rows} />
            {facts.partial && <p className="text-xs text-muted-foreground">Very large dump: only its first {DUMP_SCAN_GB} GB were read, so its admins are not known.</p>}
          </>
        ) : (
          <p className="text-muted-foreground">Add a dump and the panel reads its table prefix, addresses, network and WordPress version, then suggests the rest.</p>
        )}
        {children}
      </CardBody>
    </Card>
  );
}

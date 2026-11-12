import type { Site, WporgBlock, WporgDetails, WporgInline } from '@devmagic-panel/shared';
import { ArrowUpCircle, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { Reading } from '@/components/layout/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { KeyValue, type KeyValueRow } from '@/components/ui/key-value';
import { Notice } from '@/components/ui/notice';
import { Tabs } from '@/components/ui/tabs';
import { TextLink } from '@/components/ui/text-link';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { compareVersions } from '@/lib/version-compare';
import { type CompatLine, compatLines } from '@/lib/wporg-compat';

/** The plugin or theme a details dialog is for: its WordPress.org slug, its name here, the version installed and the update WordPress found. */
export interface DetailsTarget {
  kind: 'plugin' | 'theme';
  slug: string;
  title: string;
  installed: string;
  update?: string | undefined;
}

type Section = 'changelog' | 'description' | 'installation' | 'faq';
const SECTION_LABEL: Record<Section, string> = { changelog: 'Changelog', description: 'Description', installation: 'Installation', faq: 'FAQ' };
/** Versions shown before Show older versions. */
const FIRST_VERSIONS = 6;

/**
 * What wp-admin calls "View version details", from WordPress.org: the changelog (open first,
 * the versions this update brings marked), description, installation and FAQ, and beside them
 * the facts, with the PHP and WordPress versions it needs next to the site's own. The text is
 * the panel's own reading of WordPress.org's HTML (wporg-details.ts): nothing of it runs here.
 */
export function PluginDetailsDialog({ site, target, onClose, onUpdate, updating }: {
  site: Site;
  target: DetailsTarget | null;
  onClose: () => void;
  /** Update to the version found, from the dialog's footer. */
  onUpdate?: () => void;
  updating?: boolean;
}) {
  const details = useAsync(() => (target ? api.wporgDetails(target.kind, target.slug) : Promise.resolve(null)), [target?.kind, target?.slug]);
  const data = details.data && target && details.data.slug === target.slug ? details.data : null;
  const sections = data ? (['changelog', 'description', 'installation', 'faq'] as const).filter((s) => (s === 'changelog' ? data.changelog.length > 0 : data[s].length > 0)) : [];
  const [tab, setTab] = useState<Section>('changelog');
  useEffect(() => {
    if (sections.length && !sections.includes(tab)) setTab(sections[0] as Section);
  }, [sections.join(), tab]);
  useEffect(() => setTab('changelog'), [target?.slug]);

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="lg"
      title={target ? data?.name ?? target.title : ''}
      description={target ? `${target.installed} installed${target.update ? ` · ${target.update} available` : ''}` : undefined}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="soft" onClick={onClose}>Close</Button>
          {target?.update && onUpdate && (
            <Button disabled={updating} onClick={onUpdate}>
              <ArrowUpCircle />
              Update to {target.update}
            </Button>
          )}
        </div>
      }
    >
      {!data && details.loading && <Reading>Reading the details from WordPress.org...</Reading>}
      {!data && details.error && !details.loading && <Notice>{details.error}</Notice>}
      {data && target && (
        <div className="grid gap-4">
          {sections.length > 1 && <Tabs size="sm" label="Details" value={tab} onChange={setTab} items={sections.map((s) => ({ value: s, label: SECTION_LABEL[s] }))} />}
          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="min-w-0">
              {tab === 'changelog' && sections.includes('changelog') ? (
                <Changelog details={data} installed={target.installed} update={target.update} />
              ) : (
                <Blocks blocks={sections.includes(tab) && tab !== 'changelog' ? data[tab] : []} />
              )}
              {sections.length === 0 && <p className="text-sm text-muted-foreground">WordPress.org has no description or changelog for it.</p>}
            </div>
            <Facts details={data} site={site} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** The changelog by version: those after the installed one, up to the update, in a box of their own; then the rest, the older ones folded. */
function Changelog({ details, installed, update }: { details: WporgDetails; installed: string; update?: string | undefined }) {
  const [all, setAll] = useState(false);
  const isNew = (v: string) => v !== '' && compareVersions(v, installed) > 0 && (!update || compareVersions(v, update) <= 0);
  const fresh = details.changelog.filter((v) => isNew(v.version));
  const rest = details.changelog.filter((v) => !isNew(v.version));
  const shown = all ? rest : rest.slice(0, Math.max(0, FIRST_VERSIONS - fresh.length));
  const head = (version: string, note?: string, extra?: ReactNode) => (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
      {version}
      {note && <span className="text-xs font-normal text-muted-foreground">{note}</span>}
      {extra}
    </p>
  );
  return (
    <div className="grid gap-4">
      {fresh.length > 0 && (
        <Notice tone="info" icon={false}>
          <div className="grid gap-3">
            {fresh.map((v, i) => (
              <div key={v.version} className="grid gap-1.5">
                {head(v.version, v.note, i === 0 && <Badge tone="primary">new in this update</Badge>)}
                <Blocks blocks={v.blocks} />
              </div>
            ))}
          </div>
        </Notice>
      )}
      {shown.map((v) => (
        <div key={`${v.version}-${v.note ?? ''}`} className="grid gap-1.5 text-muted-foreground">
          {v.version && head(v.version, v.note, v.version === installed && <span className="text-xs font-normal">installed</span>)}
          <Blocks blocks={v.blocks} />
        </div>
      ))}
      {!all && rest.length > shown.length && (
        <Button size="sm" variant="soft" className="justify-self-start" onClick={() => setAll(true)}>
          Show {rest.length - shown.length} older version{rest.length - shown.length === 1 ? '' : 's'}
        </Button>
      )}
    </div>
  );
}

/** Blocks as the server read them: never HTML, so nothing from WordPress.org runs. */
function Blocks({ blocks }: { blocks: WporgBlock[] }) {
  return (
    <div className="grid gap-2 text-sm">
      {blocks.map((b, i) => {
        if (b.kind === 'pre') return <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre">{b.text}</pre>;
        if ('parts' in b) return <p key={i} className={b.kind === 'h' ? 'mt-1 font-semibold text-foreground' : 'whitespace-pre-line'}><Inline parts={b.parts} /></p>;
        const List = b.kind === 'ol' ? 'ol' : 'ul';
        return (
          <List key={i} className={cn('grid gap-1 pl-5', b.kind === 'ol' ? 'list-decimal' : 'list-disc')}>
            {b.items.map((item, j) => <li key={j} className="whitespace-pre-line"><Inline parts={item} /></li>)}
          </List>
        );
      })}
    </div>
  );
}

function Inline({ parts }: { parts: WporgInline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        let node: ReactNode = p.text;
        if (p.code) node = <code className="rounded bg-muted px-1 font-mono text-dense">{node}</code>;
        if (p.italic) node = <em>{node}</em>;
        if (p.bold) node = <strong className="font-semibold">{node}</strong>;
        if (p.href && /^https?:\/\//i.test(p.href)) node = <TextLink href={p.href}>{node}</TextLink>;
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

const TONE_ICON: Record<CompatLine['tone'], ReactNode> = {
  ok: <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />,
  warning: <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />,
  danger: <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />,
  plain: null,
};

/** "3+ million", "10,000+": as WordPress.org rounds its installs. */
const installs = (n: number) => (n >= 1_000_000 ? `${Math.floor(n / 1_000_000)}+ million` : `${n.toLocaleString('en')}+`);
/** WordPress.org's "2026-11-10 3:22pm GMT" as "3 days ago", or as it is. */
const updatedAgo = (text: string) => {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  return day ? timeAgo(`${day}T12:00:00Z`) : text;
};

/** The facts beside the text, what it needs next to what the site has. */
function Facts({ details, site }: { details: WporgDetails; site: Site }) {
  const compat = compatLines(details, { wordpress: site.core.version, php: site.php?.version });
  const toned = (value: ReactNode, tone: CompatLine['tone']) => (
    <span className={cn('flex items-start gap-1.5', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>
      {TONE_ICON[tone]}
      <span className="min-w-0">{value}</span>
    </span>
  );
  const rows: KeyValueRow[] = [
    { label: 'Version', value: details.version },
    ...(details.lastUpdated ? [{ label: 'Last updated', value: updatedAgo(details.lastUpdated) }] : []),
    ...compat.map((c) => ({ label: c.label, value: toned(c.value, c.tone) })),
    ...(details.activeInstalls ? [{ label: 'Active installs', value: installs(details.activeInstalls) }] : []),
    ...(details.rating !== undefined && details.numRatings ? [{ label: 'Rating', value: `${(details.rating / 20).toFixed(1)} of 5 · ${details.numRatings.toLocaleString('en')} ratings` }] : []),
  ];
  return (
    <div className="grid content-start gap-3 sm:border-l sm:pl-4">
      <KeyValue layout="stacked" rows={rows} />
      <TextLink href={details.page} className="text-sm">WordPress.org page</TextLink>
    </div>
  );
}

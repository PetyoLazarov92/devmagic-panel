import { Database, Download, MoreHorizontal, Plug, RefreshCw, Server, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CheckAgain, PageHeader, ViewBar } from '@/components/page';
import { ScopeLabel } from '@/components/scope-label';
import { Badge, CountBadge, StatusBadge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader, CardSection } from '@/components/ui/card';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { FilterBar, FilterChips } from '@/components/ui/filter-chips';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { KeyValue } from '@/components/ui/key-value';
import { ListRow, RowList } from '@/components/ui/list-row';
import { EmptyState, Notice } from '@/components/ui/notice';
import { SectionLayout } from '@/components/ui/section-nav';
import { Segmented } from '@/components/ui/segmented';
import { SettingRow } from '@/components/ui/setting-row';
import { Spinner } from '@/components/ui/spinner';
import { StatTile, StatTiles } from '@/components/ui/stat-tile';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { TextLink } from '@/components/ui/text-link';

/**
 * Only in the mockup: every part the screens are made of, with the rule for where it goes.
 * The reference for a change to the web app; see the Components section of ui-ux.mdc.
 */
export function UiKitPage() {
  const [tab, setTab] = useState<'overview' | 'logs' | 'files'>('overview');
  const [view, setView] = useState<'overview' | 'tables' | 'sql'>('tables');
  const [filter, setFilter] = useState<'all' | 'on' | 'off' | 'updates'>('all');
  const [mode, setMode] = useState<'compact' | 'details'>('compact');
  const [on, setOn] = useState(true);
  const [tick, setTick] = useState(false);
  return (
    <div className="grid gap-8 pt-4">
      <div className="grid gap-3">
        <Breadcrumbs items={[{ label: 'Mockup', href: '/mockup' }, { label: 'Parts' }]} />
        <PageHeader title="Parts" intro="Every part the panel's screens are made of, and where each one goes. A page uses these, never its own copy." actions={<CheckAgain onClick={() => undefined} />} />
      </div>

      <Section title="Type and colour" rule="text-2xl page titles, text-sm body, text-dense for dense rows and code, text-xs captions, text-2xs only in badges and counts. Colour only for status; the accent for the one main action and links.">
        <Card>
          <CardBody>
            <p className="text-2xl font-semibold tracking-tight">Page title, text-2xl</p>
            <p className="text-sm font-semibold">Card title, text-sm semibold</p>
            <p className="text-sm">Body, text-sm: what a card says.</p>
            <p className="font-mono text-dense">text-dense: wp-content/themes/wandworks, a slug, a row</p>
            <p className="text-xs text-muted-foreground">Caption, text-xs: when it was read, a hint.</p>
            <div className="flex flex-wrap gap-2">
              <Badge>neutral</Badge>
              <Badge tone="primary">primary</Badge>
              <Badge tone="success">success</Badge>
              <Badge tone="warning">warning</Badge>
              <Badge tone="danger">danger</Badge>
            </div>
          </CardBody>
        </Card>
      </Section>

      <Section title="Buttons and links" rule="One primary (solid) button per page header or card, then outline, then soft (a light fill) for the rest. Ghost only for icon buttons and toolbars. Danger only inside a confirm. A link goes somewhere, a button does something.">
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center gap-2">
              <Button>Main action</Button>
              <Button variant="outline">Second action</Button>
              <Button variant="soft">Third action</Button>
              <Button variant="danger"><Trash2 />Delete, in a confirm</Button>
              <Button size="sm" variant="outline"><Download />Small</Button>
              <Button size="xs" variant="outline">Extra small</Button>
              <IconButton icon={MoreHorizontal} label="More actions" />
              <Button disabled><Spinner />Working...</Button>
            </div>
            <p>
              In text: <TextLink href="/sites">Sites</TextLink>, quiet: <TextLink href="/aura" tone="muted">Aura</TextLink>, out of the panel:{' '}
              <TextLink href="https://wordpress.org/plugins/">WordPress.org</TextLink>, and a way out of a card: <TextLink href="/services" arrow>Open Services</TextLink>
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section title="Navigation" rule="Breadcrumbs above every page below the menu's top level. Tabs are level 1, small tabs level 2 (a tab's views). A detail page's sections are its side menu. Segmented only switches how the same thing shows.">
        <Card>
          <CardBody>
            <Breadcrumbs items={[{ label: 'Sites', href: '/sites' }, { label: 'local.spellbook.example', href: '/sites/local.spellbook.example' }, { label: 'Database' }]} />
            <Tabs
              items={[{ value: 'overview', label: 'Overview' }, { value: 'logs', label: 'Logs', count: 4, tone: 'danger' }, { value: 'files', label: 'Files' }]}
              value={tab}
              onChange={setTab}
            />
            <Tabs size="sm" items={[{ value: 'overview', label: 'Overview' }, { value: 'tables', label: 'Tables' }, { value: 'sql', label: 'SQL' }]} value={view} onChange={setView} />
            <Segmented label="How plugins show" value={mode} onChange={setMode} options={[['compact', 'Compact'], ['details', 'Details']]} className="justify-self-start" />
          </CardBody>
        </Card>
        <SectionLayout
          label="Site sections"
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'logs', label: 'Logs', count: 4, tone: 'danger' },
            { value: 'files', label: 'Files' },
          ]}
          value={tab}
          onChange={setTab}
        >
          <Card>
            <CardHeader title="The section's content" meta={<ScopeLabel>this site</ScopeLabel>} />
            <CardBody>A detail page's sections run down its side on a wide screen and turn into tabs on a narrow one.</CardBody>
          </Card>
        </SectionLayout>
      </Section>

      <Section title="Lists and filters" rule="A list is one card of rows over a FilterBar: search first, counted filters, then pickers at its end. Rows: something at the start, name and a line under it, badges, actions and a menu.">
        <FilterBar
          search={<Input placeholder="Find a plugin" aria-label="Find a plugin" className="h-9" />}
          end={<Segmented label="How plugins show" value={mode} onChange={setMode} options={[['compact', 'Compact'], ['details', 'Details']]} />}
        >
          <FilterChips
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[{ value: 'all', label: 'All', count: 13 }, { value: 'on', label: 'On', count: 7 }, { value: 'off', label: 'Off', count: 4 }, { value: 'updates', label: 'Updates', count: 3, tone: 'warning' }]}
          />
        </FilterBar>
        <Card>
          <CardBody flush>
            <RowList label="Plugins">
              <ListRow leading={<Switch checked={on} onChange={setOn} label="Turn off Wand Forms" />} title="Wand Forms" sub={<span className="font-mono">wand-forms 2.4.1</span>} badges={<Badge tone="warning">2.5.0 available</Badge>} actions={<IconButton icon={MoreHorizontal} label="More for Wand Forms" size="icon-sm" />} />
              <ListRow leading={<Plug className="size-4 text-muted-foreground" />} title="Spellbook Blocks" sub={<span className="font-mono">spellbook-blocks 1.3.0</span>} badges={<Badge tone="primary">Local helper</Badge>} actions={<Button size="sm" variant="outline">Open folder</Button>} />
            </RowList>
          </CardBody>
        </Card>
      </Section>

      <Section title="Cards" rule="A card is one task or fact: a header with one thing on its right (a scope, a status or a count), a body, titled sections inside, and a footer with its buttons on the left and the way out on the right. A job shows in the footer of the card that started it.">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Apache" description="Serves every site on this machine." meta={<StatusBadge status="ok" />} />
            <CardBody>
              <KeyValue rows={[{ label: 'Version', value: 'Apache/2.4.58' }, { label: 'Sites', value: '12' }, { label: 'Config', value: <span className="font-mono text-dense">/etc/apache2</span> }]} />
            </CardBody>
            <CardFooter end={<TextLink href="/services/apache" arrow>Open Apache</TextLink>}>
              <Button size="sm" variant="outline"><RefreshCw />Reload</Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader title="Import a database" meta={<ScopeLabel>this site</ScopeLabel>} />
            <CardBody>
              <p className="text-muted-foreground">From production&apos;s saved server, or a dump from any source.</p>
              <Notice tone="warning" size="inline">The current database is backed up first, and Undo puts it back.</Notice>
            </CardBody>
            <CardFooter>
              <Button size="sm"><Database />Import</Button>
              <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5 text-primary" />Importing, step 3 of 5</span>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader title="Settings" meta={<ScopeLabel>all sites</ScopeLabel>} />
            <CardSection title="Mail" description="Where the sites' mail goes.">
              <SettingRow title="Send mail to Mailpit" description="Nothing leaves this computer." control={<Switch checked={on} onChange={setOn} label="Send mail to Mailpit" />} />
            </CardSection>
            <CardSection title="Defaults">
              <Field label="PHP for new sites" htmlFor="ui-php">
                <Select id="ui-php" defaultValue="8.3"><option value="8.3">PHP 8.3</option><option value="8.2">PHP 8.2</option></Select>
              </Field>
              <Checkbox id="ui-tick" checked={tick} onChange={setTick} label="Turn on Local mode" hint="Mail to Mailpit, noindex, a Local label." />
            </CardSection>
          </Card>
          <Card>
            <CardHeader title="Facts, stacked" meta={<CountBadge count={3} tone="warning" />} />
            <CardBody>
              <KeyValue layout="stacked" rows={[{ label: 'Folder', value: <span className="font-mono text-dense">/var/www/local.spellbook.example</span> }, { label: 'Repository', value: <TextLink href="https://github.com/wandworks/site">wandworks/site</TextLink> }]} />
            </CardBody>
          </Card>
        </div>
      </Section>

      <Section title="Tiles" rule="A row of numbers at the top of an overview: label, value, a line in the tone of what it says. A tile opens the tab or card with the rest.">
        <StatTiles>
          <StatTile label="Database" value="296 MB" sub="402 tables" href="/sites/local.spellbook.example?tab=database" />
          <StatTile label="WP-Cron" value="7 events" sub="2 late" tone="warning" />
          <StatTile label="Debug" value="Log only" sub="4 errors" tone="danger" />
          <StatTile label="SSL" value="1 name" sub="Until January" tone="success" />
        </StatTiles>
      </Section>

      <Section title="Notices and empty states" rule="The only tinted boxes. One tone per box, right under the header or bar it is about; inline inside a card. An empty state says what would be here and how to get it.">
        <Notice tone="danger">3 PHP fatal errors in the last hour.</Notice>
        <Notice tone="warning" action={<Button size="sm" variant="outline">Reissue cert</Button>}>The cert is still signed by the old LocalhostCA.</Notice>
        <Notice tone="success">The database is imported.</Notice>
        <Notice tone="info">Tables WordPress makes that this database lacks: wp_termmeta.</Notice>
        <EmptyState icon={Server} title="No sites on nginx" action={<Button variant="outline">Set up nginx</Button>}>Sites move to nginx from their Server tab once nginx runs next to Apache.</EmptyState>
      </Section>

      <Section title="Bars" rule="A view's bar: what it is about on the left, Check again on the right, when it was read under it.">
        <ViewBar onCheck={() => undefined} checkedAt={new Date(Date.now() - 120_000).toISOString()} note="Tables starting wp_ in spellbook.">
          <Select aria-label="Site of the network" wrapClassName="w-64"><option>/ (main site), wp_</option></Select>
        </ViewBar>
      </Section>
    </div>
  );
}

function Section({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{rule}</p>
      </div>
      {children}
    </section>
  );
}

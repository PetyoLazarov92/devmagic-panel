import type { NginxState, Site } from '@devmagic-panel/shared';
import { localDomainFor } from '@devmagic-panel/shared';
import { ArrowRight, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { TextLink } from '@/components/ui/text-link';
import { installLabel } from '@/components/layout/site-bits';
import { NetworkSection } from './network';
import { Input } from '@/components/ui/input';
import { takeoverHref } from '@/lib/site-ref';
import { type NetworkPlan, NO_NETWORK_ANSWERS } from '@/lib/network';
import { cn } from '@/lib/utils';
import { type DomainRow, type Setter, type WizardState } from './wizard-shared';
import { cleanAddress, cleanPath } from './wizard-state';

// ── Domains ──────────────────────────────────────────────────

export function DomainsStep({ state, set, nginx, errors, sites, underError, underFolder, existing, network, networkErrors, summary }: {
  state: WizardState;
  set: Setter;
  /** Whether nginx runs next to Apache; null while it is read. */
  nginx: NginxState | null;
  /** What the replace step will change, or null when the dump already answers here. */
  summary?: string | null;
  errors: Array<string | null>;
  /** The dump's network as it will run here, and errors on its sites the page knows, by blog id. */
  network: NetworkPlan | null;
  networkErrors: Map<number, string>;
  sites: Site[];
  underError: string | null;
  underFolder: string | null;
  /** The site the primary domain belongs to already, if any. */
  existing: Site | undefined;
}) {
  const fromDump = state.source === 'repo' && !state.noDump;
  const under = state.source !== 'empty' ? state.under : null;
  const facts = state.upload?.facts;
  const update = (i: number, row: Partial<DomainRow>) => set('domains', state.domains.map((d, j) => (j === i ? { ...d, ...row } : d)));
  // Where an address came from, shown under its row.
  const hostOf = (url?: string) => {
    try {
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  };
  const sourceOf = (prod: string) =>
    !facts || !prod ? null : hostOf(facts.home) === prod ? `home in the dump: ${facts.home}` : hostOf(facts.siteUrl) === prod ? `siteurl in the dump: ${facts.siteUrl}` : facts.sites?.some((x) => x.domain === prod) ? 'a site of the network' : null;

  // A network's site list needs the room of a table.
  return (
    <div className={cn('grid gap-4', network ? 'max-w-5xl' : 'max-w-3xl')}>
      <p className="text-sm text-muted-foreground">
        {under
          ? `The site answers at its parent's domain and the path${fromDump ? ', so every address the database uses is replaced with that domain' : ''}. The parent's certificate and hosts line already cover it.`
          : <>
              {fromDump
                ? 'Each address the database uses maps to a local one: production, staging or another local copy. Search and replace runs for every pair; the first local domain is the primary.'
                : 'The first domain is the primary. Add aliases for other languages or brands that share this site.'}{' '}
              One certificate, one vhost and one hosts line cover all of them.
            </>}
      </p>
      {state.source !== 'empty' && !(fromDump && facts?.multisite) && <UnderPath state={state} set={set} sites={sites} error={underError} folder={underFolder} />}
      {fromDump && facts?.multisite && (
        <p className="text-xs text-muted-foreground">
          A multisite network needs a domain of its own, so it is not installed under a path of another site.
          {facts.domainMapping && ' Its sites get their domains from a domain mapping plugin\'s own table: they keep them, and those domains are replaced like the others above.'}
        </p>
      )}
      {fromDump && facts?.multisite && facts.sites && !network && !facts.domainMapping && <NetworkNote sites={facts.sites} />}
      <div className="grid gap-2">
        <div className={cn('hidden gap-3 px-1 text-xs font-medium text-muted-foreground', !(under && !fromDump) && 'sm:grid', fromDump ? 'grid-cols-[minmax(0,1fr)_1.4rem_minmax(0,1fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_2rem]')}>
          {fromDump && <span>In the database</span>}
          {fromDump && <span />}
          <span>Local address</span>
          <span />
        </div>
        {(under && !fromDump ? [] : state.domains).map((d, i) => {
          const same = fromDump && !under && cleanAddress(d.prod) !== '' && cleanAddress(d.prod) === cleanAddress(d.local, false);
          const source = fromDump ? sourceOf(cleanAddress(d.prod)) : null;
          return (
            <div key={i} className={cn('grid items-start gap-3', fromDump ? 'sm:grid-cols-[minmax(0,1fr)_1.4rem_minmax(0,1fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_2rem]')}>
              {fromDump && (
                <div>
                  <Input
                    value={d.prod}
                    aria-label={`Address in the database ${i + 1}`}
                    onChange={(e) => update(i, { prod: e.target.value, local: d.local || localDomainFor(cleanAddress(e.target.value)) })}
                    // A pasted URL keeps only its address: no scheme, path or trailing slash.
                    onBlur={() => update(i, { prod: cleanAddress(d.prod) })}
                    placeholder="www.example.com"
                    className="font-mono text-dense"
                    spellCheck={false}
                  />
                  {source && <p className="mt-1 truncate text-xs text-muted-foreground" title={source}>{source}</p>}
                </div>
              )}
              {fromDump && <ArrowRight className="mt-3 hidden size-4 text-muted-foreground sm:block" />}
              {under ? (
                <p className="flex h-10 items-center rounded-md border border-teal-500/45 bg-teal-500/[0.04] px-3 font-mono text-dense text-muted-foreground dark:border-teal-400/40">
                  {under.domain || 'the site below'}{cleanPath(under.path)}
                </p>
              ) : (
              <div>
                <div className="relative">
                  <Input
                    value={d.local}
                    aria-label={`Local domain ${i + 1}`}
                    aria-invalid={errors[i] ? true : undefined}
                    onChange={(e) => update(i, { local: e.target.value.toLowerCase().trim() })}
                    onBlur={() => update(i, { local: cleanAddress(d.local, false) })}
                    placeholder="local.example.com"
                    spellCheck={false}
                    // The name this site gets here: tinted so it reads as the one being set; the primary badge keeps its room.
                    className={cn('font-mono text-dense', i === 0 && d.local && 'pr-20', errors[i] ? 'border-danger' : 'border-teal-500/45 bg-teal-500/[0.04] focus-visible:border-teal-500 dark:border-teal-400/40 dark:bg-teal-400/[0.05]')}
                  />
                  {i === 0 && d.local && <Badge className="absolute top-1/2 right-2 -translate-y-1/2">primary</Badge>}
                </div>
                {errors[i] && <p className="mt-1 text-xs text-danger">{errors[i]}</p>}
                {!errors[i] && same && <p className="mt-1 text-xs text-muted-foreground">Same as the database address, nothing to replace</p>}
              </div>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove domain ${i + 1}`}
                disabled={state.domains.length === 1}
                onClick={() => set('domains', state.domains.filter((_, j) => j !== i))}
                className="mt-0.5 size-9"
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>
      {!(under && !fromDump) && (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => set('domains', [...state.domains, { prod: '', local: '' }])}>
          <Plus />
          {under ? 'Add an address' : 'Add domain'}
        </Button>
      )}
      {network && facts && (
        <NetworkSection facts={facts} plan={network} main={cleanAddress(state.domains[0]?.local ?? '', false)} answers={state.network ?? NO_NETWORK_ANSWERS} errors={networkErrors} onChange={(answers) => set('network', answers)} nothingChanges={summary === null} />
      )}
      {existing && <ReinstallNote site={existing} state={state} set={set} />}
      {nginx?.setUp && !under && <ServerChoice state={state} set={set} php={nginx.php} />}
      {fromDump && state.upload && <ReplaceOptions state={state} set={set} summary={summary ?? null} />}
    </div>
  );
}

/** The web server of the new site, once nginx runs next to Apache; a site can move later on its Server and PHP tab. */
export function ServerChoice({ state, set, php }: { state: WizardState; set: Setter; php: string | undefined }) {
  const choices = [
    { value: 'apache', label: 'Apache', hint: 'Reads .htaccess, as most WordPress hosts run it' },
    { value: 'nginx-apache', label: 'nginx + Apache', hint: 'nginx in front, Apache behind it reads .htaccess, like hosts that run both' },
    { value: 'nginx', label: 'nginx', hint: php ? `PHP through PHP-FPM ${php}; .htaccess is not read` : 'Needs PHP-FPM for the default PHP version: install it on Services, PHP' },
  ] as const;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Web server</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {choices.map((c) => (
          <label key={c.value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', state.server === c.value && 'border-primary/50 bg-primary/5', c.value === 'nginx' && !php && 'cursor-not-allowed opacity-60')}>
            <input type="radio" name="web-server" checked={state.server === c.value} disabled={c.value === 'nginx' && !php} onChange={() => set('server', c.value)} className="mt-0.5 accent-[var(--primary)]" />
            <span className="grid gap-0.5">
              <span className="font-medium">{c.label}</span>
              <span className="text-xs text-muted-foreground">{c.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Pick what the site runs on in production. It can move later, on its Server and PHP tab.</p>
    </fieldset>
  );
}

/** The primary domain is a site already: installing again archives it first, once you tick it. */
export function ReinstallNote({ site, state, set }: { site: Site; state: WizardState; set: Setter }) {
  return (
    <Notice tone="warning">
      <div className="grid gap-3">
        <p className="font-medium">{site.domain} is installed already</p>
        <p className="text-muted-foreground">
          {installLabel(site.install)}.{' '}
          {site.removable
            ? 'Installing again archives it first, with its folder, vhost, certificate and database. Restore it from Removed sites on the Sites page for 14 days, or with Undo on the install.'
            : 'The panel cannot archive it first: its folder or vhost is not in the usual place. Remove it by hand, or pick another domain.'}
        </p>
        {site.removable && (
          <Checkbox
            id="replace-existing"
            checked={state.replaceExisting}
            onChange={(v) => set('replaceExisting', v)}
            label={`Archive ${site.domain} and install it again`}
          />
        )}
      </div>
    </Notice>
  );
}

/**
 * Install under a path of an existing site: its own folder and database,
 * served at the site's domain and the path by the site's vhost.
 */
export function UnderPath({ state, set, sites, error, folder }: { state: WizardState; set: Setter; sites: Site[]; error: string | null; folder: string | null }) {
  const parents = sites.filter((s) => !s.path).sort((a, b) => a.domain.localeCompare(b.domain));
  const parent = parents.find((s) => s.domain === state.under?.domain);
  // The path the dump's site lives at (its home address), to warn when it differs: only the domain gets replaced.
  let dumpPath: string | null = null;
  try {
    if (state.source === 'repo' && state.upload?.facts.home) dumpPath = cleanPath(new URL(state.upload.facts.home).pathname);
  } catch {
    dumpPath = null;
  }
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
      <Checkbox
        id="under"
        checked={state.under !== null}
        onChange={(on) => set('under', on ? { domain: '', path: '' } : null)}
        label="Install under a path of an existing site"
        hint="Like Spellbook Learn at local.spellbook.example/learn: its own folder, database and git, served by that site's vhost."
      />
      {state.under && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Site" htmlFor="under-site">
            <Select id="under-site" value={state.under.domain} onChange={(e) => set('under', { ...(state.under as { domain: string; path: string }), domain: e.target.value })}>
              <option value="">Pick a site</option>
              {parents.map((s) => <option key={s.domain} value={s.domain}>{s.domain}</option>)}
            </Select>
          </Field>
          <Field label="Path" htmlFor="under-path">
            <Input
              id="under-path"
              value={state.under.path}
              onChange={(e) => set('under', { ...(state.under as { domain: string; path: string }), path: e.target.value })}
              onBlur={() => set('under', { ...(state.under as { domain: string; path: string }), path: cleanPath(state.under?.path ?? '') })}
              placeholder="/learn"
              className="font-mono text-dense"
              spellCheck={false}
            />
          </Field>
          <p className={cn('text-xs sm:col-span-2', error ? 'text-danger' : 'text-muted-foreground')}>
            {error ?? (folder && parent ? `At https://${parent.domain}${cleanPath(state.under.path)}/, in /var/www/${folder}.` : 'Pick the site and the path.')}
            {!error && parent && !parent.vhostManaged && <> Its vhost was made by hand, so the install shows the lines to add to it, unless you <TextLink href={takeoverHref(parent)}>take it over</TextLink> first.</>}
          </p>
          {dumpPath !== null && cleanPath(state.under.path) && dumpPath !== cleanPath(state.under.path) && (
            <Notice tone="warning" size="inline" className="sm:col-span-2">
              The database's site is at {dumpPath || '/'}, but this one goes under {cleanPath(state.under.path)}. Search and replace changes the domain only, so links
              would miss the path: use the same path as the site in the dump.
            </Notice>
          )}
        </div>
      )}
    </div>
  );
}

/** How a network's sites spread over domains, and which ones live under a path and need no row. */
export function NetworkNote({ sites }: { sites: Array<{ domain: string; path: string }> }) {
  const domains = [...new Set(sites.map((x) => x.domain))];
  const underPath = sites.filter((x) => x.path !== '/');
  const hosts = [...new Set(underPath.map((x) => x.domain))];
  return (
    <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      A network: {sites.length} site{sites.length === 1 ? '' : 's'} on {domains.length} domain{domains.length === 1 ? '' : 's'}.
      {underPath.length > 0 && (
        <>
          {' '}{underPath.length} {underPath.length === 1 ? 'is' : 'are'} under a path of <span className="font-mono text-dense">{hosts.join(', ')}</span> ({underPath.map((x) => x.path).join(', ')}) and need{underPath.length === 1 ? 's' : ''} no row of {underPath.length === 1 ? 'its' : 'their'} own.
        </>
      )}
    </p>
  );
}

/** Whether to replace at all: production URLs only, so email addresses and plain text keep the production domain. */
export function ReplaceOptions({ state, set, summary }: { state: WizardState; set: Setter; summary: string | null }) {
  // Every address of the dump is its local name already: there is nothing to turn off.
  const anyToReplace = state.domains.some((d) => cleanAddress(d.prod) && cleanAddress(d.prod) !== cleanAddress(d.local, false));
  return (
    <div className="mt-2 grid gap-3 border-t pt-4">
      {anyToReplace && (
        <Checkbox
          id="replace-on"
          checked={state.replaceOn}
          onChange={(v) => set('replaceOn', v)}
          label="Search and replace the production domains after the import"
          hint="URLs only, so email addresses and plain text keep the production domain. Turn it off for a dump that already uses the local domains. Either way, http:// links become https:// where the dump has them."
        />
      )}
      {summary ? (
        <p className="text-xs text-muted-foreground">One step after the import: {summary.charAt(0).toLowerCase()}{summary.slice(1)}.</p>
      ) : (
        <Notice tone="success">Already set up for here: no search and replace. Every address in the dump answers here, on https.</Notice>
      )}
    </div>
  );
}

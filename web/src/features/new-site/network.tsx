import type { DumpFacts } from '@devmagic-panel/shared';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { networkSummary } from '@/features/new-site/dump-facts';
import { Input } from '@/components/ui/input';
import type { NetworkAnswers, NetworkChoice, NetworkPlan, NetworkRow } from '@/lib/network';
import { cn } from '@/lib/utils';

const KEEP = {
  value: 'keep' as const,
  label: 'Keep each site where it is',
  hint: () => 'Sites under paths stay under paths and sites on their own hosts stay there: nothing moves. New sites follow the dump\'s own setting.',
};

const LAYOUTS: Array<{ value: NetworkChoice; label: string; hint: (main: string) => string }> = [
  { value: 'subdirectory', label: 'Subdirectory', hint: (main) => `Every site under a path of ${main}, like ${main}/shop/: one domain and one hosts line. New sites go under paths.` },
  {
    value: 'subdomain',
    label: 'Subdomain',
    hint: () => 'Every site on a host of its own, a subdomain or another domain mapped to it, all in this site\'s certificate, vhost and hosts line. A new site gets a subdomain, which needs its hosts line and certificate before it opens.',
  },
];

/**
 * A network from the dump: how it runs here, as a subdirectory or a
 * subdomain network, and where each site goes. It starts as the dump has it;
 * a site whose address changes is moved by the install after the replace.
 */
/** The site list's columns: a stack on a phone, a table from md up. */
const COLUMNS = 'px-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_5.5rem] md:gap-x-5';

const STATUS: Record<NetworkRow['status'], { label: string; tone?: 'warning' }> = {
  same: { label: 'Stays' },
  host: { label: 'New host' },
  moves: { label: 'Moves', tone: 'warning' },
};

/** What a choice does, beside its name: nothing, or how many sites it moves. */
function consequence(plan: NetworkPlan, choice: NetworkChoice): string {
  const n = plan.movesFor[choice];
  const asDump = choice === 'keep' || (!plan.mixed && plan.dumpLayout === choice);
  if (n === 0) return asDump ? ' (as in the dump, nothing to change)' : ' (nothing moves)';
  return ` (moves ${n} site${n === 1 ? '' : 's'})`;
}

export function NetworkSection({ facts, plan, main, answers, errors, onChange, nothingChanges = false }: {
  facts: DumpFacts;
  plan: NetworkPlan;
  main: string;
  answers: NetworkAnswers;
  /** Errors the page knows besides the plan's, like a domain another site uses, by blog id. */
  errors: Map<number, string>;
  onChange: (answers: NetworkAnswers) => void;
  /** No search and replace at all: the table folds away. */
  nothingChanges?: boolean;
}) {
  const choices = plan.mixed ? [KEEP, ...LAYOUTS] : LAYOUTS;
  const changing = plan.rows.filter((r) => r.status !== 'same').length;
  const type = (id: number, value: string) =>
    onChange(plan.layout === 'subdomain' ? { ...answers, domains: { ...answers.domains, [id]: value } } : { ...answers, paths: { ...answers.paths, [id]: value } });
  return (
    <Card role="region" className="grid gap-5 p-5" aria-label="The network">
      <div>
        <p className="text-sm font-medium">A multisite network of {plan.rows.length} sites</p>
        <p className="text-xs text-muted-foreground">In the dump: {networkSummary(facts)}. Pick its type here; each site's address follows.</p>
      </div>
      <div role="radiogroup" aria-label="Network type here" className={cn('grid gap-2', choices.length === 3 ? 'lg:grid-cols-3' : 'sm:grid-cols-2')}>
        {choices.map((l) => (
          <label key={l.value} className={cn('flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:border-primary/50', plan.layout === l.value && 'border-primary bg-primary/5')}>
            <input type="radio" name="network-layout" checked={plan.layout === l.value} onChange={() => onChange({ ...answers, layout: l.value })} className="mt-0.5 accent-[var(--primary)]" />
            <span className="min-w-0">
              <span className="font-medium">{l.label}</span>
              <span className="text-muted-foreground">{consequence(plan, l.value)}</span>
              <span className="block text-xs text-muted-foreground">{l.hint(main || 'the primary domain')}</span>
            </span>
          </label>
        ))}
      </div>
      <details className="group" open={!nothingChanges}>
        <summary className="cursor-pointer text-sm font-medium">
          {changing === 0 ? `All ${plan.rows.length} sites keep their address` : `${changing} of ${plan.rows.length} sites change address, ${plan.rows.length - changing} ${plan.rows.length - changing === 1 ? 'stays' : 'stay'}`}
          <span className="font-normal text-muted-foreground group-open:hidden"> · show the {plan.rows.length} sites</span>
          <span className="hidden font-normal text-muted-foreground group-open:inline"> · hide them</span>
        </summary>
        <div className="mt-3 overflow-hidden rounded-lg border">
          <div className={cn(COLUMNS, 'hidden border-b bg-muted/40 py-2.5 text-xs font-medium text-muted-foreground md:grid')}>
            <span>Site</span>
            <span>In the dump</span>
            <span>Here</span>
            <span className="text-right">Address</span>
          </div>
          <ul className="divide-y">
            {plan.rows.map((r) => {
              const error = r.error ?? errors.get(r.site.id);
              const name = r.site.name || `Site ${r.site.id}`;
              return (
                <li key={r.site.id} className={cn(COLUMNS, 'grid gap-y-2 py-3.5 md:items-center')}>
                  <div className="flex min-w-0 items-start justify-between gap-3 md:block">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={name}>{name}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        Site {r.site.id}
                        {r.main && <Badge className="whitespace-nowrap">main site</Badge>}
                      </p>
                    </div>
                    {/* On a phone the change sits beside the name; on wider screens it has a column of its own. */}
                    <Badge className="shrink-0 md:hidden" tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </div>
                  <p className="min-w-0 truncate font-mono text-dense text-muted-foreground" title={`${r.dump.domain}${r.dump.path}`}>
                    <span className="font-sans text-xs md:hidden">In the dump: </span>
                    {r.dump.domain}{r.dump.path}
                  </p>
                  <div className="min-w-0">
                    {r.main || plan.layout === 'keep' ? (
                      <p className="truncate font-mono text-dense" title={`${r.here.domain}${r.here.path}`}>{r.here.domain}{r.here.path}</p>
                    ) : plan.layout === 'subdomain' ? (
                      <Input
                        value={answers.domains[r.site.id] ?? r.here.domain}
                        onChange={(e) => type(r.site.id, e.target.value)}
                        aria-label={`Local domain for ${name}`}
                        aria-invalid={error ? true : undefined}
                        spellCheck={false}
                        className={cn('font-mono text-dense', error ? 'border-danger' : 'border-teal-500/45 bg-teal-500/[0.04] dark:border-teal-400/40 dark:bg-teal-400/[0.05]')}
                      />
                    ) : (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="max-w-[45%] shrink-0 truncate font-mono text-dense text-muted-foreground" title={r.here.domain}>{r.here.domain}</span>
                        <Input
                          value={answers.paths[r.site.id] ?? r.here.path}
                          onChange={(e) => type(r.site.id, e.target.value)}
                          onBlur={(e) => e.target.value.trim() && type(r.site.id, `/${e.target.value.split('/').map((p) => p.trim()).filter(Boolean).join('/')}/`)}
                          aria-label={`Path for ${name}`}
                          aria-invalid={error ? true : undefined}
                          spellCheck={false}
                          className={cn('min-w-0 font-mono text-dense', error ? 'border-danger' : 'border-teal-500/45 bg-teal-500/[0.04] dark:border-teal-400/40 dark:bg-teal-400/[0.05]')}
                        />
                      </div>
                    )}
                    {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
                  </div>
                  <div className="hidden justify-self-end md:block">
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
      {plan.moves.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {plan.moves.length} {plan.moves.length === 1 ? 'site moves' : 'sites move'}: in the same passes as the replace, the install changes {plan.moves.length === 1 ? 'its' : 'their'} links, then {plan.moves.length === 1 ? 'its' : 'their'} home and siteurl and {plan.moves.length === 1 ? 'its' : 'their'} row in the network's site list.
          {plan.layout === 'subdomain' && ' The new hosts get a hosts line and go in the certificate.'}
        </p>
      )}
    </Card>
  );
}

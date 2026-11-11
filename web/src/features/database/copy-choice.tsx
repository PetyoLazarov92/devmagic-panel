import type { UploadResult } from '@devmagic-panel/shared';
import { CLEAN_FORM_TABLES, CLEAN_LOG_TABLES, CLEAN_WOO_TABLES } from '@devmagic-panel/shared';
import { Segmented } from '@/components/ui/segmented';

/**
 * The copy: as the dump has it, or cleaned. One choice for a site's import
 * and the new site wizard, with what a clean-up removes once it is known.
 */
export function CopyChoice({ id, clean, onChange, removed, keeps }: {
  id: string;
  clean: boolean;
  onChange: (clean: boolean) => void;
  /** What the clean-up removes from this dump, when it is known. */
  removed?: string[];
  /** Who stays, where the caller picks the user elsewhere: "the WordPress step's admin". */
  keeps?: string;
}) {
  return (
    <div className="grid gap-2 text-sm">
      <span className="font-medium">The copy</span>
      <Segmented label="The copy" value={clean ? 'clean' : 'whole'} onChange={(v) => onChange(v === 'clean')} options={[['whole', 'As it is'], ['clean', 'Cleaned']]} className="justify-self-start" />
      {clean ? (
        <div id={id} className="grid gap-1.5 text-sm text-muted-foreground">
          <p className="text-xs">
            Cleaned here with SQL before the site uses it, so no WordPress code runs on it and nothing can send mail. Mail plugins are turned off and one user stays{keeps ? ` (${keeps})` : ''}, the author of every post. Nothing changes on production.
          </p>
          <ul className="grid gap-1">
            {(removed ?? CLEAN_REMOVES).map((f) => <li key={f} className="before:mr-2 before:text-primary before:content-['–']">{f}</li>)}
          </ul>
        </div>
      ) : (
        <p id={id} className="text-xs text-muted-foreground">An exact copy: every user, order and key stays as the dump has them.</p>
      )}
    </div>
  );
}

/** What a clean-up removes, before the dump's own tables are known. */
const CLEAN_REMOVES = ['every user but the one you keep', 'WooCommerce orders, customers and product reviews', 'form entries, logs and transients', 'payment, mail and API keys'];

/** What a clean copy finds in a dump, from the tables it makes: the plugins with private data, and the log tables. */
export function findings(upload: UploadResult): string[] {
  const tables = Object.keys(upload.facts.tableHosts ?? {});
  return cleanupFindings(tables, upload.facts.tablePrefix ?? 'wp_');
}

/** What the clean-up removes, from a list of table names. */
export function cleanupFindings(tables: readonly string[], prefix: string): string[] {
  const has = (names: readonly string[]) => names.filter((n) => tables.some((t) => t.toLowerCase() === `${prefix}${n}`.toLowerCase() || new RegExp(`^${prefix}\\d+_${n}$`, 'i').test(t)));
  const found = ['every user but the one you keep'];
  if (has(CLEAN_WOO_TABLES).length > 0) found.push('WooCommerce orders, customers and product reviews');
  const forms = has(CLEAN_FORM_TABLES);
  if (forms.length > 0) found.push(`form entries (${forms.length} table${forms.length === 1 ? '' : 's'})`);
  const logs = has(CLEAN_LOG_TABLES);
  if (logs.length > 0) found.push(`logs (${logs.length} table${logs.length === 1 ? '' : 's'}) and transients`);
  found.push('payment, mail and API keys');
  return found;
}

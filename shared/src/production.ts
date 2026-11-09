/**
 * Tables a copy from production usually leaves the rows of: logs that grow
 * without end, and personal data a local copy does not need. By name without
 * the table prefix; a network's sites' own tables (wp_2_...) match too.
 */
export const LOG_TABLES = [
  'actionscheduler_logs',
  'wfhits',
  'wflogins',
  'wflivetraffichuman',
  'redirection_logs',
  'redirection_404',
  'wsal_occurrences',
  'wsal_metadata',
  'simple_history',
  'simple_history_contexts',
  'stream',
  'stream_meta',
  'wpml_mails',
  'yoast_seo_links',
] as const;

export const PERSONAL_TABLES = [
  'wc_orders',
  'wc_orders_meta',
  'wc_order_addresses',
  'wc_order_operational_data',
  'wc_order_stats',
  'wc_order_product_lookup',
  'wc_customer_lookup',
  'woocommerce_order_items',
  'woocommerce_order_itemmeta',
  'woocommerce_sessions',
  'gf_entry',
  'gf_entry_meta',
  'gf_entry_notes',
  'wpforms_entries',
  'wpforms_entry_meta',
  'wpforms_entry_fields',
] as const;

/** The database's table prefix: the one before its shortest options table. */
export function tablePrefixOf(tables: readonly string[]): string {
  const options = tables.filter((t) => t.endsWith('options')).sort((a, b) => a.length - b.length)[0];
  return options ? options.slice(0, -'options'.length) : 'wp_';
}

/** Which of these tables are known logs, and which hold personal data. */
export function knownLeftOut(tables: readonly string[]): { logs: string[]; personal: string[] } {
  const prefix = tablePrefixOf(tables);
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kind = (names: readonly string[]) => tables.filter((t) => names.some((n) => new RegExp(`^${esc}(?:\\d+_)?${n}$`).test(t)));
  return { logs: kind(LOG_TABLES), personal: kind(PERSONAL_TABLES) };
}

/** A server's tables for a copy, biggest first, with the known ones and the ones you left out last time. */
export interface ServerTables {
  tables: Array<{ name: string; bytes: number }>;
  logs: string[];
  personal: string[];
  /** The tables you left out the last time, for this server and folder. */
  remembered?: string[];
}

/**
 * How a server signs you in over SSH, asked before anything runs there:
 * key (your SSH key signs in, no password needed), password (your key does
 * not, and the server takes a password), refused (it takes keys only, and
 * not yours), or unknown, with why (not in known_hosts, not reachable).
 */
export interface ServerSignIn {
  how: 'key' | 'password' | 'refused' | 'unknown';
  problem?: string;
}

/** What a site keeps for Refresh from production: no secret, only where and how. */
export interface ProductionSettings {
  host: string;
  folder: string;
  excludeRows: string[];
  clean: boolean;
  /** The user a cleaned copy keeps: an administrator there by login, or a new one. */
  keep?: string | undefined;
}

/** The tables ticked at first: the ones left out last time, else the known logs, and the personal ones when the copy is cleaned. */
export function defaultLeftOut(found: Pick<ServerTables, 'logs' | 'personal' | 'remembered' | 'tables'>, clean: boolean): string[] {
  const names = new Set(found.tables.map((t) => t.name));
  if (found.remembered?.length) return found.remembered.filter((t) => names.has(t));
  return clean ? [...found.logs, ...found.personal] : [...found.logs];
}

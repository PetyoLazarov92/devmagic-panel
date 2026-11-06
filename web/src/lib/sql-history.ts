/**
 * The SQL runner's last statements per database, in this browser only
 * (queries can hold data, so they never go to the server to be kept).
 * Storage can be missing or refuse, in a private window: then there is no
 * history, and nothing breaks.
 */
export const SQL_HISTORY_MAX = 30;

const key = (database: string) => `dmp:sql-history:${database}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readHistory(database: string, store: Store | null = storage()): string[] {
  try {
    const list = JSON.parse(store?.getItem(key(database)) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, SQL_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

/** Puts a statement first, without a copy of it further down, and keeps the newest 30. */
export function addHistory(database: string, sql: string, store: Store | null = storage()): string[] {
  const text = sql.trim();
  const next = [text, ...readHistory(database, store).filter((s) => s !== text)].slice(0, SQL_HISTORY_MAX);
  try {
    store?.setItem(key(database), JSON.stringify(next));
  } catch {
    // Full or refused: the history is a convenience.
  }
  return next;
}

export function clearHistory(database: string, store: Store | null = storage()): void {
  try {
    store?.removeItem(key(database));
  } catch {
    // Nothing to clear.
  }
}

/** A result as CSV (RFC 4180): every value quoted when it needs to be, NULL as an empty field. */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | null>>): string {
  const field = (v: string | null) => (v === null ? '' : /[",\r\n]/.test(v) || v === '' ? `"${v.replaceAll('"', '""')}"` : v);
  return [columns, ...rows].map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}

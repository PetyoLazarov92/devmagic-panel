import type { LocalConstant, Site } from '@devmagic-panel/shared';
import { DEFAULT_LOCAL_CONSTANTS, localConstants } from '@devmagic-panel/shared';

/** The meta row that holds the list. */
const KEY = 'local-constants';

interface Meta {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** The constants every local site should have, from Settings; the default until you save a list. */
export function readLocalConstants(store: Pick<Meta, 'getMeta'> | undefined): LocalConstant[] {
  try {
    const saved = store?.getMeta(KEY);
    if (saved === undefined) return DEFAULT_LOCAL_CONSTANTS;
    const list = localConstants.safeParse(JSON.parse(saved));
    return list.success ? list.data : DEFAULT_LOCAL_CONSTANTS;
  } catch {
    return DEFAULT_LOCAL_CONSTANTS;
  }
}

export function saveLocalConstants(store: Meta, list: LocalConstant[]): void {
  store.setMeta(KEY, JSON.stringify(list));
}

/** The local constants a site does not have at the value asked for, with what it has now. */
export function missingLocalConstants(site: Pick<Site, 'constants'>, list: readonly LocalConstant[]): Array<LocalConstant & { now?: string | boolean | number }> {
  if (!site.constants) return [];
  return list.flatMap((c) => {
    const found = site.constants?.find((s) => s.name === c.name);
    if (found && found.value === c.value) return [];
    return [{ ...c, ...(found?.value !== undefined ? { now: found.value } : {}) }];
  });
}

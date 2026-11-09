import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig } from '../config.js';

/** Where dmp-root records a folder the panel made or took over: its path and device:inode. */
export const siteRegistryEntry = (config: SystemConfig, domain: string) => join(config.STATE_DIR, 'sites', domain);

/** The folder is the one dmp-root registered for the domain, the very same (path and device:inode). */
export function isPanelFolder(config: SystemConfig, docroot: string, domain: string): boolean {
  try {
    const [path, id] = readFileSync(siteRegistryEntry(config, domain), 'utf8').split('\n');
    const st = statSync(docroot);
    return path === docroot && id === `${st.dev}:${st.ino}`;
  } catch {
    return false;
  }
}

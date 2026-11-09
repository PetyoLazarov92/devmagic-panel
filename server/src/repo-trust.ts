import type { RepoOwner } from '@devmagic-panel/shared';
import { isShared, ownedBy, parseNamespaceRef, repoKey, repoOwner, repoWeb } from '@devmagic-panel/shared';
import type { RunStore } from './store.js';

/** Why a repo may run here: one of your organizations or groups, an owner you trusted, or a repo your signed-in CLI listed. */
export type TrustReason = 'namespace' | 'trusted' | 'listed';

export interface RepoTrust {
  owner: RepoOwner | null;
  trusted: boolean;
  why?: TrustReason;
}

/**
 * Whether code from a repo may run on this computer: its PHP when the site
 * loads, its composer and npm builds as you. Repos of the organizations and
 * groups you scan, and repos a signed-in gh or glab listed for you, are;
 * any other needs its owner trusted once, in the wizard or Settings.
 */
export function repoTrust(url: string, store: Pick<RunStore, 'trustedOwners' | 'listedRepo'>, namespaces: readonly string[]): RepoTrust {
  const owner = repoOwner(url, repoWeb(url));
  if (!owner) return { owner: null, trusted: false };
  const yours = namespaces.flatMap((ref) => {
    const ns = parseNamespaceRef(ref);
    return ns && !isShared(ns) ? [{ host: ns.host.toLowerCase(), owner: ns.path.toLowerCase() }] : [];
  });
  if (ownedBy(owner, yours)) return { owner, trusted: true, why: 'namespace' };
  if (ownedBy(owner, store.trustedOwners())) return { owner, trusted: true, why: 'trusted' };
  const key = repoKey(url);
  if (key && store.listedRepo(key)) return { owner, trusted: true, why: 'listed' };
  return { owner, trusted: false };
}

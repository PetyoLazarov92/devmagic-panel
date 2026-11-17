import type { CliStatus, OrgNamespace, OrgStatus } from '@devmagic-panel/shared';
import { namespaceShortLabel, parseNamespaceRef } from '@devmagic-panel/shared';

/** One host in the scan dialog: its CLI's state, what to run when it is not signed in, and its organizations or groups. */
export interface ScanHost {
  host: string;
  name: string;
  provider: 'github' | 'gitlab';
  /** One of your own GitLab hosts, which you can remove. */
  own: boolean;
  signedIn: boolean;
  /** signed in as wandworksco, not signed in, the GitLab CLI is not installed, or its problem. */
  state: string;
  /** What to run in a terminal while it is not signed in. */
  commands: string[];
  items: Array<{ ref: string; label: string }>;
}

/**
 * The hosts of the scan dialog, each with its own state and choices: GitHub,
 * gitlab.com, then your GitLab hosts. A ticked organization the CLI no longer
 * lists stays under its host, so it can be unticked.
 */
export function scanHosts(status: OrgStatus, namespaces: readonly OrgNamespace[], selected: readonly string[], gitlabHosts: readonly string[]): ScanHost[] {
  const hostOf = (ref: string) => {
    const ns = parseNamespaceRef(ref);
    return ns ? (ns.provider === 'github' ? 'github.com' : ns.host) : null;
  };
  const order = [...new Set(['github.com', 'gitlab.com', ...gitlabHosts, ...status.glab.hosts.map((h) => h.host), ...namespaces.map((n) => n.host)])];
  return order.map((host) => {
    const github = host === 'github.com';
    const cli: CliStatus | undefined = github ? status.gh : status.glab.hosts.find((h) => h.host === host);
    const login = github ? 'gh auth login' : `glab auth login${host === 'gitlab.com' ? '' : ` --hostname ${host}`}`;
    const installed = github ? status.gh.installed : status.glab.installed;
    const signedIn = Boolean(cli?.signedIn);
    const state = signedIn
      ? cli?.user ? `signed in as ${cli.user}` : 'signed in'
      : !installed
        ? `the ${github ? 'GitHub' : 'GitLab'} CLI is not installed`
        : cli?.problem && !/not signed in/.test(cli.problem) ? cli.problem : 'not signed in';
    const commands = signedIn ? [] : installed ? [login] : [`sudo apt install ${github ? 'gh' : 'glab'}`, login];
    const listed = namespaces.filter((n) => n.host === host).map((n) => n.ref);
    const kept = selected.filter((ref) => hostOf(ref) === host && !listed.includes(ref));
    const items = [...listed, ...kept].map((ref) => {
      const path = parseNamespaceRef(ref)?.path;
      const label = namespaceShortLabel(ref);
      return { ref, label: cli?.user && path?.toLowerCase() === cli.user.toLowerCase() ? `${label} (your account)` : label };
    });
    return { host, name: github ? 'GitHub' : host, provider: github ? 'github' : 'gitlab', own: gitlabHosts.includes(host), signedIn, state, commands, items } satisfies ScanHost;
  });
}

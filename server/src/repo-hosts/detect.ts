import type { WebProvider } from '@devmagic-panel/shared';
import { providerOfHost, registerGitHosts, registerHostAliases, remoteEndpoint } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import type { RunStore } from '../store.js';

/** A host is asked again after a week, as a server can move to GitLab or away. */
export const RECHECK_MS = 7 * 24 * 3_600_000;
/** Hosts whose kind is known from their name alone, never asked. */
const PUBLIC = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
const firstMatch = (text: string, re: RegExp) => re.exec(text)?.[1];

/**
 * Finds out what runs the git hosts in the sites' remotes when their name does
 * not say: an SSH alias from ~/.ssh/config is resolved with `ssh -G` (local,
 * no network), and a host still unknown is asked once with `ssh -T`, the same
 * hello `git fetch` makes, which GitLab answers "Welcome to GitLab" and Gitea
 * or Forgejo by name. No token, no API, no new host key accepted. The answers
 * are kept in the panel's database and registered for every link helper,
 * merge request and Environment check.
 */
export class GitHostDetector {
  private running: Promise<void> | null = null;

  constructor(
    private readonly exec: Executor,
    private readonly store: RunStore,
    private readonly now = () => Date.now(),
  ) {}

  /** What the database knows: the hosts found to run GitLab or Gitea, and the aliases with their real host. */
  known(): { hosts: Record<string, 'GitLab' | 'Gitea'>; aliases: Record<string, string> } {
    const hosts: Record<string, 'GitLab' | 'Gitea'> = {};
    const aliases: Record<string, string> = {};
    for (const r of this.store.gitHosts()) {
      if (r.realHost && r.realHost !== r.host) aliases[r.host] = r.realHost;
      const host = r.realHost ?? r.host;
      if ((r.provider === 'GitLab' || r.provider === 'Gitea') && !PUBLIC.has(host)) hosts[host] = r.provider;
    }
    return { hosts, aliases };
  }

  /** Registers what the database knows; call once at start. */
  apply(): void {
    const { hosts, aliases } = this.known();
    registerHostAliases(aliases);
    registerGitHosts('detected', hosts);
  }

  /** Asks the hosts of these remotes that were never asked or not this week; one run at a time. */
  refresh(remotes: readonly string[]): Promise<void> {
    const run = (this.running ?? Promise.resolve()).catch(() => undefined).then(() => this.check(remotes));
    this.running = run;
    return run.finally(() => {
      if (this.running === run) this.running = null;
    });
  }

  private async check(remotes: readonly string[]): Promise<void> {
    const seen = new Map(this.store.gitHosts().map((r) => [r.host, Date.parse(r.checkedAt)]));
    const due = new Map<string, NonNullable<ReturnType<typeof remoteEndpoint>>>();
    for (const remote of remotes) {
      const end = remoteEndpoint(remote);
      if (!end || PUBLIC.has(end.host) || due.has(end.host)) continue;
      const at = seen.get(end.host);
      if (at !== undefined && this.now() - at < RECHECK_MS) continue;
      due.set(end.host, end);
    }
    if (due.size === 0) return;
    await Promise.all([...due.values()].map((end) => this.ask(end)));
    this.apply();
  }

  private async ask(end: NonNullable<ReturnType<typeof remoteEndpoint>>): Promise<void> {
    let real: string | undefined;
    if (end.ssh) {
      // -G prints the settings ssh would use, the real hostname among them, and connects to nothing.
      const g = await this.exec('ssh', ['-G', end.host], { timeoutMs: 5_000 });
      const resolved = g.code === 0 ? firstMatch(g.stdout, /^hostname\s+(\S+)$/m)?.toLowerCase() : undefined;
      if (resolved && resolved !== end.host) real = resolved;
    }
    // What its name or your settings say; an earlier answer of this detector is asked again.
    let provider: WebProvider = providerOfHost(real ?? end.host, 'detected');
    if (provider === 'Git') {
      const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...(end.port ? ['-p', String(end.port)] : []), `${end.user}@${end.host}`];
      const r = await this.exec('ssh', args, { timeoutMs: 10_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      provider = /welcome to gitlab/i.test(text) ? 'GitLab' : /\b(gitea|forgejo)\b/i.test(text) ? 'Gitea' : 'Git';
    }
    this.store.saveGitHost(end.host, provider, real, new Date(this.now()).toISOString());
  }
}

import type { InstallDraft, Namespace, OrgRepo, OrgRepoList, OrgScanMode, RepoKind, Site, SiteInstall, TrashEntry } from '@devmagic-panel/shared';
import { classifyRepo, isShared, parseNamespaceRef, repoKey } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { HostRefused, type HostRepo, hostFor, type RepoHost } from '../repo-hosts/index.js';
import type { RunStore } from '../store.js';

/** Both hosts' largest page: GitHub's and GitLab's REST APIs give 100. */
const REPO_PAGE_SIZE = 100;

/** Opening the page checks for new pushes when the last check is older than this. */
export const CHECK_EVERY_MS = 3_600_000;
/** And lists every repo, to drop deleted and renamed ones, when the last full list is older than this. */
export const LIST_EVERY_MS = 7 * 24 * 3_600_000;
/** No organization has more pages than this; a guard against a loop that never ends. */
const MAX_PAGES = 100;

/** A repo as stored: what its host listed, its kind, and the push its kind was read at. */
type StoredRepo = Omit<OrgRepo, 'local'> & { kindPushedAt?: string };

/** What this machine has of each repo: installed sites, archived copies, an unfinished install. */
export interface LocalState {
  sites: Site[];
  installs: Map<string, SiteInstall>;
  trash: TrashEntry[];
  drafts: InstallDraft[];
}

/** Runs at most `limit` of the calls at once. */
async function pooled<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The local state of a repo, matched by its git remote. */
export function localOf(sshUrl: string, local: LocalState): OrgRepo['local'] | undefined {
  const key = repoKey(sshUrl);
  if (!key) return undefined;
  const same = (url?: string) => Boolean(url) && repoKey(url as string) === key;
  const installed = local.sites
    .filter((s) => same(s.git?.remote) || same(local.installs.get(`${s.domain}${s.path ?? ''}`)?.repo) || s.mounts?.some((m) => same(m.git?.remote)))
    .map((s) => ({ domain: s.domain, ...(s.path ? { path: s.path } : {}), how: s.install?.how ?? 'hand' }));
  const archived = local.trash.filter((e) => same(e.install?.repo));
  const draft = local.drafts.find((d) => d.status !== 'installing' && same(((d.state ?? {}) as { repoUrl?: string }).repoUrl));
  const state: NonNullable<OrgRepo['local']> = {
    ...(installed.length ? { installed } : {}),
    ...(archived.length ? { archived: { count: archived.length, latest: archived.map((e) => e.deletedAt).sort().at(-1) as string } } : {}),
    ...(draft ? { draft: { id: draft.id, ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}) } } : {}),
  };
  return Object.keys(state).length ? state : undefined;
}

/**
 * The repos of an organization (GitHub) or group (GitLab) with what each holds, kept in the panel's
 * database so they show at once and survive restarts. A check reads the
 * repos pushed since the last one (newest push first, so usually one page);
 * a full list, once a week or when you ask, reads them all and drops the
 * ones that went. A repo's top-level names are read again only after a push.
 * Archived repos are listed but not looked into.
 */
export class OrgScanner {
  /** One scan per organization at a time; the next waits and then sees what it saved. */
  private readonly running = new Map<string, Promise<unknown>>();
  /** The signed-in account on each host, read once. */
  private readonly logins = new Map<string, string | null>();

  constructor(
    private readonly exec: Executor,
    private readonly store: RunStore,
    private readonly now = () => Date.now(),
    private readonly sleep?: (ms: number) => Promise<void>,
    private readonly hostOf: (ns: Namespace) => RepoHost = (ns) => hostFor(exec, ns, sleep),
  ) {}

  async repos(org: string, local: LocalState, mode: OrgScanMode = 'none'): Promise<OrgRepoList> {
    let problem: string | undefined;
    if (mode !== 'none') {
      const key = org.toLowerCase();
      const run = (this.running.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.scan(org, mode));
      this.running.set(key, run);
      try {
        await run;
      } catch (error) {
        if (!(error instanceof HostRefused)) throw error;
        problem = error.message;
      } finally {
        if (this.running.get(key) === run) this.running.delete(key);
      }
    }
    const scan = this.store.orgScan(org);
    const repos = (this.store.orgRepos(org) as StoredRepo[])
      .map(({ kindPushedAt: _, ...r }): OrgRepo => {
        const state = localOf(r.sshUrl, local);
        return state ? { ...r, local: state } : r;
      })
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || a.name.localeCompare(b.name));
    return { repos, ...(scan ? { checkedAt: scan.checkedAt, listedAt: scan.listedAt } : {}), ...(problem ? { problem } : {}) };
  }

  /** What a scan in this mode reads now: nothing when the stored list is fresh enough. */
  private due(org: string, mode: Exclude<OrgScanMode, 'none'>): 'check' | 'full' | null {
    const scan = this.store.orgScan(org);
    if (!scan || mode === 'full') return 'full';
    if (mode === 'check') return 'check';
    if (this.now() - Date.parse(scan.listedAt) > LIST_EVERY_MS) return 'full';
    return this.now() - Date.parse(scan.checkedAt) > CHECK_EVERY_MS ? 'check' : null;
  }

  private async scan(org: string, mode: Exclude<OrgScanMode, 'none'>): Promise<void> {
    const what = this.due(org, mode);
    if (!what) return;
    const ns = parseNamespaceRef(org);
    if (!ns) throw new HostRefused(`${org} is not an organization or group`);
    const host = this.hostOf(ns);
    const started = this.now();
    const since = what === 'check' ? Date.parse(this.store.orgScan(org)?.checkedAt ?? '') - host.checkOverlapMs : NaN;
    if (!this.logins.has(host.host)) this.logins.set(host.host, await host.login());
    const login = this.logins.get(host.host);
    const self = !isShared(ns) && Boolean(login && login.toLowerCase() === ns.path.toLowerCase());
    const listed: HostRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const repos = await host.repoPage(ns, self, page);
      listed.push(...repos);
      if (repos.length < REPO_PAGE_SIZE) break;
      // Newest first: once a page ends before the last check, the rest is older still.
      const oldest = Date.parse(repos.at(-1)?.pushedAt ?? '');
      if (what === 'check' && !(oldest >= since)) break;
    }
    const keep = await host.keepFor?.(ns);
    const kept = keep ? listed.filter(keep) : listed;
    const stored = new Map((this.store.orgRepos(org) as StoredRepo[]).map((r) => [r.fullName.toLowerCase(), r]));
    const repos = await pooled(kept, 8, (r) => this.withKind(host, org, r, stored.get(r.path.toLowerCase())));
    this.store.saveOrgScan(org, repos, what === 'full', new Date(started).toISOString(), (r) => (ns.provider === 'github' && !isShared(ns) ? r.name : r.fullName.toLowerCase()));
  }

  /** A listed repo with its kind: the stored one while no push came since, else read from its top-level names. */
  private async withKind(host: RepoHost, org: string, r: HostRepo, before: StoredRepo | undefined): Promise<StoredRepo> {
    const base = {
      org,
      name: r.name,
      fullName: r.path,
      ...(r.description ? { description: r.description } : {}),
      sshUrl: r.sshUrl,
      url: r.url,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}),
      archived: r.archived,
    };
    if (r.archived) return { ...base, kind: 'other' };
    if (before?.kindPushedAt !== undefined && before.kindPushedAt === (r.pushedAt ?? '')) return { ...base, kind: before.kind, kindPushedAt: before.kindPushedAt };
    const names = r.empty ? [] : await host.topNames(r.path);
    // The host did not answer: keep what was known and look again next time.
    if (!names) return { ...base, kind: before?.kind ?? ('other' as RepoKind) };
    return { ...base, kind: classifyRepo(names), kindPushedAt: r.pushedAt ?? '' };
  }
}

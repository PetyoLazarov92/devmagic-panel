import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GitHosts, InstallDraft, OrgNamespace, OrgRepoList, OrgSettings, OrgStatus, Site, SiteInstall, TrashEntry } from '@devmagic-panel/shared';
import { DEFAULT_ORG_SETTINGS, gitlabHostsWith, knownLeftOut, orgName, orgScanMode, orgSettingsInput, registerGitlabHosts } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import type { Executor } from '../exec.js';
import type { RunStore } from '../store.js';
import { RepoRefused } from '../sites/repo.js';
import { ClaudeCodeError, claudeStatus, connectorProbe, findClaude, runClaude } from './claude-code.js';
import { DumpRefused, listRemote, rcloneRemotes, recentDownloads, rcloneRemote } from './dumps.js';
import { z } from 'zod';
import { MoreDumpsRefused, serverTables } from '../sites/more-dumps.js';
import { ghStatus } from '../repo-hosts/github.js';
import { type GitHostDetector, glabOverview, HostRefused, listNamespaces, remotesOf } from '../repo-hosts/index.js';
import { OrgScanner } from './scan.js';

/** The organization settings in ~/.config/devmagic-panel/organizations.json; nothing secret. */
export function readOrgSettings(file: string): OrgSettings {
  try {
    const parsed = orgSettingsInput.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : DEFAULT_ORG_SETTINGS;
  } catch {
    return DEFAULT_ORG_SETTINGS;
  }
}

export function writeOrgSettings(file: string, settings: OrgSettings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  registerGitlabHosts(settings.gitlabHosts);
}

/**
 * Your own account on each host is ticked once, the first time that host's
 * CLI is signed in: GitHub through gh, gitlab.com and your own GitLab hosts
 * through glab, each on its own. The host is noted, so an account you untick
 * stays unticked. Null when nothing changes.
 */
export function withAccountsTicked(settings: OrgSettings, gh: OrgStatus['gh'], glab: OrgStatus['glab']): OrgSettings | null {
  const signedIn = [
    ...(gh.signedIn && gh.user ? [{ host: 'github.com', ref: gh.user }] : []),
    ...glab.hosts.flatMap((h) => (h.signedIn && h.user ? [{ host: h.host, ref: `${h.host}/${h.user}` }] : [])),
  ].filter((a) => !settings.accountHosts.includes(a.host));
  if (signedIn.length === 0) return null;
  const selected = [...settings.selected, ...signedIn.map((a) => a.ref).filter((ref) => !settings.selected.includes(ref))];
  const parsed = orgSettingsInput.safeParse({ ...settings, selected, accountHosts: [...settings.accountHosts, ...signedIn.map((a) => a.host)] });
  return parsed.success ? parsed.data : null;
}

export interface OrgRouteDeps {
  exec: Executor;
  /** Where the scanned repos are kept. */
  store: RunStore;
  /** What runs the hosts in the sites' remotes, found over SSH. */
  gitHosts?: GitHostDetector;
  home: string;
  /** Where to look for claude besides the usual places. */
  searchPath: string;
  /** Scratch space for clones and Claude Code's folders. */
  workDir: string;
  settingsFile: string;
  sites: () => Promise<Site[]>;
  installs: () => Map<string, SiteInstall>;
  trash: () => Promise<TrashEntry[]>;
  drafts: () => InstallDraft[];
}

/**
 * Installing a site from an organization: what is set up for it, its
 * settings, and the organizations and their repos. Claude Code reading a repo
 * and its links runs as jobs through the registry actions org.readRepo and
 * org.checkAccess, so it goes on when you leave the page.
 */
export function registerOrgRoutes(api: FastifyInstance, deps: OrgRouteDeps): void {
  const scanner = new OrgScanner(deps.exec, deps.store);
  // Links to your own GitLab hosts come out right from the start, not only once this page is opened.
  registerGitlabHosts(readOrgSettings(deps.settingsFile).gitlabHosts);
  const claude = () => {
    const bin = findClaude(deps.home, deps.searchPath);
    if (!bin) throw new ClaudeCodeError('Claude Code is not installed or not found: install it and sign in with claude auth login, then check again');
    return bin;
  };
  const refused = (error: unknown) => error instanceof ClaudeCodeError || error instanceof HostRefused || error instanceof RepoRefused;

  api.get('/api/org/status', async (): Promise<OrgStatus> => {
    let settings = readOrgSettings(deps.settingsFile);
    const [claude, gh, glab, rclone] = await Promise.all([
      claudeStatus(deps.exec, deps.home, deps.searchPath),
      ghStatus(deps.exec),
      glabOverview(deps.exec, gitlabHostsWith(settings.gitlabHosts)),
      rcloneRemote(deps.exec),
    ]);
    const ticked = withAccountsTicked(settings, gh, glab);
    if (ticked) {
      settings = ticked;
      writeOrgSettings(deps.settingsFile, settings);
    }
    return { claude, gh, glab, rclone, settings };
  });

  // The GitLab hosts that are not called gitlab-something, so the browser links them as GitLab too.
  // The detected ones too, and SSH aliases with their real host; hosts not asked this week are asked behind the answer.
  api.get('/api/git-hosts', async (): Promise<GitHosts> => {
    const known = deps.gitHosts?.known() ?? { hosts: {}, aliases: {} };
    if (deps.gitHosts) {
      const detector = deps.gitHosts;
      void deps.sites().then((sites) => detector.refresh(remotesOf(sites))).catch(() => undefined);
    }
    return { gitlab: readOrgSettings(deps.settingsFile).gitlabHosts, detected: known.hosts, aliases: known.aliases };
  });

  api.put<{ Body: unknown }>('/api/org/settings', async (request, reply): Promise<OrgSettings | undefined> => {
    const parsed = orgSettingsInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Not organization settings' });
    // The hosts your account was ticked on stay noted, whatever the page sent, so an account you untick stays unticked.
    const stored = readOrgSettings(deps.settingsFile).accountHosts;
    const settings = { ...parsed.data, accountHosts: [...new Set([...stored, ...parsed.data.accountHosts])] };
    writeOrgSettings(deps.settingsFile, settings);
    return settings;
  });

  // The connector tools Claude Code reaches, for Check connectors: one small Haiku run of at most $0.10.
  api.post('/api/org/test', async (_request, reply) => {
    try {
      const bin = claude();
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(deps.workDir, { recursive: true, mode: 0o700 });
      const empty = mkdtempSync(join(deps.workDir, 'org-test-'));
      try {
        const { output, costUsd } = await runClaude(deps.exec, {
          bin, cwd: empty, model: 'haiku', effort: 'low', budgetUsd: 0.1, tools: [], schema: connectorProbe,
          prompt: 'Without calling any tool, list the exact names of all your tools whose names contain Asana, Google_Drive or Google_Docs.',
        });
        const has = (part: string) => output.tools.some((t) => t.includes(part));
        return { asana: has('Asana'), drive: has('Google_Drive'), docs: has('Google_Docs'), costUsd };
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } catch (error) {
      if (refused(error)) return reply.code(409).send({ error: (error as Error).message });
      throw error;
    }
  });

  // Organizations and groups from each signed-in CLI; a host that fails says why, the rest still list.
  api.get('/api/org/orgs', async (_request, reply): Promise<{ namespaces: OrgNamespace[]; problems: string[] } | undefined> => {
    const found = await listNamespaces(deps.exec, readOrgSettings(deps.settingsFile).gitlabHosts);
    if (found.namespaces.length === 0 && found.problems.length > 0) return reply.code(409).send({ error: found.problems.join('; ') });
    return found;
  });

  // The stored list at once with scan=none (no gh needed), or after reading what is due, the new pushes or every repo.
  // When the host cannot be read the stored list still comes back, with the problem.
  api.get<{ Querystring: { org?: string; scan?: string } }>('/api/org/repos', async (request, reply): Promise<OrgRepoList | undefined> => {
    const org = orgName.safeParse(request.query.org);
    if (!org.success) return reply.code(400).send({ error: 'Name an organization or group' });
    const mode = orgScanMode.safeParse(request.query.scan ?? 'none');
    if (!mode.success) return reply.code(400).send({ error: 'scan is none, auto, check or full' });
    const local = { sites: await deps.sites(), installs: deps.installs(), trash: await deps.trash().catch(() => []), drafts: deps.drafts() };
    return scanner.repos(org.data, local, mode.data);
  });

  // Dumps you downloaded in the browser, to pick one when rclone is not set up.
  api.get('/api/downloads', async () => recentDownloads(deps.home));

  // A server's tables with their sizes, for leaving the rows of some out of an export; and what was left out last time there.
  const serverFolder = z.object({ host: z.string().max(300).regex(/^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/), path: z.string().max(500).regex(/^\/[A-Za-z0-9._/-]+$/).refine((p) => !p.split('/').includes('..')) });
  api.post<{ Body: unknown }>('/api/dumps/server-tables', async (request, reply) => {
    const body = serverFolder.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'An ssh host and an absolute folder' });
    try {
      const tables = await serverTables(deps.exec, body.data.host, body.data.path);
      const kept = deps.store.getMeta(`server-export:${body.data.host}|${body.data.path}`);
      return { tables, ...knownLeftOut(tables.map((t) => t.name)), ...(kept ? { remembered: JSON.parse(kept) as string[] } : {}) };
    } catch (error) {
      if (error instanceof MoreDumpsRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // rclone's remotes and one folder of one, read only, for the Database step: names and sizes of dumps, never their contents.
  api.get('/api/dumps/remotes', async () => rcloneRemotes(deps.exec));
  const remoteFolder = z.object({
    remote: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/),
    path: z.string().max(1000).refine((p) => p === '' || (!p.startsWith('/') && !p.startsWith('-') && !/[\0\n]/.test(p) && !p.split('/').some((x) => x === '..' || x === '.' || x === '')), 'A folder in the remote'),
  });
  api.post<{ Body: unknown }>('/api/dumps/remote-list', async (request, reply) => {
    const body = remoteFolder.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'A remote and a folder in it' });
    try {
      return await listRemote(deps.exec, body.data.remote, body.data.path);
    } catch (error) {
      if (error instanceof DumpRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}

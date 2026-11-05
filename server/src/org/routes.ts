import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InstallDraft, OrgRepoList, OrgSettings, OrgStatus, Site, SiteInstall, TrashEntry } from '@devmagic-panel/shared';
import { DEFAULT_ORG_SETTINGS, orgName, orgScanMode, orgSettingsInput } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import type { Executor } from '../exec.js';
import type { RunStore } from '../store.js';
import { RepoRefused } from '../sites/repo.js';
import { ClaudeCodeError, claudeStatus, connectorProbe, findClaude, runClaude } from './claude-code.js';
import { recentDownloads, rcloneRemote } from './dumps.js';
import { GhRefused, ghOrgs, ghStatus } from './github-cli.js';
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
}

export interface OrgRouteDeps {
  exec: Executor;
  /** Where the scanned repos are kept. */
  store: RunStore;
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
  const claude = () => {
    const bin = findClaude(deps.home, deps.searchPath);
    if (!bin) throw new ClaudeCodeError('Claude Code is not installed or not found: install it and sign in with claude auth login, then check again');
    return bin;
  };
  const refused = (error: unknown) => error instanceof ClaudeCodeError || error instanceof GhRefused || error instanceof RepoRefused;

  api.get('/api/org/status', async (): Promise<OrgStatus> => {
    const [claude, gh, rclone] = await Promise.all([claudeStatus(deps.exec, deps.home, deps.searchPath), ghStatus(deps.exec), rcloneRemote(deps.exec)]);
    return {
      claude,
      gh,
      rclone,
      settings: readOrgSettings(deps.settingsFile),
    };
  });

  api.put<{ Body: unknown }>('/api/org/settings', async (request, reply): Promise<OrgSettings | undefined> => {
    const parsed = orgSettingsInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Not organization settings' });
    writeOrgSettings(deps.settingsFile, parsed.data);
    return parsed.data;
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

  api.get('/api/org/orgs', async (_request, reply): Promise<string[] | undefined> => {
    try {
      return await ghOrgs(deps.exec);
    } catch (error) {
      if (refused(error)) return reply.code(409).send({ error: (error as Error).message });
      throw error;
    }
  });

  // The stored list at once with scan=none (no gh needed), or after reading what is due, the new pushes or every repo.
  // When GitHub cannot be read the stored list still comes back, with the problem.
  api.get<{ Querystring: { org?: string; scan?: string } }>('/api/org/repos', async (request, reply): Promise<OrgRepoList | undefined> => {
    const org = orgName.safeParse(request.query.org);
    if (!org.success) return reply.code(400).send({ error: 'Name an organization' });
    const mode = orgScanMode.safeParse(request.query.scan ?? 'none');
    if (!mode.success) return reply.code(400).send({ error: 'scan is none, auto, check or full' });
    const local = { sites: await deps.sites(), installs: deps.installs(), trash: await deps.trash().catch(() => []), drafts: deps.drafts() };
    return scanner.repos(org.data, local, mode.data);
  });

  // Dumps you downloaded in the browser, to pick one when rclone is not set up.
  api.get('/api/downloads', async () => recentDownloads(deps.home));
}

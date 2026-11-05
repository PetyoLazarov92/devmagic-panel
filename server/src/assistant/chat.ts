import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { ActionId, AuraReport, ChatReply, ChatTurn, EnvironmentReport, Proposal, Site } from '@devmagic-panel/shared';
import { actions, ASSISTANT_EXCLUDED_ACTIONS, localName, mountPath } from '@devmagic-panel/shared';
import { z } from 'zod';
import type { SystemConfig } from '../config.js';
import type { CoreStatusMap } from '../core-status.js';
import type { Executor } from '../exec.js';
import { servicesReport } from '../services.js';
import { coresReport } from '../sites/cores.js';
import { gitFolder, readGitDetails } from '../sites/git.js';
import { findVhost } from '../sites/discover.js';
import { findSiteRepo } from '../sites/repo.js';
import { readSiteLog } from '../sites/routes.js';
import type { RunStore } from '../store.js';
import { redact } from './redact.js';

export interface ChatDeps {
  config: SystemConfig;
  exec: Executor;
  store: RunStore;
  wpcoreConf: string;
  sites: () => Promise<Site[]>;
  aura: () => Promise<AuraReport>;
  environment: () => Promise<EnvironmentReport>;
  coreStatus: () => Promise<CoreStatusMap | null>;
  /** This machine's conventions.md, or its default. */
  conventions: () => string;
}

const SYSTEM = `You are the assistant inside devmagic-panel, a control panel for the local WordPress sites on this developer's Ubuntu machine.
Look before you answer: use the read tools (sites, findings, environment, logs, repo docs, conventions, git, services, cores, recent runs). Base answers on what they return.
To change anything, call the matching action tool. That only shows the user a card with a Run button; nothing runs until they click it. Never say a change was made. Propose one card per change, with a one-line reason in "why".
You cannot run shell commands, read other files or see database contents, and some actions (removing sites, restoring or importing databases, creating sites, removing cores) are only on their own pages; say so when asked.
Answer briefly in plain sentences, without em dashes. Never repeat anything that looks like a password, key or token.`;

const MAX_RESULT = 12_000;

/** Every tool result is redacted and capped, so a big log or report cannot flood the context or leak secrets. */
const out = (value: unknown) => {
  const text = redact(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[cut at ${MAX_RESULT} characters]` : text;
};

const readFirst = (file: string, max = 4000) => (existsSync(file) ? readFileSync(file, 'utf8').slice(0, max) : undefined);

/** The read tools: they run at once and only read. `looked` records each call for the reply. */
export function readTools(deps: ChatDeps, looked: string[]) {
  const note = (what: string) => looked.push(what);
  const site = z.object({ domain: localName.describe('The site\'s primary domain, like local.northwind.com') });
  return [
    betaZodTool({
      name: 'list_sites',
      description: 'Every local site: domain, title, health, issue count, WordPress core, branch, multisite, Local mode.',
      inputSchema: z.object({}),
      run: async () => {
        note('list_sites');
        return out(
          (await deps.sites()).map((s) => ({
            domain: s.domain, title: s.title, health: s.health, issues: s.issues.length, core: s.core,
            branch: s.git?.branch, multisite: s.network ? `${s.network.mode}, ${s.network.sites.length} sites` : undefined, localMode: s.localMode?.enabled,
          })),
        );
      },
    }),
    betaZodTool({
      name: 'site_details',
      description: 'One site in full: aliases, folder, cert, git, database name and size, debug, Local mode, mounted folders and its issues.',
      inputSchema: site,
      run: async ({ domain }) => {
        note(`site_details ${domain}`);
        const found = (await deps.sites()).find((s) => s.domain === domain);
        return found ? out(found) : `No site called ${domain}.`;
      },
    }),
    betaZodTool({
      name: 'aura_findings',
      description: 'Every problem the panel found across sites and this machine, with the label of its one-click fix when there is one.',
      inputSchema: z.object({}),
      run: async () => {
        note('aura_findings');
        return out((await deps.aura()).items.map((i) => ({ site: i.domain ?? 'this machine', status: i.status, problem: i.text, fix: i.fix?.label, hint: i.hint })));
      },
    }),
    betaZodTool({
      name: 'environment_checks',
      description: 'The machine checks (Apache, certificates, hosts, MySQL, PHP, tools, access) that are not ok.',
      inputSchema: z.object({}),
      run: async () => {
        note('environment_checks');
        const report = await deps.environment();
        return out({ ok: report.checks.filter((c) => c.status === 'ok').length, notOk: report.checks.filter((c) => c.status !== 'ok').map((c) => ({ check: c.label, status: c.status, detail: c.detail })) });
      },
    }),
    betaZodTool({
      name: 'read_log',
      description: 'The last lines of a site\'s debug.log or its Apache error log, newest last.',
      inputSchema: site.extend({ source: z.enum(['debug', 'apache']).default('debug'), lines: z.number().int().min(1).max(60).default(30) }),
      run: async ({ domain, source, lines }) => {
        note(`read_log ${domain} ${source}`);
        const log = readSiteLog(deps.config, domain, source);
        if (!log) return `No site called ${domain}.`;
        if (!log.exists) return `${log.file} does not exist.`;
        return out(log.lines.slice(-lines).map((l) => `[${l.time}] ${l.level}: ${l.message.slice(0, 400)}`).join('\n') || 'The log is empty.');
      },
    }),
    betaZodTool({
      name: 'read_repo_docs',
      description: "Where a site's repo is (site root, wp-content, a theme or a plugin) and the start of its README.md and CLAUDE.md, for the client's own conventions.",
      inputSchema: site,
      run: async ({ domain }) => {
        note(`read_repo_docs ${domain}`);
        const vhost = findVhost(deps.config, domain);
        if (!vhost?.docroot || vhost.names[0] !== domain) return `No site called ${domain}.`;
        const repo = findSiteRepo(vhost.docroot);
        if (!repo) return `${domain} has no git repo.`;
        return out({ repo, readme: readFirst(join(repo.root, 'README.md')), claudeMd: readFirst(join(repo.root, 'CLAUDE.md')) });
      },
    }),
    betaZodTool({
      name: 'git_status',
      description: 'A site repo (or a mounted folder like /learn): branches, the last commits and uncommitted changes.',
      inputSchema: site.extend({ mount: mountPath.optional() }),
      run: async ({ domain, mount }) => {
        note(`git_status ${domain}${mount ?? ''}`);
        try {
          const details = await readGitDetails(deps.exec, gitFolder(deps.config, domain, mount));
          return out({ current: details.branches.find((b) => b.current)?.name, branches: details.branches.slice(0, 40).map((b) => b.name), commits: details.commits.slice(0, 10), changes: details.changes.slice(0, 50) });
        } catch (error) {
          return (error as Error).message;
        }
      },
    }),
    betaZodTool({
      name: 'services_status',
      description: 'Apache, MySQL and Mailpit state, PHP versions and Xdebug.',
      inputSchema: z.object({}),
      run: async () => {
        note('services_status');
        return out(await servicesReport(deps.config, deps.exec));
      },
    }),
    betaZodTool({
      name: 'wordpress_cores',
      description: 'The shared WordPress cores with their WordPress.org status and the sites on each, plus releases worth adding.',
      inputSchema: z.object({}),
      run: async () => {
        note('wordpress_cores');
        return out(coresReport(deps.config, deps.wpcoreConf, await deps.coreStatus()));
      },
    }),
    betaZodTool({
      name: 'read_conventions',
      description: 'This machine\'s conventions.md: how local sites are named and set up here.',
      inputSchema: z.object({}),
      run: async () => {
        note('read_conventions');
        return out(deps.conventions());
      },
    }),
    betaZodTool({
      name: 'recent_runs',
      description: 'The last actions the panel ran, with their result.',
      inputSchema: z.object({}),
      run: async () => {
        note('recent_runs');
        return out(deps.store.recent().slice(0, 20).map((r) => ({ action: r.action, ok: r.exitCode === null ? 'running' : r.exitCode === 0, startedAt: r.startedAt })));
      },
    }),
  ];
}

/** Tool names cannot hold dots: site.clearCache becomes site_clearCache. */
export const toolNameFor = (id: ActionId) => id.replace('.', '_');

/**
 * One tool per registry action, built from the action's own schema. Calling
 * one only adds a proposal card; the card runs the action through the same
 * route as the panel's buttons once you click Run.
 */
export function actionTools(
  propose: (proposal: Proposal) => void,
  reply = 'Shown to the user as a card with a Run button. It has not run; do not say it did.',
) {
  return (Object.keys(actions) as ActionId[])
    .filter((id) => !ASSISTANT_EXCLUDED_ACTIONS.includes(id))
    .map((id) => {
      const action = actions[id];
      return betaZodTool({
        name: toolNameFor(id),
        description: `${action.title}. ${action.description} Calling this only shows the user a card with a Run button; it does not run anything.`,
        inputSchema: z.object({ input: action.input, why: z.string().max(300).describe('One line: why this helps') }),
        run: async ({ input, why }) => {
          propose({ id: randomUUID(), action: id, title: action.title, description: action.description, input: input as Record<string, unknown>, why });
          return reply;
        },
      });
    });
}

export async function chat(client: Anthropic, model: string, deps: ChatDeps, turns: ChatTurn[]): Promise<ChatReply> {
  const proposals: Proposal[] = [];
  const looked: string[] = [];
  const final = await client.beta.messages.toolRunner({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    tools: [...readTools(deps, looked), ...actionTools((p) => proposals.push(p))],
    messages: turns.map((t) => ({ role: t.role, content: t.content })),
    max_iterations: 12,
  });
  if (final.stop_reason === 'refusal') return { reply: 'Claude declined to answer that.', proposals: [], looked };
  const reply = final.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  return { reply, proposals, looked };
}

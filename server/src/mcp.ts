import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompatScan } from '@devmagic-panel/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { actionTools, readTools, type ChatDeps } from './assistant/chat.js';
import { readConventions } from './assistant/conventions.js';
import { readAura } from './aura.js';
import { readLocalConstants } from './local-constants.js';
import { DMP_ROOT, loadConfig, userPaths } from './config.js';
import { coreStatusSource } from './core-status.js';
import { checkEnvironment, defaultHostPaths } from './environment.js';
import { runCommand } from './exec.js';
import { readSecrets } from './secrets.js';
import { discoverSites } from './sites/discover.js';
import { RunStore } from './store.js';

const INSTRUCTIONS = `devmagic-panel manages the local WordPress sites on this machine (Apache vhosts, certs, hosts, databases, git, WordPress cores).
Read tools answer at once. Tools named propose_* never change anything: they queue a card in the panel, and the user runs it there with a click. Never say a proposed change was made.`;

/** The tools as MCP lists them; read tools as they are, action tools as propose_<action>. */
interface McpTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  parse: (input: unknown) => unknown;
  run: (input: never) => unknown;
}

/**
 * The panel's tools for MCP clients like Claude Code and Claude Desktop: the
 * same read tools the in-panel chat has, and every registry action the chat
 * may propose as a propose_* tool that only queues a card in the panel.
 */
export function createMcpServer(deps: ChatDeps, store: RunStore, panelUrl: string, version: string): Server {
  const server = new Server({ name: 'devmagic-panel', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const source = () => server.getClientVersion()?.name ?? 'an MCP client';
  const reply = `Queued in devmagic-panel (${panelUrl}). It runs only when the user clicks Run there; do not say it ran.`;
  const read = readTools(deps, []) as unknown as McpTool[];
  const propose = (actionTools((p) => store.addProposal(p, source()), reply) as unknown as McpTool[]).map((t) => ({ ...t, name: `propose_${t.name}` }));
  const tools = [...read.map((t) => ({ tool: t, readOnly: true })), ...propose.map((t) => ({ tool: t, readOnly: false }))];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ tool, readOnly }) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.input_schema as { type: 'object'; properties?: Record<string, unknown> },
      annotations: readOnly ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = tools.find(({ tool }) => tool.name === request.params.name);
    if (!entry) return { content: [{ type: 'text', text: `No tool called ${request.params.name}` }], isError: true };
    try {
      // The tool's own schema checks the arguments before anything runs.
      const result = await entry.tool.run(entry.tool.parse(request.params.arguments ?? {}) as never);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    }
  });
  return server;
}

/** `devmagic-panel mcp`: the MCP server on stdio, reading the same config, store and sites as the panel. */
export async function runMcpStdio(version: string): Promise<void> {
  const config = loadConfig();
  const paths = userPaths();
  const hostPaths = defaultHostPaths(homedir());
  const store = new RunStore(paths.databaseFile);
  const coreStatus = coreStatusSource(join(paths.dataDir, 'wp-core-status.json'));
  const sites = async () => discoverSites({ config, exec: runCommand, secrets: readSecrets(paths.secretsFile), wpcoreConf: hostPaths.wpcoreConf, coreStatus: await coreStatus() });
  const deps: ChatDeps = {
    config,
    exec: runCommand,
    store,
    wpcoreConf: hostPaths.wpcoreConf,
    sites,
    aura: async () => readAura({ config, exec: runCommand, localConstants: readLocalConstants(store), compatScans: (key) => store.compatScans(key) as CompatScan[] }, await sites()),
    environment: () => checkEnvironment({ config, exec: runCommand, secrets: readSecrets(paths.secretsFile), paths: hostPaths, dmpRoot: process.env.DEVMAGIC_PANEL_DMP_ROOT ?? DMP_ROOT }),
    coreStatus,
    conventions: () => readConventions(join(paths.configDir, 'conventions.md'), config, hostPaths.wpcoreConf).text,
  };
  const server = createMcpServer(deps, store, `https://${config.PANEL_DOMAIN}`, version);
  await server.connect(new StdioServerTransport());
}

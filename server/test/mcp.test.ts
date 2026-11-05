import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Site } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { ChatDeps } from '../src/assistant/chat.js';
import { createMcpServer } from '../src/mcp.js';
import { RunStore } from '../src/store.js';
import { fakeExec, NO_DEBUG_CONSTANTS, wpSiteTree } from './helpers.js';

const SITE: Site = {
  domain: 'local.shop.com', aliases: [], docroot: '/var/www/local.shop.com', vhostManaged: false, removable: false, panelMade: false,
  core: { kind: 'wpcore', version: '7.1.3' }, debug: { enabled: false, logBytes: 0, constants: NO_DEBUG_CONSTANTS }, health: 'ok', issues: [],
};

async function connect() {
  const t = wpSiteTree();
  const fake = fakeExec();
  const store = new RunStore(':memory:');
  const deps: ChatDeps = {
    config: t.config, exec: fake.exec, store, wpcoreConf: t.wpcoreConf, sites: async () => [SITE],
    aura: async () => ({ checkedAt: '', items: [] }), environment: async () => ({ checkedAt: '', durationMs: 0, checks: [] }),
    coreStatus: async () => null, conventions: () => '# ours',
  };
  const server = createMcpServer(deps, store, 'https://local.devmagic', '9.9.9');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, store, calls: fake.calls };
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

describe('MCP server', () => {
  it('lists read tools as read-only and actions as propose_* tools, without the destructive ones', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_sites');
    expect(names).toContain('propose_cert_reissue');
    expect(names).not.toContain('propose_site_remove');
    expect(names).not.toContain('cert_reissue');
    expect(tools.find((t) => t.name === 'list_sites')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'propose_cert_reissue')?.inputSchema.type).toBe('object');
    expect(client.getInstructions()).toContain('propose_*');
  });

  it('answers read tools and queues proposals in the panel, running nothing', async () => {
    const { client, store, calls } = await connect();
    expect(text(await client.callTool({ name: 'list_sites', arguments: {} }))).toContain('local.shop.com');
    const queued = await client.callTool({ name: 'propose_cert_reissue', arguments: { input: { domain: 'local.shop.com' }, why: 'Old CA' } });
    expect(text(queued)).toContain('Queued in devmagic-panel (https://local.devmagic)');
    expect(store.pendingProposals()).toMatchObject([{ action: 'cert.reissue', input: { domain: 'local.shop.com' }, why: 'Old CA', source: 'claude-code' }]);
    expect(calls).toHaveLength(0);
  });

  it('refuses bad arguments and unknown tools as tool errors', async () => {
    const { client, store } = await connect();
    expect((await client.callTool({ name: 'propose_hosts_add', arguments: { input: { domain: 'www.example.com' }, why: 'x' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'nope', arguments: {} })).isError).toBe(true);
    expect(store.pendingProposals()).toEqual([]);
  });
});

describe('proposal queue', () => {
  it('lists pending proposals and closes each once', () => {
    const store = new RunStore(':memory:');
    store.addProposal({ id: 'a', action: 'site.clearCache', title: 'Clear caches', description: '', input: { domain: 'local.shop.com' } }, 'claude-code');
    expect(store.pendingProposals().map((p) => p.id)).toEqual(['a']);
    expect(store.closeProposal('a', 'ran')).toBe(true);
    expect(store.closeProposal('a', 'dismissed')).toBe(false);
    expect(store.pendingProposals()).toEqual([]);
  });
});

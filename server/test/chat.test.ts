import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Proposal, Site } from '@devmagic-panel/shared';
import { actions, ASSISTANT_EXCLUDED_ACTIONS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { actionTools, chat, readTools, type ChatDeps } from '../src/assistant/chat.js';
import { RunStore } from '../src/store.js';
import { fakeExec, NO_DEBUG_CONSTANTS, wpSiteTree } from './helpers.js';

const SITE: Site = {
  domain: 'local.shop.com', aliases: [], docroot: '/var/www/local.shop.com', vhostManaged: false, server: 'apache', removable: false, panelMade: false,
  core: { kind: 'wpcore', version: '7.1.3' }, debug: { enabled: true, logBytes: 0, constants: NO_DEBUG_CONSTANTS }, health: 'warn',
  issues: [{ id: 'cert.legacy', status: 'warn', text: 'Cert still signed by the old LocalhostCA' }],
};

function deps(): ChatDeps & { calls: ReturnType<typeof fakeExec>['calls']; docroot: string } {
  const t = wpSiteTree();
  const fake = fakeExec();
  return {
    config: t.config, exec: fake.exec, store: new RunStore(':memory:'), wpcoreConf: t.wpcoreConf,
    sites: async () => [SITE], aura: async () => ({ checkedAt: '', items: [{ ...SITE.issues[0] as Site['issues'][number], domain: SITE.domain }] }),
    environment: async () => ({ checkedAt: '', durationMs: 0, checks: [] }), coreStatus: async () => null, conventions: () => '# Local site conventions',
    calls: fake.calls, docroot: t.docroot,
  };
}

/** The parts of a runnable tool these tests use; the SDK's own type is a wide union. */
type Tool = { name: string; input_schema: { type: string }; run: (input: unknown) => Promise<unknown>; parse: (input: unknown) => unknown };
const byName = (tools: unknown[], name: string) => (tools as Tool[]).find((t) => t.name === name) as Tool;

describe('action tools', () => {
  it('cover every action except the destructive ones, each with a JSON schema built from the registry', () => {
    const tools = actionTools(() => undefined);
    const names = tools.map((t) => t.name);
    for (const id of ASSISTANT_EXCLUDED_ACTIONS) expect(names).not.toContain(id.replace('.', '_'));
    expect(names).toContain('cert_reissue');
    expect(tools).toHaveLength(Object.keys(actions).length - ASSISTANT_EXCLUDED_ACTIONS.length);
    for (const tool of tools as unknown as Tool[]) expect(tool.input_schema.type).toBe('object');
  });

  it('only record a proposal, with the registry\'s defaults filled in and bad input refused', async () => {
    const proposals: Proposal[] = [];
    const tool = byName(actionTools((p) => proposals.push(p)), 'php_setXdebug');
    const result = await tool.run(tool.parse({ input: { enabled: true }, why: 'Debug the cart' }));
    expect(result).toContain('has not run');
    expect(proposals).toEqual([{ id: expect.any(String), action: 'php.setXdebug', title: 'Turn Xdebug on or off', description: actions['php.setXdebug'].description, input: { enabled: true, modes: ['debug'], startWithRequest: 'trigger' }, why: 'Debug the cart' }]);
    expect(() => byName(actionTools(() => undefined), 'hosts_add').parse({ input: { domain: 'www.example.com' }, why: 'x' })).toThrow();
  });
});

describe('read tools', () => {
  it('read a log with secrets blanked out, and say when a site does not exist', async () => {
    const d = deps();
    writeFileSync(join(d.docroot, 'wp-content/debug.log'), "[24-Oct-2026 08:30:00 UTC] PHP Warning:  DB password=hunter2 failed in /x.php\n");
    const looked: string[] = [];
    const tools = readTools(d, looked);
    const log = byName(tools, 'read_log');
    const text = await log.run(log.parse({ domain: 'local.shop.com' }));
    expect(text).toContain('password=[redacted]');
    expect(text).not.toContain('hunter2');
    const details = byName(tools, 'site_details');
    expect(await details.run(details.parse({ domain: 'local.nope.com' }))).toBe('No site called local.nope.com.');
    expect(looked).toEqual(['read_log local.shop.com debug', 'site_details local.nope.com']);
    expect(() => log.parse({ domain: '../../etc' })).toThrow();
  });
});

describe('chat', () => {
  it('lets Claude read and propose, runs nothing, and returns the reply with its cards', async () => {
    const d = deps();
    let params: { tools: Tool[]; messages: unknown; model: string } | undefined;
    const client = {
      beta: {
        messages: {
          // Stands in for the tool runner: calls two tools the way the model would, then answers.
          toolRunner: async (p: NonNullable<typeof params>) => {
            params = p;
            const list = byName(p.tools, 'list_sites');
            await list.run(list.parse({}));
            const reissue = byName(p.tools, 'cert_reissue');
            await reissue.run(reissue.parse({ input: { domain: 'local.shop.com' }, why: 'Old CA' }));
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'local.shop.com still uses the old CA.' }] };
          },
        },
      },
    } as unknown as Anthropic;
    const reply = await chat(client, 'claude-opus-5-5', d, [{ role: 'user', content: 'Anything wrong?' }]);
    expect(reply).toMatchObject({ reply: 'local.shop.com still uses the old CA.', looked: ['list_sites'], proposals: [{ action: 'cert.reissue', input: { domain: 'local.shop.com' } }] });
    expect(params).toMatchObject({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Anything wrong?' }] });
    expect(d.calls).toHaveLength(0);
  });
});

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AuraReport } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Briefings, briefingContext, type ClaudeFactory } from '../src/assistant/briefing.js';
import { redact } from '../src/assistant/redact.js';
import { hashPassword, readSecrets, writeSecrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const REPORT: AuraReport = {
  checkedAt: '2026-10-24T09:00:00Z',
  items: [
    { id: 'php.fatals', status: 'fail', text: '3 PHP fatal errors in the last hour', domain: 'local.arcade.example' },
    { id: 'cert.legacy', status: 'warn', text: 'Cert still signed by the old LocalhostCA', domain: 'local.spellbook.example', fix: { action: 'cert.reissue', input: { domain: 'local.spellbook.example' }, label: 'Reissue cert' } },
  ],
};

/** A stand-in for the Anthropic client: records calls and answers with a fixed briefing. */
function fakeClaude(output: unknown = { headline: 'Two things.', points: [{ text: 'Fix arcade.', items: [1, 9] }, { text: 'Reissue Spellbook.', items: [2, 2] }] }) {
  const calls: Array<{ apiKey: string | undefined; params: Record<string, unknown> }> = [];
  const factory: ClaudeFactory = (apiKey) =>
    ({
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push({ apiKey, params });
          return { stop_reason: 'end_turn', parsed_output: output };
        },
        countTokens: async () => {
          calls.push({ apiKey, params: { count: true } });
          return { input_tokens: 3 };
        },
      },
      beta: {
        messages: {
          toolRunner: async (params: Record<string, unknown>) => {
            calls.push({ apiKey, params: { chat: (params.messages as unknown[]).length } });
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All quiet.' }] };
          },
        },
      },
    }) as unknown as Anthropic;
  return { factory, calls };
}

describe('redact', () => {
  it('blanks wp-config secrets, keys, passwords and long tokens', () => {
    const text = [
      "define( 'DB_PASSWORD', 'hunter2' );",
      "define('AUTH_SALT', 'a;b\\'c');",
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'mysql://root:secret@localhost/db',
      'password=topsecret token: abc123',
      'hash 0123456789abcdef0123456789abcdef01',
    ].join('\n');
    const out = redact(text);
    for (const secret of ['hunter2', "a;b\\'c", 'abcdefghijklmnopqrstuvwxyz', 'secret@', 'topsecret', 'abc123', '0123456789abcdef0123456789abcdef01']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("define( 'DB_PASSWORD', '[redacted]' );");
  });

  it('keeps what a briefing needs: domains, paths and messages', () => {
    const line = 'PHP Fatal error: Uncaught Error in /var/www/local.dailypost.example/wp-content/themes/dailypost-child/inc/integrations/newsletter.php:42';
    expect(redact(line)).toBe(line);
  });
});

describe('Briefings', () => {
  it('numbers the findings, ties points back to real items and drops numbers Claude made up', async () => {
    const claude = fakeClaude();
    const briefing = await new Briefings(claude.factory).brief(REPORT, 'claude-opus-5-5', 'sk-ant-test');
    expect(briefing).toMatchObject({ status: 'ready', headline: 'Two things.', model: 'claude-opus-5-5' });
    if (briefing.status !== 'ready') throw new Error('not ready');
    expect(briefing.points.map((p) => p.items.map((i) => i.id))).toEqual([['php.fatals'], ['cert.legacy']]);
    expect(briefing.sent).toBe(briefingContext(REPORT));
    expect(JSON.parse(briefing.sent)[1]).toEqual({ n: 2, site: 'local.spellbook.example', status: 'warn', problem: 'Cert still signed by the old LocalhostCA', fix: 'Reissue cert' });
    expect(claude.calls[0]).toMatchObject({ apiKey: 'sk-ant-test', params: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: briefing.sent }] } });
  });

  it('asks Claude once per set of findings and model, and not at all when nothing is wrong', async () => {
    const claude = fakeClaude();
    const briefings = new Briefings(claude.factory);
    await briefings.brief(REPORT, 'claude-opus-5-5', undefined);
    await briefings.brief(REPORT, 'claude-opus-5-5', undefined);
    await briefings.brief(REPORT, 'claude-haiku-5-5', undefined);
    expect(claude.calls).toHaveLength(2);
    expect((await briefings.brief({ checkedAt: '', items: [] }, 'claude-opus-5-5', undefined)).status).toBe('clear');
    expect(claude.calls).toHaveLength(2);
  });

  it('reports a failure without caching it', async () => {
    let fail = true;
    const factory: ClaudeFactory = () =>
      ({
        messages: {
          parse: async () => {
            if (fail) throw new Error('connect ECONNREFUSED');
            return { stop_reason: 'end_turn', parsed_output: { headline: 'ok', points: [] } };
          },
        },
      }) as unknown as Anthropic;
    const briefings = new Briefings(factory);
    expect(await briefings.brief(REPORT, 'claude-opus-5-5', undefined)).toEqual({ status: 'error', error: 'connect ECONNREFUSED' });
    fail = false;
    expect((await briefings.brief(REPORT, 'claude-opus-5-5', undefined)).status).toBe('ready');
  });
});

describe('assistant routes', () => {
  const HOST = 'local.devmagic';
  const ORIGIN = 'https://local.devmagic';
  let app: FastifyInstance;
  let store: RunStore;
  let cookie: string;
  let secretsFile: string;
  let claude: ReturnType<typeof fakeClaude>;

  beforeEach(async () => {
    const tree = tempTree();
    secretsFile = join(tree.root, 'home/.config/devmagic-panel/secrets.json');
    writeSecrets(secretsFile, { panelPasswordHash: await hashPassword('correct horse') });
    store = new RunStore(':memory:');
    claude = fakeClaude();
    app = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => readSecrets(secretsFile), hostPaths: tree.hostPaths,
      dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true,
      secretsFile, settingsFile: join(tree.root, 'home/.config/devmagic-panel/settings.json'), claude: claude.factory,
    });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('start off, with no briefing and no call to Claude', async () => {
    expect((await call('GET', '/api/assistant')).json()).toEqual({ enabled: false, model: 'claude-opus-5-5', keySource: 'none' });
    expect((await call('GET', '/api/assistant/briefing')).json()).toEqual({ status: 'off' });
    expect(claude.calls).toHaveLength(0);
  });

  it('save the key 0600 without ever sending it back, and remove it', async () => {
    const key = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
    expect((await call('PUT', '/api/assistant/key', { apiKey: 'not-a-key' })).statusCode).toBe(400);
    const saved = await call('PUT', '/api/assistant/key', { apiKey: key });
    expect(saved.json()).toEqual({ enabled: false, model: 'claude-opus-5-5', keySource: 'panel', keyHint: 'CRET' });
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(secretsFile, 'utf8'))).toMatchObject({ panelPasswordHash: expect.any(String), anthropic: { apiKey: key } });
    for (const url of ['/api/assistant', '/api/assistant/briefing']) expect((await call('GET', url)).body).not.toContain('SECRET');
    expect((await call('DELETE', '/api/assistant/key', {})).json().keySource).toBe('none');
    expect(readFileSync(secretsFile, 'utf8')).not.toContain('anthropic');
  });

  it('brief with the saved key and model once switched on, and test with a token count', async () => {
    await call('PUT', '/api/assistant/key', { apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuv' });
    expect((await call('PUT', '/api/assistant', { enabled: true, model: 'claude-haiku-5-5' })).json()).toMatchObject({ enabled: true, model: 'claude-haiku-5-5' });
    expect((await call('PUT', '/api/assistant', { model: 'gpt-4' })).statusCode).toBe(400);
    expect((await call('POST', '/api/assistant/test', {})).json()).toEqual({ ok: true });
    const briefing = (await call('GET', '/api/assistant/briefing')).json();
    // The test tree has no sites, so there is nothing to brief about.
    expect(briefing.status).toBe('clear');
    expect(claude.calls).toEqual([{ apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuv', params: { count: true } }]);
  });

  it('chat only while switched on, with a valid conversation', async () => {
    const turn = { messages: [{ role: 'user', content: 'Anything wrong?' }] };
    expect((await call('POST', '/api/assistant/chat', turn)).statusCode).toBe(409);
    await call('PUT', '/api/assistant', { enabled: true });
    expect((await call('POST', '/api/assistant/chat', { messages: [] })).statusCode).toBe(400);
    expect((await call('POST', '/api/assistant/chat', { messages: [{ role: 'assistant', content: 'hi' }] })).statusCode).toBe(400);
    expect((await call('POST', '/api/assistant/chat', turn)).json()).toEqual({ reply: 'All quiet.', proposals: [], looked: [] });
    expect(claude.calls.at(-1)).toEqual({ apiKey: undefined, params: { chat: 1 } });
  });

  it('serve the default conventions until saved, and refuse the wizard while off', async () => {
    const before = (await call('GET', '/api/assistant/conventions')).json();
    expect(before).toMatchObject({ saved: false, text: expect.stringContaining('# Local site conventions') });
    expect((await call('PUT', '/api/assistant/conventions', { text: '# Ours' })).json()).toMatchObject({ saved: true, text: '# Ours\n' });
    expect((await call('POST', '/api/assistant/wizard', { description: 'Wandworks' })).statusCode).toBe(409);
    await call('PUT', '/api/assistant', { enabled: true });
    expect((await call('POST', '/api/assistant/wizard', { description: 'Wandworks', repoUrl: 'ext::sh -c id' })).statusCode).toBe(400);
  });

  it('refuse settings changes from another origin', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/assistant', headers: { host: HOST, origin: 'https://evil.example.com', cookie }, payload: { enabled: true } });
    expect(res.statusCode).toBe(403);
  });
});


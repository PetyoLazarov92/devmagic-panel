import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStep } from '../src/jobs.js';
import { hashPassword, readSecrets, writeSecrets } from '../src/secrets.js';
import { forgetSshPassword, savedSshPassword, saveSshPassword } from '../src/ssh-saved.js';
import { planServerDump } from '../src/sites/more-dumps.js';
import { PASSWORD_OPTIONS } from '../src/sites/ssh-password.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, type FakeResponse, healthyResponses, tempTree, wpSiteTree } from './helpers.js';

const SECRET = 'correct horse battery';
const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';
const DONE = "-- MySQL dump\nCREATE TABLE `wp_options` (x int);\n-- Dump completed on 2026-11-10 10:00:00\n";
const job = () => ({ progress: () => undefined, onUndo: () => undefined }) as unknown as Parameters<JobStep['run']>[0];

async function secretsFile() {
  const t = tempTree();
  const file = join(t.root, 'config', 'secrets.json');
  writeSecrets(file, { panelPasswordHash: await hashPassword('correct horse'), mysql: { user: 'root', password: 'db-secret', host: 'localhost' } });
  return { t, file };
}

describe('a saved SSH password', () => {
  it('is kept in secrets.json (0600) by host without case, next to what is there, and forgotten again', async () => {
    const { file } = await secretsFile();
    expect(saveSshPassword(file, 'Spellbook-Prod', SECRET)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const kept = readSecrets(file);
    expect(kept?.mysql?.password).toBe('db-secret');
    expect(savedSshPassword(kept, 'spellbook-prod')).toBe(SECRET);
    expect(forgetSshPassword(file, 'spellbook-prod')).toBe(true);
    expect(readSecrets(file)?.sshPasswords).toBeUndefined();
    expect(forgetSshPassword(file, 'spellbook-prod')).toBe(false);
  });

  it('takes one line only, as ssh askpass hands it on', async () => {
    const { file } = await secretsFile();
    expect(() => saveSshPassword(file, 'spellbook-prod', 'two\nlines')).toThrow();
    expect(() => saveSshPassword(file, 'spellbook-prod', '')).toThrow();
  });

  function setup(responses: Record<string, FakeResponse>, saved?: string) {
    const t = wpSiteTree();
    const runtimeDir = join(t.root, 'run');
    mkdirSync(runtimeDir);
    const fake = fakeExec({ mkfifo: { stdout: '' }, ...responses });
    const fed: string[] = [];
    const feed = async (_fifo: string, text: string) => void fed.push(text);
    const secrets = { panelPasswordHash: 'x', ...(saved ? { sshPasswords: { 'alex@www.spellbook.example': saved } } : {}) };
    const ctx = { config: t.config, exec: fake.exec, uploadsDir: join(t.root, 'uploads'), dmpRoot: DMP, sshPassword: { runtimeDir, feed }, secrets };
    return { ctx, fake, fed };
  }

  it('signs a run in when none was typed, through the helper only, and a Retry has it too', async () => {
    const s = setup({ ssh: { stdout: DONE } }, SECRET);
    const steps = planServerDump(s.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined);
    await (steps[0] as JobStep).run(job());
    await (steps[0] as JobStep).run(job());
    const ssh = s.fake.calls.filter((c) => c.file === 'ssh');
    expect(ssh).toHaveLength(2);
    for (const call of ssh) expect(call.args.slice(0, 4)).toEqual(PASSWORD_OPTIONS);
    expect(s.fed).toEqual([`${SECRET}\n`, `${SECRET}\n`]);
    expect(JSON.stringify(s.fake.calls)).not.toContain(SECRET);
  });

  it('gives way to a password typed for the run, and says when the saved one was not taken', async () => {
    const typed = setup({ ssh: { stdout: DONE } }, SECRET);
    await (planServerDump(typed.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [], password: 'typed now' }, () => undefined)[0] as JobStep).run(job());
    expect(typed.fed).toEqual(['typed now\n']);
    const denied = setup({ ssh: { code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey,password).' } }, SECRET);
    const out = [await (planServerDump(denied.ctx, { host: 'alex@www.spellbook.example', mode: 'export', path: '/var/www/spellbook', excludeRows: [] }, () => undefined)[0] as JobStep).run(job())].flat();
    expect(out[0]?.stderr).toBe('alex@www.spellbook.example did not take the password saved for it: it may have changed. Give the new one under the host to replace it, or forget it');
  });
});

describe('the routes for a saved password and how a server signs you in', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function start() {
    const { t, file } = await secretsFile();
    const fake = fakeExec({ ...healthyResponses(), ssh: { code: 255, stderr: 'alex@www.spellbook.example: Permission denied (publickey,password).' } });
    app = await buildApp({ config: t.config, exec: fake.exec, store: new RunStore(':memory:'), secrets: () => readSecrets(file), secretsFile: file, hostPaths: t.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(t.root, 'uploads'), production: true });
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    const cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
    const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload: object) => app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, cookie }, payload });
    return { file, fake, call };
  }

  it('saves a password, never answers with it, and forgets it', async () => {
    const s = await start();
    const saved = await s.call('PUT', '/api/ssh/saved', { host: 'alex@www.spellbook.example', password: SECRET });
    expect(saved.json()).toEqual({ saved: true });
    const asked = await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example' });
    expect(asked.json()).toMatchObject({ how: 'password', saved: true });
    expect(asked.body + saved.body).not.toContain(SECRET);
    expect((await s.call('DELETE', '/api/ssh/saved', { host: 'alex@www.spellbook.example' })).json()).toEqual({ forgotten: true });
    expect(readSecrets(s.file)?.sshPasswords).toBeUndefined();
    expect((await s.call('PUT', '/api/ssh/saved', { host: 'alex@www.spellbook.example', password: 'a\nb' })).statusCode).toBe(400);
  });

  it('keeps how a server signs you in for an hour: the last answer connects to nothing, Check connection does', async () => {
    const s = await start();
    const ssh = () => s.fake.calls.filter((c) => c.file === 'ssh').length;
    expect((await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example', last: true })).json()).toEqual({ how: 'unchecked', saved: false });
    expect(ssh()).toBe(0);
    const first = (await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example' })).json();
    expect(first).toMatchObject({ how: 'password', checkedAt: expect.any(String) });
    await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example' });
    expect((await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example', last: true })).json()).toMatchObject({ how: 'password' });
    expect(ssh()).toBe(1);
    await s.call('POST', '/api/dumps/server-sign-in', { host: 'alex@www.spellbook.example', fresh: true });
    expect(ssh()).toBe(2);
  });
});

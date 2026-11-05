import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword, readSecrets, verifyPassword, writeSecrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { DMP, type FakeCall, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';
const SYSTEM = 'my computer pw';

let app: FastifyInstance;
let store: RunStore;

afterEach(async () => {
  await app.close();
  store.close();
});

/** A panel with a real secrets file; sudo asks for a password (or not, with `sudoNeedsNone`) and accepts SYSTEM on stdin. */
async function setup(opts: { sudoNeedsNone?: boolean; sudoRefused?: boolean } = {}) {
  const tree = tempTree();
  const file = join(tree.root, 'config', 'secrets.json');
  writeSecrets(file, { panelPasswordHash: await hashPassword('correct horse'), mysql: { user: 'root', host: 'localhost', password: 'db-secret' } });
  const fake = fakeExec({
    'sudo -n -k -v': opts.sudoNeedsNone ? {} : opts.sudoRefused ? { code: 1, stderr: 'Sorry, user alex may not run sudo on magic.' } : { code: 1, stderr: 'sudo: a password is required' },
    'sudo -k -S': (call: FakeCall) => (call.input === `${SYSTEM}\n` ? {} : { code: 1, stderr: 'Sorry, try again.' }),
    'sudo -K': {},
  });
  store = new RunStore(':memory:');
  app = await buildApp({
    config: tree.config, exec: fake.exec, store, secrets: () => readSecrets(file), secretsFile: file,
    hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true,
  });
  return { file, calls: fake.calls, user: tree.config.PANEL_USER };
}

const post = (url: string, payload: Record<string, string>, cookie?: string) => app.inject({ method: 'POST', url, headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}) }, payload });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}) } });

async function login(password = 'correct horse'): Promise<string> {
  const res = await post('/api/login', { password });
  expect(res.statusCode).toBe(204);
  return `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
}

describe('changing the panel password', () => {
  it('needs the current password, keeps this browser signed in and signs every other one out', async () => {
    const s = await setup();
    const other = await login();
    const mine = await login();
    expect((await post('/api/password', { current: 'nope', next: 'copper kettle rain' }, mine)).statusCode).toBe(403);
    expect((await post('/api/password', { current: 'correct horse', next: 'short' }, mine)).json()).toMatchObject({ error: 'At least 8 characters' });
    expect((await post('/api/password', { current: 'correct horse', next: 'password123' }, mine)).json().error).toMatch(/Too common/);

    const res = await post('/api/password', { current: 'correct horse', next: 'copper kettle rain' }, mine);
    expect(res.statusCode).toBe(204);
    const renewed = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
    expect((await get('/api/sites', other)).statusCode).toBe(401);
    expect((await get('/api/password', renewed)).statusCode).toBe(200);

    // The new hash, when it changed, and the other secrets kept, in a file only you can read.
    const saved = readSecrets(s.file);
    expect(await verifyPassword('copper kettle rain', saved?.panelPasswordHash as string)).toBe(true);
    expect(saved?.mysql?.password).toBe('db-secret');
    expect(Date.parse(saved?.panelPasswordChangedAt as string)).toBeGreaterThan(Date.now() - 60_000);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect((await get('/api/password', renewed)).json()).toEqual({ changedAt: saved?.panelPasswordChangedAt });
  });

  it('is only for a signed-in browser, and wrong current passwords count towards the login limit', async () => {
    await setup();
    expect((await post('/api/password', { current: 'correct horse', next: 'copper kettle rain' })).statusCode).toBe(401);
    const mine = await login();
    for (let i = 0; i < 10; i++) await post('/api/password', { current: `wrong ${i}`, next: 'copper kettle rain' }, mine);
    expect((await post('/api/password', { current: 'correct horse', next: 'copper kettle rain' }, mine)).statusCode).toBe(429);
  });
});

describe('resetting a forgotten panel password', () => {
  it('offers the computer password when sudo asks this account for one, and the terminal always', async () => {
    await setup();
    expect((await get('/api/password/reset')).json()).toEqual({ system: true, command: 'node ~/.local/share/devmagic-panel/current/server/dist/cli.js set-password' });
  });

  it('resets with the computer password, given to sudo on stdin only, and signs every browser out', async () => {
    const s = await setup();
    const before = await login();
    expect((await post('/api/password/reset', { system: SYSTEM, next: 'copper kettle rain' })).statusCode).toBe(204);
    expect(await verifyPassword('copper kettle rain', readSecrets(s.file)?.panelPasswordHash as string)).toBe(true);
    expect((await get('/api/sites', before)).statusCode).toBe(401);
    await login('copper kettle rain');
    const check = s.calls.find((c) => c.args.includes('-S')) as FakeCall;
    expect(check.args).toEqual(['-k', '-S', '-p', '', '-v']);
    expect(JSON.stringify(s.calls.map((c) => c.args))).not.toContain(SYSTEM);
    expect(s.calls.at(-1)?.args).toEqual(['-K']);
  });

  it('refuses a wrong computer password without writing, checks the new password before asking sudo, and locks for an hour after 5 failures from anyone', async () => {
    const s = await setup();
    const hash = readSecrets(s.file)?.panelPasswordHash;
    expect((await post('/api/password/reset', { system: SYSTEM, next: 'short' })).statusCode).toBe(400);
    expect(s.calls.some((c) => c.args.includes('-S'))).toBe(false);
    const wrong = await post('/api/password/reset', { system: 'guess', next: 'copper kettle rain' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: 'Your computer password was not accepted' });
    expect(readSecrets(s.file)?.panelPasswordHash).toBe(hash);
    for (let i = 0; i < 4; i++) await post('/api/password/reset', { system: `guess ${i}`, next: 'copper kettle rain' });
    const locked = await post('/api/password/reset', { system: SYSTEM, next: 'copper kettle rain' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/Too many attempts: try again after \d\d:\d\d, or use the terminal/);
    expect((await get('/api/password/reset')).json().lockedUntil).toBeDefined();
    expect(readSecrets(s.file)?.panelPasswordHash).toBe(hash);
  });

  it('hides the computer password where it proves nothing: sudo asks for none, or the account may not use sudo', async () => {
    await setup({ sudoNeedsNone: true });
    expect((await get('/api/password/reset')).json()).toMatchObject({ system: false, reason: expect.stringContaining('asks for no password') });
    expect((await post('/api/password/reset', { system: 'anything', next: 'copper kettle rain' })).statusCode).toBe(409);
    await app.close();
    store.close();
    await setup({ sudoRefused: true });
    expect((await get('/api/password/reset')).json()).toMatchObject({ system: false, reason: expect.stringContaining('may not use sudo') });
  });
});

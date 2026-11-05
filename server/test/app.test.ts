import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Sessions } from '../src/auth.js';
import { hashPassword, type Secrets } from '../src/secrets.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, healthyResponses, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';

let app: FastifyInstance;
let store: RunStore;
let calls: ReturnType<typeof fakeExec>['calls'];
let secrets: Secrets | null;

beforeEach(async () => {
  const tree = tempTree();
  const fake = fakeExec({ ...healthyResponses(), [`sudo -n ${DMP} hosts-add`]: { stdout: 'ok: hosts entry written\n' } });
  calls = fake.calls;
  store = new RunStore(':memory:');
  secrets = { panelPasswordHash: await hashPassword('correct horse') };
  app = await buildApp({
    config: tree.config,
    exec: fake.exec,
    store,
    secrets: () => secrets,
    hostPaths: tree.hostPaths,
    dmpRoot: DMP,
    version: '9.9.9', uploadsDir: join(tree.root, 'uploads'),
    production: true,
  });
});

afterEach(async () => {
  await app.close();
  store.close();
});

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' },
  });
  expect(res.statusCode).toBe(204);
  const cookie = res.cookies.find((c) => c.name === 'dmp_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  return `dmp_session=${cookie?.value}`;
}

describe('static files', () => {
  it('serve the app shell for page routes but 404 for missing assets', async () => {
    const tree = tempTree();
    tree.write('index.html', '<!doctype html><title>shell</title>');
    const web = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => secrets, hostPaths: tree.hostPaths,
      dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true, webRoot: tree.root,
    });
    const page = await web.inject({ method: 'GET', url: '/sites/local.a.com', headers: { host: HOST } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('shell');
    const asset = await web.inject({ method: 'GET', url: '/assets/index-missing.js', headers: { host: HOST } });
    expect(asset.statusCode).toBe(404);
    await web.close();
  });

  it('let the browser keep hashed assets and check the page on each load', async () => {
    const tree = tempTree();
    tree.write('index.html', '<!doctype html><title>shell</title>');
    mkdirSync(join(tree.root, 'assets'));
    tree.write('assets/index-a1b2c3.js', 'console.log(1)');
    tree.write('favicon.svg', '<svg/>');
    const web = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => secrets, hostPaths: tree.hostPaths,
      dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true, webRoot: tree.root,
    });
    const get = (url: string) => web.inject({ method: 'GET', url, headers: { host: HOST } });
    // A tab restored after a reboot loads these from the cache while the panel starts.
    const asset = await get('/assets/index-a1b2c3.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const url of ['/', '/index.html', '/sites/local.a.com', '/favicon.svg']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
    await web.close();
  });
});

describe('host and origin checks', () => {
  it('refuses unknown hosts (DNS rebinding)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(421);
  });

  it('refuses unsafe requests from another origin', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/login', headers: { host: HOST, origin: 'https://evil.example.com' }, payload: { password: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses unsafe requests without an origin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST }, payload: { password: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('allows the dev server origin only outside production', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'localhost:5173' } });
    expect(res.statusCode).toBe(421);
  });
});

describe('login', () => {
  it('reports the session state and setup status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST } });
    expect(res.json()).toMatchObject({ authenticated: false, version: '9.9.9', setupRequired: false });
  });

  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('asks for setup when no password exists', async () => {
    secrets = null;
    const res = await app.inject({
      method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'x' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('blocks after ten failures', async () => {
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'nope' } });
    }
    const res = await app.inject({
      method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' },
    });
    expect(res.statusCode).toBe(429);
    // When to try again, for the login page's countdown: about 15 minutes after the first failure.
    const wait = Number(res.headers['retry-after']);
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect(Math.abs(Date.parse(res.json().retryAt) - (Date.now() + wait * 1000))).toBeLessThan(2000);
  });

  it('logs in, keeps the session, and logs out', async () => {
    const cookie = await login();
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST, cookie } });
    expect(session.json().authenticated).toBe(true);
    await app.inject({ method: 'POST', url: '/api/logout', headers: { host: HOST, origin: ORIGIN, cookie } });
    const after = await app.inject({ method: 'GET', url: '/api/environment', headers: { host: HOST, cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('keeps the session through a restart, an update for one, storing only a hash of the token', async () => {
    const cookie = await login();
    const tree = tempTree();
    // The panel after a restart: a new app on the same database.
    const restarted = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => secrets, hostPaths: tree.hostPaths,
      dmpRoot: DMP, version: '9.9.10', uploadsDir: join(tree.root, 'uploads'), production: true,
    });
    const session = await restarted.inject({ method: 'GET', url: '/api/session', headers: { host: HOST, cookie } });
    expect(session.json().authenticated).toBe(true);
    await restarted.close();
    const token = cookie.split('=')[1] as string;
    expect(store.getSession(token)).toBeUndefined();
  });

  it('ends every session when the panel password changes', async () => {
    const cookie = await login();
    secrets = { panelPasswordHash: await hashPassword('battery staple') };
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST, cookie } });
    expect(session.json().authenticated).toBe(false);
    // And it stays ended with the old password back.
    secrets = { panelPasswordHash: await hashPassword('correct horse') };
    const again = await app.inject({ method: 'GET', url: '/api/environment', headers: { host: HOST, cookie } });
    expect(again.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('end 12 hours after their last use, and use extends them', () => {
    let now = 1_000_000;
    const sessions = new Sessions(store, () => secrets?.panelPasswordHash, () => now);
    const token = sessions.create();
    now += 11 * 3_600_000;
    expect(sessions.touch(token)).toBe(true);
    now += 11 * 3_600_000;
    expect(sessions.touch(token)).toBe(true);
    now += 13 * 3_600_000;
    expect(sessions.touch(token)).toBe(false);
    expect(sessions.touch(undefined)).toBe(false);
  });
});

describe('protected routes', () => {
  it('need a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/environment', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('return the environment report', async () => {
    const cookie = await login();
    const res = await app.inject({ method: 'GET', url: '/api/environment', headers: { host: HOST, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.length).toBeGreaterThan(10);
  });
});

describe('actions', () => {
  it('run through sudo -n dmp-root with validated arguments and are recorded', async () => {
    const cookie = await login();
    const res = await app.inject({
      method: 'POST', url: '/api/actions/hosts.add', headers: { host: HOST, origin: ORIGIN, cookie },
      payload: { domain: 'local.shop.com', aliases: ['local.shop.de'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, exitCode: 0 });
    expect(calls.at(-1)).toEqual({ file: 'sudo', args: ['-n', DMP, 'hosts-add', 'local.shop.com', 'local.shop.de'] });
    expect(store.recent()[0]).toMatchObject({ action: 'hosts.add', exitCode: 0 });
  });

  it('reject invalid input before any command runs', async () => {
    const cookie = await login();
    const before = calls.length;
    const res = await app.inject({
      method: 'POST', url: '/api/actions/hosts.add', headers: { host: HOST, origin: ORIGIN, cookie },
      payload: { domain: 'bank.example.com; rm -rf /' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(before);
  });

  it('answer 404 for unknown actions', async () => {
    const cookie = await login();
    const res = await app.inject({
      method: 'POST', url: '/api/actions/shell.run', headers: { host: HOST, origin: ORIGIN, cookie }, payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('report a failed step with its exit code', async () => {
    const cookie = await login();
    const res = await app.inject({
      method: 'POST', url: '/api/actions/apache.enableModule', headers: { host: HOST, origin: ORIGIN, cookie },
      payload: { module: 'proxy' },
    });
    // apache-module-enable is not faked, so the fake answers 127.
    expect(res.json()).toMatchObject({ ok: false, exitCode: 127 });
    expect(calls.filter((c) => c.args.includes('apache-reload'))).toHaveLength(0);
  });
});

describe('preferences', () => {
  it('starts from the defaults, keeps what a save changes, and refuses values it does not know', async () => {
    const cookie = await login();
    const headers = { host: HOST, origin: ORIGIN, cookie };
    expect((await app.inject({ method: 'GET', url: '/api/preferences', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/preferences', headers })).json()).toEqual({ theme: 'system', sitesView: 'grid', sitesSort: 'name' });
    const saved = await app.inject({ method: 'PUT', url: '/api/preferences', headers, payload: { theme: 'dark', sitesView: 'list' } });
    expect(saved.json()).toEqual({ theme: 'dark', sitesView: 'list', sitesSort: 'name' });
    await app.inject({ method: 'PUT', url: '/api/preferences', headers, payload: { sitesSort: 'newest' } });
    expect((await app.inject({ method: 'GET', url: '/api/preferences', headers })).json()).toEqual({ theme: 'dark', sitesView: 'list', sitesSort: 'newest' });
    for (const payload of [{ theme: 'neon' }, { sitesView: 'list', extra: 1 }]) {
      expect((await app.inject({ method: 'PUT', url: '/api/preferences', headers, payload })).statusCode).toBe(400);
    }
    expect(JSON.parse(store.getMeta('preferences') ?? '{}')).toEqual({ theme: 'dark', sitesView: 'list', sitesSort: 'newest' });
  });
});

describe('local constants', () => {
  it('starts from WP_ENVIRONMENT_TYPE local, keeps a saved list and refuses names the panel does not set', async () => {
    const cookie = await login();
    const headers = { host: HOST, origin: ORIGIN, cookie };
    expect((await app.inject({ method: 'GET', url: '/api/local-constants', headers })).json()).toEqual([{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }]);
    const list = [{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }, { name: 'ACME_DEV', value: true }];
    expect((await app.inject({ method: 'PUT', url: '/api/local-constants', headers, payload: list })).json()).toEqual(list);
    expect((await app.inject({ method: 'GET', url: '/api/local-constants', headers })).json()).toEqual(list);
    for (const payload of [[{ name: 'DB_PASSWORD', value: 'x' }], [{ name: 'ACME_DEV', value: true }, { name: 'ACME_DEV', value: false }], [{ name: 'ACME', value: 'a\nb' }]]) {
      expect((await app.inject({ method: 'PUT', url: '/api/local-constants', headers, payload })).statusCode).toBe(400);
    }
  });
});

describe('unread mail', () => {
  it("answers Mailpit's unread count, and null while Mailpit is not running", async () => {
    const tree = tempTree();
    const withMail = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => secrets, hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true,
      mailpit: async () => ({ ok: true, status: 200, json: async () => ({ unread: 2, messages: [] }) }),
    });
    const res = await withMail.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    const cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
    expect((await withMail.inject({ method: 'GET', url: '/api/mail/unread', headers: { host: HOST, cookie } })).json()).toEqual({ unread: 2 });
    await withMail.close();
    const down = await buildApp({
      config: tree.config, exec: fakeExec().exec, store, secrets: () => secrets, hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true,
      mailpit: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    const again = await down.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    const cookie2 = `dmp_session=${again.cookies.find((c) => c.name === 'dmp_session')?.value}`;
    expect((await down.inject({ method: 'GET', url: '/api/mail/unread', headers: { host: HOST, cookie: cookie2 } })).json()).toEqual({ unread: null });
    await down.close();
  });
});

describe('services tabs', () => {
  it('answers the MySQL and Apache tabs only when signed in', async () => {
    const tree = tempTree();
    const app = await buildApp({ config: tree.config, exec: fakeExec().exec, store, secrets: () => ({ panelPasswordHash: secrets?.panelPasswordHash as string }), hostPaths: tree.hostPaths, dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true });
    expect((await app.inject({ method: 'GET', url: '/api/mysql', headers: { host: HOST } })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
    const headers = { host: HOST, cookie: `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}` };
    expect((await app.inject({ method: 'GET', url: '/api/mysql', headers })).json()).toMatchObject({ server: null, error: expect.stringMatching(/no MySQL admin account/) });
    expect((await app.inject({ method: 'GET', url: '/api/apache', headers })).json()).toMatchObject({ vhosts: [], modules: [] });
    expect((await app.inject({ method: 'GET', url: '/api/apache/log', headers })).json()).toMatchObject({ exists: false, lines: [] });
    await app.close();
  });
});

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/secrets.js';
import { pruneUploads } from '../src/sites/uploads.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const HOST = 'local.devmagic';
const ORIGIN = 'https://local.devmagic';

let app: FastifyInstance;
let store: RunStore;
let statusAsks: Array<{ fresh?: boolean }>;
let cookie: string;
let backupDir: string;

beforeEach(async () => {
  const tree = tempTree();
  const { config } = tree;
  backupDir = config.BACKUP_DIR;
  const docroot = join(config.WEB_DIR, 'local.shop.com');
  mkdirSync(join(docroot, 'wp-content'), { recursive: true });
  writeFileSync(join(docroot, 'wp-config.php'), "<?php define('DB_NAME', 'shop_com'); define('WP_DEBUG', true);");
  writeFileSync(join(docroot, 'wp-content/debug.log'), '[24-Oct-2026 08:30:00 UTC] PHP Warning:  careful in /x.php\n');
  // A WordPress install the same vhost serves under /learn, from its own folder.
  const learn = join(config.WEB_DIR, 'local.learn.shop.com');
  mkdirSync(join(learn, 'wp-content'), { recursive: true });
  writeFileSync(join(learn, 'wp-config.php'), "<?php define('DB_NAME', 'shop_learn'); define('WP_DEBUG', true);");
  writeFileSync(join(learn, 'wp-content/debug.log'), '[24-Oct-2026 08:40:00 UTC] PHP Notice:  learn only\n');
  writeFileSync(
    join(config.APACHE_LOG_DIR, 'error.log'),
    [
      `[Sat Oct 24 09:01:02.000001 2026] [php:error] [pid 1] [client 127.0.0.1:1] PHP Fatal error:  boom in ${docroot}/a.php on line 1`,
      '[Sat Oct 24 09:01:03.000001 2026] [php:error] [pid 1] [client 127.0.0.1:1] PHP Fatal error:  other site in /var/www/local.other.com/b.php',
    ].join('\n'),
  );
  writeFileSync(
    join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'),
    `<VirtualHost *:443>\n ServerName local.shop.com\n DocumentRoot ${docroot}\n Alias /learn ${learn}\n ErrorLog \${APACHE_LOG_DIR}/error.log\n</VirtualHost>\n`,
  );
  symlinkSync(join(config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf'), join(config.APACHE_SITES_ENABLED, 'local.shop.com-ssl.conf'));

  store = new RunStore(':memory:');
  statusAsks = [];
  const hash = await hashPassword('correct horse');
  app = await buildApp({
    config, exec: fakeExec().exec, store, secrets: () => ({ panelPasswordHash: hash }), hostPaths: tree.hostPaths,
    dmpRoot: DMP, version: '9.9.9', uploadsDir: join(tree.root, 'uploads'), production: true,
    coreStatus: async (options) => {
      statusAsks.push(options ?? {});
      return { '7.1.4': 'latest', '7.1.3': 'insecure' };
    },
    // Mailpit answers for local.shop.com only; anything else is "not running".
    mailpit: async (path) => {
      if (!path.includes('local.shop.com')) throw new Error('connect ECONNREFUSED 127.0.0.1:8025');
      return { ok: true, status: 200, json: async () => ({ messages_count: 0, messages: [] }) };
    },
  });
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: 'correct horse' } });
  cookie = `dmp_session=${res.cookies.find((c) => c.name === 'dmp_session')?.value}`;
});

afterEach(async () => {
  await app.close();
  store.close();
});

const get = (url: string, withCookie = true) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(withCookie ? { cookie } : {}) } });

describe('site routes', () => {
  it('give the WordPress releases report from the copy, and ask WordPress.org now on Check again', async () => {
    expect((await get('/api/cores/report')).json().latest).toBe('7.1.4');
    await get('/api/cores/report?fresh=1');
    expect(statusAsks).toEqual([{ fresh: false }, { fresh: true }]);
  });

  it("keep a site's Refresh from production settings, checked, and say no site for an unknown one", async () => {
    const put = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url, headers: { host: HOST, origin: ORIGIN, cookie }, payload });
    expect((await get('/api/sites/local.shop.com/production')).json()).toBeNull();
    const saved = await put('/api/sites/local.shop.com/production?path=%2Flearn', { host: 'shop-prod', folder: '/var/www/shop/learn', excludeRows: ['wp_2_actionscheduler_logs'], clean: true });
    expect(saved.statusCode).toBe(200);
    expect((await get('/api/sites/local.shop.com/production?path=%2Flearn')).json()).toEqual({ host: 'shop-prod', folder: '/var/www/shop/learn', excludeRows: ['wp_2_actionscheduler_logs'], clean: true });
    expect((await get('/api/sites/local.shop.com/production')).json()).toBeNull();
    expect((await put('/api/sites/local.shop.com/production', { host: 'shop-prod', folder: '/var/www/shop', excludeRows: ['wp_x; DROP'] })).statusCode).toBe(400);
    expect((await put('/api/sites/local.other.com/production', { host: 'shop-prod', folder: '/var/www/shop' })).statusCode).toBe(404);
  });

  it('need a session', async () => {
    expect((await get('/api/sites', false)).statusCode).toBe(401);
  });

  it('say how each site came here: what the panel recorded, else by hand', async () => {
    store.setInstall('local.shop.com', '/learn', { how: 'wordpress', at: '2026-10-25T08:00:00Z' });
    const list = await get('/api/sites');
    expect(list.json().map((s: { install: unknown }) => s.install)).toEqual([{ how: 'hand' }, { how: 'wordpress', at: '2026-10-25T08:00:00Z' }]);
  });

  it('refuse a git repo folder that is not one of a site\'s, before any command', async () => {
    for (const repo of ['../local.other.com', 'wp-content/uploads', 'wp-content/themes/../../x']) {
      expect((await get(`/api/sites/local.shop.com/git?repo=${encodeURIComponent(repo)}`)).statusCode).toBe(400);
      expect((await get(`/api/sites/local.shop.com/git/pulls?repo=${encodeURIComponent(repo)}`)).statusCode).toBe(400);
    }
    expect((await get('/api/sites/local.shop.com/git?repo=wp-content%2Fthemes%2Fwandworks')).statusCode).toBe(404);
  });

  it('say what an organization install needs, keep its settings per step, and start no read without Claude Code', async () => {
    const send = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown>) => app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, cookie }, payload });
    expect((await get('/api/org/status')).json()).toMatchObject({ claude: { found: false }, gh: { installed: false }, glab: { installed: false, hosts: [{ host: 'gitlab.com', installed: false }] }, rclone: { installed: false }, settings: { selected: [] } });
    const settings = { selected: ['wandworks', 'gitlab.com/wandworks/web'], gitlabHosts: ['git.wandworks.test'], read: { model: 'haiku', effort: 'high', budgetUsd: 0.2 }, access: { model: 'sonnet', effort: 'low', budgetUsd: 0.5 } };
    expect((await send('PUT', '/api/org/settings', settings)).json()).toEqual({ ...settings, accountHosts: [] });
    expect((await send('PUT', '/api/org/settings', { selected: ['-bad'] })).statusCode).toBe(400);
    expect((await get('/api/org/status')).json().settings).toEqual({ ...settings, accountHosts: [] });
    // The hosts your account was ticked on stay noted when the page saves without them.
    await send('PUT', '/api/org/settings', { ...settings, accountHosts: ['github.com'] });
    expect((await send('PUT', '/api/org/settings', settings)).json().accountHosts).toEqual(['github.com']);
    await send('PUT', '/api/org/settings', settings);
    // Links to your own GitLab hosts come out as GitLab's in the browser too.
    expect((await get('/api/git-hosts')).json()).toEqual({ gitlab: ['git.wandworks.test'], detected: {}, aliases: {} });
    expect((await get('/api/org/status')).json().glab.hosts.map((h: { host: string }) => h.host)).toEqual(['gitlab.com', 'git.wandworks.test']);
    // Reading a repo is a job started through its action; without Claude Code it does not start.
    const input = { draftId: '11111111-2222-4333-8444-555555555555', url: 'git@github.com:wandworks/site.git', branch: 'main', fullName: 'wandworks/site', settings: settings.read };
    const read = await send('POST', '/api/actions/org.readRepo', input);
    expect(read.json()).toMatchObject({ ok: false, output: expect.stringContaining('Claude Code is not installed') });
    expect((await send('POST', '/api/actions/org.readRepo', { ...input, url: 'nope' })).statusCode).toBe(400);
    expect((await send('POST', '/api/org/read', input)).statusCode).toBe(404);
    // The stored list needs no GitHub CLI; a scan without one says why and still answers with it.
    expect((await get('/api/org/repos?org=wandworks')).json()).toEqual({ repos: [] });
    expect((await get('/api/org/repos?org=wandworks&scan=auto')).json()).toEqual({ repos: [], problem: expect.stringContaining('the GitHub CLI cannot list the repos of wandworks') });
    expect((await get('/api/org/repos?org=wandworks&scan=everything')).statusCode).toBe(400);
  });

  it('keep install drafts: saved, read, refused when malformed, and discarded', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const send = (method: 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, cookie }, ...(payload ? { payload } : {}) });
    expect((await send('PUT', `/api/drafts/${id}`, { step: 'domains', state: { adminPassword: null, repoUrl: 'x' } })).statusCode).toBe(200);
    expect((await get('/api/drafts')).json()).toEqual([expect.objectContaining({ id, step: 'domains', status: 'open' })]);
    expect((await get(`/api/drafts/${id}`)).json()).toMatchObject({ state: { repoUrl: 'x' } });
    expect((await send('PUT', '/api/drafts/nope', { step: 'domains', state: {} })).statusCode).toBe(400);
    expect((await send('PUT', `/api/drafts/${id}`, { step: '../x', state: {} })).statusCode).toBe(400);
    expect((await send('DELETE', `/api/drafts/${id}`)).statusCode).toBe(200);
    expect((await get(`/api/drafts/${id}`)).statusCode).toBe(404);
  });

  it('list sites and find one by domain', async () => {
    const list = await get('/api/sites');
    expect(list.json().map((s: { domain: string; path?: string }) => `${s.domain}${s.path ?? ''}`)).toEqual(['local.shop.com', 'local.shop.com/learn']);
    expect((await get('/api/sites/local.shop.com')).json().domain).toBe('local.shop.com');
    expect((await get('/api/sites/local.nope.com')).statusCode).toBe(404);
  });

  it('read the debug log of the site', async () => {
    const log = (await get('/api/sites/local.shop.com/logs')).json();
    expect(log).toMatchObject({ shared: false, exists: true });
    expect(log.file).toMatch(/local\.shop\.com\/wp-content\/debug\.log$/);
    expect(log.lines[0].level).toBe('warning');
  });

  it('filter a shared Apache log down to the site', async () => {
    const log = (await get('/api/sites/local.shop.com/logs?source=apache')).json();
    expect(log.shared).toBe(true);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0].message).toContain('boom');
  });

  it('answer 404 for logs of unknown sites', async () => {
    expect((await get('/api/sites/local.nope.com/logs')).statusCode).toBe(404);
  });

  it('refuse git details for odd mounts and folders that are not repos', async () => {
    expect((await get('/api/sites/local.shop.com/git?mount=%2F..%2Fetc')).statusCode).toBe(400);
    expect((await get('/api/sites/local.shop.com/git?mount=/learn')).statusCode).toBe(404);
    expect((await get('/api/sites/local.shop.com/git')).json().error).toContain('not a git repository');
    expect((await get('/api/sites/local.shop.com/git/pulls?mount=%2F..%2Fetc')).statusCode).toBe(400);
    expect((await get('/api/sites/local.nope.com/git/pulls')).statusCode).toBe(404);
  });

  it('serve a site under a path: the site itself, its own debug.log, and its own snapshots', async () => {
    const learn = (await get('/api/sites/local.shop.com?path=/learn')).json();
    expect(learn).toMatchObject({ domain: 'local.shop.com', path: '/learn', db: { name: 'shop_learn' } });
    expect((await get('/api/sites/local.shop.com')).json().path).toBeUndefined();
    expect((await get('/api/sites/local.shop.com?path=/nope')).statusCode).toBe(404);
    const log = (await get('/api/sites/local.shop.com/logs?source=debug&path=/learn')).json();
    expect(log.lines.map((l: { message: string }) => l.message)).toEqual(['PHP Notice:  learn only']);
    expect((await get('/api/sites/local.shop.com/logs?source=debug&path=..')).statusCode).toBe(400);
    const dir = join(backupDir, 'snapshots', 'local.shop.com@learn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '20261020-090500.sql.gz'), 'gz');
    expect((await get('/api/sites/local.shop.com/snapshots?path=/learn')).json()).toMatchObject([{ name: '20261020-090500.sql.gz' }]);
    expect((await get('/api/sites/local.shop.com/snapshots')).json()).toEqual([]);
    const file = await get('/api/sites/local.shop.com/snapshots/20261020-090500.sql.gz?path=/learn');
    expect(file.headers['content-disposition']).toBe('attachment; filename="local.shop.com@learn-20261020-090500.sql.gz"');
  });

  it('list and download snapshots, refusing names outside the pattern', async () => {
    const dir = join(backupDir, 'snapshots', 'local.shop.com');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '20261020-090500-before-import.sql.gz'), 'gz');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect((await get('/api/sites/local.shop.com/snapshots')).json()).toMatchObject([{ name: '20261020-090500-before-import.sql.gz', label: 'before-import', sizeBytes: 2 }]);
    const file = await get('/api/sites/local.shop.com/snapshots/20261020-090500-before-import.sql.gz');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="local.shop.com-20261020-090500-before-import.sql.gz"');
    expect(file.body).toBe('gz');
    expect((await get('/api/sites/local.shop.com/snapshots/notes.txt')).statusCode).toBe(400);
    expect((await get('/api/sites/local.shop.com/snapshots/20201020-090500.sql.gz')).statusCode).toBe(404);
    expect((await get('/api/sites/local.nope.com/snapshots')).statusCode).toBe(404);
  });

  it('list and download clean copies with what the leftover check found, refusing names outside the pattern', async () => {
    const dir = join(backupDir, 'clean', 'local.shop.com');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shop.com-local-clean-2026.10.28.sql.gz'), 'gz');
    writeFileSync(join(dir, 'shop.com-local-clean-2026.10.28.sql.gz.json'), JSON.stringify({ leftoverEmails: { total: 0, tables: [] } }));
    writeFileSync(join(dir, '.shop.com-local-clean-2026.10.29.sql.gz.part'), 'half');
    expect((await get('/api/sites/local.shop.com/clean-copies')).json()).toMatchObject([{ name: 'shop.com-local-clean-2026.10.28.sql.gz', sizeBytes: 2, leftoverEmails: { total: 0 } }]);
    const file = await get('/api/sites/local.shop.com/clean-copies/shop.com-local-clean-2026.10.28.sql.gz');
    expect(file.headers['content-disposition']).toBe('attachment; filename="shop.com-local-clean-2026.10.28.sql.gz"');
    expect(file.body).toBe('gz');
    expect((await get('/api/sites/local.shop.com/clean-copies/..%2Fsecrets.json')).statusCode).toBe(400);
    expect((await get('/api/sites/local.shop.com/clean-copies/shop.com-local-clean-2020.01.01.sql.gz')).statusCode).toBe(404);
    expect((await get('/api/sites/local.nope.com/clean-copies')).statusCode).toBe(404);
  });

  it("list a site's kept databases with the day each goes", async () => {
    store.addKeptDatabase({ name: 'shop_com__keep261020090500', site: 'local.shop.com', db: 'shop_com', reason: 'before shop.sql from production', createdAt: '2026-10-20T09:05:00.000Z' });
    expect((await get('/api/sites/local.shop.com/kept-databases')).json()).toMatchObject([{ name: 'shop_com__keep261020090500', purgeAt: '2026-10-27T09:05:00.000Z' }]);
    expect((await get('/api/sites/local.nope.com/kept-databases')).statusCode).toBe(404);
  });

  it('list queued proposals, close them once, and give the MCP command', async () => {
    store.addProposal({ id: 'q1', action: 'site.clearCache', title: 'Clear caches', description: '', input: { domain: 'local.shop.com' } }, 'claude-code');
    expect((await get('/api/proposals')).json()).toMatchObject([{ id: 'q1', source: 'claude-code' }]);
    const close = (status: string) => app.inject({ method: 'POST', url: '/api/proposals/q1/close', headers: { host: HOST, origin: ORIGIN, cookie }, payload: { status } });
    expect((await close('maybe')).statusCode).toBe(400);
    expect((await close('dismissed')).statusCode).toBe(204);
    expect((await close('ran')).statusCode).toBe(404);
    expect((await get('/api/mcp')).json().command).toMatch(/^claude mcp add devmagic-panel -- \S+node\S* --disable-warning=ExperimentalWarning \S+cli\.js mcp$/);
  });

  it('list runs with titles and their target site', async () => {
    const id = store.start('hosts.add', { domain: 'local.shop.com', aliases: [] });
    store.finish(id, 0, 'ok');
    const runs = (await get('/api/runs')).json().runs;
    expect(runs[0]).toMatchObject({ action: 'hosts.add', title: 'Add hosts entry', target: 'local.shop.com', ok: true });
  });

  it('page runs 50 at a time by number and show one with its output and stored input', async () => {
    for (let i = 0; i < 55; i++) store.finish(store.start('site.create', { domain: `local.s${i}.com`, admin: { password: '(hidden)' } }), 0, `out ${i}`);
    const first = (await get('/api/runs')).json() as { runs: Array<{ id: number }>; page: number; pageSize: number; total: number };
    expect(first).toMatchObject({ page: 1, pageSize: 50, total: 55 });
    expect(first.runs).toHaveLength(50);
    const rest = (await get('/api/runs?page=2')).json().runs as Array<{ id: number }>;
    expect(rest).toHaveLength(5);
    expect(rest[0]?.id).toBe((first.runs.at(-1)?.id as number) - 1);
    expect((await get('/api/runs?page=3')).json().runs).toEqual([]);
    for (const bad of ['0', 'x', '-1']) expect((await get(`/api/runs?page=${bad}`)).statusCode).toBe(400);
    const one = (await get(`/api/runs/${rest[0]?.id}`)).json();
    expect(one).toMatchObject({ target: 'local.s4.com', ok: true, output: 'out 4', input: { admin: { password: '(hidden)' } } });
    expect(one.jobId).toBeUndefined();
    expect((await get('/api/runs/999999')).statusCode).toBe(404);
  });

  it('mark runs a stopped panel left open as interrupted', async () => {
    const open = store.start('db.import', { domain: 'local.shop.com' });
    store.finish(store.start('hosts.add', { domain: 'local.shop.com' }), 0, 'ok');
    expect(store.markInterrupted()).toBe(1);
    expect(store.markInterrupted()).toBe(0);
    const run = (await get(`/api/runs/${open}`)).json();
    expect(run).toMatchObject({ ok: false, interrupted: true, output: 'Interrupted: the panel stopped before this run finished.' });
  });

  it('prune runs past their age or count and clear finished ones, never one still going', async () => {
    const going = store.start('site.create', { domain: 'local.going.com' });
    for (let i = 0; i < 5; i++) store.finish(store.start('hosts.add', { domain: `local.h${i}.com` }), 0, 'ok');
    // The newest three stay, and so does the run still going, whatever its age.
    expect(store.prune(90, 3)).toBe(2);
    expect(store.page(1, 50).total).toBe(4);
    expect(store.prune(90, 3)).toBe(0);
    // Old ones go by age too: a run started 100 days ago.
    const old = store.start('hosts.add', { domain: 'local.old.com' });
    store.finish(old, 0, 'ok');
    (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 100 * 86_400_000).toISOString(), old);
    expect(store.prune(90, 2000)).toBe(1);
    expect(store.clearRuns()).toBe(3);
    expect(store.page(1, 50).runs.map((r) => r.id)).toEqual([going]);
  });

  it('marks a skipped install step done, keeping the rest of the record, and lists runs with steps skipped', async () => {
    const todo = (label: string) => ({ label, todo: `${label} by hand` });
    store.setInstall('local.shop.com', undefined, { how: 'repo', repo: 'git@github.com:wandworks/shop.git', at: '2026-10-25T08:00:00Z', skipped: [todo('Run the build'), todo('Flush caches')] });
    const done = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/actions/site.skippedDone', headers: { host: HOST, origin: ORIGIN, cookie }, payload });
    expect((await done({ domain: 'local.shop.com', label: 'Run the build' })).json()).toMatchObject({ ok: true, output: 'Run the build: marked done on local.shop.com' });
    expect(store.installs().get('local.shop.com')).toEqual({ how: 'repo', repo: 'git@github.com:wandworks/shop.git', at: '2026-10-25T08:00:00Z', skipped: [todo('Flush caches')] });
    expect((await done({ domain: 'local.shop.com', label: 'Run the build' })).json()).toMatchObject({ ok: false, output: expect.stringContaining('local.shop.com has no skipped step called Run the build') });
    expect((await done({ domain: 'www.shop.com', label: 'Flush caches' })).statusCode).toBe(400);
    await done({ domain: 'local.shop.com', label: 'Flush caches' });
    // The last one leaves no empty list behind.
    expect(store.installs().get('local.shop.com')).toEqual({ how: 'repo', repo: 'git@github.com:wandworks/shop.git', at: '2026-10-25T08:00:00Z' });

    store.finish(store.start('site.create', { domain: 'local.shop.com' }), 0, 'done, 2 steps skipped', 2);
    const listed = (await get('/api/runs')).json().runs as Array<{ action: string; skipped?: number }>;
    expect(listed.find((r) => r.action === 'site.create')?.skipped).toBe(2);
    expect(listed.filter((r) => r.action === 'site.skippedDone').every((r) => r.skipped === undefined)).toBe(true);
  });

  it('lists a site\'s plugins, with 404 for no such site, 400 for a bad path and 502 when WP-CLI fails', async () => {
    expect((await get('/api/sites/local.none.com/plugins')).statusCode).toBe(404);
    expect((await get('/api/sites/local.shop.com/plugins?path=learn')).statusCode).toBe(400);
    // The fake executor has no wp, so WP-CLI fails.
    const res = await get('/api/sites/local.shop.com/plugins?path=/learn');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('WP-CLI could not list the plugins');
  });

  it('clear run history only with clear typed', async () => {
    store.finish(store.start('hosts.add', { domain: 'local.shop.com' }), 0, 'ok');
    const act = (confirm: string) => app.inject({ method: 'POST', url: '/api/actions/history.clear', headers: { host: HOST, origin: ORIGIN, cookie }, payload: { confirm } });
    expect((await act('yes')).statusCode).toBe(400);
    const res = await act('clear');
    expect(res.json()).toMatchObject({ ok: true, output: 'deleted 1 runs' });
    // Only the clear itself is left.
    expect((await get('/api/runs')).json().runs.map((r: { action: string }) => r.action)).toEqual(['history.clear']);
  });
});

describe('mail', () => {
  it("lists a site's mail, refuses names that are not local and answers 503 while Mailpit is down", async () => {
    expect((await get('/api/mail?site=local.shop.com')).json()).toEqual({ total: 0, messages: [] });
    expect((await get('/api/mail?site=www.shop.com')).statusCode).toBe(400);
    const down = await get('/api/mail');
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toMatch(/Mailpit is not reachable/);
    expect((await get('/api/mail/..%2Fetc')).statusCode).toBe(400);
  });
});

describe('uploads', () => {
  const post = (url: string, payload: string) =>
    app.inject({ method: 'POST', url, headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/octet-stream' }, payload });

  it('store a dump and answer with its facts and suggestions', async () => {
    const res = await post('/api/uploads?name=shop.sql', "CREATE TABLE `xyz_options` (x int);\nINSERT INTO `xyz_options` VALUES (1,'siteurl','https://www.shop.com','yes');\n");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'shop.sql',
      facts: { tablePrefix: 'xyz_', hosts: ['www.shop.com'] },
      suggestions: { replace: [{ from: 'www.shop.com', to: 'local.shop.com' }] },
    });
  });

  it('map an address that is already a local name to itself, keep ports, and suggest no core', async () => {
    const local = await post('/api/uploads?name=local.sql', "CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://local.shop.com','yes'),(2,'home','http://localhost:8888','yes'),(3,'db_version','60717','yes');\n");
    expect(local.json().suggestions).toEqual({ replace: [{ from: 'localhost:8888', to: 'local.localhost' }, { from: 'local.shop.com', to: 'local.shop.com' }] });
    // Replacing every mention is gone, and its count with it.
    expect((await get(`/api/uploads/${local.json().id}/mentions?hosts=www.shop.com`)).statusCode).toBe(404);
  });

  it('drop a dump the wizard no longer uses', async () => {
    const { id } = (await post('/api/uploads?name=shop.sql', 'CREATE TABLE x (y int);\n')).json();
    const del = (upload: string) => app.inject({ method: 'DELETE', url: `/api/uploads/${upload}`, headers: { host: HOST, origin: ORIGIN, cookie } });
    expect((await del(id)).statusCode).toBe(200);
    expect((await get(`/api/uploads/${id}`)).statusCode).toBe(404);
    expect((await del('not-an-upload')).statusCode).toBe(400);
  });

  it('prune dumps a day old that no job reads, and nothing else in the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-uploads-'));
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    for (const id of [...ids, 'not-an-upload']) mkdirSync(join(dir, id));
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const id of [ids[0], ids[1], 'not-an-upload'] as string[]) utimesSync(join(dir, id), old, old);
    // ids[1] is old but a failed install still reads it; ids[2] is fresh.
    expect(pruneUploads(dir, 86_400_000, new Set([ids[1] as string]))).toEqual([ids[0]]);
    expect(existsSync(join(dir, ids[1] as string)) && existsSync(join(dir, ids[2] as string)) && existsSync(join(dir, 'not-an-upload'))).toBe(true);
  });

  it('refuse files that are not dumps', async () => {
    const res = await post('/api/uploads?name=evil.php', '<?php');
    expect(res.statusCode).toBe(400);
  });

  it('answer 404 for unknown jobs', async () => {
    expect((await get('/api/jobs/nope')).statusCode).toBe(404);
  });
});

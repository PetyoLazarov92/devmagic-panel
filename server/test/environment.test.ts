import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvironment, enabledSiteNames, hostsNames } from '../src/environment.js';
import type { Secrets } from '../src/secrets.js';
import { DMP, fakeExec, healthyResponses, tempTree } from './helpers.js';

const secrets: Secrets = { panelPasswordHash: 'x', mysql: { user: 'root', host: 'localhost', password: 'pw' } };

function healthyTree() {
  const tree = tempTree();
  for (const m of ['ssl', 'rewrite', 'headers', 'proxy', 'proxy_http', 'proxy_wstunnel']) tree.write(`mods-enabled/${m}.load`);
  tree.write('certs/devmagic-panel-ca/ca.pem', 'pem');
  tree.write('home/.pki/nssdb/cert9.db');
  mkdirSync(join(tree.root, 'wp-cores/7.1.3'), { recursive: true });
  mkdirSync(join(tree.root, 'wp-cores/6.8.3'), { recursive: true });
  tree.write('wpcore.conf', `CORES_DIR="${join(tree.root, 'wp-cores')}"\nSITES_DIR="${tree.config.WEB_DIR}"\n`);
  return tree;
}

const byId = (report: Awaited<ReturnType<typeof checkEnvironment>>, id: string) => report.checks.find((c) => c.id === id);

describe('checkEnvironment', () => {
  it('reports every check as ok on a healthy machine', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const notOk = report.checks.filter((c) => c.status !== 'ok' && !c.optional && !c.recommended);
    expect(notOk).toEqual([]);
    expect(byId(report, 'access.github')?.status).toBe('ok');
  });

  it('shows nothing about GitLab when it is not in use', async () => {
    const tree = healthyTree();
    const fake = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec: fake.exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, gitlabHosts: async () => [] });
    expect(report.checks.filter((c) => /gitlab/i.test(c.id))).toEqual([]);
    expect(fake.calls.some((c) => c.file === 'glab' || (c.file === 'ssh' && c.args.includes('git@gitlab.com')))).toBe(false);
  });

  it('checks the GitLab CLI and SSH on each GitLab host in use, as optional warnings at most', async () => {
    const tree = healthyTree();
    const fake = fakeExec({
      ...healthyResponses(),
      'glab --version': { stdout: 'glab version 1.36.0 (2024-01-10)\n' },
      'glab api --hostname gitlab.com user': { stdout: JSON.stringify({ username: 'alex' }) },
      'glab api --hostname git.acme.test user': { code: 1, stderr: '401 Unauthorized' },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@gitlab.com': { stdout: 'Welcome to GitLab, @alex!\n' },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@git.acme.test': { code: 255, stderr: 'git@git.acme.test: Permission denied (publickey).\n' },
    });
    const report = await checkEnvironment({ config: tree.config, exec: fake.exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, gitlabHosts: async () => ['gitlab.com', 'git.acme.test'] });
    expect(byId(report, 'access.gitlabCli.gitlab.com')).toMatchObject({ status: 'ok', optional: true, detail: 'glab 1.36.0, signed in as alex; it lists your groups and their projects' });
    expect(byId(report, 'access.gitlabCli.git.acme.test')).toMatchObject({ status: 'warn', optional: true });
    expect(byId(report, 'access.gitlabCli.git.acme.test')?.detail).toContain('glab auth login --hostname git.acme.test');
    expect(byId(report, 'access.gitlab.gitlab.com')).toMatchObject({ status: 'ok', optional: true });
    expect(byId(report, 'access.gitlab.git.acme.test')).toMatchObject({ status: 'warn', optional: true, detail: 'cannot authenticate: add your SSH key to git.acme.test, or cloning its private repos will fail' });
    expect(byId(report, 'access.github')?.status).toBe('ok');
  });

  it('says when glab is missing or older than 1.36, the oldest the panel works with', async () => {
    const tree = healthyTree();
    const missing = await checkEnvironment({ config: tree.config, exec: fakeExec(healthyResponses()).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, gitlabHosts: async () => ['gitlab.com'] });
    expect(byId(missing, 'access.gitlabCli')).toMatchObject({ status: 'warn', optional: true });
    expect(byId(missing, 'access.gitlabCli')?.detail).toContain('not installed');
    const old = await checkEnvironment({ config: tree.config, exec: fakeExec({ ...healthyResponses(), 'glab --version': { stdout: 'glab version 1.22.0\n' } }).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, gitlabHosts: async () => ['gitlab.com'] });
    expect(byId(old, 'access.gitlabCli')?.detail).toBe('glab 1.22.0 is older than 1.36, the oldest the panel works with: update it');
  });

  it('passes the MySQL password through the environment, never the arguments', async () => {
    const tree = healthyTree();
    const { exec, calls } = fakeExec(healthyResponses());
    await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const ping = calls.find((c) => c.file === 'mysql');
    expect(ping?.env).toEqual({ MYSQL_PWD: 'pw' });
    expect(ping?.args.join(' ')).not.toContain('pw');
  });

  it('offers one fix per missing Apache module', async () => {
    const tree = tempTree();
    tree.write('mods-enabled/ssl.load');
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const modules = byId(report, 'apache.modules');
    expect(modules?.status).toBe('fail');
    expect(modules?.fixes?.map((f) => f.input)).toEqual([
      { module: 'rewrite' }, { module: 'headers' }, { module: 'proxy' }, { module: 'proxy_http' }, { module: 'proxy_wstunnel' },
    ]);
  });

  it('warns instead of failing the configtest when sudo needs a password', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec({
      ...healthyResponses(),
      [`sudo -n ${DMP} apache-configtest`]: { code: 1, stderr: 'sudo: a password is required\n' },
    });
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'apache.configtest')).toMatchObject({ status: 'warn', detail: expect.stringContaining('install.sh') });
  });

  it('reports wpcore as shared with the CLI, listing its cores', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'tools.wpcore')?.detail).toMatch(/shared with the wpcore CLI: .*2 cores in .*\(7\.1\.3, 6\.8\.3\)/);
  });

  it('fails wpcore when its cores folder is missing', async () => {
    const tree = healthyTree();
    tree.write('wpcore.conf', `CORES_DIR="${join(tree.root, 'nope')}"\n`);
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'tools.wpcore')?.status).toBe('fail');
  });

  it('reports Mailpit as recommended, ok only while it listens on port 1025', async () => {
    const tree = healthyTree();
    const run = (ss: string) =>
      checkEnvironment({ config: tree.config, exec: fakeExec({ ...healthyResponses(), 'ss -ltnH': { stdout: ss } }).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(await run('LISTEN 0 511 *:80 *:*\nLISTEN 0 511 *:443 *:*\n'), 'tools.mailpit')).toMatchObject({ status: 'warn', recommended: true });
    expect(byId(await run('LISTEN 0 511 *:80 *:*\nLISTEN 0 511 *:443 *:*\nLISTEN 0 4096 127.0.0.1:1025 0.0.0.0:*\n'), 'tools.mailpit')?.status).toBe('ok');
  });

  it('needs git and unzip, and recommends Composer, with the apt command for each', async () => {
    const tree = healthyTree();
    const healthy = await checkEnvironment({ config: tree.config, exec: fakeExec(healthyResponses()).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(healthy, 'tools.git')).toMatchObject({ status: 'ok', detail: 'git version 2.43.0' });
    expect(byId(healthy, 'tools.unzip')).toMatchObject({ status: 'ok', detail: 'UnZip 6.00' });
    expect(byId(healthy, 'tools.composer')).toMatchObject({ status: 'ok', detail: 'Composer version 2.7.1', recommended: true });

    const missing = { code: 127, stderr: 'not found' };
    const bare = await checkEnvironment({
      config: tree.config,
      exec: fakeExec({ ...healthyResponses(), 'git --version': missing, 'unzip -v': missing, 'composer --version': missing }).exec,
      secrets, paths: tree.hostPaths, dmpRoot: DMP,
    });
    expect(byId(bare, 'tools.git')).toMatchObject({ status: 'fail' });
    expect(byId(bare, 'tools.git')?.detail).toContain('apt install git');
    expect(byId(bare, 'tools.unzip')).toMatchObject({ status: 'fail' });
    expect(byId(bare, 'tools.composer')).toMatchObject({ status: 'warn', recommended: true });
    expect(byId(bare, 'tools.composer')?.detail).toContain('apt install composer');
  });

  it('says nothing about the old devmagic CLI', async () => {
    const tree = healthyTree();
    tree.write('devmagic.conf');
    const report = await checkEnvironment({ config: tree.config, exec: fakeExec(healthyResponses()).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(report.checks.some((c) => /devmagic\b(?!-panel)/i.test(`${c.label} ${c.detail}`))).toBe(false);
  });

  it('fails the database check when no MySQL account is set up', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets: null, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'mysql.reachable')?.status).toBe('fail');
  });

  it('flags missing hosts names with a hosts.add fix for the whole site', async () => {
    const tree = healthyTree();
    tree.write('sites-enabled/local.shop.com-ssl.conf', [
      '<VirtualHost *:80>', '  ServerName local.shop.com', '  ServerAlias local.shop.de', '</VirtualHost>',
      '<VirtualHost *:443>', '  ServerName local.shop.com', '  ServerAlias local.shop.de www.local.shop.com public.example.com', '</VirtualHost>',
    ].join('\n'));
    tree.write('hosts', '127.0.0.1 localhost local.shop.com\n');
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const site = byId(report, 'hosts.local.shop.com');
    expect(site?.status).toBe('fail');
    expect(site?.detail).toBe('not in hosts: local.shop.de, www.local.shop.com');
    expect(site?.fixes?.[0]).toMatchObject({
      action: 'hosts.add',
      input: { domain: 'local.shop.com', aliases: ['local.shop.de', 'www.local.shop.com'] },
    });
  });

  it('warns about the legacy CA with a confirmed fix', async () => {
    const tree = healthyTree();
    tree.write('system-ca/LocalhostCA.crt');
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const legacy = byId(report, 'ca.legacy');
    expect(legacy?.status).toBe('warn');
    expect(legacy?.fixes?.[0]?.action).toBe('ca.untrustLegacy');
    expect(legacy?.fixes?.[0]?.confirm).toBeTruthy();
  });

  it('offers browser trust when a store lacks the CA', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec({ ...healthyResponses(), 'certutil -L': { code: 255 } });
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'ca.browsers')).toMatchObject({ status: 'fail', fixes: [{ action: 'ca.trustBrowsers' }] });
  });

  it('fails PHP older than 8.1 and names missing modules', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec({ ...healthyResponses(), 'php -r': { stdout: '7.4.33' }, 'php -m': { stdout: 'curl\ngd\n' } });
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'php.version')?.status).toBe('fail');
    expect(byId(report, 'php.modules')?.detail).toContain('mysqli');
  });

  it('says whether Claude Code is signed in, and with claude.ai', async () => {
    const tree = healthyTree();
    const bin = join(tree.hostPaths.home, '.local/bin/claude');
    mkdirSync(join(tree.hostPaths.home, '.local/bin'), { recursive: true });
    tree.write('home/.local/bin/claude');
    const report = (auth: string) =>
      checkEnvironment({ config: tree.config, exec: fakeExec({ ...healthyResponses(), [`${bin} --version`]: { stdout: '2.1.309 (Claude Code)' }, [`${bin} auth status --json`]: { stdout: auth } }).exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    const claude = async (auth: string) => byId(await report(auth), 'access.claudeCode');
    expect(await claude(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))).toMatchObject({ status: 'ok', optional: true });
    expect((await claude(JSON.stringify({ loggedIn: false })))?.detail).toContain('not signed in: run claude auth login');
    expect((await claude(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })))?.detail).toContain('Asana and Google links need');
  });
});

describe('enabledSiteNames', () => {
  it('keeps local names only, first one as the key', () => {
    const tree = tempTree();
    tree.write('sites-enabled/000-default.conf', 'ServerName localhost\n');
    tree.write('sites-enabled/x-ssl.conf', 'ServerName local.x.com\nServerAlias LOCAL.X.DE public.example.com\n');
    expect([...enabledSiteNames(tree.config.APACHE_SITES_ENABLED)]).toEqual([['local.x.com', ['local.x.com', 'local.x.de']]]);
  });
});

describe('hostsNames', () => {
  it('reads loopback names and ignores comments', () => {
    const names = hostsNames('127.0.0.1 localhost a.test # b.test\n::1 c.test\n10.0.0.1 d.test\n#127.0.0.1 e.test\n');
    expect([...names].sort()).toEqual(['a.test', 'c.test', 'localhost']);
  });
});

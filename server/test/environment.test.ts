import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { checkEnvironment, enabledSiteNames, hostsNames } from '../src/environment.js';
import type { Secrets } from '../src/secrets.js';
import { HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
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
      'glab api --hostname git.wandworks.test user': { code: 1, stderr: '401 Unauthorized' },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@gitlab.com': { stdout: 'Welcome to GitLab, @alex!\n' },
      'ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@git.wandworks.test': { code: 255, stderr: 'git@git.wandworks.test: Permission denied (publickey).\n' },
    });
    const report = await checkEnvironment({ config: tree.config, exec: fake.exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, gitlabHosts: async () => ['gitlab.com', 'git.wandworks.test'] });
    expect(byId(report, 'access.gitlabCli.gitlab.com')).toMatchObject({ status: 'ok', optional: true, detail: 'glab 1.36.0, signed in as alex; it lists your groups and their projects' });
    expect(byId(report, 'access.gitlabCli.git.wandworks.test')).toMatchObject({ status: 'warn', optional: true });
    expect(byId(report, 'access.gitlabCli.git.wandworks.test')?.detail).toContain('glab auth login --hostname git.wandworks.test');
    expect(byId(report, 'access.gitlab.gitlab.com')).toMatchObject({ status: 'ok', optional: true });
    expect(byId(report, 'access.gitlab.git.wandworks.test')).toMatchObject({ status: 'warn', optional: true, detail: 'cannot authenticate: add your SSH key to git.wandworks.test, or cloning its private repos will fail' });
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

describe("MySQL's memory for site data", () => {
  const pool = (answer: string) => ({ ...healthyResponses(), "mysql --user root --host localhost --batch --skip-column-names -e SELECT VERSION(),": { stdout: answer } });

  it('says how much to set and where when the buffer pool is far smaller than the data', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(pool(`8.0.43\t${128 * 1024 ** 2}\t${6 * 1024 ** 3}\n`));
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, totalMemory: () => 16 * 1024 ** 3 });
    expect(byId(report, 'mysql.bufferPool')).toMatchObject({
      status: 'warn',
      optional: true,
      detail: '128 MB for 6.0 GB of InnoDB data: big sites read from the disk on every page. Set the buffer pool to 7680M, on the MySQL page or here',
      fixes: [{ action: 'mysql.setSettings', input: { values: { innodb_buffer_pool_size: 7680 * 1024 ** 2 } }, label: 'Set it to 7680M' }],
    });
    expect(byId(report, 'mysql.bufferPool')?.fixes?.[0]?.confirm).toMatch(/^MySQL takes the new size at once, and keeps it for its next start/);
  });

  it('never asks for more than half the memory, and says MariaDB on a MariaDB', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(pool(`10.11.6-MariaDB-0ubuntu0.24.04.1\t${128 * 1024 ** 2}\t${40 * 1024 ** 3}\n`));
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP, totalMemory: () => 8 * 1024 ** 3 });
    expect(byId(report, 'mysql.bufferPool')?.detail).toContain('Set the buffer pool to 4G');
    expect(byId(report, 'mysql.bufferPool')?.fixes?.[0]).toMatchObject({ input: { values: { innodb_buffer_pool_size: 4 * 1024 ** 3 } }, confirm: expect.stringMatching(/^MariaDB takes/) });
  });

  it('is fine when the pool holds a good part of the data', async () => {
    const tree = healthyTree();
    const { exec } = fakeExec(healthyResponses());
    const report = await checkEnvironment({ config: tree.config, exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
    expect(byId(report, 'mysql.bufferPool')).toMatchObject({ status: 'ok', detail: '1.0 GB for 512 MB of InnoDB data' });
  });
});

describe('WSL on Windows', () => {
  /** WSL 2 as install.sh and get.ps1 leave it: hosts kept, Apache on 127.0.0.1, interop on, the helper in place. */
  function wslTree(wslConf = '[boot]\nsystemd=true\n\n[network]\ngenerateHosts = false\n') {
    const tree = healthyTree();
    tree.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
    tree.write('wsl.conf', wslConf);
    tree.write('ports.conf', 'Listen 127.0.0.1:80\n<IfModule ssl_module>\n\tListen 127.0.0.1:443\n</IfModule>\n');
    mkdirSync(join(tree.root, 'binfmt_misc'), { recursive: true });
    tree.write('binfmt_misc/WSLInterop');
    tree.write('dmp-win.ps1', '# the helper');
    tree.write('hosts', `127.0.0.1 localhost\n${HOSTS_BEGIN}\n127.0.0.1 local.devmagic\n127.0.0.2 local.wandworks-store.example\n${HOSTS_END}\n`);
    return tree;
  }
  /** The helper's status as it reads a machine get.ps1 set up, with changes. */
  const windowsStatus = (changes: Record<string, unknown> = {}) =>
    JSON.stringify({
      distro: 'devmagic-panel',
      wsl: { answering: true, distroState: 'Running' },
      hosts: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', block: ['127.0.0.1 local.devmagic', '127.0.0.2 local.wandworks-store.example'] },
      ca: { readable: true, thumbprint: 'ABC123', trusted: true },
      logonTask: { installed: true },
      ports: ['127.0.0.1:443'],
      uac: { enabled: true, promptsAdmins: true },
      ...changes,
    });
  const check = (tree: ReturnType<typeof healthyTree>, linger = 'yes\n', config = tree.config, status = windowsStatus()) => {
    const powershell = `${join(tree.root, 'Windows')}/System32/WindowsPowerShell/v1.0/powershell.exe`;
    const fake = fakeExec({ ...healthyResponses(), 'loginctl show-user': { stdout: linger }, [powershell]: { stdout: status } });
    lastCalls = fake.calls;
    return checkEnvironment({ config, exec: fake.exec, secrets, paths: tree.hostPaths, dmpRoot: DMP });
  };
  let lastCalls: Array<{ file: string; args: string[] }> = [];
  const wsl = (report: Awaited<ReturnType<typeof checkEnvironment>>) => report.checks.filter((c) => c.group === 'wsl');

  it('shows nothing on a machine that is not WSL, or under WSL 1', async () => {
    const tree = healthyTree();
    expect(wsl(await check(tree))).toEqual([]);
    tree.write('osrelease', '4.4.0-19041-Microsoft\n');
    expect(wsl(await check(tree))).toEqual([]);
  });

  it('is all ok as install.sh and get.ps1 leave WSL 2, and asks the helper by its full Windows path', async () => {
    const report = await check(wslTree());
    expect(wsl(report).map((c) => [c.id, c.status])).toEqual([
      ['wsl.hosts', 'ok'],
      ['wsl.apacheAddress', 'ok'],
      ['wsl.linger', 'ok'],
      ['wsl.webDir', 'ok'],
      ['wsl.interop', 'ok'],
      ['windows.hosts', 'ok'],
      ['windows.ca', 'ok'],
      ['windows.logonTask', 'ok'],
    ]);
    const call = lastCalls.find((c) => c.file.endsWith('powershell.exe'));
    expect(call?.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Program Files\\devmagic-panel\\dmp-win.ps1', 'status']);
  });

  it('offers each Windows step as a fix when it is not in place', async () => {
    const status = windowsStatus({
      hosts: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', block: ['127.0.0.1 local.devmagic', '127.0.0.1 local.old-site.test'] },
      ca: { readable: true, thumbprint: 'ABC123', trusted: false },
      logonTask: { installed: false },
      uac: { enabled: true, promptsAdmins: false },
    });
    const report = await check(wslTree(), 'yes\n', undefined, status);
    expect(byId(report, 'windows.hosts')).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/^missing local\.wandworks-store\.example; left over local\.old-site\.test/),
      fixes: [{ action: 'windows.hostsSync', input: {}, confirm: expect.stringContaining('UAC') }],
    });
    expect(byId(report, 'windows.ca')).toMatchObject({ status: 'warn', fixes: [{ action: 'windows.trustCa', input: {} }] });
    expect(byId(report, 'windows.logonTask')).toMatchObject({ status: 'warn', fixes: [{ action: 'windows.autostart', input: {} }] });
    // A setting you chose: shown, never a warning.
    expect(byId(report, 'windows.uac')).toMatchObject({ status: 'ok', optional: true, detail: expect.stringContaining('never notify') });
  });

  it("checks Windows' relays to nginx only while nginx is set up, or while relays are left over", async () => {
    const relays = ['127.0.0.2:443=127.0.0.1:8443', '127.0.0.2:80=127.0.0.1:8080'];
    const plain = wslTree();
    expect(byId(await check(plain, 'yes\n', undefined, windowsStatus({ portproxy: { rules: [], ipHelper: 'Running' } })), 'windows.portproxy')).toBeUndefined();
    expect(byId(await check(plain, 'yes\n', undefined, windowsStatus({ portproxy: { rules: relays, ipHelper: 'Running' } })), 'windows.portproxy')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('nginx is not set up, but Windows still relays 127.0.0.2:443 and 127.0.0.2:80'),
      fixes: [{ action: 'windows.portproxy', input: {}, label: 'Remove the relays' }],
    });
    const nginx = wslTree();
    nginx.write('nginx/conf.d/devmagic-panel.conf', `${VHOST_MARKER}\n`);
    expect(byId(await check(nginx, 'yes\n', undefined, windowsStatus({ portproxy: { rules: ['0.0.0.0:2222=172.20.1.5:22'], ipHelper: 'Running' } })), 'windows.portproxy')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('does not relay 127.0.0.2:80 and :443 to nginx on 127.0.0.1:8080 and :8443'),
      fixes: [{ action: 'windows.portproxy', input: {}, confirm: expect.stringContaining('UAC') }],
    });
    expect(byId(await check(nginx, 'yes\n', undefined, windowsStatus({ portproxy: { rules: relays, ipHelper: 'Running' } })), 'windows.portproxy')).toMatchObject({ status: 'ok' });
    expect(byId(await check(nginx, 'yes\n', undefined, windowsStatus({ portproxy: { rules: relays, ipHelper: 'Stopped' } })), 'windows.portproxy')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('IP Helper service is Stopped'),
    });
    // A helper older than portproxy: nothing to say.
    expect(byId(await check(nginx), 'windows.portproxy')).toBeUndefined();
  });

  it('says to run get.ps1 when the helper is not there, and asks Windows nothing then, or without interop', async () => {
    const tree = wslTree();
    rmSync(join(tree.root, 'dmp-win.ps1'));
    const report = await check(tree);
    expect(byId(report, 'windows.helper')).toMatchObject({ status: 'warn', detail: expect.stringContaining('run get.ps1') });
    expect(lastCalls.some((c) => c.file.endsWith('powershell.exe'))).toBe(false);
    const noInterop = wslTree();
    rmSync(join(noInterop.root, 'binfmt_misc/WSLInterop'));
    const quiet = await check(noInterop);
    expect(wsl(quiet).some((c) => c.id.startsWith('windows.'))).toBe(false);
    expect(lastCalls.some((c) => c.file.endsWith('powershell.exe'))).toBe(false);
  });

  it('fails when WSL writes /etc/hosts anew, and warns about Apache on every address and lingering off', async () => {
    const tree = wslTree('[boot]\nsystemd=true\n');
    tree.write('ports.conf', 'Listen 80\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n');
    const report = await check(tree, 'no\n');
    expect(byId(report, 'wsl.hosts')).toMatchObject({ status: 'fail', detail: expect.stringContaining('local.devmagic and every site drop out') });
    expect(byId(report, 'wsl.apacheAddress')).toMatchObject({ status: 'warn', detail: expect.stringContaining('ports.conf has Listen 80') });
    expect(byId(report, 'wsl.linger')).toMatchObject({ status: 'warn', detail: expect.stringContaining('lingering is off for dev') });
  });

  it('reads generateHosts from [network] only, in any case', async () => {
    expect(byId(await check(wslTree('[boot]\ngenerateHosts = false\n')), 'wsl.hosts')?.status).toBe('fail');
    expect(byId(await check(wslTree('[Network]\nGenerateHosts=False\n')), 'wsl.hosts')?.status).toBe('ok');
    expect(byId(await check(wslTree('[network]\n# generateHosts = false\ngenerateHosts = true\n')), 'wsl.hosts')?.status).toBe('fail');
  });

  it('fails for sites on a Windows drive, and warns when Windows programs cannot be started', async () => {
    const tree = wslTree();
    rmSync(join(tree.root, 'binfmt_misc/WSLInterop'));
    const report = await check(tree, 'yes\n', { ...tree.config, WEB_DIR: '/mnt/c/sites' });
    expect(byId(report, 'wsl.webDir')).toMatchObject({ status: 'fail', detail: expect.stringContaining('/mnt/c/sites, on a Windows drive') });
    expect(byId(report, 'wsl.interop')).toMatchObject({ status: 'warn', optional: true });
  });

  it('offers to register interop again when another distro took it away, but not when wsl.conf turns it off', async () => {
    const taken = wslTree();
    rmSync(join(taken.root, 'binfmt_misc/WSLInterop'));
    expect(byId(await check(taken), 'wsl.interop')).toMatchObject({ status: 'warn', fixes: [{ action: 'wsl.repairInterop', input: {} }] });
    const off = wslTree('[boot]\nsystemd=true\n\n[network]\ngenerateHosts = false\n\n[interop]\nenabled = false\n');
    rmSync(join(off.root, 'binfmt_misc/WSLInterop'));
    const check2 = byId(await check(off), 'wsl.interop');
    expect(check2).toMatchObject({ status: 'warn', detail: expect.stringContaining('turned off in /etc/wsl.conf') });
    expect(check2?.fixes).toBeUndefined();
  });
});

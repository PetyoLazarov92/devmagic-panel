import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { parseConfig } from '../src/config.js';
import { checkEnvironment } from '../src/environment.js';
import { Jobs } from '../src/jobs.js';
import { listenConflict, nginxConfigs, nginxReport, parseNginxConfig, planNginxSetup, planNginxTeardown } from '../src/nginx.js';
import { servicesReport } from '../src/services.js';
import { parseNginxErrorLog } from '../src/sites/logs.js';
import { SiteActionRefused } from '../src/sites/site-actions.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, healthyResponses, tempTree } from './helpers.js';

const MARKER = '# Managed by devmagic-panel. Edits here are overwritten.';

/** A tree with nginx installed, and set up by the panel when asked. */
function nginxTree({ setUp = false } = {}) {
  const t = tempTree();
  t.write('nginx/nginx.conf', 'http {}\n');
  if (setUp) t.write('nginx/conf.d/devmagic-panel.conf', `${MARKER}\nserver {}\n`);
  return t;
}

/** A config in sites-available, linked from sites-enabled when enabled. */
function site(t: ReturnType<typeof tempTree>, name: string, text: string, enabled = true) {
  t.write(`nginx/sites-available/${name}`, text);
  if (enabled) symlinkSync(join(t.root, 'nginx/sites-available', name), join(t.root, 'nginx/sites-enabled', name));
}

describe('nginx configs', () => {
  it('reads server_name and listen, without comments or _', () => {
    expect(parseNginxConfig('server {\n  listen 127.0.0.2:443 ssl; # tls\n  listen [::]:80;\n  # listen 80;\n  server_name local.acme.com www.local.acme.com _;\n}\n')).toEqual({
      names: ['local.acme.com', 'www.local.acme.com'],
      listens: ['127.0.0.2:443 ssl', '[::]:80'],
    });
  });

  it('flags listens on port 80 or 443 off nginx address, as dmp_nginx_conflicts does', () => {
    expect(listenConflict('80', '127.0.0.2')).toBe('listens on port 80 on every address');
    expect(listenConflict('443 ssl default_server', '127.0.0.2')).toBe('listens on port 443 on every address');
    expect(listenConflict('0.0.0.0:80', '127.0.0.2')).toBe('listens on port 80 on every address');
    expect(listenConflict('127.0.0.1:443 ssl', '127.0.0.2')).toBe('listens on port 443 on 127.0.0.1');
    expect(listenConflict('127.0.0.5', '127.0.0.2')).toBe('listens on port 80 on 127.0.0.5');
    for (const fine of ['127.0.0.2:443 ssl', '127.0.0.2', '[::]:80', '8080', 'unix:/run/x.sock']) expect(listenConflict(fine, '127.0.0.2')).toBeNull();
  });

  it('lists every config with whose it is, and leaves Debian default site out of the conflicts', () => {
    const t = nginxTree();
    site(t, 'default', 'server {\n  listen 80 default_server;\n}\n');
    site(t, 'manual', 'server {\n  listen 80;\n  server_name local.manual.test;\n}\n');
    site(t, 'off', 'server {\n  listen 80;\n}\n', false);
    site(t, 'local.acme.com.conf', `${MARKER}\nserver {\n  listen 127.0.0.2:443 ssl;\n  server_name local.acme.com;\n}\n`);
    expect(nginxConfigs(t.config)).toEqual([
      { file: 'default', enabled: true, managed: false, names: [], listens: ['80 default_server'] },
      { file: 'local.acme.com.conf', enabled: true, managed: true, names: ['local.acme.com'], listens: ['127.0.0.2:443 ssl'] },
      { file: 'manual', enabled: true, managed: false, names: ['local.manual.test'], listens: ['80'], conflict: 'listens on port 80 on every address' },
      { file: 'off', enabled: false, managed: false, names: [], listens: ['80'] },
    ]);
  });
});

describe('nginxReport', () => {
  it('says only that nginx is missing when it is not installed, running nothing', async () => {
    const t = tempTree();
    const { exec, calls } = fakeExec();
    const report = await nginxReport(t.config, exec, DMP, () => 0);
    expect(report).toMatchObject({ installed: false, setUp: false, server: { state: 'missing' }, configs: [], addresses: { nginx: '127.0.0.2', apache: '127.0.0.1' } });
    expect(calls).toHaveLength(0);
  });

  it('reads the state, version and nginx -t through dmp-root once installed', async () => {
    const t = nginxTree({ setUp: true });
    const { exec } = fakeExec({
      [`sudo -n ${DMP} nginx-configtest`]: { stderr: 'nginx: configuration file test is successful\n' },
      'systemctl is-active nginx': { stdout: 'inactive\n' },
      'systemctl cat nginx.service': { stdout: '[Unit]' },
      'nginx -v': { stderr: 'nginx version: nginx/1.24.0 (Ubuntu)\n' },
    });
    const report = await nginxReport(t.config, exec, DMP, () => 0, () => 100);
    expect(report).toMatchObject({ installed: true, setUp: true, configtest: { ok: true }, server: { state: 'stopped', version: 'nginx/1.24.0' } });
  });

  it('does not call nginx -t failed when the root scripts are older than nginx', async () => {
    const t = nginxTree();
    const { exec } = fakeExec({ [`sudo -n ${DMP} nginx-configtest`]: { code: 2, stderr: 'error: unknown command: nginx-configtest (see dmp-root --help)\n' } });
    expect((await nginxReport(t.config, exec, DMP, () => 0, () => 100)).configtest.ok).toBeNull();
  });
});

describe('nginx jobs and actions', () => {
  function ctx(t: ReturnType<typeof tempTree>) {
    const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' } });
    const store = new RunStore(':memory:');
    const c: ActionContext = {
      config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: join(t.root, 'wpcore.conf'), home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    return { c, lines: () => fake.calls.map((x) => [x.file, ...x.args].join(' ')) };
  }

  it('refuses to set nginx up before it is installed, or while a config made by hand takes Apache ports', () => {
    const { c } = ctx(tempTree());
    expect(() => planNginxSetup(c)).toThrow(/sudo apt install nginx/);
    const t = nginxTree();
    site(t, 'manual', 'server {\n  listen 443 ssl;\n}\n');
    expect(() => planNginxSetup(ctx(t).c)).toThrow(SiteActionRefused);
    expect(() => planNginxSetup(ctx(t).c)).toThrow(/manual listens on port 443 on every address/);
  });

  it('sets nginx up, checks every site, and offers Undo only when it was not set up before', async () => {
    const t = nginxTree();
    const { c, lines } = ctx(t);
    const steps = planNginxSetup(c);
    expect(steps.map((s) => s.id)).toEqual(['setup', 'sites']);
    const undos: string[] = [];
    const job = { onUndo: (label: string) => undos.push(label) } as unknown as Parameters<(typeof steps)[number]['run']>[0];
    await steps[0]?.run(job);
    expect(lines()).toEqual([`sudo -n ${DMP} nginx-setup`]);
    expect(undos).toEqual(['Turn nginx off; Apache answers on every address again']);

    t.write('nginx/conf.d/devmagic-panel.conf', `${MARKER}\n`);
    const again = planNginxSetup(c);
    undos.length = 0;
    await again[0]?.run(job);
    expect(undos).toEqual([]);
  });

  it('turns nginx off only once it is set up, with Undo setting it up again', async () => {
    expect(() => planNginxTeardown(ctx(nginxTree()).c)).toThrow(/not set up/);
    const { c, lines } = ctx(nginxTree({ setUp: true }));
    const steps = planNginxTeardown(c);
    const undos: string[] = [];
    await steps[0]?.run({ onUndo: (label: string) => undos.push(label) } as unknown as Parameters<(typeof steps)[number]['run']>[0]);
    expect(lines()).toEqual([`sudo -n ${DMP} nginx-teardown`]);
    expect(undos).toEqual(['Set nginx up again on 127.0.0.2']);
  });

  it('reloads and restarts nginx through dmp-root', async () => {
    const { c, lines } = ctx(nginxTree({ setUp: true }));
    await runAction(c, 'nginx.reload', {});
    await runAction(c, 'service.restart', { service: 'nginx' });
    expect(lines()).toEqual([`sudo -n ${DMP} nginx-reload`, `sudo -n ${DMP} service-restart nginx`]);
    await expect(runAction(c, 'nginx.reload', { extra: true })).resolves.toBeDefined();
    await expect(runAction(c, 'service.restart', { service: 'nginx;id' })).rejects.toBeInstanceOf(ActionInputError);
  });
});

describe('nginx on the Services page and the Environment page', () => {
  it('shows nginx as installed but not set up, without a restart', async () => {
    const t = nginxTree();
    const { exec } = fakeExec({ 'systemctl is-active nginx': { stdout: 'inactive\n' }, 'systemctl cat nginx.service': { stdout: '[Unit]' }, 'nginx -v': { stderr: 'nginx version: nginx/1.24.0\n' } });
    const report = await servicesReport(t.config, exec, () => 0);
    expect(report.services.find((s) => s.id === 'nginx')).toEqual({ id: 'nginx', label: 'nginx', state: 'stopped', detail: 'nginx/1.24.0 installed, not set up next to Apache yet', canRestart: false });
  });

  it('shows where each server answers once nginx is set up', async () => {
    const t = nginxTree({ setUp: true });
    const { exec } = fakeExec({ 'systemctl is-active nginx': { stdout: 'active\n' }, 'nginx -v': { stderr: 'nginx version: nginx/1.24.0\n' } });
    const report = await servicesReport(t.config, exec, () => 0);
    expect(report.services.find((s) => s.id === 'nginx')).toEqual({ id: 'nginx', label: 'nginx', state: 'running', detail: 'nginx/1.24.0 on 127.0.0.2, Apache on 127.0.0.1', canRestart: true });
  });

  const nginxChecks = async (t: ReturnType<typeof tempTree>, responses: Record<string, { stdout?: string; stderr?: string; code?: number }> = {}) => {
    const { exec } = fakeExec({ ...healthyResponses(), ...responses });
    const report = await checkEnvironment({ config: t.config, exec, secrets: null, paths: t.hostPaths, dmpRoot: DMP });
    return report.checks.filter((c) => c.group === 'nginx');
  };

  it('has no nginx checks while nginx is not installed', async () => {
    expect(await nginxChecks(tempTree())).toEqual([]);
  });

  it('suggests setting nginx up once it is installed, as an optional warning', async () => {
    const checks = await nginxChecks(nginxTree());
    expect(checks.map((c) => [c.id, c.status, c.optional])).toEqual([['nginx.setUp', 'warn', true]]);
  });

  it('passes when each server listens on its own address only', async () => {
    const checks = await nginxChecks(nginxTree({ setUp: true }), {
      'systemctl is-active nginx': { stdout: 'active\n' },
      [`sudo -n ${DMP} nginx-configtest`]: { stdout: 'ok' },
      'ss -ltnH': { stdout: 'LISTEN 0 511 127.0.0.1:80 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 511 127.0.0.2:80 0.0.0.0:*\nLISTEN 0 511 127.0.0.2:443 0.0.0.0:*\n' },
    });
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(['nginx.setUp', 'nginx.running', 'nginx.configtest', 'nginx.addresses', 'nginx.conflicts']);
  });

  it('fails when Apache still listens on every address or nginx is down, with a start fix', async () => {
    const checks = await nginxChecks(nginxTree({ setUp: true }), {
      'systemctl is-active nginx': { code: 3, stdout: 'failed\n' },
      [`sudo -n ${DMP} nginx-configtest`]: { stdout: 'ok' },
      'ss -ltnH': { stdout: 'LISTEN 0 511 *:80 *:*\nLISTEN 0 511 *:443 *:*\n' },
    });
    const running = checks.find((c) => c.id === 'nginx.running');
    expect(running?.status).toBe('fail');
    expect(running?.fixes).toEqual([{ action: 'service.restart', input: { service: 'nginx' }, label: 'Start nginx' }]);
    const addresses = checks.find((c) => c.id === 'nginx.addresses');
    expect(addresses?.status).toBe('fail');
    expect(addresses?.detail).toContain('nginx on 127.0.0.2:80');
    expect(addresses?.detail).toContain('port 80 and 443 on every address');
  });
});

describe('nginx in config.env and its error log', () => {
  const valid = [
    'PANEL_USER=dev', 'PANEL_GROUP=dev', 'PANEL_PORT=4710', 'PANEL_DOMAIN=local.devmagic', 'WEB_DIR=/var/www',
    'WEB_GROUP=www-data', 'CERTS_DIR=/etc/ssl/localcerts', 'CA_DIR=/etc/ssl/localcerts/devmagic-panel-ca',
    'APACHE_SITES_AVAILABLE=/etc/apache2/sites-available', 'APACHE_SITES_ENABLED=/etc/apache2/sites-enabled',
    'APACHE_LOG_DIR=/var/log/apache2', 'HOSTS_FILE=/etc/hosts', 'SYSTEM_CA_DIR=/usr/local/share/ca-certificates',
    'BACKUP_DIR=/home/dev/devmagic-panel-backups',
  ].join('\n');

  it('defaults nginx paths and addresses for files written before them', () => {
    expect(parseConfig(valid, 'test')).toMatchObject({ NGINX_SITES_AVAILABLE: '/etc/nginx/sites-available', NGINX_LOG_DIR: '/var/log/nginx', NGINX_ADDRESS: '127.0.0.2', APACHE_ADDRESS: '127.0.0.1' });
    expect(parseConfig(`${valid}\nNGINX_ADDRESS=127.0.0.9`, 'test').NGINX_ADDRESS).toBe('127.0.0.9');
  });

  it('refuses addresses off loopback, 127.0.1.1, or the same for both', () => {
    for (const bad of ['10.0.0.2', '127.0.1.1', '127.0.0.300']) expect(() => parseConfig(`${valid}\nNGINX_ADDRESS=${bad}`, 'test')).toThrow(/NGINX_ADDRESS must be/);
    expect(() => parseConfig(`${valid}\nNGINX_ADDRESS=127.0.0.1`, 'test')).toThrow(/must differ/);
  });

  it('parses nginx error lines newest first, with PHP level from FastCGI lines', () => {
    const lines = parseNginxErrorLog([
      '2026/11/06 10:00:00 [notice] 1234#1234: signal process started',
      '2026/11/06 10:01:00 [error] 1235#1235: *7 FastCGI sent in stderr: "PHP message: PHP Fatal error:  Uncaught Error in /var/www/local.acme.com/index.php" while reading response header',
      '2026/11/06 10:02:00 [emerg] 1236#1236: bind() to 127.0.0.2:80 failed (98: Address already in use)',
    ].join('\n'));
    expect(lines.map((l) => l.level)).toEqual(['fatal', 'fatal', 'notice']);
    expect(lines[0]?.message).toBe('bind() to 127.0.0.2:80 failed (98: Address already in use)');
    expect(lines[2]?.time).toBe(new Date(2026, 10, 6, 10, 0, 0).toISOString());
  });
});


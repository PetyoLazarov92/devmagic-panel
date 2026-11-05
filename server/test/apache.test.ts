import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { apacheErrorLog, apacheReport } from '../src/apache.js';
import { Jobs } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { fakeExec, wpSiteTree } from './helpers.js';

const DMP = '/x/dmp-root';

function setup(configtest: { code?: number; stdout?: string; stderr?: string } = { stderr: 'Syntax OK\n' }) {
  const t = wpSiteTree();
  // A panel vhost that is not enabled, and Apache's default.
  writeFileSync(join(t.config.APACHE_SITES_AVAILABLE, 'local.old.test.conf'), `${VHOST_MARKER}\n<VirtualHost *:80>\n ServerName local.old.test\n DocumentRoot ${t.config.WEB_DIR}/local.old.test\n Alias /learn ${t.config.WEB_DIR}/local.learn.old.test\n</VirtualHost>\n`);
  writeFileSync(join(t.config.APACHE_SITES_AVAILABLE, '000-default.conf'), '<VirtualHost *:80>\n DocumentRoot /var/www/html\n</VirtualHost>\n');
  mkdirSync(join(t.root, 'mods-available'), { recursive: true });
  for (const m of ['ssl', 'rewrite', 'expires', 'http2', 'mpm_prefork', 'mpm_event', 'php8.3']) writeFileSync(join(t.root, 'mods-available', `${m}.load`), '');
  for (const m of ['ssl', 'rewrite', 'mpm_prefork', 'php8.3']) writeFileSync(join(t.root, 'mods-enabled', `${m}.load`), '');
  writeFileSync(join(t.root, 'mods-enabled', 'ssl.conf'), '');
  writeFileSync(join(t.root, 'ports.conf'), 'Listen 80\n\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n<IfModule mod_gnutls.c>\n\tListen 443\n</IfModule>\n');
  const fake = fakeExec({
    [`sudo -n ${DMP} apache-configtest`]: configtest,
    'systemctl is-active apache2': { stdout: 'active\n' },
    'systemctl show apache2 --property=ActiveEnterTimestampMonotonic --value': { stdout: '7200000000\n' },
    'apache2ctl -v': { stdout: 'Server version: Apache/2.4.58 (Ubuntu)\nServer built:   2025-08-11T11:10:09\n' },
    [`openssl x509 -in ${t.cert} -noout -enddate`]: { stdout: 'notAfter=Jan 30 10:00:00 2028 GMT\n' },
  });
  return { ...t, exec: fake.exec, calls: fake.calls };
}

describe('apacheReport', () => {
  it('lists every vhost file with whether Apache serves it and whose it is', async () => {
    const s = setup();
    // Up 10 hours since boot; Apache started 2 hours in, so 8 hours ago.
    const r = await apacheReport(s.config, s.exec, DMP, () => Date.parse('2026-10-29T10:00:00Z'), () => 36_000);
    expect(r.configtest).toEqual({ ok: true, output: 'Syntax OK' });
    expect(r.server).toEqual({ state: 'running', version: 'Apache/2.4.58', since: '2026-10-29T02:00:00.000Z', mpm: 'mpm_prefork', php: '8.3', ports: ['80', '443'] });
    expect(r.modules).toEqual([
      { name: 'expires', enabled: false },
      { name: 'http2', enabled: false },
      { name: 'mpm_event', enabled: false, locked: 'mod_php needs this worker model' },
      { name: 'mpm_prefork', enabled: true, locked: 'mod_php needs this worker model' },
      { name: 'php8.3', enabled: true, locked: 'Runs PHP for your sites' },
      { name: 'rewrite', enabled: true, locked: 'The panel needs it' },
      { name: 'ssl', enabled: true, locked: 'The panel needs it' },
    ]);
    expect(r.vhosts.map((v) => v.file)).toEqual(['000-default.conf', 'local.old.test.conf', 'local.shop.com-ssl.conf']);
    expect(r.vhosts[2]).toEqual({
      file: 'local.shop.com-ssl.conf',
      enabled: true,
      managed: false,
      names: ['local.shop.com', 'local.shop.de', 'www.local.shop.com'],
      docroot: join(s.config.WEB_DIR, 'local.shop.com'),
      site: 'local.shop.com',
      mounts: [],
      certExpiresAt: '2028-01-30T10:00:00.000Z',
    });
    // Not enabled: no page to link to, as the panel reads its sites from what Apache serves.
    expect(r.vhosts[1]).toMatchObject({ enabled: false, managed: true, mounts: ['/learn'] });
    expect(r.vhosts[1]?.site).toBeUndefined();
    expect(r.vhosts[0]).toMatchObject({ enabled: false, names: [] });
  });

  it('tells a failing config from one it could not test', async () => {
    const f = setup({ code: 1, stderr: 'AH00526: Syntax error on line 4\n' });
    expect((await apacheReport(f.config, f.exec, DMP)).configtest).toEqual({ ok: false, output: 'AH00526: Syntax error on line 4' });
    const s = setup({ code: 1, stderr: 'sudo: a password is required\n' });
    expect((await apacheReport(s.config, s.exec, DMP)).configtest.ok).toBeNull();
  });
});

describe('apacheErrorLog', () => {
  it("reads the last lines of Apache's own error log", () => {
    const s = setup();
    writeFileSync(join(s.config.APACHE_LOG_DIR, 'error.log'), '[Thu Oct 29 10:00:00.000000 2026] [core:error] [pid 1] AH00037: Symbolic link not allowed\n');
    const log = apacheErrorLog(s.config);
    expect(log).toMatchObject({ file: join(s.config.APACHE_LOG_DIR, 'error.log'), exists: true });
    expect(log.lines[0]?.message).toContain('AH00037');
  });
});

describe('apache.setModule', () => {
  it('switches a module through dmp-root, and refuses a locked one before any command', async () => {
    const t = wpSiteTree();
    const fake = fakeExec({ [`sudo -n ${DMP} apache-module`]: { stdout: 'ok: apache module expires on' } });
    const store = new RunStore(':memory:');
    const ctx: ActionContext = { config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: t.wpcoreConf, home: t.hostPaths.home, jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null };
    expect((await runAction(ctx, 'apache.setModule', { module: 'expires', enabled: true })).ok).toBe(true);
    expect((await runAction(ctx, 'apache.setModule', { module: 'expires', enabled: false })).ok).toBe(true);
    expect(fake.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([`sudo -n ${DMP} apache-module expires on`, `sudo -n ${DMP} apache-module expires off`]);
    for (const input of [{ module: 'ssl', enabled: false }, { module: 'php8.3', enabled: false }, { module: 'mpm_event', enabled: true }, { module: '../x', enabled: true }]) {
      await expect(runAction(ctx, 'apache.setModule', input)).rejects.toThrow();
    }
    // A locked module can still be turned on when it is off.
    expect((await runAction(ctx, 'apache.setModule', { module: 'ssl', enabled: true })).ok).toBe(true);
    expect(fake.calls).toHaveLength(3);
  });
});

import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { developerReport, formatJournal, listFolder, parseInstalledFiles, readLog } from '../src/developer.js';
import { fakeExec, tempTree } from './helpers.js';
import { CRON_BEGIN, CRON_END } from '../src/cron.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';

const LIST = [
  '# devmagic-panel: what install.sh put on this machine.',
  'file\t/etc/sudoers.d/devmagic-panel\tremove\tlets you run dmp-root and wpcore without a password',
  'line\t/etc/hosts\tremove\tlocal.devmagic in the devmagic-panel block',
  'packages\tapt:apache2 openssl\tkeep\tpackages the panel needs',
  'broken line without tabs',
  'file\t/x\tmaybe\tunknown policy',
].join('\n');

describe('developer options', () => {
  it('reads the installed files list, skipping comments and lines it does not understand', () => {
    expect(parseInstalledFiles(LIST)).toEqual([
      { kind: 'file', path: '/etc/sudoers.d/devmagic-panel', onUninstall: 'remove', note: 'lets you run dmp-root and wpcore without a password' },
      { kind: 'line', path: '/etc/hosts', onUninstall: 'remove', note: 'local.devmagic in the devmagic-panel block' },
      { kind: 'packages', path: 'apt:apache2 openssl', onUninstall: 'keep', note: 'packages the panel needs' },
    ]);
  });

  it('reports versions, services, config, files with sizes, and logs newest first', async () => {
    const t = tempTree();
    const state = join(t.root, 'state');
    const logs = join(t.root, 'logs');
    mkdirSync(state, { recursive: true });
    mkdirSync(logs, { recursive: true });
    const file = join(t.root, 'hosts');
    writeFileSync(join(state, 'installed-files'), `file\t${file}\tremove\tthe hosts file\nfile\t${join(t.root, 'gone')}\tremove\tremoved since\n`);
    writeFileSync(join(logs, 'install-20261024-090000.log'), 'old');
    writeFileSync(join(logs, 'install-20261025-090000.log'), 'new run');
    writeFileSync(join(logs, 'notes.txt'), 'not a log');
    utimesSync(join(logs, 'install-20261024-090000.log'), new Date('2026-10-24T09:00:00Z'), new Date('2026-10-24T09:00:00Z'));
    const { exec } = fakeExec({
      'git -C': { stdout: 'v0.5.0-3-gabc1234\n' },
      'systemctl --user show --timestamp=unix -p Id,LoadState,ActiveState,UnitFileState,ActiveEnterTimestamp devmagic-panel.service': {
        stdout: 'Id=devmagic-panel.service\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nActiveEnterTimestamp=@1792882284\n',
      },
      'systemctl --user show --timestamp=unix -p Id,LoadState,ActiveState,UnitFileState,ActiveEnterTimestamp devmagic-panel-mailpit.service': {
        stdout: 'Id=devmagic-panel-mailpit.service\nLoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nActiveEnterTimestamp=\n',
      },
      // MariaDB, not MySQL: the first unit that is loaded counts.
      'systemctl show --timestamp=unix -p Id,LoadState,ActiveState,UnitFileState,ActiveEnterTimestamp mysql.service mariadb.service': {
        stdout: 'Id=mysql.service\nLoadState=not-found\nActiveState=inactive\n\nId=mariadb.service\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nActiveEnterTimestamp=@1792800000\n',
      },
      'systemctl show --timestamp=unix -p Id,LoadState,ActiveState,UnitFileState,ActiveEnterTimestamp apache2.service': { code: 1, stdout: '' },
      loginctl: { stdout: 'no\n' },
    });
    const report = await developerReport({ config: { ...t.config, STATE_DIR: state }, exec, version: '0.5.0', home: t.root, dataDir: join(t.root, 'data'), configDir: join(t.root, 'config'), logsDir: logs, runningJobs: () => 2 });
    expect(report).toMatchObject({ version: '0.5.0', commit: 'v0.5.0-3-gabc1234', linger: false });
    expect(report.server).toMatchObject({ pid: process.pid, port: t.config.PANEL_PORT, runningJobs: 2 });
    expect(report.services.slice(0, 4)).toEqual([
      { unit: 'devmagic-panel.service', label: 'Panel', scope: 'user', active: 'active', enabled: 'enabled', since: '2026-10-24T22:51:24.000Z' },
      { unit: 'devmagic-panel-mailpit.service', label: 'Mailpit', scope: 'user', active: 'inactive', enabled: 'disabled' },
      { unit: 'apache2.service', label: 'Apache', scope: 'system', active: 'not installed', enabled: '' },
      { unit: 'mariadb.service', label: 'MySQL', scope: 'system', active: 'active', enabled: 'enabled', since: new Date(1792800000 * 1000).toISOString() },
    ]);
    // nginx and cron are always asked about; PHP-FPM only for the versions that have it.
    expect(report.services.slice(4).map((u) => u.label)).toEqual(['nginx', 'cron']);
    expect(report.installedFiles).toEqual([
      { kind: 'file', path: file, onUninstall: 'remove', note: 'the hosts file', exists: true, sizeBytes: 20 },
      { kind: 'file', path: join(t.root, 'gone'), onUninstall: 'remove', note: 'removed since', exists: false },
    ]);
    expect(report.logs.map((l) => l.name)).toEqual(['install-20261025-090000.log', 'install-20261024-090000.log']);
    expect(report.config.find((c) => c.key === 'STATE_DIR')?.value).toBe(state);
    expect(report.panelFiles.find((f) => f.path.endsWith('secrets.json'))).toMatchObject({ exists: false });
  });

  it('lists the system files dmp-root wrote, only the ones there, and what else the panel made, never a password', async () => {
    const t = tempTree();
    const c = t.config;
    mkdirSync(join(c.PHP_CONF_DIR, '8.3', 'fpm', 'pool.d'), { recursive: true });
    mkdirSync(join(c.PHP_CONF_DIR, '8.3', 'fpm', 'conf.d'), { recursive: true });
    writeFileSync(join(c.PHP_CONF_DIR, '8.3', 'fpm', 'pool.d', 'dmp-local.spellbook.example.conf'), '; pool\n');
    writeFileSync(join(c.PHP_CONF_DIR, '8.3', 'fpm', 'pool.d', 'www.conf'), '; not ours\n');
    writeFileSync(join(c.PHP_CONF_DIR, '8.3', 'fpm', 'conf.d', '99-devmagic-panel.ini'), 'memory_limit = 512M\n');
    mkdirSync(c.NGINX_SITES_AVAILABLE, { recursive: true });
    writeFileSync(join(c.NGINX_SITES_AVAILABLE, 'local.wandworks.example.conf'), `${VHOST_MARKER}\nserver {}\n`);
    writeFileSync(join(c.NGINX_SITES_AVAILABLE, 'by-hand.conf'), 'server {}\n');
    mkdirSync(join(c.MYSQL_CONF_DIR, 'mysql.conf.d'), { recursive: true });
    writeFileSync(join(c.MYSQL_CONF_DIR, 'mysql.conf.d', 'zz-devmagic-panel.cnf'), '[mysqld]\n');
    mkdirSync(join(c.WEB_DIR, 'local.spellbook.example', 'wp-content', 'mu-plugins'), { recursive: true });
    writeFileSync(join(c.WEB_DIR, 'local.spellbook.example', 'wp-content', 'mu-plugins', 'devmagic-panel-login.php'), '<?php\n');
    const { exec } = fakeExec({ crontab: { stdout: `MAILTO=""\n${CRON_BEGIN}\n*/5 * * * * one\n0 3 * * * two\n${CRON_END}\n` }, loginctl: { stdout: 'yes\n' } });
    const report = await developerReport({ config: c, exec, version: '0.5.0', home: t.root, dataDir: join(t.root, 'data'), configDir: join(t.root, 'config'), logsDir: join(t.root, 'logs'), mysqlAccounts: () => [{ user: 'devmagic_panel_ro', host: 'localhost', role: 'read-only' }] });
    const system = report.panelFiles.filter((f) => f.group === 'system').map((f) => f.path);
    expect(system).toEqual([
      join(c.PHP_CONF_DIR, '8.3', 'fpm', 'conf.d', '99-devmagic-panel.ini'),
      join(c.PHP_CONF_DIR, '8.3', 'fpm', 'pool.d', 'dmp-local.spellbook.example.conf'),
      join(c.NGINX_SITES_AVAILABLE, 'local.wandworks.example.conf'),
      join(c.MYSQL_CONF_DIR, 'mysql.conf.d', 'zz-devmagic-panel.cnf'),
    ]);
    const other = report.panelFiles.filter((f) => f.group === 'other');
    expect(other.map((f) => f.note)).toEqual([
      "the panel's tasks, 2 lines; every other line stays yours",
      "the SQL runner's, SELECT and SHOW VIEW only",
      'the one-time wp-admin login, in 1 site folder',
      'Local mode, in 0 site folders',
    ]);
    expect(other[1]?.path).toBe('MySQL account devmagic_panel_ro@localhost');
    expect(report.panelFiles.filter((f) => f.group === 'data').some((f) => f.path === join(t.root, 'data', 'file-trash'))).toBe(true);
  });

  it('has no list before the first install that writes one', async () => {
    const t = tempTree();
    const report = await developerReport({ config: { ...t.config, STATE_DIR: join(t.root, 'none') }, exec: fakeExec().exec, version: '0.5.0', home: t.root, dataDir: t.root, configDir: t.root, logsDir: join(t.root, 'no-logs') });
    expect(report.installedFiles).toBeNull();
    expect(report.logs).toEqual([]);
    expect(report.linger).toBeNull();
  });

  it('reads a log only by its own name', () => {
    const t = tempTree();
    writeFileSync(join(t.root, 'install-20261025-090000.log'), 'hello');
    expect(readLog(t.root, 'install-20261025-090000.log')).toBe('hello');
    expect(readLog(t.root, '../hosts')).toBeNull();
    expect(readLog(t.root, 'hosts')).toBeNull();
    expect(readLog(t.root, 'update-20261025-090000.log')).toBeNull();
  });

  it('keeps starts, stops, warnings and errors from the journal and drops request lines', () => {
    const journal = [
      '2026-10-25T00:40:00+03:00 magic systemd[1200]: Started devmagic-panel.service - devmagic-panel.',
      '2026-10-25T00:40:01+03:00 magic node[1]: {"level":30,"time":1,"pid":1,"hostname":"magic","msg":"Server listening at http://127.0.0.1:4710"}',
      '2026-10-25T00:40:02+03:00 magic node[1]: {"level":30,"time":1,"reqId":"req-1","req":{"method":"GET","url":"/api/jobs"},"msg":"incoming request"}',
      '2026-10-25T00:40:03+03:00 magic node[1]: {"level":40,"time":1,"msg":"trash purge: no trash folder"}',
      '2026-10-25T00:40:04+03:00 magic node[1]: {"level":50,"time":1,"reqId":"req-2","err":{"message":"boom"},"msg":"request errored"}',
    ].join('\n');
    expect(formatJournal(journal).split('\n')).toEqual([
      '2026-10-25T00:40:00+03:00 magic systemd[1200]: Started devmagic-panel.service - devmagic-panel.',
      '2026-10-25T00:40:01+03:00 info Server listening at http://127.0.0.1:4710',
      '2026-10-25T00:40:03+03:00 warn trash purge: no trash folder',
      '2026-10-25T00:40:04+03:00 error request errored: boom',
    ]);
  });
});

describe('opening a folder in the developer options', () => {
  /** A machine where install.sh listed one folder and a link, and the panel has its logs folder. */
  function machine() {
    const t = tempTree();
    const state = join(t.root, 'state');
    const app = join(t.root, 'app');
    const outside = join(t.root, 'outside');
    mkdirSync(state, { recursive: true });
    mkdirSync(join(app, 'bin'), { recursive: true });
    mkdirSync(join(app, 'big'), { recursive: true });
    mkdirSync(join(app, 'releases', 'v1'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(app, 'bin', 'dmp-root'), 'x'.repeat(42));
    writeFileSync(join(app, 'notes.txt'), 'hello');
    writeFileSync(join(outside, 'secret.txt'), 'never listed');
    symlinkSync(outside, join(app, 'escape'));
    symlinkSync(join(app, 'releases', 'v1'), join(app, 'current'));
    for (let i = 0; i < 205; i++) writeFileSync(join(app, 'big', `f${String(i).padStart(3, '0')}`), '');
    writeFileSync(join(state, 'installed-files'), `dir\t${app}\tremove\tthe app\nlink\t${join(app, 'current')}\tremove\tthe release it runs\nstore\t${outside}\task\ta browser store\n`);
    const ctx = { config: { ...t.config, STATE_DIR: state }, exec: fakeExec().exec, version: '0.5.0', home: t.root, dataDir: join(t.root, 'data'), configDir: join(t.root, 'config'), logsDir: join(t.root, 'logs') };
    return { ctx, app, outside };
  }

  it('lists folders first, then files with their sizes, and where links point', () => {
    const { ctx, app, outside } = machine();
    const listing = listFolder(ctx, app);
    expect(listing?.entries.map((e) => [e.name, e.kind])).toEqual([['big', 'dir'], ['bin', 'dir'], ['releases', 'dir'], ['current', 'link'], ['escape', 'link'], ['notes.txt', 'file']]);
    expect(listing?.entries.find((e) => e.name === 'notes.txt')).toMatchObject({ sizeBytes: 5 });
    expect(listing?.entries.find((e) => e.name === 'escape')).toMatchObject({ target: outside, targetKind: 'dir' });
    expect(listFolder(ctx, join(app, 'bin'))?.entries).toEqual([expect.objectContaining({ name: 'dmp-root', kind: 'file', sizeBytes: 42 })]);
  });

  it('opens a listed link to a folder inside the roots, and caps a large folder', () => {
    const { ctx, app } = machine();
    expect(listFolder(ctx, join(app, 'current'))).toEqual({ path: join(app, 'current'), entries: [], more: 0 });
    const big = listFolder(ctx, join(app, 'big'));
    expect(big?.entries).toHaveLength(200);
    expect(big?.more).toBe(5);
  });

  it('never opens a folder outside them: another path, a way up, a link out or a browser store', () => {
    const { ctx, app, outside } = machine();
    expect(listFolder(ctx, outside)).toBeNull();
    expect(listFolder(ctx, `${app}/../outside`)).toBeNull();
    expect(listFolder(ctx, join(app, 'escape'))).toBeNull();
    expect(listFolder(ctx, 'relative/path')).toBeNull();
    expect(listFolder(ctx, '/etc')).toBeNull();
  });

  it('says why a folder within them cannot be listed', () => {
    const { ctx, app } = machine();
    expect(listFolder(ctx, join(app, 'gone'))).toEqual({ path: join(app, 'gone'), entries: [], more: 0, error: 'not there any more' });
    expect(listFolder(ctx, join(app, 'notes.txt'))).toMatchObject({ error: 'not a folder' });
    // Root reads any folder, so this only shows for another user.
    if (process.getuid?.() !== 0) {
      chmodSync(join(app, 'bin'), 0o000);
      try {
        expect(listFolder(ctx, join(app, 'bin'))).toMatchObject({ entries: [], error: 'only root can list this' });
      } finally {
        chmodSync(join(app, 'bin'), 0o755);
      }
    }
  });
});


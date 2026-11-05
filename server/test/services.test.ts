import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { servicesReport } from '../src/services.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

function phpTree() {
  const t = tempTree();
  writeFileSync(join(t.root, 'mods-enabled/php8.3.load'), '');
  return t;
}

describe('servicesReport', () => {
  it('reads unit states, picks MariaDB when MySQL is missing, and Mailpit from its port', async () => {
    const t = phpTree();
    const { exec } = fakeExec({
      'systemctl is-active apache2': { stdout: 'active\n' },
      'systemctl is-active mysql': { code: 4, stdout: 'inactive\n' },
      'systemctl cat mysql.service': { code: 1, stderr: 'No files found' },
      'systemctl is-active mariadb': { code: 3, stdout: 'failed\n' },
      'systemctl cat mariadb.service': { stdout: '[Unit]' },
      'apache2ctl -v': { stdout: 'Server version: Apache/2.4.58 (Ubuntu)\n' },
      'mysql --version': { stdout: 'mysql  Ver 15.1 Distrib 10.11.8-MariaDB\n' },
      'php -r': { stdout: '8.3.6' },
      'ss -ltnH': { stdout: 'LISTEN 0 511 *:80 *:*\n' },
    });
    const report = await servicesReport(t.config, exec, () => 0);
    expect(report.services).toEqual([
      { id: 'apache', label: 'Apache', state: 'running', detail: 'Apache/2.4.58', canRestart: true },
      { id: 'mysql', label: 'MariaDB', state: 'stopped', detail: 'mysql  Ver 15.1 Distrib 10.11.8-MariaDB', canRestart: true },
      { id: 'mailpit', label: 'Mailpit', state: 'stopped', detail: 'not listening on port 1025', canRestart: false },
    ]);
    expect(report.php).toEqual({ apache: '8.3', cli: '8.3.6' });
  });
});

describe('service and Xdebug actions', () => {
  function ctx(t: ReturnType<typeof tempTree>) {
    const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' } });
    const store = new RunStore(':memory:');
    const c: ActionContext = {
      config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: join(t.root, 'wpcore.conf'), home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    return { c, lines: () => fake.calls.map((x) => [x.file, ...x.args].join(' ')) };
  }

  it('go through dmp-root with allow-listed values only', async () => {
    const { c, lines } = ctx(tempTree());
    await runAction(c, 'php.setXdebug', { enabled: true, modes: ['profile', 'debug', 'develop'], startWithRequest: 'yes' });
    await runAction(c, 'php.setXdebug', { enabled: false });
    await runAction(c, 'service.restart', { service: 'mysql' });
    expect(lines()).toEqual([
      `sudo -n ${DMP} xdebug-enable debug,develop,profile yes`,
      `sudo -n ${DMP} xdebug-disable`,
      `sudo -n ${DMP} service-restart mysql`,
    ]);
    for (const modes of [['debug;id'], [], ['debug', 'debug']]) {
      await expect(runAction(c, 'php.setXdebug', { enabled: true, modes })).rejects.toBeInstanceOf(ActionInputError);
    }
    await expect(runAction(c, 'service.restart', { service: 'sshd' })).rejects.toBeInstanceOf(ActionInputError);
  });

  it('turn a PHP module on or off through dmp-root, never Xdebug, a bad name or a module WordPress needs off', async () => {
    const { c, lines } = ctx(tempTree());
    await runAction(c, 'php.setModule', { module: 'soap', enabled: true });
    await runAction(c, 'php.setModule', { module: 'pdo_mysql', enabled: false });
    await runAction(c, 'php.setModule', { module: 'mysqli', enabled: true });
    expect(lines()).toEqual([`sudo -n ${DMP} php-module soap on`, `sudo -n ${DMP} php-module pdo_mysql off`, `sudo -n ${DMP} php-module mysqli on`]);
    for (const input of [{ module: 'xdebug', enabled: true }, { module: 'soap;id', enabled: true }, { module: '../soap', enabled: true }, { module: 'mysqli', enabled: false }, { module: 'xml', enabled: false }]) {
      await expect(runAction(c, 'php.setModule', input), JSON.stringify(input)).rejects.toBeInstanceOf(ActionInputError);
    }
    expect(lines()).toHaveLength(3);
  });
});

import { existsSync } from 'node:fs';
import type { ServicesReport } from '@devmagic-panel/shared';
import { MAILPIT_SMTP, MAILPIT_WEB } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import { isListening } from './environment.js';
import type { ExecResult, Executor } from './exec.js';
import { apachePhpVersion, fpmDefaultVersion } from './php/versions.js';
import { parseCrontab, tasksOf } from './cron.js';
import { nginxInstalled, nginxSetUp } from './nginx.js';

/** `systemctl is-active` answers active, inactive, failed, or unknown for a unit that does not exist. */
export async function unitState(exec: Executor, unit: string): Promise<'running' | 'stopped' | 'missing'> {
  const r = await exec('systemctl', ['is-active', unit]);
  const state = r.stdout.trim();
  if (state === 'active' || state === 'reloading' || state === 'activating') return 'running';
  if (state === 'inactive' || state === 'failed' || state === 'deactivating') {
    const exists = await exec('systemctl', ['cat', `${unit}.service`]);
    return exists.code === 0 ? 'stopped' : 'missing';
  }
  return 'missing';
}

const firstLine = (r: ExecResult) => (r.code === 0 ? (r.stdout.trim().split('\n')[0] ?? '') : '');

/** How many tasks of the panel and lines of your own the crontab has. */
function cronDetail(crontab: ExecResult): string {
  if (crontab.code !== 0 && !/no crontab for/i.test(crontab.stderr)) return 'runs your crontab and the system\'s';
  const parsed = parseCrontab(crontab.code === 0 ? crontab.stdout : '');
  const tasks = tasksOf(parsed).length;
  const own = [...parsed.before, ...parsed.after].filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `${n(tasks, 'task', 'tasks')} of the panel, ${n(own, 'line', 'lines')} of your own`;
}

export async function servicesReport(config: SystemConfig, exec: Executor, now = Date.now, mailpitBin?: string): Promise<ServicesReport> {
  const hasNginx = nginxInstalled(config);
  const [apache, mysql, mariadb, mailpit, apacheVersion, mysqlVersion, cli, cron, crontab, nginx, nginxVersion] = await Promise.all([
    unitState(exec, 'apache2'),
    unitState(exec, 'mysql'),
    unitState(exec, 'mariadb'),
    isListening(exec, MAILPIT_SMTP.port),
    exec('apache2ctl', ['-v']),
    exec('mysql', ['--version']),
    exec('php', ['-r', 'echo PHP_VERSION;']),
    unitState(exec, 'cron'),
    exec('crontab', ['-l']),
    hasNginx ? unitState(exec, 'nginx') : Promise.resolve('missing' as const),
    hasNginx ? exec('nginx', ['-v']) : Promise.resolve(null),
  ]);
  const nginxLabel = nginxVersion ? /nginx\/[\d.]+/.exec(`${nginxVersion.stdout}${nginxVersion.stderr}`)?.[0] : undefined;
  const setUp = hasNginx && nginxSetUp(config);
  const nginxDetail = !hasNginx
    ? 'not installed: sudo apt install nginx runs sites on it next to Apache'
    : setUp
      ? `${nginxLabel ?? 'nginx'} on ${config.NGINX_ADDRESS}, Apache on ${config.APACHE_ADDRESS}`
      : `${nginxLabel ?? 'nginx'} installed, not set up next to Apache yet`;
  const db = mysql !== 'missing' ? { unit: 'mysql', state: mysql } : { unit: 'mariadb', state: mariadb };
  const apacheLabel = /Apache\/[\d.]+/.exec(apacheVersion.stdout)?.[0] ?? 'Apache';
  const phpApache = apachePhpVersion(config);
  const phpFpm = phpApache ? undefined : fpmDefaultVersion(config);
  return {
    checkedAt: new Date(now()).toISOString(),
    services: [
      { id: 'apache', label: 'Apache', state: apache, detail: apacheLabel, canRestart: apache !== 'missing' },
      { id: 'nginx', label: 'nginx', state: nginx, detail: nginxDetail, canRestart: setUp && nginx !== 'missing' },
      { id: 'mysql', label: db.unit === 'mysql' ? 'MySQL' : 'MariaDB', state: db.state, detail: firstLine(mysqlVersion) || db.unit, canRestart: db.state !== 'missing' },
      {
        id: 'mailpit',
        label: 'Mailpit',
        state: mailpit ? 'running' : 'stopped',
        detail: mailpit ? `catching mail on port ${MAILPIT_SMTP.port}, read it at ${MAILPIT_WEB}` : `not listening on port ${MAILPIT_SMTP.port}`,
        canRestart: false,
        ...(!mailpit && mailpitBin ? { offer: existsSync(mailpitBin) ? ('start' as const) : ('install' as const) } : {}),
      },
      { id: 'cron', label: 'Cron', state: cron, detail: cron === 'missing' ? 'not installed: sudo apt install cron' : cronDetail(crontab), canRestart: false },
    ],
    php: { ...(phpApache ? { apache: phpApache } : {}), ...(phpFpm ? { fpm: phpFpm } : {}), ...(firstLine(cli) ? { cli: firstLine(cli) } : {}) },
  };
}

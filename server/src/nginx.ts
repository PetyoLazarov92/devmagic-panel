import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NginxConfig, NginxReport, SiteLog } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult, Executor } from './exec.js';
import { runRoot } from './exec.js';
import type { JobStep } from './jobs.js';
import { checkAllSites } from './php/switch.js';
import type { SitePhpContext } from './php/site-php.js';
import { SiteActionRefused } from './sites/site-actions.js';
import { machineUptime, startedAt } from './apache.js';
import { unitState } from './services.js';
import { parseNginxErrorLog, tailFile } from './sites/logs.js';
import { readSiteVhosts, VHOST_MARKER } from './sites/vhost.js';

/**
 * nginx as the nginx tab shows it: whether it is installed and set up next to
 * Apache (scripts/lib/nginx.sh), its state and version, every config in
 * sites-available with whether it is enabled, whose it is and whether it
 * keeps nginx from starting next to Apache, nginx -t and nginx's error log.
 */

/** Same name as DMP_NGINX_CONF_NAME in scripts/lib/nginx.sh. */
export const NGINX_CONF_NAME = 'devmagic-panel.conf';

const nginxDir = (config: SystemConfig) => dirname(config.NGINX_SITES_AVAILABLE);
export const nginxConfFile = (config: SystemConfig) => join(nginxDir(config), 'conf.d', NGINX_CONF_NAME);

const firstLine = (file: string) => {
  try {
    return readFileSync(file, 'utf8').split('\n', 1)[0];
  } catch {
    return undefined;
  }
};

/** The nginx package is on the machine: its nginx.conf is where config.env says. */
export const nginxInstalled = (config: SystemConfig) => existsSync(join(nginxDir(config), 'nginx.conf'));

/** The panel set nginx up next to Apache: its conf.d file is there with the marker. */
export const nginxSetUp = (config: SystemConfig) => firstLine(nginxConfFile(config)) === VHOST_MARKER;

/** server_name and listen of an nginx config, without comments. */
export function parseNginxConfig(text: string): { names: string[]; listens: string[] } {
  const names: string[] = [];
  const listens: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const name = /^server_name\s+([^;]+);/.exec(line)?.[1];
    if (name) for (const n of name.toLowerCase().split(/\s+/)) if (n && n !== '_' && !names.includes(n)) names.push(n);
    const listen = /^listen\s+([^;]+);/.exec(line)?.[1];
    if (listen) listens.push(listen.trim().replace(/\s+/g, ' '));
  }
  return { names, listens };
}

/**
 * Why a listen keeps nginx from starting next to Apache, as dmp_nginx_conflicts
 * in scripts/lib/nginx.sh sees it: port 80 or 443 on every address or on one
 * but nginx's. IPv6 and unix sockets are fine.
 */
export function listenConflict(listen: string, nginxAddress: string): string | null {
  const spec = listen.split(' ')[0] ?? '';
  if (spec.startsWith('unix:') || spec.startsWith('[')) return null;
  let addr: string;
  let port: string;
  if (/^\d+$/.test(spec)) [addr, port] = ['*', spec];
  else if (spec.includes(':')) [addr, port] = [spec.slice(0, spec.lastIndexOf(':')), spec.slice(spec.lastIndexOf(':') + 1)];
  else [addr, port] = [spec, '80'];
  if (port !== '80' && port !== '443') return null;
  if (addr === nginxAddress) return null;
  return addr === '*' || addr === '0.0.0.0' ? `listens on port ${port} on every address` : `listens on port ${port} on ${addr}`;
}

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/** Every config in sites-available, and the enabled ones made by hand that stand in the way of the setup. */
export function nginxConfigs(config: SystemConfig): NginxConfig[] {
  const available = config.NGINX_SITES_AVAILABLE;
  if (!existsSync(available)) return [];
  const enabledDir = config.NGINX_SITES_ENABLED;
  const links = existsSync(enabledDir) ? readdirSync(enabledDir).map((f) => ({ name: f, target: real(join(enabledDir, f)) })) : [];
  const enabled = new Set(links.map((l) => l.target));
  return readdirSync(available)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .flatMap((name): NginxConfig[] => {
      const file = join(available, name);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const { names, listens } = parseNginxConfig(text);
      const managed = text.split('\n', 1)[0] === VHOST_MARKER;
      const isOn = enabled.has(real(file));
      // Debian's default site is turned off by the setup, so it never stands in the way.
      const isDefault = name === 'default' && links.some((l) => l.name === 'default');
      const conflict = isOn && !managed && !isDefault ? listens.map((l) => listenConflict(l, config.NGINX_ADDRESS)).find(Boolean) : undefined;
      return [{ file: name, enabled: isOn, managed, names, listens, ...(conflict ? { conflict } : {}) }];
    });
}

export async function nginxReport(config: SystemConfig, exec: Executor, dmpRoot: string, now = Date.now, uptime = machineUptime): Promise<NginxReport> {
  const installed = nginxInstalled(config);
  const addresses = { nginx: config.NGINX_ADDRESS, apache: config.APACHE_ADDRESS };
  const errorLog = join(config.NGINX_LOG_DIR, 'error.log');
  if (!installed) {
    return { checkedAt: new Date(now()).toISOString(), installed, setUp: false, addresses, configtest: { ok: null, output: 'nginx is not installed' }, server: { state: 'missing' }, configs: [], errorLog };
  }
  const [test, state, version, since] = await Promise.all([
    runRoot(exec, dmpRoot, ['nginx-configtest'], 30_000),
    unitState(exec, 'nginx'),
    exec('nginx', ['-v']),
    startedAt(exec, now(), uptime, 'nginx'),
  ]);
  const output = [test.stdout, test.stderr].map((s) => s.trim()).filter(Boolean).join('\n');
  // sudo refusing (no sudoers rule yet, or root scripts older than nginx) is not a verdict on the config.
  const ran = test.code === 0 || !/\bsudo\b|unknown command/.test(output);
  const versionText = /nginx\/[\d.]+/.exec(`${version.stdout}${version.stderr}`)?.[0];
  return {
    checkedAt: new Date(now()).toISOString(),
    installed,
    setUp: nginxSetUp(config),
    addresses,
    configtest: { ok: ran ? test.code === 0 : null, output: output || (test.code === 0 ? 'syntax is ok' : 'nginx -t failed') },
    server: { state, ...(versionText ? { version: versionText } : {}), ...(state === 'running' && since ? { since } : {}) },
    configs: nginxConfigs(config),
    errorLog,
  };
}

/** The last lines of nginx's own error log. */
export function nginxErrorLog(config: SystemConfig): SiteLog {
  const file = join(config.NGINX_LOG_DIR, 'error.log');
  return { file, shared: true, exists: existsSync(file), lines: parseNginxErrorLog(tailFile(file, 512 * 1024)) };
}

const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
const root = (ctx: SitePhpContext, args: string[]) => ctx.exec('sudo', ['-n', ctx.dmpRoot, ...args], { timeoutMs: 180_000 });

/**
 * nginx.setup: nginx next to Apache (dmp-root nginx-setup), then every site
 * must still answer, now on Apache's own address. Undo turns nginx off again,
 * unless it was set up before and this run only wrote its settings anew.
 */
export function planNginxSetup(ctx: SitePhpContext): JobStep[] {
  const { config } = ctx;
  if (!nginxInstalled(config)) throw new SiteActionRefused('nginx is not installed: run sudo apt install nginx in a terminal, then set it up here.');
  const conflicts = nginxConfigs(config).filter((c) => c.conflict);
  if (conflicts.length > 0) {
    throw new SiteActionRefused(`Not yet: ${conflicts.map((c) => `${c.file} ${c.conflict}`).join('; ')}. Make ${conflicts.length === 1 ? 'it' : 'them'} listen on ${config.NGINX_ADDRESS}, or turn ${conflicts.length === 1 ? 'it' : 'them'} off.`);
  }
  const before = nginxSetUp(config);
  return [
    {
      id: 'setup',
      label: before ? 'Write the panel\'s nginx settings anew' : `Move Apache to ${config.APACHE_ADDRESS}, start nginx on ${config.NGINX_ADDRESS}`,
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, ['nginx-setup']);
        if (r.code === 0 && !before) job.onUndo('Turn nginx off; Apache answers on every address again', () => root(ctx, ['nginx-teardown']));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
    checkAllSites(ctx),
  ];
}

/** nginx.teardown: Apache back on every address and nginx stopped, then every site must still answer. Undo sets nginx up again. */
export function planNginxTeardown(ctx: SitePhpContext): JobStep[] {
  if (!nginxSetUp(ctx.config)) throw new SiteActionRefused('nginx is not set up next to Apache.');
  const onNginx = readSiteVhosts(ctx.config).filter((v) => v.server === 'nginx').map((v) => v.names[0] as string);
  if (onNginx.length) throw new SiteActionRefused(`${onNginx.join(', ')} ${onNginx.length === 1 ? 'runs' : 'run'} on nginx: move ${onNginx.length === 1 ? 'it' : 'them'} to Apache on the Server and PHP tab first.`);
  return [
    {
      id: 'teardown',
      label: 'Turn nginx off; Apache answers on every address again',
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, ['nginx-teardown']);
        if (r.code === 0) job.onUndo(`Set nginx up again on ${ctx.config.NGINX_ADDRESS}`, () => root(ctx, ['nginx-setup']));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
    checkAllSites(ctx),
  ];
}

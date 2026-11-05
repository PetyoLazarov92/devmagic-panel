import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApacheModule, ApacheReport, ApacheVhost, SiteLog } from '@devmagic-panel/shared';
import { apacheModuleLock, isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { Executor } from './exec.js';
import { runRoot } from './exec.js';
import { parseCertText } from './sites/discover.js';
import { parseApacheErrorLog, tailFile } from './sites/logs.js';
import { apachePhpVersion } from './php/versions.js';
import { unitState } from './services.js';
import { parseVhost } from './sites/vhost.js';

/**
 * Apache as the Apache tab shows it: at a glance (version, state, worker
 * model, PHP, ports), every module in mods-available with whether it is on,
 * every vhost file in sites-available with whether it is enabled and whose
 * it is, a configtest, and Apache's own error log. Modules switch through
 * apache.setModule; Reload and Restart are the Services page's own.
 */

/** The modules of a mods folder, from their .load files. */
function loads(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^([a-z][a-z0-9_.]*)\.load$/.exec(f)?.[1])
    .filter((n): n is string => Boolean(n))
    .sort();
}

/** Every module in mods-available, with whether it is on and, when the panel will not switch it, why. */
export function apacheModules(config: SystemConfig): ApacheModule[] {
  const base = dirname(config.APACHE_SITES_AVAILABLE);
  const enabled = new Set(loads(join(base, 'mods-enabled')));
  return loads(join(base, 'mods-available')).map((name) => {
    const on = enabled.has(name);
    const locked = apacheModuleLock(name, !on);
    return { name, enabled: on, ...(locked ? { locked } : {}) };
  });
}

/** The ports ports.conf listens on: Listen 80, Listen 443 https, Listen 127.0.0.1:8080. */
export function listenPorts(config: SystemConfig): string[] {
  const file = join(dirname(config.APACHE_SITES_AVAILABLE), 'ports.conf');
  if (!existsSync(file)) return [];
  const ports = [...readFileSync(file, 'utf8').matchAll(/^\s*Listen\s+(\S+)/gim)].map((m) => (m[1] as string).split(':').pop() as string).filter((p) => /^\d{1,5}$/.test(p));
  return [...new Set(ports)];
}

/** Seconds since the machine started, from /proc/uptime. */
const machineUptime = () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);

/** When Apache last started: systemd's monotonic start, against the machine's uptime. */
async function startedAt(exec: Executor, now: number, uptime: () => number): Promise<string | undefined> {
  const r = await exec('systemctl', ['show', 'apache2', '--property=ActiveEnterTimestampMonotonic', '--value']);
  const micros = Number(r.stdout.trim());
  if (r.code !== 0 || !micros) return undefined;
  try {
    const ago = uptime() * 1000 - micros / 1000;
    return ago >= 0 ? new Date(now - ago).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

export async function apacheReport(config: SystemConfig, exec: Executor, dmpRoot: string, now = Date.now, uptime = machineUptime): Promise<ApacheReport> {
  const enabled = new Set(existsSync(config.APACHE_SITES_ENABLED) ? readdirSync(config.APACHE_SITES_ENABLED).map((f) => real(join(config.APACHE_SITES_ENABLED, f))) : []);
  const files = existsSync(config.APACHE_SITES_AVAILABLE) ? readdirSync(config.APACHE_SITES_AVAILABLE).filter((f) => f.endsWith('.conf')).sort() : [];
  const [test, state, version, since, ...vhosts] = await Promise.all([
    runRoot(exec, dmpRoot, ['apache-configtest'], 30_000),
    unitState(exec, 'apache2'),
    exec('apache2ctl', ['-v']),
    startedAt(exec, now(), uptime),
    ...files.map(async (name): Promise<ApacheVhost | null> => {
      const file = join(config.APACHE_SITES_AVAILABLE, name);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      const info = parseVhost(text, file, config.APACHE_LOG_DIR);
      const primary = info.names[0];
      const isSite = Boolean(primary && isLocalName(primary) && primary !== config.PANEL_DOMAIN && info.docroot?.startsWith(`${config.WEB_DIR}/`));
      const isOn = enabled.has(real(file));
      const cert = info.certFile ? await exec('openssl', ['x509', '-in', info.certFile, '-noout', '-enddate']) : null;
      const expires = cert?.code === 0 ? parseCertText(cert.stdout).expiresAt : '';
      return {
        file: name,
        enabled: isOn,
        managed: info.managed,
        names: info.names,
        ...(info.docroot ? { docroot: info.docroot } : {}),
        // Only an enabled one has a page: the panel reads sites from what Apache serves.
        ...(isSite && isOn && primary ? { site: primary } : {}),
        mounts: info.mounts.map((m) => m.path),
        ...(expires ? { certExpiresAt: expires } : {}),
      };
    }),
  ]);
  const output = [test.stdout, test.stderr].map((s) => s.trim()).filter(Boolean).join('\n');
  // dmp-root's configtest says Syntax OK; sudo refusing (no sudoers rule yet) is not a verdict on the config.
  const ran = test.code === 0 || !/\bsudo\b/.test(output);
  const modules = apacheModules(config);
  const mpm = modules.find((m) => m.enabled && m.name.startsWith('mpm_'))?.name;
  const php = apachePhpVersion(config);
  const versionText = /Apache\/[\d.]+/.exec(version.stdout)?.[0];
  return {
    checkedAt: new Date(now()).toISOString(),
    configtest: { ok: ran ? test.code === 0 : null, output: output || (test.code === 0 ? 'Syntax OK' : 'configtest failed') },
    server: {
      state,
      ...(versionText ? { version: versionText } : {}),
      ...(state === 'running' && since ? { since } : {}),
      ...(mpm ? { mpm } : {}),
      ...(php ? { php } : {}),
      ports: listenPorts(config),
    },
    modules,
    vhosts: vhosts.filter((v): v is ApacheVhost => v !== null),
    errorLog: join(config.APACHE_LOG_DIR, 'error.log'),
  };
}

/** The last lines of Apache's own error log. */
export function apacheErrorLog(config: SystemConfig): SiteLog {
  const file = join(config.APACHE_LOG_DIR, 'error.log');
  return { file, shared: true, exists: existsSync(file), lines: parseApacheErrorLog(tailFile(file, 512 * 1024)) };
}

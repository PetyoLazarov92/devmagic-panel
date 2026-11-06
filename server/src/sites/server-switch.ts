import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ActionInput } from '@devmagic-panel/shared';
import { isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { nginxSetUp } from '../nginx.js';
import { readPools } from '../php/pools.js';
import { checkSite } from '../php/site-php.js';
import { apachePhpVersion, fpmDefaultVersion } from '../php/versions.js';
import { findVhost } from './discover.js';
import { htaccessIgnored, readHtaccess, siteKind } from './htaccess.js';
import { hostsOutsideBlock, readHosts } from './hosts-block.js';
import { mountArgs, SiteActionRefused } from './site-actions.js';
import { readSiteVhosts, type VhostInfo } from './vhost.js';
import { parseWpConfig } from './wpconfig.js';

/**
 * site.setServer: a site moves between Apache and nginx, both on ports 80
 * and 443 on their own addresses. Its folder, database and certificate stay;
 * its server config is written for the other server, its hosts line follows
 * (dmp-root hosts-add reads where it runs), and the old config goes once the
 * site answers. Undo moves it back. On nginx already, it writes the nginx
 * file again, as after the site became a network.
 */

export interface ServerSwitchContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  settle?: { tries?: number; delayMs?: number };
}

const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
const root = (ctx: ServerSwitchContext, args: string[]) => ctx.exec('sudo', ['-n', ctx.dmpRoot, ...args], { timeoutMs: 180_000 });
const failed = (r: ExecResult) => (r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` });

/** The PHP-FPM version a site's PHP goes to on nginx: its own pool's, else the default version's, when that FPM is installed. */
export function nginxPhpVersion(config: SystemConfig, domain: string): string | undefined {
  const pool = readPools(config).find((p) => p.folder === domain);
  if (pool) return pool.version;
  const version = fpmDefaultVersion(config) ?? apachePhpVersion(config);
  return version && existsSync(join(config.PHP_LIB_DIR, version, 'sapi', 'fpm')) ? version : undefined;
}

/** What nginx leaves out of the site's .htaccess, for the move dialog. */
export function ignoredOnNginx(docroot: string): string[] {
  return htaccessIgnored(readHtaccess(docroot) ?? '');
}

/** The WordPress rules a site needs on nginx, from its wp-config.php. */
function kindOf(docroot: string): 'single' | 'subdirectory' | 'subdomain' {
  const file = join(docroot, 'wp-config.php');
  return existsSync(file) ? siteKind(parseWpConfig(readFileSync(file, 'utf8'))) : 'single';
}

/**
 * Why a site cannot move to the other server, or null when it can: the
 * checks site.setServer makes before anything runs, also shown on the site's
 * page before you click.
 */
export function moveRefusal(config: SystemConfig, vhost: VhostInfo, domain: string): string | null {
  if (!vhost.docroot || vhost.names[0] !== domain) return `${domain} is not a site's primary domain here`;
  if (!vhost.managed) return `the vhost of ${domain} was made by hand, so it stays on Apache as it is`;
  if (vhost.docroot !== join(config.WEB_DIR, domain)) return `${domain} lives in ${vhost.docroot}, not ${join(config.WEB_DIR, domain)}; only a site in the usual folder moves`;
  if (vhost.server === 'nginx') return null;
  if (!nginxSetUp(config)) return 'nginx is not set up next to Apache yet: set it up on Services, nginx first';
  const elsewhere = vhost.mounts.filter((m) => dirname(m.docroot) !== config.WEB_DIR);
  if (elsewhere.length) return `${domain} serves ${elsewhere.map((m) => m.docroot).join(', ')} from outside ${config.WEB_DIR}, which the panel does not move`;
  const outside = hostsOutsideBlock(readHosts(config), vhost.names);
  if (outside.length) return `${outside.join(', ')} ${outside.length === 1 ? 'has' : 'have'} a line in /etc/hosts outside the panel's block, which keeps the site on Apache: remove that line first`;
  if (!nginxPhpVersion(config, domain)) return `nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain} runs: install PHP-FPM for it on Services, PHP`;
  const noFpm = vhost.mounts.find((m) => !nginxPhpVersion(config, basename(m.docroot)));
  if (noFpm) return `nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain}${noFpm.path} runs: install PHP-FPM for it on Services, PHP`;
  return null;
}

/** What the site page shows about moving the site: why it cannot, what nginx leaves out, its PHP there. */
export function moveFacts(config: SystemConfig, vhost: VhostInfo, domain: string): { refusal?: string; ignored: string[]; php?: string } {
  const refusal = moveRefusal(config, vhost, domain);
  const ignored = vhost.docroot && vhost.server === 'apache' ? ignoredOnNginx(vhost.docroot) : [];
  const php = nginxPhpVersion(config, domain);
  return { ...(refusal ? { refusal } : {}), ignored, ...(php ? { php } : {}) };
}

export function planSetServer(ctx: ServerSwitchContext, { domain, server, acceptIgnored }: ActionInput<'site.setServer'>): JobStep[] {
  const { config } = ctx;
  const vhost = findVhost(config, domain);
  if (!vhost) throw new SiteActionRefused(`${domain} is not a site's primary domain here`);
  const refusal = moveRefusal(config, vhost, domain);
  if (refusal) throw new SiteActionRefused(refusal);
  const aliases = vhost.names.slice(1).filter(isLocalName);
  const names = [domain, ...aliases];

  if (server === 'apache') {
    if (vhost.server === 'apache') throw new SiteActionRefused(`${domain} runs on Apache already`);
    return toApache(ctx, vhost, domain, aliases);
  }

  if (!nginxSetUp(config)) throw new SiteActionRefused('nginx is not set up next to Apache yet: set it up on Services, nginx first.');
  const php = nginxPhpVersion(config, domain);
  if (!php) throw new SiteActionRefused(`nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain} runs: install PHP-FPM for it on Services, PHP`);
  const kind = kindOf(vhost.docroot as string);
  const write = () => root(ctx, ['nginx-site-write', domain, '--kind', kind, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...mountArgs(config, vhost.mounts), ...aliases]);

  if (vhost.server === 'nginx') {
    return [{ id: 'nginx', label: `Write the nginx site for ${domain} again, with the ${kind === 'single' ? 'single site' : `${kind} network`} rules`, weight: 2, run: async () => failed(await write()) }, check(ctx, domain)];
  }
  const ignored = ignoredOnNginx(vhost.docroot as string);
  if (ignored.length && !acceptIgnored) {
    throw new SiteActionRefused(`nginx does not read .htaccess, and ${domain}'s has rules beyond WordPress's: ${ignored.join(', ')}. Tick that you accept it, or keep the site on Apache.`);
  }
  return [
    {
      id: 'nginx',
      label: `Write the nginx site for ${domain}, its PHP through PHP-FPM ${php}`,
      weight: 2,
      run: async (job) => {
        const r = await write();
        // Undo goes last: the nginx file leaves, and the hosts line follows the site back to Apache.
        if (r.code === 0) {
          job.onUndo('Take the site off nginx and point its hosts line at Apache', async () => {
            const removed = await root(ctx, ['nginx-site-remove', domain]);
            return removed.code === 0 ? root(ctx, ['hosts-add', ...names]) : removed;
          });
        }
        return failed(r);
      },
    },
    { id: 'hosts', label: `Point the hosts line at nginx (${config.NGINX_ADDRESS})`, weight: 1, run: async () => failed(await root(ctx, ['hosts-add', ...names])) },
    check(ctx, domain),
    {
      id: 'apache',
      label: 'Remove the Apache vhost',
      weight: 1,
      run: async (job) => {
        const r = await root(ctx, ['vhost-remove', domain]);
        if (r.code === 0) job.onUndo('Write the Apache vhost again', () => root(ctx, apacheArgs(config, vhost, domain, aliases)));
        return failed(r);
      },
    },
  ];
}

/**
 * sites.setServerAll: every site that can moves to one server, one after the
 * other, each as site.setServer moves it. Sites that cannot (made by hand,
 * no PHP-FPM, .htaccess rules nginx ignores without the tick) stay where they
 * are and are listed. Undo moves every site back.
 */
export function planSetServerAll(ctx: ServerSwitchContext, { server, acceptIgnored }: ActionInput<'sites.setServerAll'>): JobStep[] {
  const target = server === 'nginx' ? 'nginx' : 'Apache';
  const moving: string[] = [];
  const staying: string[] = [];
  for (const vhost of readSiteVhosts(ctx.config).filter((v) => v.server !== server)) {
    const domain = vhost.names[0] as string;
    const refusal = moveRefusal(ctx.config, vhost, domain);
    const ignored = server === 'nginx' && vhost.docroot ? ignoredOnNginx(vhost.docroot) : [];
    if (refusal) staying.push(`${domain}: ${refusal}`);
    else if (ignored.length && !acceptIgnored) staying.push(`${domain}: nginx would not read its .htaccess rules (${ignored.join(', ')})`);
    else moving.push(domain);
  }
  if (moving.length === 0) {
    throw new SiteActionRefused(staying.length ? `No site can move to ${target}: ${staying.join('; ')}` : `Every site runs on ${target} already`);
  }
  const list: JobStep = {
    id: 'list',
    label: `Move ${moving.length} site${moving.length === 1 ? '' : 's'} to ${target}${staying.length ? `, leave ${staying.length} as ${staying.length === 1 ? 'it is' : 'they are'}` : ''}`,
    weight: 1,
    run: async () => ({ code: 0, stdout: [`moving: ${moving.join(', ')}`, ...staying.map((s) => `staying: ${s}`)].join('\n'), stderr: '' }),
  };
  return [
    list,
    ...moving.flatMap((domain) =>
      planSetServer(ctx, { domain, server, acceptIgnored }).map((step) => ({ ...step, id: `${domain}:${step.id}`, label: `${domain}: ${step.label}` })),
    ),
  ];
}

const apacheArgs = (config: SystemConfig, vhost: VhostInfo, domain: string, aliases: string[]) => [
  'vhost-write', domain, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...mountArgs(config, vhost.mounts), ...aliases,
];

function toApache(ctx: ServerSwitchContext, vhost: VhostInfo, domain: string, aliases: string[]): JobStep[] {
  const names = [domain, ...aliases];
  const kind = vhost.kind ?? 'single';
  return [
    {
      id: 'apache',
      label: 'Write the Apache vhost',
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, apacheArgs(ctx.config, vhost, domain, aliases));
        if (r.code === 0) job.onUndo('Remove the Apache vhost', () => root(ctx, ['vhost-remove', domain]));
        return failed(r);
      },
    },
    {
      id: 'nginx',
      label: 'Take the site off nginx',
      weight: 1,
      run: async (job) => {
        const r = await root(ctx, ['nginx-site-remove', domain]);
        if (r.code === 0) {
          job.onUndo('Write the nginx site again and point the hosts line at nginx', async () => {
            const written = await root(ctx, ['nginx-site-write', domain, '--kind', kind, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...mountArgs(ctx.config, vhost.mounts), ...aliases]);
            return written.code === 0 ? root(ctx, ['hosts-add', ...names]) : written;
          });
        }
        return failed(r);
      },
    },
    { id: 'hosts', label: `Point the hosts line at Apache (${ctx.config.APACHE_ADDRESS})`, weight: 1, run: async () => failed(await root(ctx, ['hosts-add', ...names])) },
    check(ctx, domain),
  ];
}

/** The site answers where its hosts line now points, without PHP source or a server error. */
function check(ctx: ServerSwitchContext, domain: string): JobStep {
  return { id: 'check', label: `Check ${domain} answers`, weight: 1, run: () => checkSite(ctx, { domain, host: domain }) };
}

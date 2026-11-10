import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ActionInput } from '@devmagic-panel/shared';
import { isLocalName, SITE_SERVER_LABEL, SITE_SERVERS, type HtaccessRule, type SiteMove, type SiteServer } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { nginxSetUp } from '../nginx.js';
import { readPools } from '../php/pools.js';
import { checkSite } from '../php/site-php.js';
import { apachePhpVersion, fpmDefaultVersion } from '../php/versions.js';
import { findVhost } from './discover.js';
import { htaccessFolders, readHtaccess, siteKind, staticRules } from './htaccess.js';
import { chosenRules, readHtaccessReport, reportSums, sameSums } from './htaccess-rules.js';
import { hostsLinesOutside, readHosts } from './hosts-block.js';
import { mountArgs, ruleArgs, SiteActionRefused } from './site-actions.js';
import { readSiteVhosts, siteServer, type VhostInfo } from './vhost.js';
import { parseWpConfig } from './wpconfig.js';

/**
 * site.setServer: a site moves between Apache, nginx in front of its Apache
 * vhost, and nginx with PHP-FPM. Apache and nginx answer on ports 80 and 443,
 * each on its own address. Its folder, database and certificate stay;
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

/** A site made by hand that the panel took over: dmp-root keeps its record in STATE_DIR/taken-over/<domain>. */
const takenOver = (config: SystemConfig, domain: string) => existsSync(join(config.STATE_DIR, 'taken-over', domain));

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

/** How the move dialog names a rule: its file when it is not the site's own, its section, and its first line. */
const ruleName = (r: HtaccessRule) => `${r.file === '/' ? '' : `${r.file}: `}${r.section ? `${r.section}: ` : ''}${(r.source.split('\n')[0] ?? '').slice(0, 90)}`;

/** What nginx leaves out of the site's .htaccess files: rules the panel does not translate, and PHP settings for the PHP tab. */
export function ignoredOnNginx(docroot: string): string[] {
  const left = readHtaccessReport(docroot).rules.filter((r) => r.status === 'manual' || r.status === 'php');
  const names = left.slice(0, 8).map((r) => (r.status === 'php' ? `PHP setting: ${ruleName(r)}` : ruleName(r)));
  return left.length > 8 ? [...names, `and ${left.length - 8} more`] : names;
}

/** The WordPress rules a site needs on nginx, from its wp-config.php. */
function kindOf(docroot: string): 'single' | 'subdirectory' | 'subdomain' {
  const file = join(docroot, 'wp-config.php');
  return existsSync(file) ? siteKind(parseWpConfig(readFileSync(file, 'utf8'))) : 'single';
}

/** The folders of a site with an .htaccess of their own; fresh when a move is planned, else from the last minute. */
export const apachePaths = (docroot: string, fresh = false): string[] => htaccessFolders(docroot, fresh);

/**
 * Why a site cannot run on a web server, or null when it can: the checks
 * site.setServer makes before anything runs, also shown on the site's page
 * before you click. Its own server always can (to write its files again).
 */
export function moveRefusal(config: SystemConfig, vhost: VhostInfo, domain: string, target: SiteServer = 'nginx'): string | null {
  if (!vhost.docroot || vhost.names[0] !== domain) return `${domain} is not a site's primary domain here`;
  if (!vhost.managed) return `the vhost of ${domain} was made by hand, so it stays on Apache as it is: take the site over first (Take over... on its Overview)`;
  if (vhost.docroot !== join(config.WEB_DIR, domain)) return `${domain} lives in ${vhost.docroot}, not ${join(config.WEB_DIR, domain)}; only a site in the usual folder moves`;
  if (target === 'apache' || target === siteServer(vhost)) return null;
  if (!nginxSetUp(config)) return 'nginx is not set up next to Apache yet: set it up on Services, nginx first';
  const outside = hostsLinesOutside(readHosts(config), vhost.names);
  if (outside.shared.length) return `/etc/hosts has ${outside.shared.map((l) => `"${l}"`).join(' and ')} outside the panel's block, naming ${domain} with other hosts, which keeps the site on Apache: take ${domain} off ${outside.shared.length === 1 ? 'that line' : 'those lines'} by hand (sudo nano /etc/hosts)`;
  // A site taken over has its own lines moved into its takeover record by the move itself; another site's need a person.
  if (outside.own.length && !takenOver(config, domain)) return `/etc/hosts has ${outside.own.map((l) => `"${l}"`).join(' and ')} outside the panel's block, which keeps the site on Apache: remove ${outside.own.length === 1 ? 'that line' : 'those lines'} by hand first (sudo nano /etc/hosts)`;
  // In front of Apache, the vhost serves the sites under its paths and runs every PHP as before.
  if (target === 'nginx-apache') return null;
  const elsewhere = vhost.mounts.filter((m) => dirname(m.docroot) !== config.WEB_DIR);
  if (elsewhere.length) return `${domain} serves ${elsewhere.map((m) => m.docroot).join(', ')} from outside ${config.WEB_DIR}, which the panel does not move`;
  if (!nginxPhpVersion(config, domain)) return `nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain} runs: install PHP-FPM for it on Services, PHP`;
  const noFpm = vhost.mounts.find((m) => !nginxPhpVersion(config, basename(m.docroot)));
  if (noFpm) return `nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain}${noFpm.path} runs: install PHP-FPM for it on Services, PHP`;
  return null;
}

/** What the site page shows about moving the site: why it cannot go where, what each server leaves out, its PHP there. */
export function moveFacts(config: SystemConfig, vhost: VhostInfo, domain: string): SiteMove {
  const current = siteServer(vhost);
  const refusals: SiteMove['refusals'] = {};
  for (const server of SITE_SERVERS) {
    if (server === current) continue;
    const why = moveRefusal(config, vhost, domain, server);
    if (why) refusals[server] = why;
  }
  const docroot = vhost.docroot;
  const ignored = docroot && current !== 'nginx' ? ignoredOnNginx(docroot) : [];
  const php = nginxPhpVersion(config, domain);
  const front: SiteMove['front'] = {
    apachePaths: docroot && current !== 'nginx' ? apachePaths(docroot) : [],
    staticRules: docroot && current !== 'nginx' ? staticRules(readHtaccess(docroot) ?? '') : [],
    ...(vhost.front ? { static: vhost.front.static } : {}),
  };
  return { refusals, ignored, ...(php ? { php } : {}), front };
}

const LABEL = SITE_SERVER_LABEL;

export function planSetServer(ctx: ServerSwitchContext, input: ActionInput<'site.setServer'>): JobStep[] {
  const { config } = ctx;
  const { domain, server: target } = input;
  const vhost = findVhost(config, domain);
  if (!vhost) throw new SiteActionRefused(`${domain} is not a site's primary domain here`);
  const refusal = moveRefusal(config, vhost, domain, target);
  if (refusal) throw new SiteActionRefused(refusal);
  const current = siteServer(vhost);
  if (target === 'apache' && current === 'apache') throw new SiteActionRefused(`${domain} runs on Apache already`);
  if (target !== 'apache' && !nginxSetUp(config)) throw new SiteActionRefused('nginx is not set up next to Apache yet: set it up on Services, nginx first.');
  const aliases = vhost.names.slice(1).filter(isLocalName);
  const names = [domain, ...aliases];
  const docroot = vhost.docroot as string;
  // A site taken over before takeovers moved hosts lines: the line made by hand would keep it on Apache, so it moves first.
  const own = target !== 'apache' && target !== current ? hostsLinesOutside(readHosts(config), vhost.names).own : [];
  const ownHosts: JobStep[] = own.length
    ? [{ id: 'hosts-own', label: `Move the hosts line${own.length === 1 ? '' : 's'} made by hand (${own.join('; ')}) into the takeover record; Give back puts ${own.length === 1 ? 'it' : 'them'} back`, weight: 1, run: async () => failed(await root(ctx, ['hosts-adopt', domain])) }]
    : [];

  if (target === 'nginx') {
    const php = nginxPhpVersion(config, domain);
    if (!php) throw new SiteActionRefused(`nginx runs PHP through PHP-FPM only, and there is none for the PHP version ${domain} runs: install PHP-FPM for it on Services, PHP`);
    const kind = kindOf(docroot);
    if (current === 'nginx') {
      const again = () => root(ctx, nginxArgs(config, vhost, domain, aliases, kind, vhost.rules, vhost.htaccessSums));
      return [{ id: 'nginx', label: `Write the nginx site for ${domain} again, with the ${kind === 'single' ? 'single site' : `${kind} network`} rules`, weight: 2, run: async () => failed(await again()) }, check(ctx, domain)];
    }
    // The .htaccess rules the panel translates go along: the ones reviewed, when the dialog sent them.
    const report = readHtaccessReport(docroot, undefined, Date.now(), true);
    if (input.htaccess && !sameSums(reportSums(report), input.htaccess.sums)) {
      throw new SiteActionRefused(`${domain}'s .htaccess changed since you reviewed it: review its rules again`);
    }
    const left = report.rules.filter((r) => r.status === 'manual' || r.status === 'php');
    if (left.length && !input.acceptIgnored && !input.htaccess) {
      throw new SiteActionRefused(`nginx does not read .htaccess, and ${domain}'s has rules the panel does not translate: ${ignoredOnNginx(docroot).join(', ')}. Tick that you accept it, or keep the site on Apache, or put nginx in front of Apache.`);
    }
    const rules = chosenRules(report, input.htaccess?.skip);
    const sums = reportSums(report);
    const write = () => root(ctx, nginxArgs(config, vhost, domain, aliases, kind, rules, sums));
    return [
      ...ownHosts,
      {
        id: 'nginx',
        label: `Write the nginx site for ${domain}, its PHP through PHP-FPM ${php}${rules.length ? `, with ${rules.length} rule${rules.length === 1 ? '' : 's'} from its .htaccess` : ''}`,
        weight: 2,
        run: async (job) => {
          const r = await write();
          // Undo goes last: the nginx file leaves (or nginx goes back in front), and the hosts line follows.
          if (r.code === 0) {
            job.onUndo(current === 'nginx-apache' ? 'Put nginx in front of Apache again' : 'Take the site off nginx and point its hosts line at Apache', async () => {
              const back = current === 'nginx-apache' ? await root(ctx, frontArgs(domain, vhost.front?.static ?? true, apachePaths(docroot, true), aliases)) : await root(ctx, ['nginx-site-remove', domain]);
              return back.code === 0 ? root(ctx, ['hosts-add', ...names]) : back;
            });
          }
          return failed(r);
        },
      },
      hostsStep(ctx, names, 'nginx'),
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

  if (target === 'nginx-apache') {
    const paths = input.static ? apachePaths(docroot, true) : [];
    const write = () => root(ctx, frontArgs(domain, input.static, paths, aliases));
    const what = input.static ? `nginx serves images, CSS, JS and fonts${paths.length ? `, ${paths.length} folder${paths.length === 1 ? '' : 's'} with an .htaccess of ${paths.length === 1 ? 'its' : 'their'} own go${paths.length === 1 ? 'es' : ''} to Apache` : ''}` : 'every request goes to Apache';
    if (current === 'nginx-apache') {
      return [{ id: 'nginx', label: `Write nginx in front of Apache for ${domain} again: ${what}`, weight: 2, run: async () => failed(await write()) }, check(ctx, domain)];
    }
    const steps: JobStep[] = [...ownHosts];
    if (current === 'nginx') {
      // The vhost comes back first: nginx sends the site's requests to it.
      steps.push({
        id: 'apache',
        label: 'Write the Apache vhost',
        weight: 2,
        run: async (job) => {
          const r = await root(ctx, apacheArgs(config, vhost, domain, aliases));
          if (r.code === 0) job.onUndo('Remove the Apache vhost', () => root(ctx, ['vhost-remove', domain]));
          return failed(r);
        },
      });
    }
    steps.push(
      {
        id: 'nginx',
        label: `Put nginx in front of the Apache vhost: ${what}`,
        weight: 2,
        run: async (job) => {
          const r = await write();
          if (r.code === 0) {
            job.onUndo(current === 'nginx' ? 'Write the nginx site again' : 'Take nginx out and point the hosts line at Apache', async () => {
              if (current === 'nginx') return root(ctx, nginxArgs(config, vhost, domain, aliases, vhost.kind ?? 'single', vhost.rules, vhost.htaccessSums));
              const removed = await root(ctx, ['nginx-site-remove', domain]);
              return removed.code === 0 ? root(ctx, ['hosts-add', ...names]) : removed;
            });
          }
          return failed(r);
        },
      },
      hostsStep(ctx, names, 'nginx'),
      check(ctx, domain),
    );
    return steps;
  }

  return current === 'nginx' ? toApache(ctx, vhost, domain, aliases) : frontToApache(ctx, vhost, domain, aliases);
}

/**
 * sites.setServerAll: every site that can moves to one server, one after the
 * other, each as site.setServer moves it. Sites that cannot (made by hand,
 * no PHP-FPM, .htaccess rules nginx ignores without the tick) stay where they
 * are and are listed. Undo moves every site back.
 */
export function planSetServerAll(ctx: ServerSwitchContext, input: ActionInput<'sites.setServerAll'>): JobStep[] {
  const { server } = input;
  const target = LABEL[server];
  const moving: string[] = [];
  const staying: string[] = [];
  for (const vhost of readSiteVhosts(ctx.config).filter((v) => siteServer(v) !== server)) {
    const domain = vhost.names[0] as string;
    const refusal = moveRefusal(ctx.config, vhost, domain, server);
    const ignored = server === 'nginx' && vhost.docroot ? ignoredOnNginx(vhost.docroot) : [];
    if (refusal) staying.push(`${domain}: ${refusal}`);
    else if (ignored.length && !input.acceptIgnored) staying.push(`${domain}: nginx would not read its .htaccess rules (${ignored.join(', ')})`);
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
      planSetServer(ctx, { domain, server, static: input.static, acceptIgnored: input.acceptIgnored }).map((step) => ({ ...step, id: `${domain}:${step.id}`, label: `${domain}: ${step.label}` })),
    ),
  ];
}

/**
 * site.applyHtaccessRules: a site on nginx gets its .htaccess rules as
 * reviewed. The files are read again here, never taken from the browser;
 * when one changed since the review, nothing is written. Undo writes the
 * rules it had before.
 */
export function planApplyHtaccess(ctx: ServerSwitchContext, input: ActionInput<'site.applyHtaccessRules'>): JobStep[] {
  const { config } = ctx;
  const { domain } = input;
  const vhost = findVhost(config, domain);
  if (!vhost?.docroot || vhost.names[0] !== domain) throw new SiteActionRefused(`${domain} is not a site's primary domain here`);
  if (vhost.server !== 'nginx') throw new SiteActionRefused(`${domain} does not run on nginx alone: ${siteServer(vhost) === 'nginx-apache' ? 'Apache behind nginx reads its .htaccess' : 'Apache reads its .htaccess'} as it is`);
  if (!vhost.managed) throw new SiteActionRefused(`the nginx file of ${domain} was not written by the panel`);
  const report = readHtaccessReport(vhost.docroot, undefined, Date.now(), true);
  const sums = reportSums(report);
  if (!sameSums(sums, input.sums)) throw new SiteActionRefused(`${domain}'s .htaccess changed since you reviewed it: review its rules again`);
  const rules = chosenRules(report, input.skip);
  const aliases = vhost.names.slice(1).filter(isLocalName);
  const kind = vhost.kind ?? 'single';
  const before = { rules: vhost.rules ?? [], sums: vhost.htaccessSums ?? {} };
  return [
    {
      id: 'nginx',
      label: rules.length ? `Write ${rules.length} rule${rules.length === 1 ? '' : 's'} from ${domain}'s .htaccess into its nginx file` : `Write ${domain}'s nginx file with no .htaccess rules`,
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, nginxArgs(config, vhost, domain, aliases, kind, rules, sums));
        if (r.code === 0) job.onUndo('Put the rules back as they were', () => root(ctx, nginxArgs(config, vhost, domain, aliases, kind, before.rules, before.sums)));
        return failed(r);
      },
    },
    check(ctx, domain),
  ];
}

const apacheArgs = (config: SystemConfig, vhost: VhostInfo, domain: string, aliases: string[]) => [
  'vhost-write', domain, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...mountArgs(config, vhost.mounts), ...aliases,
];

const nginxArgs = (config: SystemConfig, vhost: VhostInfo, domain: string, aliases: string[], kind: string, rules?: string[], sums?: Record<string, string>) => [
  'nginx-site-write', domain, '--kind', kind, ...(vhost.uploadsProxy ? ['--uploads-proxy', vhost.uploadsProxy] : []), ...ruleArgs(rules, sums), ...mountArgs(config, vhost.mounts), ...aliases,
];

/** dmp-root's command for nginx in front of the site's Apache vhost. */
export const frontArgs = (domain: string, staticFiles: boolean, paths: string[], aliases: string[]) => [
  'nginx-site-write', domain, '--upstream', 'apache', '--static', staticFiles ? 'on' : 'off', ...(staticFiles ? paths.flatMap((p) => ['--apache-path', p]) : []), ...aliases,
];

const hostsStep = (ctx: ServerSwitchContext, names: string[], to: 'nginx' | 'apache'): JobStep => ({
  id: 'hosts',
  label: `Point the hosts line at ${to === 'nginx' ? `nginx (${ctx.config.NGINX_ADDRESS})` : `Apache (${ctx.config.APACHE_ADDRESS})`}`,
  weight: 1,
  run: async () => failed(await root(ctx, ['hosts-add', ...names])),
});

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
            const written = await root(ctx, nginxArgs(ctx.config, vhost, domain, aliases, kind, vhost.rules, vhost.htaccessSums));
            return written.code === 0 ? root(ctx, ['hosts-add', ...names]) : written;
          });
        }
        return failed(r);
      },
    },
    hostsStep(ctx, names, 'apache'),
    check(ctx, domain),
  ];
}

/** nginx leaves the front of the site: its Apache vhost answers alone, as it did. */
function frontToApache(ctx: ServerSwitchContext, vhost: VhostInfo, domain: string, aliases: string[]): JobStep[] {
  const names = [domain, ...aliases];
  const front = vhost.front;
  return [
    {
      id: 'nginx',
      label: 'Take nginx out from in front of Apache',
      weight: 1,
      run: async (job) => {
        const r = await root(ctx, ['nginx-site-remove', domain]);
        if (r.code === 0) {
          job.onUndo('Put nginx in front of Apache again', async () => {
            const written = await root(ctx, frontArgs(domain, front?.static ?? true, front?.apachePaths ?? [], aliases));
            return written.code === 0 ? root(ctx, ['hosts-add', ...names]) : written;
          });
        }
        return failed(r);
      },
    },
    hostsStep(ctx, names, 'apache'),
    check(ctx, domain),
  ];
}

/** The site answers where its hosts line now points, without PHP source or a server error. */
function check(ctx: ServerSwitchContext, domain: string): JobStep {
  return { id: 'check', label: `Check ${domain} answers`, weight: 1, run: () => checkSite(ctx, { domain, host: domain }) };
}

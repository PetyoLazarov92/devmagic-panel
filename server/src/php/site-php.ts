import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, PhpIniKey, SitePhp } from '@devmagic-panel/shared';
import { PHP_INI_SETTINGS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { SiteActionRefused, type SiteRef } from '../sites/site-actions.js';
import { effectiveIni, phpDirectivesOutsideModPhp } from './fpm-check.js';
import { diffIni } from './ini.js';
import { PhpInfoUnavailable, webInfo, webInfoSettled } from './info.js';
import { poolFolder, sitePool, type SitePool } from './pools.js';
import { readPhpRequirements } from './requirements.js';
import { type LogMark, markLogs, trialRun } from './trial.js';
import { apachePhpVersion, fpmDefaultVersion, installedVersions, readPhpModules } from './versions.js';

/** Versions a site can run on: those with PHP-FPM installed. */
export const fpmVersions = (config: SystemConfig) => installedVersions(config).filter((v) => v.sapis.includes('fpm')).map((v) => v.version);

/** The version sites run without a pool of their own: mod_php's, else the default FPM one, else the newest with FPM. */
export const defaultPhpVersion = (config: SystemConfig): string | undefined => apachePhpVersion(config) ?? fpmDefaultVersion(config) ?? fpmVersions(config)[0];

export function readSitePhp(config: SystemConfig, site: SiteRef): SitePhp {
  const folder = poolFolder(config, site.docroot);
  const pool = folder ? sitePool(config, site.docroot) : undefined;
  const requires = readPhpRequirements(site.docroot);
  const defaultVersion = defaultPhpVersion(config);
  return {
    ...(pool ? { version: pool.version } : {}),
    ...(defaultVersion ? { defaultVersion } : {}),
    values: pool?.values ?? {},
    choices: fpmVersions(config),
    ...(requires ? { requires } : {}),
    ...(folder ? {} : { refused: `Only a site whose folder sits right in ${config.WEB_DIR} can have a PHP of its own; ${site.docroot} is elsewhere.` }),
  };
}

/** key=value arguments in the panel's order of settings. */
const pairs = (values: Partial<Record<string, string>>): string[] =>
  (Object.keys(PHP_INI_SETTINGS) as PhpIniKey[]).filter((k) => values[k] !== undefined).map((k) => `${k}=${values[k]}`);

/** What stops PHP-FPM of a version from serving a site the way mod_php of it does now. */
function fpmDiffers(config: SystemConfig, version: string): string[] {
  const base = join(config.PHP_CONF_DIR, version);
  const settings = diffIni(effectiveIni(join(base, 'apache2')), effectiveIni(join(base, 'fpm'))).map((d) => d.key);
  const modules = readPhpModules(config, version).filter((m) => m.apache2 !== undefined && m.fpm !== undefined && m.apache2 !== m.fpm).map((m) => m.name);
  return [...settings, ...modules];
}

export interface SitePhpContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  /** How often and how long apart to ask PHP-FPM again while it starts a pool; tests make it quick. */
  settle?: { tries?: number; delayMs?: number };
}

const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';

/** The site answers through PHP: a status under 500 and no PHP source in the page. */
export async function checkSite(ctx: SitePhpContext, site: Pick<SiteRef, 'host' | 'domain'>): Promise<ExecResult> {
  const url = `https://${site.host}/wp-login.php`;
  const { tries = 8, delayMs = 750 } = ctx.settle ?? {};
  let r: ExecResult;
  let status: number;
  // Right after a reload PHP-FPM may not answer yet (502 to 504): asked again a few times.
  for (let attempt = 1; ; attempt++) {
    r = await ctx.exec('curl', [
      '-sS', '--max-time', '30', '--noproxy', '*', '--cacert', join(ctx.config.CA_DIR, 'ca.pem'),
      '--resolve', `${site.domain}:443:127.0.0.1`, '-o', '-', '-w', '\n%{http_code}', url,
    ], { timeoutMs: 40_000 });
    status = Number(r.stdout.trim().split('\n').at(-1));
    if (r.code !== 0 || status < 502 || status > 504 || attempt >= tries) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (r.code !== 0) return { code: 1, stdout: '', stderr: `${url} did not answer: ${lastLine(r)}\n` };
  if (r.stdout.trimStart().startsWith('<?php')) return { code: 1, stdout: '', stderr: `${url} sent PHP source instead of running it\n` };
  if (!status || status >= 500) return { code: 1, stdout: '', stderr: `${url} answered with ${status || 'nothing'}: open its Logs tab for the error\n` };
  return { code: 0, stdout: `${url} answers (${status})`, stderr: '' };
}

/**
 * site.setPhp: the site runs on a version through its own pool, with its own
 * settings, or back on the PHP every site runs. Refused before anything runs
 * when FPM of that version is missing, when the site's .htaccess sets PHP
 * values only mod_php understands, or when FPM of mod_php's own version would
 * serve it differently from mod_php (Make PHP-FPM match Apache fixes that).
 */
export function planSitePhp(ctx: SitePhpContext, site: SiteRef, { version, values }: Pick<ActionInput<'site.setPhp'>, 'version' | 'values'>): JobStep[] {
  const { config } = ctx;
  const folder = poolFolder(config, site.docroot);
  if (!folder) throw new SiteActionRefused(`Only a site whose folder sits right in ${config.WEB_DIR} can have a PHP of its own; ${site.docroot} is elsewhere.`);
  const before: SitePool | undefined = sitePool(config, site.docroot);
  const removing = version === null && Object.keys(values).length === 0;
  if (removing && !before) throw new SiteActionRefused(`${site.host} already runs the PHP every site runs.`);
  const target = version ?? defaultPhpVersion(config);

  if (!removing) {
    if (!target) throw new SiteActionRefused('No PHP version has PHP-FPM installed, so the site cannot have a PHP of its own yet.');
    if (!fpmVersions(config).includes(target)) throw new SiteActionRefused(`PHP-FPM is not installed for PHP ${target}: install it on the PHP tab first.`);
    const htaccess = join(site.docroot, '.htaccess');
    if (existsSync(htaccess) && phpDirectivesOutsideModPhp(readFileSync(htaccess, 'utf8')) > 0) {
      throw new SiteActionRefused(`${site.host}'s .htaccess sets PHP values with php_value, which PHP-FPM answers with error 500. Move them to the site's PHP settings, or wrap them in <IfModule mod_php.c>, first.`);
    }
    if (target === apachePhpVersion(config)) {
      const differs = fpmDiffers(config, target);
      if (differs.length > 0) throw new SiteActionRefused(`PHP-FPM ${target} differs from Apache's PHP ${target} in ${differs.join(', ')}: use Make PHP-FPM match Apache on the PHP tab first.`);
    }
  }

  const put = (pool: { version: string; values: Partial<Record<PhpIniKey, string>> } | undefined) =>
    pool ? runRoot(ctx.exec, ctx.dmpRoot, ['php-pool-write', folder, pool.version, ...pairs(pool.values)]) : runRoot(ctx.exec, ctx.dmpRoot, ['php-pool-remove', folder]);
  const after = removing ? undefined : { version: target as string, values };
  // The site's logs as they were before the switch, for the trial run at the end.
  let marks: LogMark[] = [];

  const steps: JobStep[] = [
    {
      id: 'pool',
      label: after
        ? `Run ${site.host} on PHP ${after.version} through its own PHP-FPM pool${Object.keys(values).length > 0 ? `, with ${Object.keys(values).join(', ')}` : ''}`
        : `Put ${site.host} back on the PHP every site runs`,
      run: async (job) => {
        marks = markLogs(config, site);
        const r = await put(after);
        if (r.code === 0) job.onUndo(before ? `Put ${site.host} back on PHP ${before.version}${Object.keys(before.values).length ? ' with its settings' : ''}` : `Put ${site.host} back on the PHP every site runs`, () => put(before));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
  ];
  if (after) {
    steps.push({
      id: 'fpm',
      label: `Check the pool answers with PHP ${after.version}`,
      run: async () => {
        try {
          const info = await webInfoSettled(ctx.exec, config, ctx.dmpRoot, `dmp-${folder}/info.php`, ctx.settle);
          if (!info.version.startsWith(`${after.version}.`)) return { code: 1, stdout: '', stderr: `the pool answered with PHP ${info.version}, not ${after.version}\n` };
          return { code: 0, stdout: `the pool runs PHP ${info.version} (${info.sapi})`, stderr: '' };
        } catch (error) {
          if (error instanceof PhpInfoUnavailable) return { code: 1, stdout: '', stderr: `${error.message}\n` };
          throw error;
        }
      },
    });
  }
  steps.push({ id: 'site', label: `Check ${site.host} answers`, run: () => checkSite(ctx, site) });
  const runs = after?.version ?? defaultPhpVersion(config);
  steps.push({
    id: 'trial',
    label: `Open the home page and wp-admin${runs ? ` on PHP ${runs}` : ''} and read the new lines in its logs`,
    weight: 2,
    skippable: `Keep it on PHP ${runs ?? 'the new version'} anyway: the fatal errors stay until the code is fixed. Undo puts the old PHP back instead.`,
    run: () => trialRun(ctx, site, runs ?? '', marks, after?.version),
  });
  return steps;
}

/** php.matchFpm: FPM of a version gets mod_php's modules, settings and php.ini; Undo puts FPM's php.ini back. */
export function planMatchFpm(ctx: SitePhpContext, version: string): JobStep[] {
  if (!installedVersions(ctx.config).find((v) => v.version === version)?.sapis.includes('fpm')) throw new SiteActionRefused(`PHP-FPM is not installed for PHP ${version}.`);
  return [
    {
      id: 'match',
      label: `Give PHP-FPM ${version} the modules, settings and php.ini of Apache's PHP ${version}`,
      run: async (job) => {
        const r = await runRoot(ctx.exec, ctx.dmpRoot, ['php-fpm-match', version]);
        const saved = /^saved (\S+)$/m.exec(r.stdout)?.[1];
        if (r.code === 0 && saved) job.onUndo(`Put PHP-FPM ${version}'s own php.ini back`, () => runRoot(ctx.exec, ctx.dmpRoot, ['php-ini-put-back', version, 'fpm', saved]));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
  ];
}

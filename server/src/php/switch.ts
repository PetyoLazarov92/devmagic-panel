import type { ExecResult } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { SiteActionRefused } from '../sites/site-actions.js';
import { readSiteVhosts } from '../sites/vhost.js';
import { readFpmFindings } from './fpm-check.js';
import { checkSite, fpmVersions, type SitePhpContext } from './site-php.js';
import { apachePhpVersion, fpmDefaultVersion, modPhpVersions } from './versions.js';

/**
 * The last switch: mod_php off and every site without a PHP of its own on
 * one version through PHP-FPM (dmp-root php-switch-fpm), and the way back
 * (php-switch-modphp). Both jobs check every site afterwards: a site that
 * answers with an error or PHP source fails the job, and Undo switches back.
 */

const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
const root = (ctx: SitePhpContext, args: string[]) => ctx.exec('sudo', ['-n', ctx.dmpRoot, ...args], { timeoutMs: 180_000 });

/** Every site's address, root sites and the WordPress installs under paths. */
function addresses(ctx: SitePhpContext): Array<{ domain: string; host: string }> {
  return readSiteVhosts(ctx.config).flatMap((v) => {
    const domain = v.names[0] as string;
    return [{ domain, host: domain }, ...v.mounts.map((m) => ({ domain, host: `${domain}${m.path}` }))];
  });
}

/** Checks every site, all of them, and fails listing the ones that did not answer. */
function checkAllSites(ctx: SitePhpContext): JobStep {
  return {
    id: 'sites',
    label: 'Check every site answers',
    weight: 3,
    run: async () => {
      const results = await Promise.all(addresses(ctx).map(async (s) => ({ s, r: await checkSite(ctx, s) })));
      const failed = results.filter((x) => x.r.code !== 0);
      const report = results.map((x) => (x.r.code === 0 ? x.r.stdout : `${x.s.host}: ${x.r.stderr.trim()}`)).join('\n');
      return failed.length === 0
        ? { code: 0, stdout: `${results.length} site${results.length === 1 ? '' : 's'} answer\n${report}`, stderr: '' }
        : { code: 1, stdout: report, stderr: `${failed.length} of ${results.length} sites did not answer: ${failed.map((x) => x.s.host).join(', ')}. Undo switches back.\n` };
    },
  };
}

export function planSwitchToFpm(ctx: SitePhpContext, version: string): JobStep[] {
  const { config } = ctx;
  if (!fpmVersions(config).includes(version)) throw new SiteActionRefused(`PHP-FPM is not installed for PHP ${version}.`);
  const modphp = apachePhpVersion(config);
  const previous = fpmDefaultVersion(config);
  if (!modphp && previous === version) throw new SiteActionRefused(`Every site without a PHP of its own already runs on PHP ${version} through PHP-FPM.`);
  const blocking = readFpmFindings(config).filter(
    (f) => f.status === 'warn' && (f.id === 'apache-php-value' || f.id === 'htaccess-php-value' || ((f.id === 'ini-differs' || f.id === 'modules-differ') && f.version === version && version === modphp)),
  );
  if (blocking.length > 0) throw new SiteActionRefused(`Not yet: ${blocking.map((f) => `${f.text}${f.files?.length ? ` (${f.files.slice(0, 5).join(', ')}${f.files.length > 5 ? ', ...' : ''})` : ''}`).join(' ')}`);
  return [
    {
      id: 'switch',
      label: modphp ? `Turn mod_php ${modphp} off and run every site without a PHP of its own on PHP ${version} through PHP-FPM` : `Run every site without a PHP of its own on PHP ${version}`,
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, ['php-switch-fpm', version]);
        if (r.code === 0) {
          job.onUndo(modphp ? `Turn mod_php ${modphp} back on` : `Put sites back on PHP ${previous}`, () => root(ctx, modphp ? ['php-switch-modphp', modphp] : ['php-switch-fpm', previous as string]));
        }
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
    checkAllSites(ctx),
  ];
}

export function planSwitchToModPhp(ctx: SitePhpContext, version: string): JobStep[] {
  const { config } = ctx;
  if (apachePhpVersion(config)) throw new SiteActionRefused(`Apache runs mod_php ${apachePhpVersion(config)} already.`);
  if (!modPhpVersions(config).includes(version)) throw new SiteActionRefused(`mod_php is not installed for PHP ${version}: apt install libapache2-mod-php${version}`);
  const previous = fpmDefaultVersion(config);
  return [
    {
      id: 'switch',
      label: `Turn mod_php ${version} back on for every site without a PHP of its own`,
      weight: 2,
      run: async (job) => {
        const r = await root(ctx, ['php-switch-modphp', version]);
        if (r.code === 0 && previous) job.onUndo(`Run sites on PHP ${previous} through PHP-FPM again`, () => root(ctx, ['php-switch-fpm', previous]));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    },
    checkAllSites(ctx),
  ];
}

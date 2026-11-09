import type { ActionInput, AddressInput, RunStep } from '@devmagic-panel/shared';
import { addressSummary, mountFolder, repoTarget } from '@devmagic-panel/shared';

export type CreateSiteInput = ActionInput<'site.create'>;

export { PRODUCTION_ONLY_PLUGINS } from '@devmagic-panel/shared';

/**
 * A preview of the steps the server will run, for the review screen. The
 * server builds the real list; this mirrors server/src/sites/create.ts.
 */
export function previewSteps(input: CreateSiteInput, dbName: string, dumpName?: string, cores?: string[], addresses?: AddressInput): RunStep[] {
  const isWp = input.source !== 'empty';
  // Every address in one step, none when the dump already answers here; without the dump's facts, every host gets its https pass.
  const replace = addressSummary(addresses ?? { hosts: input.replace, moves: [], locals: [input.domain, ...input.aliases], httpHosts: undefined }, input.network?.layout);
  const names = 1 + input.aliases.length;
  // A site under a path: its own folder, served by its parent's vhost, which already has the certificate and hosts line.
  const under = input.path ? mountFolder(input.domain, input.path) : null;
  const hasRepos = input.repos.length > 0;
  // Cloned in the server's order: the site root first, then by depth.
  const depth = (t: string) => (t ? t.split('/').length : 0);
  const clones = input.repos
    .map((r, i) => ({ r, i }))
    .sort((a, b) => depth(repoTarget(a.r)) - depth(repoTarget(b.r)) || a.i - b.i)
    .map(({ r, i }): [string, string, boolean] => [i === 0 ? 'clone' : `clone-${i + 1}`, `Clone ${r.url} (${r.branch}) into ${repoTarget(r) || 'the site root'}`, true]);
  const version = input.core?.version ?? '';
  const s: Array<[string, string, boolean]> = [
    ['space', 'Check free disk space', hasRepos || Boolean(input.uploadId)],
    ['folder', `Create /var/www/${under ?? input.domain}`, true],
    ...clones,
    ['content', 'Prepare wp-content', isWp],
    ['addcore', `Add WordPress ${version} to the shared cores`, isWp && input.core?.mode === 'wpcore' && cores !== undefined && !cores.includes(version)],
    ['core', input.core?.mode === 'wpcore' ? `Link WordPress ${version} with wpcore` : input.core?.mode === 'repo' ? "Use the repo's own WordPress" : `Download WordPress ${version}`, isWp],
    ['mount', `Serve it at https://${input.domain}${input.path ?? ''}/`, Boolean(under)],
    ['cert', `Issue a certificate for ${names} name${names > 1 ? 's' : ''}`, !under],
    ['vhost', `Write the ${input.server === 'nginx' ? 'nginx site' : 'Apache vhost'} and reload${input.uploadsFrom && input.uploadsVia === 'redirect' ? ` (missing uploads from ${input.uploadsFrom})` : ''}`, !under],
    ['front', 'Put nginx in front of the Apache vhost and reload', !under && input.server === 'nginx-apache'],
    ['hosts', 'Add the /etc/hosts entry', !under],
    ['db', `Create database ${dbName} and its user`, isWp],
    ['config', 'Write wp-config.php', isWp],
    ['import', `Import ${dumpName ?? 'the database dump'}`, Boolean(input.uploadId)],
    ['replace', replace ?? '', Boolean(input.uploadId) && replace !== null],
    ['install', 'Install WordPress', input.source === 'wordpress' || (input.source === 'repo' && !input.uploadId)],
    ['plugins', `Deactivate ${input.deactivate.length} production-only plugin${input.deactivate.length === 1 ? '' : 's'} when active`, Boolean(input.uploadId) && input.deactivate.length > 0],
    [
      'admin',
      input.admin?.ifExists === 'keep' ? `Add ${input.admin.user} unless the database has it` : `Make sure ${input.admin?.user ?? ''} is an administrator`,
      input.source === 'repo' && Boolean(input.uploadId) && Boolean(input.admin) && !(input.admin?.ifExists === 'keep' && input.admin.ifMissing === 'skip'),
    ],
    ['helpers', `Turn on ${input.activate.join(', ')}`, isWp && input.activate.length > 0],
    ['media', `Load missing uploads from ${input.uploadsFrom ?? ''} with BE Media from Production`, isWp && input.uploadsVia === 'plugin' && Boolean(input.uploadsFrom)],
    ['build', input.builds && input.builds.length > 1 ? `Run ${input.builds.length} builds` : 'Run the build', hasRepos && (input.builds ? input.builds.length > 0 : input.build.composer || input.build.npm)],
    ['htaccess', 'Write .htaccess when the site has none', isWp],
    ['local', 'Turn on Local mode (mail to Mailpit, noindex)', isWp],
    ['flush', 'Flush caches and rewrite rules', isWp],
  ];
  return s.filter(([, , on]) => on).map(([id, label]) => ({ id, label, status: 'pending' }));
}

import type { ActionInput, ProductionSettings } from '@devmagic-panel/shared';
import { isLocalName, localDomainFor, productionSettings } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobStep } from '../jobs.js';
import type { RunStore } from '../store.js';
import { type CleanContext, planCleanCopy } from './clean.js';
import { DbRefused, planImport, wordpressSite } from './db.js';
import { slugOf } from './install-plugins.js';
import { scanMissing } from './missing-scan.js';
import { type MoreDumpsContext, planServerDump } from './more-dumps.js';
import type { SiteRef } from './site-actions.js';
import { readUpload } from './uploads.js';

/**
 * Refresh from production: the copy settings saved for a site (no secret),
 * and the job that uses them. The job exports over SSH as dump.fromServer
 * does, reading only, then hands the dump to the same steps as an import as
 * it is or, with clean on, a cleaned one. Nothing is written on
 * production.
 */

export type RefreshContext = CleanContext & MoreDumpsContext & { store: RunStore };

const key = (domain: string, path?: string) => `production:${domain}${path ?? ''}`;

/** The settings saved for a site, or null until it is set up. */
export function readProduction(store: RunStore, domain: string, path?: string): ProductionSettings | null {
  const raw = store.getMeta(key(domain, path));
  if (!raw) return null;
  try {
    const parsed = productionSettings.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveProduction(store: RunStore, domain: string, path: string | undefined, settings: ProductionSettings): ProductionSettings {
  store.setMeta(key(domain, path), JSON.stringify(settings));
  // The next export from that server and folder starts with the same tables left out.
  store.setMeta(`server-export:${settings.host}|${settings.folder}`, JSON.stringify(settings.excludeRows));
  return settings;
}

/** Every production host of the dump to the site's name for it: the local name it would get when the site serves that, else its main domain. */
export function replaceFor(hosts: readonly string[], site: Pick<SiteRef, 'domain' | 'names'>): Array<{ from: string; to: string }> {
  return hosts.filter((h) => !isLocalName(h)).map((from) => {
    const local = localDomainFor(from);
    return { from, to: site.names.includes(local) ? local : site.domain };
  });
}

const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

export function planRefresh(ctx: RefreshContext, input: ActionInput<'site.refreshFromProduction'>, onUpload: (id: string) => void): JobStep[] {
  const settings = readProduction(ctx.store, input.domain, input.path);
  if (!settings) throw new DbRefused('Refresh from production is not set up for this site: save the server and folder first');
  const { site } = wordpressSite(ctx, input.domain, input.path);
  let uploadId: string | null = null;
  const exporting = planServerDump(ctx, { host: settings.host, mode: 'export', path: settings.folder, excludeRows: settings.excludeRows, ...(settings.wpCli ? { wpCli: settings.wpCli } : {}), ...(input.password ? { password: input.password } : {}) }, (id) => {
    uploadId = id;
    onUpload(id);
  });
  // The import's own steps, planned once the dump is in; a Retry goes on from the one that failed.
  let inner: JobStep[] | null = null;
  let next = 0;
  const copy: JobStep = {
    id: 'copy',
    label: settings.clean ? 'Clean it in a side database and swap it in' : 'Import it and swap it in',
    weight: 10,
    run: async (job) => {
      if (!uploadId) return fail('the export brought no dump');
      if (!inner) {
        const upload = readUpload(ctx.uploadsDir, uploadId);
        if (!upload) return fail('the exported dump is gone; run the refresh again');
        const replace = replaceFor(upload.facts.hosts, site);
        try {
          inner = settings.clean
            ? planCleanCopy(ctx, { domain: input.domain, ...(input.path ? { path: input.path } : {}), uploadId, replace, replaceBare: false, user: input.user, confirm: input.confirm })
            : planImport(ctx, { domain: input.domain, ...(input.path ? { path: input.path } : {}), uploadId, replace, replaceBare: false, confirm: input.confirm });
        } catch (error) {
          if (error instanceof DbRefused) return fail(error.message);
          throw error;
        }
      }
      const results: ExecResult[] = [];
      for (; next < inner.length; next++) {
        const step = inner[next] as JobStep;
        job.activity?.(step.label);
        const out = await step.run(job);
        const list = Array.isArray(out) ? out : [out];
        if (list.some((r) => r.code !== 0)) {
          if (!step.skippable) return [...results, ...list];
          results.push({ code: 0, stdout: `warn: ${step.label} did not work: ${step.skippable}`, stderr: '' });
          continue;
        }
        results.push(...list);
      }
      return results;
    },
  };
  // The new database may name plugins and themes these files never had: said here, offered on the Plugins tab, never fetched on its own.
  const missing: JobStep = {
    id: 'missing',
    label: 'Look for plugins and themes the new database names that the files lack',
    skippable: 'The check for missing plugins and themes did not run: the Plugins tab shows them.',
    run: async () => {
      const { plugins, themes } = await scanMissing(ctx.exec, site);
      if (plugins.length + themes.length === 0) return ok('the files have every plugin and theme the new database names');
      const names = [...themes.map((t) => `${t.name} (theme)`), ...plugins.filter((p) => p.active).map((p) => slugOf(p))];
      const parts = [plugins.length ? `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}` : '', themes.length ? `${themes.length} theme${themes.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      return ok(`warn: the new database names ${parts} the files lack${names.length ? ` (${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''})` : ''}: install or copy them on the Plugins tab, under the missing row. Nothing was installed or copied`);
    },
  };
  return [...exporting, copy, missing];
}

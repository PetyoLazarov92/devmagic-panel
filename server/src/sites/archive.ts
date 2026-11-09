import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveReason } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { planRemove, removalRefusal, removalStamp, type RemoveContext, RemoveRefused } from './remove.js';
import { planTrashRestore, type TrashContext } from './trash.js';
import { readSiteVhosts } from './vhost.js';
import { parseWpConfig } from './wpconfig.js';

/** The site at a domain that something new would replace, and whether the panel can archive it first. */
export interface CurrentSite {
  /** Why the panel cannot archive it, or null when it can. */
  refusal: string | null;
  /** Its database, from its wp-config.php. */
  dbName?: string;
  /** Its database user, from its wp-config.php. */
  dbUser?: string;
}

/** The site at domain now: its vhost, or its folder; null when there is none. */
export function currentSite(ctx: Pick<RemoveContext, 'config'>, domain: string): CurrentSite | null {
  const vhost = readSiteVhosts(ctx.config).find((v) => v.names[0] === domain);
  const folder = join(ctx.config.WEB_DIR, domain);
  if (!vhost && !existsSync(folder)) return null;
  if (!vhost?.docroot) return { refusal: `${folder} exists without a vhost of its own; remove it by hand` };
  const configFile = join(vhost.docroot, 'wp-config.php');
  const { dbName, dbUser } = existsSync(configFile) ? parseWpConfig(readFileSync(configFile, 'utf8')) : {};
  return { refusal: removalRefusal(ctx.config, domain, vhost.docroot, vhost.file), ...(dbName ? { dbName } : {}), ...(dbUser ? { dbUser } : {}) };
}

/** A runtime for steps run inside another step's undo: they register nothing more and report no progress. */
const quiet: JobRuntime = { onUndo: () => undefined, progress: () => undefined };

/**
 * Steps that move the site at domain to the archive before a reinstall or a
 * restore takes its place: its database is exported and dropped, its files
 * archived and removed, as for Remove. Once it is gone, Undo puts it back
 * from that archive, after whatever took its place and is still there went to
 * the archive too, so a failed or unwanted install or restore can be taken
 * back whole.
 */
export function archiveSteps(ctx: RemoveContext & TrashContext, domain: string, reason: Extract<ArchiveReason, 'reinstall' | 'restore'>, stamp = removalStamp()): JobStep[] {
  const current = currentSite(ctx, domain);
  if (!current) return [];
  if (current.refusal) throw new RemoveRefused(current.refusal);
  const id = `${domain}-${stamp}`;
  return planRemove(ctx, { domain }, stamp, reason).map((step) =>
    step.id !== 'remove'
      ? { ...step, id: `archive-${step.id}` }
      : {
          ...step,
          id: 'archive-remove',
          run: async (job) => {
            const r = await step.run(job);
            if (Array.isArray(r) ? r.every((x) => x.code === 0) : r.code === 0) {
              job.onUndo(`Put ${domain} back from the archive`, async () => {
                const results: ExecResult[] = [];
                const run = async (steps: JobStep[]) => {
                  for (const back of steps) {
                    const out = await back.run(quiet);
                    const list = Array.isArray(out) ? out : [out];
                    results.push(...list);
                    if (list.some((x) => x.code !== 0)) return false;
                  }
                  return true;
                };
                // What took its place and is still there, like a restored copy, goes to the archive first, so nothing is lost.
                const now = currentSite(ctx, domain);
                if (now?.refusal) return [{ code: 1, stdout: '', stderr: `cannot put ${domain} back: ${now.refusal}` }];
                const again = removalStamp() === stamp ? removalStamp(new Date(Date.now() + 1000)) : removalStamp();
                if (now && !(await run(planRemove(ctx, { domain }, again, reason)))) return results;
                if (!(await run(await planTrashRestore(ctx, { id }, now?.dbName ? { replacingDb: now.dbName } : {})))) return results;
                // Back as it was: how it had been installed comes back too.
                const before = ctx.store?.archivedInstall(id);
                if (before) ctx.store?.setInstall(domain, undefined, before);
                ctx.store?.restoreArchiveMeta(id);
                ctx.store?.forgetArchive(id);
                return results;
              });
            }
            return r;
          },
        },
  );
}

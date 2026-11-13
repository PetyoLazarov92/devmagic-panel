import type { StorageCleanKind } from '@devmagic-panel/shared';
import { dirname } from 'node:path';
import type { ActionContext } from './actions.js';
import type { ExecResult } from './exec.js';
import { mysqlBackupsDir, pruneMysqlBackups } from './mysql-server.js';
import { pruneAutoSnapshots } from './panel-storage.js';
import { fileTrashDir, pruneFileTrash } from './sites/file-changes.js';
import { purgeKept } from './sites/kept.js';
import { pruneUploads } from './sites/uploads.js';

/**
 * Clean up now on the Sanctum page: everything of one kind goes now, not
 * when its time is over, through the same removals the background tasks
 * use with no age left to wait. What a job or a draft still uses stays, and
 * so do the snapshots you took yourself. The background tasks still remove
 * only what is past its time.
 */

/** Long enough after any file's time that every one counts as past it. */
const EVERYTHING = Number.MAX_SAFE_INTEGER;

export async function cleanStorage(ctx: Pick<ActionContext, 'config' | 'exec' | 'store' | 'jobs' | 'uploadsDir' | 'secrets' | 'drafts'>, kind: StorageCleanKind): Promise<ExecResult> {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const dataDir = dirname(ctx.uploadsDir);
  switch (kind) {
    case 'snapshots': {
      const gone = pruneAutoSnapshots(ctx.config.BACKUP_DIR, EVERYTHING, 0, 0);
      return ok(`removed ${count(gone.length, 'automatic snapshot')}; the ones you took stay`);
    }
    case 'downloads': {
      const inUse = new Set([...ctx.jobs.uploadsInUse(), ...(ctx.drafts?.uploadsInUse() ?? [])]);
      const gone = pruneUploads(ctx.uploadsDir, 0, inUse, EVERYTHING);
      return ok(`removed ${count(gone.length, 'downloaded dump')}${inUse.size ? `; ${count(inUse.size, 'dump')} a job or a draft uses stay` : ''}`);
    }
    case 'file-trash':
      return ok(`removed ${count(pruneFileTrash(fileTrashDir(dataDir), EVERYTHING).length, 'Files tab delete')}`);
    case 'mysql-backups':
      return ok(`removed ${count(pruneMysqlBackups(mysqlBackupsDir(ctx.uploadsDir), EVERYTHING).length, 'MySQL settings backup')}`);
    case 'kept': {
      const mysql = ctx.secrets?.mysql;
      if (!mysql) return { code: 1, stdout: '', stderr: 'the panel has no MySQL admin account to drop them with: add one on the Services page, MySQL tab' };
      const busy = (site: string) => ctx.jobs.busyFor(site.replaceAll('@', '/')) !== undefined;
      try {
        const dropped = await purgeKept(ctx.store, ctx.exec, mysql, busy, EVERYTHING);
        const left = ctx.store.keptDatabases().length;
        return ok(`${dropped.length ? `dropped ${dropped.join(', ')}` : 'dropped none'}${left ? `; ${count(left, 'kept database')} of a site a job works on stay` : ''}`);
      } catch (error) {
        return { code: 1, stdout: '', stderr: (error as Error).message };
      }
    }
    case 'runs':
      return ok(`deleted ${count(ctx.store.clearRuns(), 'finished run')}`);
  }
}

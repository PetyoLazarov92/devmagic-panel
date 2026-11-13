import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PanelStorage, StorageRow } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { Executor } from './exec.js';

/**
 * What the panel keeps on disk, measured for the Sanctum page: each kind with
 * its size, how long it stays and what Clean up now removes. Sizes come from
 * one `du` over the folders the panel itself owns; root's trash folder is
 * summed from the sizes its archives record. Only sizes and counts: no file
 * is read.
 */

export interface StorageContext {
  config: Pick<SystemConfig, 'BACKUP_DIR'>;
  exec: Executor;
  dataDir: string;
  uploadsDir: string;
  logsDir: string;
  /** The deleted sites' sizes, as their archives record them. */
  trashBytes: () => Promise<number | null>;
  /** How many databases are kept in MySQL, and when the oldest goes. */
  keptDatabases: () => { count: number; note: string; items: NonNullable<StorageRow['items']> };
}

/** Snapshots the panel takes itself before a change: "<stamp>-before-import.sql.gz". */
const AUTO_SNAPSHOT = /^\d{8}-\d{6}-before-[a-z-]+\.sql\.gz$/;
/** Of those, the newest this many per site always stay. */
export const AUTO_SNAPSHOTS_KEPT = 3;
/** And every one this new stays. */
export const AUTO_SNAPSHOT_DAYS = 30;

/** Bytes on disk of each path, from one du; a path that is not there counts 0. */
async function diskBytes(exec: Executor, paths: string[]): Promise<Map<string, number>> {
  const there = paths.filter((p) => existsSync(p));
  const sizes = new Map<string, number>(paths.map((p) => [p, 0]));
  if (there.length === 0) return sizes;
  // Unreadable entries make du end with 1 and still print the totals it could read. -l: a folder inside another listed one still counts in full.
  const r = await exec('du', ['-s', '-l', '-B1', '--', ...there], { timeoutMs: 120_000 });
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) sizes.set(m[2] as string, Number(m[1]));
  }
  return sizes;
}

export async function panelStorage(ctx: StorageContext, now = new Date()): Promise<PanelStorage> {
  const backup = ctx.config.BACKUP_DIR;
  const d = (name: string) => join(ctx.dataDir, name);
  const groups: Array<Omit<StorageRow, 'bytes'> & { paths: string[] }> = [
    { id: 'snapshots', label: 'Database snapshots', what: 'Copies of a site\'s database: yours, and the ones the panel takes before an import, a restore, a search and replace or updates.', kept: `Yours until you delete them. The panel's own: the newest ${AUTO_SNAPSHOTS_KEPT} per site and every one from the last ${AUTO_SNAPSHOT_DAYS} days`, clean: { kind: 'snapshots', goes: 'Every snapshot the panel took before a change. The ones you took stay.' }, paths: [join(backup, 'snapshots')], where: [join(backup, 'snapshots')] },
    { id: 'clean', label: 'Clean copies', what: 'Databases exported without personal data, to share.', kept: 'Until you delete them', manage: { note: 'Delete one on its site\'s Database tab, under Backups and tools', label: 'Sites', href: '/sites' }, paths: [join(backup, 'clean')], where: [join(backup, 'clean')] },
    { id: 'undo', label: 'Backups for Undo', what: 'What a change replaced: config files before a root change, clean-ups, row edits, crontabs and removed sites\' extras.', kept: 'Clean-ups and row edits 14 days; the backups dmp-restore restores a change from stay until you remove them', paths: [backup], where: [backup] },
    { id: 'downloads', label: 'Downloaded dumps', what: 'Database dumps you uploaded or the panel downloaded, and files staged for the Files tab.', kept: 'A day, unless a job or a draft still uses one', clean: { kind: 'downloads', goes: 'Every downloaded dump, except one a job or a draft still uses.' }, paths: [ctx.uploadsDir, d('file-uploads')], where: [ctx.uploadsDir, d('file-uploads')] },
    { id: 'file-trash', label: 'Files tab deletes', what: 'Files and folders deleted in the Files tab, for Undo.', kept: '14 days, 1 GB at most', clean: { kind: 'file-trash', goes: 'Every file and folder deleted in the Files tab, and with them their Undo.' }, paths: [d('file-trash')], where: [d('file-trash')] },
    { id: 'mysql-backups', label: 'MySQL settings backups', what: 'MySQL\'s settings before the panel changed them.', kept: '14 days', clean: { kind: 'mysql-backups', goes: "Every backup of MySQL's settings." }, paths: [join(dirname(ctx.uploadsDir), 'mysql-backups')], where: [join(dirname(ctx.uploadsDir), 'mysql-backups')] },
    { id: 'releases', label: 'Panel versions', what: 'The running version of the panel and the ones before it, to switch back to.', kept: 'Three in all', manage: { note: 'Each update removes the oldest', label: 'Updates', href: '/update' }, paths: [d('releases'), d('node')], where: [d('releases')] },
    { id: 'tools', label: 'Mailpit and tools', what: 'Mailpit with the mail it caught, and tools the panel downloaded, like the PHP compatibility check.', kept: 'Until you remove Mailpit; mail as Mailpit keeps it', manage: { note: 'Delete caught mail in Mail', label: 'Mail', href: '/mail' }, paths: [d('mailpit'), d('tools')], where: [d('mailpit'), d('tools')] },
    { id: 'panel', label: 'Run history and logs', what: 'The panel\'s database (Run history, drafts, settings) and its logs.', kept: 'Runs 90 days, 2000 at most', clean: { kind: 'runs', goes: 'Every finished run in Run history. Runs still going and the logs stay.' }, paths: [d('panel.db'), d('panel.db-wal'), d('panel.db-shm'), d('profiles'), ctx.logsDir], where: [d('panel.db'), ctx.logsDir] },
  ];
  const sizes = await diskBytes(ctx.exec, groups.flatMap((g) => g.paths));
  const rows: StorageRow[] = groups.map(({ paths, ...g }) => ({ ...g, bytes: paths.reduce((sum, p) => sum + (sizes.get(p) ?? 0), 0) }));
  // The backups folder holds the snapshots and clean copies too: Undo's row is the rest of it.
  const undo = rows.find((r) => r.id === 'undo');
  if (undo) undo.bytes = Math.max(0, (undo.bytes ?? 0) - (sizes.get(join(backup, 'snapshots')) ?? 0) - (sizes.get(join(backup, 'clean')) ?? 0));
  const trash = await ctx.trashBytes().catch(() => null);
  rows.splice(3, 0, { id: 'trash', label: 'Deleted sites', what: 'Sites you deleted or replaced, archived with their files, config and database, to restore.', bytes: trash, kept: '14 days', manage: { note: 'Delete one sooner in Removed sites', label: 'Removed sites', href: '/sites?show=removed' }, where: ['$STATE_DIR/trash (root)'] });
  const kept = ctx.keptDatabases();
  rows.push({ id: 'kept', label: 'Kept databases', what: 'A site\'s database as it was before a swap or a refresh, kept in MySQL to switch back.', bytes: null, count: kept.count, items: kept.items, kept: kept.note ? `7 days (${kept.note.replace(/^\d+ kept, /, '')})` : '7 days', clean: { kind: 'kept', goes: 'Every kept database, except one of a site a job works on. You can no longer switch back to them.' }, where: ['MySQL'] });
  return { measuredAt: now.toISOString(), rows, totalBytes: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0) };
}

/**
 * Removes the snapshots the panel took itself before a change once they are
 * past their time: per site, all but the newest AUTO_SNAPSHOTS_KEPT that are
 * older than AUTO_SNAPSHOT_DAYS. Snapshots you took (any other name) are
 * never touched. Returns the paths removed.
 */
export function pruneAutoSnapshots(backupDir: string, now = Date.now(), keep = AUTO_SNAPSHOTS_KEPT, days = AUTO_SNAPSHOT_DAYS): string[] {
  const root = join(backupDir, 'snapshots');
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const site of readdirSync(root, { withFileTypes: true })) {
    if (!site.isDirectory()) continue;
    const dir = join(root, site.name);
    const auto = readdirSync(dir)
      .filter((n) => AUTO_SNAPSHOT.test(n))
      .map((n) => ({ path: join(dir, n), at: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const s of auto.slice(keep)) {
      if (now - s.at < days * 86_400_000) continue;
      rmSync(s.path, { force: true });
      removed.push(s.path);
    }
  }
  return removed;
}

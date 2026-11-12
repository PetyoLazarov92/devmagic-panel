import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecResult, Executor } from '../exec.js';
import { keepReplaced, restoreEntries } from './file-changes.js';
import type { FilesContext } from './files.js';
import { ownUpgradeFolder } from './install-plugins.js';

/**
 * Updates a site's plugins and themes to the version WordPress already found,
 * from WordPress.org through WP-CLI, as you: one at a time, a failure noted
 * and put back, never the end of the run. Before each, its folder is copied
 * into the Files tab's file trash (keepReplaced), so Undo, and the Files tab,
 * put the version from before back. A plugin is checked against WordPress.org's
 * checksums after, and put back when it does not match. Only real folders in
 * wp-content/plugins and wp-content/themes: never a link, a one-file plugin,
 * a must-use plugin or a drop-in. One in a git repo is updated too, and the
 * result says to commit it there.
 */

export type UpdateKind = 'plugin' | 'theme';

export interface UpdateDeps {
  exec: Executor;
  docroot: string;
  host: string;
  /** The file trash folder and the site's key in it. */
  trash: string;
  site: string;
  files: FilesContext;
}

export interface Updated {
  folder: string;
  /** The file trash entry with the version from before. */
  entry: string;
}

export interface UpdateOutcome {
  results: ExecResult[];
  updated: Updated[];
  failed: string[];
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1)?.replace(/^(Error|Warning):\s*/, '') ?? `exit ${r.code}`;
/** What verify-checksums says when a file differs, is missing or was added: anything but "no checksums for this version". */
const MISMATCH = /doesn't verify against checksum|File is missing|File was added|Plugin doesn't verify/i;

export async function updateItems(deps: UpdateDeps, kind: UpdateKind, slugs: readonly string[]): Promise<UpdateOutcome> {
  const where = kind === 'plugin' ? 'plugins' : 'themes';
  const wp = (args: string[]) => deps.exec('wp', [`--path=${deps.docroot}`, `--url=https://${deps.host}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs: 10 * 60_000 });
  const version = async (slug: string) => {
    const r = await wp([kind, 'get', slug, '--field=version']);
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const results: ExecResult[] = [];
  const updated: Updated[] = [];
  const failed: string[] = [];
  const upgrade = slugs.length ? ownUpgradeFolder(deps.docroot) : { restore: () => undefined };
  if (upgrade.note) results.push(ok(upgrade.note));

  /** Puts the version from before back in place of what is there now. */
  const putBack = async (folder: string, entry: string) => {
    rmSync(folder, { recursive: true, force: true });
    await restoreEntries(deps.files, deps.trash, deps.site, entry);
  };

  try {
    for (const slug of slugs) {
      const name = kind === 'plugin' ? slug : `the theme ${slug}`;
      const folder = join(deps.docroot, 'wp-content', where, slug);
      const stat = lstatSync(folder, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory()) {
        results.push(ok(`${name}: ${stat?.isSymbolicLink() ? `wp-content/${where}/${slug} is a link: update it where it points` : `no folder wp-content/${where}/${slug}: update it where it is kept`}; left as it is`));
        continue;
      }
      const before = await version(slug);
      const tracked = await deps.exec('git', ['-C', folder, 'ls-files', '--', '.'], { timeoutMs: 30_000 });
      const kept = await keepReplaced(deps.trash, deps.site, `wp-content/${where}`, async (backup) => {
        cpSync(folder, join(backup, slug), { recursive: true, verbatimSymlinks: true });
      });
      const r = await wp([kind, 'update', slug]);
      const after = await version(slug);
      if (r.code !== 0 || !existsSync(folder) || !after) {
        failed.push(slug);
        if (kept) await putBack(folder, kept.id);
        results.push(ok(`warn: ${name} was not updated: ${lastLine(r)}${kept ? `; ${before || 'the version from before'} is back` : ''}`));
        continue;
      }
      if (after === before) {
        // Nothing changed: the copy is not needed.
        if (kept) rmSync(join(deps.trash, kept.id), { recursive: true, force: true });
        results.push(ok(`${name}: already at ${after}`));
        continue;
      }
      if (kind === 'plugin') {
        const check = await wp(['plugin', 'verify-checksums', slug]);
        if (check.code !== 0 && MISMATCH.test(`${check.stdout}\n${check.stderr}`)) {
          failed.push(slug);
          if (kept) await putBack(folder, kept.id);
          results.push(ok(`warn: ${slug} ${after} did not match WordPress.org's checksums, so ${before} is back`));
          continue;
        }
      }
      if (kept) updated.push({ folder, entry: kept.id });
      const inRepo = tracked.code === 0 && tracked.stdout.trim() !== '';
      results.push(ok(`${name}: ${before} to ${after}${inRepo ? '; it is in a git repo, so commit the update there' : ''}`));
    }
  } finally {
    upgrade.restore();
  }
  const noun = kind === 'plugin' ? 'plugin' : 'theme';
  const done = slugs.length - failed.length;
  results.push(ok(failed.length ? `updated ${done} of ${slugs.length} ${noun}s; not updated: ${failed.join(', ')}` : `updated ${done} ${noun}${done === 1 ? '' : 's'}`));
  return { results, updated, failed };
}

/** Undo: the versions from before back, the last updated first. */
export async function undoUpdates(deps: Pick<UpdateDeps, 'trash' | 'site' | 'files'>, updated: readonly Updated[]): Promise<ExecResult> {
  for (const u of [...updated].reverse()) {
    rmSync(u.folder, { recursive: true, force: true });
    await restoreEntries(deps.files, deps.trash, deps.site, u.entry);
  }
  return ok(`put back the version from before of ${updated.length} folder${updated.length === 1 ? '' : 's'}`);
}

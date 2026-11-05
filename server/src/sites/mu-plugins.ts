import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ExecResult, Executor } from '../exec.js';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

export const muPluginPath = (docroot: string, fileName: string) => join(docroot, 'wp-content', 'mu-plugins', fileName);

/**
 * Writes one of the panel's mu-plugins and lists it in the repo's local
 * `.git/info/exclude` (never `.gitignore`), so it never travels to production.
 */
export async function installMuPlugin(exec: Executor, docroot: string, fileName: string, content: string, comment: string): Promise<ExecResult> {
  const file = muPluginPath(docroot, fileName);
  const dir = join(file, '..');
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content, { mode: 0o644 });
  } catch (error) {
    return failed(`could not write ${file}: ${(error as Error).message}`);
  }
  await excludeLocally(exec, file, comment);
  return ok(`${fileName} ready in ${dir}`);
}

/**
 * Lists a file the panel added in its repo's local `.git/info/exclude`, so it
 * never shows in `git status` or gets committed. Does nothing outside a repo.
 */
export async function excludeLocally(exec: Executor, file: string, comment: string): Promise<void> {
  const top = await exec('git', ['-C', dirname(file), 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) return;
  const root = top.stdout.trim();
  const excludePath = await exec('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude']);
  if (excludePath.code !== 0) return;
  const gitPath = excludePath.stdout.trim();
  const exclude = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
  const line = `/${relative(root, file)}`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# ${comment}\n${line}\n`);
}

/** Deletes one of the panel's mu-plugins; the exclude line stays, it is harmless. */
export function removeMuPlugin(docroot: string, fileName: string): ExecResult {
  const file = muPluginPath(docroot, fileName);
  if (!existsSync(file)) return ok(`${fileName} is not installed`);
  try {
    rmSync(file);
    return ok(`removed ${file}`);
  } catch (error) {
    return failed(`could not remove ${file}: ${(error as Error).message}`);
  }
}

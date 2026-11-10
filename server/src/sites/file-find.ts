import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { FILE_DIFF_MAX, FILE_FIND_MAX, type FileDiff, type FileFindResult, type FileGitState, type FileGitStatus, type FileMatch, joinPath, nameOf } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { FileRefused, type FilesContext, locate } from './files.js';

/**
 * What the Files tab reads on top of a folder and a file: a search under a
 * folder by name or by text, what git says changed, and a diff. All of it
 * only reads, as you, in the site's folder, and every program gets its
 * arguments as a list. A diff holds the file's text: it goes to the browser
 * only.
 */

/** Folders a search never goes into. */
const SKIPPED = ['.git', 'node_modules'];
/** A search by name gives up after this many entries. */
const VISIT_MAX = 100_000;
const LINE_MAX = 240;

/** What to look for: a few plain characters, no line breaks. */
export function findQuery(q: unknown): string {
  if (typeof q !== 'string' || q.trim().length < 2 || q.length > 200 || /[\u0000-\u001f\u007f]/.test(q)) throw new FileRefused('Type 2 to 200 characters to look for');
  return q.trim();
}

const searchFolder = (ctx: FilesContext, rel: string): string => {
  const dir = locate(ctx, rel);
  if (!statSync(dir.real).isDirectory()) throw new FileRefused(`${rel} is not a folder`);
  return dir.real;
};

/** Files and folders under a folder whose name holds the text, whatever its case. Links are named and not followed. */
export function findByName(ctx: FilesContext, rel: string, q: string, max = FILE_FIND_MAX, visitMax = VISIT_MAX): FileFindResult {
  const top = searchFolder(ctx, rel);
  const needle = findQuery(q).toLowerCase();
  const matches: FileMatch[] = [];
  let visited = 0;
  let more = false;
  // Folder by folder, the nearest first, so a match close to where you are comes before a deep one.
  const queue: string[] = [''];
  while (queue.length > 0 && !more) {
    const at = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(top, at), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue; // a folder you may not read
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > visitMax || matches.length >= max) {
        more = true;
        break;
      }
      const path = joinPath(at, entry.name);
      const dir = entry.isDirectory();
      if (entry.name.toLowerCase().includes(needle)) matches.push({ path: joinPath(rel, path), kind: dir ? 'dir' : 'file' });
      if (dir && !SKIPPED.includes(entry.name)) queue.push(path);
    }
  }
  return { matches, more };
}

/** Lines of the text files under a folder that hold the text, whatever its case: grep, with the text as fixed characters. */
export async function findInFiles(exec: Executor, ctx: FilesContext, rel: string, q: string, max = FILE_FIND_MAX): Promise<FileFindResult> {
  const top = searchFolder(ctx, rel);
  const needle = findQuery(q);
  const result = await exec(
    'grep',
    // -r never follows a link under the folder, -I leaves binary files out, -Z ends each file name with a NUL so a colon in a name is no trouble.
    ['-rInZ', '-F', '-i', '-m', '5', ...SKIPPED.map((d) => `--exclude-dir=${d}`), '--exclude=*.min.js', '--exclude=*.min.css', '--exclude=*.map', '-e', needle, '--', '.'],
    { cwd: top, timeoutMs: 20_000, maxBufferBytes: 4 * 1024 * 1024, env: { LC_ALL: 'C.UTF-8' } },
  );
  // 1 is grep's "nothing found"; 2 comes with matches too, when a file could not be read.
  if (result.code !== 0 && result.stdout === '') {
    if (result.code === 1 || result.code === 2) return { matches: [], more: false };
    throw new FileRefused(`The search did not run: ${result.stderr.trim().split('\n').at(-1) || `grep ended with ${result.code}`}`);
  }
  const matches: FileMatch[] = [];
  const lines = result.stdout.split('\n');
  // The last line of output that was cut may be half a line.
  const cut = result.code !== 0 && result.code !== 1 && result.code !== 2;
  if (cut) lines.pop();
  for (const line of lines) {
    const found = /^(?:\.\/)?([^\u0000]+)\u0000(\d+):(.*)$/s.exec(line);
    if (!found) continue;
    if (matches.length >= max) return { matches, more: true };
    const text = (found[3] ?? '').trim();
    matches.push({ path: joinPath(rel, found[1] as string), kind: 'file', line: Number(found[2]), text: text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}...` : text });
  }
  return { matches, more: cut };
}

/** The repo a folder of the site is in: the nearest folder with a .git, up to the site's folder and no further. */
export function repoOf(ctx: FilesContext, rel: string): { repo: string; dir: string; within: string } | undefined {
  const at = locate(ctx, rel);
  if (!at.inside) return undefined;
  const root = locate(ctx, '').real;
  let dir = at.real;
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { repo: relative(root, dir), dir, within: relative(dir, at.real) };
    if (dir === root || !dir.startsWith(`${root}/`)) return undefined;
    dir = dirname(dir);
  }
}

// A hook that watches files (fsmonitor) is a program of the repo's config: reading a status never starts it.
const GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const RANK: readonly FileGitState[] = ['new', 'added', 'renamed', 'modified', 'deleted', 'conflict'];

const stateOf = (xy: string): FileGitState => {
  if (xy === '??') return 'new';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('M') || xy.includes('T')) return 'modified';
  return 'added';
};

/** What git says about a folder's entries: each changed file by its name, and a folder when something in it changed. */
export async function gitStatus(exec: Executor, ctx: FilesContext, rel: string): Promise<FileGitStatus> {
  const none: FileGitStatus = { entries: {} };
  const found = repoOf(ctx, rel);
  if (!found) return none;
  const result = await exec('git', ['-C', found.dir, ...GIT, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal', '--', found.within || '.'], { timeoutMs: 10_000, env: GIT_ENV });
  if (result.code !== 0) return none;
  const entries: Record<string, FileGitState> = {};
  let branch: string | undefined;
  const parts = result.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    if (part.startsWith('## ')) {
      const name = part.slice(3).replace(/^No commits yet on /, '').split('...')[0] as string;
      if (!name.startsWith('HEAD (no branch)')) branch = name;
      continue;
    }
    if (part.length < 4) continue;
    const xy = part.slice(0, 2);
    const path = part.slice(3);
    // A rename names the path it had next: not an entry of its own.
    if (xy.includes('R') || xy.includes('C')) i += 1;
    const below = found.within ? (path.startsWith(`${found.within}/`) ? path.slice(found.within.length + 1) : undefined) : path;
    if (!below) continue;
    const [name, ...rest] = below.split('/') as [string, ...string[]];
    // Deeper than the folder listed: the folder is marked. A new folder is named with a slash at its end.
    const state: FileGitState = rest.length === 0 ? stateOf(xy) : rest.length === 1 && rest[0] === '' && xy === '??' ? 'new' : 'modified';
    const had = entries[name];
    if (had === undefined || RANK.indexOf(state) > RANK.indexOf(had)) entries[name] = state;
  }
  return { repo: found.repo, ...(branch ? { branch } : {}), entries };
}

const cutDiff = (text: string): FileDiff => (text.length > FILE_DIFF_MAX ? { diff: text.slice(0, text.lastIndexOf('\n', FILE_DIFF_MAX) + 1), cut: true } : { diff: text, cut: false });

const fileAt = (ctx: FilesContext, rel: string): string => {
  const at = locate(ctx, rel);
  if (!at.inside) throw new FileRefused(`${rel} is part of a shared WordPress core, outside the site`);
  if (!statSync(at.real).isFile()) throw new FileRefused(`${rel} is not a file`);
  return at.real;
};

/** A file's changes since the last commit of its repo, as git writes them. */
export async function gitDiff(exec: Executor, ctx: FilesContext, rel: string): Promise<FileDiff> {
  const file = fileAt(ctx, rel);
  const found = repoOf(ctx, rel);
  if (!found) throw new FileRefused(`${rel} is not in a git repo`);
  // No program of the repo's config runs for a diff: no external diff, no textconv.
  const result = await exec('git', ['-C', found.dir, ...GIT, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', relative(found.dir, file)], { timeoutMs: 10_000, env: GIT_ENV, maxBufferBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 && result.stdout === '') throw new FileRefused(result.stderr.includes('HEAD') ? 'This repo has no commit yet to compare with' : `git could not compare ${nameOf(rel)}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`);
  return cutDiff(result.stdout);
}

/** What is on disk next to what was typed, as a diff: the typed text goes to diff on stdin, never a file or an argument. */
export async function diffWithDisk(exec: Executor, ctx: FilesContext, rel: string, content: string, eol?: 'lf' | 'crlf'): Promise<FileDiff> {
  const file = fileAt(ctx, rel);
  const typed = eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : eol === 'lf' ? content.replace(/\r\n/g, '\n') : content;
  const result = await exec('diff', ['-u', '--label', 'on disk', '--label', 'what you typed', '--', file, '-'], { timeoutMs: 10_000, input: typed, maxBufferBytes: 8 * 1024 * 1024 });
  // 0: the same. 1: they differ. Anything else: diff could not read one of them.
  if (result.code !== 0 && result.code !== 1) throw new FileRefused(`The two could not be compared: ${result.stderr.trim().split('\n').at(-1) || `diff ended with ${result.code}`}`);
  return cutDiff(result.stdout);
}

/** PHP's own word on a saved file's syntax, or undefined when it parses (or PHP is not there to ask). Never runs the file. */
export async function phpSyntax(exec: Executor, ctx: FilesContext, rel: string): Promise<string | undefined> {
  if (!/\.(php|inc|phtml)$/i.test(rel)) return undefined;
  let file: string;
  try {
    file = fileAt(ctx, rel);
  } catch {
    return undefined;
  }
  // -n: no php.ini, so no extension or setting of the machine has a say; -l only parses.
  const result = await exec('php', ['-n', '-l', '--', file], { timeoutMs: 10_000 });
  if (result.code === 0 || result.code === 127) return undefined;
  const said = /(?:Parse|Fatal) error:\s+(.+?)(?: in .+?)? on line (\d+)/.exec(`${result.stdout}\n${result.stderr}`);
  return said ? `${said[1]}, on line ${said[2]}` : undefined;
}

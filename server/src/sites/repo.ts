import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalHelperPlugin, RepoInspection, RepoLookup } from '@devmagic-panel/shared';
import { classifyRepo, headerCandidate, holdsCore, LOCAL_HELPER_PLUGINS, MEDIA_PLUGIN, themeFolderIn, wpHeaderIn } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { BUILD_FILES, composerPlugins, planBuilds, SKIPPED_DIRS } from './builds.js';
import { NO_PROMPTS } from './git.js';
import { installedNodes, nodeEnv, nodeFor, nodeForFiles } from './node.js';

/** The most a repo's file list may take: about 1.8 million files. */
const LIST_BYTES = 256 * 1024 * 1024;
/** At most this many files are read for a theme's or plugin's header: the ones at the top come first. */
const HEADER_FILES = 60;

export class RepoRefused extends Error {}

/** Where a site's code lives in git: the site root, wp-content, or the first theme or plugin with its own repo. */
export interface SiteRepo {
  root: string;
  layout: 'site-root' | 'wp-content' | 'theme' | 'plugin';
}

export function findSiteRepo(docroot: string): SiteRepo | null {
  if (existsSync(join(docroot, '.git'))) return { root: docroot, layout: 'site-root' };
  const content = join(docroot, 'wp-content');
  if (existsSync(join(content, '.git'))) return { root: content, layout: 'wp-content' };
  for (const [folder, layout] of [['themes', 'theme'], ['plugins', 'plugin']] as const) {
    const dir = join(content, folder);
    if (!existsSync(dir)) continue;
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .find((name) => existsSync(join(dir, name, '.git')));
    if (found) return { root: join(dir, found), layout };
  }
  return null;
}

/** `ref: refs/heads/master\tHEAD` from `git ls-remote --symref`. */
export function parseDefaultBranch(lsRemote: string): string | undefined {
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote)?.[1];
}

/** Branch names from `git ls-remote ... 'refs/heads/*'`: the default first, then by name. */
export function parseBranches(lsRemote: string, defaultBranch?: string): string[] {
  const names = [...lsRemote.matchAll(/^[0-9a-f]{40,64}\s+refs\/heads\/(\S+)$/gm)].map((m) => m[1] as string);
  return [...new Set(names)].sort((a, b) => Number(b === defaultBranch) - Number(a === defaultBranch) || a.localeCompare(b));
}

/**
 * A repo's branches and default branch from `git ls-remote`, and for the assistant the
 * start of a few docs (README.md, CLAUDE.md) through a shallow, blob-less
 * clone with no checkout. Nothing from the repo is kept.
 */
export async function inspectRepo(
  exec: Executor,
  workDir: string,
  url: string,
  branch?: string,
  /** Also read these files from the repo root (first 4000 characters each), for the assistant. */
  docs: string[] = [],
): Promise<Omit<RepoInspection, 'preset'> & { docs?: Record<string, string> }> {
  const remote = (args: string[]) => exec('git', args, { timeoutMs: 60_000, env: NO_PROMPTS });
  // One call: the default branch (HEAD) and every branch, without tags or pull request refs.
  const head = await remote(['ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*']);
  if (head.code !== 0) throw new RepoRefused(head.stderr.trim().split('\n').at(-1) || `cannot read ${url}`);
  const defaultBranch = parseDefaultBranch(head.stdout);
  const branches = parseBranches(head.stdout, defaultBranch);
  const ref = branch ?? defaultBranch;
  if (!ref) throw new RepoRefused(`${url} has no default branch; name one`);
  const base = { ...(defaultBranch ? { defaultBranch } : {}), branch: ref, branches };
  if (docs.length === 0) return base;

  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(workDir, 'inspect-'));
  try {
    const clone = await remote(['clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', ref, '--', url, tmp]);
    if (clone.code !== 0) throw new RepoRefused(clone.stderr.trim().split('\n').at(-1) || `cannot clone ${url}`);
    const found: Record<string, string> = {};
    for (const name of docs) {
      const doc = await exec('git', ['-C', tmp, 'show', `HEAD:${name}`], { timeoutMs: 60_000, env: NO_PROMPTS });
      if (doc.code === 0) found[name] = doc.stdout.slice(0, 4000);
    }
    return { ...base, docs: found };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * What a branch holds for the WordPress step, from a one-commit clone
 * without file contents, thrown away after: the local helper plugins (as
 * plugins/<slug> folders anywhere, or required from WordPress Packagist in a
 * composer.json), BE Media from Production, and the builds it needs. Only
 * the build manifests, ignore rules and plugin readmes are read, fetched in
 * one request.
 */
export async function repoLookup(exec: Executor, workDir: string, url: string, branch: string, home = homedir()): Promise<RepoLookup> {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(workDir, 'helpers-'));
  const git = (args: string[], input?: string) => exec('git', args, { timeoutMs: 120_000, env: NO_PROMPTS, ...(input !== undefined ? { input } : {}) });
  // About 140 bytes a file: a site repo with its plugins can list hundreds of thousands, past the usual 8 MB.
  const list = (args: string[]) => exec('git', args, { timeoutMs: 120_000, env: NO_PROMPTS, maxBufferBytes: LIST_BYTES });
  try {
    const clone = await git(['clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', branch, '--', url, tmp]);
    if (clone.code !== 0) throw new RepoRefused(clone.stderr.trim().split('\n').at(-1) || `cannot clone ${url}`);
    const tree = await list(['-C', tmp, 'ls-tree', '-r', '--full-tree', 'HEAD']);
    if (tree.code !== 0) throw new RepoRefused(/maxBuffer/i.test(tree.stderr) ? 'the repo has too many files to list' : tree.stderr.trim() || 'cannot list the repo');
    // Lines are "<mode> <type> <id>\t<path>".
    const blobs = new Map<string, string>();
    for (const line of tree.stdout.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
      if (m) blobs.set(m[2] as string, m[1] as string);
    }
    const paths = new Set(blobs.keys());
    const top = [...new Set([...paths].map((p) => p.split('/')[0] as string))];
    const withCore = holdsCore(top);
    const topKind = classifyRepo(top);
    // Not a whole site: the headers WordPress reads (style.css, the PHP files at the top and one folder down) say theme or plugin.
    const headers = topKind === 'site' || topKind === 'wp-content' ? [] : [...blobs].filter(([path]) => headerCandidate(path)).sort(([a], [b]) => a.split('/').length - b.split('/').length).slice(0, HEADER_FILES);
    const wanted = [...[...blobs].filter(([path]) => (BUILD_FILES.test(path) && !SKIPPED_DIRS.test(path) && path.split('/').length <= 8) || (withCore && path === 'wp-includes/version.php')).slice(0, 301), ...headers];
    const text = await readBlobs(git, tmp, wanted);
    const header = wpHeaderIn(new Map(headers.flatMap(([path]) => (text.has(path) ? [[path, text.get(path) as string]] : []))));
    const files = { paths, text };
    const folders = new Set([...paths].map((p) => /(?:^|\/)plugins\/([^/]+)\//.exec(p)?.[1]).filter(Boolean));
    const fromComposer = new Set(composerPlugins(files));
    const has = (slug: string) => folders.has(slug) || fromComposer.has(slug);
    // With the Node builds use (nvm's), so a repo's npm build is not taken for one this machine cannot run.
    const choice = nodeFor(null, null, { home });
    const env = 'error' in choice ? {} : nodeEnv(choice);
    const tools = await Promise.all((['composer', 'npm', 'yarn', 'pnpm'] as const).map(async (tool) => ((await exec(tool, ['--version'], { timeoutMs: 15_000, env })).code === 0 ? [tool] : [])));
    const version = /\$wp_version\s*=\s*'([^']+)'/.exec(text.get('wp-includes/version.php') ?? '')?.[1];
    const nodes = installedNodes({ home });
    // Tooling on top and the theme in a folder of the repo: by its files, or by its header (a block theme has no functions.php).
    const themeIn = topKind === 'other' ? (themeFolderIn(paths) ?? (header?.kind === 'theme' ? header.folder : undefined)) : undefined;
    const kind = themeIn ? 'theme' : topKind === 'other' && header && !header.folder ? header.kind : topKind;
    const pluginIn = topKind === 'other' && !themeIn && header?.kind === 'plugin' ? header.folder : undefined;
    return {
      helpers: (Object.keys(LOCAL_HELPER_PLUGINS) as LocalHelperPlugin[]).filter(has),
      mediaPlugin: has(MEDIA_PLUGIN),
      // The Node each build would run on, when nvm is there to choose from.
      builds: planBuilds(files, new Set(tools.flat()), (dir) => {
        if (nodes.length === 0) return undefined;
        const on = nodeForFiles(dir, text, { home });
        return 'error' in on ? on.error : on.note;
      }),
      ...(nodes.length ? { nodes } : {}),
      kind,
      ...(themeIn ? { themeIn } : {}),
      ...(pluginIn ? { pluginIn } : {}),
      ...(header ? { header } : {}),
      ...(withCore ? { core: version ? { version } : {} } : {}),
      ...([...paths].some((p) => p.startsWith('wp-content/uploads/') || p.startsWith('uploads/')) ? { uploads: true } : {}),
      plugins: [...new Set([...paths].flatMap((p) => /^((?:.*?\/)?plugins\/[^/]+)/.exec(p)?.[1] ?? []))].filter((p) => !p.split('/').includes('node_modules') && !p.split('/').includes('vendor')).slice(0, 2000),
      themes: [...new Set([...paths].flatMap((p) => /^((?:.*?\/)?themes\/[^/]+)/.exec(p)?.[1] ?? []))].filter((p) => !p.split('/').includes('node_modules') && !p.split('/').includes('vendor')).slice(0, 2000),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The contents of some files of a clone without them: one fetch for all
 * (as git does for one missing file at a time), then read locally.
 */
async function readBlobs(git: (args: string[], input?: string) => ReturnType<Executor>, repo: string, files: Array<[string, string]>): Promise<Map<string, string>> {
  const text = new Map<string, string>();
  if (files.length === 0) return text;
  const ids = [...new Set(files.map(([, id]) => id))];
  await git(['-C', repo, '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'], `${ids.join('\n')}\n`);
  for (const [path, id] of files) {
    const shown = await git(['-C', repo, 'cat-file', 'blob', id]);
    if (shown.code === 0) text.set(path, shown.stdout.slice(0, 256 * 1024));
  }
  return text;
}

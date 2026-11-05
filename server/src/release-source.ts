import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UPDATE_WAYS, type UpdateWay } from '@devmagic-panel/shared';
import { GIT_URL } from './config.js';
import type { Executor } from './exec.js';
import { NO_PROMPTS } from './sites/git.js';

/**
 * Where the panel's releases come from. Each version is published twice by
 * the release workflow: as a GitHub release (package, .sha256, .json, get.sh,
 * the changelog section as its description) and as a package tag
 * `pkg/vX.Y.Z`, an annotated tag on a commit with no history that holds the
 * same files, its message the same notes. Three ways reach them, and the panel
 * uses the first that can read the repository, so a public repository, a
 * signed-in GitHub CLI or an SSH key that reads it are each enough. No token
 * is asked for or stored: gh and git keep their own sign-in.
 */
export const DEFAULT_UPDATE_REPO = 'PetyoLazarov92/devmagic-panel';
export const GITHUB_API = 'https://api.github.com';
export const RELEASE_TAG = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A published version as one way sees it, newest first. */
export interface PublishedRelease {
  tag: string;
  /** The release description, or the package tag's message: the changelog of that version. */
  notes: string;
  date?: string;
  /** File sizes by name; none when the way cannot tell without downloading (git). */
  sizes?: Record<string, number>;
}

export interface ReleaseSource {
  way: UpdateWay;
  /** Published versions, newest first. Throws SourceRefused when this way cannot read the repository. */
  releases(): Promise<PublishedRelease[]>;
  /** A small file of a release, like its .json or .sha256. */
  text(tag: string, name: string): Promise<string>;
  /** A release file into dest; onBytes gets the bytes so far when the way can tell. */
  download(tag: string, name: string, dest: string, onBytes?: (bytes: number) => void): Promise<void>;
}

/** This way cannot read the repository; the message says why, in words for the Updates page. */
export class SourceRefused extends Error {}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (RELEASE_TAG.exec(v.startsWith('v') ? v : `v${v}`) ?? []).slice(1, 4).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

const newestFirst = (list: PublishedRelease[]) => list.filter((r) => RELEASE_TAG.test(r.tag)).sort((a, b) => compareVersions(b.tag, a.tag));

function checkFile(tag: string, name: string): void {
  if (!RELEASE_TAG.test(tag)) throw new Error(`not a release: ${tag}`);
  if (!FILE_NAME.test(name)) throw new Error(`not a release file: ${name}`);
}

// ── GitHub releases, as the API and the GitHub CLI answer ────

interface GitHubRelease {
  tag_name: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: Array<{ name: string; size: number; browser_download_url?: string }>;
}

function fromGitHub(list: unknown): GitHubRelease[] {
  if (!Array.isArray(list)) throw new SourceRefused('GitHub answered with something that is not a list of releases');
  return (list as GitHubRelease[]).filter((r) => typeof r?.tag_name === 'string' && !r.draft && !r.prerelease);
}

const published = (r: GitHubRelease): PublishedRelease => ({
  tag: r.tag_name,
  notes: r.body ?? '',
  ...(r.published_at ? { date: r.published_at } : {}),
  sizes: Object.fromEntries((r.assets ?? []).map((a) => [a.name, a.size])),
});

/** Streams a response into dest, refusing more than maxBytes. */
async function save(response: Response, dest: string, maxBytes: number, onBytes?: (bytes: number) => void): Promise<void> {
  if (!response.body) throw new Error('the download is empty');
  let done = 0;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    if (done > maxBytes) body.destroy(new Error('the download is far larger than a release'));
    onBytes?.(done);
  });
  await pipeline(body, createWriteStream(dest, { mode: 0o600 }));
}

export const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;

/** Way 1: the public GitHub releases, with no login. 60 API calls an hour per address; a check uses one. */
export function httpsSource(repo: string, get: typeof fetch = fetch): ReleaseSource {
  const urls = new Map<string, string>();
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'devmagic-panel' };
  const fileUrl = (tag: string, name: string) => {
    checkFile(tag, name);
    return urls.get(`${tag}/${name}`) ?? `https://github.com/${repo}/releases/download/${tag}/${name}`;
  };
  const fetchFile = async (url: string, timeoutMs: number) => {
    const r = await get(url, { headers: { 'user-agent': 'devmagic-panel' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  };
  return {
    way: 'https',
    async releases() {
      let r: Response;
      try {
        r = await get(`${GITHUB_API}/repos/${repo}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        throw new SourceRefused(`could not reach GitHub: ${(error as Error).message}`);
      }
      if (r.status === 404 || r.status === 401) throw new SourceRefused(`${repo} is not public`);
      if (r.status === 403 || r.status === 429) throw new SourceRefused('GitHub refused: too many requests from this address, try again within the hour');
      if (!r.ok) throw new SourceRefused(`GitHub answered HTTP ${r.status}`);
      const list = fromGitHub(await r.json());
      urls.clear();
      for (const release of list) {
        for (const a of release.assets ?? []) if (a.browser_download_url?.startsWith('https://')) urls.set(`${release.tag_name}/${a.name}`, a.browser_download_url);
      }
      return newestFirst(list.map(published));
    },
    async text(tag, name) {
      return (await fetchFile(fileUrl(tag, name), 30_000)).text();
    },
    async download(tag, name, dest, onBytes) {
      await save(await fetchFile(fileUrl(tag, name), 10 * 60_000), dest, MAX_PACKAGE_BYTES, onBytes);
    },
  };
}

/** Why gh failed, in words. */
function ghProblem(stderr: string, repo: string): string {
  if (/gh auth login|not logged in|authentication/i.test(stderr)) return 'the GitHub CLI is not signed in: run gh auth login';
  if (/HTTP 404|Not Found/i.test(stderr)) return `the GitHub CLI cannot read ${repo}`;
  return `the GitHub CLI failed: ${firstLine(stderr) || 'no answer'}`;
}

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };

/** Way 2: the GitHub CLI, with its own sign-in; the panel never reads its token. */
export function ghSource(exec: Executor, repo: string): ReleaseSource {
  return {
    way: 'gh',
    async releases() {
      const r = await exec('gh', ['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/releases?per_page=30`], { timeoutMs: 30_000, env: GH_ENV });
      if (r.code === 127) throw new SourceRefused('the GitHub CLI (gh) is not installed');
      if (r.code !== 0) throw new SourceRefused(ghProblem(r.stderr || r.stdout, repo));
      let list: unknown;
      try {
        list = JSON.parse(r.stdout);
      } catch {
        throw new SourceRefused('the GitHub CLI answered with something that is not JSON');
      }
      return newestFirst(fromGitHub(list).map(published));
    },
    async text(tag, name) {
      checkFile(tag, name);
      const r = await exec('gh', ['release', 'download', tag, '-R', repo, '-p', name, '-O', '-'], { timeoutMs: 60_000, env: GH_ENV });
      if (r.code !== 0) throw new Error(`could not download ${name}: ${ghProblem(r.stderr, repo)}`);
      return r.stdout;
    },
    async download(tag, name, dest, onBytes) {
      checkFile(tag, name);
      // gh shows no progress here, so the file's size on disk stands in for it.
      const timer = onBytes
        ? setInterval(() => {
            try {
              onBytes(statSync(dest).size);
            } catch {
              // not started yet
            }
          }, 500)
        : undefined;
      try {
        const r = await exec('gh', ['release', 'download', tag, '-R', repo, '-p', name, '-O', dest, '--clobber'], { timeoutMs: 10 * 60_000, env: GH_ENV });
        if (r.code !== 0) throw new Error(`could not download ${name}: ${ghProblem(r.stderr, repo)}`);
      } finally {
        if (timer) clearInterval(timer);
      }
      if (statSync(dest).size > MAX_PACKAGE_BYTES) {
        rmSync(dest, { force: true });
        throw new Error(`${name} is far larger than a release`);
      }
    },
  };
}

/**
 * Way 3: git over SSH (or git's HTTPS sign-in) on the package tags. A bare
 * cache in the panel's data folder fetches the tags without their files
 * (--filter=blob:none), so a check moves a few kilobytes and reads the notes
 * from the tag messages; a file is fetched only when it is read.
 */
export function gitSource(exec: Executor, url: string, cacheDir: string): ReleaseSource {
  if (!GIT_URL.test(url)) throw new Error(`not a git remote: ${url}`);
  const git = (args: string[], timeoutMs = 120_000, env: Record<string, string> = {}) => exec('git', ['-C', cacheDir, ...args], { timeoutMs, env: { ...NO_PROMPTS, ...env } });
  const ref = (tag: string) => `refs/tags/pkg/${tag}`;

  const ensure = async () => {
    if (!existsSync(join(cacheDir, 'HEAD'))) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const r = await exec('git', ['init', '-q', '--bare', cacheDir], { timeoutMs: 10_000 });
      if (r.code === 127) throw new SourceRefused('git is not installed');
      if (r.code !== 0) throw new SourceRefused(`could not set up ${cacheDir}: ${firstLine(r.stderr)}`);
    }
    const settings: Array<[string, string]> = [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.url', url],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
    ];
    for (const [key, value] of settings) {
      const r = await git(['config', key, value], 10_000);
      if (r.code !== 0) throw new SourceRefused(`could not set up ${cacheDir}: ${firstLine(r.stderr)}`);
    }
  };

  return {
    way: 'git',
    async releases() {
      await ensure();
      const fetched = await git(['fetch', '-q', '--filter=blob:none', '--no-tags', '--prune', 'origin', '+refs/tags/pkg/*:refs/tags/pkg/*']);
      if (fetched.code !== 0) throw new SourceRefused(`git cannot read ${url}: ${firstLine(fetched.stderr) || 'no answer'}`);
      const listed = await git(['for-each-ref', '--format=%(refname:lstrip=3)%00%(creatordate:iso-strict)%00%(contents)%00', 'refs/tags/pkg/'], 10_000);
      if (listed.code !== 0) throw new SourceRefused(`could not list the package tags: ${firstLine(listed.stderr)}`);
      const list: PublishedRelease[] = [];
      for (const record of listed.stdout.split('\0\n')) {
        const [tag, date, notes] = record.split('\0');
        if (!tag) continue;
        list.push({ tag, notes: (notes ?? '').trim(), ...(date ? { date } : {}) });
      }
      return newestFirst(list);
    },
    async text(tag, name) {
      checkFile(tag, name);
      const r = await git(['cat-file', 'blob', `${ref(tag)}:${name}`]);
      if (r.code !== 0) throw new Error(`could not read ${name} of ${tag}: ${firstLine(r.stderr)}`);
      return r.stdout;
    },
    async download(tag, name, dest) {
      checkFile(tag, name);
      // Checked out into a folder of its own, with an index of its own, so a check running meanwhile is not in the way.
      const work = join(dirname(dest), `.git-${tag}`);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true, mode: 0o700 });
      try {
        const r = await exec('git', [`--git-dir=${cacheDir}`, `--work-tree=${work}`, 'checkout', '-q', '-f', ref(tag), '--', name], {
          timeoutMs: 10 * 60_000,
          env: { ...NO_PROMPTS, GIT_INDEX_FILE: join(work, '.index') },
        });
        if (r.code !== 0) throw new Error(`could not download ${name}: ${firstLine(r.stderr)}`);
        if (statSync(join(work, name)).size > MAX_PACKAGE_BYTES) throw new Error(`${name} is far larger than a release`);
        renameSync(join(work, name), dest);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** The ways in the order they are tried. */
export function defaultSources(exec: Executor, repo: string, gitUrl: string, dataDir: string, get: typeof fetch = fetch): ReleaseSource[] {
  return [httpsSource(repo, get), ghSource(exec, repo), gitSource(exec, gitUrl, join(dataDir, 'updates.git'))];
}

export const gitUrlFor = (repo: string) => `git@github.com:${repo}.git`;

type Problems = Array<{ way: UpdateWay; problem: string }>;
export type Found = { source: ReleaseSource; releases: PublishedRelease[]; problems: Problems } | { problems: Problems };

/**
 * The releases through the first way that answers: the one that worked last
 * time first, then the others in order. Either way, why the ways tried before
 * failed.
 */
export async function findReleases(sources: ReleaseSource[], preferred?: UpdateWay): Promise<Found> {
  const order = preferred ? [...sources.filter((s) => s.way === preferred), ...sources.filter((s) => s.way !== preferred)] : sources;
  const problems: Problems = [];
  const sorted = () => problems.sort((a, b) => UPDATE_WAYS.indexOf(a.way) - UPDATE_WAYS.indexOf(b.way));
  for (const source of order) {
    try {
      const releases = await source.releases();
      return { source, releases, problems: sorted() };
    } catch (error) {
      problems.push({ way: source.way, problem: (error as Error).message });
    }
  }
  return { problems: sorted() };
}

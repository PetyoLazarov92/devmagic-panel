import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangelogSection, InstalledRelease, UpdateStatus, UpdateWay } from '@devmagic-panel/shared';
import { releaseName, UPDATE_WAY_LABELS } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import { sha256File } from './mailpit.js';
import { compareVersions, findReleases, type PublishedRelease, RELEASE_TAG, type ReleaseSource } from './release-source.js';
import { formatBytes, progressNote } from './sites/db.js';

export { compareVersions, RELEASE_TAG } from './release-source.js';

/**
 * Updates from the panel's releases, read through the first way that can
 * reach the repository (release-source.ts). A release is a package the
 * release workflow built and checked: devmagic-panel-vX.Y.Z.tar.gz, its
 * .sha256, and devmagic-panel-vX.Y.Z.json (release.json: checksums of
 * install.sh and the root scripts). The panel runs from releases/<name> in its
 * data folder, the one `current` points at. An update downloads and checks
 * the package, unpacks it next to the others, moves `current` and restarts;
 * the release before stays to switch back to. Root scripts only install.sh may
 * replace, with your sudo password: a release that changes them is downloaded
 * here and installed from a terminal.
 */
export interface UpdateContext {
  exec: Executor;
  /** The folder the panel runs from: a release (releases/v0.6.0), or a checkout in development. */
  appDir: string;
  /** The panel's data folder, with releases/ and current. */
  dataDir: string;
  /** The running version, like 0.6.0. */
  version: string;
  /** Where update logs go, next to the install logs. */
  logsDir: string;
  /** The installed dmp-root; the installed root scripts are in bin/ and lib/ next to its folder. */
  dmpRoot: string;
  /** The ways to the releases, in the order they are tried. */
  sources: ReleaseSource[];
  /** The way that worked last; it is tried first next time. */
  memory?: { way?: UpdateWay };
  /** A one-time note for the Updates page, like the saved GitHub token being deleted. */
  notice?: () => string | undefined;
}

/** Releases kept installed: the running one and the newest others. */
export const KEEP_RELEASES = 3;

/** The lines of a release's notes, the way the changelog writes them: `* ` or `- ` items, else its non-empty lines. */
export function notesItems(notes: string): string[] {
  const lines = notes.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.flatMap((l) => {
    const m = /^[*-]\s+(.*)$/.exec(l);
    return m ? [m[1] as string] : [];
  });
  return items.length ? items : lines.filter((l) => !l.startsWith('#'));
}

// ── releases on this machine ─────────────────────────────────

/** A release's release.json, written by scripts/package.sh. */
export interface ReleaseInfo {
  name: string;
  version: string;
  commit: string;
  built?: string;
  /** sha256 of its install.sh. */
  installer: string;
  /** sha256 of each root script, by its path under scripts/: bin/dmp-root, lib/cert.sh. */
  scripts: Record<string, string>;
}

export function parseRelease(text: string): ReleaseInfo | null {
  try {
    const r = JSON.parse(text) as Partial<ReleaseInfo>;
    if (!releaseName.safeParse(r.name).success || typeof r.version !== 'string' || typeof r.installer !== 'string' || !r.scripts || typeof r.scripts !== 'object') return null;
    return r as ReleaseInfo;
  } catch {
    return null;
  }
}

/** The release.json of a release folder; null for a checkout. */
/**
 * The panel's CLI as a command outside the panel should run it: through
 * current for a release, so it keeps working after updates, or the checkout's
 * own build.
 */
export function panelCli(where?: { appDir: string; dataDir: string }): string {
  return where && readRelease(where.appDir) ? join(where.dataDir, 'current', 'server', 'dist', 'cli.js') : fileURLToPath(new URL('./cli.js', import.meta.url));
}

export function readRelease(dir: string): ReleaseInfo | null {
  try {
    return parseRelease(readFileSync(join(dir, 'release.json'), 'utf8'));
  } catch {
    return null;
  }
}

const releasesDir = (ctx: Pick<UpdateContext, 'dataDir'>) => join(ctx.dataDir, 'releases');
const currentLink = (ctx: Pick<UpdateContext, 'dataDir'>) => join(ctx.dataDir, 'current');

/** The release current points at, by name. */
export function currentRelease(dataDir: string): string | null {
  try {
    return basename(readlinkSync(join(dataDir, 'current')));
  } catch {
    return null;
  }
}

/** The root scripts of a release that are not the installed ones; install.sh puts those in place, with your password. */
export function changedRootScripts(release: ReleaseInfo, dmpRoot: string): string[] {
  const prefix = dirname(dirname(dmpRoot));
  return Object.entries(release.scripts)
    .filter(([file, sum]) => {
      try {
        return sha256File(join(prefix, file)) !== sum;
      } catch {
        return true;
      }
    })
    .map(([file]) => file);
}

/** The sections of a CHANGELOG.md, newest first: `### v0.6.1 (2026-10-02)` and its `* ` items. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const line of text.split('\n')) {
    const head = /^###\s+(v\d+\.\d+\.\d+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/.exec(line);
    if (head) sections.push({ version: head[1] as string, ...(head[2] ? { date: head[2] } : {}), items: [] });
    else if (/^[*-]\s+/.test(line)) sections.at(-1)?.items.push(line.replace(/^[*-]\s+/, '').trim());
  }
  return sections;
}

/**
 * What switching from the running version to each release adds or removes,
 * from one changelog that has them all (the newest release's): the versions
 * between the two, newest first.
 */
export function releaseChanges(release: Pick<InstalledRelease, 'version' | 'current'>, running: string, sections: readonly ChangelogSection[]): InstalledRelease['changes'] {
  const between = (low: string, high: string) => sections.filter((s) => compareVersions(s.version, low) > 0 && compareVersions(s.version, high) <= 0);
  const step = release.current || compareVersions(release.version, running) === 0
    ? { kind: 'running' as const, sections: sections.filter((s) => compareVersions(s.version, running) === 0) }
    : compareVersions(release.version, running) > 0
      ? { kind: 'adds' as const, sections: between(running, release.version) }
      : { kind: 'removes' as const, sections: between(release.version, running) };
  return step.sections.length > 0 ? step : undefined;
}

/** An install.sh that knows --from-panel; older ones only install from a terminal. */
export function installsFromPanel(dir: string): boolean {
  try {
    return readFileSync(join(dir, 'install.sh'), 'utf8').includes('--from-panel)');
  } catch {
    return false;
  }
}

/** The releases in the releases folder, newest install first. */
export function installedReleases(ctx: Pick<UpdateContext, 'dataDir' | 'dmpRoot'>): InstalledRelease[] {
  const dir = releasesDir(ctx);
  const current = currentRelease(ctx.dataDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => releaseName.safeParse(name).success);
  } catch {
    return [];
  }
  const releases = names
    .flatMap((name): InstalledRelease[] => {
      const info = readRelease(join(dir, name));
      if (!info) return [];
      const terminal = changedRootScripts(info, ctx.dmpRoot).length > 0;
      return [{
        name,
        version: info.version,
        current: name === current,
        installedAt: statSync(join(dir, name)).mtime.toISOString(),
        ...(info.built ? { built: info.built } : {}),
        mode: terminal ? 'terminal' : 'panel',
        ...(terminal && name !== current ? { command: join(dir, name, 'install.sh') } : {}),
        ...(installsFromPanel(join(dir, name)) ? { fromPanel: true as const } : {}),
      }];
    })
    .concat(
      packedNames(dir).flatMap((name): InstalledRelease[] => {
        if (names.includes(name)) return [];
        const packed = readPacked(dir, name);
        if (!packed) return [];
        const terminal = changedRootScripts(packed.release, ctx.dmpRoot).length > 0;
        return [{
          name,
          version: packed.release.version,
          current: false,
          installedAt: packed.installedAt,
          ...(packed.release.built ? { built: packed.release.built } : {}),
          mode: terminal ? 'terminal' : 'panel',
          ...(terminal ? { command: join(dir, name, 'install.sh') } : {}),
          ...(packed.fromPanel ? { fromPanel: true as const } : {}),
          packed: true as const,
        }];
      }),
    )
    .sort((a, b) => b.installedAt.localeCompare(a.installedAt));
  // The newest release's changelog has every version of the others.
  const running = releases.find((r) => r.current)?.version;
  const newest = [...releases].filter((r) => !r.packed).sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!running || !newest) return releases;
  let sections: ChangelogSection[] = [];
  try {
    sections = parseChangelog(readFileSync(join(dir, newest.name, 'CHANGELOG.md'), 'utf8'));
  } catch {
    return releases;
  }
  return releases.map((r) => {
    const changes = releaseChanges(r, running, sections);
    return changes ? { ...r, changes } : r;
  });
}

// ── packed releases ──────────────────────────────────────────

/**
 * A release the panel does not run is kept packed: its folder as
 * <name>.tar.gz (gzip at its best, about a seventh of the folder, mostly
 * node_modules) and what the Updates page lists of it in <name>.release.json
 * beside it. Switching back to one unpacks it first.
 */
interface PackedRelease {
  release: ReleaseInfo;
  installedAt: string;
  fromPanel: boolean;
}

const packedFile = (dir: string, name: string) => join(dir, `${name}.tar.gz`);
const packedInfoFile = (dir: string, name: string) => join(dir, `${name}.release.json`);

function readPacked(dir: string, name: string): PackedRelease | null {
  if (!existsSync(packedFile(dir, name))) return null;
  try {
    const raw = JSON.parse(readFileSync(packedInfoFile(dir, name), 'utf8')) as { release?: unknown; installedAt?: unknown; fromPanel?: unknown };
    const release = parseRelease(JSON.stringify(raw.release));
    if (!release || release.name !== name || typeof raw.installedAt !== 'string') return null;
    return { release, installedAt: raw.installedAt, fromPanel: raw.fromPanel === true };
  } catch {
    return null;
  }
}

/** The packed releases by name. */
function packedNames(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => {
      const name = f.endsWith('.tar.gz') ? f.slice(0, -'.tar.gz'.length) : '';
      return name && releaseName.safeParse(name).success ? [name] : [];
    });
  } catch {
    return [];
  }
}

/** Packs one release folder into <name>.tar.gz with gzip at level 9, checks the archive reads back, then removes the folder. */
export async function packRelease(exec: Executor, dir: string, name: string): Promise<{ before: number; after: number }> {
  const folder = join(dir, name);
  const info = readRelease(folder);
  if (!info || info.name !== name) throw new Error(`${name} has no release.json of its own`);
  const before = await folderBytes(exec, folder);
  const part = join(dir, `.packing-${name}.tar.gz`);
  const out = new PassThrough();
  const written = pipeline(out, createGzip({ level: 9 }), createWriteStream(part, { mode: 0o600 }));
  const r = await exec('tar', ['-cf', '-', '-C', dir, '--', name], { stdoutTo: out, timeoutMs: 10 * 60_000 });
  if (r.code !== 0) out.destroy();
  const failedWrite = await written.then(() => null, (error: Error) => error);
  if (r.code !== 0 || failedWrite) {
    rmSync(part, { force: true });
    throw new Error(r.code !== 0 ? `tar could not pack ${name}: ${firstLine(r.stderr) || `exit ${r.code}`}` : `could not write ${part}: ${failedWrite?.message}`);
  }
  // The archive must read back whole before the folder goes.
  const check = await exec('tar', ['-tzf', part], { timeoutMs: 5 * 60_000 });
  if (check.code !== 0 || !check.stdout.split('\n').includes(`${name}/release.json`)) {
    rmSync(part, { force: true });
    throw new Error(`the packed ${name} did not read back, so its folder stays`);
  }
  writeFileSync(packedInfoFile(dir, name), `${JSON.stringify({ release: info, installedAt: statSync(folder).mtime.toISOString(), fromPanel: installsFromPanel(folder) } satisfies PackedRelease)}\n`, { mode: 0o600 });
  renameSync(part, packedFile(dir, name));
  rmSync(folder, { recursive: true, force: true });
  return { before, after: statSync(packedFile(dir, name)).size };
}

async function folderBytes(exec: Executor, folder: string): Promise<number> {
  const r = await exec('du', ['-s', '-B1', '--', folder], { timeoutMs: 60_000 });
  return Number(r.stdout.split('\t')[0]) || 0;
}

/** Unpacks a packed release into its folder again, with the time it was installed; nothing to do when the folder is there. */
export async function unpackRelease(exec: Executor, dir: string, name: string): Promise<boolean> {
  if (existsSync(join(dir, name, 'release.json'))) return false;
  const packed = readPacked(dir, name);
  if (!packed) throw new Error(`${name} is neither in ${dir} nor packed there`);
  const staging = join(dir, `.unpacking-${name}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const r = await exec('tar', ['-xzf', packedFile(dir, name), '-C', staging, '--no-same-owner'], { timeoutMs: 10 * 60_000 });
  if (r.code !== 0 || readRelease(join(staging, name))?.name !== name) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(r.code !== 0 ? `tar could not unpack ${name}: ${firstLine(r.stderr) || `exit ${r.code}`}` : `the packed ${name} holds another release`);
  }
  rmSync(join(dir, name), { recursive: true, force: true });
  renameSync(join(staging, name), join(dir, name));
  rmSync(staging, { recursive: true, force: true });
  const at = new Date(packed.installedAt);
  utimesSync(join(dir, name), at, at);
  rmSync(packedFile(dir, name), { force: true });
  rmSync(packedInfoFile(dir, name), { force: true });
  return true;
}

/**
 * Packs every release folder the panel neither runs nor points current at,
 * and none newer than the running one (a release downloaded for a terminal
 * install waits for its install.sh there). For the background task.
 */
export async function packOlderReleases(ctx: Pick<UpdateContext, 'exec' | 'dataDir' | 'appDir'>): Promise<string> {
  const dir = releasesDir(ctx);
  const current = currentRelease(ctx.dataDir);
  const running = readRelease(ctx.appDir);
  if (!current || !running) return 'the panel does not run from a release';
  const keep = new Set([current, basename(ctx.appDir)]);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => releaseName.safeParse(n).success && !keep.has(n));
  } catch {
    return 'no releases folder';
  }
  const done: string[] = [];
  let saved = 0;
  for (const name of names) {
    const info = readRelease(join(dir, name));
    if (!info || compareVersions(info.version, running.version) >= 0) continue;
    const { before, after } = await packRelease(ctx.exec, dir, name);
    saved += Math.max(0, before - after);
    done.push(name);
  }
  return done.length ? `packed ${done.join(', ')}, ${formatBytes(saved)} less` : 'every older version is packed';
}

/** Points current at a release in one rename, so the service starts it on its next start. */
function pointCurrent(ctx: UpdateContext, name: string): void {
  const link = currentLink(ctx);
  rmSync(`${link}.new`, { force: true });
  symlinkSync(join('releases', name), `${link}.new`);
  renameSync(`${link}.new`, link);
}

/** Keeps the running release, the one before and the newest others, up to KEEP_RELEASES, packed or not, and removes what an interrupted update left. */
function pruneReleases(ctx: UpdateContext, keep: string[]): string[] {
  const dir = releasesDir(ctx);
  const removed: string[] = [];
  const at = (name: string) => {
    const packed = readPacked(dir, name);
    if (packed) return Date.parse(packed.installedAt);
    try {
      return statSync(join(dir, name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const files = readdirSync(dir);
  const releases = [...new Set([...files.filter((n) => releaseName.safeParse(n).success), ...packedNames(dir)])].map((name) => ({ name, at: at(name) })).sort((a, b) => b.at - a.at);
  let kept = keep.length;
  for (const { name } of releases) {
    if (keep.includes(name)) continue;
    if (kept < KEEP_RELEASES) {
      kept += 1;
      continue;
    }
    for (const path of [join(dir, name), packedFile(dir, name), packedInfoFile(dir, name)]) rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  // What an interrupted download, unpack or pack left.
  for (const name of files.filter((n) => n.startsWith('.'))) {
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// ── checking ─────────────────────────────────────────────────

const short = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
const packageName = (tag: string) => `devmagic-panel-${tag}.tar.gz`;

/** Reads the releases through the first way that answers and says whether one is newer, what it brings and how it gets installed here. */
export async function checkUpdate(ctx: UpdateContext, now = () => new Date()): Promise<UpdateStatus> {
  const running = readRelease(ctx.appDir);
  const notice = ctx.notice?.();
  const base: UpdateStatus = {
    current: ctx.version,
    ...(running ? { release: running.name } : {}),
    checkedAt: now().toISOString(),
    changelog: [],
    available: false,
    mode: 'blocked',
    ...(notice ? { notice } : {}),
    releases: installedReleases(ctx),
  };
  if (!running) {
    return { ...base, reason: `The panel runs from a checkout (${ctx.appDir}), not a release, so it does not update itself. Install it with ./install.sh to get updates here.` };
  }
  const found = await findReleases(ctx.sources, ctx.memory?.way);
  if (!('source' in found)) {
    return { ...base, access: found.problems, error: 'No way could read the releases. Any one of them is enough: make the repository public, sign in to the GitHub CLI, or use an SSH key that can read it.' };
  }
  const { source, releases } = found;
  if (ctx.memory) ctx.memory.way = source.way;
  base.source = source.way;
  if (found.problems.length) base.access = found.problems;
  const latest = releases[0];
  if (!latest) return { ...base, reason: 'No releases yet: the repository has no published release.' };
  const tag = latest.tag;
  if (compareVersions(tag, ctx.version) <= 0) return { ...base, latest: tag, reason: 'You have the latest version.' };

  const sizes = latest.sizes;
  if (sizes && !['', '.sha256'].every((end) => `${packageName(tag)}${end}` in sizes)) {
    return { ...base, latest: tag, available: true, reason: `${tag} is out, but its package is not there yet: its release workflow may still be running. Check again in a few minutes.` };
  }
  let info: ReleaseInfo | null = null;
  try {
    info = parseRelease(await source.text(tag, `devmagic-panel-${tag}.json`));
  } catch {
    // said below
  }
  if (!info) return { ...base, latest: tag, available: true, error: `Could not read what ${tag} changes (devmagic-panel-${tag}.json) through ${UPDATE_WAY_LABELS[source.way]}` };

  const changelog = releases
    .filter((r) => compareVersions(r.tag, ctx.version) > 0)
    .sort((a, b) => compareVersions(b.tag, a.tag))
    .map((r) => ({ version: r.tag, ...(r.date ? { date: r.date.slice(0, 10) } : {}), items: notesItems(r.notes) }));
  const size = latest.sizes?.[packageName(tag)];
  const status: UpdateStatus = { ...base, latest: tag, available: true, changelog, ...(size ? { packageBytes: size } : {}) };
  const scripts = changedRootScripts(info, ctx.dmpRoot);
  if (scripts.length > 0) {
    return {
      ...status,
      mode: 'terminal',
      reason: `${tag} changes the root scripts (${short(scripts)}), which only its install.sh may put in place, with your sudo password: the Updates page downloads and checks ${tag} and hands the password to its installer once, or you run the installer in a terminal.`,
      command: join(releasesDir(ctx), tag, 'install.sh'),
    };
  }
  if (info.installer !== running.installer) return { ...status, mode: 'panel', installerChanged: true, command: join(currentLink(ctx), 'install.sh') };
  return { ...status, mode: 'panel' };
}

/**
 * Keeps the last check of the releases and checks again when asked. The
 * releases on this machine are read every time: a download finished since the
 * check shows at once, without asking GitHub again.
 */
export class UpdateChecker {
  private last: UpdateStatus | null = null;
  private running: Promise<UpdateStatus> | null = null;

  constructor(private readonly ctx: UpdateContext) {}

  async status(refresh = false): Promise<UpdateStatus> {
    if (this.last && !refresh) return { ...this.last, releases: installedReleases(this.ctx) };
    this.running ??= checkUpdate(this.ctx).finally(() => {
      this.running = null;
    });
    this.last = await this.running;
    return this.last;
  }
}

// ── jobs ─────────────────────────────────────────────────────

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** Each step's label and output go to an update log next to the install logs too. */
function updateLog(ctx: UpdateContext, now: () => Date) {
  const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(ctx.logsDir, `update-${stamp}.log`);
  const log = (text: string) => {
    try {
      mkdirSync(ctx.logsDir, { recursive: true, mode: 0o700 });
      appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // A log that cannot be written never stops the update.
    }
  };
  const logged = (step: JobStep): JobStep => ({
    ...step,
    run: async (job) => {
      log(`==> ${step.label}`);
      const out = await step.run(job);
      for (const r of Array.isArray(out) ? out : [out]) log([r.stdout.trim(), r.stderr.trim(), r.code !== 0 ? `exit ${r.code}` : ''].filter(Boolean).join('\n') || 'ok');
      return out;
    },
  });
  return { log, logged };
}

/** Restarts the panel a few seconds after the job ends, from a timer outside its own service, once the job is in run history. */
async function scheduleRestart(ctx: UpdateContext, done: string): Promise<ExecResult> {
  const r = await ctx.exec('systemd-run', ['--user', '--on-active=3', '--timer-property=AccuracySec=100ms', 'systemctl', '--user', 'restart', 'devmagic-panel.service']);
  return r.code === 0 ? ok(done) : r;
}

/** Points current at a release, with Undo pointing it back, and keeps the newest releases. */
function switchStep(ctx: UpdateContext, name: string): JobStep {
  return {
    id: 'switch',
    label: `Switch the panel to ${name}`,
    run: async (job) => {
      const before = currentRelease(ctx.dataDir);
      pointCurrent(ctx, name);
      if (before && before !== name) {
        job.onUndo(`Switch back to ${before} and restart`, async () => {
          // Packed meanwhile by the background task: unpacked again first.
          await unpackRelease(ctx.exec, releasesDir(ctx), before);
          pointCurrent(ctx, before);
          return scheduleRestart(ctx, `back on ${before}; the panel restarts in a few seconds`);
        });
      }
      const pruned = pruneReleases(ctx, [name, ...(before ? [before] : [])]);
      return ok(`current points at releases/${name}${before ? `, before: ${before}` : ''}${pruned.length ? `; removed the older ${pruned.join(', ')}` : ''}`);
    },
  };
}

/**
 * Installs a release: download, checksum, unpack next to the
 * others, then (mode panel) point current at it and restart, (mode
 * terminal) leave the switch and the root scripts to its install.sh, or
 * (mode download) stop there, for a job that runs its install.sh next.
 */
export function planUpdate(ctx: UpdateContext, version: string, mode: 'panel' | 'terminal' | 'download', now = () => new Date()): JobStep[] {
  const { log, logged } = updateLog(ctx, now);
  const dir = releasesDir(ctx);
  const base = `devmagic-panel-${version}.tar.gz`;
  const download = join(dir, `.download-${base}`);
  const incoming = join(dir, `.incoming-${version}`);
  const dest = join(dir, version);
  let expected = '';

  const steps: JobStep[] = [
    {
      id: 'download',
      label: `Download ${version}`,
      weight: 4,
      run: async (job) => {
        log(`devmagic-panel update, ${now().toISOString()}, ${ctx.version} to ${version} (${mode})`);
        const found = await findReleases(ctx.sources, ctx.memory?.way);
        if (!('source' in found)) return failed(`no way could read the releases: ${found.problems.map((p) => `${UPDATE_WAY_LABELS[p.way]}: ${p.problem}`).join('; ')}`);
        const release: PublishedRelease | undefined = found.releases.find((r) => r.tag === version);
        if (!release) return failed(`there is no release ${version}`);
        const source = found.source;
        let sum: string;
        try {
          sum = await source.text(version, `${base}.sha256`);
        } catch (error) {
          return failed(`could not download ${base}.sha256: ${(error as Error).message}`);
        }
        expected = firstLine(sum).split(/\s+/)[0] ?? '';
        if (!/^[0-9a-f]{64}$/.test(expected)) return failed(`${base}.sha256 holds no checksum`);

        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const started = Date.now();
        const total = release.sizes?.[base];
        try {
          await source.download(version, base, download, (done) => {
            if (total) job.progress(Math.min(done / total, 1), progressNote(done, total, started));
          });
        } catch (error) {
          rmSync(download, { force: true });
          return failed(`could not download ${base} through ${UPDATE_WAY_LABELS[source.way]}: ${(error as Error).message}`);
        }
        return ok(`downloaded ${base} (${formatBytes(statSync(download).size)}) through ${UPDATE_WAY_LABELS[source.way]}`);
      },
    },
    {
      id: 'verify',
      label: 'Check the checksum',
      run: async () => {
        const actual = sha256File(download);
        if (actual !== expected) {
          rmSync(download, { force: true });
          return failed(`checksum mismatch: expected ${expected}, got ${actual}; the download was deleted`);
        }
        return ok(`sha256 ${actual} matches ${base}.sha256`);
      },
    },
    {
      id: 'unpack',
      label: `Unpack ${version} next to the installed releases`,
      run: async (job) => {
        rmSync(incoming, { recursive: true, force: true });
        mkdirSync(incoming, { recursive: true });
        const r = await ctx.exec('tar', ['-xzf', download, '-C', incoming, '--strip-components=1', '--no-same-owner'], { timeoutMs: 5 * 60_000 });
        if (r.code !== 0) return r;
        if (readRelease(incoming)?.name !== version) {
          rmSync(incoming, { recursive: true, force: true });
          return failed(`${base} is not release ${version}: its release.json says otherwise`);
        }
        if (currentRelease(ctx.dataDir) === version) return failed(`the panel already runs ${version}`);
        rmSync(dest, { recursive: true, force: true });
        renameSync(incoming, dest);
        // Its folder says when it was installed, not when it was built.
        const at = new Date();
        utimesSync(dest, at, at);
        rmSync(download, { force: true });
        job.onUndo(`Remove ${version} from the releases`, async () => {
          if (currentRelease(ctx.dataDir) !== version) rmSync(dest, { recursive: true, force: true });
          return ok(`removed ${dest}`);
        });
        return ok(`unpacked to ${dest}`);
      },
    },
  ];
  if (mode === 'panel') {
    steps.push(switchStep(ctx, version), {
      id: 'restart',
      label: 'Restart the panel',
      run: () => scheduleRestart(ctx, `${version} is installed; the panel restarts in a few seconds`),
    });
  } else if (mode === 'terminal') {
    steps.push({
      id: 'handover',
      label: `Finish ${version} in a terminal`,
      run: async () => ok(`${version} is downloaded and checked. Run ${join(dest, 'install.sh')} in a terminal: it installs the root scripts with your password, switches the panel to ${version} and restarts it`),
    });
  }
  return steps.map(logged);
}

/** After a download for an install with the password: its install.sh must know --from-panel, or it goes in a terminal. */
export function installerCheck(version: string, dir: string): JobStep {
  return {
    id: 'installer',
    label: `Check that ${version}'s installer can run from the panel`,
    run: async () =>
      installsFromPanel(dir)
        ? ok(`${version}'s install.sh installs from the panel`)
        : failed(`${version}'s install.sh cannot install from the panel; it is downloaded, so run ${join(dir, 'install.sh')} in a terminal`),
  };
}

/** Switches the panel to a release that is already installed, like the one before an update, and restarts it. */
export function planSwitch(ctx: UpdateContext, name: string, now = () => new Date()): JobStep[] {
  const { log, logged } = updateLog(ctx, now);
  const first = switchStep(ctx, name);
  const steps: JobStep[] = [
    {
      id: 'unpack',
      label: `Unpack ${name} if it is packed`,
      run: async () => {
        log(`devmagic-panel switch, ${now().toISOString()}, ${currentRelease(ctx.dataDir) ?? ctx.version} to ${name}`);
        try {
          return ok((await unpackRelease(ctx.exec, releasesDir(ctx), name)) ? `unpacked ${name}` : `${name} is unpacked already`);
        } catch (error) {
          return failed((error as Error).message);
        }
      },
    },
    {
      ...first,
      run: async (job) => {
        if (!existsSync(join(releasesDir(ctx), name, 'release.json'))) return failed(`${name} is not in ${releasesDir(ctx)}`);
        return first.run(job);
      },
    },
    { id: 'restart', label: 'Restart the panel', run: () => scheduleRestart(ctx, `switched to ${name}; the panel restarts in a few seconds`) },
  ];
  return steps.map(logged);
}

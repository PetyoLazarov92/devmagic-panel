import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { type PinnedTool, type ToolArch, type ToolId, TOOLS, toolText } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import { download as defaultDownload, type Downloader, mailpitArch, sha256File } from './mailpit.js';
import { progressNote } from './sites/db.js';

/**
 * Tools the panel installs as you (TOOLS in shared): the pinned release,
 * checked against its SHA-256, only its program kept, in the panel's data
 * folder (tools/<id>/<version>/<id>), linked into ~/.local/bin so your own
 * terminal finds it too. Never over a copy you installed: with one on your
 * PATH, the panel uses yours and offers no install. No root anywhere.
 */
export interface ToolPlaces {
  /** The panel's data folder, ~/.local/share/devmagic-panel. */
  dataDir: string;
  home: string;
  /** Where to look for a copy of yours; the panel's PATH when not given. */
  searchPath?: string;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

export const toolsDir = (places: ToolPlaces, id: ToolId): string => join(places.dataDir, 'tools', id);
export const toolDir = (places: ToolPlaces, id: ToolId, version: string = TOOLS[id].version): string => join(toolsDir(places, id), version);
export const toolBin = (places: ToolPlaces, id: ToolId, version?: string): string => join(toolDir(places, id, version), id);
export const toolLink = (places: ToolPlaces, id: ToolId): string => join(places.home, '.local', 'bin', id);

/** True when the link in ~/.local/bin is the panel's, pointing into its tools folder. */
export function panelLink(places: ToolPlaces, id: ToolId): boolean {
  const link = toolLink(places, id);
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return resolve(dirname(link), readlinkSync(link)).startsWith(`${toolsDir(places, id)}/`);
  } catch {
    return false;
  }
}

function isProgram(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A copy of the tool that is not the panel's: on the PATH, or in the folders programs usually go to. */
export function otherCopy(places: ToolPlaces, id: ToolId): string | null {
  const local = join(places.home, '.local', 'bin');
  // The panel's PATH (a user service's is short) and the folders programs usually go to; only the given folders when searchPath is set.
  const listed = places.searchPath !== undefined ? [...places.searchPath.split(delimiter), local] : [...(process.env.PATH ?? '').split(delimiter), '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin', local];
  const dirs = new Set(listed.filter((d) => d.startsWith('/')));
  for (const dir of dirs) {
    const file = join(dir, id);
    if (file === toolLink(places, id) && panelLink(places, id)) continue;
    if (file.startsWith(`${toolsDir(places, id)}/`)) continue;
    if (isProgram(file)) return file;
  }
  return null;
}

/** The program to run: the panel's own copy when it has one, else the name, found on the PATH. */
export function resolveTool(places: ToolPlaces, id: ToolId): string {
  const bin = toolBin(places, id);
  return isProgram(bin) ? bin : id;
}

export function toolArch(arch: string = process.arch): ToolArch | null {
  return mailpitArch(arch);
}

/**
 * Installs a pinned tool: download, check the SHA-256, unpack only its
 * program, check it runs, link it into ~/.local/bin when no other copy is
 * there. Undo removes the link (only the panel's) and the version folder.
 */
export function planInstallTool(
  ctx: { exec: Executor; places: ToolPlaces; download?: Downloader; onInstalled?: (bin: string | null) => void },
  id: ToolId,
  arch: ToolArch | null = toolArch(),
  tool: PinnedTool = TOOLS[id],
): JobStep[] {
  if (!arch) throw new Error(`no ${tool.name} build for this processor (${process.arch})`);
  const other = otherCopy(ctx.places, id);
  if (other) throw new Error(`${tool.name} is installed already at ${other}: the panel uses yours and leaves it as it is`);
  const dir = toolDir(ctx.places, id, tool.version);
  const bin = toolBin(ctx.places, id, tool.version);
  const archive = join(dir, tool.archive === 'zip' ? 'release.zip' : 'release.tar.gz');
  const url = toolText(tool.url, tool, arch);
  const member = toolText(tool.member, tool, arch);
  const fetchFile = ctx.download ?? defaultDownload;
  const link = toolLink(ctx.places, id);
  return [
    {
      id: 'download',
      label: `Download ${tool.name} ${tool.version}`,
      weight: 4,
      run: async (job) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (isProgram(bin)) return ok(`${bin} is already there`);
        const started = Date.now();
        await fetchFile(url, `${archive}.part`, (done, total) => total && job.progress(done / total, progressNote(done, total, started)));
        renameSync(`${archive}.part`, archive);
        return ok(`downloaded ${url}`);
      },
    },
    {
      id: 'verify',
      label: 'Check the checksum',
      run: async () => {
        if (!existsSync(archive)) return ok('nothing new to check');
        const actual = sha256File(archive);
        if (actual !== tool.sha256[arch]) {
          rmSync(archive, { force: true });
          return failed(`checksum mismatch: expected ${tool.sha256[arch]}, got ${actual}; the download was deleted`);
        }
        return ok(`sha256 ${actual} matches ${tool.name} ${tool.version}`);
      },
    },
    {
      id: 'unpack',
      label: `Unpack the ${id} program`,
      run: async (job) => {
        if (existsSync(archive)) {
          // Only the one file, by name: nothing else from the archive lands anywhere.
          const strip = member.split('/').length - 1;
          const r =
            tool.archive === 'zip'
              ? await ctx.exec('unzip', ['-j', '-o', '-q', archive, member, '-d', dir], { timeoutMs: 120_000 })
              : await ctx.exec('tar', ['-xzf', archive, '-C', dir, '--no-same-owner', `--strip-components=${strip}`, member], { timeoutMs: 120_000 });
          rmSync(archive, { force: true });
          if (r.code === 127) return failed('unzip is not installed: install it from Machine checks (Tools, unzip) first');
          if (r.code !== 0) return r;
        }
        if (!existsSync(bin)) return failed(`${member} was not in the archive`);
        chmodSync(bin, 0o755);
        job.onUndo(`Remove ${tool.name} ${tool.version}`, async () => {
          if (panelLink(ctx.places, id)) unlinkSync(link);
          rmSync(dir, { recursive: true, force: true });
          ctx.onInstalled?.(null);
          return ok(`removed ${dir}`);
        });
        const version = await ctx.exec(bin, ['--version'], { timeoutMs: 20_000 });
        if (version.code !== 0) return failed(`${bin} does not run: ${(version.stderr || version.stdout).trim()}`);
        return ok(`${bin}: ${version.stdout.trim().split('\n')[0] ?? ''}`);
      },
    },
    {
      id: 'link',
      label: `Link it into ~/.local/bin`,
      run: async () => {
        ctx.onInstalled?.(bin);
        if (panelLink(ctx.places, id)) unlinkSync(link);
        try {
          lstatSync(link);
          return ok(`note: ${link} is there already and not the panel's, so it stays; the panel runs ${bin}`);
        } catch {
          // Nothing there: the link goes in.
        }
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(bin, link);
        return ok(`${link} -> ${bin}: your terminal finds ${id} after your next login (Ubuntu adds ~/.local/bin to PATH then)`);
      },
    },
  ];
}

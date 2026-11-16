import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import { download as defaultDownload, type Downloader, sha256OfFile } from './mailpit.js';
import { progressNote } from './sites/db.js';

/**
 * Claude Code, installed the way Anthropic's own installer does it
 * (https://claude.ai/install.sh), in the panel's code instead of a shell
 * script: the newest version from downloads.claude.ai, its manifest, the
 * binary for this machine checked against the SHA-256 the manifest gives,
 * then that binary's own `claude install`, which sets up ~/.local/bin/claude
 * and keeps Claude Code updated from then on. As you, no root.
 */
export const CLAUDE_DOWNLOADS = 'https://downloads.claude.ai/claude-code-releases';

/** Reads a short text over HTTPS; injectable for tests. */
export type TextFetch = (url: string) => Promise<string>;

export const fetchText: TextFetch = async (url) => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.text()).trim();
};

/** The manifest's name for this machine: linux-x64 or linux-arm64, with -musl on a musl libc. */
export function claudePlatform(arch: string = process.arch, musl: boolean = isMusl()): string | null {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  return cpu ? `linux-${cpu}${musl ? '-musl' : ''}` : null;
}

function isMusl(): boolean {
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

interface Chosen {
  version: string;
  checksum: string;
  size: number;
}

/** The checksum and size the manifest gives one platform; null when it has none. */
export function manifestEntry(text: string, platform: string): { checksum: string; size: number } | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = (manifest as { platforms?: Record<string, { checksum?: unknown; size?: unknown }> })?.platforms?.[platform];
  const checksum = typeof entry?.checksum === 'string' && /^[0-9a-f]{64}$/.test(entry.checksum) ? entry.checksum : null;
  const size = typeof entry?.size === 'number' && entry.size > 0 ? entry.size : null;
  return checksum && size ? { checksum, size } : null;
}

export function planInstallClaude(ctx: { exec: Executor; home: string; tmpDir: string; fetchText?: TextFetch; download?: Downloader }, platform: string | null = claudePlatform()): JobStep[] {
  if (!platform) throw new Error(`Claude Code has no build for this processor (${process.arch})`);
  const read = ctx.fetchText ?? fetchText;
  let pick: Chosen | null = null;
  const file = () => join(ctx.tmpDir, `claude-${pick?.version ?? 'new'}-${platform}`);
  return [
    {
      id: 'manifest',
      label: "Read the newest version and its manifest from downloads.claude.ai",
      run: async () => {
        const version = await read(`${CLAUDE_DOWNLOADS}/latest`);
        if (!/^\d+\.\d+\.\d+$/.test(version)) return failed('downloads.claude.ai did not answer with a version: it may be unreachable from here, or not offered in your region (https://www.anthropic.com/supported-countries)');
        const entry = manifestEntry(await read(`${CLAUDE_DOWNLOADS}/${version}/manifest.json`), platform);
        if (!entry) return failed(`the manifest of Claude Code ${version} has no build for ${platform}`);
        pick = { version, ...entry };
        return ok(`Claude Code ${version} for ${platform}: ${Math.round(entry.size / 1024 / 1024)} MB, sha256 ${entry.checksum}`);
      },
    },
    {
      id: 'download',
      label: 'Download Claude Code',
      weight: 6,
      run: async (job) => {
        if (!pick) return failed('no version was read');
        mkdirSync(ctx.tmpDir, { recursive: true, mode: 0o700 });
        const started = Date.now();
        // The manifest says how big it is: a download past that stops.
        await (ctx.download ?? defaultDownload)(`${CLAUDE_DOWNLOADS}/${pick.version}/${platform}/claude`, `${file()}.part`, (done, total) => job.progress(done / (total || pick?.size || done), progressNote(done, total || (pick?.size ?? 0), started)), pick.size + 1024 * 1024);
        renameSync(`${file()}.part`, file());
        return ok(`downloaded Claude Code ${pick.version}`);
      },
    },
    {
      id: 'verify',
      label: 'Check it against the manifest',
      run: async () => {
        if (!pick || !existsSync(file())) return failed('nothing was downloaded');
        const actual = await sha256OfFile(file());
        if (actual !== pick.checksum) {
          rmSync(file(), { force: true });
          return failed(`checksum mismatch: the manifest says ${pick.checksum}, the download is ${actual}; it was deleted`);
        }
        return ok(`sha256 ${actual} matches the manifest`);
      },
    },
    {
      id: 'install',
      label: 'Set it up with claude install',
      weight: 2,
      run: async () => {
        if (!pick || !existsSync(file())) return failed('nothing to install');
        chmodSync(file(), 0o755);
        try {
          const r = await ctx.exec(file(), ['install'], { timeoutMs: 10 * 60_000, cwd: ctx.home });
          if (r.code !== 0) return { ...r, stderr: r.stderr.trim() || `claude install ended with ${r.code}` };
        } finally {
          rmSync(file(), { force: true });
        }
        const bin = join(ctx.home, '.local', 'bin', 'claude');
        const version = await ctx.exec(bin, ['--version'], { timeoutMs: 30_000 });
        if (version.code !== 0) return failed(`${bin} does not answer: ${(version.stderr || version.stdout).trim()}`);
        return ok(`${bin}: ${version.stdout.trim()}. Sign it in with claude auth login in a terminal`);
      },
    },
  ];
}

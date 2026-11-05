import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MailMessage, MailPage } from '@devmagic-panel/shared';
import { MAILPIT_SMTP } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';
import type { JobStep } from './jobs.js';
import { formatBytes, progressNote } from './sites/db.js';

/**
 * Mailpit, the local mail catcher Local mode sends every site's mail to. The
 * panel installs a pinned release as the panel user: checked against the
 * checksums GitHub publishes for that release, unpacked into the panel's data
 * folder and run as a systemd user service on 127.0.0.1 only. No root.
 */
export const MAILPIT_RELEASE = {
  version: '1.31.4',
  sha256: {
    amd64: '30942c4605c2ca8b9f759b1bb4e3ab6a12bdfdf66e5c94644ec2c75ac41e88e7',
    arm64: '010a346a8b9d454f6fa22d4fd2dbd5bf5eb7104688412b9c130d0ba33a3579c4',
  },
} as const;

export const MAILPIT_UNIT = 'devmagic-panel-mailpit.service';
export const MAILPIT_API = 'http://127.0.0.1:8025/api/v1';

export type MailpitArch = keyof typeof MAILPIT_RELEASE.sha256;

export function mailpitArch(arch: string = process.arch): MailpitArch | null {
  return arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
}

export interface MailpitPaths {
  dir: string;
  bin: string;
  database: string;
  unitFile: string;
}

export function mailpitPaths(dataDir: string, home: string): MailpitPaths {
  const dir = join(dataDir, 'mailpit');
  return { dir, bin: join(dir, 'mailpit'), database: join(dir, 'mailpit.db'), unitFile: join(home, '.config', 'systemd', 'user', MAILPIT_UNIT) };
}

export function mailpitUnit(paths: MailpitPaths): string {
  return `[Unit]
Description=Mailpit for devmagic-panel: catches mail from local sites
After=network.target

[Service]
ExecStart=${paths.bin} --smtp ${MAILPIT_SMTP.host}:${MAILPIT_SMTP.port} --listen 127.0.0.1:8025 --database ${paths.database}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Downloads a URL to a file, reporting bytes; injectable for tests. */
export type Downloader = (url: string, file: string, onProgress: (done: number, total: number) => void) => Promise<void>;

export const download: Downloader = async (url, file, onProgress) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  let done = 0;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    if (done > 100 * 1024 * 1024) body.destroy(new Error('download is far larger than a Mailpit release'));
    onProgress(done, total);
  });
  await pipeline(body, createWriteStream(file, { mode: 0o600 }));
};

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

export const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Installs (or starts) Mailpit: download the pinned release, check its
 * checksum, unpack only the mailpit binary, write the user service and start it.
 * A binary already in place is checked and reused.
 */
export function planInstallMailpit(
  ctx: { exec: Executor; dataDir: string; home: string; download?: Downloader },
  arch = mailpitArch(),
  release: { version: string; sha256: Record<MailpitArch, string> } = MAILPIT_RELEASE,
): JobStep[] {
  if (!arch) throw new Error(`no Mailpit build for this processor (${process.arch}); install it by hand from https://mailpit.axllent.org/docs/install/`);
  const paths = mailpitPaths(ctx.dataDir, ctx.home);
  const archive = join(paths.dir, `mailpit-linux-${arch}.tar.gz`);
  const url = `https://github.com/axllent/mailpit/releases/download/v${release.version}/mailpit-linux-${arch}.tar.gz`;
  const expected = release.sha256[arch];
  const fetchFile = ctx.download ?? download;
  return [
    {
      id: 'download',
      label: `Download Mailpit ${release.version}`,
      weight: 4,
      run: async (job) => {
        mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
        if (existsSync(paths.bin)) return ok(`${paths.bin} is already there`);
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
        if (actual !== expected) {
          rmSync(archive, { force: true });
          return failed(`checksum mismatch: expected ${expected}, got ${actual}; the download was deleted`);
        }
        return ok(`sha256 ${actual} matches release ${release.version}`);
      },
    },
    {
      id: 'unpack',
      label: 'Unpack the mailpit binary',
      run: async () => {
        if (!existsSync(archive)) return ok('already unpacked');
        // Only the one file, by name: nothing else from the archive lands anywhere.
        const r = await ctx.exec('tar', ['-xzf', archive, '-C', paths.dir, '--no-same-owner', 'mailpit'], { timeoutMs: 60_000 });
        if (r.code !== 0) return r;
        chmodSync(paths.bin, 0o755);
        rmSync(archive, { force: true });
        return ok(`installed ${paths.bin} (${formatBytes(Number(readFileSync(paths.bin).length))})`);
      },
    },
    {
      id: 'service',
      label: 'Start Mailpit as a user service',
      run: async () => {
        mkdirSync(join(paths.unitFile, '..'), { recursive: true });
        writeFileSync(paths.unitFile, mailpitUnit(paths));
        const results = [await ctx.exec('systemctl', ['--user', 'daemon-reload'])];
        if (results[0]?.code === 0) results.push(await ctx.exec('systemctl', ['--user', 'enable', '--now', MAILPIT_UNIT]));
        return results;
      },
    },
  ];
}

// ── reading mail ─────────────────────────────────────────────

/** Talks to Mailpit's API on 127.0.0.1; injectable for tests. */
export type MailpitFetch = (path: string, init?: { method?: string; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const mailpitFetch: MailpitFetch = (path, init) =>
  fetch(`${MAILPIT_API}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });

interface ApiAddress {
  Name?: string;
  Address?: string;
}
interface ApiSummary {
  ID: string;
  From?: ApiAddress;
  To?: ApiAddress[] | null;
  Subject?: string;
  Created?: string;
  Snippet?: string;
  Tags?: string[] | null;
  Read?: boolean;
}

const address = (a?: ApiAddress) => (a?.Name ? `${a.Name} <${a.Address ?? ''}>` : (a?.Address ?? ''));

/** Local mode tags each message with the site it came from (X-Tags), so a site's mail is a tag search. */
export const siteQuery = (site: string) => `tag:"${site}"`;

export async function listMail(get: MailpitFetch, site: string | undefined, start = 0, limit = 50): Promise<MailPage> {
  const path = site ? `/search?query=${encodeURIComponent(siteQuery(site))}&start=${start}&limit=${limit}` : `/messages?start=${start}&limit=${limit}`;
  const res = await get(path);
  if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
  const data = (await res.json()) as { total?: number; messages_count?: number; messages?: ApiSummary[] };
  return {
    total: data.messages_count ?? data.total ?? 0,
    messages: (data.messages ?? []).map((m) => ({
      id: m.ID,
      from: address(m.From),
      to: (m.To ?? []).map(address),
      subject: m.Subject ?? '',
      date: m.Created ?? '',
      snippet: m.Snippet ?? '',
      site: (m.Tags ?? []).find((t) => t.includes('.')) ?? null,
      read: Boolean(m.Read),
    })),
  };
}

/** How many messages nobody has opened yet, in the panel or in Mailpit: Mailpit counts them (opening one marks it read). */
export async function unreadMail(get: MailpitFetch): Promise<number> {
  const res = await get('/messages?start=0&limit=1');
  if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
  const data = (await res.json()) as { unread?: number };
  return typeof data.unread === 'number' ? data.unread : 0;
}

export async function readMail(get: MailpitFetch, id: string): Promise<MailMessage | null> {
  const res = await get(`/message/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
  const m = (await res.json()) as ApiSummary & { To?: ApiAddress[]; Date?: string; Text?: string; HTML?: string };
  return { id: m.ID, from: address(m.From), to: (m.To ?? []).map(address), subject: m.Subject ?? '', date: m.Date ?? '', text: m.Text ?? '', html: m.HTML ?? '' };
}

/** Deletes a site's mail, or all of it. */
export async function clearMail(get: MailpitFetch, site?: string): Promise<ExecResult> {
  const res = site ? await get(`/search?query=${encodeURIComponent(siteQuery(site))}`, { method: 'DELETE' }) : await get('/messages', { method: 'DELETE', body: '{}' });
  return res.ok ? ok(site ? `deleted the mail from ${site}` : 'deleted all mail') : failed(`Mailpit answered ${res.status}`);
}

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { SSH_KEY_NAME, type SshKey } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from './exec.js';
import { deviceFlow } from './github-access.js';
import type { JobStep } from './jobs.js';
import { GH_ENV, ghBinary } from './repo-hosts/github.js';

/**
 * SSH keys for GitHub: the panel lists the keys in ~/.ssh (and under WSL in
 * Windows' %USERPROFILE%\.ssh), tests each one alone against GitHub, makes a
 * new one, copies a Windows key in, or adds a key to GitHub through gh. It
 * works with file names and public keys only: the private key is passed to
 * ssh and ssh-keygen by path, copied by the file system, and never read into
 * the panel or sent anywhere.
 */
export interface SshPlaces {
  home: string;
  /** A folder of the panel's for short-lived copies (a Windows key tested at 0600). */
  tmpDir: string;
  /** Windows' %USERPROFILE% as this distro sees it, under WSL. */
  windowsProfile?: string | null;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

export const sshDir = (home: string): string => join(home, '.ssh');

/** Files a .ssh folder has that are never keys. */
const NOT_A_KEY = /^(known_hosts|config|authorized_keys|environment|rc)(\b|[._-])|\.pub$|\.removed-|\.bak|\.old$|\.orig$|\.ppk$/i;

/** The private key files in a .ssh folder, by name, small regular files only. */
export function keyFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => SSH_KEY_NAME.test(name) && !NOT_A_KEY.test(name))
    .filter((name) => {
      try {
        const s = statSync(join(dir, name));
        return s.isFile() && s.size > 0 && s.size < 20_000;
      } catch {
        return false;
      }
    })
    .sort();
}

/** "256 SHA256:abc... alex@laptop (ED25519)" from ssh-keygen -l; null for a file that is no key. */
export function keyFacts(line: string): Pick<SshKey, 'bits' | 'fingerprint' | 'comment' | 'type'> | null {
  const m = /^(\d+) (SHA256:\S+) (.*) \(([A-Z0-9-]+)\)$/.exec(line.trim());
  if (!m) return null;
  return { bits: Number(m[1]), fingerprint: m[2] as string, type: m[4] as string, ...(m[3] && m[3] !== 'no comment' ? { comment: m[3] } : {}) };
}

/** The key files a Host block matching github.com names (IdentityFile), by file name. */
export function githubIdentities(config: string): string[] {
  const names: string[] = [];
  let matches = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (key === 'host') {
      const patterns = value.split(/\s+/);
      const hit = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test('github.com');
      matches = patterns.some((p) => !p.startsWith('!') && hit(p)) && !patterns.some((p) => p.startsWith('!') && hit(p.slice(1)));
    } else if (key === 'match') {
      matches = false;
    } else if (matches && key === 'identityfile') {
      names.push(basename(value.replace(/^"|"$/g, '').replaceAll('\\', '/')));
    }
  }
  return names;
}

/** The GitHub account that knows this key alone; null when GitHub refuses it. */
export async function githubUserOf(exec: Executor, file: string): Promise<string | null> {
  const r = await exec('ssh', ['-T', '-i', file, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', 'git@github.com'], { timeoutMs: 15_000 });
  return /Hi ([A-Za-z0-9-]+)! You've successfully authenticated/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null;
}

/** The public key of a key without a passphrase (ssh-keygen -y), or null: it has one, or it is no key. */
export async function publicWithoutPassphrase(exec: Executor, file: string): Promise<string | null> {
  const r = await exec('ssh-keygen', ['-y', '-P', '', '-f', file], { timeoutMs: 10_000 });
  return r.code === 0 && /^(ssh|ecdsa|sk)-\S+ \S+/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

async function inspect(exec: Executor, name: string, file: string, where: SshKey['where'], pubFile: string): Promise<SshKey | null> {
  const facts = keyFacts((await exec('ssh-keygen', ['-l', '-f', file], { timeoutMs: 10_000 })).stdout);
  if (!facts) return null;
  const derived = await publicWithoutPassphrase(exec, file);
  const passphrase = derived === null;
  let publicKey: string | undefined;
  if (where === 'here') {
    try {
      publicKey = existsSync(pubFile) ? readFileSync(pubFile, 'utf8').trim() : (derived ?? undefined);
    } catch {
      publicKey = derived ?? undefined;
    }
  }
  return { name, where, ...facts, passphrase, ...(passphrase ? {} : { github: await githubUserOf(exec, file) }), ...(publicKey ? { publicKey } : {}) };
}

/** Every key here and in Windows' .ssh, tested. A Windows key is tested on a 0600 copy (ssh refuses /mnt/c's open modes), removed after. */
export async function listSshKeys(exec: Executor, places: SshPlaces): Promise<SshKey[]> {
  const here = sshDir(places.home);
  const windowsDir = places.windowsProfile ? join(places.windowsProfile, '.ssh') : null;
  const hereNames = keyFiles(here);
  const windowsNames = windowsDir ? keyFiles(windowsDir) : [];
  let forGithub: string[] = [];
  if (windowsDir) {
    try {
      forGithub = githubIdentities(readFileSync(join(windowsDir, 'config'), 'utf8'));
    } catch {
      forGithub = [];
    }
  }
  mkdirSync(places.tmpDir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(places.tmpDir, 'ssh-keys-'));
  try {
    const found = await Promise.all([
      ...hereNames.map((name) => inspect(exec, name, join(here, name), 'here', join(here, `${name}.pub`))),
      ...windowsNames.map(async (name) => {
        const copy = join(tmp, name);
        copyFileSync(join(windowsDir as string, name), copy);
        chmodSync(copy, 0o600);
        const key = await inspect(exec, name, copy, 'windows', '');
        if (!key) return null;
        const copiedAs = `windows-${name}`;
        return { ...key, ...(forGithub.includes(name) ? { windowsForGithub: true } : {}), ...(hereNames.includes(copiedAs) ? { copiedAs } : {}) };
      }),
    ]);
    return found.filter((k): k is SshKey => k !== null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Moves a key and its .pub aside (never deleted): <name>.removed-<stamp>. */
function putAside(dir: string, name: string): string {
  const aside = `${name}.removed-${stamp()}`;
  renameSync(join(dir, name), join(dir, aside));
  if (existsSync(join(dir, `${name}.pub`))) renameSync(join(dir, `${name}.pub`), join(dir, `${aside}.pub`));
  return aside;
}

function readySshDir(home: string): string {
  const dir = sshDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** A new ed25519 key without a passphrase, never over a key: id_ed25519, else id_ed25519_devmagic(2, 3...). */
export function planMakeSshKey(ctx: { exec: Executor; home: string; chosen: (name: string | null) => void }): JobStep[] {
  return [
    {
      id: 'make',
      label: 'Make an ed25519 key without a passphrase',
      run: async (job) => {
        const dir = readySshDir(ctx.home);
        const free = ['id_ed25519', 'id_ed25519_devmagic', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `id_ed25519_devmagic${n}`)].find((n) => !existsSync(join(dir, n)) && !existsSync(join(dir, `${n}.pub`)));
        if (!free) return failed(`${dir} has no free name for a new key`);
        const comment = `${userInfo().username}@${hostname()} (devmagic-panel)`;
        const r = await ctx.exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', join(dir, free)], { timeoutMs: 30_000 });
        if (r.code !== 0) return r;
        ctx.chosen(free);
        job.onUndo(`Put ${free} aside`, async () => {
          ctx.chosen(null);
          return ok(`moved ${free} to ${putAside(dir, free)}`);
        });
        const pub = readFileSync(join(dir, `${free}.pub`), 'utf8').trim();
        return ok(`made ${join(dir, free)}; the panel clones GitHub repos with it. Add its public key to GitHub (Add to GitHub, or https://github.com/settings/ssh/new):\n${pub}`);
      },
    },
  ];
}

/** A Windows key without a passphrase, copied here as windows-<name> (0600), then used for GitHub. */
export function planCopyWindowsKey(ctx: { exec: Executor; home: string; windowsProfile: string | null; chosen: (name: string | null) => void }, name: string): JobStep[] {
  return [
    {
      id: 'copy',
      label: `Copy the Windows key ${name} into this distro`,
      run: async (job) => {
        if (!ctx.windowsProfile) return failed("Windows' user folder cannot be read from here: the panel needs WSL's interop to find it");
        const from = join(ctx.windowsProfile, '.ssh');
        if (!keyFiles(from).includes(name)) return failed(`${name} is not a key in ${from}`);
        const dir = readySshDir(ctx.home);
        const copiedAs = `windows-${name}`;
        const to = join(dir, copiedAs);
        if (existsSync(to) || existsSync(`${to}.pub`)) return failed(`${to} is there already: use it from the list`);
        const part = `${to}.part`;
        copyFileSync(join(from, name), part);
        chmodSync(part, 0o600);
        const pub = await publicWithoutPassphrase(ctx.exec, part);
        if (!pub) {
          rmSync(part, { force: true });
          return failed(`${name} has a passphrase (or is no key), which the panel cannot type: nothing was copied. Make a new key here instead, or use it from Windows`);
        }
        renameSync(part, to);
        writeFileSync(`${to}.pub`, `${pub}\n`, { mode: 0o644 });
        ctx.chosen(copiedAs);
        job.onUndo(`Put ${copiedAs} aside`, async () => {
          ctx.chosen(null);
          return ok(`moved ${copiedAs} to ${putAside(dir, copiedAs)}`);
        });
        return ok(`copied to ${to}; the panel clones GitHub repos with it`);
      },
    },
  ];
}

/** Token scopes from gh auth status ("Token scopes: 'gist', 'read:org', 'repo'"). */
export function tokenScopes(status: string): string[] {
  return (/Token scopes: (.*)$/m.exec(status)?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

/** A key here added to your GitHub account through gh: first the right to add keys (a device sign-in), then gh ssh-key add. */
export function planAddSshKey(ctx: { exec: Executor; home: string }, name: string): JobStep[] {
  const file = join(sshDir(ctx.home), name);
  const gh = (args: string[], timeoutMs = 60_000) => ctx.exec(ghBinary(), args, { timeoutMs, env: GH_ENV });
  return [
    {
      id: 'scope',
      label: 'Let the GitHub CLI add SSH keys to your account',
      run: async (job) => {
        if (!existsSync(`${file}.pub`)) return failed(`${file}.pub is not there`);
        const status = await gh(['auth', 'status', '--hostname', 'github.com'], 20_000);
        if (/not logged|auth login/i.test(`${status.stdout}${status.stderr}`)) return failed('the GitHub CLI is not signed in: Sign in to GitHub first');
        const scopes = tokenScopes(`${status.stdout}\n${status.stderr}`);
        if (scopes.includes('admin:public_key') || scopes.includes('write:public_key')) return ok('gh may add SSH keys already');
        return deviceFlow(ctx.exec, job, ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'admin:public_key'], 'gh may add SSH keys now');
      },
    },
    {
      id: 'add',
      label: `Add ${name} to your GitHub account`,
      run: async () => {
        const r = await gh(['ssh-key', 'add', `${file}.pub`, '--title', `${hostname()} (devmagic-panel)`]);
        if (r.code !== 0 && /already exists|key is already in use/i.test(`${r.stdout}${r.stderr}`)) return ok('GitHub has this key already');
        return r.code === 0 ? ok(`added ${name}.pub to your GitHub account`) : r;
      },
    },
    {
      id: 'check',
      label: 'Check GitHub knows it',
      run: async () => {
        const user = await githubUserOf(ctx.exec, file);
        return user ? ok(`GitHub knows ${name} as ${user}`) : failed(`GitHub does not answer to ${name} yet: try Check again in a minute`);
      },
    },
  ];
}

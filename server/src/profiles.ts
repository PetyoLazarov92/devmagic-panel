import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { ProfileFunction, ProfileInfo, ProfileList, ProfileSummary } from '@devmagic-panel/shared';
import { PHP_VERSION_PATTERN, PROFILE_KEEP_DAYS, PROFILE_NAME, profileGroup, xdebugNamePart } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import type { ExecResult } from './exec.js';

/**
 * Xdebug's profiles, from the folder dmp-root xdebug-enable gives each PHP
 * version ($STATE_DIR/profiles/<version>, the panel user's): listed per
 * site by the host in their name, read as a summary (the file is streamed,
 * gzipped or not, and the summary kept in the panel's data folder), sent as
 * they are for KCachegrind or an IDE, and deleted after PROFILE_KEEP_DAYS.
 * A file is only ever named from this folder's listing, never from a path
 * the browser sends.
 */

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const TOP = 60;
const KEEP_MS = PROFILE_KEEP_DAYS * 24 * 3600_000;

export const profilesDir = (config: SystemConfig) => join(config.STATE_DIR, 'profiles');
const cacheDir = (dataDir: string) => join(dataDir, 'profiles');

/** The versions whose profiles come to the panel's folder. */
function versions(config: SystemConfig): string[] {
  const dir = profilesDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((v) => PHP_VERSION_PATTERN.test(v) && statSync(join(dir, v)).isDirectory()).sort();
}

/**
 * The host and the request in what follows a profile's time: the longest
 * known host the name starts with, as Xdebug writes it (dots as _) or as it
 * is; with none known, up to the first _ that starts the request.
 */
function splitHost(rest: string, known: readonly string[]): { host: string; request: string } {
  let best: { host: string; length: number } | null = null;
  for (const host of known) {
    for (const form of [xdebugNamePart(host), host]) {
      if ((rest === form || rest.startsWith(`${form}_`)) && (!best || form.length > best.length)) best = { host, length: form.length };
    }
  }
  if (best) return { host: best.host, request: rest.slice(best.length) };
  // A host with its dots, as some Xdebug versions write it: it ends at the first _.
  const dotted = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(_.*)?$/.exec(rest);
  if (dotted) return { host: dotted[1] as string, request: dotted[2] ?? '' };
  const cut = rest.indexOf('__') >= 0 ? rest.indexOf('__') : rest.length;
  return { host: rest.slice(0, cut), request: rest.slice(cut) };
}

/** A profile's facts from its name, or null for a file that is not one of the panel's; known are the hosts of every site, to tell the host from the request. */
export function parseProfileName(version: string, name: string, known: readonly string[] = []): Omit<ProfileInfo, 'bytes'> | null {
  const m = PROFILE_NAME.exec(name);
  if (!m) return null;
  const at = new Date(Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000));
  if (Number.isNaN(at.getTime())) return null;
  const { host, request } = splitHost(m[3] ?? '', known);
  return { version, name, at: at.toISOString(), host, request: request.replace(/^_/, '/') };
}

/** The file of a profile, checked: a version and a name that Xdebug wrote, in the panel's folder. */
export function profileFile(config: SystemConfig, version: string, name: string): string {
  if (!PHP_VERSION_PATTERN.test(version) || !PROFILE_NAME.test(name)) throw new ProfileError('A PHP version like 8.3 and a profile name like cachegrind.out.1762500000_123456.local.wandworks.example_');
  const file = join(profilesDir(config), version, name);
  if (!existsSync(file)) throw new ProfileError(`No profile ${name} for PHP ${version}`, 404);
  return file;
}

const summaryFile = (dataDir: string, version: string, name: string) => join(cacheDir(dataDir), `${version}-${name.replace(/\.gz$/, '')}.json`);

function cachedSummary(dataDir: string, version: string, name: string): ProfileSummary | null {
  try {
    return JSON.parse(readFileSync(summaryFile(dataDir, version, name), 'utf8')) as ProfileSummary;
  } catch {
    return null;
  }
}

/**
 * The profiles of the hosts given (a site's domain and aliases; every one
 * when none), newest first. Profiles older than PROFILE_KEEP_DAYS go first,
 * with their summaries.
 */
export function listProfiles(config: SystemConfig, dataDir: string, hosts: string[] = [], pathPrefix = '', now = Date.now(), known: readonly string[] = hosts): ProfileList {
  const found = versions(config);
  const profiles: ProfileInfo[] = [];
  for (const version of found) {
    const dir = join(profilesDir(config), version);
    for (const name of readdirSync(dir)) {
      const info = parseProfileName(version, name, known);
      if (!info) {
        // Traces and GC stats Xdebug writes next to the profiles go after the same days.
        if (/^(trace|gcstats)\./.test(name)) {
          const other = join(dir, name);
          if (now - statSync(other).mtimeMs > KEEP_MS) rmSync(other, { force: true });
        }
        continue;
      }
      const file = join(dir, name);
      const stat = statSync(file);
      if (now - stat.mtimeMs > KEEP_MS) {
        rmSync(file, { force: true });
        rmSync(summaryFile(dataDir, version, name), { force: true });
        continue;
      }
      if (hosts.length && !hosts.includes(info.host)) continue;
      // A site under a path: Xdebug turns its /learn into _learn.
      if (pathPrefix && !(info.request === pathPrefix || info.request.startsWith(`${pathPrefix}_`) || info.request.startsWith(`${pathPrefix}/`))) continue;
      const cached = cachedSummary(dataDir, version, name);
      profiles.push({ ...info, bytes: stat.size, ...(cached ? { totalMs: cached.totalMs, ...(cached.peakBytes !== undefined ? { peakBytes: cached.peakBytes } : {}) } : {}) });
    }
  }
  profiles.sort((a, b) => b.at.localeCompare(a.at));
  return { profiles, versions: found };
}

interface Fn {
  name: string;
  file: string;
  self: number;
  called: number;
  calls: number;
  callers: Map<string, number>;
}

/**
 * Reads a cachegrind file as Xdebug writes it: fl= and fn= open a
 * function (with names compressed as "(12) name" the first time and "(12)"
 * after), the cost lines under it are its own time, and a calls= line says
 * the cost line after it is the time of that call, everything under it
 * included. Times are in the unit the events line names.
 */
export async function parseCachegrind(input: Readable): Promise<Omit<ProfileSummary, keyof ProfileInfo> & { totalMs: number; peakBytes?: number }> {
  const files = new Map<string, string>();
  const names = new Map<string, string>();
  const fns = new Map<string, Fn>();
  const expand = (table: Map<string, string>, value: string) => {
    const m = /^\((\d+)\)(?: (.*))?$/.exec(value);
    if (!m) return value;
    if (m[2] !== undefined) table.set(m[1] as string, m[2]);
    return table.get(m[1] as string) ?? value;
  };
  const fnFor = (file: string, name: string) => {
    const key = `${file}\n${name}`;
    let fn = fns.get(key);
    if (!fn) {
      fn = { name, file, self: 0, called: 0, calls: 0, callers: new Map() };
      fns.set(key, fn);
    }
    return fn;
  };
  let toMs = 1 / 100_000;
  let script = '';
  let summary: number[] = [];
  let file = '';
  let current: Fn | null = null;
  let calleeFile = '';
  let callee: Fn | null = null;
  let callCount = 0;
  let nextIsCall = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    const key = eq > 0 && eq < 6 ? line.slice(0, eq) : '';
    if (key === 'fl' || key === 'fi' || key === 'fe') {
      file = expand(files, line.slice(eq + 1));
      continue;
    }
    if (key === 'fn') {
      current = fnFor(file, expand(names, line.slice(eq + 1)));
      calleeFile = file;
      continue;
    }
    if (key === 'cfl' || key === 'cfi') {
      calleeFile = expand(files, line.slice(eq + 1));
      continue;
    }
    if (key === 'cfn') {
      callee = fnFor(calleeFile, expand(names, line.slice(eq + 1)));
      continue;
    }
    if (key === 'calls') {
      callCount = Number(line.slice(eq + 1).split(' ')[0]) || 0;
      nextIsCall = true;
      continue;
    }
    if (/^\d/.test(line) || line.startsWith('+') || line.startsWith('-') || line.startsWith('*')) {
      const time = Number(line.split(' ')[1]) || 0;
      if (nextIsCall && current && callee) {
        current.called += time;
        callee.calls += callCount;
        callee.callers.set(current.name, (callee.callers.get(current.name) ?? 0) + callCount);
        nextIsCall = false;
      } else if (current) {
        current.self += time;
      }
      continue;
    }
    if (line.startsWith('events:')) {
      toMs = /10ns/.test(line) ? 1 / 100_000 : /µs|us\b|microsec/i.test(line) ? 1 / 1000 : /ns/.test(line) ? 1 / 1_000_000 : 1 / 100_000;
      continue;
    }
    if (line.startsWith('cmd:')) {
      script = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('summary:')) {
      summary = line.slice(8).trim().split(/\s+/).map(Number);
    }
  }
  const all = [...fns.values()];
  // {main} has no caller: the whole request is its time with everything under it.
  const main = all.find((f) => f.name === '{main}');
  const totalMs = (summary[0] ?? (main ? main.self + main.called : all.reduce((t, f) => t + f.self, 0))) * toMs;
  const groupOf = (f: Fn): string => {
    const own = profileGroup(f.file);
    if (own !== 'PHP') return own;
    // PHP's own functions count with the code that calls them most.
    const top = [...f.callers.entries()].sort((a, b) => b[1] - a[1])[0];
    const caller = top ? all.find((c) => c.name === top[0]) : undefined;
    return caller && caller !== f ? profileGroup(caller.file) : 'PHP';
  };
  const groups = new Map<string, number>();
  for (const f of all) groups.set(groupOf(f), (groups.get(groupOf(f)) ?? 0) + f.self * toMs);
  const round = (n: number) => Math.round(n * 100) / 100;
  const functions: ProfileFunction[] = all
    .sort((a, b) => b.self - a.self)
    .slice(0, TOP)
    .map((f) => ({
      name: f.name,
      file: f.file,
      group: groupOf(f),
      calls: f.calls || (f.name === '{main}' ? 1 : 0),
      selfMs: round(f.self * toMs),
      totalMs: round((f.self + f.called) * toMs),
      callers: [...f.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, calls]) => ({ name, calls })),
    }));
  return {
    script,
    totalMs: round(totalMs),
    ...(summary[1] !== undefined && Number.isFinite(summary[1]) ? { peakBytes: summary[1] } : {}),
    groups: [...groups.entries()].map(([group, selfMs]) => ({ group, selfMs: round(selfMs) })).filter((g) => g.selfMs > 0).sort((a, b) => b.selfMs - a.selfMs),
    functions,
    functionCount: all.length,
  };
}

/** A profile's summary, read once and kept in the panel's data folder. */
export async function profileSummary(config: SystemConfig, dataDir: string, version: string, name: string): Promise<ProfileSummary> {
  const file = profileFile(config, version, name);
  const cached = cachedSummary(dataDir, version, name);
  if (cached) return cached;
  const info = parseProfileName(version, name) as Omit<ProfileInfo, 'bytes'>;
  const raw = createReadStream(file);
  const stream = name.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  let parsed: Awaited<ReturnType<typeof parseCachegrind>>;
  try {
    parsed = await parseCachegrind(stream);
  } catch (error) {
    throw new ProfileError(`Could not read ${name}: ${(error as Error).message}`, 422);
  } finally {
    raw.destroy();
  }
  const summary: ProfileSummary = { ...info, bytes: statSync(file).size, ...parsed };
  mkdirSync(cacheDir(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(summaryFile(dataDir, version, name), JSON.stringify(summary), { mode: 0o600 });
  return summary;
}

/** Deletes profiles and their summaries; a name that is not there any more counts as gone. */
export function deleteProfiles(config: SystemConfig, dataDir: string, items: Array<{ version: string; name: string }>): ExecResult {
  let gone = 0;
  for (const { version, name } of items) {
    if (!PHP_VERSION_PATTERN.test(version) || !PROFILE_NAME.test(name)) throw new ProfileError(`Not a profile: ${version}/${name}`);
    rmSync(join(profilesDir(config), version, name), { force: true });
    rmSync(summaryFile(dataDir, version, name), { force: true });
    gone += 1;
  }
  return { code: 0, stdout: `deleted ${gone} profile${gone === 1 ? '' : 's'}\n`, stderr: '' };
}

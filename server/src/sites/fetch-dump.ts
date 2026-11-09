import { createWriteStream } from 'node:fs';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DUMP_EXTENSION, type DumpType, SNIFF_BYTES, sniffDump, typeByName } from './dump-type.js';

/**
 * Downloads a dump from a public HTTPS address with Node's own https, no
 * curl and no shell: HTTPS only, no user name or password in the address,
 * at most five redirects (each checked again), never an address on this
 * computer or a private network (checked on the address actually connected
 * to), a size cap checked before and while it streams, and the type read
 * from the first bytes. The address's query (signed links carry tokens
 * there) is never stored or logged: see `shownUrl`.
 */

export class FetchRefused extends Error {}

/** Addresses a download never reaches: this computer, private networks, link-local, CGNAT, multicast and reserved. */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) BLOCKED.addSubnet(net, bits, 'ipv6');

/** Whether an address is out on the internet, not this computer or a private network. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return isPublicAddress(mapped);
    return !BLOCKED.check(address, 'ipv6');
  }
  return !BLOCKED.check(address, 'ipv4');
}

/** The address as it may be shown and kept: no query, no fragment. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? '?(hidden)' : ''}`;
  } catch {
    return '(not a URL)';
  }
}

/** Why an address cannot be downloaded from, or null: HTTPS, a host name, no user name or password, not this computer. */
export function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Not a URL';
  }
  if (u.protocol !== 'https:') return 'Only https:// addresses';
  if (u.username || u.password) return 'No user name or password in the address';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) return 'Not an address on this computer or a private network';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || !host.includes('.')) return 'Not a name on this computer or a local network';
  return null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS that refuses a name with any address that is not public, so a name cannot point a download at this computer. */
export function publicLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      const refused = Object.assign(new Error(`${hostname} points at ${bad?.address ?? 'nothing'}, which is not on the internet`), { code: 'EREFUSED' });
      return callback(refused, '');
    }
    if (options.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}

/** One answer of the server: its status, headers and body. */
export interface Hop {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** Asks for one address; the real one is `httpsGet`, tests pass their own. */
export type Getter = (url: URL, signal: AbortSignal) => Promise<Hop>;

/** GET over HTTPS with the public-only lookup, a 30 second wait for the server and two minutes of quiet at most. */
export const httpsGet: Getter = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup: publicLookup as never, signal, headers: { 'user-agent': 'devmagic-panel', accept: '*/*' } }, (res) => {
      res.setTimeout(120_000, () => res.destroy(new Error('the server stopped sending for two minutes')));
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('the server did not answer in 30 seconds')));
    req.on('error', reject);
    req.end();
  });

/** A file name from Content-Disposition, or the address's last part. */
export function nameFrom(url: URL, disposition: string | undefined): string {
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '')?.[1];
  let name = '';
  try {
    name = decodeURIComponent(star ?? plain ?? url.pathname.split('/').pop() ?? '');
  } catch {
    name = plain ?? '';
  }
  return name.split(/[\\/]/).pop()?.trim() ?? '';
}

/** A name that says the type the bytes have: dump.sql.gz for a gzip whose address said nothing. */
export function nameForType(name: string, type: DumpType): string {
  const said = typeByName(name);
  if (said === type) return name;
  const base = name.replace(/\.(sql\.gz|sql|gz|zip)$/i, '') || 'dump';
  return `${base}${DUMP_EXTENSION[type]}`;
}

export interface FetchResult {
  name: string;
  size: number;
  type: DumpType;
}

/**
 * Streams the dump at `url` into `file` (a .part file the caller renames),
 * following redirects, refusing anything but a dump, and stopping at
 * `maxBytes`. `beforeBody` gets the size the server announces, to check the
 * free space before a byte is written.
 */
export async function fetchDump(
  url: string,
  file: string,
  options: { maxBytes: number; get?: Getter; signal?: AbortSignal; onBytes?: (done: number, total: number | null) => void; beforeBody?: (total: number | null) => void; maxMs?: number },
): Promise<FetchResult> {
  const get = options.get ?? httpsGet;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('the download took longer than three hours')), options.maxMs ?? 3 * 3_600_000);
  const onAbort = () => stop.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort);
  try {
    let at = new URL(url);
    for (let hop = 0; ; hop += 1) {
      const problem = urlProblem(at.href);
      if (problem) throw new FetchRefused(`${shownUrl(at.href)}: ${problem}`);
      const res = await get(at, stop.signal);
      if (res.status >= 300 && res.status < 400) {
        res.body.resume();
        const location = res.headers.location;
        if (typeof location !== 'string' || !location) throw new FetchRefused(`${shownUrl(at.href)} redirects nowhere`);
        if (hop >= 5) throw new FetchRefused('more than five redirects');
        at = new URL(location, at);
        continue;
      }
      if (res.status !== 200) {
        res.body.resume();
        throw new FetchRefused(`${shownUrl(at.href)} answered ${res.status}${res.status === 401 || res.status === 403 ? ': it is not public, download it in the browser and pick it from your Downloads folder' : ''}`);
      }
      const announced = Number(res.headers['content-length']);
      const total = Number.isFinite(announced) && announced > 0 ? announced : null;
      if (total !== null && total > options.maxBytes) {
        res.body.destroy();
        throw new FetchRefused(`the file is ${Math.round(total / 1024 ** 3)} GB, more than the ${Math.round(options.maxBytes / 1024 ** 3)} GB the panel takes`);
      }
      options.beforeBody?.(total);
      let done = 0;
      let head: Buffer | null = Buffer.alloc(0);
      let type: DumpType | null = null;
      const check = new Transform({
        transform(chunk: Buffer, _enc, next) {
          done += chunk.length;
          if (done > options.maxBytes) return next(new FetchRefused(`the file is larger than the ${Math.round(options.maxBytes / 1024 ** 3)} GB the panel takes`));
          options.onBytes?.(done, total);
          if (head) {
            head = Buffer.concat([head, chunk]);
            if (head.length < SNIFF_BYTES) return next();
            type = sniffDump(head.subarray(0, SNIFF_BYTES));
            if (!type) return next(new FetchRefused('this is not a database dump: it does not start like SQL, a gzip or a zip (a sign-in or download page, maybe: download it in the browser instead)'));
            const out = head;
            head = null;
            return next(null, out);
          }
          next(null, chunk);
        },
        flush(next) {
          if (head) {
            type = sniffDump(head);
            if (!type) return next(new FetchRefused('this is not a database dump: it does not start like SQL, a gzip or a zip'));
            this.push(head);
          }
          next();
        },
      });
      await pipeline(res.body, check, createWriteStream(file, { mode: 0o600 }), { signal: stop.signal });
      const found = type as DumpType | null;
      if (!found) throw new FetchRefused('the server sent nothing');
      return { name: nameForType(nameFrom(at, typeof res.headers['content-disposition'] === 'string' ? res.headers['content-disposition'] : undefined), found), size: done, type: found };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { DumpFacts } from '@devmagic-panel/shared';
import { DUMP_SCAN_GB } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import { freeSpace } from './space.js';

export type { DumpFacts };

// Most dumps are read to the end, where the users are; a larger one stops here and its admins stay unknown.
const SCAN_LIMIT = DUMP_SCAN_GB * 1024 ** 3;
const OVERLAP = 8 * 1024;
/** More hosts with http links than this, and the dump is taken to have them for every host. */
const MAX_HTTP_HOSTS = 2000;
// A statement at the start of a line, where a dump's statements begin; rows never hold a raw newline.
const LINE_STATEMENT = /^(?:(?:INSERT|REPLACE)\b[^\n(]*?\bINTO|CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?)\s+([^\s(]+)/gim;
// A host after two slashes, plain, JSON-escaped or escaped again inside SQL. It starts at a slash, which the
// regex engine finds fast; whether http: is before it is looked up after.
const URL_HOST = /\/(?:\\*\/)([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?/gi;
const HTTP_BEFORE = /http:\\*$/i;
// A view, trigger, procedure, function or event, as mysqldump and others write them, at the start of a line.
const STORED_OBJECT = /^(?:\/\*!\d+\s*)?(?:CREATE\b[^\n]{0,300}?\b(?:VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\b|(?:VIEW|TRIGGER)\b|DELIMITER\b)/im;
/** More hosts than this in one table, and it is taken to have every host. */
const MAX_TABLE_HOSTS = 500;
/** More host entries than this in all, and the dump says nothing per table. */
const MAX_HOST_ENTRIES = 10_000;
/** What a scan carries from one chunk to the next, so a host or statement cut in two is still read. */
const CARRY = 600;
/** A table that has more hosts than are kept: every pass looks at it. */
export const ANY_HOST = '*';

/**
 * Which hosts each table a dump creates has in its rows after two slashes,
 * the way search and replace finds them (//host, http://host, //host/path),
 * and the http:// hosts of the whole dump. A table is only counted as the
 * dump's when a plain CREATE TABLE makes it, which fails unless it starts
 * empty; one created with IF NOT EXISTS can keep rows the dump never had. A
 * statement the scan cannot name the table of makes the result unknown, so
 * nothing is skipped on its word.
 */
export class TableHosts {
  private readonly hosts = new Map<string, Set<string>>();
  private table: string | undefined;
  private carry = '';
  private carryAtLineStart = true;
  private entries = 0;
  private unknown = false;
  /** The dump makes a view, trigger, procedure, function or event: things RENAME TABLE cannot move between databases. */
  storedObjects = false;

  constructor(private readonly http?: Set<string>) {}

  /** Reads the next piece of the dump; last reads what was carried through to the end. */
  add(chunk: string, last = false): void {
    if (this.unknown && !this.http) return;
    const text = this.carry + chunk;
    const cut = last ? text.length : Math.max(0, text.length - CARRY);
    if (!this.storedObjects && STORED_OBJECT.test(text)) this.storedObjects = true;
    // Only what starts before the cut is read now; the rest comes again at the start of the next piece.
    let table = this.table;
    let from = 0;
    for (const m of text.matchAll(LINE_STATEMENT)) {
      const at = m.index;
      if (at >= cut) break;
      if (at === 0 ? !this.carryAtLineStart : text[at - 1] !== '\n') continue;
      this.readHosts(table, text, from, at);
      const name = /^[`"]?([\w$]+)[`"]?$/.exec(m[2] as string)?.[1];
      if (!name) this.unknown = true;
      table = name;
      // IF NOT EXISTS: the table may keep rows the dump does not show, so it is not the dump's.
      if (name && /^CREATE/i.test(m[0])) {
        if (m[1]) this.hosts.delete(name);
        else if (!this.hosts.has(name)) this.hosts.set(name, new Set());
      }
      from = at;
    }
    this.readHosts(table, text, from, cut);
    this.table = table;
    this.carry = text.slice(cut);
    this.carryAtLineStart = cut === 0 ? this.carryAtLineStart : text[cut - 1] === '\n';
  }

  /** The hosts of text[from..] that start before end, as the rows of table. */
  private readHosts(table: string | undefined, text: string, from: number, end: number): void {
    if (from >= end) return;
    const own = table === undefined ? undefined : this.hosts.get(table);
    URL_HOST.lastIndex = from;
    for (let m = URL_HOST.exec(text); m && m.index < end; m = URL_HOST.exec(text)) {
      const host = m[1] as string;
      const before = text.charCodeAt(m.index - 1);
      // Only a colon or a backslash can end "http:" or "http:\\" right before the slashes.
      if (this.http && (before === 58 || before === 92) && this.http.size <= MAX_HTTP_HOSTS && HTTP_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index))) this.http.add(`${host}${m[2] ?? ''}`.toLowerCase());
      if (!own || own.has(ANY_HOST) || own.has(host)) continue;
      if (own.size >= MAX_TABLE_HOSTS) {
        own.clear();
        own.add(ANY_HOST);
        continue;
      }
      own.add(host);
      if (++this.entries > MAX_HOST_ENTRIES) this.unknown = true;
    }
  }

  /** Each table the dump creates and its hosts, as seen (case kept); undefined when that cannot be told. */
  result(): Record<string, string[]> | undefined {
    if (this.unknown) return undefined;
    return Object.fromEntries([...this.hosts].map(([table, hosts]) => [table, [...hosts].sort()]));
  }
}

export function emptyFacts(): DumpFacts {
  return { multisite: false, hosts: [], partial: false };
}

/** The options a scan keeps from each options table, the main site's and every subsite's. */
interface OptionValues {
  siteurl?: string;
  home?: string;
  dbVersion?: string;
  blogname?: string;
  activePlugins?: string[];
}

/** What a network's meta table says. */
interface NetworkMeta {
  subdomainInstall?: boolean;
  sitewide?: string[];
  admins?: string[];
}

/**
 * Where a scan is between chunks: the table whose rows come next, the tables
 * created so far, the users and roles seen, which become the facts' admins
 * once the users and usermeta tables are read through, and what each options,
 * blogs, site and sitemeta table held. Which of them is the main site's is
 * decided from all of them, since mysqldump writes wp_10_options before
 * wp_options.
 */
export interface ScanState {
  table?: string | undefined;
  tables: string[];
  logins: Map<number, string>;
  adminIds: Set<number>;
  superAdmins?: string[];
  /** Table prefixes in the order their options or blogs table came, subsites' too. */
  prefixes: string[];
  options: Map<string, OptionValues>;
  blogs: Map<string, Array<{ id: number; domain: string; path: string }>>;
  site: Map<string, { domain: string; path: string }>;
  meta: Map<string, NetworkMeta>;
  /** A domain mapping plugin's table: the active domain of each blog. */
  mapping: Map<string, Map<number, string>>;
}

export const emptyScan = (): ScanState => ({ tables: [], logins: new Map(), adminIds: new Set(), prefixes: [], options: new Map(), blogs: new Map(), site: new Map(), meta: new Map(), mapping: new Map() });

// mysqldump writes "VALUES (row),(row)" on one line; MariaDB's dump puts each row on a line of its own.
const STATEMENT = /INSERT INTO `(\w+)` (?:\([^)]*\) )?VALUES\s*|CREATE TABLE `(\w+)`/g;
const QUOTED = "'((?:[^'\\\\]|\\\\.)*)'";
const LOGIN = /^[\w.@+ -]{1,60}$/;
const unquote = (value: string) => value.replace(/\\(.)/g, '$1');
/** A site name as WordPress stores it, with the few HTML entities it escapes turned back. */
const plainName = (text: string) =>
  text.replace(/&(amp|quot|lt|gt|#0?39);/g, (_, e: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#039': "'", '#39': "'" })[e] ?? '').slice(0, 200);
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plugin slugs from a serialized list of plugin paths like akismet/akismet.php. */
const pluginSlugs = (serialized: string) =>
  [...serialized.matchAll(/s:\d+:\\?"([^"\\]+)\\?"/g)].map((p) => (p[1] as string).split('/')[0]?.replace(/\.php$/, '') ?? '').filter((slug) => /^[a-z0-9_-]{1,100}$/.test(slug));

/** A table prefix the scan has seen, from an options table (wp_ or a subsite's wp_10_) or the network's blogs table. */
function notePrefix(state: ScanState, table: string): void {
  const prefix = /^(\w*?)(?:options|blogs)$/.exec(table)?.[1];
  if (prefix !== undefined && !state.prefixes.includes(prefix)) state.prefixes.push(prefix);
}

/**
 * The main site's table prefix: not a subsite's (wp_10_ when wp_ is there
 * too), and one whose options hold the site's address or that has the
 * network's blogs table, so a plugin's own options table is not taken.
 */
export function mainPrefix(state: ScanState): string | undefined {
  const seen = new Set(state.prefixes);
  // wp_10_ is a subsite's when wp_ is there too.
  const own = state.prefixes.filter((p) => {
    const parent = /^(.*?)\d+_$/.exec(p)?.[1];
    return parent === undefined || !seen.has(parent);
  });
  const isSite = (p: string) => state.blogs.has(`${p}blogs`) || state.tables.includes(`${p}blogs`) || Boolean(state.options.get(`${p}options`)?.siteurl ?? state.options.get(`${p}options`)?.home);
  return own.find(isSite) ?? own[0];
}

/** The rows of one table in a stretch of SQL, kept by table: options, a network's tables, logins and roles. */
function readRows(table: string | undefined, rows: string, state: ScanState): void {
  if (!table || !rows) return;
  if (table.endsWith('options')) {
    const values = state.options.get(table) ?? {};
    for (const m of rows.matchAll(new RegExp(`\\(\\d+,'(siteurl|home|db_version|blogname|active_plugins)',${QUOTED}`, 'g'))) {
      const value = m[2] ?? '';
      if (m[1] === 'siteurl') values.siteurl ??= unquote(value);
      else if (m[1] === 'home') values.home ??= unquote(value);
      else if (m[1] === 'blogname') values.blogname ??= plainName(unquote(value));
      else if (m[1] === 'db_version') values.dbVersion ??= value;
      else values.activePlugins ??= pluginSlugs(value);
    }
    if (Object.keys(values).length) state.options.set(table, values);
    return;
  }
  if (table.endsWith('blogs')) {
    // (blog_id,site_id,'domain','path',...)
    const list = state.blogs.get(table) ?? [];
    for (const m of rows.matchAll(/\((\d+),\d+,'([^']+)','([^']*)'/g)) {
      const id = Number(m[1]);
      if (!list.some((b) => b.id === id)) list.push({ id, domain: (m[2] as string).toLowerCase(), path: m[3] as string });
    }
    if (list.length) state.blogs.set(table, list);
    return;
  }
  if (table.endsWith('sitemeta')) {
    const meta = state.meta.get(table) ?? {};
    for (const m of rows.matchAll(new RegExp(`\\(\\d+,\\d+,'(subdomain_install|active_sitewide_plugins|site_admins)',${QUOTED}\\)`, 'g'))) {
      const value = m[2] ?? '';
      if (m[1] === 'subdomain_install') meta.subdomainInstall ??= value === '1';
      else if (m[1] === 'active_sitewide_plugins') meta.sitewide ??= pluginSlugs(value);
      else meta.admins ??= [...value.matchAll(/s:\d+:\\?"([^"\\]+)\\?"/g)].map((x) => x[1] as string).filter((l) => LOGIN.test(l));
    }
    if (Object.keys(meta).length) state.meta.set(table, meta);
    return;
  }
  if (table.endsWith('domain_mapping')) {
    // (id,blog_id,'domain',active), as WordPress MU Domain Mapping and Mercator keep it.
    const map = state.mapping.get(table) ?? new Map<number, string>();
    for (const m of rows.matchAll(/\(\d+,(\d+),'([^']+)',(\d)\)/g)) {
      if (m[3] === '1' && !map.has(Number(m[1]))) map.set(Number(m[1]), (m[2] as string).toLowerCase());
    }
    state.mapping.set(table, map);
    return;
  }
  if (table.endsWith('site')) {
    // (id,'domain','path')
    const m = /\((\d+),'([^']+)','([^']*)'\)/.exec(rows);
    if (m && !state.site.has(table)) state.site.set(table, { domain: (m[2] as string).toLowerCase(), path: m[3] as string });
    return;
  }
  const prefix = mainPrefix(state);
  if (prefix === undefined) return;
  if (table === `${prefix}users`) {
    for (const m of rows.matchAll(new RegExp(`\\((\\d+),${QUOTED},`, 'g'))) {
      const login = unquote(m[2] ?? '');
      if (LOGIN.test(login)) state.logins.set(Number(m[1]), login);
    }
  } else if (table === `${prefix}usermeta`) {
    for (const m of rows.matchAll(new RegExp(`\\(\\d+,(\\d+),'${escapeRe(prefix)}capabilities',${QUOTED}\\)`, 'g'))) {
      if (/administrator/.test(m[2] ?? '')) state.adminIds.add(Number(m[1]));
    }
  }
}

/** A table was read through: another one was created after it. */
function tableRead(state: ScanState, table: string): boolean {
  const at = state.tables.indexOf(table);
  return at !== -1 && state.tables.length - 1 > at;
}

/** Both users tables were read through: a table was created after each. */
export function usersRead(state: ScanState, prefix: string | undefined): boolean {
  if (prefix === undefined) return false;
  return tableRead(state, `${prefix}users`) && tableRead(state, `${prefix}usermeta`);
}

/** The admins the scan found, by login and user id order; none when the users were not read through. */
export function adminsOf(state: ScanState, facts: DumpFacts, complete: boolean): Pick<DumpFacts, 'admins' | 'superAdmins'> {
  if (!complete && !usersRead(state, facts.tablePrefix)) return {};
  if (!state.tables.includes(`${facts.tablePrefix}users`)) return {};
  const admins = [...state.adminIds].sort((a, b) => a - b).flatMap((id) => state.logins.get(id) ?? []);
  return { admins, ...(facts.multisite ? { superAdmins: state.superAdmins ?? [] } : {}) };
}

/** The facts from what the scan has kept so far: the main site's options and the network's tables only. */
function resolve(facts: DumpFacts, state: ScanState): void {
  const prefix = mainPrefix(state);
  if (prefix === undefined) return;
  facts.tablePrefix = prefix;
  const main = state.options.get(`${prefix}options`) ?? {};
  if (main.siteurl !== undefined) facts.siteUrl = main.siteurl;
  if (main.home !== undefined) facts.home = main.home;
  if (main.dbVersion && /^\d+$/.test(main.dbVersion)) facts.dbVersion = Number(main.dbVersion);
  const meta = state.meta.get(`${prefix}sitemeta`) ?? {};
  if (main.activePlugins || meta.sitewide) facts.activePlugins = [...new Set([...(main.activePlugins ?? []), ...(meta.sitewide ?? [])])];
  if (meta.admins) state.superAdmins = meta.admins;
  const blogs = state.blogs.get(`${prefix}blogs`) ?? [];
  if (blogs.length || state.tables.includes(`${prefix}blogs`)) facts.multisite = true;
  const mapping = state.mapping.get(`${prefix}domain_mapping`);
  if (mapping || state.tables.includes(`${prefix}domain_mapping`)) facts.domainMapping = true;
  if (blogs.length) {
    facts.sites = blogs.slice(0, 500).map((b) => {
      const name = state.options.get(b.id === 1 ? `${prefix}options` : `${prefix}${b.id}_options`)?.blogname;
      const mapped = mapping?.get(b.id);
      return { id: b.id, ...(mapped ? { domain: mapped, path: '/', mapped: true as const } : { domain: b.domain, path: b.path }), ...(name ? { name } : {}) };
    });
  }
  // The network's own setting; a dump without it is told by its sites: all at / on their own hosts, or under paths.
  const subdomain = meta.subdomainInstall ?? (blogs.length > 1 ? blogs.every((b) => b.path === '/') : undefined);
  if (subdomain !== undefined) facts.subdomainInstall = subdomain;
  const network = state.site.get(`${prefix}site`);
  if (network && /^\/[\w./-]*$/.test(network.path)) facts.networkPath = network.path;
  const hosts: string[] = [];
  for (const url of [main.home, main.siteurl]) {
    try {
      // host keeps a port (http://localhost:8888), so the replace takes it away too.
      if (url) addHost(hosts, new URL(url).host);
    } catch {
      // not a URL; ignore
    }
  }
  for (const b of blogs) addHost(hosts, b.domain);
  // A mapped domain is where the site answers; the blogs table keeps its subdomain or path too, so both are replaced.
  for (const host of mapping?.values() ?? []) addHost(hosts, host);
  facts.hosts = hosts;
}

function addHost(hosts: string[], host: string): void {
  const h = host.toLowerCase();
  if (/^[a-z0-9.-]+(:\d{1,5})?$/.test(h) && !hosts.includes(h)) hosts.push(h);
}

/** Folds one chunk of SQL into the scan state, and the facts from it. Exported for tests. */
export function scanSql(text: string, facts: DumpFacts, state: ScanState = emptyScan(), keep = 0): void {
  // Rows belong to the table of the INSERT before them, or to the one the last chunk ended in.
  const cut = text.length - keep;
  let table = state.table;
  let from = 0;
  let next = state.table;
  for (const m of text.matchAll(STATEMENT)) {
    readRows(table, text.slice(from, m.index), state);
    notePrefix(state, (m[1] ?? m[2]) as string);
    // A CREATE TABLE ends the rows of the table before it.
    table = m[1];
    from = m.index + m[0].length;
    if (m[2] && from <= cut && !state.tables.includes(m[2])) state.tables.push(m[2]);
    if (m.index < cut) next = table;
  }
  readRows(table, text.slice(from), state);
  // The next chunk starts with the kept tail: its rows are read again, under the table they began in.
  state.table = next;
  resolve(facts, state);
}

/**
 * Streams a .sql or .sql.gz file and collects the facts. onRead gets how
 * much of the file is read (0 to 1), now and then: a large dump takes a minute.
 */
export async function analyzeDump(file: string, onRead?: (fraction: number) => void): Promise<DumpFacts> {
  const facts = emptyFacts();
  const state = emptyScan();
  const size = statSync(file).size || 1;
  const source = createReadStream(file);
  const stream = file.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  let tail = '';
  let read = 0;
  let told = 0;
  // Once the facts are in, the rest is only searched for http links, to the end of the dump.
  let found = false;
  let toEnd = true;
  const http = new Set<string>();
  const tableHosts = new TableHosts(http);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      read += chunk.length;
      // Of the file on disk: for a gzip, the packed bytes read so far.
      const fraction = Math.min(source.bytesRead / size, 1);
      if (onRead && fraction - told >= 0.01) {
        told = fraction;
        onRead(fraction);
      }
      const piece = chunk.toString('utf8');
      tableHosts.add(piece);
      const text = tail + piece;
      tail = text.slice(-OVERLAP);
      if (!found) {
        scanSql(text, facts, state, OVERLAP);
        const network = !facts.multisite || tableRead(state, `${facts.tablePrefix}blogs`);
        found = Boolean(facts.tablePrefix !== undefined && facts.siteUrl && facts.home && facts.dbVersion && facts.activePlugins && network && usersRead(state, facts.tablePrefix));
        // The kept tail was only read as the start of a next chunk: read it once more as the end.
        if (found) scanSql(tail, facts, state, 0);
      }
      if (read > SCAN_LIMIT) {
        if (!found) facts.partial = true;
        toEnd = false;
        break;
      }
    }
  } finally {
    source.destroy();
  }
  if (!found) scanSql(tail, facts, state, 0);
  tableHosts.add('', true);
  if (toEnd && http.size <= MAX_HTTP_HOSTS) facts.httpHosts = [...http];
  const perTable = toEnd ? tableHosts.result() : undefined;
  if (perTable) facts.tableHosts = perTable;
  if (toEnd) facts.storedObjects = tableHosts.storedObjects;
  return { ...facts, ...adminsOf(state, facts, !facts.partial) };
}

/** The most a zip's .sql may unpack to: past this it is refused before anything is written. */
export const MAX_UNZIPPED_BYTES = 100 * 1024 ** 3;

/** The entries `unzip -l` lists: their unpacked size and name. */
export function parseZipList(text: string): Array<{ size: number; name: string }> {
  return [...text.matchAll(/^\s*(\d+)\s+\d{2,4}-\d{2}-\d{2,4}\s+\d{2}:\d{2}\s+(.+)$/gm)].map((m) => ({ size: Number(m[1]), name: (m[2] as string).trimEnd() }));
}

/** The .sql a zip holds, as the import takes it: the first outside __MACOSX, with a name unzip reads literally. */
export function sqlEntry(entries: Array<{ size: number; name: string }>): { size: number; name: string } | null {
  return entries.find((e) => /\.sql$/i.test(e.name) && !e.name.split('/').includes('__MACOSX') && !/[*?[\]\\]/.test(e.name) && !e.name.startsWith('-')) ?? null;
}

/**
 * The file an import streams: .sql and .sql.gz as they are (a gzip is
 * unpacked on the way into MySQL), .zip unpacked once with unzip, as a zip
 * cannot be read as a stream. Only its first .sql comes out, flat into the
 * folder (no paths from the zip), after its unpacked size is checked against
 * the limit and the free space: no zip bomb, and nothing else is written.
 */
export async function sqlFileFor(exec: Executor, file: string, workDir: string, free: (path: string) => { bytes: number } = freeSpace): Promise<string> {
  if (!file.endsWith('.zip')) return file;
  const dir = join(workDir, 'unzipped');
  if (existsSync(dir)) {
    const found = findSql(dir);
    if (found) return found;
  }
  const listed = await exec('unzip', ['-l', file], { timeoutMs: 5 * 60_000 });
  if (listed.code !== 0) throw new Error(`could not read ${file}: ${listed.stderr.trim()}`);
  const entry = sqlEntry(parseZipList(listed.stdout));
  if (!entry) throw new Error('the zip holds no .sql file');
  if (entry.size > MAX_UNZIPPED_BYTES) throw new Error(`the .sql in the zip unpacks to ${Math.round(entry.size / 1024 ** 3)} GB, more than the ${MAX_UNZIPPED_BYTES / 1024 ** 3} GB the panel takes`);
  const room = free(existsSync(workDir) ? workDir : dirname(workDir)).bytes;
  if (room < entry.size + 1024 ** 3) throw new Error(`not enough free disk space to unpack the zip: ${Math.round(entry.size / 1024 ** 2)} MB needed, ${Math.round(room / 1024 ** 2)} MB free`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const res = await exec('unzip', ['-o', '-q', '-j', file, entry.name, '-d', dir], { timeoutMs: 30 * 60_000 });
  if (res.code !== 0) throw new Error(`could not unzip ${file}: ${res.stderr.trim()}`);
  const sql = findSql(dir);
  if (!sql) throw new Error('the zip holds no .sql file');
  return sql;
}

function findSql(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.sql')) return path;
    if (entry.isDirectory() && !entry.name.startsWith('__MACOSX')) {
      const found = findSql(path);
      if (found) return found;
    }
  }
  return null;
}

import { existsSync } from 'node:fs';
import type { DumpPlugin, DumpTheme, MissingScan, MissingScanState } from '@devmagic-panel/shared';
import type { Executor } from '../exec.js';
import type { RunStore } from '../store.js';
import { PLUGIN_FILE, THEME_NAME } from './dump.js';
import { pluginPresent } from './install-plugins.js';
import { themeDir } from './local-mode.js';
import { phpArray } from './php-serialized.js';
import type { SiteRef } from './site-actions.js';

/** How long a scan stays good: a tab opened again within it shows the last one at once. */
export const MISSING_SCAN_MS = 30 * 60_000;
/** Option tables read in one query. */
const CHUNK = 200;
/** A network's sites read at most. */
const MAX_SITES = 5000;
const OPTIONS = ['active_plugins', 'recently_activated', 'stylesheet', 'template'];

export type ScanProgress = (step: string, done: number, total: number) => void;

/** mysql's batch output: one row a line, tabs between fields, \t \n \\ and \0 escaped. */
export function batchRows(stdout: string): string[][] {
  const unescape = (field: string) => field.replace(/\\([tn0\\])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : '\\'));
  return stdout.split('\n').filter((l) => l !== '').map((l) => l.split('\t').map(unescape));
}

/**
 * What a site's database names that its files lack, plugins and themes in
 * one pass: every site's active plugins, recently turned off ones, its theme
 * and a child theme's parent, read with one query over all the option
 * tables (in chunks of 200 sites) instead of WP-CLI once per site, plus the
 * network-wide plugins and the versions and WordPress.org slugs WordPress's
 * own update check saved. Read only; nothing of the site is loaded.
 */
export async function scanMissing(exec: Executor, site: Pick<SiteRef, 'docroot' | 'host' | 'wp'>, progress: ScanProgress = () => undefined): Promise<{ plugins: DumpPlugin[]; themes: DumpTheme[] }> {
  const wp = (args: string[], timeoutMs = 120_000) => exec('wp', [`--path=${site.docroot}`, `--url=https://${site.host}/`, ...args, '--skip-plugins', '--skip-themes'], { timeoutMs });
  const json = async (args: string[]): Promise<unknown> => {
    const r = await wp(args, 60_000);
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      return undefined;
    }
  };
  const query = async (sql: string): Promise<string[][]> => {
    const r = await wp(['db', 'query', sql, '--skip-column-names', '--batch']);
    if (r.code !== 0) throw new Error(`could not read the database: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`);
    return batchRows(r.stdout);
  };

  progress('Reading the sites', 0, 1);
  let prefix = site.wp.tablePrefix;
  if (!prefix) {
    const r = await wp(['db', 'prefix'], 60_000);
    prefix = r.code === 0 ? r.stdout.trim() : '';
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(prefix)) throw new Error('could not read the table prefix from wp-config.php');
  // The update checks are read meanwhile: two WP-CLI runs next to the queries.
  const checks = Promise.all([json(['transient', 'get', 'update_plugins', '--network', '--format=json']), json(['transient', 'get', 'update_themes', '--network', '--format=json'])]);

  // Which option tables there are and, on a network, which sites: a site whose tables are gone is left out.
  const tables = await query(
    `SELECT 't', TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, ${prefix.length}) = '${prefix}' AND TABLE_NAME LIKE '%options'${site.wp.multisite ? ` UNION ALL SELECT 'b', blog_id FROM \`${prefix}blogs\`` : ''}`,
  );
  const tableOf = new Map<number, string>();
  const own = new RegExp(`^${prefix}(?:(\\d+)_)?options$`);
  for (const [kind, name] of tables) {
    const m = kind === 't' && name ? own.exec(name) : null;
    if (m) tableOf.set(m[1] ? Number(m[1]) : 1, name as string);
  }
  const blogs = site.wp.multisite ? tables.filter(([kind]) => kind === 'b').map(([, id]) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : [1];
  const ids = blogs.filter((id) => tableOf.has(id)).slice(0, MAX_SITES);
  const network = site.wp.multisite;

  const rows: string[][] = [];
  if (network) rows.push(...(await query(`SELECT 0, meta_key, meta_value FROM \`${prefix}sitemeta\` WHERE meta_key = 'active_sitewide_plugins'`)));
  const names = OPTIONS.map((o) => `'${o}'`).join(', ');
  for (let i = 0; i < ids.length; i += CHUNK) {
    progress(ids.length === 1 ? 'Reading its plugins and themes' : `Reading the plugins and themes of ${ids.length} sites`, i, ids.length);
    const part = ids.slice(i, i + CHUNK);
    rows.push(...(await query(part.map((id) => `SELECT ${id}, option_name, option_value FROM \`${tableOf.get(id)}\` WHERE option_name IN (${names})`).join(' UNION ALL '))));
  }
  progress('Reading what WordPress saved of its update checks', ids.length, ids.length);
  const [pluginCheck, themeCheck] = await checks;

  // Plugins: by file, active ones counted per site.
  const validFile = (f: unknown): f is string => typeof f === 'string' && PLUGIN_FILE.test(f) && !f.includes('..');
  const byFile = new Map<string, DumpPlugin>();
  const get = (file: string) => byFile.get(file) ?? { file, active: false };
  const used = new Map<string, number>();
  const parents = new Set<string>();
  const perBlog = new Map<number, { stylesheet?: string; template?: string }>();
  const themeName = (v: string | undefined) => (v && THEME_NAME.test(v) && !v.includes('..') ? v : undefined);
  for (const [blog, option, value = ''] of rows) {
    const id = Number(blog);
    if (option === 'active_sitewide_plugins' && id === 0) {
      for (const file of phpArray(value)?.keys() ?? []) if (validFile(file)) byFile.set(file, { ...get(file), active: true, network: true });
    } else if (option === 'active_plugins') {
      for (const file of phpArray(value)?.values() ?? []) {
        if (!validFile(file)) continue;
        const p = get(file);
        byFile.set(file, { ...p, active: true, ...(network ? { sites: (p.sites ?? 0) + 1 } : {}) });
      }
    } else if (option === 'recently_activated') {
      for (const file of phpArray(value)?.keys() ?? []) if (validFile(file)) byFile.set(file, get(file));
    } else if (option === 'stylesheet' || option === 'template') {
      perBlog.set(id, { ...perBlog.get(id), [option]: value.trim() });
    }
  }
  for (const { stylesheet, template } of perBlog.values()) {
    const mine = themeName(stylesheet);
    const parent = themeName(template);
    if (mine) used.set(mine, (used.get(mine) ?? 0) + 1);
    if (parent && parent !== mine) parents.add(parent);
  }

  const check = (pluginCheck ?? null) as { checked?: unknown; response?: unknown; no_update?: unknown } | null;
  if (check && typeof check === 'object') {
    for (const [file, version] of Object.entries((check.checked && typeof check.checked === 'object' ? check.checked : {}) as Record<string, unknown>)) {
      if (validFile(file)) byFile.set(file, { ...get(file), ...(typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) ? { version } : {}) });
    }
    for (const list of [check.response, check.no_update]) {
      for (const [file, info] of Object.entries((list && typeof list === 'object' ? list : {}) as Record<string, { slug?: unknown }>)) {
        if (byFile.has(file) && typeof info?.slug === 'string' && /^[a-z0-9_-]{1,100}$/.test(info.slug)) byFile.set(file, { ...get(file), slug: info.slug });
      }
    }
  }
  const themeVersions = ((themeCheck as { checked?: unknown } | null)?.checked ?? {}) as Record<string, unknown>;
  const version = (n: string) => (typeof themeVersions[n] === 'string' && /^[\w.+-]{1,40}$/.test(themeVersions[n] as string) ? { version: themeVersions[n] as string } : {});

  const plugins = [...byFile.values()].filter((p) => !pluginPresent(site.docroot, p.file)).sort((a, b) => Number(b.active) - Number(a.active) || a.file.localeCompare(b.file));
  const themes = [
    ...[...used].map(([n, count]): DumpTheme => ({ name: n, ...(network ? { sites: count } : {}), ...version(n) })),
    ...[...parents].filter((n) => !used.has(n)).map((n): DumpTheme => ({ name: n, parent: true, ...version(n) })),
  ].filter((t) => !existsSync(themeDir(site.docroot, t.name)));
  return { plugins, themes };
}

const metaKey = (site: string) => `missing-scan:${site}`;

/**
 * The scans for missing plugins and themes, one per site at a time, run on
 * the server apart from any request: leaving the tab does not stop one, and
 * coming back shows how far it got or what it found. The last result is kept
 * in the panel's database (names and versions only) for MISSING_SCAN_MS, and
 * forgotten when a job changes the site.
 */
export class MissingScans {
  private running = new Map<string, NonNullable<MissingScanState['running']>>();
  private errors = new Map<string, string>();

  constructor(
    private store: RunStore,
    private exec: Executor,
    private now: () => number = Date.now,
  ) {}

  /**
   * What there is for a site; starts a scan when there is none, or the last is
   * too old, unless one runs. peek only reads: the Overview never starts one.
   */
  state(site: string, ref: () => SiteRef, how: 'read' | 'force' | 'peek' = 'read'): MissingScanState {
    const scan = this.kept(site);
    const stale = !scan || this.now() - Date.parse(scan.checkedAt) > MISSING_SCAN_MS;
    if (how !== 'peek' && !this.running.has(site) && (how === 'force' || (stale && !this.errors.has(site)))) this.start(site, ref());
    const running = this.running.get(site);
    const error = this.errors.get(site);
    return { ...(scan ? { scan } : {}), ...(running ? { running: { ...running } } : {}), ...(error && !running ? { error } : {}) };
  }

  /** The last result, however old; refresh.ts and Aura read it without starting a scan. */
  kept(site: string): MissingScan | undefined {
    const text = this.store.getMeta(metaKey(site));
    if (!text) return undefined;
    try {
      return JSON.parse(text) as MissingScan;
    } catch {
      return undefined;
    }
  }

  forget(site: string): void {
    this.store.deleteMeta(metaKey(site));
    this.errors.delete(site);
  }

  /** Waits for a site's scan to end; for tests and a job that needs the answer. */
  async settled(site: string): Promise<void> {
    while (this.running.has(site)) await new Promise((r) => setTimeout(r, 5));
  }

  private start(site: string, ref: SiteRef): void {
    const running = { startedAt: new Date(this.now()).toISOString(), step: 'Starting', done: 0, total: 1 };
    this.running.set(site, running);
    this.errors.delete(site);
    void scanMissing(this.exec, ref, (step, done, total) => Object.assign(running, { step, done, total }))
      .then(
        ({ plugins, themes }) => this.store.setMeta(metaKey(site), JSON.stringify({ plugins, themes, checkedAt: new Date(this.now()).toISOString() } satisfies MissingScan)),
        (error: Error) => this.errors.set(site, error.message),
      )
      .finally(() => this.running.delete(site));
  }
}

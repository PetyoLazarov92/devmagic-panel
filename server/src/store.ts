import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CronRunStatus, CronRunView, InstallHow, Proposal, QueuedProposal, SiteInstall } from '@devmagic-panel/shared';
import { actions, isActionId } from '@devmagic-panel/shared';

/**
 * Run history in node:sqlite (no native module). One row per action run:
 * what ran, with which input, how it ended and what it printed.
 */
export interface RunRecord {
  id: number;
  action: string;
  input: string;
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string | null;
  /** Steps a job finished without (Skip and continue); null for other runs and ones before this was kept. */
  skipped: number | null;
}

/** A database the panel made to keep a site's tables from before a swap, purged after a while. */
export interface KeptDatabase {
  name: string;
  /** The site's key: its domain, or domain@path. */
  site: string;
  /** The site's database the tables came from. */
  db: string;
  reason: string;
  createdAt: string;
  /** The site's tables before the swap, so a restore can put back exactly those: tables the swap added go out too. */
  before?: string[];
}

/** Exit code of a run the panel was stopped in the middle of (restart, reboot, logout). */
export const INTERRUPTED = -1;

const RUN_COLUMNS = 'id, action, input, exit_code AS exitCode, output, started_at AS startedAt, finished_at AS finishedAt, skipped';

/** A login session as kept: which panel password it was made with (a hash of its hash) and when it ends. */
export interface StoredSession {
  password: string;
  expiresAt: number;
}

export type SessionStore = Pick<RunStore, 'getSession' | 'putSession' | 'deleteSession' | 'purgeSessions'>;

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // The panel and the MCP server Claude Code starts both open this file.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        input TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        title TEXT NOT NULL,
        input TEXT NOT NULL,
        why TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS repo_presets (
        repo TEXT PRIMARY KEY,
        preset TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installs (
        site TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archives (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS org_repos (
        org TEXT NOT NULL,
        name TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (org, name)
      );
      CREATE TABLE IF NOT EXISTS git_hosts (
        host TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        real_host TEXT,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS org_scans (
        org TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        listed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compat_scans (
        site TEXT NOT NULL,
        version TEXT NOT NULL,
        scan TEXT NOT NULL,
        PRIMARY KEY (site, version)
      );
      CREATE TABLE IF NOT EXISTS kept_databases (
        name TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        db TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS cron_runs_task ON cron_runs (task, id)
    `);
    this.addColumn('runs', 'skipped', 'INTEGER');
    this.addColumn('kept_databases', 'before_tables', 'TEXT');
    this.backfillInstalls();
  }

  /** A column added after the table was made, once; the MCP server may add it at the same moment. */
  private addColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (error) {
      if (!/duplicate column/i.test(String(error))) throw error;
    }
  }

  /**
   * Sites the panel made before it kept how: from the run history of
   * site.create and trash.restore runs that finished well, once.
   */
  private backfillInstalls(): void {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'installs-backfilled'").get()) return;
    const rows = this.db
      .prepare("SELECT action, input, started_at AS at FROM runs WHERE action IN ('site.create', 'trash.restore') AND exit_code = 0 ORDER BY id")
      .all() as Array<{ action: string; input: string; at: string }>;
    for (const row of rows) {
      try {
        const input = JSON.parse(row.input) as { source?: string; domain?: string; path?: string; repo?: { url?: string }; id?: string };
        if (row.action === 'site.create' && input.domain && ['repo', 'wordpress', 'empty'].includes(input.source ?? '')) {
          this.setInstall(input.domain, input.path, { how: input.source as InstallHow, at: row.at, ...(input.repo?.url ? { repo: input.repo.url } : {}) });
        } else if (row.action === 'trash.restore' && input.id && /-\d{8}-\d{6}$/.test(input.id)) {
          this.setInstall(input.id.slice(0, -16), undefined, { how: 'restore', at: row.at });
        }
      } catch {
        // a run whose input cannot be read tells nothing
      }
    }
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('installs-backfilled', ?)").run(new Date().toISOString());
  }

  /** A database of a site's tables from before a swap, which the panel made and may drop. */
  addKeptDatabase(kept: KeptDatabase): void {
    this.db
      .prepare(
        'INSERT INTO kept_databases (name, site, db, reason, created_at, before_tables) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET site = excluded.site, db = excluded.db, reason = excluded.reason, created_at = excluded.created_at, before_tables = excluded.before_tables',
      )
      .run(kept.name, kept.site, kept.db, kept.reason, kept.createdAt, kept.before ? JSON.stringify(kept.before) : null);
  }

  /** The kept databases, newest first; of one site when given (its key, like local.shop.com or local.shop.com@learn). */
  keptDatabases(site?: string): KeptDatabase[] {
    const columns = 'name, site, db, reason, created_at AS createdAt, before_tables AS before';
    const rows = (site === undefined ? this.db.prepare(`SELECT ${columns} FROM kept_databases ORDER BY created_at DESC`).all() : this.db.prepare(`SELECT ${columns} FROM kept_databases WHERE site = ? ORDER BY created_at DESC`).all(site)) as Array<
      Omit<KeptDatabase, 'before'> & { before: string | null }
    >;
    return rows.map(({ before, ...kept }) => ({ ...kept, ...(before ? { before: JSON.parse(before) as string[] } : {}) }));
  }

  removeKeptDatabase(name: string): void {
    this.db.prepare('DELETE FROM kept_databases WHERE name = ?').run(name);
  }

  /** A value the panel keeps for itself, like MySQL limits to put back. */
  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  /** The keys of kept values that start with prefix. */
  metaKeys(prefix: string): string[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (this.db.prepare("SELECT key FROM meta WHERE key LIKE ? ESCAPE '\\'").all(like) as Array<{ key: string }>).map((r) => r.key);
  }

  /** A login session, by the hash of its token: the token itself is never stored. */
  getSession(tokenHash: string): StoredSession | undefined {
    const row = this.db.prepare('SELECT password, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { password: string; expires_at: number } | undefined;
    return row ? { password: row.password, expiresAt: row.expires_at } : undefined;
  }

  putSession(tokenHash: string, session: StoredSession): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, password, expires_at) VALUES (?, ?, ?) ON CONFLICT (token_hash) DO UPDATE SET password = excluded.password, expires_at = excluded.expires_at')
      .run(tokenHash, session.password, session.expiresAt);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Drops the sessions that ended before now. */
  purgeSessions(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  /** How a site came here, keyed by its domain and path, like local.shop.com or local.shop.com/learn. */
  setInstall(domain: string, path: string | undefined, record: SiteInstall): void {
    this.db
      .prepare('INSERT INTO installs (site, record) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET record = excluded.record')
      .run(`${domain}${path ?? ''}`, JSON.stringify(record));
  }

  /**
   * A step skipped at install was done by hand: it leaves the site's list of
   * what is left to do, and the rest of how the site was installed stays.
   * False when the site has no such step.
   */
  skippedDone(domain: string, path: string | undefined, label: string): boolean {
    const site = `${domain}${path ?? ''}`;
    const row = this.db.prepare('SELECT record FROM installs WHERE site = ?').get(site) as { record: string } | undefined;
    if (!row) return false;
    const { skipped = [], ...rest } = JSON.parse(row.record) as SiteInstall;
    const left = skipped.filter((s) => s.label !== label);
    if (left.length === skipped.length) return false;
    this.setInstall(domain, path, { ...rest, ...(left.length ? { skipped: left } : {}) });
    return true;
  }

  installs(): Map<string, SiteInstall> {
    const rows = this.db.prepare('SELECT site, record FROM installs').all() as Array<{ site: string; record: string }>;
    return new Map(rows.map((r) => [r.site, JSON.parse(r.record) as SiteInstall]));
  }

  /**
   * A site went to the archive: how it had been installed moves with it, to
   * show on the Archive page and to carry over when it is restored. The
   * domain's sites under a path go with it.
   */
  archiveInstall(domain: string, archiveId: string): void {
    const own = this.db.prepare('SELECT record FROM installs WHERE site = ?').get(domain) as { record: string } | undefined;
    if (own) this.db.prepare('INSERT INTO archives (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record').run(archiveId, own.record);
    this.db.prepare("DELETE FROM installs WHERE site = ? OR site LIKE ? ESCAPE '\\'").run(domain, `${domain.replace(/[\\%_]/g, '\\$&')}/%`);
  }

  /** How the site in an archive had been installed, when the panel knew. */
  archivedInstall(archiveId: string): SiteInstall | undefined {
    const row = this.db.prepare('SELECT record FROM archives WHERE id = ?').get(archiveId) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as SiteInstall) : undefined;
  }

  forgetArchive(archiveId: string): void {
    this.db.prepare('DELETE FROM archives WHERE id = ?').run(archiveId);
  }

  start(action: string, input: unknown): number {
    const result = this.db
      .prepare('INSERT INTO runs (action, input, started_at) VALUES (?, ?, ?)')
      .run(action, JSON.stringify(input), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finish(id: number, exitCode: number, output: string, skipped?: number): void {
    this.db
      .prepare('UPDATE runs SET exit_code = ?, output = ?, finished_at = ?, skipped = ? WHERE id = ?')
      .run(exitCode, output, new Date().toISOString(), skipped || null, id);
  }

  /**
   * Marks the runs a stopped panel left without an end as stopped, at start,
   * when nothing of this panel can still be running them. The panel's own
   * updates are left alone: their installer goes on and finishes its run.
   */
  stopUnfinished(note: string, except: (action: string) => boolean): number {
    const rows = this.db.prepare('SELECT id, action, output FROM runs WHERE finished_at IS NULL').all() as Array<{ id: number; action: string; output: string }>;
    const stopped = rows.filter((r) => !except(r.action));
    for (const r of stopped) this.finish(r.id, 1, [r.output, note].filter(Boolean).join('\n'));
    return stopped.length;
  }

  /** The newest runs, for the assistant's look at what happened lately. */
  recent(limit = 50): RunRecord[] {
    return this.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT ?`).all(limit) as unknown as RunRecord[];
  }

  /** One page of Run history, newest first (page 1 is the newest), with how many runs there are in all. */
  page(page: number, size: number): { runs: RunRecord[]; total: number } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n);
    const runs = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size) as unknown as RunRecord[];
    return { runs, total };
  }

  /**
   * Keeps Run history from growing for ever: finished runs older than `days`,
   * and any beyond the newest `max`, go. Runs still going are never touched.
   */
  prune(days: number, max: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = this.db.prepare('DELETE FROM runs WHERE finished_at IS NOT NULL AND started_at < ?').run(cutoff);
    const over = this.db
      .prepare('DELETE FROM runs WHERE finished_at IS NOT NULL AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)')
      .run(max);
    return Number(old.changes) + Number(over.changes);
  }

  /** Deletes every finished run; ones still going (a running job) stay. */
  clearRuns(): number {
    return Number(this.db.prepare('DELETE FROM runs WHERE finished_at IS NOT NULL').run().changes);
  }

  get(id: number): RunRecord | undefined {
    return this.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as unknown as RunRecord | undefined;
  }

  /**
   * Closes the runs a stopped panel left open, so they do not show as running
   * forever. Called once at startup, before anything new runs.
   */
  markInterrupted(): number {
    const note = 'Interrupted: the panel stopped before this run finished.';
    const result = this.db
      .prepare(`UPDATE runs SET exit_code = ?, output = CASE WHEN output = '' THEN ? ELSE output || char(10) || ? END, finished_at = ? WHERE finished_at IS NULL`)
      .run(INTERRUPTED, note, note, new Date().toISOString());
    return Number(result.changes);
  }

  /** Queues a change suggested from outside the panel (an MCP client); it runs only when clicked in the panel. */
  addProposal(proposal: Proposal, source: string): void {
    this.db
      .prepare('INSERT INTO proposals (id, action, title, input, why, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(proposal.id, proposal.action, proposal.title, JSON.stringify(proposal.input), proposal.why ?? null, source, new Date().toISOString());
  }

  pendingProposals(): QueuedProposal[] {
    const rows = this.db
      .prepare("SELECT id, action, title, input, why, source, created_at AS createdAt FROM proposals WHERE status = 'pending' ORDER BY created_at")
      .all() as Array<{ id: string; action: string; title: string; input: string; why: string | null; source: string; createdAt: string }>;
    return rows.flatMap((r) =>
      isActionId(r.action)
        ? [{ id: r.id, action: r.action, title: r.title, description: actions[r.action].description, input: JSON.parse(r.input) as Record<string, unknown>, ...(r.why ? { why: r.why } : {}), source: r.source, createdAt: r.createdAt }]
        : [],
    );
  }

  /** Marks a queued proposal as run or dismissed; false when there was none pending. */
  closeProposal(id: string, status: 'ran' | 'dismissed'): boolean {
    return Number(this.db.prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'").run(status, id).changes) > 0;
  }

  /** Remembers the new site wizard's answers for a repo, keyed by repoKey(url). */
  savePreset(repo: string, preset: unknown): void {
    this.db
      .prepare('INSERT INTO repo_presets (repo, preset, updated_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET preset = excluded.preset, updated_at = excluded.updated_at')
      .run(repo, JSON.stringify(preset), new Date().toISOString());
  }

  preset(repo: string): unknown {
    const row = this.db.prepare('SELECT preset FROM repo_presets WHERE repo = ?').get(repo) as { preset: string } | undefined;
    return row ? (JSON.parse(row.preset) as unknown) : undefined;
  }

  /** The last compatibility scan of a site (its key, like local.acme.com@learn) against one PHP version. */
  saveCompatScan(site: string, version: string, scan: unknown): void {
    this.db
      .prepare('INSERT INTO compat_scans (site, version, scan) VALUES (?, ?, ?) ON CONFLICT(site, version) DO UPDATE SET scan = excluded.scan')
      .run(site, version, JSON.stringify(scan));
  }

  /**
   * Deletes compatibility scans and says which went: one site's (`key`), every
   * site of a vhost (`domain`, its installs under a path too), and with
   * `version` only that version's; `version` alone, that version on every site.
   */
  deleteCompatScans(where: { key?: string; domain?: string; version?: string }): Array<{ site: string; version: string }> {
    const clauses: string[] = [];
    const args: string[] = [];
    if (where.key !== undefined) {
      clauses.push('site = ?');
      args.push(where.key);
    }
    if (where.domain !== undefined) {
      clauses.push("(site = ? OR site LIKE ? ESCAPE '\\')");
      args.push(where.domain, `${where.domain.replace(/[\\%_]/g, '\\$&')}@%`);
    }
    if (where.version !== undefined) {
      clauses.push('version = ?');
      args.push(where.version);
    }
    if (clauses.length === 0) throw new Error('deleteCompatScans needs a site, a domain or a version');
    const sql = clauses.join(' AND ');
    this.db.exec('BEGIN');
    try {
      const gone = this.db.prepare(`SELECT site, version FROM compat_scans WHERE ${sql}`).all(...args) as Array<{ site: string; version: string }>;
      this.db.prepare(`DELETE FROM compat_scans WHERE ${sql}`).run(...args);
      this.db.exec('COMMIT');
      return gone;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  compatScans(site: string): unknown[] {
    const rows = this.db.prepare('SELECT scan FROM compat_scans WHERE site = ?').all(site) as Array<{ scan: string }>;
    return rows.map((r) => JSON.parse(r.scan) as unknown);
  }

  /** An install draft: the wizard's answers and the files it holds, as JSON. */
  saveDraft(id: string, record: unknown): void {
    this.db
      .prepare('INSERT INTO drafts (id, record, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at')
      .run(id, JSON.stringify(record), new Date().toISOString());
  }

  draft(id: string): unknown {
    const row = this.db.prepare('SELECT record FROM drafts WHERE id = ?').get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as unknown) : undefined;
  }

  drafts(): unknown[] {
    return (this.db.prepare('SELECT record FROM drafts ORDER BY updated_at DESC').all() as Array<{ record: string }>).map((r) => JSON.parse(r.record) as unknown);
  }

  deleteDraft(id: string): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  /** The repos of an organization as the last scan saw them, keyed by lower-case org name as GitHub ignores case. */
  orgRepos(org: string): unknown[] {
    return (this.db.prepare('SELECT record FROM org_repos WHERE org = ?').all(org.toLowerCase()) as Array<{ record: string }>).map((r) => JSON.parse(r.record) as unknown);
  }

  /** When an organization's repos were last checked for pushes and last listed in full. */
  orgScan(org: string): { checkedAt: string; listedAt: string } | undefined {
    return this.db.prepare('SELECT checked_at AS checkedAt, listed_at AS listedAt FROM org_scans WHERE org = ?').get(org.toLowerCase()) as { checkedAt: string; listedAt: string } | undefined;
  }

  /**
   * Saves what a scan found. A full list replaces the organization's repos, so
   * deleted, renamed and transferred ones go; a check only adds and updates.
   */
  /** What the panel found out about the git hosts in the sites' remotes, by asking each over SSH. */
  gitHosts(): Array<{ host: string; provider: string; realHost?: string; checkedAt: string }> {
    const rows = this.db.prepare('SELECT host, provider, real_host AS realHost, checked_at AS checkedAt FROM git_hosts').all() as Array<{ host: string; provider: string; realHost: string | null; checkedAt: string }>;
    return rows.map(({ realHost, ...r }) => (realHost ? { ...r, realHost } : r));
  }

  saveGitHost(host: string, provider: string, realHost: string | undefined, at: string): void {
    this.db
      .prepare('INSERT INTO git_hosts (host, provider, real_host, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET provider = excluded.provider, real_host = excluded.real_host, checked_at = excluded.checked_at')
      .run(host, provider, realHost ?? null, at);
  }

  /** keyOf names a repo within its namespace: its name on GitHub, its full path in a GitLab group, where subgroups can repeat a name. */
  saveOrgScan<R extends { name: string }>(org: string, repos: R[], full: boolean, at: string, keyOf: (r: R) => string = (r) => r.name): void {
    const key = org.toLowerCase();
    this.db.exec('BEGIN');
    try {
      if (full) this.db.prepare('DELETE FROM org_repos WHERE org = ?').run(key);
      const put = this.db.prepare('INSERT INTO org_repos (org, name, record) VALUES (?, ?, ?) ON CONFLICT(org, name) DO UPDATE SET record = excluded.record');
      for (const r of repos) put.run(key, keyOf(r), JSON.stringify(r));
      this.db
        .prepare(`INSERT INTO org_scans (org, checked_at, listed_at) VALUES (?, ?, ?) ON CONFLICT(org) DO UPDATE SET checked_at = excluded.checked_at${full ? ', listed_at = excluded.listed_at' : ''}`)
        .run(key, at, at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** A run of a cron task starts: recorded as running, so the page shows it. */
  startCronRun(task: string, trigger: CronRunView['trigger'], startedAt = new Date().toISOString()): number {
    const r = this.db.prepare("INSERT INTO cron_runs (task, trigger, status, started_at) VALUES (?, ?, 'running', ?)").run(task, trigger, startedAt);
    return Number(r.lastInsertRowid);
  }

  /** A run that never started, like one skipped while the last still runs. */
  addCronRun(task: string, trigger: CronRunView['trigger'], status: CronRunStatus, output: string, startedAt = new Date().toISOString()): number {
    const r = this.db
      .prepare('INSERT INTO cron_runs (task, trigger, status, started_at, duration_ms, exit_code, output) VALUES (?, ?, ?, ?, 0, NULL, ?)')
      .run(task, trigger, status, startedAt, output);
    return Number(r.lastInsertRowid);
  }

  finishCronRun(id: number, status: CronRunStatus, exitCode: number | null, durationMs: number, output: string): void {
    this.db.prepare('UPDATE cron_runs SET status = ?, exit_code = ?, duration_ms = ?, output = ? WHERE id = ?').run(status, exitCode, durationMs, output, id);
  }

  /** A task's runs, newest first, without their output. */
  cronRuns(task: string, limit = 100): CronRunView[] {
    return (this.db.prepare(`SELECT ${CRON_COLUMNS} FROM cron_runs WHERE task = ? ORDER BY id DESC LIMIT ?`).all(task, limit) as unknown as CronRow[]).map(cronRun);
  }

  /** The newest run of each task. */
  lastCronRuns(): Map<string, CronRunView> {
    const rows = this.db.prepare(`SELECT ${CRON_COLUMNS} FROM cron_runs WHERE id IN (SELECT MAX(id) FROM cron_runs GROUP BY task)`).all() as unknown as CronRow[];
    return new Map(rows.map((r) => [r.task, cronRun(r)]));
  }

  /** One run with its output. */
  cronRun(id: number): CronRunView | undefined {
    const row = this.db.prepare(`SELECT ${CRON_COLUMNS}, output FROM cron_runs WHERE id = ?`).get(id) as unknown as (CronRow & { output: string }) | undefined;
    return row ? { ...cronRun(row), output: row.output } : undefined;
  }

  clearCronRuns(task: string): number {
    return Number(this.db.prepare('DELETE FROM cron_runs WHERE task = ?').run(task).changes);
  }

  /**
   * Keeps the last 100 runs of each task, and a failed one for 14 days even
   * past those; a task no longer in the crontab (live, when known) keeps its
   * runs for 14 days.
   */
  pruneCronRuns(now = Date.now(), live?: readonly string[]): number {
    const cutoff = new Date(now - CRON_KEEP_DAYS * 24 * 3600 * 1000).toISOString();
    let n = Number(
      this.db
        .prepare(
          `DELETE FROM cron_runs WHERE id IN (
             SELECT id FROM (SELECT id, status, started_at, ROW_NUMBER() OVER (PARTITION BY task ORDER BY id DESC) AS n FROM cron_runs)
             WHERE n > ${CRON_KEEP_RUNS} AND (status != 'failed' OR started_at < ?))`,
        )
        .run(cutoff).changes,
    );
    if (live) {
      const keep = new Set(live);
      const gone = (this.db.prepare('SELECT DISTINCT task FROM cron_runs').all() as Array<{ task: string }>).map((r) => r.task).filter((t) => !keep.has(t));
      for (const task of gone) n += Number(this.db.prepare('DELETE FROM cron_runs WHERE task = ? AND started_at < ?').run(task, cutoff).changes);
    }
    return n;
  }

  close(): void {
    this.db.close();
  }
}

interface CronRow {
  id: number;
  task: string;
  trigger: CronRunView['trigger'];
  status: CronRunStatus;
  startedAt: string;
  durationMs: number | null;
  exitCode: number | null;
}

const CRON_COLUMNS = 'id, task, trigger, status, started_at AS startedAt, duration_ms AS durationMs, exit_code AS exitCode';
/** Runs kept per task, and how long a failed one or one of a removed task stays past those. */
export const CRON_KEEP_RUNS = 100;
export const CRON_KEEP_DAYS = 14;

const cronRun = (r: CronRow): CronRunView => ({ id: r.id, task: r.task, trigger: r.trigger, status: r.status, startedAt: r.startedAt, durationMs: r.durationMs, exitCode: r.exitCode });

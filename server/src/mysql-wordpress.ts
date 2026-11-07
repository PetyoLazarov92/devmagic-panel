import type { DbTable, WpDbBlog, WpDbContent, WpDbMetaKeys, WpDbReport, WpDbSection, WpDbUser } from '@devmagic-panel/shared';
import { WP_AUTOLOAD_LIMIT, WP_AUTOLOAD_VALUES, WP_DB_ON_DEMAND, WP_DB_SECTIONS, WP_DB_SLOW_SECTIONS, WP_KEEP_REVISIONS, WP_META_SIZE_ROWS } from '@devmagic-panel/shared';
import { type BrowseContext, checkDatabase, dbOverview, num, parseJson, READ_LIMIT_MS, read } from './mysql-browse.js';
import { wordpressHealth } from './mysql-health.js';
import { wordpressPlugins } from './wordpress-plugins.js';
import { siteDatabases } from './mysql-server.js';
import { BrowseError, ident, textLiteral } from './mysql-sql.js';

/**
 * The WordPress view of a site's database, read only: autoloaded options,
 * transients, what a clean-up would find (revisions, drafts, trash, spam,
 * orphaned meta), the postmeta keys that take the most room and the users.
 * Table names come from the prefix in wp-config.php and are used only when
 * the database has them; every other word of the SQL is a constant here.
 */
type Section = WpDbSection;

/** The tables each site of WordPress has, and the ones a whole network shares. */
const SITE_TABLES = ['options', 'posts', 'postmeta', 'comments', 'commentmeta', 'terms', 'term_taxonomy', 'term_relationships', 'termmeta'];
const SHARED_TABLES = ['users', 'usermeta'];

const PREFIX = /^[A-Za-z0-9_]{1,40}$/;
const AUTOLOADED = `autoload IN (${WP_AUTOLOAD_VALUES.map((v) => `'${v}'`).join(', ')})`;
const MAX_USERS = 100;
/** The parts that read whole tables get a minute; the rest the browser's usual 15 seconds. */
const SLOW_LIMIT_MS = 60_000;
/** Look for duplicates reads every value of postmeta: two minutes. */
const ON_DEMAND_LIMIT_MS = 120_000;

/** What plugins leave that a clean-up takes, shared with mysql-cleanup.ts so the count and the delete match. */
export const OEMBED_WHERE = "meta_key LIKE '\\_oembed\\_%'";
export const AKISMET_WHERE = "meta_key IN ('akismet_history', 'akismet_as_submitted')";
export const ACTIONS_DONE = "('complete', 'failed', 'canceled')";
/** Each revision with its place among its post's revisions, newest first. */
export const revisionRanks = (posts: string) => `SELECT ID, ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_date DESC, ID DESC) AS n FROM ${posts} WHERE post_type = 'revision'`;

/** The site's database and table prefix, as its wp-config.php says; only a database on this machine's MySQL. */
function siteDatabase(ctx: BrowseContext, domain: string, path?: string): { database: string; prefix: string } {
  const found = siteDatabases(ctx.config).find((s) => s.domain === domain && s.path === path);
  if (!found?.db) throw new BrowseError(`${domain}${path ?? ''} has no database on this computer's MySQL server`, 404);
  const prefix = found.prefix ?? 'wp_';
  if (!PREFIX.test(prefix)) throw new BrowseError(`The table prefix in wp-config.php is not one the panel reads: ${prefix.slice(0, 40)}`);
  return { database: checkDatabase(found.db), prefix };
}

/** The role names in a wp_capabilities value, a PHP serialized array of role => true. */
export function rolesOf(capabilities: unknown): string[] {
  if (typeof capabilities !== 'string') return [];
  return [...capabilities.matchAll(/s:\d+:"([^"]+)";b:1;/g)].map((m) => m[1] as string);
}

const tagged = (lines: string[], tag: string) => lines.map(parseJson).filter((r) => r[0] === tag).map((r) => r.slice(1));

/** A WordPress site's database as the report and the clean-ups read it: its tables, its network's sites, and the prefix of the site picked. */
export interface WordpressTables {
  database: string;
  prefix: string;
  blog: number;
  blogPrefix: string;
  names: Set<string>;
  network?: WpDbBlog[];
}

export async function wordpressTables(ctx: BrowseContext, domain: string, path: string | undefined, blog = 1): Promise<WordpressTables> {
  const { database, prefix } = siteDatabase(ctx, domain, path);
  const db = ident(database);
  const names = new Set(await read(ctx, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)};\n`, { raw: false }));

  let network: WpDbBlog[] | undefined;
  if (names.has(`${prefix}blogs`)) {
    const rows = await read(ctx, `SELECT JSON_ARRAY(blog_id, domain, path, archived, spam, deleted) FROM ${db}.${ident(`${prefix}blogs`)} ORDER BY blog_id LIMIT 1000;\n`);
    network = rows.map(parseJson).map(([id, d, p, archived, spam, deleted]) => {
      const n = num(id);
      return {
        id: n,
        domain: String(d),
        path: String(p),
        prefix: n === 1 ? prefix : `${prefix}${n}_`,
        ...(num(archived) || num(spam) || num(deleted) ? { inactive: true } : {}),
      };
    });
  }
  if (!Number.isInteger(blog) || blog < 1) throw new BrowseError('A site of the network by its number, like 2');
  if (blog !== 1 && !network?.some((b) => b.id === blog)) throw new BrowseError(`This network has no site ${blog}`, 404);
  const blogPrefix = blog === 1 ? prefix : `${prefix}${blog}_`;
  return { database, prefix, blog, blogPrefix, names, ...(network ? { network } : {}) };
}

export interface WordpressReportOptions {
  /** Notes the site's table sizes and answers what grew; no growth part without it (the assistant's summary). */
  history?: (database: string, sizes: Array<{ table: string; bytes: number }>) => WpDbReport['growth'];
  /** The parts to read; the others are left out of the answer. All of them when not given. */
  sections?: readonly WpDbSection[];
  /** Read the size of every postmeta value, however big the table. */
  sizes?: boolean;
}

export async function wordpressReport(
  ctx: BrowseContext,
  domain: string,
  path: string | undefined,
  blog = 1,
  now = Date.now,
  { sections: wanted = WP_DB_SECTIONS.filter((s) => !WP_DB_ON_DEMAND.includes(s)), sizes = false, history }: WordpressReportOptions = {},
): Promise<WpDbReport> {
  const { database, prefix, blogPrefix, names, network } = await wordpressTables(ctx, domain, path, blog);
  const db = ident(database);

  /** A table of this site (or the network's shared one), qualified and in backticks, when the database has it. */
  const table = (name: string, shared = false): string | null => {
    const full = `${shared ? prefix : blogPrefix}${name}`;
    return names.has(full) ? `${db}.${ident(full)}` : null;
  };
  const missingTables = [...SITE_TABLES.map((n) => `${blogPrefix}${n}`), ...SHARED_TABLES.map((n) => `${prefix}${n}`)].filter((n) => !names.has(n));

  const options = table('options');
  const posts = table('posts');
  const comments = table('comments');
  const users = table('users', true);
  const usermeta = table('usermeta', true);

  const sections: Record<Section, () => Promise<unknown>> = {
    // information_schema only, and counts for a table that lost its keys: quick.
    health: () => wordpressHealth(ctx, database, names, prefix, blogPrefix, blog),
    // The tables and autoloaded options of plugins, with whether each plugin is on: names and sizes only.
    plugins: () => wordpressPlugins(ctx, { domain, path, database, names, prefix, blogPrefix, blog, network: network !== undefined }),
    autoload: async () => {
      if (!options) return null;
      const lines = await read(
        ctx,
        `SELECT JSON_ARRAY('a', COUNT(*), COALESCE(SUM(LENGTH(option_value)), 0)) FROM ${options} WHERE ${AUTOLOADED};\n` +
          `SELECT JSON_ARRAY('o', option_name, LENGTH(option_value)) FROM ${options} WHERE ${AUTOLOADED} ORDER BY LENGTH(option_value) DESC LIMIT 20;\n`,
      );
      const [count, bytes] = tagged(lines, 'a')[0] ?? [];
      return { count: num(count), bytes: num(bytes), limitBytes: WP_AUTOLOAD_LIMIT, top: tagged(lines, 'o').map(([name, size]) => ({ name: String(name), bytes: num(size) })) };
    },
    transients: async () => {
      if (!options) return null;
      // _transient_timeout_x holds when _transient_x expires; a site transient lives in sitemeta on a network.
      const kinds = (tag: string, from: string, nameCol: string, valueCol: string, kind: string) =>
        `SELECT JSON_ARRAY('${tag}', COUNT(*), COALESCE(SUM(LENGTH(${valueCol})), 0)) FROM ${from} WHERE ${nameCol} LIKE '\\_${kind}\\_%' AND ${nameCol} NOT LIKE '\\_${kind}\\_timeout\\_%';\n` +
        `SELECT JSON_ARRAY('${tag}x', COUNT(*)) FROM ${from} WHERE ${nameCol} LIKE '\\_${kind}\\_timeout\\_%' AND CAST(${valueCol} AS UNSIGNED) < UNIX_TIMESTAMP();\n`;
      const sitemeta = network ? table('sitemeta', true) : null;
      const sql = kinds('t', options, 'option_name', 'option_value', 'transient') + (sitemeta ? kinds('s', sitemeta, 'meta_key', 'meta_value', 'site\\_transient') : kinds('s', options, 'option_name', 'option_value', 'site\\_transient'));
      const lines = await read(ctx, sql);
      const pick = (tag: string) => {
        const [count, bytes] = tagged(lines, tag)[0] ?? [];
        return { count: num(count), bytes: num(bytes), expired: num(tagged(lines, `${tag}x`)[0]?.[0]) };
      };
      return { ...pick('t'), site: pick('s') };
    },
    content: async (): Promise<WpDbContent | null> => {
      if (!posts && !comments) return null;
      // What plugins leave, counted only where the site has their table; each count reads an index those tables have.
      const postmeta = table('postmeta');
      const commentmeta = table('commentmeta');
      const actions = table('actionscheduler_actions');
      const logs = table('actionscheduler_logs');
      const sessions = table('woocommerce_sessions');
      const lines = await read(
        ctx,
        (posts ? `SELECT JSON_ARRAY('p', COALESCE(SUM(post_type = 'revision'), 0), COALESCE(SUM(post_status = 'auto-draft'), 0), COALESCE(SUM(post_status = 'trash'), 0)) FROM ${posts};\n` : '') +
          (comments ? `SELECT JSON_ARRAY('c', COALESCE(SUM(comment_approved = 'spam'), 0), COALESCE(SUM(comment_approved = 'trash'), 0)) FROM ${comments};\n` : '') +
          (postmeta ? `SELECT JSON_ARRAY('oe', COUNT(*)) FROM ${postmeta} WHERE ${OEMBED_WHERE};\n` : '') +
          (commentmeta ? `SELECT JSON_ARRAY('ak', COUNT(*)) FROM ${commentmeta} WHERE ${AKISMET_WHERE};\n` : '') +
          (actions ? `SELECT JSON_ARRAY('as', COUNT(*)) FROM ${actions} WHERE status IN ${ACTIONS_DONE};\n` : '') +
          (actions && logs ? `SELECT JSON_ARRAY('al', COUNT(*)) FROM ${logs} l WHERE NOT EXISTS (SELECT 1 FROM ${actions} a WHERE a.action_id = l.action_id AND a.status NOT IN ${ACTIONS_DONE});\n` : '') +
          (sessions ? `SELECT JSON_ARRAY('ws', COUNT(*)) FROM ${sessions} WHERE session_expiry < UNIX_TIMESTAMP();\n` : '') +
          (blog === 1 && usermeta ? `SELECT JSON_ARRAY('st', COUNT(*)) FROM ${usermeta} WHERE meta_key = 'session_tokens';\n` : ''),
        { limitMs: SLOW_LIMIT_MS },
      );
      const [revisions, autoDrafts, trashedPosts] = tagged(lines, 'p')[0] ?? [];
      const [spam, trash] = tagged(lines, 'c')[0] ?? [];
      const one = (tag: string) => (tagged(lines, tag)[0] ? num(tagged(lines, tag)[0]?.[0]) : undefined);
      // Revisions past the newest few of each post: a window function, so MySQL 8 or MariaDB 10.2; older ones just do not offer to keep some.
      let revisionsOver: WpDbContent['revisionsOver'];
      if (posts && num(revisions) > 0) {
        try {
          const [over = []] = tagged(await read(ctx, `SELECT JSON_ARRAY('r', ${WP_KEEP_REVISIONS.map((n) => `COALESCE(SUM(n > ${n}), 0)`).join(', ')}) FROM (${revisionRanks(posts)}) r;\n`, { limitMs: SLOW_LIMIT_MS }), 'r');
          revisionsOver = Object.fromEntries(WP_KEEP_REVISIONS.map((n, i) => [n, num(over[i])]));
        } catch (error) {
          if (error instanceof BrowseError && error.status === 499) throw error;
        }
      }
      const extra = { oembed: one('oe'), akismet: one('ak'), actionsDone: one('as'), actionLogs: one('al'), wcSessions: one('ws'), sessionTokens: one('st') };
      return {
        revisions: num(revisions),
        ...(revisionsOver ? { revisionsOver } : {}),
        autoDrafts: num(autoDrafts),
        trashedPosts: num(trashedPosts),
        spamComments: num(spam),
        trashedComments: num(trash),
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
      };
    },
    growth: async () => {
      if (!history) return null;
      // This site's tables, without another site of the network's (wp_2_) on the first one.
      const other = new RegExp(`^${prefix}\\d+_`);
      const lines = await read(ctx, `SELECT JSON_ARRAY(TABLE_NAME, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)} AND TABLE_TYPE = 'BASE TABLE';\n`);
      const sizes = lines.map(parseJson).map(([t, b]) => ({ table: String(t), bytes: num(b) })).filter((t) => t.table.startsWith(blogPrefix) && (blog !== 1 || !other.test(t.table)));
      return history(`${database}#${blog}`, sizes);
    },
    postTypes: async () => {
      if (!posts) return null;
      const site = siteDatabases(ctx.config).find((s) => s.domain === domain && s.path === path);
      const own = network?.find((b) => b.id === blog);
      const url = blog === 1 ? `https://${domain}${path ?? ''}/` : own ? `https://${own.domain}${own.path}` : undefined;
      if (!site?.docroot || !url) return null;
      // Plugins and the theme load: the post types they register are the point.
      const wp = await ctx.exec('wp', [`--path=${site.docroot}`, `--url=${url}`, 'post-type', 'list', '--field=name'], { timeoutMs: SLOW_LIMIT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (ctx.signal?.aborted) throw new BrowseError('The read is no longer needed', 499);
      if (wp.code !== 0) throw new BrowseError(`WP-CLI could not list the post types: ${(wp.stderr || wp.stdout).trim().split('\n').at(-1) ?? `exit ${wp.code}`}`, 502);
      const registered = new Set(wp.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      const lines = await read(ctx, `SELECT JSON_ARRAY(post_type, COUNT(*)) FROM ${posts} GROUP BY post_type;\n`, { limitMs: SLOW_LIMIT_MS });
      const unregistered = lines
        .map(parseJson)
        .map(([t, n]) => ({ type: String(t), count: num(n) }))
        .filter((t) => !registered.has(t.type))
        .sort((a, b) => b.count - a.count);
      return { unregistered };
    },
    duplicates: async () => {
      const postmeta = table('postmeta');
      if (!postmeta) return null;
      // Every row read: only when you ask, with more time.
      const lines = await read(ctx, `SELECT JSON_ARRAY(meta_key, SUM(c - 1)) FROM (SELECT meta_key, COUNT(*) AS c FROM ${postmeta} GROUP BY post_id, meta_key, MD5(meta_value) HAVING COUNT(*) > 1) d GROUP BY meta_key ORDER BY SUM(c - 1) DESC;\n`, { limitMs: ON_DEMAND_LIMIT_MS });
      const keys = lines.map(parseJson).map(([k, n]) => ({ key: k === null ? '' : String(k), rows: num(n) }));
      return { rows: keys.reduce((n, k) => n + k.rows, 0), keys: keys.slice(0, 20) };
    },
    orphans: async () => {
      const orphan = (tag: string, meta: string | null, parent: string | null, key: string, parentKey: string) =>
        meta && parent ? `SELECT JSON_ARRAY('${tag}', COUNT(*)) FROM ${meta} m LEFT JOIN ${parent} p ON p.${parentKey} = m.${key} WHERE p.${parentKey} IS NULL;\n` : '';
      const relationships = table('term_relationships');
      const taxonomy = table('term_taxonomy');
      // A relationship to a link (link_category) has no post either: those are not orphans.
      const sql =
        orphan('pm', table('postmeta'), posts, 'post_id', 'ID') +
        orphan('cm', table('commentmeta'), comments, 'comment_id', 'comment_ID') +
        orphan('tm', table('termmeta'), table('terms'), 'term_id', 'term_id') +
        (relationships && posts && taxonomy
          ? `SELECT JSON_ARRAY('tr', COUNT(*)) FROM ${relationships} r LEFT JOIN ${posts} p ON p.ID = r.object_id LEFT JOIN ${taxonomy} t ON t.term_taxonomy_id = r.term_taxonomy_id WHERE p.ID IS NULL AND (t.taxonomy IS NULL OR t.taxonomy <> 'link_category');\n`
          : '') +
        (blog === 1 ? orphan('um', usermeta, users, 'user_id', 'ID') : '');
      if (!sql) return null;
      const lines = await read(ctx, sql, { limitMs: SLOW_LIMIT_MS });
      const count = (tag: string) => num(tagged(lines, tag)[0]?.[0]);
      return { postmeta: count('pm'), commentmeta: count('cm'), termmeta: count('tm'), termRelationships: count('tr'), ...(blog === 1 && usermeta && users ? { usermeta: count('um') } : {}) };
    },
    metaKeys: async (): Promise<WpDbMetaKeys | null> => {
      const postmeta = table('postmeta');
      if (!postmeta) return null;
      const estimate = await read(ctx, `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${textLiteral(database)} AND TABLE_NAME = ${textLiteral(`${blogPrefix}postmeta`)};\n`, { raw: false });
      const estimatedRows = num(estimate[0]);
      // A size needs every value read, long ones from their own pages; a count only the rows. Big tables are counted first.
      const sized = sizes || estimatedRows <= WP_META_SIZE_ROWS;
      const lines = await read(
        ctx,
        sized
          ? `SELECT JSON_ARRAY(meta_key, COUNT(*), COALESCE(SUM(LENGTH(meta_value)), 0)) FROM ${postmeta} GROUP BY meta_key ORDER BY SUM(LENGTH(meta_value)) DESC LIMIT 20;\n`
          : `SELECT JSON_ARRAY(meta_key, COUNT(*)) FROM ${postmeta} GROUP BY meta_key ORDER BY COUNT(*) DESC LIMIT 20;\n`,
        { limitMs: SLOW_LIMIT_MS },
      );
      const keys = lines.map(parseJson).map(([key, count, bytes]) => ({ key: key === null ? '' : String(key), count: num(count), ...(sized ? { bytes: num(bytes) } : {}) }));
      return { estimatedRows, sized, keys };
    },
    users: async () => {
      if (!users) return null;
      // Roles on this site: wp_capabilities on the first site, wp_2_capabilities on the second.
      const capabilities = textLiteral(`${blogPrefix}capabilities`);
      const lines = await read(
        ctx,
        `SELECT JSON_ARRAY('n', COUNT(*)) FROM ${users};\n` +
          `SELECT JSON_ARRAY('u', u.ID, u.user_login, u.user_email, u.user_registered, ${usermeta ? 'm.meta_value' : 'NULL'}) FROM ${users} u` +
          (usermeta ? ` LEFT JOIN ${usermeta} m ON m.user_id = u.ID AND m.meta_key = ${capabilities}` : '') +
          ` ORDER BY u.ID LIMIT ${MAX_USERS};\n`,
      );
      const list: WpDbUser[] = tagged(lines, 'u').map(([id, login, email, registered, caps]) => ({
        id: String(id),
        login: String(login ?? ''),
        email: String(email ?? ''),
        registered: String(registered ?? ''),
        roles: rolesOf(caps),
      }));
      return { count: num(tagged(lines, 'n')[0]?.[0]), list };
    },
  };

  const keys = WP_DB_SECTIONS.filter((k) => wanted.includes(k));
  const settled = await Promise.allSettled(keys.map((k) => sections[k]()));
  const errors: WpDbReport['errors'] = {};
  const results = Object.fromEntries(
    keys.map((k, i) => {
      const r = settled[i] as PromiseSettledResult<unknown>;
      if (r.status === 'fulfilled') return [k, r.value];
      // A read nobody waits for any more ends the whole answer, so it is never kept as that part's error.
      if (!(r.reason instanceof BrowseError) || r.reason.status === 499) throw r.reason;
      // A part of this view has no filter to narrow it: say how long MySQL had instead.
      const limit = WP_DB_ON_DEMAND.includes(k) ? ON_DEMAND_LIMIT_MS : WP_DB_SLOW_SECTIONS.includes(k) ? SLOW_LIMIT_MS : READ_LIMIT_MS;
      errors[k] = r.reason.status === 504 ? `MySQL stopped the read after ${limit / 1000} seconds: the tables are too big to read in time` : r.reason.message;
      return [k, null];
    }),
  ) as Pick<WpDbReport, Section>;

  return {
    database,
    prefix,
    blog,
    blogPrefix,
    ...(network ? { network } : {}),
    missingTables,
    ...results,
    errors,
    checkedAt: new Date(now()).toISOString(),
  };
}

/**
 * What the assistant may know about a site's database: names, sizes and
 * counts, never a value from a row (no option values, no users or emails).
 */
export async function databaseSummary(ctx: BrowseContext, domain: string, path?: string) {
  const { database } = siteDatabase(ctx, domain, path);
  // Only the parts it tells: no WP-CLI for post types, no scan of every postmeta value.
  const [overview, wp] = await Promise.all([dbOverview(ctx, database), wordpressReport(ctx, domain, path, 1, Date.now, { sections: ['autoload', 'transients', 'users', 'content', 'orphans', 'metaKeys'] })]);
  const mb = (n: number) => Math.round((n / 1024 ** 2) * 10) / 10;
  const biggest = [...overview.tables].sort((a: DbTable, b: DbTable) => b.dataBytes + b.indexBytes - (a.dataBytes + a.indexBytes)).slice(0, 15);
  return {
    database,
    prefix: wp.prefix,
    tables: overview.tables.length,
    totalMb: mb(overview.totalBytes),
    biggestTables: biggest.map((t) => ({ name: t.name, engine: t.engine, rows: t.rows, mb: mb(t.dataBytes + t.indexBytes), freeMb: mb(t.freeBytes) })),
    notInnodb: overview.tables.filter((t) => !t.view && t.engine && t.engine.toLowerCase() !== 'innodb').map((t) => `${t.name} (${t.engine})`),
    ...(wp.network ? { networkSites: wp.network.length } : {}),
    missingTables: wp.missingTables,
    autoload: wp.autoload && { count: wp.autoload.count, kb: Math.round(wp.autoload.bytes / 1024), siteHealthLimitKb: Math.round(wp.autoload.limitBytes / 1024), biggestOptions: wp.autoload.top.map((o) => ({ name: o.name, kb: Math.round(o.bytes / 102.4) / 10 })) },
    transients: wp.transients,
    content: wp.content,
    orphans: wp.orphans,
    biggestPostmetaKeys: wp.metaKeys?.keys.map((k) => ({ key: k.key, rows: k.count, ...(k.bytes === undefined ? {} : { mb: mb(k.bytes) }) })) ?? null,
    users: wp.users ? wp.users.count : null,
    ...(Object.keys(wp.errors).length ? { notRead: wp.errors } : {}),
  };
}

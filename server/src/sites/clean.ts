import type { ActionInput } from '@devmagic-panel/shared';
import { CLEAN_FORM_TABLES, CLEAN_LOG_TABLES, CLEAN_WOO_TABLES, isLocalName, MAIL_PLUGINS, PRODUCTION_ONLY_PLUGINS } from '@devmagic-panel/shared';
import type { ExecResult } from '../exec.js';
import type { JobRuntime, JobStep } from '../jobs.js';
import { type LimitsTarget, withRaisedLimits } from '../mysql-limits.js';
import { freshStatsSql } from '../mysql-stats.js';
import type { RunStore } from '../store.js';
import { CHECK_SKIPPED, type DbContext, DbRefused, flush, type WpRunner, httpsForLocals, importOptions, importSql, isLocalDbHost, limitsTarget, raisedFor, replaceDomains, wordpressSite } from './db.js';
import { sqlFileFor } from './dump.js';
import { sqlModeStatement } from './sql-stream.js';
import { checkAddresses } from './replace.js';
import { canKeep, chooseMode, dropSide, KEEP_DAYS, keepName, makeSide, sideName, SWAP_UNDO, swapIn } from './swap.js';
import { readUpload } from './uploads.js';

/**
 * A production dump made a site's database without private data. It is
 * imported into a side database and cleaned there with plain SQL, so no
 * WordPress or plugin code runs on production data and nothing can send
 * mail; only then is it swapped in, with the site's tables from before kept
 * for KEEP_DAYS days. After that the usual replace, the mail and
 * production-only plugins turned off, and one user left: an administrator
 * you keep or a new one, the author of every post, as wp user delete
 * --reassign leaves it. Comments stay as they are.
 */

/** A table of the side database, with information_schema's row count (an estimate for InnoDB) and size of data and indexes. */
export interface SideTable {
  name: string;
  rows: number;
  bytes?: number;
}

export interface CleanGroup {
  id: 'users' | 'woocommerce' | 'reviews' | 'forms' | 'logs' | 'secrets' | 'settings';
  label: string;
  statements: string[];
}

/** Orders, refunds and subscriptions where WooCommerce keeps them as posts. */
const ORDER_TYPES = ['shop_order', 'shop_order_refund', 'shop_order_placehold', 'shop_subscription'];
/** Form entries kept as posts: Flamingo's messages and contacts, Ninja Forms' submissions. */
const FORM_TYPES = ['flamingo_inbound', 'flamingo_contact', 'flamingo_outbound', 'nf_sub'];
/** Settings that hold payment, mail and API keys, by name. */
const SECRET_OPTIONS = [
  'wp_mail_smtp', 'postman_options', 'swpsmtp_options', 'fluentmail-settings', 'mailgun', 'mc4wp', 'jetpack_options', 'jetpack_private_options',
  'woocommerce_stripe_settings', 'woocommerce_paypal_settings', 'woocommerce_ppcp-gateway_settings', 'woocommerce-ppcp-settings',
];
/** And by the start of their name (LIKE, with _ escaped). */
const SECRET_PATTERNS = [
  'woocommerce\\_stripe\\_%', 'woocommerce-ppcp-%', 'woocommerce\\_ppcp-%', 'woocommerce\\_paypal%', 'woocommerce\\_square\\_%', 'wc\\_square\\_%',
  'woocommerce\\_braintree\\_%', 'woocommerce\\_authorize\\_net\\_%', 'mailchimp-woocommerce%', 'mailchimp\\_woocommerce\\_%',
];
/** WooCommerce's admin mail settings with a recipient: without them it mails the site's admin address. */
const WOO_RECIPIENT_SETTINGS = ['woocommerce_new_order_settings', 'woocommerce_cancelled_order_settings', 'woocommerce_failed_order_settings'];

const q = (name: string) => `\`${name}\``;
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
/** A line of the report: what was removed, how many, and whether that is information_schema's estimate. */
const report = (label: string, count: string, kind: 'about' | 'exact') => `SELECT '${label}', ${count}, '${kind}';`;

/** A login as a PHP serialized string, as site_admins holds it: logins are plain ASCII, so length is bytes. */
const serializedLogin = (login: string) => `s:${login.length}:"${login}";`;

/**
 * The users group: every user goes, but keep's row and meta when given,
 * whose address becomes adminEmail. The tables are emptied with TRUNCATE
 * (fast on a shop with a million customers), and the id counter is set
 * back past the highest id there was, so no new user takes the id of one
 * that went: comments keep the user_id of who wrote them, as after wp user
 * delete.
 */
function usersStatements(find: (name: string) => SideTable | undefined, base: string, adminEmail: string, keep: string | undefined): string[] {
  const users = find(`${base}users`);
  const meta = find(`${base}usermeta`);
  const sitemeta = find(`${base}sitemeta`);
  const others = [find(`${base}signups`), find(`${base}registration_log`)].filter((t): t is SideTable => t !== undefined);
  const out: string[] = [];
  if (users) {
    out.push(`SELECT COALESCE(MAX(ID), 0) + 1 INTO @dmp_next_id FROM ${q(users.name)};`);
    if (keep) {
      out.push(
        `CREATE TEMPORARY TABLE dmp_keep_user AS SELECT * FROM ${q(users.name)} WHERE user_login = '${keep}';`,
        ...(meta ? [`CREATE TEMPORARY TABLE dmp_keep_meta AS SELECT m.* FROM ${q(meta.name)} m JOIN dmp_keep_user u ON u.ID = m.user_id;`] : []),
      );
    }
    out.push(`TRUNCATE TABLE ${q(users.name)};`, ...(meta ? [`TRUNCATE TABLE ${q(meta.name)};`] : []));
    if (keep) {
      out.push(
        `INSERT INTO ${q(users.name)} SELECT * FROM dmp_keep_user;`,
        ...(meta ? [`INSERT INTO ${q(meta.name)} SELECT * FROM dmp_keep_meta;`] : []),
        `UPDATE ${q(users.name)} SET user_email = '${adminEmail}';`,
      );
    }
    out.push(
      `SET @dmp_ai = CONCAT('ALTER TABLE ${q(users.name)} AUTO_INCREMENT = ', @dmp_next_id);`,
      'PREPARE dmp_ai FROM @dmp_ai;',
      'EXECUTE dmp_ai;',
      'DEALLOCATE PREPARE dmp_ai;',
      report(`${users.name} removed${keep ? `, all but ${keep}` : ''}`, String(Math.max(0, users.rows - (keep ? 1 : 0))), 'about'),
      ...(meta ? [report(`${meta.name} removed with them`, String(meta.rows), 'about')] : []),
    );
  }
  for (const t of others) out.push(`TRUNCATE TABLE ${q(t.name)};`, report(`${t.name} emptied`, String(t.rows), 'about'));
  if (sitemeta) out.push(`UPDATE ${q(sitemeta.name)} SET meta_value = '${keep ? `a:1:{i:0;${serializedLogin(keep)}}` : 'a:0:{}'}' WHERE meta_key = 'site_admins';`);
  return out;
}

/**
 * The statements that clean a side database, for the tables it has. A
 * network's sites each get theirs (wp_2_, wp_3_ ...); users, signups and the
 * network's own tables are the main prefix's only. keep: the login of the
 * one user to keep, when one already there stays.
 */
export function cleanupPlan(tables: readonly SideTable[], base: string, adminEmail: string, keep?: string): CleanGroup[] {
  return buildCleanup(tables, base, adminEmail, keep).groups;
}

/**
 * The tables the clean-up empties whole and puts nothing back in: logs, form
 * entries, orders. Clean this database makes them without their rows. Not
 * the users tables, which keep the user you keep.
 */
export function emptiedTables(tables: readonly SideTable[], base: string): SideTable[] {
  const emptied = new Set(buildCleanup(tables, base, 'admin@localhost').emptied);
  return tables.filter((t) => emptied.has(t.name));
}

function buildCleanup(tables: readonly SideTable[], base: string, adminEmail: string, keep?: string): { groups: CleanGroup[]; emptied: string[] } {
  const emptied: string[] = [];
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const find = (name: string) => byName.get(name.toLowerCase());
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sites = [base, ...tables.map((t) => new RegExp(`^${escaped}(\\d+)_options$`, 'i').exec(t.name)?.[1]).filter((id): id is string => id !== undefined).map((id) => `${base}${id}_`)];
  const truncate = (names: Array<SideTable | undefined>) =>
    names.filter((t): t is SideTable => t !== undefined).flatMap((t) => {
      emptied.push(t.name);
      return [`TRUNCATE TABLE ${q(t.name)};`, report(`${t.name} emptied`, String(t.rows), 'about')];
    });
  const each = (fn: (p: string) => string[]) => sites.flatMap(fn);
  const has = (p: string, suffix: string) => find(`${p}${suffix}`);
  const woo = (p: string) => tables.some((t) => t.name.toLowerCase().startsWith(`${p}woocommerce_`.toLowerCase()) || t.name.toLowerCase().startsWith(`${p}wc_`.toLowerCase()));
  const deletePosts = (p: string, types: readonly string[], label: string) => {
    const posts = has(p, 'posts');
    const meta = has(p, 'postmeta');
    if (!posts) return [];
    return [
      ...(meta ? [`DELETE m FROM ${q(meta.name)} m JOIN ${q(posts.name)} o ON o.ID = m.post_id WHERE o.post_type IN (${list(types)});`] : []),
      `DELETE FROM ${q(posts.name)} WHERE post_type IN (${list(types)});`,
      report(label, 'ROW_COUNT()', 'exact'),
    ];
  };
  const deleteComments = (p: string, where: string, label: string) => {
    const comments = has(p, 'comments');
    const meta = has(p, 'commentmeta');
    if (!comments) return [];
    return [
      ...(meta ? [`DELETE m FROM ${q(meta.name)} m JOIN ${q(comments.name)} c ON c.comment_ID = m.comment_id WHERE ${where};`] : []),
      `DELETE c FROM ${q(comments.name)} c WHERE ${where};`,
      report(label, 'ROW_COUNT()', 'exact'),
    ];
  };
  const options = (p: string) => has(p, 'options');
  const sitemeta = find(`${base}sitemeta`);

  const groups: CleanGroup[] = [
    {
      id: 'users',
      label: 'Users',
      statements: usersStatements(find, base, adminEmail, keep),
    },
    {
      id: 'woocommerce',
      label: 'WooCommerce orders and customers',
      statements: each((p) => {
        if (!woo(p)) return [];
        const pdf = tables.filter((t) => t.name.toLowerCase().startsWith(`${p}wcpdf_`.toLowerCase()));
        const opts = options(p);
        return [
          ...truncate([...CLEAN_WOO_TABLES.map((t) => has(p, t)), ...pdf]),
          ...deletePosts(p, ORDER_TYPES, `${p}posts orders, refunds and subscriptions`),
          ...deleteComments(p, `c.comment_type IN ('order_note', 'webhook_delivery')`, `${p}comments order notes`),
          ...(opts ? [`DELETE FROM ${q(opts.name)} WHERE option_name LIKE '\\_wc\\_session\\_%';`, report(`${opts.name} old sessions`, 'ROW_COUNT()', 'exact')] : []),
        ];
      }),
    },
    {
      id: 'reviews',
      label: 'Product reviews',
      statements: each((p) => {
        const posts = has(p, 'posts');
        if (!woo(p) || !posts) return [];
        return [
          ...deleteComments(p, `(c.comment_type = 'review' OR c.comment_post_ID IN (SELECT ID FROM ${q(posts.name)} WHERE post_type = 'product'))`, `${p}comments product reviews`),
          `UPDATE ${q(posts.name)} SET comment_count = 0 WHERE post_type = 'product';`,
        ];
      }),
    },
    {
      id: 'forms',
      label: 'Form entries',
      statements: each((p) => [...truncate(CLEAN_FORM_TABLES.map((t) => has(p, t))), ...deletePosts(p, FORM_TYPES, `${p}posts Flamingo and Ninja Forms entries`)]),
    },
    {
      id: 'logs',
      label: 'Logs',
      statements: [
        ...each((p) => {
          const opts = options(p);
          return [
            ...truncate(CLEAN_LOG_TABLES.map((t) => has(p, t))),
            ...(opts ? [`DELETE FROM ${q(opts.name)} WHERE option_name LIKE '\\_transient\\_%' OR option_name LIKE '\\_site\\_transient\\_%';`, report(`${opts.name} transients`, 'ROW_COUNT()', 'exact')] : []),
          ];
        }),
        ...(sitemeta ? [`DELETE FROM ${q(sitemeta.name)} WHERE meta_key LIKE '\\_site\\_transient\\_%';`, report(`${sitemeta.name} transients`, 'ROW_COUNT()', 'exact')] : []),
      ],
    },
    {
      id: 'secrets',
      label: 'Payment, mail and API keys',
      statements: each((p) => {
        const opts = options(p);
        if (!opts) return [];
        const like = SECRET_PATTERNS.map((pattern) => `option_name LIKE '${pattern}'`).join(' OR ');
        return [`DELETE FROM ${q(opts.name)} WHERE option_name IN (${list(SECRET_OPTIONS)}) OR ${like};`, report(`${opts.name} settings with keys`, 'ROW_COUNT()', 'exact')];
      }),
    },
    {
      id: 'settings',
      label: 'Settings',
      statements: [
        ...each((p) => {
          const opts = options(p);
          if (!opts) return [];
          return [
            `UPDATE ${q(opts.name)} SET option_value = '0' WHERE option_name = 'blog_public';`,
            `UPDATE ${q(opts.name)} SET option_value = '${adminEmail}' WHERE option_name IN ('admin_email', 'new_admin_email', 'woocommerce_email_from_address', 'woocommerce_stock_email_recipient');`,
            `DELETE FROM ${q(opts.name)} WHERE option_name IN (${list(WOO_RECIPIENT_SETTINGS)});`,
          ];
        }),
        ...(sitemeta ? [`UPDATE ${q(sitemeta.name)} SET meta_value = '${adminEmail}' WHERE meta_key = 'admin_email';`] : []),
      ],
    },
  ];
  return { groups: groups.filter((g) => g.statements.length > 0), emptied };
}

/** The statement that asks information_schema for fresh sizes (freshStatsSql), for the admin account. */
export const freshStats = (target: LimitsTarget): Promise<string> => freshStatsSql(target.exec, target.mysql);

/** The tables of a database with their estimated rows, read with the admin account. */

export async function sideTables(target: LimitsTarget, db: string): Promise<{ tables: SideTable[]; result: ExecResult }> {
  const { user, host, password } = target.mysql;
  const fresh = await freshStats(target);
  const result = await target.exec(
    'mysql',
    ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', `${fresh}SELECT TABLE_NAME, COALESCE(TABLE_ROWS, 0), COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE'`],
    { env: { MYSQL_PWD: password } },
  );
  const tables = result.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([name]) => name && /^[\w$]+$/.test(name))
    .map(([name, rows, bytes]) => ({ name: name as string, rows: Number(rows) || 0, bytes: Number(bytes) || 0 }));
  return { tables, result };
}

/** "1,234" style counts for the report. */
const count = (n: string) => Number(n).toLocaleString('en-US');

/** Runs each group's statements on the side database and says what went, leaving out what had nothing to remove. */
export async function runCleanup(target: LimitsTarget, db: string, groups: readonly CleanGroup[], job?: JobRuntime): Promise<ExecResult[]> {
  const { user, host, password } = target.mysql;
  const results: ExecResult[] = [];
  // WordPress's own SQL modes, as for an import: a copy of its tables keeps their zero dates.
  const mode = await target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', 'SELECT @@SESSION.sql_mode'], { env: { MYSQL_PWD: password } });
  const modeLine = mode.code === 0 ? sqlModeStatement(mode.stdout) : '';
  for (const [i, group] of groups.entries()) {
    job?.progress(i / groups.length, group.label);
    const r = await target.exec('mysql', ['--batch', '--skip-column-names', '--user', user, '--host', host, db], {
      env: { MYSQL_PWD: password },
      // The binary log off for this session (the admin account may): deleting rows by the million would fill it.
      input: `SET sql_log_bin = 0;\nSET foreign_key_checks = 0;\n${modeLine ? `${modeLine}\n` : ''}${group.statements.join('\n')}\n`,
      timeoutMs: 3 * 60 * 60_000,
    });
    if (r.code !== 0) return [...results, r];
    const lines = r.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([label, n]) => label && Number(n) > 0)
      .map(([label, n, kind]) => `${label}: ${kind === 'about' ? 'about ' : ''}${count(n as string)}${kind === 'about' ? ' rows' : ''}`);
    results.push({ code: 0, stdout: `${group.label}${lines.length > 0 ? `\n  ${lines.join('\n  ')}` : ': done'}`, stderr: '' });
  }
  return results;
}

export interface CleanContext extends DbContext {
  store?: RunStore;
}

/** Plugins a clean copy turns off: the mail ones and the production-only ones. */
export const CLEAN_COPY_OFF = [...new Set([...MAIL_PLUGINS, ...PRODUCTION_ONLY_PLUGINS])];

/** WP-CLI on a site with something on its stdin, like a password for --prompt. */
export const wpWithInput = (ctx: DbContext, site: { docroot: string; host: string }) => (args: string[], input: string) =>
  ctx.exec('wp', [`--path=${site.docroot}`, `--url=https://${site.host}/`, ...args, '--skip-plugins', '--skip-themes'], { input, timeoutMs: 10 * 60_000 });

/** The user a clean-up keeps or makes, as the action takes it. */
export type CleanUser = ActionInput<'db.cleanCopy'>['user'];

/** What the clean step learns about the cleaned tables, for the steps after the swap. */
export interface CleanState {
  /** Each site's table prefix: wp_, then wp_2_ and up on a network. */
  prefixes: string[];
  postsTables: string[];
  linksTables: string[];
  /** Rows of the tables copied without them, by name, for the clean-up's report. */
  leftOutRows: Map<string, number>;
}

export const newCleanState = (): CleanState => ({ prefixes: [], postsTables: [], linksTables: [], leftOutRows: new Map() });

/**
 * Checks that the user to keep is in db and an administrator (a super admin
 * on a network) before anything is removed; null when it is.
 */
async function checkKept(target: LimitsTarget, db: string, prefix: string, tables: readonly SideTable[], keep: string): Promise<ExecResult | null> {
  const { user, host, password } = target.mysql;
  const has = (name: string) => tables.some((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!has(`${prefix}users`)) return { code: 1, stdout: '', stderr: `${db} has no ${prefix}users table, so there is no ${keep} to keep` };
  const t = (name: string) => `${q(db)}.${q(name)}`;
  const admin = [
    ...(has(`${prefix}usermeta`) ? [`EXISTS(SELECT 1 FROM ${t(`${prefix}usermeta`)} m WHERE m.user_id = u.ID AND m.meta_key = '${prefix}capabilities' AND m.meta_value LIKE '%"administrator"%')`] : []),
    ...(has(`${prefix}sitemeta`) ? [`EXISTS(SELECT 1 FROM ${t(`${prefix}sitemeta`)} WHERE meta_key = 'site_admins' AND meta_value LIKE '%${serializedLogin(keep).replace(';', '')}%')`] : []),
  ];
  const r = await target.exec(
    'mysql',
    ['--batch', '--skip-column-names', '--user', user, '--host', host, '-e', `SELECT u.ID, ${admin.length > 0 ? admin.join(' OR ') : '0'} FROM ${t(`${prefix}users`)} u WHERE u.user_login = '${keep}'`],
    { env: { MYSQL_PWD: password } },
  );
  if (r.code !== 0) return r;
  const [id, isAdmin] = (r.stdout.trim().split('\n')[0] ?? '').split('\t');
  if (!id) return { code: 1, stdout: '', stderr: `there is no user ${keep} to keep: pick another, or make a new one` };
  if (isAdmin !== '1') return { code: 1, stdout: '', stderr: `${keep} is not an administrator: pick an administrator to keep, or make a new one` };
  return null;
}

/** Cleans the side database with SQL, keeping the chosen user, and notes its tables for the steps after the swap. */
export function cleanStep(target: LimitsTarget, sideDb: string, prefix: string, adminEmail: string, user: CleanUser, state: CleanState): JobStep {
  return {
    id: 'clean',
    label: `Remove ${user.keep ? `users but ${user.keep}` : 'users'}, orders, reviews, form entries, logs and keys`,
    weight: 2,
    run: async (job) => {
      const side = await sideTables(target, sideDb);
      if (side.result.code !== 0) return side.result;
      const tables = side.tables.map((t) => ({ ...t, rows: state.leftOutRows.get(t.name) ?? t.rows }));
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const named = (suffix: string) => tables.filter((t) => new RegExp(`^${escaped}(\\d+_)?${suffix}$`, 'i').test(t.name)).map((t) => t.name);
      state.postsTables = named('posts');
      state.linksTables = named('links');
      state.prefixes = named('options').map((t) => t.slice(0, -'options'.length));
      if (user.keep) {
        const refused = await checkKept(target, sideDb, prefix, tables, user.keep);
        if (refused) return refused;
      }
      job.activity?.('cleaning with SQL in the side database: no WordPress or plugin code runs');
      return withRaisedLimits(target, (line) => job.activity?.(line), () => runCleanup(target, sideDb, cleanupPlan(tables, prefix, adminEmail, user.keep), job));
    },
  };
}

/** Turns off the mail and production-only plugins without loading them (--skip-plugins), so no plugin code runs. */
export function pluginsOffStep(wp: WpRunner, multisite: boolean): JobStep {
  return {
    id: 'plugins',
    label: 'Turn off mail and production-only plugins',
    run: async () => {
      const results: ExecResult[] = [];
      const off: string[] = [];
      for (const status of multisite ? ['active-network', 'active'] : ['active']) {
        const active = await wp(['plugin', 'list', `--status=${status}`, '--field=name']);
        if (active.code !== 0) return active;
        const names = new Set(active.stdout.split('\n').map((n) => n.trim()).filter(Boolean));
        const targets = CLEAN_COPY_OFF.filter((p) => names.has(p));
        if (targets.length === 0) continue;
        const r = await wp(['plugin', 'deactivate', ...targets, ...(status === 'active-network' ? ['--network'] : [])]);
        results.push(r);
        if (r.code !== 0) return results;
        off.push(...targets);
      }
      return [...results, { code: 0, stdout: off.length > 0 ? `turned off: ${off.join(', ')}` : 'none of them were on', stderr: '' }];
    },
  };
}

/**
 * The one user left: the kept administrator with the chosen password, or a
 * new one. On a network a super admin; an administrator of every site; and
 * the author of every post and the owner of every link, as wp user delete
 * --reassign leaves them. Comments keep who wrote them.
 */
export function userStep(wp: WpRunner, wpInput: (args: string[], input: string) => Promise<ExecResult>, opts: { user: CleanUser; adminEmail: string; multisite: boolean; prefix: string; state: CleanState }): JobStep {
  const { user, adminEmail, multisite, prefix, state } = opts;
  const login = user.keep ?? user.login;
  return {
    id: 'admin',
    label: user.keep ? `Keep ${login} as the only user, the author of every post` : `Make ${login} the only user, the author of every post`,
    run: async () => {
      // The password goes on stdin (--prompt), never on the command line; --skip-email sends no notice.
      const made = user.keep
        ? await wpInput(['user', 'update', login, '--prompt=user_pass', '--skip-email'], `${user.password}\n`)
        : await wpInput(['user', 'create', login, adminEmail, '--role=administrator', '--prompt=user_pass'], `${user.password}\n`);
      if (made.code !== 0) return made;
      const results: ExecResult[] = [made];
      if (multisite && !user.keep) {
        const r = await wp(['super-admin', 'add', login]);
        results.push(r);
        if (r.code !== 0) return results;
      }
      const id = (await wp(['user', 'get', login, '--field=ID'])).stdout.trim();
      if (!/^\d+$/.test(id)) return [...results, { code: 1, stdout: '', stderr: `cannot read ${login}'s id` }];
      const meta = q(`${prefix}usermeta`);
      const sql = [
        ...state.prefixes.flatMap((p) => [
          `DELETE FROM ${meta} WHERE user_id = ${id} AND meta_key IN ('${p}capabilities', '${p}user_level');`,
          `INSERT INTO ${meta} (user_id, meta_key, meta_value) VALUES (${id}, '${p}capabilities', 'a:1:{s:13:"administrator";b:1;}'), (${id}, '${p}user_level', '10');`,
        ]),
        ...state.postsTables.map((t) => `UPDATE ${q(t)} SET post_author = ${id} WHERE post_author <> ${id};`),
        ...state.linksTables.map((t) => `UPDATE ${q(t)} SET link_owner = ${id} WHERE link_owner <> ${id};`),
      ];
      if (sql.length > 0) {
        const r = await wp(['db', 'query', sql.join(' ')]);
        results.push(r);
        if (r.code !== 0) return results;
      }
      const role = multisite ? ', a super admin and an administrator of every site,' : ', an administrator,';
      return [...results, { code: 0, stdout: `${login} is the only user${role} and the author of every post and link; comments keep who wrote them`, stderr: '' }];
    },
  };
}

/** Flushes caches; once the job is through, the kept database is the way back, so the job's Undo goes. */
export function flushStep(wp: WpRunner): JobStep {
  return {
    id: 'flush',
    label: 'Flush caches and rewrite rules',
    run: async (job) => {
      const r = await flush(wp)();
      if (r.every((x) => x.code === 0)) job.dropUndo?.(SWAP_UNDO);
      return r;
    },
  };
}

/** The job that makes a production dump the site's clean database. */
export function planCleanCopy(ctx: CleanContext, { domain, path, uploadId, replace, replaceBare, user }: ActionInput<'db.cleanCopy'>): JobStep[] {
  const { site, wp } = wordpressSite(ctx, domain, path);
  const upload = readUpload(ctx.uploadsDir, uploadId);
  if (!upload) throw new DbRefused('The uploaded dump is gone; upload it again');
  const prefix = site.wp.tablePrefix ?? 'wp_';
  if (upload.facts.tablePrefix && upload.facts.tablePrefix !== prefix) {
    throw new DbRefused(`The dump uses the table prefix ${upload.facts.tablePrefix} but wp-config.php uses ${prefix}; WordPress would not see the imported tables`);
  }
  const target = isLocalDbHost(site.wp.dbHost) ? limitsTarget(ctx.exec, ctx.secrets?.mysql, ctx.store) : null;
  if (!target) throw new DbRefused('A clean copy needs the MySQL admin account (Aura, Machine checks) and the site\'s database on this machine');
  const db = site.wp.dbName;
  if (!canKeep(db)) throw new DbRefused(`The database name ${db} is too long or unusual to keep its tables aside; use a plain import`);
  if (upload.facts.storedObjects !== false) {
    throw new DbRefused(
      upload.facts.storedObjects ? 'The dump makes views, triggers or routines, which cannot be swapped in from a side database; use a plain import' : 'The dump was not read to its end, so it is not known to be safe to swap in; upload it again',
    );
  }
  const multisite = upload.facts.multisite || site.wp.multisite;
  const adminEmail = `admin@${site.domain}`;
  const state = newCleanState();
  const wpInput = wpWithInput(ctx, site);

  const steps: JobStep[] = [
    {
      id: 'import',
      label: `Import ${upload.name} beside the site`,
      weight: 8,
      run: async (job) => {
        const file = await sqlFileFor(ctx.exec, upload.file, upload.dir);
        const choice = await chooseMode(target, db, file);
        if (choice.hasTables && choice.mode === 'direct') return { code: 1, stdout: '', stderr: `cannot keep ${db}'s tables aside: ${choice.why}` };
        job.activity?.(`importing into ${sideName(db)}: the site keeps its database, and nothing reaches it before the clean`);
        const made = await makeSide(target, db);
        if (made.code !== 0) return made;
        const r = await importSql(ctx.exec, site.docroot, site.host, file, { ...importOptions(ctx, job), database: sideName(db) });
        if (r.code !== 0) await dropSide(target, db);
        return r;
      },
    },
    cleanStep(target, sideName(db), prefix, adminEmail, user, state),
    {
      id: 'swap',
      label: 'Swap the clean tables in',
      weight: 0.2,
      run: async (job) => {
        const out = keepName(db);
        return swapIn(target, db, job, {
          out,
          keptFor: `for ${KEEP_DAYS} days`,
          onKept: (before) => {
            ctx.store?.addKeptDatabase({ name: out, site: site.key, db, reason: `before ${upload.name} from production`, createdAt: new Date().toISOString(), before });
          },
          afterUndo: () => ctx.store?.removeKeptDatabase(out),
        });
      },
    },
  ];

  if (replace.length > 0) {
    steps.push({
      id: 'replace',
      label: `Replace ${replace.length} production domain${replace.length > 1 ? 's' : ''}`,
      weight: 5,
      run: (job) =>
        raisedFor(ctx, site, job, () =>
          replaceDomains(wp, replace, { tables: '--all-tables-with-prefix', tableHosts: upload.facts.tableHosts, multisite, prefix, bare: replaceBare, domainMapping: Boolean(upload.facts.domainMapping), job }),
        ),
    });
  }
  const locals = site.names.filter(isLocalName);
  const http = upload.facts.httpHosts;
  if (http === undefined || [...replace.map((r) => r.from), ...locals].some((h) => http.includes(h))) {
    steps.push({
      id: 'https',
      label: 'Use https for the local domains',
      weight: 2,
      run: (job) => raisedFor(ctx, site, job, () => httpsForLocals(wp, locals, { tables: '--all-tables-with-prefix', tableHosts: upload.facts.tableHosts, replaced: replace, bare: replaceBare, job })),
    });
  }
  const left = replace.filter((r) => r.from !== r.to).map((r) => r.from);
  if (left.length > 0) {
    steps.push({ id: 'check', label: 'Check no site is left on a production address', run: () => checkAddresses(wp, { prefix, multisite, from: left }), skippable: CHECK_SKIPPED });
  }

  steps.push(pluginsOffStep(wp, multisite), userStep(wp, wpInput, { user, adminEmail, multisite, prefix, state }), flushStep(wp));
  return steps;
}

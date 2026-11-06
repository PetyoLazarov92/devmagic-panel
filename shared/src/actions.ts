import { z } from 'zod';
import { apacheModuleLock, apacheModuleName } from './apache.js';
import { mysqlAccount, mysqlBackupName, mysqlDatabaseName } from './mysql.js';
import { NETWORK_PATH } from './network.js';
import { PHP_VERSION_PATTERN, phpIniValueError } from './php.js';
import { cronSchedule } from './cron.js';
import { namespaceRef } from './repo-host.js';

/**
 * The action registry: every change the panel can make, defined once.
 * The API route, the UI form and (later) the AI tool are all derived from
 * these entries, so a new capability is one new entry plus its handler.
 */

// Mirrors dmp_is_local_name in scripts/lib/validate.sh.
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const LOCAL_NAME = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

export function isLocalName(name: string): boolean {
  if (name.length > 253 || !LOCAL_NAME.test(name)) return false;
  return (
    name.startsWith('local.') ||
    name.startsWith('www.local.') ||
    name.endsWith('.test') ||
    name.endsWith('.localhost')
  );
}

export const localName = z
  .string()
  .refine(isLocalName, 'Use a local name: local.example.com, *.test or *.localhost');

/** A public or local hostname, no scheme, port or path. */
export const hostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'A hostname like www.example.com');

/**
 * The address a dump uses, to search and replace: a hostname, a single label
 * like localhost, and an optional port (localhost:8888, staging.example.com:8080).
 */
export const dumpHost = z
  .string()
  .max(260)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/, 'An address like www.example.com or localhost:8888');

/** SSH or HTTPS git remotes only; never something git could read as an option. */
export const gitUrl = z
  .string()
  .max(500)
  .regex(
    /^(git@[\w.-]+:[\w./-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./-]+|https:\/\/[\w.-]+(:\d+)?\/[\w./-]+)$/,
    'A git URL like git@github.com:team/repo.git, git@gitlab.com:group/sub/repo.git or https://git.acme.test/team/repo.git',
  );

/** A build of the install: composer install, or a package manager's install and one of its scripts, in a folder of the repo. */
export const buildStep = z.object({
  dir: z
    .string()
    .max(300)
    .regex(/^(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]*$/, 'A folder in the repo')
    .refine((dir) => !dir.split('/').some((part) => part === '..' || part === '.'), 'A folder in the repo'),
  tool: z.enum(['composer', 'npm', 'yarn', 'pnpm']),
  script: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,59}$/, 'A script name from package.json').optional(),
});

/** A repo by its path on its host: acme/shop, or acme/web/shop in a GitLab subgroup. */
export const repoFullName = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100}){1,21}$/, 'A repo like acme/shop or acme/web/shop')
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), 'A repo like acme/shop or acme/web/shop');

export const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'] as const;
export const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** How one Claude Code run goes: the model, how hard it thinks (--effort) and the most it may spend. */
export const claudeRun = z.object({
  model: z.enum(CLAUDE_MODELS),
  effort: z.enum(CLAUDE_EFFORTS),
  budgetUsd: z.number().min(0.05).max(5),
});
export type ClaudeRun = z.infer<typeof claudeRun>;

export const branchName = z
  .string()
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/, 'A branch name like master or feature/cart');

export const wpSlug = z.string().regex(/^[a-z0-9_-]{1,100}$/, 'A plugin slug like wp-rocket');

/** Plugins that help on a local copy; the wizard turns on the ones the repo has, when you tick them. Nothing is downloaded. */
export const LOCAL_HELPER_PLUGINS = {
  'query-monitor': 'Queries, hooks, PHP errors and HTTP calls for every page',
  'wp-crontrol': 'See and run WP-Cron events',
  'user-switching': 'Switch to any user in one click',
} as const;
export type LocalHelperPlugin = keyof typeof LOCAL_HELPER_PLUGINS;
const localHelper = z.enum(Object.keys(LOCAL_HELPER_PLUGINS) as [LocalHelperPlugin, ...LocalHelperPlugin[]]);

/** BE Media from Production: loads missing uploads from production, set by a constant in wp-config.php. */
export const MEDIA_PLUGIN = 'be-media-from-production';
export const MEDIA_PLUGIN_URL = 'BE_MEDIA_FROM_PRODUCTION_URL';
/** How missing uploads load from production: a redirect (the panel's vhost, or Local mode), or BE Media from Production. */
export const uploadsVia = z.enum(['redirect', 'plugin']);

/** WordPress.org's list of every release with its status (latest, outdated, insecure): where exact version numbers come from. */
export const WP_RELEASES_URL = 'https://api.wordpress.org/core/stable-check/1.0/';

export const coreVersion = z.string().regex(/^\d+(\.\d+){1,3}$/, 'A version like 7.1.3');

/**
 * Hosts Local mode blocks by default: mail services whose HTTP APIs skip
 * SMTP, so a local copy cannot email real people through them, and
 * Mailchimp's API, where a test signup would join the real list and get its
 * opt-in mail. A host also blocks its subdomains (us21.api.mailchimp.com).
 */
export const LOCAL_MODE_DEFAULT_BLOCKED_HOSTS = [
  'api.sendgrid.com',
  'mailgun.net',
  'api.postmarkapp.com',
  'api.sparkpost.com',
  'mandrillapp.com',
  'api.brevo.com',
  'api.sendinblue.com',
  'api.mailjet.com',
  'api.resend.com',
  'api.smtp2go.com',
  'api.elasticemail.com',
  'api.mailchimp.com',
] as const;

/** A folder served under a path in the site's vhost, like `/learn`; the server finds its folder. */
/** A folder in the panel's releases: v0.6.0, or v0.6.0-dev.1a2b3c4 for one built from a checkout. */
export const releaseName = z.string().regex(/^v\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/, 'A release like v0.6.0');

export const mountPath = z.string().max(200).regex(/^(\/(?!\.\.?(\/|$))[A-Za-z0-9._-]+)+$/, 'A path like /learn');

/**
 * A repo inside a site's own folder, as found there: wp-content itself, or
 * one theme, plugin or must-use plugin folder (wp-content/themes/acme).
 * Nothing else, so an action can never reach another folder.
 */
export const repoFolder = z
  .string()
  .max(200)
  .regex(/^wp-content(?:\/(?:themes|plugins|mu-plugins)\/[A-Za-z0-9._-]{1,100})?$/, 'A folder like wp-content/themes/acme')
  .refine((f) => !f.split('/').some((s) => s === '.' || s === '..'), 'A folder like wp-content/themes/acme');

const gitTarget = { domain: localName, mount: mountPath.optional(), repo: repoFolder.optional() };

/**
 * The folder a site under a path gets, named like a domain so dmp-root takes
 * it: /learn on local.northwind.com is local.learn.northwind.com, /blog/en
 * on shop.test is blog-en.shop.test. Null when the name would not be local.
 */
export function mountFolder(domain: string, path: string): string | null {
  const label = path.slice(1).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!label) return null;
  const folder = domain.startsWith('local.') ? `local.${label}.${domain.slice('local.'.length)}` : domain.startsWith('www.local.') ? `local.${label}.${domain.slice('www.local.'.length)}` : `${label}.${domain}`;
  return isLocalName(folder) ? folder : null;
}

/**
 * A WordPress install under a path of a site's domain, like /learn on
 * local.northwind.com (an Alias in its vhost); left out for the site at the root.
 */
const sitePath = mountPath.optional();

/** A snapshot file in the site's snapshot folder: `20261024-091500-before-import.sql.gz`. */
export const snapshotName = z.string().regex(/^\d{8}-\d{6}(-[a-z0-9-]{1,40})?\.sql\.gz$/, 'A snapshot file name');
/** A kept database: a site's tables from before a swap, like shop_com__keep261028143012. */
export const keptDatabaseName = z.string().regex(/^[A-Za-z0-9_$]{1,46}__keep\d{12}$/, 'A kept database name');
/** A clean copy's file name: acme.com-local-clean-2026.10.28.sql.gz, with -2 and up for another the same day. */
export const cleanCopyName = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,200}-local-clean-\d{4}\.\d{2}\.\d{2}(-\d{1,3})?\.sql\.gz$/, 'A clean copy file name');

/** Text for search and replace: one line, and never something wp-cli could read as an option. */
const replaceText = z.string().min(3).max(500).regex(/^[^-\r\n][^\r\n]*$/, 'One line, not starting with a dash');

/** A Deleted sites entry: <domain>-<YYYYMMDD-HHMMSS>. */
export const trashId = z
  .string()
  .max(280)
  .regex(/^[a-z0-9.-]+-\d{8}-\d{6}$/, 'A deleted site id like local.shop.com-20261024-153000')
  .refine((id) => localName.safeParse(id.slice(0, -16)).success, 'A deleted site id like local.shop.com-20261024-153000');

const confirmDomain = <T extends { domain: string; confirm: string }>(v: T) => v.confirm === v.domain;

/**
 * What the new site wizard remembers about a repo between installs. Kept in
 * the panel's own database, keyed by the repo URL; never written into a repo.
 */
/**
 * How a network from a dump is set up here: a subdirectory or a subdomain
 * network, with where each site goes by its blog id.
 */
export const networkChoice = z.object({
  layout: z.enum(['subdirectory', 'subdomain']),
  sites: z
    .array(z.object({ id: z.number().int().min(1), domain: localName, path: z.string().max(200).regex(NETWORK_PATH, 'A path like /shop/') }))
    .max(500),
});

export const repoPreset = z.object({
  /** The first local name is the site's primary domain; production hosts are replaced with their local name after an import. */
  domains: z.array(z.object({ production: dumpHost.optional(), local: localName })).min(1).max(50),
  layout: z.enum(['site-root', 'wp-content', 'theme', 'plugin']),
  core: z.object({ mode: z.enum(['wpcore', 'standalone']).default('wpcore'), version: coreVersion }).optional(),
  /** Production-only plugins to deactivate after an import. */
  deactivate: z.array(wpSlug).max(50).default([]),
  /** Local helper plugins to activate when the repo has them. */
  activate: z.array(localHelper).max(10).default([]),
  /** Production host that serves uploads missing locally. */
  uploadsFrom: hostname.optional(),
  uploadsVia: uploadsVia.optional(),
  build: z.object({ composer: z.boolean().default(false), npm: z.boolean().default(false) }).default({ composer: false, npm: false }),
  /** For a network: its layout here and where each site went. */
  network: networkChoice.optional(),
});

/** Xdebug settings the panel offers; dmp-root holds the same lists. */
export const XDEBUG_MODES = ['debug', 'develop', 'profile', 'trace', 'coverage'] as const;
/** A WordPress login as the panel accepts one: letters, digits, space and _ . @ + -, up to 60. */
export const wpLogin = z.string().regex(/^[\w.@+ -]{1,60}$/, 'A WordPress login');
/**
 * The one user a clean-up keeps: an administrator already in the database
 * (keep), or a new one made with login and password. Every other user goes,
 * and their posts and links become this user's, as wp user delete --reassign
 * does; comments stay as they are.
 */
export const cleanUser = z
  .object({ keep: wpLogin.optional(), login: wpLogin.default('admin'), password: z.string().min(1).max(200).default('admin') })
  .default({ login: 'admin', password: 'admin' });
/** PHP modules WordPress cannot run without: never switched off. Same list as DMP_PHP_REQUIRED in scripts/lib/php.sh. */
export const PHP_REQUIRED_MODULES = ['mysqli', 'mysqlnd', 'pdo', 'xml'] as const;
export const phpModuleName = z
  .string()
  .regex(/^[a-z0-9_]{1,40}$/, 'A PHP module name, like soap or intl')
  .refine((m) => m !== 'xdebug', 'Xdebug has its own switch');
export const XDEBUG_STARTS = ['trigger', 'yes'] as const;
/** A PHP version as Debian names its folders: 8.3. */
export const phpVersion = z.string().regex(PHP_VERSION_PATTERN, 'A PHP version, like 8.3');
/** Settings the panel writes to its own ini file, each checked against PHP_INI_SETTINGS. */
export const phpIniValues = z
  .record(z.string(), z.string())
  .refine((v) => Object.keys(v).length <= 30, 'Too many settings')
  .superRefine((values, ctx) => {
    for (const [key, value] of Object.entries(values)) {
      const error = phpIniValueError(key, value);
      if (error) ctx.addIssue({ code: 'custom', message: error, path: [key] });
    }
  });

/**
 * The WordPress debug constants the panel sets one by one, with the value
 * WordPress uses when wp-config.php leaves one out.
 */
export const WP_DEBUG_DEFAULTS = { WP_DEBUG: false, WP_DEBUG_LOG: false, WP_DEBUG_DISPLAY: true, SCRIPT_DEBUG: false, SAVEQUERIES: false } as const;
export type WpDebugConstant = keyof typeof WP_DEBUG_DEFAULTS;
export const WP_DEBUG_CONSTANTS = Object.keys(WP_DEBUG_DEFAULTS) as WpDebugConstant[];

/** A constant name as PHP takes it, like WP_DEBUG or ACME_2FA. */
export const constantName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'A constant name like WP_ENVIRONMENT_TYPE');
/**
 * A constant's value: true or false, a whole number, or text on one line.
 * Text that starts with - would read as an option to wp config set.
 */
export const constantValue = z.union([
  z.boolean(),
  z.number().int(),
  z.string().max(500).regex(/^[^\r\n]*$/, 'Text on one line').refine((v) => !v.startsWith('-'), 'Text cannot start with -'),
]);
export type ConstantValue = z.infer<typeof constantValue>;

/** WordPress's keys and salts, which sign login cookies and nonces. */
/** WordPress's keys and salts since 2.7, which sign login cookies and nonces; a site's own wp-config-sample.php says which its WordPress asks for. */
export const WP_SALT_KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'] as const;
/**
 * The single key of WordPress 2.5 and the salt of 2.6, read only while one of
 * the keys above is missing. The panel reads which ones a site's WordPress
 * still checks from its wp_salt(); this pair is the fallback.
 */
export const LEGACY_SALT_KEYS = ['SECRET_KEY', 'SECRET_SALT'] as const;

/** Constants other actions or the install own: the database, the keys and salts, ABSPATH and a network's layout. */
export const PROTECTED_CONSTANTS = [
  'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_CHARSET', 'DB_COLLATE', 'ABSPATH',
  'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
  'MULTISITE', 'SUBDOMAIN_INSTALL', 'DOMAIN_CURRENT_SITE', 'PATH_CURRENT_SITE', 'SITE_ID_CURRENT_SITE', 'BLOG_ID_CURRENT_SITE',
] as const;

/** A name that looks like it holds a secret: its value never leaves the server, and the panel does not set it (it would go on a command line). */
export function isSecretConstant(name: string): boolean {
  return /PASSWORD|PASSWD|SECRET|TOKEN|SALT|PRIVATE|(^|_)KEY($|_)|_KEYS?$|API_?KEY/i.test(name);
}

/** Whether the panel may set or remove a constant. */
export function editableConstant(name: string): boolean {
  return !(PROTECTED_CONSTANTS as readonly string[]).includes(name.toUpperCase()) && !isSecretConstant(name);
}

/** The constants every local site should have, from Settings; new installs write them. */
export const localConstants = z
  .array(z.object({ name: constantName.refine(editableConstant, 'The panel does not set this constant'), value: constantValue }))
  .max(20)
  .refine((list) => new Set(list.map((c) => c.name)).size === list.length, 'Each constant once');
export type LocalConstant = z.infer<typeof localConstants>[number];
export const DEFAULT_LOCAL_CONSTANTS: LocalConstant[] = [{ name: 'WP_ENVIRONMENT_TYPE', value: 'local' }];

/** Plugins that usually only belong on production; offered for deactivation after an import. */
export const PRODUCTION_ONLY_PLUGINS = ['wp-rocket', 'wordfence', 'wp-mail-smtp', 'cloudflare', 'sucuri-scanner', 'litespeed-cache', 'redis-cache'] as const;

/**
 * Plugins that send mail or reach a mailing list: SMTP and mail services,
 * newsletters, marketing mail. A clean copy from production turns them off
 * before the site is first opened.
 */
export const MAIL_PLUGINS = [
  'wp-mail-smtp', 'post-smtp', 'easy-wp-smtp', 'fluent-smtp', 'mailgun', 'sendgrid-email-delivery-simplified', 'wp-ses', 'wp-offload-ses',
  'mailpoet', 'newsletter', 'mailchimp-for-wp', 'mailchimp-for-woocommerce', 'klaviyo', 'automatewoo', 'woocommerce-follow-up-emails',
] as const;

/** WooCommerce tables that only hold orders, customers, payments and their traces. */
export const CLEAN_WOO_TABLES = [
  'woocommerce_order_items', 'woocommerce_order_itemmeta', 'woocommerce_payment_tokens', 'woocommerce_payment_tokenmeta', 'woocommerce_sessions',
  'woocommerce_api_keys', 'woocommerce_downloadable_product_permissions', 'woocommerce_log', 'wc_customer_lookup', 'wc_download_log', 'wc_webhooks',
  'wc_reserved_stock', 'wc_rate_limits', 'wc_orders', 'wc_orders_meta', 'wc_order_addresses', 'wc_order_operational_data', 'wc_order_product_lookup',
  'wc_order_tax_lookup', 'wc_order_coupon_lookup', 'wc_order_stats',
] as const;

/** Form plugins' entry tables: Gravity Forms (and its old names), WPForms, Formidable, Elementor, CFDB7. */
export const CLEAN_FORM_TABLES = [
  'gf_entry', 'gf_entry_meta', 'gf_entry_notes', 'gf_draft_submissions', 'rg_lead', 'rg_lead_detail', 'rg_lead_detail_long', 'rg_lead_meta', 'rg_lead_notes',
  'rg_incomplete_submissions', 'wpforms_entries', 'wpforms_entry_meta', 'wpforms_entry_fields', 'wpforms_payments', 'wpforms_payment_meta', 'frm_items',
  'frm_item_metas', 'e_submissions', 'e_submissions_values', 'e_submissions_actions_log', 'db7_forms',
] as const;

/** Log tables: Action Scheduler, Wordfence, activity logs, Redirection, mail logs, security plugins, Uncanny Automator runs (what its own purge empties). */
export const CLEAN_LOG_TABLES = [
  'actionscheduler_actions', 'actionscheduler_claims', 'actionscheduler_logs', 'wfhits', 'wflogins', 'wfblockediplog', 'wfsecurityevents', 'wftrafficrates',
  'wflivetraffichuman', 'wsal_occurrences', 'wsal_metadata', 'stream', 'stream_meta', 'simple_history', 'simple_history_contexts', 'redirection_logs',
  'redirection_404', 'wpmailsmtp_debug_events', 'wpmailsmtp_emails_log', 'post_smtp_logs', 'post_smtp_logmeta', 'email_log', 'itsec_logs', 'itsec_temp',
  'itsec_lockouts', 'aiowps_audit_log', 'aiowps_failed_logins', 'aiowps_login_activity', 'ualp_user_activity', 'uap_recipe_log', 'uap_recipe_log_meta',
  'uap_action_log', 'uap_action_log_meta', 'uap_closure_log', 'uap_closure_log_meta', 'uap_trigger_log', 'uap_trigger_log_meta', 'uap_api_log',
  'uap_api_log_response', 'uap_tokens_log',
] as const;

// ── cron ────────────────────────────────────────────────────

/** A task of the panel's block in the user's crontab: six letters and digits, on its line. */
export const cronTaskId = z.string().regex(/^[a-z0-9]{6}$/, 'A task id like k3f9q2');
/** A task's name, on the comment line above it in the crontab. */
export const cronTitle = z.string().trim().min(1, 'Give the task a name').max(80).regex(/^[^\x00-\x1f\x7f]+$/, 'One line, no control characters');
/** A word that goes on a crontab line as it is: nothing /bin/sh reads as syntax. */
export const CRON_WORD = /^[A-Za-z0-9._/:=@,+-]{1,200}$/;

/** WP-CLI's own commands: a site's own command is anything else that the site has. */
export const WP_CLI_BUILTIN = [
  'cache', 'cap', 'cli', 'comment', 'config', 'core', 'cron', 'db', 'dist-archive', 'embed', 'eval', 'eval-file', 'export', 'find', 'help', 'i18n', 'import',
  'language', 'maintenance-mode', 'media', 'menu', 'network', 'option', 'package', 'plugin', 'post', 'post-type', 'profile', 'rewrite', 'role', 'scaffold',
  'search-replace', 'server', 'shell', 'sidebar', 'site', 'super-admin', 'taxonomy', 'term', 'theme', 'transient', 'user', 'widget',
] as const;
/** The WP-CLI commands a task may run, besides a site's own. */
export const WP_CLI_SCHEDULED = [['action-scheduler', 'run'], ['cron', 'event', 'run'], ['transient', 'delete'], ['cache', 'flush']] as const;
/** WP-CLI's global options that load or run code, or point it at another site. */
const WP_CLI_REFUSED_OPTIONS = ['--exec', '--require', '--path', '--url', '--ssh', '--http', '--context'];

/** Why a task may not run this WP-CLI command, or null. Whether a site has its own command is checked on the site. */
export function wpCliCommandProblem(words: readonly string[]): string | null {
  const first = words[0] ?? '';
  const option = words.find((w) => WP_CLI_REFUSED_OPTIONS.some((o) => w === o || w.startsWith(`${o}=`)));
  if (option) return `${option.split('=')[0]} is not allowed in a task`;
  if (first.startsWith('-')) return 'Start with the command, like action-scheduler run';
  if (WP_CLI_SCHEDULED.some((allowed) => allowed.every((w, i) => words[i] === w))) {
    if (first === 'cron' && !words[3]) return 'cron event run needs the hook to run';
    return null;
  }
  if ((WP_CLI_BUILTIN as readonly string[]).includes(first)) {
    return `wp ${words.slice(0, 2).join(' ')} is not one a task may run: ${WP_CLI_SCHEDULED.map((c) => c.join(' ')).join(', ')}, or a command of the site's own`;
  }
  return null;
}

/** Whether the WP-CLI command is a site's own (a plugin's or the theme's), which the site must have. */
export const isSiteWpCommand = (words: readonly string[]) => !(WP_CLI_BUILTIN as readonly string[]).includes(words[0] ?? '') && words[0] !== 'action-scheduler';

/** A file in the site's folder, relative to it. */
const siteFile = z
  .string()
  .max(300)
  .regex(/^(?!\/)[A-Za-z0-9._/-]+\.php$/, 'A PHP file in the site, like wp-content/cron/sync.php')
  .refine((f) => !f.split('/').some((part) => part === '..' || part === '.' || part === ''), 'A PHP file in the site, like wp-content/cron/sync.php');

const cronSite = { domain: localName, path: sitePath };

/**
 * What a task of the panel runs. The runner runs it with an argument list,
 * never through a shell, and checks it again with this schema each time.
 */
export const cronTask = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wp-cron'), ...cronSite }),
  z
    .object({ kind: z.literal('wp-cli'), ...cronSite, command: z.array(z.string().regex(CRON_WORD, 'Letters, digits and . _ / : = @ , + - only')).min(1).max(20) })
    .superRefine((v, ctx) => {
      const problem = wpCliCommandProblem(v.command);
      if (problem) ctx.addIssue({ code: 'custom', path: ['command'], message: problem });
    }),
  z.object({ kind: z.literal('php-script'), ...cronSite, file: siteFile }),
  z.object({
    kind: z.literal('url'),
    url: z
      .string()
      .max(500)
      .refine((u) => {
        try {
          const url = new URL(u);
          return (url.protocol === 'https:' || url.protocol === 'http:') && isLocalName(url.hostname) && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'An address on a local name, like https://local.acme.com/wp-cron.php'),
  }),
  z.object({
    kind: z.literal('program'),
    program: z
      .string()
      .max(300)
      .regex(/^\/[A-Za-z0-9._/+-]+$/, 'The full path of a program, like /home/alex/bin/sync.sh')
      .refine((p) => !p.split('/').slice(1).some((part) => part === '..' || part === '.' || part === ''), 'The full path of a program, like /home/alex/bin/sync.sh'),
    args: z.array(z.string().max(500).regex(/^[^\0\r\n]*$/, 'One line each')).max(20).default([]),
  }),
]);
export type CronTask = z.output<typeof cronTask>;
export type CronTaskKind = CronTask['kind'];

/** A saved copy of the crontab, or of a site's WP-Cron events, taken before a change. */
export const cronBackupName = z.string().regex(/^(crontab|wp-cron-[a-z0-9.-]{1,253})-\d{8}-\d{6}-\d{3}\.(txt|json)$/, 'A saved copy');
/** A network site's address, for --url. */
const wpSiteUrl = z.string().url().max(500).optional();
/** A hook of a WP-Cron event. */
export const wpCronHook = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:/\\-]{0,189}$/, 'A hook like acme_sync_orders');

const cronFields = {
  title: cronTitle,
  schedule: cronSchedule,
  task: cronTask,
  enabled: z.boolean().default(true),
  /** The run is stopped after this long. */
  timeoutMinutes: z.number().int().min(1).max(60).default(10),
};

export const APACHE_MODULES = ['ssl', 'rewrite', 'headers', 'proxy', 'proxy_http', 'proxy_wstunnel'] as const;

export const actions = {
  'apache.enableModule': {
    title: 'Enable Apache module',
    description: 'Enables an Apache module the panel needs, then reloads Apache.',
    changesSystem: true,
    input: z.object({ module: z.enum(APACHE_MODULES) }),
  },
  'apache.setModule': {
    title: 'Turn an Apache module on or off',
    description:
      "Turns a module in mods-available on or off with a2enmod or a2dismod, runs a configtest (the change is taken back when it fails) and restarts Apache. Never php* or mpm_*, and never off for the panel's own modules (ssl, rewrite, headers, proxy, proxy_http, proxy_wstunnel) or the ones every vhost needs.",
    changesSystem: true,
    input: z
      .object({ module: apacheModuleName, enabled: z.boolean() })
      .superRefine((v, ctx) => {
        const lock = apacheModuleLock(v.module, v.enabled);
        if (lock) ctx.addIssue({ code: 'custom', path: ['module'], message: `${v.module} stays as it is: ${lock.toLowerCase()}` });
      }),
  },
  'apache.reload': {
    title: 'Reload Apache',
    description: 'Runs a configtest and reloads Apache when it passes.',
    changesSystem: true,
    input: z.object({}),
  },
  'service.restart': {
    title: 'Restart a service',
    description: 'Restarts Apache or nginx (each only after its configtest passes) or MySQL/MariaDB.',
    changesSystem: true,
    input: z.object({ service: z.enum(['apache', 'mysql', 'nginx']) }),
  },
  'nginx.setup': {
    title: 'Set nginx up next to Apache',
    description:
      "Runs nginx next to Apache, both on ports 80 and 443: Apache moves from every address to its own (127.0.0.1) and nginx answers on another (127.0.0.2), so a site later goes to the server its hosts line points at. Turns Debian's default nginx site off, writes the panel's nginx settings, restarts Apache and starts nginx, then checks every site still answers. Run again, it writes the settings anew. Needs nginx installed (sudo apt install nginx). Sites, the panel and phpMyAdmin stay on Apache. Starts a job; Undo turns nginx off again.",
    changesSystem: true,
    input: z.object({}),
  },
  'nginx.teardown': {
    title: 'Turn nginx off',
    description:
      "Puts Apache back on every address and Debian's default nginx site back on, stops nginx and keeps it from starting at boot, then checks every site still answers. Refused while a site runs on nginx. nginx stays installed. Starts a job; Undo sets nginx up again.",
    changesSystem: true,
    input: z.object({}),
  },
  'site.setServer': {
    title: 'Move a site between Apache and nginx',
    description:
      "Moves a site to nginx or back to Apache. Both servers answer on ports 80 and 443, each on its own address, and a site goes to the one its hosts line points at. To nginx: writes the site's nginx file (WordPress's rules for a single site or its kind of network, the uploads redirect, PHP through its own PHP-FPM pool or the default version's), points the hosts line at nginx, checks the site answers, then removes the Apache vhost. Back to Apache: the other way round. Its folder, database and certificate stay. Only for a site the panel made the vhost of, in the usual folder, without sites under paths, once nginx is set up; nginx reads no .htaccess, so a site whose .htaccess has rules beyond WordPress's needs acceptIgnored. On nginx already, writes its nginx file again (after it became a network). Starts a job; Undo moves it back.",
    changesSystem: true,
    input: z.object({ domain: localName, server: z.enum(['apache', 'nginx']), acceptIgnored: z.boolean().default(false) }),
  },
  'sites.setServerAll': {
    title: 'Move every site to Apache or nginx',
    description:
      "Moves every site that can to one web server, one after the other, each as site.setServer moves it, and checks each answers. Sites that cannot stay where they are and are listed: vhosts made by hand, sites without PHP-FPM for their PHP version, and, unless acceptIgnored, sites whose .htaccess has rules nginx does not read. Starts a job; Undo moves every site back.",
    changesSystem: true,
    input: z.object({ server: z.enum(['apache', 'nginx']), acceptIgnored: z.boolean().default(false) }),
  },
  'nginx.reload': {
    title: 'Reload nginx',
    description: 'Runs nginx -t and reloads nginx when it passes.',
    changesSystem: true,
    input: z.object({}),
  },
  'mysql.analyze': {
    title: 'Analyze database tables',
    description:
      "Runs ANALYZE TABLE on every table of one database, or of every database but MySQL's own when none is named, so the sizes and row counts the panel shows are current. Changes no data.",
    changesSystem: false,
    input: z.object({ database: mysqlDatabaseName.optional() }),
  },
  'mysql.optimize': {
    title: 'Optimize a database',
    description:
      'Runs OPTIMIZE TABLE on every table of one database, which rebuilds them and gives the space rows deleted since back to the disk, as after cleared logs. Takes a while on a big database, and the tables are busy meanwhile. Not for MySQL\'s own databases. Starts a job.',
    changesSystem: true,
    input: z.object({ database: mysqlDatabaseName }),
  },
  'mysql.dropDatabase': {
    title: 'Delete a database',
    description:
      "Deletes a database no site on this machine uses, after exporting it to the panel's MySQL backups, kept 14 days, so Undo puts it back. Refused for MySQL's own databases, a site's database (remove the site instead) and the ones the panel keeps for a site. Starts a job.",
    changesSystem: true,
    input: z.object({ database: mysqlDatabaseName }),
  },
  'mysql.dropUsers': {
    title: 'Delete MySQL users',
    description:
      "Deletes MySQL accounts no site uses, like a site's user left behind after its database went. Each account and its rights are saved to the panel's MySQL backups first, so Undo makes them again. Refused for MySQL's own accounts, the panel's account and an account a site's wp-config.php uses. Starts a job.",
    changesSystem: true,
    input: z.object({ accounts: z.array(mysqlAccount).min(1).max(50) }),
  },
  'mysql.deleteBackup': {
    title: 'Delete a saved MySQL copy',
    description:
      "Deletes one file of the panel's MySQL backups now instead of after its 14 days: the export of a deleted database, or the saved accounts of deleted users. Undo on the job that deleted them cannot put them back afterwards.",
    changesSystem: true,
    input: z.object({ name: mysqlBackupName }),
  },
  'mysql.makeReadOnlyAccount': {
    title: 'Make the read-only MySQL account',
    description:
      "Makes devmagic_panel_ro@localhost with the admin account, with SELECT and SHOW VIEW on every database and nothing else, and a new password saved in the panel's secrets file. The SQL runner reads with it, so MySQL itself refuses any change a query would make. Run again, it gets a new password and loses any other right it was given.",
    changesSystem: true,
    input: z.object({}),
  },
  'mysql.resetSiteUser': {
    title: "Reset a site's database user",
    description:
      "Gives the database user in a site's wp-config.php a new password, written to wp-config.php first, and makes the user and its access to the site's database when they are missing. Only for a user that site alone uses: never root, the panel's account or a user other sites share.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'php.setXdebug': {
    title: 'Turn Xdebug on or off',
    description:
      'Turns Xdebug on or off for the web parts of a PHP version (Apache\'s mod_php and PHP-FPM; never the command line), then restarts Apache when it runs that version and reloads that version\'s FPM. Without a version, the one Apache runs. On, it connects to 127.0.0.1:9003 with the chosen modes (any mix, like debug and develop); trigger means only when the browser extension or XDEBUG_TRIGGER asks.',
    changesSystem: true,
    input: z.object({
      version: phpVersion.optional(),
      enabled: z.boolean(),
      modes: z.array(z.enum(XDEBUG_MODES)).min(1).max(XDEBUG_MODES.length).refine((m) => new Set(m).size === m.length, 'Each mode once').default(['debug']),
      startWithRequest: z.enum(XDEBUG_STARTS).default('trigger'),
    }),
  },
  'php.setModule': {
    title: 'Turn a PHP module on or off',
    description:
      'Turns a PHP module installed for a PHP version on or off for every part of that version (Apache\'s mod_php, PHP-FPM, the command line), then restarts Apache when it runs that version and reloads its FPM. Without a version, the one Apache runs. Only modules in mods-available, never Xdebug (it has its own action), and never off for the ones WordPress needs: mysqli, mysqlnd, pdo and xml.',
    changesSystem: true,
    input: z
      .object({ version: phpVersion.optional(), module: phpModuleName, enabled: z.boolean() })
      .refine((v) => v.enabled || !(PHP_REQUIRED_MODULES as readonly string[]).includes(v.module), 'WordPress cannot run without this module, so it stays on'),
  },
  'php.setIni': {
    title: 'Set PHP settings for a version',
    description:
      'Writes the panel\'s own ini file (99-devmagic-panel.ini) for a PHP version with exactly these settings: for its web parts (Apache\'s mod_php and PHP-FPM, so every site on that version) or for its command line (WP-CLI, Composer). Only the settings the panel manages, like memory_limit, upload_max_filesize, max_execution_time or display_errors; a setting left out goes back to php.ini\'s value. php.ini itself is never changed. The web side restarts Apache or reloads FPM.',
    changesSystem: true,
    input: z.object({ version: phpVersion, scope: z.enum(['web', 'cli']), values: phpIniValues }),
  },
  'php.switchToFpm': {
    title: 'Run every site on PHP-FPM',
    description:
      "Turns Apache's mod_php off, puts Apache on mpm_event, and runs every site without a PHP of its own on one PHP version through PHP-FPM; phpMyAdmin gets a pool of its own with the folder limits its config gave mod_php. Refused while Apache config or a site's .htaccess sets php_value, or while FPM of mod_php's own version differs from it. A job that checks every site answers; Undo turns mod_php back on.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.switchToModPhp': {
    title: 'Run sites on mod_php again',
    description: "Turns Apache's mod_php of a version back on (with mpm_prefork) for every site without a PHP of its own; sites with their own pool keep it. A job that checks every site answers; Undo runs them on PHP-FPM again.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.install': {
    title: 'Install a PHP version',
    description:
      "Installs a PHP version from the sources apt already has (the ondrej PPA, added by a person, gives the versions Ubuntu lacks): PHP-FPM, the command line and the common modules (mysql, xml, mbstring, curl, zip, gd, intl, bcmath, imagick when there). Sites keep their PHP until one is given this version. A job; Undo removes it again.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.package': {
    title: 'Install or remove a PHP module package',
    description:
      'Installs or removes one php<version>-<name> package, like php8.3-redis, from the sources apt has, then Apache or FPM of that version picks it up. Never removes the packages a version cannot do without (common, cli, fpm, mysql, xml). A job; Undo does the opposite.',
    changesSystem: true,
    input: z.object({ version: phpVersion, name: z.string().regex(/^[a-z0-9][a-z0-9.+-]{1,30}$/, 'A package name, like redis'), how: z.enum(['install', 'remove']) }),
  },
  'php.upgrade': {
    title: 'Update a PHP version',
    description: 'Updates every installed package of a PHP version to the newest build apt has, then restarts Apache when it runs that version and reloads its FPM. A job without Undo: apt keeps no older build.',
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.remove': {
    title: 'Remove a PHP version',
    description:
      "Removes every package of a PHP version; its settings stay in /etc/php/<version> for a reinstall. Refused while Apache runs it as mod_php, while it is the command line's php, or while a site's pool runs on it. A job; Undo installs it again.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.setCli': {
    title: 'Pick the PHP of the command line',
    description:
      "Points php on the command line (and phar) at an installed PHP version through update-alternatives. WP-CLI, Composer and the panel's own WP-CLI for sites without a PHP of their own run on it, so it should be the version those sites run on the web. apt points it at the newest version it installs; installing a version from the panel keeps it where it was.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'php.checkCompat': {
    title: "Check a site's code against a PHP version",
    description:
      "Scans the PHP code of a site's themes and plugins (the active ones, or with scope all the inactive ones too), its must-use plugins, drop-ins and its vendor folder for what a PHP version removed or deprecated, with PHPCompatibilityWP on that version's own command line. WordPress core and the panel's files are left out. The result is a hint: the scanner is an alpha and cannot see code that runs only at run time. Changes nothing in the site; on first use it fetches the scanner (pinned in the panel's composer.lock) with Composer into the panel's data folder. A job; the result is kept per site and version and shown on the site's PHP tab.",
    changesSystem: false,
    input: z.object({ domain: localName, path: sitePath, version: phpVersion, scope: z.enum(['active', 'all']).default('active') }),
  },
  'php.checkCompatAll': {
    title: "Check every site's code against a PHP version",
    description:
      "php.checkCompat for every WordPress site of this machine in turn, as one job: their themes and plugins scanned for what that PHP version removed or deprecated, the result kept per site and shown on the version's page and each site's PHP tab. A site WP-CLI cannot read is passed over and named at the end. Changes nothing in the sites. A hint for moving sites to a version, not a verdict.",
    changesSystem: false,
    input: z.object({ version: phpVersion, scope: z.enum(['active', 'all']).default('active') }),
  },
  'php.deleteCompat': {
    title: 'Delete compatibility scans',
    description:
      "Deletes the panel's kept compatibility scans and the scanner's cache for them: one site's for one version, all of one site's (domain and path, version left out), or one version's on every site (domain left out). Changes nothing in the sites; a new check makes them again.",
    changesSystem: true,
    input: z.object({ domain: localName.optional(), path: sitePath, version: phpVersion.optional() }),
  },
  'php.adoptIni': {
    title: "Move php.ini changes into the panel's settings",
    description:
      "For a PHP version, copies every setting its php.ini files change from the packaged ones into the panel's settings for that version (web and command line), then puts the packaged php.ini back, so updates never ask about a changed php.ini and FPM gets the same values. The panel's own values win where both set one. Refused when a change is a setting the panel does not manage. A job: Undo puts the old php.ini files and settings back.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'ca.trustSystem': {
    title: 'Trust the CA system-wide',
    description: 'Adds the local CA to the system certificate store.',
    changesSystem: true,
    input: z.object({}),
  },
  'ca.trustBrowsers': {
    title: 'Trust the CA in browsers',
    description: 'Adds the local CA to Chrome and every Firefox profile of your user.',
    changesSystem: true,
    input: z.object({}),
  },
  'ca.untrustLegacy': {
    title: 'Remove the old LocalhostCA',
    description: 'Removes the old devmagic LocalhostCA from the system store. Do this once every site loads with its new cert.',
    changesSystem: true,
    input: z.object({}),
  },
  'hosts.add': {
    title: 'Add hosts entry',
    description: 'Points the domain and its aliases to 127.0.0.1 in /etc/hosts.',
    changesSystem: true,
    input: z.object({ domain: localName, aliases: z.array(localName).max(100).default([]) }),
  },
  'hosts.remove': {
    title: 'Remove hosts entry',
    description: 'Removes a domain\'s line from the panel\'s block in /etc/hosts. Lines outside the block are never changed.',
    changesSystem: true,
    input: z.object({ domain: localName }),
  },
  'cert.reissue': {
    title: 'Reissue certificate',
    description: 'Issues a new certificate from the local CA covering every name in the site\'s vhost, then reloads Apache.',
    changesSystem: true,
    input: z.object({ domain: localName }),
  },
  'site.setLocalMode': {
    title: 'Set Local mode',
    description:
      'Turns Local mode on or off for a WordPress site. On, a mu-plugin (kept out of git) sends all mail to Mailpit, tells search engines not to index, shows a Local label in the admin bar, accepts logins from this computer only and blocks requests to the chosen hosts.',
    changesSystem: true,
    input: z.object({
      domain: localName, path: sitePath,
      enabled: z.boolean(),
      /** Defaults to the hosts already set, or the default mail APIs. */
      blockedHosts: z.array(hostname).max(100).optional(),
    }),
  },
  'git.fetch': {
    title: 'Fetch from origin',
    description: 'Fetches branches and commits from origin (pruning deleted branches) for the site, one of its mounted folders, or a repo in it (repo: wp-content, or a theme or plugin folder). Changes no files.',
    changesSystem: false,
    input: z.object(gitTarget),
  },
  'git.pull': {
    title: 'Pull',
    description: 'Pulls the current branch from its upstream, fast-forward only: never creates a merge commit and never overwrites local changes.',
    changesSystem: true,
    input: z.object(gitTarget),
  },
  'git.switch': {
    title: 'Switch branch',
    description: 'Switches the site (or a mounted folder, or a repo in it such as a theme or plugin folder) to another branch; a branch that exists only on origin is checked out tracking it. Refused while there are uncommitted changes.',
    changesSystem: true,
    input: z.object({ ...gitTarget, branch: branchName }),
  },
  'db.snapshot': {
    title: 'Take a database snapshot',
    description: 'Exports the site\'s database to a gzipped snapshot in the backup folder. Starts a job.',
    changesSystem: false,
    input: z.object({ domain: localName, path: sitePath, label: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Lowercase letters, digits and dashes').optional() }),
  },
  'db.restore': {
    title: 'Restore a database snapshot',
    description: 'Takes a snapshot of the current database, then imports the chosen snapshot over it. Starts a job.',
    changesSystem: true,
    input: z
      .object({ domain: localName, path: sitePath, snapshot: snapshotName, confirm: z.string() })
      .refine(confirmDomain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'db.deleteSnapshot': {
    title: 'Delete a database snapshot',
    description: 'Deletes one snapshot file from the site\'s snapshot folder.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, snapshot: snapshotName }),
  },
  'db.import': {
    title: 'Import a database dump',
    description:
      'Imports an uploaded dump into a side database and swaps its tables in at once (Undo puts the tables from before back until the job ends), or takes a snapshot and imports straight in when that cannot be done; then replaces production domains (URLs only, or every mention with replaceBare), makes http:// for the local names https:// and flushes caches. The dump must use the table prefix in wp-config.php. Starts a job.',
    changesSystem: true,
    input: z
      .object({
        domain: localName, path: sitePath,
        uploadId: z.string().regex(/^[0-9a-f-]{36}$/),
        replace: z.array(z.object({ from: dumpHost, to: localName })).max(50).default([]),
        /** Replace every mention of the production hosts, emails included, not only URLs. */
        replaceBare: z.boolean().default(false),
        confirm: z.string(),
      })
      .refine(confirmDomain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'db.cleanCopy': {
    title: 'Prepare the database from production',
    description:
      "Makes a production dump this site's database without private data: imports it into a side database, removes every user but the one kept, WooCommerce orders and customer data, product reviews, form entries, logs and payment, mail and API keys there with SQL (no WordPress code runs), then swaps it in. The site's tables from before are kept for 7 days. Then replaces production domains, turns off mail and production-only plugins, and keeps one user: an administrator of the dump (user.keep) or a new one (user.login, admin / admin by default), who becomes the author of every post as wp user delete --reassign does; comments stay as they are. Needs the MySQL admin account. Starts a job.",
    changesSystem: true,
    input: z
      .object({
        domain: localName, path: sitePath,
        uploadId: z.string().regex(/^[0-9a-f-]{36}$/),
        replace: z.array(z.object({ from: dumpHost, to: localName })).max(50).default([]),
        user: cleanUser,
        confirm: z.string(),
      })
      .refine(confirmDomain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'db.cleanCurrent': {
    title: "Clean the site's database",
    description:
      "Cleans the database a site has now, like a production database imported earlier, the way Prepare from production cleans a dump: copies it into a side database on the MySQL server, removes every user but the one kept, WooCommerce orders and customer data, product reviews, form entries, logs and payment, mail and API keys there with SQL, then swaps it in; the tables from before are kept for 7 days. Then turns off mail and production-only plugins and keeps one user, an administrator there (user.keep) or a new one (user.login, admin / admin by default), the author of every post as wp user delete --reassign leaves it; comments stay as they are. Replaces no address. Needs the MySQL admin account, and refuses a database with views, triggers or generated columns. Starts a job.",
    changesSystem: true,
    input: z
      .object({ domain: localName, path: sitePath, user: cleanUser, confirm: z.string() })
      .refine(confirmDomain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'db.exportClean': {
    title: 'Export a clean copy of the database',
    description:
      "Exports the site's database as a gzipped dump to share with the team, streamed with no file written on the way, into the site's clean copies folder, and counts the email addresses left in it per table (local and example addresses aside), so anything private a cleanup missed shows. Starts a job.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'db.deleteCleanCopy': {
    title: 'Delete a clean copy',
    description: "Deletes one clean copy from the site's clean copies folder.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, name: cleanCopyName }),
  },
  'db.restoreKept': {
    title: 'Put back a kept database',
    description:
      "Puts back the site's tables a swap kept aside, in one RENAME TABLE, and takes out the tables the swap brought in; the tables it takes out are kept the same way for 7 days, so this can be undone too. Needs the MySQL admin account. Starts a job.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, name: keptDatabaseName, confirm: z.string() }).refine(confirmDomain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'db.deleteKept': {
    title: 'Delete a kept database',
    description: "Drops one of the site's kept databases now instead of after its 7 days. Only a database the panel kept for this site.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, name: keptDatabaseName }),
  },
  'db.searchReplace': {
    title: 'Search and replace in the database',
    description:
      'Replaces text in every table of the site with wp search-replace, serialized data included (guid columns are skipped). A preview (dryRun) only counts; a real run takes a snapshot first. Starts a job.',
    changesSystem: true,
    input: z
      .object({ domain: localName, path: sitePath, from: replaceText, to: replaceText, dryRun: z.boolean() })
      .refine((v) => v.from !== v.to, { path: ['to'], message: 'Replace with something different' }),
  },
  'site.writeHtaccess': {
    title: 'Write .htaccess',
    description: 'Writes WordPress\'s rewrite rules (single site or network) when the site has no .htaccess; an existing file is never changed. Kept out of git locally.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.setUploadsFrom': {
    title: 'Load missing uploads from production',
    description:
      'Loads uploads that are missing locally from a production host, or stops (host null). via redirect: for a site the panel made the Apache vhost redirects them; for a vhost made by hand the Local mode plugin does, so Local mode must be on. via plugin: BE Media from Production, which the site must have, gets BE_MEDIA_FROM_PRODUCTION_URL in wp-config.php and is turned on (off when host is null). Picking one turns the other off, so only one loads them.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, host: hostname.nullable(), via: uploadsVia.default('redirect') }),
  },
  'site.addAliases': {
    title: 'Add domains to a site',
    description:
      "Adds domains to a site whose vhost the panel made, like the sites of a subdomain network that do not open here yet: they go in its vhost with the names and folders it has, its certificate is issued again for all of them, and its /etc/hosts line lists them. A vhost made by hand is left as it is. Changes Apache config, the certificate and /etc/hosts.",
    changesSystem: true,
    input: z.object({ domain: localName, aliases: z.array(localName).min(1).max(100) }),
  },
  'site.fixWritable': {
    title: 'Make wp-content writable by WordPress',
    description: "Gives the web server group write access to wp-content and its plugins, themes and uploads folders (chmod -R g+w as the panel user), so installs and updates from wp-admin work. Only for folders the panel user owns that are already in the web server's group.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'mailpit.install': {
    title: 'Install Mailpit',
    description: `Installs Mailpit, the local mail catcher Local mode sends mail to, as the panel user: downloads the pinned release from GitHub, checks its checksum, and runs it as a systemd user service on 127.0.0.1 (SMTP 1025, web 8025). Starts it when it is already installed. Starts a job.`,
    changesSystem: true,
    input: z.object({}),
  },
  'panel.autostart': {
    title: 'Start the panel after login',
    description:
      'Writes ~/.config/autostart/devmagic-panel.desktop, so your desktop starts the panel and Mailpit when you log in. For a home folder encrypted with eCryptfs, which systemd cannot read at boot, so neither starts on its own. Changes no system file.',
    changesSystem: true,
    input: z.object({}),
  },
  'org.readRepo': {
    title: 'Read a repo with Claude Code',
    description:
      "Claude Code reads a repo's README, docs and build files, copied into a folder of their own, and fills a fixed form for the install: addresses, network, versions, build and the Asana and Google links. Read-only, within the given model, effort and spending cap. Starts a job; the answer is kept on the install draft.",
    changesSystem: false,
    input: z.object({ draftId: z.string().uuid(), url: gitUrl, branch: branchName, fullName: repoFullName, settings: claudeRun }),
  },
  'org.checkAccess': {
    title: 'Check the linked tasks and files with Claude Code',
    description:
      'Claude Code opens the Asana tasks and Google files a repo links, read-only, marks each ok, no access or not found, collects facts for the install and lists the database dumps in Google Drive. Starts a job; the answer is kept on the install draft.',
    changesSystem: false,
    input: z.object({
      draftId: z.string().uuid(),
      fullName: repoFullName,
      links: z.array(z.string().max(500)).max(40),
      dumpHints: z.array(z.string().max(500)).max(10).default([]),
      settings: claudeRun,
    }),
  },
  'dump.download': {
    title: 'Download a database dump',
    description:
      "Downloads a database dump from Google Drive with rclone (its own sign-in) into the panel's uploads, checks free space first, and reads it as for an upload: tables, prefix, addresses, multisite. A download that stops leaves nothing behind. Starts a job; the upload id is in its data.",
    changesSystem: true,
    input: z.object({
      fileId: z.string().regex(/^[A-Za-z0-9_-]{10,120}$/, 'Not a Google Drive file id'),
      name: z.string().regex(/^[^/\\\0]{1,200}\.(?:sql|sql\.gz|zip)$/i, 'A .sql, .sql.gz or .zip file name'),
      sizeBytes: z.number().int().nonnegative().optional(),
      /** The install draft the dump is for: it keeps the dump until it goes. */
      draftId: z.string().uuid().optional(),
    }),
  },
  'dump.useDownloaded': {
    title: 'Use a downloaded dump',
    description:
      "Takes a dump you downloaded in the browser from your Downloads folder into the panel's uploads (a link when it can, else a copy; your file stays) and reads it as for an upload. Starts a job; the upload id is in its data.",
    changesSystem: true,
    input: z.object({
      file: z.string().regex(/^\/[^\0]{1,1000}\.(?:sql|sql\.gz|zip)$/i, 'A .sql, .sql.gz or .zip file in your Downloads folder'),
      draftId: z.string().uuid().optional(),
    }),
  },
  'panel.update': {
    title: 'Update the panel',
    description:
      "Installs the newest release of the panel, read through the first way that can reach its repository (public HTTPS, the GitHub CLI or git): downloads the package, checks its checksum, unpacks it next to the installed releases, points current at it and restarts the panel. When the release changes the root scripts it only downloads and unpacks it, and its install.sh finishes the update in a terminal. Starts a job.",
    changesSystem: true,
    input: z.object({ version: z.string().regex(/^v\d{1,4}\.\d{1,4}\.\d{1,6}$/, 'A release like v0.6.0') }),
  },
  'panel.switchRelease': {
    title: 'Switch the panel to an installed release',
    description:
      "Points current at another release in the panel's releases folder, like the one before an update, and restarts the panel. Only for a release whose root scripts are the installed ones; for any other, its install.sh does it in a terminal. Starts a job.",
    changesSystem: true,
    input: z.object({ release: releaseName }),
  },
  'panel.installRelease': {
    title: 'Install a release with your sudo password',
    description:
      "Runs an installed release's install.sh --from-panel in the background, for a release that changes the root scripts (or to switch to one that has other root scripts). The sudo password goes to install.sh's stdin only, is never saved, and run history shows it as (hidden). install.sh keeps the root scripts, config.env and sudoers rule, swaps the new root scripts in whole, restarts the panel and checks it answers with the new version; a failure puts everything back. Starts a job; the panel restarts on success.",
    changesSystem: true,
    input: z.object({ release: releaseName, password: z.string().max(1024) }),
  },
  'site.skippedDone': {
    title: 'Mark a skipped step done',
    description:
      "Takes a step skipped when the site was installed (Skip and continue) off the site's page, once you did it yourself, like running the build. Only that step goes; how the site was installed stays, and the job and Run history keep the step as skipped. Nothing on the machine changes.",
    changesSystem: false,
    input: z.object({ domain: localName, path: sitePath, label: z.string().min(1).max(200) }),
  },
  'history.clear': {
    title: 'Clear run history',
    description:
      "Deletes every finished run from the panel's Run history; runs still going stay. Nothing on the machine changes. History also clears itself: runs older than 90 days, and any beyond the newest 2000, go by themselves. Needs confirm set to clear.",
    changesSystem: false,
    input: z.object({ confirm: z.literal('clear', 'Type clear to confirm') }),
  },
  'mail.clear': {
    title: 'Delete caught mail',
    description: 'Deletes the mail Mailpit caught from one site, or all of it when no domain is given.',
    changesSystem: true,
    input: z.object({ domain: localName.optional() }),
  },
  'cron.add': {
    title: 'Add a cron task',
    description:
      "Adds a task to the panel's block in your crontab, which cron runs as you: a site's WP-Cron, a WP-CLI command (action-scheduler run, cron event run <hook>, transient delete, cache flush, or the site's own command), a PHP file in the site, a local URL, or a program with arguments. The panel's runner runs it without a shell and keeps its output. Lines you wrote yourself are never changed. Undo puts the block back as it was.",
    changesSystem: true,
    input: z.object(cronFields),
  },
  'cron.update': {
    title: 'Change a cron task',
    description: "Changes a task of the panel's block in your crontab: its name, schedule, what it runs, whether it is on and how long it may take. Its run history stays.",
    changesSystem: true,
    input: z.object({ id: cronTaskId, ...cronFields }),
  },
  'cron.setEnabled': {
    title: 'Turn a cron task on or off',
    description: 'Turns a task of the panel on or off. An off task stays in the crontab, commented out, with its name and history.',
    changesSystem: true,
    input: z.object({ id: cronTaskId, enabled: z.boolean() }),
  },
  'cron.remove': {
    title: 'Remove a cron task',
    description: "Removes a task from the panel's block in your crontab. The crontab is saved first, so Undo puts the task back.",
    changesSystem: true,
    input: z.object({ id: cronTaskId }),
  },
  'cron.runNow': {
    title: 'Run a cron task now',
    description: "Runs a task of the panel now, the way cron runs it, as a job with its output; recorded in the task's history.",
    changesSystem: true,
    input: z.object({ id: cronTaskId }),
  },
  'cron.undo': {
    title: 'Undo a crontab change',
    description: "Puts the panel's block of your crontab back from the copy saved before a change. Lines outside the block, yours, stay as they are now.",
    changesSystem: true,
    input: z.object({ backup: cronBackupName }),
  },
  'cron.clearRuns': {
    title: "Clear a cron task's history",
    description: 'Deletes the run history and output the panel kept for one task.',
    changesSystem: true,
    input: z.object({ id: cronTaskId }),
  },
  'cron.setSiteWpCron': {
    title: 'Run WP-Cron from cron',
    description:
      "On: adds a task that runs the site's due WP-Cron events from cron (every 5 minutes unless a schedule is given) and sets DISABLE_WP_CRON to true, so page loads stop running it. Off: removes that task and DISABLE_WP_CRON from wp-config.php, so page loads run it again. Undo takes back both.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, fromCron: z.boolean(), schedule: cronSchedule.default('*/5 * * * *') }),
  },
  'wpcron.run': {
    title: 'Run a WP-Cron event now',
    description: "Runs a site's WP-Cron events of one hook now with wp cron event run, as WordPress would run them when due.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, url: wpSiteUrl, hook: wpCronHook }),
  },
  'wpcron.delete': {
    title: 'Delete a WP-Cron event',
    description:
      "Deletes exactly one scheduled WP-Cron event of a site (its hook, time and arguments), after saving the site's events, so Undo puts it back. A plugin that schedules the event may schedule it again.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, url: wpSiteUrl, hook: wpCronHook, time: z.number().int().min(0), sig: z.string().regex(/^[0-9a-f]{32}$/, 'An event signature') }),
  },
  'wpcron.undo': {
    title: 'Put a deleted WP-Cron event back',
    description: "Puts back the WP-Cron events a delete removed, from the copy saved before it, next to the events scheduled since.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, url: wpSiteUrl, backup: cronBackupName }),
  },
  'site.clearCache': {
    title: 'Clear caches',
    description: 'Flushes the object cache, deletes transients (network ones too on multisite) and reloads Apache to reset OPcache.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.pluginSet': {
    title: 'Turn a plugin on or off',
    description:
      "Activates or deactivates one plugin of a site with WP-CLI, like its link in wp-admin, so its activation or deactivation code runs. On a multisite network it is turned on network-wide. Must-use plugins and drop-ins always load and cannot be switched. Changes the site's database only; turning it back is the same action.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, plugin: wpSlug, active: z.boolean() }),
  },
  'site.flushRewrites': {
    title: 'Flush rewrite rules',
    description: 'Regenerates WordPress rewrite rules in the database. Does not touch .htaccess.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.openTerminal': {
    title: 'Open in terminal',
    description: "Opens a terminal window at the site's folder on this computer's desktop: the default terminal when the panel knows how to give it a folder, else the first known one installed. Changes nothing.",
    changesSystem: false,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.setPhp': {
    title: "Set a site's PHP version and settings",
    description:
      "Runs a site on a PHP version of its own through its own PHP-FPM pool, with settings on top of the version's (only the ones the panel manages, like memory_limit or max_execution_time), or with version null and no settings puts it back on the PHP every site runs. Version null with settings keeps the default version but gives the site its pool. Only for a site whose folder sits right in the web root; refused when PHP-FPM of that version is missing, when the site's .htaccess sets php_value, or when PHP-FPM of Apache's own version differs from mod_php (php.matchFpm fixes that). A job that checks the pool and the site answer; Undo puts the site's PHP back as it was.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, version: phpVersion.nullable(), values: phpIniValues }),
  },
  'php.matchFpm': {
    title: "Make PHP-FPM match Apache's PHP",
    description:
      "For a PHP version Apache runs as mod_php, gives that version's PHP-FPM the same modules, the panel's settings and Xdebug files, and the same php.ini (FPM's own is saved first), so a site moved to FPM on that version behaves as before. A job; Undo puts FPM's own php.ini back, the modules stay as Apache's.",
    changesSystem: true,
    input: z.object({ version: phpVersion }),
  },
  'network.addAdmin': {
    title: 'Make a super admin administrator on every site',
    description:
      "On a WordPress network, gives one super admin the administrator role on every site where they have no role yet, so My Sites lists them all and plugins that look for the role see them. Roles they have stay; sites deleted in Network Admin are left out. Undo on the job takes them off the sites it added them to, and only those. Starts a job.",
    changesSystem: true,
    // WP-CLI would read a login that starts with a dash as one of its own options.
    input: z.object({ domain: localName, path: sitePath, user: wpLogin.refine((u) => !u.startsWith('-'), 'A WordPress login that does not start with a dash') }),
  },
  'site.setDebug': {
    title: 'Set debug constants',
    description:
      'Sets WordPress debug constants in wp-config.php, each on its own: WP_DEBUG, WP_DEBUG_LOG (to wp-content/debug.log), WP_DEBUG_DISPLAY (errors on the page; on by default), SCRIPT_DEBUG and SAVEQUERIES. Only the ones given change. Log only is WP_DEBUG and WP_DEBUG_LOG on with WP_DEBUG_DISPLAY off.',
    changesSystem: true,
    input: z.object({
      domain: localName, path: sitePath,
      constants: z
        .object({
          WP_DEBUG: z.boolean().optional(),
          WP_DEBUG_LOG: z.boolean().optional(),
          WP_DEBUG_DISPLAY: z.boolean().optional(),
          SCRIPT_DEBUG: z.boolean().optional(),
          SAVEQUERIES: z.boolean().optional(),
        })
        .strict()
        .refine((c) => Object.values(c).some((v) => v !== undefined), 'Set at least one constant'),
    }),
  },
  'site.setConstant': {
    title: 'Set a wp-config.php constant',
    description:
      "Sets one constant in the site's wp-config.php with wp config set, where it is (inside an if too), or adds it; value null removes it with wp config delete. The value is true or false, a whole number or text. The database settings, keys and salts, ABSPATH, a network's layout and names that look like secrets are refused.",
    changesSystem: true,
    input: z.object({
      domain: localName, path: sitePath,
      name: constantName.refine(editableConstant, 'The panel does not set this constant'),
      value: constantValue.nullable(),
    }),
  },
  'site.shuffleSalts': {
    title: 'Make keys and salts',
    description:
      "Writes new WordPress keys and salts into the site's wp-config.php with wp config shuffle-salts, for the keys the site's WordPress asks for. missing writes only the ones WordPress does not take from wp-config.php (missing, left at the placeholder, or copying another key); it used its own for those, so whoever is logged in is logged out once. all makes every one new, which logs everyone out.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, only: z.enum(['missing', 'all']) }),
  },
  'site.removeLegacySalts': {
    title: 'Remove the legacy keys',
    description: "Removes SECRET_KEY and SECRET_SALT, WordPress 2.5's key and 2.6's salt, from the site's wp-config.php with wp config delete. Refused while any of the current keys is missing or not usable, since WordPress still reads the legacy ones then.",
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.clearDebugLog': {
    title: 'Clear debug.log',
    description: 'Empties the site\'s debug.log.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath }),
  },
  'site.login': {
    title: 'Log in to wp-admin',
    description: 'Creates a one-time login link (valid 60 seconds) for the first administrator and returns it.',
    changesSystem: true,
    input: z.object({
      domain: localName, path: sitePath,
      /** A network site's URL; defaults to the main site. */
      siteUrl: z.string().url().max(500).optional(),
      to: z.enum(['admin', 'network']).default('admin'),
    }),
  },
  'core.switch': {
    title: 'Switch WordPress core',
    description: 'Points the site to another shared core with wpcore, then updates the database.',
    changesSystem: true,
    input: z.object({ domain: localName, path: sitePath, version: coreVersion }),
  },
  'core.add': {
    title: 'Add a WordPress core',
    description:
      'Downloads a WordPress release from wordpress.org into the shared cores folder with wpcore, so sites can switch to it. Starts a job. A release with known security issues (for testing) needs confirmInsecure set to the same version.',
    changesSystem: true,
    input: z.object({ version: coreVersion, confirmInsecure: z.string().max(20).optional() }),
  },
  'core.remove': {
    title: 'Remove a WordPress core',
    description: 'Deletes a shared core no site uses any more, with wpcore.',
    changesSystem: true,
    input: z
      .object({ version: coreVersion, confirm: z.string() })
      .refine((v) => v.confirm === v.version, { path: ['confirm'], message: 'Type the version to confirm' }),
  },
  'site.remove': {
    title: 'Remove site',
    description:
      'Moves a site to Deleted sites, whether the panel made it or not: exports its database, archives the folder, vhost, certificate and dump (kept 14 days, restorable), then removes them and drops the database (and the per-site user the panel made). Hosts lines outside the panel block stay. Starts a job.',
    changesSystem: true,
    input: z
      .object({ domain: localName, confirm: z.string() })
      .refine((v) => v.confirm === v.domain, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'trash.restore': {
    title: 'Restore an archived site',
    description:
      'Puts a site from the archive back: folder, vhost, certificate, hosts line, database and its user. When the site exists again it is refused, unless replaceCurrent is set: then the current site goes to the archive first, and Undo puts it back. Starts a job.',
    changesSystem: true,
    input: z.object({ id: trashId, replaceCurrent: z.boolean().default(false) }),
  },
  'trash.delete': {
    title: 'Delete a deleted site for good',
    description: 'Deletes a site from Deleted sites before it would be purged; it can no longer be restored.',
    changesSystem: true,
    input: z
      .object({ id: trashId, confirm: z.string() })
      .refine((v) => v.id.startsWith(`${v.confirm}-`) && localName.safeParse(v.confirm).success, { path: ['confirm'], message: 'Type the domain to confirm' }),
  },
  'site.create': {
    title: 'Create site',
    description:
      'Creates a local site: folder, certificate, vhost and hosts line, and for WordPress the core, database and wp-config.php. From a repo it clones the project, imports the uploaded dump, replaces production domains, moves the sites of a network to the layout chosen for them, deactivates production-only plugins and runs the build. Starts a job; follow it with the job id it returns.',
    changesSystem: true,
    input: z
      .object({
        source: z.enum(['empty', 'wordpress', 'repo']),
        domain: localName,
        /** Install under this path of an existing site's domain, like /learn, in a folder of its own; the domain's vhost serves it. */
        path: sitePath,
        aliases: z.array(localName).max(100).default([]),
        repo: z.object({ url: gitUrl, branch: branchName, layout: z.enum(['site-root', 'wp-content', 'theme', 'plugin']) }).optional(),
        /** An upload from POST /api/uploads holding the database dump. */
        uploadId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
        /** Production host to local domain pairs for search and replace. */
        replace: z.array(z.object({ from: dumpHost, to: localName })).max(50).default([]),
        core: z.object({ mode: z.enum(['wpcore', 'standalone']), version: coreVersion }).optional(),
        admin: z
          .object({
            user: z.string().regex(/^[A-Za-z0-9._@-]{1,60}$/, 'Letters, digits and . _ @ -'),
            email: z.string().email(),
            /** Optional; without one the user gets a random password and signs in with one-click login. Never stored in run history. */
            password: z.string().min(1).max(200).regex(/^[^\r\n]*$/, 'One line').optional(),
            /** For an imported database that has this user already: leave it as it is, or make it an administrator with this password. */
            ifExists: z.enum(['keep', 'update']).default('update'),
            /** For an imported database without this user: create it, or add no user. */
            ifMissing: z.enum(['create', 'skip']).default('create'),
          })
          .optional(),
        deactivate: z.array(wpSlug).max(50).default([]),
        /** Local helper plugins the repo already has, to activate; one the site lacks is skipped, never downloaded. */
        activate: z.array(localHelper).max(10).default([]),
        /** Production host that serves uploads missing locally. */
        uploadsFrom: hostname.optional(),
        /** redirect: the panel's vhost (Local mode under a path); plugin: BE Media from Production, which the repo must have. */
        uploadsVia: uploadsVia.default('redirect'),
        build: z.object({ composer: z.boolean(), npm: z.boolean() }).default({ composer: false, npm: false }),
        /** The builds to run, in order, each in its folder of the repo; when given, build above is not used. */
        builds: z.array(buildStep).max(40).optional(),
        /** The site at this domain goes to the archive first, and Undo puts it back. Not for a site under a path. */
        replaceExisting: z.boolean().default(false),
        /** The install draft this comes from: it is kept while the install runs and goes, with its files, once it is done. */
        draftId: z.string().uuid().optional(),
        /** The GitHub organization or GitLab group the repo was picked from, for how the site was installed. */
        organization: namespaceRef.optional(),
        /** For a network in the dump: its layout here, and the sites whose address changes are moved after the replace. */
        network: networkChoice.optional(),
        /** The web server of a site of its own, once nginx runs next to Apache; a site under a path runs on its parent's. */
        server: z.enum(['apache', 'nginx']).default('apache'),
      })
      .superRefine((v, ctx) => {
        if (v.source === 'repo' && !v.repo) ctx.addIssue({ code: 'custom', path: ['repo'], message: 'A repo is required' });
        if (v.path && v.source === 'empty') ctx.addIssue({ code: 'custom', path: ['path'], message: 'Only a WordPress site can go under a path' });
        if (v.path && v.aliases.length > 0) ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'A site under a path uses its parent\'s domains' });
        if (v.path && !mountFolder(v.domain, v.path)) ctx.addIssue({ code: 'custom', path: ['path'], message: 'This path gives no usable folder name' });
        if (v.source !== 'empty' && !v.core) ctx.addIssue({ code: 'custom', path: ['core'], message: 'Choose a WordPress core' });
        if (v.source !== 'empty' && !v.admin) ctx.addIssue({ code: 'custom', path: ['admin'], message: 'An admin user is required' });
        if (v.aliases.includes(v.domain)) ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'The primary domain is not an alias' });
        if (v.uploadsVia === 'plugin' && (v.source !== 'repo' || !v.uploadsFrom)) {
          ctx.addIssue({ code: 'custom', path: ['uploadsVia'], message: 'BE Media from Production needs a repo that has it and a production host' });
        }
        if (v.path && v.server === 'nginx') ctx.addIssue({ code: 'custom', path: ['server'], message: "A site under a path runs on its parent's server" });
        if (v.replaceExisting && v.path) ctx.addIssue({ code: 'custom', path: ['replaceExisting'], message: 'A site under a path is not replaced; remove it first' });
        if (v.network) {
          if (!v.uploadId || v.path) ctx.addIssue({ code: 'custom', path: ['network'], message: 'A network layout needs a dump, and no site under a path' });
          // Every site's domain is served by this site's vhost and certificate.
          const served = new Set([v.domain, ...v.aliases]);
          const away = v.network.sites.find((s) => !served.has(s.domain));
          if (away) ctx.addIssue({ code: 'custom', path: ['network'], message: `${away.domain} is not one of this site's domains` });
          const addresses = v.network.sites.map((s) => `${s.domain}${s.path}`);
          if (new Set(addresses).size !== addresses.length) ctx.addIssue({ code: 'custom', path: ['network'], message: 'Two sites of the network have the same address' });
        }
      }),
  },
} as const;

export type ActionId = keyof typeof actions;
export type ActionInput<Id extends ActionId> = z.infer<(typeof actions)[Id]['input']>;

export function isActionId(id: string): id is ActionId {
  return Object.hasOwn(actions, id);
}

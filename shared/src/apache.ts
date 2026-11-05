import { z } from 'zod';

/** A module name as mods-available has it: proxy_http, or php8.3 (which is never switched). */
export const apacheModuleName = z.string().regex(/^(?:[a-z][a-z0-9_]{0,39}|php\d+\.\d+)$/, 'A module name like expires');

/**
 * Modules the panel never turns off, with why: its own (it runs behind
 * Apache through them) and the ones every vhost needs. php* and mpm_* are
 * never switched either way. Mirrors DMP_APACHE_KEEP_ON in
 * scripts/lib/apache.sh; change both together.
 */
export const APACHE_KEEP_ON: Readonly<Record<string, string>> = {
  ssl: 'The panel needs it',
  rewrite: 'The panel needs it',
  headers: 'The panel needs it',
  proxy: 'The panel needs it',
  proxy_http: 'The panel needs it',
  proxy_wstunnel: 'The panel needs it',
  socache_shmcb: 'SSL needs it',
  authz_core: 'Every vhost needs it',
  authz_host: 'Every vhost needs it',
  authn_core: 'Every vhost needs it',
  dir: 'Every vhost needs it',
  mime: 'Every vhost needs it',
  alias: 'Every vhost needs it',
};

/** Why a module cannot be switched to `enabled`, or null when it can. */
export function apacheModuleLock(name: string, enabled: boolean): string | null {
  if (/^php\d/.test(name)) return 'Runs PHP for your sites';
  if (name.startsWith('mpm_')) return 'mod_php needs this worker model';
  return enabled ? null : (APACHE_KEEP_ON[name] ?? null);
}

/** One module of mods-available, and why it stays as it is when it does. */
export interface ApacheModule {
  name: string;
  enabled: boolean;
  /** Set when the panel will not switch it from where it is. */
  locked?: string;
}

/** One vhost file of Apache's sites-available, as the Apache tab lists it. */
export interface ApacheVhost {
  /** The file name in sites-available, like local.acme.com-ssl.conf. */
  file: string;
  /** Linked from sites-enabled, so Apache serves it. */
  enabled: boolean;
  /** Written by the panel: its first line is the panel's marker. */
  managed: boolean;
  /** ServerName, then ServerAlias, as the file has them. */
  names: string[];
  docroot?: string;
  /** The panel's site it serves, for a link to its page. */
  site?: string;
  /** Folders served under a path, like /learn. */
  mounts: string[];
  /** When its certificate runs out, when it has one the panel can read. */
  certExpiresAt?: string;
}

export interface ApacheReport {
  checkedAt: string;
  /** apache2ctl configtest through dmp-root: null ok when it could not run, like before the sudoers rule. */
  configtest: { ok: boolean | null; output: string };
  /** Apache at a glance: its version, state, worker model, PHP and ports. */
  server: {
    state: 'running' | 'stopped' | 'missing';
    version?: string;
    /** When it last started, while it runs. */
    since?: string;
    /** The enabled mpm_ module, like mpm_prefork. */
    mpm?: string;
    /** The PHP version mod_php runs, like 8.3. */
    php?: string;
    /** What ports.conf listens on, like 80 and 443. */
    ports: string[];
  };
  /** Every module in mods-available, with whether it is on. */
  modules: ApacheModule[];
  vhosts: ApacheVhost[];
  /** Apache's own error log, for the log below. */
  errorLog: string;
}

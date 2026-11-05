import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * System settings from /etc/devmagic-panel/config.env, the same file dmp-root
 * reads. Parsed with the same rules as scripts/lib/config.sh: known keys,
 * plain values, no shell syntax.
 */
export interface SystemConfig {
  PANEL_USER: string;
  PANEL_GROUP: string;
  PANEL_PORT: number;
  PANEL_DOMAIN: string;
  WEB_DIR: string;
  WEB_GROUP: string;
  CERTS_DIR: string;
  CA_DIR: string;
  APACHE_SITES_AVAILABLE: string;
  APACHE_SITES_ENABLED: string;
  APACHE_LOG_DIR: string;
  HOSTS_FILE: string;
  SYSTEM_CA_DIR: string;
  BACKUP_DIR: string;
  /** Debian's PHP config root (/etc/php); optional in config.env, like in scripts/lib/config.sh. */
  PHP_CONF_DIR: string;
  /** Where Debian keeps each version's packaged php.ini (/usr/lib/php); optional in config.env. */
  PHP_LIB_DIR: string;
  /** Root-owned panel state, like the registry of site folders the panel created; optional in config.env. */
  STATE_DIR: string;
  /** owner/name of the repository the panel updates from; optional, the panel's own by default. */
  UPDATE_REPO?: string;
  /** The git remote of its package tags; optional, git@github.com:<UPDATE_REPO>.git by default. */
  UPDATE_GIT_URL?: string;
}

/** owner/name on GitHub. */
export const REPO_SLUG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
/** A git remote: scp-like, ssh://, https://, file:// or a local path; never an option. */
export const GIT_URL = /^(?:[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+|(?:ssh|https|file):\/\/[A-Za-z0-9_.@:/-]+|\/[A-Za-z0-9_./-]+)$/;

const KEYS = [
  'PANEL_USER', 'PANEL_GROUP', 'PANEL_PORT', 'PANEL_DOMAIN', 'WEB_DIR', 'WEB_GROUP',
  'CERTS_DIR', 'CA_DIR', 'APACHE_SITES_AVAILABLE', 'APACHE_SITES_ENABLED', 'APACHE_LOG_DIR',
  'HOSTS_FILE', 'SYSTEM_CA_DIR', 'BACKUP_DIR',
] as const;

/** Keys added after the first release, with the default older config files get. */
const OPTIONAL = { PHP_CONF_DIR: '/etc/php', PHP_LIB_DIR: '/usr/lib/php', STATE_DIR: '/var/lib/devmagic-panel', UPDATE_REPO: '', UPDATE_GIT_URL: '' };

export const DEFAULT_CONFIG_FILE = '/etc/devmagic-panel/config.env';

export function parseConfig(text: string, source: string): SystemConfig {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([A-Za-z0-9._/@:-]*)$/.exec(line);
    if (!match) throw new Error(`invalid line in ${source}: ${line}`);
    const [, key, value] = match as unknown as [string, string, string];
    if (!(KEYS as readonly string[]).includes(key) && !(key in OPTIONAL)) throw new Error(`unknown key in ${source}: ${key}`);
    values[key] = value;
  }
  for (const key of KEYS) {
    if (!values[key]) throw new Error(`missing key in ${source}: ${key}`);
  }
  const port = Number(values.PANEL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PANEL_PORT must be a port number in ${source}`);
  if (values.UPDATE_REPO && !REPO_SLUG.test(values.UPDATE_REPO)) throw new Error(`UPDATE_REPO must be owner/name in ${source}`);
  if (values.UPDATE_GIT_URL && !GIT_URL.test(values.UPDATE_GIT_URL)) throw new Error(`UPDATE_GIT_URL must be a git remote in ${source}`);
  const { UPDATE_REPO, UPDATE_GIT_URL, ...rest } = values;
  return {
    ...(rest as unknown as Omit<SystemConfig, 'PANEL_PORT' | 'PHP_CONF_DIR' | 'PHP_LIB_DIR' | 'STATE_DIR'>),
    PANEL_PORT: port,
    PHP_CONF_DIR: values.PHP_CONF_DIR || OPTIONAL.PHP_CONF_DIR,
    PHP_LIB_DIR: values.PHP_LIB_DIR || OPTIONAL.PHP_LIB_DIR,
    STATE_DIR: values.STATE_DIR || OPTIONAL.STATE_DIR,
    ...(UPDATE_REPO ? { UPDATE_REPO } : {}),
    ...(UPDATE_GIT_URL ? { UPDATE_GIT_URL } : {}),
  };
}

export function loadConfig(file = process.env.DEVMAGIC_PANEL_CONFIG ?? DEFAULT_CONFIG_FILE): SystemConfig {
  return parseConfig(readFileSync(file, 'utf8'), file);
}

/** Per-user state: secrets in ~/.config, run history in ~/.local/share. */
export interface UserPaths {
  configDir: string;
  secretsFile: string;
  dataDir: string;
  databaseFile: string;
}

export function userPaths(home = homedir()): UserPaths {
  const configDir = process.env.DEVMAGIC_PANEL_HOME ?? join(home, '.config', 'devmagic-panel');
  const dataDir = process.env.DEVMAGIC_PANEL_DATA ?? join(home, '.local', 'share', 'devmagic-panel');
  return {
    configDir,
    secretsFile: join(configDir, 'secrets.json'),
    dataDir,
    databaseFile: join(dataDir, 'panel.db'),
  };
}

/** Where install.sh puts the root-owned scripts. */
export const DMP_ROOT = '/usr/local/lib/devmagic-panel/bin/dmp-root';
export const WPCORE_BIN = '/usr/local/lib/devmagic-panel/bin/wpcore';

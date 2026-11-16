import type { ActionId } from './actions.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type CheckGroup = 'panel' | 'wsl' | 'apache' | 'nginx' | 'database' | 'php' | 'tools' | 'certificates' | 'hosts' | 'access';

export interface CheckFix {
  action: ActionId;
  input: Record<string, unknown>;
  label: string;
  /** Shown before running, for fixes the user should think about first. */
  confirm?: string;
  /** The action takes your sudo password (input.password): the page asks for it before running. */
  needsPassword?: true;
  /** The action takes another secret typed on the page (input.token): what to call it, a hint, and where to make one. */
  secret?: { field: 'token'; label: string; hint?: string; link?: { href: string; text: string } };
}

export interface CheckResult {
  id: string;
  group: CheckGroup;
  label: string;
  status: CheckStatus;
  detail: string;
  /** True for components the panel works without (Xdebug, phpMyAdmin). */
  optional?: boolean;
  /** True for components the panel works without but most sites want (Composer, Imagick, Mailpit); install.sh offers them with yes as the default. */
  recommended?: boolean;
  fixes?: CheckFix[];
}

export interface EnvironmentReport {
  checkedAt: string;
  durationMs: number;
  checks: CheckResult[];
}

export const CHECK_GROUP_LABELS: Record<CheckGroup, string> = {
  panel: 'Panel installation',
  wsl: 'WSL on Windows',
  apache: 'Apache',
  nginx: 'nginx',
  database: 'Database',
  php: 'PHP',
  tools: 'Tools',
  certificates: 'Certificates',
  hosts: 'Hosts file',
  access: 'Access',
};

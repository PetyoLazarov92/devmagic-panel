import type { ActionId } from './actions.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type CheckGroup = 'panel' | 'apache' | 'database' | 'php' | 'tools' | 'certificates' | 'hosts' | 'access';

export interface CheckFix {
  action: ActionId;
  input: Record<string, unknown>;
  label: string;
  /** Shown before running, for fixes the user should think about first. */
  confirm?: string;
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
  apache: 'Apache',
  database: 'Database',
  php: 'PHP',
  tools: 'Tools',
  certificates: 'Certificates',
  hosts: 'Hosts file',
  access: 'Access',
};

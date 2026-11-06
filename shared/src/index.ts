export * from './actions.js';
export * from './environment.js';
export * from './sites.js';
export * from './git.js';
export * from './project.js';
export * from './network.js';
export * from './addresses.js';
export * from './assistant.js';
export * from './text.js';
export * from './password.js';

export interface SessionInfo {
  authenticated: boolean;
  user?: string;
  version: string;
}

export interface ActionRunResult {
  runId: number;
  ok: boolean;
  exitCode: number;
  output: string;
  /** Extra results some actions return, like a one-time login URL. */
  data?: { url?: string; jobId?: string; backup?: string };
}
export * from './org.js';
export * from './preferences.js';
export * from './mysql.js';
export * from './apache.js';
export * from './php.js';
export * from './cron.js';

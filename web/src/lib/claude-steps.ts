import type { ClaudeRun, ClaudeUsage, JobView, OrgStatus } from '@devmagic-panel/shared';
import { totalTokens } from '@devmagic-panel/shared';
import { duration } from './format';

/**
 * The Claude Code steps of an install from an organization, read the repo and
 * check its links, run as jobs that note themselves on the install draft
 * with what they are for, and keep their answer there. These decide what a
 * step does when it opens, or when you come back to it from another page.
 */

export type Resume = { use: 'answer' } | { use: 'follow'; jobId: string } | { use: 'failed'; jobId: string; reason: string } | { use: 'start' };

/** Why a job failed: the last line of its failed step. */
export const failureOf = (job: JobView) => job.steps.find((s) => s.status === 'failed')?.output?.trim().split('\n').at(-1) || `${job.title} stopped`;

/**
 * The answer kept for this repo or these links, the job still working on
 * them, why that job failed, or a new run. A job or answer for another repo
 * or other links is never used.
 */
export function resumeStep(key: string, saved: { key: string } | undefined, noted: { id: string; key?: string } | undefined, job: JobView | null): Resume {
  if (saved?.key === key) return { use: 'answer' };
  if (noted?.key === key && job?.id === noted.id) {
    if (job.status === 'running' || job.status === 'queued') return { use: 'follow', jobId: job.id };
    if (job.status === 'failed') return { use: 'failed', jobId: job.id, reason: failureOf(job) };
  }
  return { use: 'start' };
}

export type OrgCardState = 'checking' | 'error' | 'missing' | 'signed-out' | 'api' | 'ready';

/** Where the organization start stands with Claude Code: only a claude.ai sign-in reaches Asana and Google. */
export function orgCardState({ status, checking }: { status: OrgStatus | null; checking: boolean }): OrgCardState {
  const claude = status?.claude;
  return checking ? 'checking' : !claude ? 'error' : !claude.found ? 'missing' : !claude.signedIn ? 'signed-out' : claude.claudeAi ? 'ready' : 'api';
}

/** The access check as the wizard keeps it, for skipping it and back. */
export interface AccessAnswer {
  status: 'idle' | 'checking' | 'done' | 'skipped' | 'error';
}

/**
 * Skip it and pick a dump myself: an answer the check has stays, since its
 * dumps list beside your own and it is paid for; otherwise nothing runs until
 * you ask. A check still running goes on, and its answer is kept.
 */
export const skipAccess = <A extends AccessAnswer>(access: A): A | { status: 'skipped' } => (access.status === 'done' ? access : { status: 'skipped' });

/**
 * Check access, or Check the links after a skip: the step looks again, so the
 * answer kept for these links comes back at no cost, a running check is
 * followed, and only otherwise does Claude Code run.
 */
export const unskipAccess = <A extends AccessAnswer>(access: A): A | { status: 'idle' } => (access.status === 'skipped' ? { status: 'idle' } : access);

/** Where the Claude Code card's values come from: this install's own only when it changed them from your defaults. */
export function runSource(own: ClaudeRun | undefined, defaults: ClaudeRun): 'defaults' | 'install' {
  return own && (own.model !== defaults.model || own.effort !== defaults.effort || own.budgetUsd !== defaults.budgetUsd) ? 'install' : 'defaults';
}

/** 48210 as 48.2k, 1350000 as 1.4M: a token count at a glance. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** What a run took, as the Claude Code card lists it: "1 min 12 s · 48.2k tokens · $0.31"; older answers have only the cost. */
export function usageText(u: ClaudeUsage): string {
  return [u.durationMs !== undefined ? duration(u.durationMs) : '', u.tokens ? `${tokenCount(totalTokens(u.tokens))} tokens` : '', `$${u.costUsd.toFixed(2)}`].filter(Boolean).join(' · ');
}

/** The hover text of a run: its tokens of each kind, and what the cost is. */
export function usageHover(u: ClaudeUsage, claudeAi: boolean): string {
  const tokens = u.tokens ? `Tokens: ${u.tokens.input} input, ${u.tokens.output} output, ${u.tokens.cacheRead} read from cache, ${u.tokens.cacheWrite} written to cache. ` : '';
  return `${tokens}The cost is Claude Code's estimate at API prices${claudeAi ? '; with a claude.ai sign-in it is not billed and counts toward your plan\'s limits' : ''}.`;
}

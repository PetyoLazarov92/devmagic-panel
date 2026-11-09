import type { InstallDraft, NewSiteSource } from '@devmagic-panel/shared';
import { placementForLayout } from '@devmagic-panel/shared';
import { canOpen } from './steps';

/**
 * The new site wizard's steps and its drafts as the rest of the panel shows
 * them. A draft has its own address, /sites/new/<draft>/<step>, so the
 * browser's Back and Forward move between its steps and a reload stays.
 */

export type WizardStep = 'start' | 'code' | 'read' | 'database' | 'domains' | 'wordpress' | 'review';

export const STEP_LABEL: Record<WizardStep, string> = {
  start: 'Start',
  code: 'Code',
  read: 'Claude reads the project',
  database: 'Database',
  domains: 'Domains',
  wordpress: 'WordPress',
  review: 'Review',
};

const SOURCES: readonly NewSiteSource[] = ['repo', 'wordpress', 'empty'];

/** The steps of each kind of install; a project lets Claude Code read the repo and its links only when you switch it on. */
export function stepsFor(source: NewSiteSource, claude = false): WizardStep[] {
  if (source === 'repo') return ['start', 'code', ...(claude ? (['read'] as const) : []), 'database', 'domains', 'wordpress', 'review'];
  if (source === 'wordpress') return ['start', 'domains', 'wordpress', 'review'];
  return ['start', 'domains', 'review'];
}

/** What an install starts from: one of the start cards. */
export type InstallKind = NewSiteSource;

/** Each kind's name: the first step's label, and the badge by a draft's name. */
export const KIND_LABEL: Record<InstallKind, string> = {
  repo: 'From a project',
  wordpress: 'Fresh WordPress',
  empty: 'Empty site',
};

export const kindOf = (source: NewSiteSource): InstallKind => source;

/** Whether a draft's answers have Claude Code read the repo: switched on, or an organization install from before 1.28. */
export function usesClaude(state: unknown): boolean {
  const org = (state as { org?: { useClaude?: unknown } | null } | null)?.org;
  if (!org) return false;
  return org.useClaude === undefined ? true : org.useClaude === true;
}

/** A step a draft stopped at in an older panel, in today's steps: Code came from two steps in 1.28, and the two Claude steps are one since 1.31. */
export function migrateStep(step: string): string {
  return step === 'source' || step === 'org' ? 'code' : step === 'access' ? 'read' : step;
}

/** A draft's address; without a step it opens where the draft stopped. */
export const draftHref = (id: string, step?: WizardStep) => `/sites/new/${encodeURIComponent(id)}${step ? `/${step}` : ''}`;

/** The step an address opens: the one it names when it can, else the furthest one that opens. */
export function landingStep(flow: readonly WizardStep[], wanted: string | undefined, passed: Partial<Record<WizardStep, string>>): WizardStep {
  const asked = flow.find((s) => s === wanted);
  if (asked && canOpen(flow, asked, passed)) return asked;
  return [...flow].reverse().find((s) => canOpen(flow, s, passed)) ?? 'start';
}

export interface DraftProgress {
  kind: InstallKind;
  /** The step it stopped at, 1 based, of total. */
  at: number;
  total: number;
  step: WizardStep;
  label: string;
}

/** Where a draft stands, for the lists of unfinished installs. */
export function draftProgress(draft: InstallDraft): DraftProgress {
  const saved = (draft.state ?? {}) as { source?: unknown; org?: unknown };
  const source = SOURCES.find((s) => s === saved.source) ?? 'repo';
  const flow = stepsFor(source, usesClaude(saved));
  const i = Math.max(0, flow.indexOf(migrateStep(draft.step) as WizardStep));
  const step = flow[i] ?? 'start';
  return { kind: kindOf(source), at: i + 1, total: flow.length, step, label: STEP_LABEL[step] };
}

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When a draft goes, in local time: "18:40" today, "tomorrow 09:15", else the date too. */
export function keptUntil(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days === 0) return clock(at);
  if (days === 1) return `tomorrow ${clock(at)}`;
  return `${at.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${clock(at)}`;
}

/**
 * A draft's saved answers in today's shape. Before 1.28 a draft kept where
 * the repo goes as a layout (site-root, wp-content, theme, plugin): it becomes
 * a placement, a folder of the site and a folder name.
 */
export function migrateDraftState(state: unknown): Record<string, unknown> {
  const saved: Record<string, unknown> = state && typeof state === 'object' && !Array.isArray(state) ? { ...(state as Record<string, unknown>) } : {};
  // An organization install from before 1.28 had Claude Code read the repo.
  if (saved.org && typeof saved.org === 'object' && (saved.org as { useClaude?: unknown }).useClaude === undefined) saved.org = { ...(saved.org as object), useClaude: true };
  // Passed steps of the old flow name the step that replaced them.
  if (saved.passed && typeof saved.passed === 'object') {
    const passed = { ...(saved.passed as Record<string, unknown>) };
    for (const old of ['source', 'org']) {
      if (passed[old] !== undefined) passed.code ??= passed[old];
      delete passed[old];
    }
    // The two Claude steps are one since 1.31: the links' step has no place of its own.
    delete passed.access;
    saved.passed = passed;
  }
  if ('layout' in saved) {
    const layouts = ['site-root', 'wp-content', 'theme', 'plugin'] as const;
    const layout = layouts.find((l) => l === saved.layout);
    delete saved.layout;
    const url = typeof saved.repoUrl === 'string' ? saved.repoUrl.trim() : '';
    if (layout && saved.placement === undefined) saved.placement = placementForLayout(layout, url);
  }
  return saved;
}

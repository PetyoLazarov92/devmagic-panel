import type { InstallDraft, NewSiteSource } from '@devmagic-panel/shared';
import { canOpen } from './steps';

/**
 * The new site wizard's steps and its drafts as the rest of the panel shows
 * them. A draft has its own address, /sites/new/<draft>/<step>, so the
 * browser's Back and Forward move between its steps and a reload stays.
 */

export type WizardStep = 'start' | 'org' | 'read' | 'access' | 'source' | 'domains' | 'wordpress' | 'review';

export const STEP_LABEL: Record<WizardStep, string> = {
  start: 'Start',
  org: 'Organization',
  read: 'Read the repo',
  access: 'Links and dump',
  source: 'Repo and database',
  domains: 'Domains',
  wordpress: 'WordPress',
  review: 'Review',
};

const SOURCES: readonly NewSiteSource[] = ['repo', 'wordpress', 'empty'];

/** The steps of each kind of install. */
export function stepsFor(source: NewSiteSource, fromOrg = false): WizardStep[] {
  if (fromOrg) return ['start', 'org', 'read', 'access', 'domains', 'wordpress', 'review'];
  if (source === 'repo') return ['start', 'source', 'domains', 'wordpress', 'review'];
  if (source === 'wordpress') return ['start', 'domains', 'wordpress', 'review'];
  return ['start', 'domains', 'review'];
}

/** What an install starts from: one of the start cards. */
export type InstallKind = NewSiteSource | 'org';

/** Each kind's name: the first step's label, and the badge by a draft's name. */
export const KIND_LABEL: Record<InstallKind, string> = {
  org: 'Organization install',
  repo: 'Git and DB dump',
  wordpress: 'Fresh WordPress',
  empty: 'Empty site',
};

export const kindOf = (source: NewSiteSource, fromOrg: boolean): InstallKind => (fromOrg ? 'org' : source);

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
  const fromOrg = Boolean(saved.org);
  const flow = stepsFor(source, fromOrg);
  const i = Math.max(0, flow.indexOf(draft.step as WizardStep));
  const step = flow[i] ?? 'start';
  return { kind: kindOf(source, fromOrg), at: i + 1, total: flow.length, step, label: STEP_LABEL[step] };
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

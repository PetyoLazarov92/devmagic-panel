import type { OrgRepo } from '@devmagic-panel/shared';
import type { WizardState } from '@/pages/new-site';
import type { OrgState } from '@/pages/new-site-org';

/** How many other repos an organization install keeps its progress for. */
export const KEPT_REPOS = 3;

/** A repo's progress in an organization install, kept while you look at another one. */
export interface RepoProgress {
  savedAt: number;
  state: Omit<WizardState, 'org'>;
  org: Omit<OrgState, 'earlier'>;
}

/** The current repo's progress put aside, newest first and at most KEPT_REPOS; never the admin password. */
function putAside(s: WizardState, now: number): Record<string, RepoProgress> {
  const { earlier = {}, ...org } = s.org as OrgState;
  const { org: _org, ...rest } = s;
  const kept = { ...earlier };
  if (org.repo) kept[org.repo.fullName] = { savedAt: now, state: { ...rest, adminPassword: null }, org };
  return kept;
}

const newest = (kept: Record<string, RepoProgress>) =>
  Object.fromEntries(Object.entries(kept).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, KEPT_REPOS));

/**
 * Picking a repo in an organization install. The one you have changes
 * nothing. Another one puts the current repo's progress aside: what Claude
 * read, the links, the dump, your answers and the steps you reached. A repo
 * picked before comes back as you left it; a new one starts from `blank`
 * with no dump of the previous repo's.
 */
export function switchRepo(s: WizardState, repo: OrgRepo, blank: WizardState, now = Date.now()): WizardState {
  const org = s.org;
  if (!org) return s;
  if (org.repo?.fullName === repo.fullName) return s;
  const kept = putAside(s, now);
  const back = kept[repo.fullName];
  delete kept[repo.fullName];
  const rest = newest(kept);
  const others = Object.keys(rest).length ? { earlier: rest } : {};
  // This install's Claude Code settings stay with the install, not the repo.
  const claude = org.claude ? { claude: org.claude } : {};
  if (back) return { ...back.state, org: { ...back.org, ...claude, ...others } };
  return {
    ...blank,
    source: 'repo',
    repoUrl: repo.sshUrl,
    branch: repo.defaultBranch ?? '',
    passed: s.passed.start ? { start: s.passed.start } : {},
    org: { name: repo.org, repo, read: { status: 'idle' }, access: { status: 'idle' }, ...claude, ...others },
  };
}

/** Another organization in the picker: the current repo's progress is put aside and no repo is picked. */
export function switchOrg(s: WizardState, name: string, now = Date.now()): WizardState {
  const org = s.org;
  if (!org || org.name === name) return s;
  const rest = newest(putAside(s, now));
  return { ...s, org: { name, repo: null, read: { status: 'idle' }, access: { status: 'idle' }, ...(org.claude ? { claude: org.claude } : {}), ...(Object.keys(rest).length ? { earlier: rest } : {}) } };
}

/** The dumps the repos put aside use, kept with the draft so they are not removed while you look elsewhere. */
export const asideUploads = (org: OrgState | null): string[] => Object.values(org?.earlier ?? {}).flatMap((p) => (p.state.upload ? [p.state.upload.id] : []));

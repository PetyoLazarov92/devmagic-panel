import type { CheckGroup, CheckResult, EnvironmentReport, MachineCheckStatus } from '@devmagic-panel/shared';

export const GROUP_ORDER: CheckGroup[] = ['panel', 'wsl', 'apache', 'nginx', 'certificates', 'hosts', 'database', 'php', 'tools', 'access'];

/** The worst status of a group's checks; info (an optional part not set up) only when nothing is wrong. */
export function groupStatus(checks: CheckResult[]): MachineCheckStatus {
  for (const s of ['fail', 'warn', 'info'] as const) if (checks.some((c) => c.status === s)) return s;
  return 'ok';
}

/** The groups a report has, in page order. */
export function groupsOf(report: EnvironmentReport): Array<{ group: CheckGroup; checks: CheckResult[]; status: MachineCheckStatus }> {
  return GROUP_ORDER.flatMap((group) => {
    const checks = report.checks.filter((c) => c.group === group);
    return checks.length ? [{ group, checks, status: groupStatus(checks) }] : [];
  });
}

/**
 * The groups open after a check: what was open stays open (so a fix that
 * passes keeps its output in view), and every group with a warning or a
 * failure opens. The first check opens only those.
 */
export function openAfterCheck(prev: ReadonlySet<CheckGroup>, report: EnvironmentReport): Set<CheckGroup> {
  const problems = groupsOf(report).filter((g) => g.status === 'warn' || g.status === 'fail').map((g) => g.group);
  return new Set([...prev, ...problems]);
}

/** Checks with a warning or a failure, for the Checks tab. */
export function problemCount(report: EnvironmentReport): { count: number; tone: 'warning' | 'danger' } {
  const bad = report.checks.filter((c) => c.status === 'warn' || c.status === 'fail');
  return { count: bad.length, tone: bad.some((c) => c.status === 'fail') ? 'danger' : 'warning' };
}

/** What Machine checks shows: every check, or only those of one status. */
export type CheckShow = 'all' | MachineCheckStatus;

const SHOWS: ReadonlyArray<{ value: Exclude<CheckShow, 'all'>; label: string; tone?: 'warning' | 'danger' }> = [
  { value: 'fail', label: 'Failing', tone: 'danger' },
  { value: 'warn', label: 'Warnings', tone: 'warning' },
  { value: 'info', label: 'Optional to set up' },
  { value: 'ok', label: 'Passing' },
];

/** The filters over Machine checks, each with its count; one with nothing in it is left out. */
export function showOptions(report: EnvironmentReport): Array<{ value: CheckShow; label: string; count: number; tone?: 'warning' | 'danger' }> {
  const count = (s: MachineCheckStatus) => report.checks.filter((c) => c.status === s).length;
  return [{ value: 'all' as const, label: 'All', count: report.checks.length }, ...SHOWS.map((o) => ({ ...o, count: count(o.value) })).filter((o) => o.count > 0)];
}

/** A filter from the address (?show=warn), or All when it is none of them. */
export const parseShow = (value: string | null): CheckShow => (value === 'fail' || value === 'warn' || value === 'info' || value === 'ok' ? value : 'all');

/**
 * The groups a filter shows: each group with checks of that status, in page
 * order, with only those checks in it; every group when the filter is All.
 */
export function shownGroups(report: EnvironmentReport, show: CheckShow): ReturnType<typeof groupsOf> {
  const groups = groupsOf(report);
  if (show === 'all') return groups;
  return groups.flatMap((g) => {
    const checks = g.checks.filter((c) => c.status === show);
    return checks.length ? [{ ...g, checks }] : [];
  });
}


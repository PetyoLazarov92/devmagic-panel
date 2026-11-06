import type { CheckGroup, CheckResult, CheckStatus, EnvironmentReport } from '@devmagic-panel/shared';

export const GROUP_ORDER: CheckGroup[] = ['panel', 'apache', 'nginx', 'certificates', 'hosts', 'database', 'php', 'tools', 'access'];

/** The worst status of a group's checks. */
export function groupStatus(checks: CheckResult[]): CheckStatus {
  return checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
}

/** The groups a report has, in page order. */
export function groupsOf(report: EnvironmentReport): Array<{ group: CheckGroup; checks: CheckResult[]; status: CheckStatus }> {
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
  const problems = groupsOf(report).filter((g) => g.status !== 'ok').map((g) => g.group);
  return new Set([...prev, ...problems]);
}

/** Checks with a warning or a failure, for the Checks tab. */
export function problemCount(report: EnvironmentReport): { count: number; tone: 'warning' | 'danger' } {
  const bad = report.checks.filter((c) => c.status !== 'ok');
  return { count: bad.length, tone: bad.some((c) => c.status === 'fail') ? 'danger' : 'warning' };
}

import type { CheckGroup, CheckResult, CheckStatus, EnvironmentReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { groupsOf, openAfterCheck, problemCount } from '../src/lib/environment.js';

const check = (id: string, group: CheckGroup, status: CheckStatus): CheckResult => ({ id, group, status, label: id, detail: '' });
const report = (...checks: CheckResult[]): EnvironmentReport => ({ checkedAt: '2026-10-26T10:00:00Z', durationMs: 900, checks });

describe('the environment checks', () => {
  it('lists the groups in page order with their worst status', () => {
    const r = report(check('php', 'php', 'ok'), check('mod', 'apache', 'warn'), check('ssl', 'apache', 'fail'), check('cli', 'tools', 'warn'));
    expect(groupsOf(r).map((g) => [g.group, g.status])).toEqual([
      ['apache', 'fail'],
      ['php', 'ok'],
      ['tools', 'warn'],
    ]);
  });

  it('opens only the groups with a problem the first time', () => {
    const r = report(check('php', 'php', 'ok'), check('mod', 'apache', 'warn'));
    expect([...openAfterCheck(new Set(), r)]).toEqual(['apache']);
  });

  it('keeps what was open after a fix passes, and opens a group with a new problem', () => {
    const r = report(check('mod', 'apache', 'ok'), check('cli', 'tools', 'fail'));
    expect([...openAfterCheck(new Set<CheckGroup>(['apache']), r)].sort()).toEqual(['apache', 'tools']);
  });

  it('counts warnings and failures for the tab, red when any fails', () => {
    expect(problemCount(report(check('a', 'php', 'ok'), check('b', 'php', 'warn')))).toEqual({ count: 1, tone: 'warning' });
    expect(problemCount(report(check('b', 'php', 'warn'), check('c', 'tools', 'fail')))).toEqual({ count: 2, tone: 'danger' });
    expect(problemCount(report(check('a', 'php', 'ok'))).count).toBe(0);
  });
});

import type { CheckGroup, CheckResult, EnvironmentReport, MachineCheckStatus } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { groupsOf, openAfterCheck, parseShow, problemCount, showOptions, shownGroups } from '../src/lib/environment.js';

const check = (id: string, group: CheckGroup, status: MachineCheckStatus): CheckResult => ({ id, group, status, label: id, detail: '' });
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

describe('optional parts that are not set up', () => {
  it('are info: no warning, no group opened, but the group says so', () => {
    const r = report(check('gh', 'access', 'ok'), check('glab', 'access', 'info'), check('php', 'php', 'ok'));
    expect(groupsOf(r).map((g) => [g.group, g.status])).toEqual([['php', 'ok'], ['access', 'info']]);
    expect([...openAfterCheck(new Set(), r)]).toEqual([]);
    expect(problemCount(r)).toEqual({ count: 0, tone: 'warning' });
    expect(groupsOf(report(check('glab', 'access', 'info'), check('ssh', 'access', 'warn')))[0]?.status).toBe('warn');
  });
});

describe('the filters over Machine checks', () => {
  const r = report(check('gh', 'access', 'info'), check('ssh', 'access', 'ok'), check('xdebug', 'php', 'info'), check('mod', 'apache', 'warn'), check('php', 'php', 'ok'));

  it('count each status, leaving out the ones with nothing', () => {
    expect(showOptions(r).map((o) => [o.value, o.count])).toEqual([['all', 5], ['warn', 1], ['info', 2], ['ok', 2]]);
  });

  it('keep every group that has one, in page order, with only those checks', () => {
    // Optional parts in two groups: both stay, each with its own.
    expect(shownGroups(r, 'info').map((g) => [g.group, g.checks.map((c) => c.id)])).toEqual([['php', ['xdebug']], ['access', ['gh']]]);
    expect(shownGroups(r, 'all')).toEqual(groupsOf(r));
  });

  it('read a filter from the address, All for anything else', () => {
    expect(parseShow('warn')).toBe('warn');
    expect(parseShow('nope')).toBe('all');
    expect(parseShow(null)).toBe('all');
  });
});

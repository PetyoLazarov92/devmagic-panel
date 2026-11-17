import type { CheckFix, CheckResult, EnvironmentReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { installRuns, missingInstalls, pickedAtFirst, picksAfter, showsInstallCard, staysHidden } from '../src/lib/install-missing.js';

const report = (...checks: CheckResult[]): EnvironmentReport => ({ checkedAt: '2026-11-17T10:00:00Z', durationMs: 900, checks });
const withPassword = (item: string): CheckFix => ({ action: 'system.install', input: { items: [item] }, label: 'Install with your password', needsPassword: true });
const GH: CheckFix = { action: 'tools.install', input: { tool: 'gh' }, label: 'Install the GitHub CLI' };

const FRESH = report(
  { id: 'tools.git', group: 'tools', status: 'ok', label: 'git', detail: 'git version 2.43.0' },
  { id: 'tools.wpcli', group: 'tools', status: 'fail', label: 'WP-CLI', detail: 'wp is not installed', fixes: [withPassword('wp-cli')] },
  { id: 'tools.composer', group: 'tools', status: 'warn', label: 'Composer', detail: 'not installed', recommended: true, fixes: [withPassword('composer')] },
  { id: 'php.imagick', group: 'php', status: 'warn', label: 'Imagick', detail: 'not installed', recommended: true, fixes: [{ action: 'php.package', input: { version: '8.3', name: 'imagick', how: 'install' }, label: 'Install for PHP 8.3' }] },
  { id: 'php.xdebug', group: 'php', status: 'warn', label: 'Xdebug', detail: 'not installed', optional: true, fixes: [{ action: 'php.package', input: { version: '8.3', name: 'xdebug', how: 'install' }, label: 'Install for PHP 8.3' }] },
  { id: 'nginx.installed', group: 'nginx', status: 'warn', label: 'nginx', detail: 'not installed', optional: true, fixes: [withPassword('nginx')] },
  { id: 'access.githubCli', group: 'access', status: 'warn', label: 'GitHub CLI', detail: 'not installed', optional: true, fixes: [GH] },
  { id: 'access.github', group: 'access', status: 'warn', label: 'GitHub access', detail: 'git over SSH cannot sign in', fixes: [GH] },
  { id: 'mysql.readonly', group: 'tools', status: 'warn', label: 'Read-only MySQL account', detail: 'not made yet', optional: true, fixes: [{ action: 'mysql.makeReadOnlyAccount', input: {}, label: 'Make it' }] },
);

describe('Install what is missing', () => {
  it('gathers the installs Machine checks offers, once each, the needed ones first', () => {
    const missing = missingInstalls(FRESH);
    expect(missing.map((m) => [m.label, m.kind])).toEqual([
      ['GitHub CLI', 'required'],
      ['WP-CLI', 'required'],
      ['Composer', 'recommended'],
      ['Imagick for PHP 8.3', 'recommended'],
      ['nginx', 'optional'],
      ['Xdebug for PHP 8.3', 'optional'],
    ]);
    // What is not an install (a MySQL account) stays with its own check.
    expect(missing.some((m) => m.fix.action === 'mysql.makeReadOnlyAccount')).toBe(false);
  });

  it('ticks what the panel needs or recommends, never an optional one', () => {
    const missing = missingInstalls(FRESH);
    expect([...pickedAtFirst(missing)].map((k) => missing.find((m) => m.key === k)?.label)).toEqual(['GitHub CLI', 'WP-CLI', 'Composer', 'Imagick for PHP 8.3']);
  });

  it('asks the password once: everything that needs it in one install', () => {
    const missing = missingInstalls(FRESH);
    expect(installRuns(missing, 's3cret')).toEqual([
      { action: 'tools.install', input: { tool: 'gh' }, what: 'GitHub CLI' },
      { action: 'php.package', input: { version: '8.3', name: 'imagick', how: 'install' }, what: 'Imagick for PHP 8.3' },
      { action: 'php.package', input: { version: '8.3', name: 'xdebug', how: 'install' }, what: 'Xdebug for PHP 8.3' },
      { action: 'system.install', input: { items: ['wp-cli', 'composer', 'nginx'], password: 's3cret' }, what: 'WP-CLI, Composer, nginx' },
    ]);
    expect(installRuns(missing.filter((m) => !m.fix.needsPassword), '')).toHaveLength(3);
  });

  it('shows for two installs or a needed one, not for a single optional one', () => {
    const one = (optional: boolean) => missingInstalls(report({ id: 'php.xdebug', group: 'php', status: 'warn', label: 'Xdebug', detail: '', ...(optional ? { optional } : {}), fixes: [withPassword('nginx')] }));
    expect(showsInstallCard(one(true))).toBe(false);
    expect(showsInstallCard(one(false))).toBe(true);
    expect(showsInstallCard(missingInstalls(FRESH))).toBe(true);
    expect(showsInstallCard([])).toBe(false);
  });
});

describe('Install what is missing, after the first report', () => {
  const tool = (id: string, tool: string, optional = true): CheckResult => ({ id, group: 'access', status: optional ? 'info' : 'warn', label: id, detail: 'not installed', optional, fixes: [{ action: 'tools.install', input: { tool }, label: 'Install' }] });

  it('names each pinned tool by itself, whichever check offers it', () => {
    const missing = missingInstalls(report(tool('access.githubCli', 'gh'), tool('access.gitlabCli', 'glab'), tool('tools.rclone', 'rclone')));
    expect(missing.map((m) => m.label)).toEqual(['GitHub CLI', 'GitLab CLI', 'rclone']);
  });

  it('keeps your picks on Check again, and ticks a needed install that is new', () => {
    const first = missingInstalls(FRESH);
    const seen = new Set(first.map((m) => m.key));
    // You untick Composer; a later check finds a needed install that was not offered before.
    const picked = new Set([...pickedAtFirst(first)].filter((k) => !k.includes('composer')));
    const later = missingInstalls({ ...FRESH, checks: [...FRESH.checks, tool('tools.rclone', 'rclone', false)] });
    const after = picksAfter(later, picked, seen);
    expect(later.filter((m) => after.has(m.key)).map((m) => m.label)).toEqual(['GitHub CLI', 'rclone', 'WP-CLI', 'Imagick for PHP 8.3']);
  });

  it('Hide this lasts until the panel needs an install it did not offer then', () => {
    const missing = missingInstalls(FRESH);
    const keys = missing.map((m) => m.key);
    expect(staysHidden(missing, null)).toBe(false);
    expect(staysHidden(missing, keys)).toBe(true);
    // A new optional one keeps it hidden; a new needed one shows it again.
    expect(staysHidden(missingInstalls({ ...FRESH, checks: [...FRESH.checks, tool('tools.rclone', 'rclone')] }), keys)).toBe(true);
    expect(staysHidden(missingInstalls({ ...FRESH, checks: [...FRESH.checks, tool('tools.rclone', 'rclone', false)] }), keys)).toBe(false);
  });
});

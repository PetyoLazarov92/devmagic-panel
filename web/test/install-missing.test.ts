import type { CheckFix, CheckResult, EnvironmentReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { installRuns, missingInstalls, pickedAtFirst, showsInstallCard } from '../src/lib/install-missing.js';

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

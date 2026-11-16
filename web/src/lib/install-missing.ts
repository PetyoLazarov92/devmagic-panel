import type { CheckFix, EnvironmentReport } from '@devmagic-panel/shared';

/** The fixes that install something; the Install what is missing card gathers them. */
const INSTALLS = new Set(['tools.install', 'php.package', 'system.install']);

export type InstallKind = 'required' | 'recommended' | 'optional';
const RANK: Record<InstallKind, number> = { required: 0, recommended: 1, optional: 2 };

export interface MissingInstall {
  key: string;
  label: string;
  detail: string;
  kind: InstallKind;
  fix: CheckFix;
}

/**
 * What the report says is missing and can be installed from Machine checks, one
 * entry per install: two checks may offer the same one (the GitHub CLI), which
 * then counts as the more needed of the two.
 */
export function missingInstalls(report: EnvironmentReport): MissingInstall[] {
  const found = new Map<string, MissingInstall>();
  for (const check of report.checks) {
    if (check.status === 'ok') continue;
    const fix = check.fixes?.find((f) => INSTALLS.has(f.action) && (f.action !== 'php.package' || f.input.how === 'install'));
    if (!fix) continue;
    const key = `${fix.action}:${JSON.stringify(fix.input)}`;
    const kind: InstallKind = check.optional ? 'optional' : check.recommended ? 'recommended' : 'required';
    const label = fix.action === 'tools.install' ? 'GitHub CLI' : fix.action === 'php.package' ? `${check.label} for PHP ${String(fix.input.version)}` : check.label;
    const before = found.get(key);
    if (!before) found.set(key, { key, label, detail: check.detail, kind, fix });
    else if (RANK[kind] < RANK[before.kind]) found.set(key, { ...before, kind });
  }
  return [...found.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.label.localeCompare(b.label));
}

/** The card shows while two or more installs are offered, or any one the panel needs or recommends. */
export const showsInstallCard = (missing: readonly MissingInstall[]): boolean => missing.length >= 2 || missing.some((m) => m.kind !== 'optional');

/** The installs ticked at first: what the panel needs or recommends. */
export const pickedAtFirst = (missing: readonly MissingInstall[]): Set<string> => new Set(missing.filter((m) => m.kind !== 'optional').map((m) => m.key));

/**
 * How the ticked installs run: those without a password each in their own job;
 * those with one together in one system.install, so the password is asked once.
 */
export function installRuns(chosen: readonly MissingInstall[], password: string): Array<{ action: CheckFix['action']; input: Record<string, unknown>; what: string }> {
  const free = chosen.filter((m) => !m.fix.needsPassword).map((m) => ({ action: m.fix.action, input: m.fix.input, what: m.label }));
  const withPassword = chosen.filter((m) => m.fix.needsPassword);
  if (withPassword.length === 0) return free;
  const items = [...new Set(withPassword.flatMap((m) => (Array.isArray(m.fix.input.items) ? (m.fix.input.items as string[]) : [])))];
  return [...free, { action: 'system.install', input: { items, password }, what: withPassword.map((m) => m.label).join(', ') }];
}

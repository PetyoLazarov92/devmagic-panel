import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput, PhpIniKey, PhpSapi, PhpSettings } from '@devmagic-panel/shared';
import { isPhpIniKey, PHP_INI_SETTINGS, phpIniValueError, XDEBUG_MODES } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { hasSapi, parseIni, readIniDiff } from './ini.js';
import { apachePhpVersion } from './versions.js';

/** Same file name as DMP_PHP_INI_NAME in scripts/lib/php.sh. */
export const PANEL_INI = '99-devmagic-panel.ini';

export class PhpSettingsRefused extends Error {}

const versionOrApache = (config: SystemConfig, version: string | undefined): string | undefined => version ?? apachePhpVersion(config);

export async function setPhpModule(config: SystemConfig, exec: Executor, dmpRoot: string, { version, module, enabled }: ActionInput<'php.setModule'>): Promise<ExecResult[]> {
  const v = versionOrApache(config, version);
  return [await runRoot(exec, dmpRoot, ['php-module', ...(v ? [v] : []), module, enabled ? 'on' : 'off'])];
}

export async function setXdebug(config: SystemConfig, exec: Executor, dmpRoot: string, { version, enabled, modes, startWithRequest }: ActionInput<'php.setXdebug'>): Promise<ExecResult[]> {
  const v = versionOrApache(config, version);
  // Always in the panel's order, so the same choice writes the same line.
  const mode = XDEBUG_MODES.filter((m) => modes.includes(m)).join(',');
  return [await runRoot(exec, dmpRoot, enabled ? ['xdebug-enable', ...(v ? [v] : []), mode, startWithRequest] : ['xdebug-disable', ...(v ? [v] : [])])];
}

/** key=value arguments for php-ini, in the panel's order of settings. */
const pairs = (values: Partial<Record<string, string>>): string[] =>
  (Object.keys(PHP_INI_SETTINGS) as PhpIniKey[]).filter((k) => values[k] !== undefined).map((k) => `${k}=${values[k]}`);

export async function setPhpIni(exec: Executor, dmpRoot: string, { version, scope, values }: ActionInput<'php.setIni'>): Promise<ExecResult[]> {
  return [await runRoot(exec, dmpRoot, ['php-ini', version, scope, ...pairs(values)])];
}

/** The parts behind a scope: web is Apache's mod_php and FPM, cli the command line. */
const sapisOf = (scope: 'web' | 'cli'): PhpSapi[] => (scope === 'web' ? ['apache2', 'fpm'] : ['cli']);

const readIni = (file: string) => (existsSync(file) ? parseIni(readFileSync(file, 'utf8')) : new Map<string, string>());

/** The managed settings in one ini map. */
const managed = (ini: Map<string, string>): Partial<Record<PhpIniKey, string>> =>
  Object.fromEntries([...ini].filter(([k]) => isPhpIniKey(k))) as Partial<Record<PhpIniKey, string>>;

/** The panel's settings for a scope, from the first part of it that has the file (they are written together). */
function panelValues(config: SystemConfig, version: string, scope: 'web' | 'cli'): Partial<Record<PhpIniKey, string>> {
  for (const sapi of sapisOf(scope).filter((s) => hasSapi(config, version, s))) {
    const file = join(config.PHP_CONF_DIR, version, sapi, 'conf.d', PANEL_INI);
    if (existsSync(file)) return managed(readIni(file));
  }
  return {};
}

/** What php.ini and the other conf.d files of a part set for the managed settings, the panel's file left out. */
function fileValues(config: SystemConfig, version: string, sapi: PhpSapi): Partial<Record<PhpIniKey, string>> {
  const dir = join(config.PHP_CONF_DIR, version, sapi);
  const confD = join(dir, 'conf.d');
  const files = [join(dir, 'php.ini'), ...(existsSync(confD) ? readdirSync(confD).filter((f) => f.endsWith('.ini') && f !== PANEL_INI).sort().map((f) => join(confD, f)) : [])];
  const out: Partial<Record<PhpIniKey, string>> = {};
  for (const file of files) Object.assign(out, managed(readIni(file)));
  return out;
}

export function readPhpSettings(config: SystemConfig, version: string): PhpSettings {
  const scopes: PhpSettings['scopes'] = [];
  for (const scope of ['web', 'cli'] as const) {
    const sapi = sapisOf(scope).find((s) => hasSapi(config, version, s));
    if (!sapi) continue;
    scopes.push({ scope, panel: panelValues(config, version, scope), files: fileValues(config, version, sapi) });
  }
  return { version, scopes };
}

/** A php.ini value the way the panel writes it: On and Off for flags, upper-case size units. */
export function normalizeIniValue(key: PhpIniKey, value: string): string {
  const kind = PHP_INI_SETTINGS[key].kind;
  if (kind === 'flag') {
    if (/^(1|on|yes|true)$/i.test(value)) return 'On';
    if (/^(0|off|no|false|none|)$/i.test(value)) return 'Off';
  }
  if (kind === 'size') return value.replace(/[kmg]$/, (u) => u.toUpperCase());
  return value.trim();
}

interface Adoption {
  /** The settings to add to the panel's file per scope. */
  values: Record<'web' | 'cli', Partial<Record<PhpIniKey, string>>>;
  /** The parts whose php.ini goes back to the packaged one. */
  reset: PhpSapi[];
}

/**
 * What adopting a version's php.ini changes means: each changed setting in
 * the panel's settings, then the packaged php.ini. Refused for a change the
 * panel cannot write: a setting it does not manage, one php.ini dropped, a
 * value it does not take, or Apache and FPM setting the same one differently.
 */
export function planAdoption(config: SystemConfig, version: string): Adoption {
  const adoption: Adoption = { values: { web: {}, cli: {} }, reset: [] };
  const problems: string[] = [];
  for (const scope of ['web', 'cli'] as const) {
    for (const sapi of sapisOf(scope)) {
      const diff = readIniDiff(config, version, sapi);
      if (!diff?.original || diff.changes.length === 0) continue;
      adoption.reset.push(sapi);
      for (const change of diff.changes) {
        if (!isPhpIniKey(change.key)) {
          problems.push(`${change.key} (${sapi}) is not a setting the panel manages`);
          continue;
        }
        if (change.current === undefined) {
          problems.push(`${change.key} (${sapi}) was taken out of php.ini`);
          continue;
        }
        const value = normalizeIniValue(change.key, change.current);
        const error = phpIniValueError(change.key, value);
        if (error) {
          problems.push(`${error} (${sapi} has ${change.current})`);
          continue;
        }
        const before = adoption.values[scope][change.key];
        if (before !== undefined && before !== value) problems.push(`${change.key} is ${before} for Apache but ${value} for FPM`);
        adoption.values[scope][change.key] = value;
      }
    }
  }
  if (problems.length > 0) throw new PhpSettingsRefused(`Some php.ini changes cannot move into the panel's settings: ${problems.join('; ')}. Change them by hand, then try again.`);
  if (adoption.reset.length === 0) throw new PhpSettingsRefused(`PHP ${version}'s php.ini files match the packaged ones: there is nothing to move.`);
  return adoption;
}

const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';

/** The steps of php.adoptIni: settings per scope first (so nothing changes for sites), then each php.ini; Undo reverses both. */
export function planAdoptIni(config: SystemConfig, exec: Executor, dmpRoot: string, version: string): JobStep[] {
  const adoption = planAdoption(config, version);
  const steps: JobStep[] = [];
  for (const scope of ['web', 'cli'] as const) {
    const adopted = adoption.values[scope];
    if (Object.keys(adopted).length === 0) continue;
    steps.push({
      id: `settings-${scope}`,
      label: `Add ${Object.keys(adopted).join(', ')} to the panel's ${scope === 'web' ? 'web' : 'command line'} settings for PHP ${version}`,
      run: async (job) => {
        const before = panelValues(config, version, scope);
        // The panel's own values win: conf.d already overrides php.ini for them.
        const r = await runRoot(exec, dmpRoot, ['php-ini', version, scope, ...pairs({ ...adopted, ...before })]);
        if (r.code === 0) job.onUndo(`Put the panel's ${scope} settings for PHP ${version} back`, () => runRoot(exec, dmpRoot, ['php-ini', version, scope, ...pairs(before)]));
        return r;
      },
    });
  }
  for (const sapi of adoption.reset) {
    steps.push({
      id: `reset-${sapi}`,
      label: `Put the packaged php.ini back for PHP ${version} (${sapi})`,
      run: async (job) => {
        const r = await runRoot(exec, dmpRoot, ['php-ini-reset', version, sapi]);
        const saved = /^saved (\S+)$/m.exec(r.stdout)?.[1];
        if (r.code === 0 && saved) job.onUndo(`Put your php.ini back for PHP ${version} (${sapi})`, () => runRoot(exec, dmpRoot, ['php-ini-put-back', version, sapi, saved]));
        return r.code === 0 ? r : { ...r, stderr: `${lastLine(r)}\n` };
      },
    });
  }
  return steps;
}

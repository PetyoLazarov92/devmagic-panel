import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PhpInfo } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { Executor } from '../exec.js';

/**
 * PHP info comes from scripts/php/info.php, installed root-owned next to
 * dmp-root in /usr/local/lib/devmagic-panel/php. The command line runs it
 * directly; the web asks the panel's own vhost on port 80, which serves it to
 * this computer only (dmp_vhost_render_panel), so the PHP that answers is the
 * one sites run. Nothing of it is kept or sent to the assistant.
 */

export class PhpInfoUnavailable extends Error {
  /** The HTTP status Apache answered with, when it answered. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 502 to 504: Apache is there but PHP-FPM did not answer, as while it starts a new pool. */
const fpmNotReady = (status: number | undefined) => status !== undefined && status >= 502 && status <= 504;

/** The prefix the panel's vhost serves the info script under: info.php for mod_php, <pool>/info.php for an FPM pool. */
export const INFO_PATH = '/.devmagic-panel-php';

export const infoScript = (dmpRoot: string) => join(dirname(dirname(dmpRoot)), 'php', 'info.php');

function parseInfo(text: string): PhpInfo {
  let data: Partial<PhpInfo>;
  try {
    data = JSON.parse(text) as Partial<PhpInfo>;
  } catch {
    throw new PhpInfoUnavailable('PHP answered in a form the panel cannot read');
  }
  if (typeof data.version !== 'string' || typeof data.ini !== 'object' || data.ini === null) throw new PhpInfoUnavailable('PHP answered in a form the panel cannot read');
  return {
    version: data.version,
    sapi: String(data.sapi ?? ''),
    ...(data.iniFile ? { iniFile: String(data.iniFile) } : {}),
    scannedFiles: Array.isArray(data.scannedFiles) ? data.scannedFiles.map(String) : [],
    ini: data.ini,
    groups: data.groups && typeof data.groups === 'object' && !Array.isArray(data.groups) ? data.groups : {},
    extensions: data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions) ? data.extensions : {},
    zendExtensions: Array.isArray(data.zendExtensions) ? data.zendExtensions.map(String) : [],
    ...(data.xdebug ? { xdebug: { version: String(data.xdebug.version), modes: Array.isArray(data.xdebug.modes) ? data.xdebug.modes.map(String) : [] } } : {}),
  };
}

function requireScript(dmpRoot: string): string {
  const script = infoScript(dmpRoot);
  if (!existsSync(script)) throw new PhpInfoUnavailable('The info script is not installed yet: run ./install.sh from the panel folder once.');
  return script;
}

/** The command line's view: php<version> runs the script, with that version's cli settings. */
export async function cliInfo(exec: Executor, dmpRoot: string, version: string): Promise<PhpInfo> {
  const script = requireScript(dmpRoot);
  const r = await exec(`php${version}`, [script], { timeoutMs: 20_000 });
  if (r.code === 127) throw new PhpInfoUnavailable(`PHP ${version} has no command line: apt install php${version}-cli`);
  if (r.code !== 0) throw new PhpInfoUnavailable(`php${version} could not run the info script: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`);
  return parseInfo(r.stdout);
}

/**
 * The web's view, from the PHP that serves `path` under INFO_PATH on the
 * panel's vhost: 'info.php' is mod_php, '<pool>/info.php' an FPM pool.
 */
export async function webInfo(exec: Executor, config: SystemConfig, dmpRoot: string, path = 'info.php'): Promise<PhpInfo> {
  requireScript(dmpRoot);
  const host = config.PANEL_DOMAIN;
  const r = await exec('curl', [
    '-sS', '--fail-with-body', '--max-time', '20', '--noproxy', '*',
    '--resolve', `${host}:80:127.0.0.1`,
    '-H', 'X-Devmagic-Panel: info',
    `http://${host}${INFO_PATH}/${path}`,
  ], { timeoutMs: 25_000 });
  if (r.code === 22) {
    const status = Number(/returned error: (\d{3})/.exec(r.stderr)?.[1]) || undefined;
    if (status === 404) throw new PhpInfoUnavailable(`Apache has no info page (404): run ./install.sh once so the panel's vhost has it.`, status);
    if (fpmNotReady(status)) throw new PhpInfoUnavailable(`PHP-FPM did not answer (${status}): Apache's error log says why.`, status);
    throw new PhpInfoUnavailable(`Apache did not serve the info page (${r.stderr.trim() || 'HTTP error'}).`, status);
  }
  if (r.code !== 0) throw new PhpInfoUnavailable(`Apache could not be asked: ${r.stderr.trim() || `curl exited with ${r.code}`}`);
  return parseInfo(r.stdout);
}

/**
 * webInfo right after a pool was written: PHP-FPM creates a new pool's socket
 * a moment after its reload returns, so a 502 to 504 is asked again a few times.
 */
export async function webInfoSettled(exec: Executor, config: SystemConfig, dmpRoot: string, path: string, { tries = 8, delayMs = 750 } = {}): Promise<PhpInfo> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await webInfo(exec, config, dmpRoot, path);
    } catch (error) {
      if (!(error instanceof PhpInfoUnavailable) || !fpmNotReady(error.status) || attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

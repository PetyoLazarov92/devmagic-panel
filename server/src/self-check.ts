import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CheckResult } from '@devmagic-panel/shared';
import { parseInstalledFiles } from './developer.js';
import { readRelease } from './update.js';

type Check = Omit<CheckResult, 'group'>;

/** Where the panel's own installation lives, for the checks that it is whole and current. */
export interface SelfCheckContext {
  /** The folder the panel runs from: a release in releases/<name>, or a checkout. */
  repo: string;
  /** The version the running server started with. */
  version: string;
  /** The folder of install.sh's list of installed files (STATE_DIR). */
  stateDir: string;
  /** The installed dmp-root; its folder's parent holds bin/ and lib/. */
  dmpRoot: string;
}

const short = (names: string[]) => (names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', '));

/** What puts the installation right: the running release's installer through current, or ./install.sh in a checkout. */
export function installCommand(repo: string): string {
  return readRelease(repo) ? join(dirname(dirname(repo)), 'current', 'install.sh') : join(repo, 'install.sh');
}

/** Every file, folder and link install.sh listed to remove on uninstall is still there. */
function installedFilesCheck(ctx: SelfCheckContext): Check {
  const list = join(ctx.stateDir, 'installed-files');
  const label = 'Installed files are all there';
  if (!existsSync(list)) return { id: 'panel.files', label, status: 'warn', detail: `no list of installed files yet: run ${installCommand(ctx.repo)} to write it` };
  const missing = parseInstalledFiles(readFileSync(list, 'utf8'))
    .filter((p) => (p.kind === 'file' || p.kind === 'dir' || p.kind === 'link') && p.onUninstall === 'remove' && p.path.startsWith('/'))
    .filter((p) => {
      try {
        statSync(p.path);
        return false;
      } catch {
        return true;
      }
    })
    .map((p) => p.path);
  return missing.length === 0
    ? { id: 'panel.files', label, status: 'ok', detail: 'everything install.sh put on this machine is in place' }
    : { id: 'panel.files', label, status: 'fail', detail: `missing: ${short(missing)}. Run ${installCommand(ctx.repo)} to put them back` };
}

/** The root-owned copies of dmp-root, its libraries, wpcore and the PHP info script are the ones in the panel's code. */
function rootScriptsCheck(ctx: SelfCheckContext): Check {
  const label = "Root scripts match the panel's code";
  const prefix = dirname(dirname(ctx.dmpRoot));
  const scripts = join(ctx.repo, 'scripts');
  if (!existsSync(scripts)) return { id: 'panel.scripts', label, status: 'warn', detail: `no scripts folder in ${ctx.repo}` };
  const pairs: Array<[string, string]> = [
    ...['dmp-root', 'dmp-restore', 'wpcore'].map((name): [string, string] => [join(scripts, 'bin', name), join(prefix, 'bin', name)]),
    ...readdirSync(join(scripts, 'lib'))
      .filter((name) => name.endsWith('.sh'))
      .map((name): [string, string] => [join(scripts, 'lib', name), join(prefix, 'lib', name)]),
    ...(existsSync(join(scripts, 'php')) ? readdirSync(join(scripts, 'php')) : [])
      .filter((name) => name.endsWith('.php'))
      .map((name): [string, string] => [join(scripts, 'php', name), join(prefix, 'php', name)]),
  ];
  const differ = pairs
    .filter(([ours, installed]) => {
      try {
        return !readFileSync(ours).equals(readFileSync(installed));
      } catch {
        return true;
      }
    })
    .map(([ours]) => ours.slice(scripts.length + 1));
  return differ.length === 0
    ? { id: 'panel.scripts', label, status: 'ok', detail: `the copies in ${prefix} are current` }
    : { id: 'panel.scripts', label, status: 'warn', detail: `${short(differ)} changed since the last install: run ${installCommand(ctx.repo)} so dmp-root runs the new code` };
}

/** The newest change time under a folder, skipping dependencies and builds. */
function newest(dir: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

/** The build is newer than the code, and the running server is the version the code says. A release comes built. */
function buildCheck(ctx: SelfCheckContext): Check {
  const label = 'The running build is current';
  const release = readRelease(ctx.repo);
  if (release) {
    return release.version === ctx.version
      ? { id: 'panel.build', label, status: 'ok', detail: `release ${release.name}${release.built ? `, built ${new Date(release.built).toLocaleString('en-GB')}` : ''}` }
      : { id: 'panel.build', label, status: 'warn', detail: `running v${ctx.version}, the release is v${release.version}: restart the panel` };
  }
  const built = [join(ctx.repo, 'server', 'dist', 'index.js'), join(ctx.repo, 'web', 'dist', 'index.html')];
  if (!built.every(existsSync)) return { id: 'panel.build', label, status: 'warn', detail: 'no build yet: run npm run build, or ./install.sh' };
  const builtAt = Math.min(...built.map((f) => statSync(f).mtimeMs));
  const changed = ['shared', 'server', 'web']
    .map((part) => join(ctx.repo, part, 'src'))
    .some((dir) => newest(dir) > builtAt);
  let checkout = ctx.version;
  try {
    checkout = (JSON.parse(readFileSync(join(ctx.repo, 'package.json'), 'utf8')) as { version?: string }).version ?? ctx.version;
  } catch {
    // no package.json to compare with
  }
  if (checkout !== ctx.version) {
    return { id: 'panel.build', label, status: 'warn', detail: `running v${ctx.version}, the code is v${checkout}: run ./install.sh to build and restart` };
  }
  return changed
    ? { id: 'panel.build', label, status: 'warn', detail: 'the code changed after the last build: run ./install.sh (or npm run build and restart the service)' }
    : { id: 'panel.build', label, status: 'ok', detail: `v${ctx.version}, built ${new Date(builtAt).toLocaleString('en-GB')}` };
}

/** The panel checks its own installation: files in place, root scripts current, build current. */
export function selfChecks(ctx: SelfCheckContext): Check[] {
  return [installedFilesCheck(ctx), rootScriptsCheck(ctx), buildCheck(ctx)];
}

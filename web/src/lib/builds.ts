import type { BuildTool, RepoBuild } from '@devmagic-panel/shared';

/** A build row by tool and folder. */
export const buildId = (build: { tool: BuildTool; dir: string }) => `${build.tool}:${build.dir}`;

/** Your choice for a build row; unset rows follow the lookup and the docs. */
export interface BuildPick {
  on: boolean;
  script?: string;
  /** The Node from nvm you put it on; unset, the panel picks. */
  node?: string;
}

/** A command from the docs, like "npm run prod" in wp-content/themes/wandworks. */
export interface DocsCommand {
  folder: string;
  command: string;
}

const folderOf = (value: string) => value.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');

/** The script the docs run in this build's folder, when it is one the package.json has; composer install counts for Composer. */
export function docsScript(build: RepoBuild, commands: DocsCommand[]): string | true | undefined {
  for (const c of commands) {
    if (folderOf(c.folder) !== build.dir) continue;
    if (build.tool === 'composer' && /\bcomposer\s+install\b/.test(c.command)) return true;
    const m = /\b(npm|yarn|pnpm)\s+(?:run\s+)?([A-Za-z0-9][A-Za-z0-9:._-]*)/.exec(c.command);
    if (m && build.tool !== 'composer' && build.scripts.includes(m[2] as string)) return m[2] as string;
  }
  return undefined;
}

/**
 * Whether a build runs and with which script: your pick, else what the docs
 * say, else the lookup. The docs tick a build only when what it makes is not
 * in the repo: rebuilding committed files takes minutes and can change them.
 */
export function buildChoice(build: RepoBuild, picks: Record<string, BuildPick>, commands: DocsCommand[]): BuildPick & { fromDocs: boolean } {
  // A script that runs a gulp task the gulpfile lacks fails at once: a pick remembered from an earlier install, or the docs, naming one is let go.
  const broken = (script: string | undefined) => Boolean(script && build.missingTasks?.[script]);
  const remembered = picks[buildId(build)];
  const pick = broken(remembered?.script) ? undefined : remembered;
  const named = docsScript(build, commands);
  const docs = typeof named === 'string' && broken(named) ? undefined : named;
  const script = pick?.script ?? (typeof docs === 'string' ? docs : build.script);
  const on = pick?.on ?? (docs !== undefined && !build.builtInRepo ? true : build.needed);
  return { on, ...(script ? { script } : {}), ...(pick?.node ? { node: pick.node } : {}), fromDocs: docs !== undefined && !pick };
}

/** The builds the install runs, in the lookup's order; an npm-like one without a script only installs. repo: which repo of the install they are in. */
export function buildSteps(builds: RepoBuild[], picks: Record<string, BuildPick>, commands: DocsCommand[], repo = 0): Array<{ repo: number; dir: string; tool: BuildTool; script?: string; node?: string }> {
  return builds.flatMap((build) => {
    const choice = buildChoice(build, picks, commands);
    if (!choice.on) return [];
    return [{ repo, dir: build.dir, tool: build.tool, ...(build.tool !== 'composer' && choice.script ? { script: choice.script } : {}), ...(build.tool !== 'composer' && choice.node ? { node: choice.node } : {}) }];
  });
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';

/**
 * The Node a build runs with. The panel's service has the plain system PATH,
 * so a Node installed with nvm (often the only npm there is) is not on it.
 * In order: the version the repo asks for in .nvmrc or .node-version, nvm's
 * default, the Node the panel runs on (it brings npm), then whatever PATH has.
 */
export interface NodeChoice {
  /** The folder with node, npm and npx, put first in the build's PATH; null leaves PATH as it is. */
  bin: string | null;
  /** How it was picked, for the job's output: "Node 20.18.0 from nvm (.nvmrc asks for 20)". */
  note: string;
}

export interface NodeOptions {
  /** Where nvm lives: ~/.nvm. */
  home?: string;
  /** The node running the panel. */
  panelNode?: string;
}

/** LTS lines by codename, for an .nvmrc like lts/iron. */
const LTS: Record<string, number> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/** nvm's installed versions, newest first, like v22.23.3. */
function nvmVersions(nvm: string): string[] {
  try {
    return readdirSync(join(nvm, 'versions', 'node'))
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && existsSync(join(nvm, 'versions', 'node', v, 'bin', 'node')))
      .sort(newer);
  } catch {
    return [];
  }
}

/** The newest installed version a wish like 20, v20.11, lts/*, lts/iron or node fits; undefined when none does. */
export function matchVersion(wish: string, installed: string[]): string | undefined {
  const w = wish.trim().toLowerCase();
  if (w === 'node' || w === 'stable' || w === 'latest' || w === 'current') return installed[0];
  if (w === 'lts/*' || w === 'lts') return installed.find((v) => (parse(v)[0] ?? 1) % 2 === 0);
  const lts = /^lts\/(.+)$/.exec(w);
  if (lts) {
    const major = LTS[lts[1] as string];
    return major === undefined ? undefined : installed.find((v) => parse(v)[0] === major);
  }
  const want = /^v?(\d+(?:\.\d+){0,2})$/.exec(w)?.[1]?.split('.').map(Number);
  if (!want) return undefined;
  return installed.find((v) => want.every((n, i) => parse(v)[i] === n));
}

/** The first .nvmrc or .node-version from the build folder up to the clone, and what it asks for. */
function repoWish(folder: string, clone: string): { file: string; wish: string } | null {
  let dir = folder;
  for (;;) {
    for (const name of ['.nvmrc', '.node-version']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const wish = readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).find(Boolean);
      if (wish) return { file: relative(clone, file) || name, wish };
    }
    if (dir === clone || relative(clone, dir).split(sep)[0] === '..' || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/** nvm's default alias, following one alias to another, like default -> lts/iron. */
function nvmDefault(nvm: string): string | undefined {
  let name = 'default';
  for (let hop = 0; hop < 3; hop++) {
    try {
      const value = readFileSync(join(nvm, 'alias', name), 'utf8').trim();
      if (!existsSync(join(nvm, 'alias', value))) return value;
      name = value;
    } catch {
      return hop === 0 ? undefined : name;
    }
  }
  return undefined;
}

/**
 * The Node for a build in `folder` of a clone. Fails only when the repo asks
 * for a version that nvm, which is there, does not have.
 */
export function nodeFor(folder: string | null, clone: string | null, options: NodeOptions = {}): NodeChoice | { error: string } {
  const nvm = join(options.home ?? homedir(), '.nvm');
  const installed = nvmVersions(nvm);
  const bin = (v: string) => join(nvm, 'versions', 'node', v, 'bin');
  const repo = folder && clone ? repoWish(folder, clone) : null;
  if (repo) {
    const v = matchVersion(repo.wish, installed);
    if (v) return { bin: bin(v), note: `Node ${v.slice(1)} from nvm (${repo.file} asks for ${repo.wish})` };
    if (installed.length > 0) return { error: `the repo asks for Node ${repo.wish} (${repo.file}), which nvm does not have: run nvm install ${repo.wish} in a terminal, then Retry` };
  }
  const asked = repo ? `; ${repo.file} asks for ${repo.wish}, and nvm is not installed` : '';
  const fallback = nvmDefault(nvm);
  const fromDefault = fallback ? matchVersion(fallback, installed) : undefined;
  const v = fromDefault ?? installed[0];
  if (v) return { bin: bin(v), note: `Node ${v.slice(1)} from nvm (${fromDefault ? `its default, ${fallback}` : 'the newest it has'})${asked}` };
  const panelNode = options.panelNode ?? process.execPath;
  const own = dirname(panelNode);
  if (existsSync(join(own, 'npm'))) return { bin: own, note: `Node ${process.versions.node}, the one the panel runs on${asked}` };
  return { bin: null, note: `the Node on the system PATH${asked}` };
}

/**
 * The environment for a build with that Node: its folder first in PATH, and
 * no NODE_ENV. The panel's service runs with NODE_ENV=production, which makes
 * npm, yarn and pnpm leave out the devDependencies a build needs (vite,
 * webpack, sass); a build in a terminal has none either.
 */
export function nodeEnv(choice: NodeChoice, path = process.env.PATH ?? ''): Record<string, string | undefined> {
  return { NODE_ENV: undefined, ...(choice.bin ? { PATH: [choice.bin, ...path.split(delimiter).filter((p) => p && p !== choice.bin)].join(delimiter) } : {}) };
}

/** Whether a Node after `major` could meet one alternative of an engines range, like >=0.10.0 <7 or ^20.19.0. */
function newerFits(range: string, major: number): boolean {
  const first = (re: RegExp) => Number(re.exec(range)?.[1]);
  if (/<=/.test(range)) return first(/<=\s*v?(\d+)/) >= major;
  if (/</.test(range)) return first(/<\s*v?(\d+)/) > major;
  if (/\s-\s/.test(range)) return first(/\s-\s*v?(\d+)/) >= major;
  if (/>/.test(range)) return true;
  const majors = [...range.matchAll(/(?:^|[^\d.])(\d+)/g)].map((v) => Number(v[1]));
  return majors.length === 0 || Math.max(...majors) >= major;
}

/**
 * What to do when npm warned that a package needs a newer Node than the one in
 * use (EBADENGINE), like vite 7 on Node 20.18; undefined when it did not. A
 * package that only fits older Nodes (^14 || ^18, or >=0.10.0 <7, on 22) is no
 * reason: npm only warns, and a newer Node would not help.
 */
export function engineHint(output: string): string | undefined {
  for (const m of output.matchAll(/required: \{ node: '([^']+)' \},?\s*npm warn EBADENGINE\s+current: \{ node: 'v(\d+)([^']*)'/g)) {
    const [, range = '', major = '', rest = ''] = m;
    if (!range.split('||').some((r) => newerFits(r.trim(), Number(major)))) continue;
    return `a package needs Node ${range} and this build ran on ${major}${rest}: run nvm install ${major} in a terminal for the newest Node ${major} (or set a newer one in .nvmrc), then Retry`;
  }
  return undefined;
}

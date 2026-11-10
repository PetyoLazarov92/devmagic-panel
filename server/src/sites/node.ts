import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';

/**
 * The Node a build runs with. The panel's service has the plain system PATH,
 * so a Node installed with nvm (often the only npm there is) is not on it.
 * In order: the version picked for the build in the wizard, the one the repo
 * asks for in .nvmrc or .node-version, what its package.json says (volta,
 * engines, or a package known to stop on newer Nodes, like node-sass), nvm's
 * default, the Node the panel runs on (it brings npm), then whatever PATH has.
 */
export interface NodeChoice {
  /** The folder with node, npm and npx, put first in the build's PATH; null leaves PATH as it is. */
  bin: string | null;
  /** How it was picked, for the job's output: "Node 20.18.0 from nvm (.nvmrc asks for 20)". */
  note: string;
  /** The nvm version it is, like v20.18.0. */
  version?: string;
  /** You or the repo's .nvmrc named it: a failed build is not tried on another. */
  pinned?: true;
}

export interface NodeOptions {
  /** The version picked for this build in the wizard, like 16.20.2. */
  pick?: string;
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

/** One comparator of a range against a version: >=14, <7, ^20.19.0, ~14.1, 16.x, 18. One it cannot read fits. */
function fitsComparator(v: number[], c: string): boolean {
  const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?/i.exec(c);
  if (!m) return true;
  const op = m[1] ?? '=';
  const given = [m[2], m[3], m[4]].filter((n): n is string => n !== undefined && /^\d+$/.test(n)).map(Number);
  if (given.length === 0) return true;
  const full = [given[0] ?? 0, given[1] ?? 0, given[2] ?? 0];
  const cmp = (a: number[], b: number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
  /** The first version after everything the partial one covers: 16 gives 17.0.0, 16.1 gives 16.2.0. */
  const after = given.length === 1 ? [(full[0] as number) + 1, 0, 0] : [full[0] as number, (full[1] as number) + 1, 0];
  const partial = given.length < 3;
  if (op === '>=') return cmp(v, full) >= 0;
  if (op === '>') return partial ? cmp(v, after) >= 0 : cmp(v, full) > 0;
  if (op === '<') return cmp(v, full) < 0;
  if (op === '<=') return partial ? cmp(v, after) < 0 : cmp(v, full) <= 0;
  if (op === '^') return cmp(v, full) >= 0 && v[0] === full[0];
  if (op === '~') return cmp(v, full) >= 0 && cmp(v, after) < 0;
  return given.every((n, i) => v[i] === n);
}

/** Whether a version like v16.20.2 meets an engines range like ^12 || ^14 || ^16, >=14 <17 or 14 - 16. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split('||').some((alt) => {
    const text = alt.trim().replace(/(>=|<=|>|<|\^|~|=)\s+/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : text.split(/\s+/).filter(Boolean);
    return parts.every((c) => fitsComparator(v, c));
  });
}

/** What a package.json says about the Node it needs, the surest first. */
interface NodeNeed {
  range: string;
  why: string;
  /** The Node to install when nvm has none that fits. */
  install: string;
}

/** The newest Node each node-sass line has a ready build for; 7 is kept at 16, the one that is sure. */
const NODE_SASS: Record<number, number> = { 3: 8, 4: 14, 5: 15, 6: 16, 7: 16, 8: 18, 9: 20 };

/**
 * What a package.json asks of Node: a package that stops on newer Nodes
 * (node-sass has ready builds up to one Node only, and cannot compile itself
 * after it; gulp 3 ends at Node 11), then volta's exact version, then engines.
 */
export function projectNeeds(manifest: string | undefined): NodeNeed[] {
  let pkg: { engines?: { node?: unknown }; volta?: { node?: unknown }; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(manifest ?? '') as typeof pkg;
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];
  const needs: NodeNeed[] = [];
  const dep = (name: string) => {
    const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    const major = typeof range === 'string' ? /(\d+)/.exec(range)?.[1] : undefined;
    return major === undefined ? undefined : Number(major);
  };
  const sass = dep('node-sass');
  const sassNode = sass === undefined ? undefined : NODE_SASS[sass];
  if (sass !== undefined && sassNode) needs.push({ range: `<=${sassNode}`, why: `node-sass ${sass} runs on Node ${sassNode} at most`, install: String(sassNode) });
  if (dep('gulp') === 3) needs.push({ range: '<=11', why: 'gulp 3 runs on Node 11 at most', install: '10' });
  const volta = pkg.volta?.node;
  if (typeof volta === 'string' && /^\d+(\.\d+){0,2}$/.test(volta)) needs.push({ range: volta, why: `package.json's volta asks for ${volta}`, install: volta });
  const engines = pkg.engines?.node;
  if (typeof engines === 'string' && engines.trim() && engines.length < 200) needs.push({ range: engines.trim(), why: `package.json asks for Node ${engines.trim()}`, install: /(\d+)/.exec(engines)?.[1] ?? '' });
  return needs;
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

/** What the repo's files say about Node, wherever they are read from: the disk, or the lookup's blobs. */
interface NodeSource {
  wish: { file: string; wish: string } | null;
  manifest: string | undefined;
}

function choose(source: NodeSource | null, options: NodeOptions): NodeChoice | { error: string } {
  const nvm = join(options.home ?? homedir(), '.nvm');
  const installed = nvmVersions(nvm);
  const bin = (v: string) => join(nvm, 'versions', 'node', v, 'bin');
  if (options.pick) {
    const v = matchVersion(options.pick, installed);
    if (v) return { bin: bin(v), version: v, pinned: true, note: `Node ${v.slice(1)} from nvm (picked for this build)` };
    return { error: `Node ${options.pick}, picked for this build, is not in nvm: run nvm install ${options.pick} in a terminal, then Retry` };
  }
  const repo = source?.wish ?? null;
  if (repo) {
    const v = matchVersion(repo.wish, installed);
    if (v) return { bin: bin(v), version: v, pinned: true, note: `Node ${v.slice(1)} from nvm (${repo.file} asks for ${repo.wish})` };
    if (installed.length > 0) return { error: `the repo asks for Node ${repo.wish} (${repo.file}), which nvm does not have: run nvm install ${repo.wish} in a terminal, then Retry` };
  }
  const asked = repo ? `; ${repo.file} asks for ${repo.wish}, and nvm is not installed` : '';
  const fallback = nvmDefault(nvm);
  const fromDefault = fallback ? matchVersion(fallback, installed) : undefined;
  // What package.json says: nvm's default when it fits, else the newest that does.
  const needs = installed.length > 0 ? projectNeeds(source?.manifest) : [];
  let missing = '';
  if (needs.length > 0) {
    const first = needs[0] as NodeNeed;
    const all = installed.filter((v) => needs.every((n) => satisfies(v, n.range)));
    const fits = all.length > 0 ? all : installed.filter((v) => satisfies(v, first.range));
    const v = fromDefault && fits.includes(fromDefault) ? fromDefault : fits[0];
    if (v) return { bin: bin(v), version: v, note: `Node ${v.slice(1)} from nvm (${first.why})` };
    missing = `; ${first.why}, and nvm has no such Node${first.install ? `: run nvm install ${first.install} in a terminal` : ''}`;
  }
  const v = fromDefault ?? installed[0];
  if (v) return { bin: bin(v), version: v, note: `Node ${v.slice(1)} from nvm (${fromDefault ? `its default, ${fallback}` : 'the newest it has'})${asked}${missing}` };
  const panelNode = options.panelNode ?? process.execPath;
  const own = dirname(panelNode);
  if (existsSync(join(own, 'npm'))) return { bin: own, note: `Node ${process.versions.node}, the one the panel runs on${asked}` };
  return { bin: null, note: `the Node on the system PATH${asked}` };
}

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * The Node for a build in `folder` of a clone. Fails only when the build's
 * pick or the repo's .nvmrc names a version that nvm, which is there, does
 * not have.
 */
export function nodeFor(folder: string | null, clone: string | null, options: NodeOptions = {}): NodeChoice | { error: string } {
  return choose(folder && clone ? { wish: repoWish(folder, clone), manifest: readText(join(folder, 'package.json')) } : null, options);
}

/** The same for a build the repo lookup found, from the files it read: dir is the build's folder in the repo. */
export function nodeForFiles(dir: string, text: ReadonlyMap<string, string>, options: NodeOptions = {}): NodeChoice | { error: string } {
  const inDir = (d: string, name: string) => (d ? `${d}/${name}` : name);
  let wish: NodeSource['wish'] = null;
  for (let d = dir; wish === null; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    for (const name of ['.nvmrc', '.node-version']) {
      const line = text.get(inDir(d, name))?.split('\n').map((l) => l.replace(/#.*/, '').trim()).find(Boolean);
      if (line && !wish) wish = { file: inDir(d, name), wish: line };
    }
    if (d === '') break;
  }
  return choose({ wish, manifest: text.get(inDir(dir, 'package.json')) }, options);
}

/** The Nodes nvm has, newest first, without the v: what a build can be put on. */
export function installedNodes(options: NodeOptions = {}): string[] {
  return nvmVersions(join(options.home ?? homedir(), '.nvm')).map((v) => v.slice(1));
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

/** npm's warning that a package needs a newer Node than the one in use: its range and that Node. */
function tooOld(output: string): { range: string; major: string; rest: string } | undefined {
  for (const m of output.matchAll(/required: \{ node: '([^']+)' \},?\s*npm warn EBADENGINE\s+current: \{ node: 'v(\d+)([^']*)'/g)) {
    const [, range = '', major = '', rest = ''] = m;
    if (range.split('||').some((r) => newerFits(r.trim(), Number(major)))) return { range, major, rest };
  }
  return undefined;
}

/**
 * What to do when npm warned that a package needs a newer Node than the one in
 * use (EBADENGINE), like vite 7 on Node 20.18; undefined when it did not. A
 * package that only fits older Nodes (^14 || ^18, or >=0.10.0 <7, on 22) is no
 * reason: npm only warns, and a newer Node would not help.
 */
export function engineHint(output: string): string | undefined {
  const old = tooOld(output);
  if (old) return `a package needs Node ${old.range} and this build ran on ${old.major}${old.rest}: run nvm install ${old.major} in a terminal for the newest Node ${old.major} (or set a newer one in .nvmrc), then Retry`;
  return nativeHint(output);
}

/** A package with compiled code that had no ready build for this Node and could not compile itself: its name and that Node. */
function native(output: string): { pkg: string; node: string | undefined } | undefined {
  if (!/gyp ERR!/.test(output)) return undefined;
  return { pkg: /gyp ERR! cwd \S*\/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/.exec(output)?.[1] ?? 'a package', node: /gyp ERR! node -v v(\d+)/.exec(output)?.[1] };
}

/**
 * What to do when a package with compiled code (node-sass, most often) had no
 * ready build for this Node and could not compile itself: the repo was made
 * for an older Node and says so nowhere, and no newer Node will help.
 */
function nativeHint(output: string): string | undefined {
  const n = native(output);
  if (!n) return undefined;
  const on = n.node ? ` on Node ${n.node}` : '';
  const older = n.pkg === 'node-sass' ? 'node-sass 7 and older run on Node 16' : 'an older Node, the one the repo was made for, has one';
  return `${n.pkg} has no ready build${on} and could not compile itself: ${older}. Put that version in the repo's .nvmrc, run nvm install for it in a terminal, then Retry`;
}

/** The Node ranges the packages of a package-lock.json ask for (lock file version 2 and 3 keep them). */
function lockRanges(folder: string): string[] {
  try {
    const lock = JSON.parse(readFileSync(join(folder, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { engines?: { node?: unknown } }> };
    return Object.values(lock.packages ?? {}).flatMap((p) => (typeof p?.engines?.node === 'string' && p.engines.node.length < 200 ? [p.engines.node] : []));
  } catch {
    return [];
  }
}

/**
 * Another Node to run a failed build on, once: when nothing named the first
 * one (no pick, no .nvmrc) and the failure points at the Node itself. A
 * package that could not compile gets the older Node nvm has that the lock
 * file's packages fit best; a package that needs a newer Node gets the newest
 * one that meets its range. Undefined when nvm has no such Node.
 */
export function secondNode(output: string, first: NodeChoice, folder: string, options: NodeOptions = {}): (NodeChoice & { cause: string }) | undefined {
  if (!first.version || first.pinned) return undefined;
  const nvm = join(options.home ?? homedir(), '.nvm');
  const installed = nvmVersions(nvm);
  const choice = (v: string, why: string, cause: string) => ({ bin: join(nvm, 'versions', 'node', v, 'bin'), version: v, note: `Node ${v.slice(1)} from nvm (${why})`, cause });
  const old = tooOld(output);
  if (old) {
    const v = installed.find((i) => satisfies(i, old.range) && newer(i, first.version as string) < 0);
    return v ? choice(v, `a package needs Node ${old.range}`, `a package needs Node ${old.range}`) : undefined;
  }
  const n = native(output);
  if (!n) return undefined;
  const older = installed.filter((v) => (parse(v)[0] ?? 0) < (parse(first.version as string)[0] ?? 0));
  if (older.length === 0) return undefined;
  const ranges = lockRanges(folder);
  const unmet = (v: string) => ranges.filter((r) => !satisfies(v, r)).length;
  // Newest first already: the sort keeps that order among equals.
  const v = [...older].sort((a, b) => unmet(a) - unmet(b))[0] as string;
  const cause = `${n.pkg} has no ready build on Node ${(first.version as string).slice(1)} and could not compile itself`;
  return choice(v, ranges.length ? "the older Node the lock file's packages fit best" : 'the next older Node nvm has', cause);
}

/** Removes a build folder's node_modules before a second try, unless it is a link. */
export function clearModules(folder: string): void {
  const modules = join(folder, 'node_modules');
  try {
    if (!lstatSync(modules).isSymbolicLink()) rmSync(modules, { recursive: true, force: true });
  } catch {
    // Not there.
  }
}

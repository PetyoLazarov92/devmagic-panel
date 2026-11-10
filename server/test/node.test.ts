import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/sites/create.js';
import { engineHint, matchVersion, nodeEnv, nodeFor, nodeForFiles, projectNeeds, satisfies } from '../src/sites/node.js';
import { fakeExec } from './helpers.js';

/** A home folder with nvm and the given Node versions, and a clone with a theme. */
function machine(versions: string[], alias?: string) {
  const home = mkdtempSync(join(tmpdir(), 'dmp-node-'));
  for (const v of versions) {
    mkdirSync(join(home, '.nvm/versions/node', v, 'bin'), { recursive: true });
    writeFileSync(join(home, '.nvm/versions/node', v, 'bin/node'), '');
  }
  if (alias) {
    mkdirSync(join(home, '.nvm/alias'), { recursive: true });
    writeFileSync(join(home, '.nvm/alias/default'), `${alias}\n`);
  }
  const clone = join(home, 'clone');
  const theme = join(clone, 'wp-content/themes/wandworks');
  mkdirSync(theme, { recursive: true });
  writeFileSync(join(theme, 'package.json'), JSON.stringify({ scripts: { build: 'webpack' } }));
  // A panel node with no npm next to it, so the last fallback is plain PATH.
  const panelNode = join(home, 'panel-node', 'node');
  return { home, clone, theme, panelNode, bin: (v: string) => join(home, '.nvm/versions/node', v, 'bin') };
}

const installed = ['v24.22.0', 'v22.23.3', 'v20.18.0', 'v18.20.4'];

describe('matchVersion', () => {
  it('reads the usual .nvmrc wishes against the installed versions, newest first', () => {
    expect(matchVersion('20', installed)).toBe('v20.18.0');
    expect(matchVersion('v18.20', installed)).toBe('v18.20.4');
    expect(matchVersion('22.23.3', installed)).toBe('v22.23.3');
    expect(matchVersion('lts/*', ['v25.1.0', ...installed])).toBe('v24.22.0');
    expect(matchVersion('lts/iron', installed)).toBe('v20.18.0');
    expect(matchVersion('node', installed)).toBe('v24.22.0');
    expect(matchVersion('16', installed)).toBeUndefined();
    expect(matchVersion('lts/nope', installed)).toBeUndefined();
  });
});

describe('nodeFor', () => {
  it('takes the version an .nvmrc up the folders asks for', () => {
    const m = machine(installed, 'node');
    writeFileSync(join(m.clone, '.nvmrc'), 'v20 # the theme still needs webpack 4\n');
    const choice = nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode });
    expect(choice).toMatchObject({ bin: m.bin('v20.18.0'), note: 'Node 20.18.0 from nvm (.nvmrc asks for v20)' });
  });

  it('prefers the build folder over the clone, and reads .node-version too', () => {
    const m = machine(installed);
    writeFileSync(join(m.clone, '.nvmrc'), '22');
    writeFileSync(join(m.theme, '.node-version'), '18');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toMatchObject({ bin: m.bin('v18.20.4') });
  });

  it('fails with the nvm command when the repo asks for a version nvm does not have', () => {
    const m = machine(installed);
    writeFileSync(join(m.clone, '.nvmrc'), '16');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toEqual({
      error: 'the repo asks for Node 16 (.nvmrc), which nvm does not have: run nvm install 16 in a terminal, then Retry',
    });
  });

  it('without an .nvmrc takes nvm\'s default, following its aliases, else the newest', () => {
    const m = machine(installed, 'lts/iron');
    mkdirSync(join(m.home, '.nvm/alias/lts'), { recursive: true });
    writeFileSync(join(m.home, '.nvm/alias/lts/iron'), 'v20.18.0\n');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toMatchObject({ bin: m.bin('v20.18.0'), note: 'Node 20.18.0 from nvm (its default, v20.18.0)' });
    const bare = machine(installed);
    expect(nodeFor(null, null, { home: bare.home, panelNode: bare.panelNode })).toMatchObject({ bin: bare.bin('v24.22.0'), note: 'Node 24.22.0 from nvm (the newest it has)' });
  });

  it('without nvm uses the Node the panel runs on when npm is next to it, then plain PATH', () => {
    const m = machine([]);
    writeFileSync(join(m.clone, '.nvmrc'), '20');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toMatchObject({ bin: null, note: 'the Node on the system PATH; .nvmrc asks for 20, and nvm is not installed' });
    mkdirSync(join(m.home, 'panel-node'), { recursive: true });
    writeFileSync(join(m.home, 'panel-node', 'npm'), '');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toMatchObject({ bin: join(m.home, 'panel-node') });
  });

  it('puts the chosen folder first in PATH, once, and leaves out the service NODE_ENV', () => {
    expect(nodeEnv({ bin: '/home/alex/.nvm/versions/node/v20.18.0/bin', note: '' }, '/usr/bin:/home/alex/.nvm/versions/node/v20.18.0/bin:/bin')).toEqual({
      NODE_ENV: undefined,
      PATH: '/home/alex/.nvm/versions/node/v20.18.0/bin:/usr/bin:/bin',
    });
    expect(nodeEnv({ bin: null, note: '' })).toEqual({ NODE_ENV: undefined });
  });
});

describe('a build with nvm', () => {
  it('runs npm with that Node first in PATH and says which Node it used', async () => {
    const m = machine(installed);
    writeFileSync(join(m.theme, '.nvmrc'), '20');
    const fake = fakeExec({ npm: { stdout: 'ok' } });
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results[0]?.stdout).toContain('wp-content/themes/wandworks: Node 20.18.0 from nvm (wp-content/themes/wandworks/.nvmrc asks for 20)');
    expect(fake.calls.map((c) => [c.file, c.args[0], c.env?.PATH?.split(':')[0]])).toEqual([
      ['npm', 'install', m.bin('v20.18.0')],
      ['npm', 'run', m.bin('v20.18.0')],
    ]);
    // NODE_ENV=production from the service would make npm skip the devDependencies the build needs.
    expect(fake.calls.every((c) => c.env && 'NODE_ENV' in c.env && c.env.NODE_ENV === undefined)).toBe(true);
  });

  it('says how to get a newer Node when the build fails after npm warned this one is too old', async () => {
    const m = machine(installed);
    writeFileSync(join(m.theme, '.nvmrc'), '20');
    const warning = [
      'npm warn EBADENGINE Unsupported engine {',
      "npm warn EBADENGINE   package: 'vite@7.3.3',",
      "npm warn EBADENGINE   required: { node: '^20.19.0 || >=22.12.0' },",
      "npm warn EBADENGINE   current: { node: 'v20.18.0', npm: '10.8.2' }",
      'npm warn EBADENGINE }',
    ].join('\n');
    const fake = fakeExec({ 'npm install': { stderr: warning }, 'npm run': { code: 1, stderr: 'vite failed' } });
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results.at(-1)?.stderr).toBe(
      'vite failed\nwp-content/themes/wandworks: a package needs Node ^20.19.0 || >=22.12.0 and this build ran on 20.18.0: run nvm install 20 in a terminal for the newest Node 20 (or set a newer one in .nvmrc), then Retry',
    );
    expect(engineHint('added 30 packages in 2s')).toBeUndefined();
    // A package with compiled code that has no build for this Node: an older Node, not a newer one.
    const gyp = ["npm error ModuleNotFoundError: No module named 'distutils'", 'npm error gyp ERR! configure error', `npm error gyp ERR! cwd ${m.clone}/wp-content/themes/wandworks/node_modules/node-sass`, 'npm error gyp ERR! node -v v22.23.4', 'npm error gyp ERR! not ok'].join('\n');
    expect(engineHint(gyp)).toBe("node-sass has no ready build on Node 22 and could not compile itself: node-sass 7 and older run on Node 16. Put that version in the repo's .nvmrc, run nvm install for it in a terminal, then Retry");
    expect(engineHint(gyp.replace('node-sass', 'bufferutil'))).toContain('bufferutil has no ready build on Node 22');
  });

  it('gives no Node hint for a package that only lists older Nodes', () => {
    const older = [
      'npm warn EBADENGINE Unsupported engine {',
      "npm warn EBADENGINE   package: 'eslint-plugin-wandworks@40.0.0',",
      "npm warn EBADENGINE   required: { node: '^14 || ^16 || ^17 || ^18 || ^19' },",
      "npm warn EBADENGINE   current: { node: 'v22.23.3', npm: '10.9.2' }",
      'npm warn EBADENGINE }',
    ].join('\n');
    expect(engineHint(older)).toBeUndefined();
    expect(engineHint(older.replace("'^14 || ^16 || ^17 || ^18 || ^19'", "'>=24'"))).toContain('a package needs Node >=24');
    // A range with an upper bound below this Node only fits older ones, even with a >= in it.
    expect(engineHint(older.replace("'^14 || ^16 || ^17 || ^18 || ^19'", "'>=0.10.0 <7'"))).toBeUndefined();
    expect(engineHint(older.replace("'^14 || ^16 || ^17 || ^18 || ^19'", "'>=12 <=18'"))).toBeUndefined();
    expect(engineHint(older.replace("'^14 || ^16 || ^17 || ^18 || ^19'", "'10 - 16'"))).toBeUndefined();
    expect(engineHint(older.replace("'^14 || ^16 || ^17 || ^18 || ^19'", "'>=18 <25'"))).toContain('a package needs Node >=18 <25');
  });

  it('looks past a warning for an old-only package to one that needs a newer Node', () => {
    const warn = (pkg: string, range: string) =>
      [
        'npm warn EBADENGINE Unsupported engine {',
        `npm warn EBADENGINE   package: '${pkg}',`,
        `npm warn EBADENGINE   required: { node: '${range}' },`,
        "npm warn EBADENGINE   current: { node: 'v22.23.3', npm: '10.9.2' }",
        'npm warn EBADENGINE }',
      ].join('\n');
    expect(engineHint(warn('fetch-wandworks@5.7.1', '>=0.10.0 <7'))).toBeUndefined();
    expect(engineHint(`${warn('fetch-wandworks@5.7.1', '>=0.10.0 <7')}\n${warn('build-wandworks@3.0.0', '>=24')}`)).toContain('a package needs Node >=24 and this build ran on 22.23.3');
  });

  it('stops before npm when the repo asks for a Node nvm lacks', async () => {
    const m = machine(installed);
    writeFileSync(join(m.theme, '.nvmrc'), '16');
    const fake = fakeExec();
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results).toEqual([{ code: 1, stdout: '', stderr: expect.stringContaining('run nvm install 16') }]);
    expect(fake.calls).toEqual([]);
  });
});

describe('the Node a project needs', () => {
  it('reads engines ranges the way npm does', () => {
    expect(satisfies('v16.20.2', '^12 || ^14 || ^16')).toBe(true);
    expect(satisfies('v22.23.4', '^12 || ^14 || ^16')).toBe(false);
    expect(satisfies('v20.18.0', '^20.19.0 || >=22.12.0')).toBe(false);
    expect(satisfies('v22.23.4', '^20.19.0 || >=22.12.0')).toBe(true);
    expect(satisfies('v16.20.2', '>=14 <17')).toBe(true);
    expect(satisfies('v17.0.0', '>= 14 <17')).toBe(false);
    expect(satisfies('v16.20.2', '<=16')).toBe(true);
    expect(satisfies('v16.20.2', '14 - 16')).toBe(true);
    expect(satisfies('v18.1.0', '14 - 16')).toBe(false);
    expect(satisfies('v14.21.3', '~14.21')).toBe(true);
    expect(satisfies('v14.22.0', '~14.21')).toBe(false);
    expect(satisfies('v16.20.2', '16.x')).toBe(true);
    expect(satisfies('v16.20.2', '>16')).toBe(false);
    expect(satisfies('v22.1.0', '*')).toBe(true);
  });

  it('takes node-sass, volta and engines from package.json, the surest first', () => {
    expect(projectNeeds(JSON.stringify({ devDependencies: { 'node-sass': '^7.0.1' }, engines: { node: '>=14' } })).map((n) => n.why)).toEqual(['node-sass 7 runs on Node 16 at most', 'package.json asks for Node >=14']);
    expect(projectNeeds(JSON.stringify({ volta: { node: '18.20.4' } }))[0]?.range).toBe('18.20.4');
    expect(projectNeeds(JSON.stringify({ dependencies: { sass: '^1.70.0' } }))).toEqual([]);
    expect(projectNeeds('not json')).toEqual([]);
  });

  it('without an .nvmrc builds a node-sass project on the Node it runs on, not on nvm\'s default', () => {
    const m = machine(['v24.22.0', 'v22.23.3', 'v16.20.2'], '22');
    writeFileSync(join(m.theme, 'package.json'), JSON.stringify({ scripts: { build: 'gulp' }, devDependencies: { 'node-sass': '^7.0.1' } }));
    expect(nodeFor(m.theme, m.clone, { home: m.home })).toMatchObject({ bin: m.bin('v16.20.2'), note: 'Node 16.20.2 from nvm (node-sass 7 runs on Node 16 at most)' });
    // The lookup reads the same from the repo's files, before the clone.
    const text = new Map([['wp-content/themes/wandworks/package.json', JSON.stringify({ devDependencies: { 'node-sass': '^7.0.1' } })]]);
    expect(nodeForFiles('wp-content/themes/wandworks', text, { home: m.home })).toMatchObject({ note: 'Node 16.20.2 from nvm (node-sass 7 runs on Node 16 at most)' });
    expect(nodeForFiles('wp-content/themes/wandworks', new Map([...text, ['.nvmrc', '24\n']]), { home: m.home })).toMatchObject({ note: 'Node 24.22.0 from nvm (.nvmrc asks for 24)' });
  });

  it('keeps nvm\'s default when it meets engines, and says what to install when nothing fits', () => {
    const m = machine(['v24.22.0', 'v22.23.3'], '22');
    writeFileSync(join(m.theme, 'package.json'), JSON.stringify({ engines: { node: '>=18' } }));
    expect(nodeFor(m.theme, m.clone, { home: m.home })).toMatchObject({ bin: m.bin('v22.23.3'), note: 'Node 22.23.3 from nvm (package.json asks for Node >=18)' });
    writeFileSync(join(m.theme, 'package.json'), JSON.stringify({ devDependencies: { 'node-sass': '6.0.1' } }));
    expect(nodeFor(m.theme, m.clone, { home: m.home })).toMatchObject({ bin: m.bin('v22.23.3'), note: 'Node 22.23.3 from nvm (its default, 22); node-sass 6 runs on Node 16 at most, and nvm has no such Node: run nvm install 16 in a terminal' });
  });

  it('puts the version picked for the build before the repo\'s .nvmrc, and refuses one nvm lost', () => {
    const m = machine(['v22.23.3', 'v16.20.2'], '22');
    writeFileSync(join(m.theme, '.nvmrc'), '22');
    expect(nodeFor(m.theme, m.clone, { home: m.home, pick: '16.20.2' })).toMatchObject({ bin: m.bin('v16.20.2'), note: 'Node 16.20.2 from nvm (picked for this build)' });
    expect(nodeFor(m.theme, m.clone, { home: m.home, pick: '14.21.3' })).toEqual({ error: 'Node 14.21.3, picked for this build, is not in nvm: run nvm install 14.21.3 in a terminal, then Retry' });
  });
});

describe('a build that fails on its Node', () => {
  const gyp = (clone: string) => ['npm error gyp ERR! configure error', `npm error gyp ERR! cwd ${clone}/wp-content/themes/wandworks/node_modules/fibers`, 'npm error gyp ERR! node -v v22.23.3', 'npm error gyp ERR! not ok'].join('\n');

  it('runs once more on the older Node the lock file fits, after clearing node_modules', async () => {
    const m = machine(['v22.23.3', 'v18.20.4', 'v16.20.2'], '22');
    writeFileSync(join(m.theme, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { engines: { node: '^12 || ^14 || ^16' } }, 'node_modules/b': { engines: { node: '>=10' } } } }));
    mkdirSync(join(m.theme, 'node_modules/left'), { recursive: true });
    const fake = fakeExec({ 'npm ci': (call) => (call.env?.PATH?.startsWith(m.bin('v22.23.3')) ? { code: 1, stderr: gyp(m.clone) } : { stdout: 'added 900 packages' }), 'npm run': { stdout: 'built' } });
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(results[1]?.stdout).toBe("warn: wp-content/themes/wandworks: the build failed on Node 22.23.3: fibers has no ready build on Node 22.23.3 and could not compile itself. Trying once more on Node 16.20.2 from nvm (the older Node the lock file's packages fit best)");
    expect(fake.calls.map((c) => [c.args[0], c.env?.PATH?.split(':')[0]])).toEqual([['ci', m.bin('v22.23.3')], ['ci', m.bin('v16.20.2')], ['run', m.bin('v16.20.2')]]);
    expect(existsSync(join(m.theme, 'node_modules'))).toBe(false);
  });

  it('does not leave the Node the repo or you named, and fails with the hint when the second try fails too', async () => {
    const m = machine(['v22.23.3', 'v16.20.2'], '22');
    writeFileSync(join(m.theme, '.nvmrc'), '22');
    const failing = () => fakeExec({ 'npm install': { code: 1, stderr: gyp(m.clone) } });
    const named = failing();
    expect((await runBuild(named.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode })).map((r) => r.code)).toEqual([0, 1]);
    expect(named.calls).toHaveLength(1);
    rmSync(join(m.theme, '.nvmrc'));
    const twice = failing();
    const results = await runBuild(twice.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(twice.calls).toHaveLength(2);
    expect(results.at(-1)).toMatchObject({ code: 1 });
    expect(results.at(-1)?.stderr).toContain('fibers has no ready build on Node 22');
  });

  it('goes to a newer Node when a package needs one', async () => {
    const m = machine(['v22.23.3', 'v20.18.0'], '20');
    const warning = ['npm warn EBADENGINE Unsupported engine {', "npm warn EBADENGINE   package: 'vite@7.3.3',", "npm warn EBADENGINE   required: { node: '^20.19.0 || >=22.12.0' },", "npm warn EBADENGINE   current: { node: 'v20.18.0', npm: '10.8.2' }", 'npm warn EBADENGINE }'].join('\n');
    const fake = fakeExec({ 'npm install': { stderr: warning }, 'npm run': (call) => (call.env?.PATH?.startsWith(m.bin('v20.18.0')) ? { code: 1, stderr: 'vite failed' } : { stdout: 'built' }) });
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results.at(-1)).toMatchObject({ code: 0, stdout: 'built' });
    expect(results[1]?.stdout).toContain('Trying once more on Node 22.23.3 from nvm (a package needs Node ^20.19.0 || >=22.12.0)');
  });
});

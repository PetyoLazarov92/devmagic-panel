import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/sites/create.js';
import { engineHint, matchVersion, nodeEnv, nodeFor } from '../src/sites/node.js';
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
  const theme = join(clone, 'wp-content/themes/acme');
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
    expect(choice).toEqual({ bin: m.bin('v20.18.0'), note: 'Node 20.18.0 from nvm (.nvmrc asks for v20)' });
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
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toEqual({ bin: m.bin('v20.18.0'), note: 'Node 20.18.0 from nvm (its default, v20.18.0)' });
    const bare = machine(installed);
    expect(nodeFor(null, null, { home: bare.home, panelNode: bare.panelNode })).toEqual({ bin: bare.bin('v24.22.0'), note: 'Node 24.22.0 from nvm (the newest it has)' });
  });

  it('without nvm uses the Node the panel runs on when npm is next to it, then plain PATH', () => {
    const m = machine([]);
    writeFileSync(join(m.clone, '.nvmrc'), '20');
    expect(nodeFor(m.theme, m.clone, { home: m.home, panelNode: m.panelNode })).toEqual({ bin: null, note: 'the Node on the system PATH; .nvmrc asks for 20, and nvm is not installed' });
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
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/acme', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results[0]?.stdout).toContain('wp-content/themes/acme: Node 20.18.0 from nvm (wp-content/themes/acme/.nvmrc asks for 20)');
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
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/acme', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results.at(-1)?.stderr).toBe(
      'vite failed\nwp-content/themes/acme: a package needs Node ^20.19.0 || >=22.12.0 and this build ran on 20.18.0: run nvm install 20 in a terminal for the newest Node 20 (or set a newer one in .nvmrc), then Retry',
    );
    expect(engineHint('added 30 packages in 2s')).toBeUndefined();
  });

  it('gives no Node hint for a package that only lists older Nodes', () => {
    const older = [
      'npm warn EBADENGINE Unsupported engine {',
      "npm warn EBADENGINE   package: 'eslint-plugin-acme@40.0.0',",
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
    expect(engineHint(warn('fetch-acme@5.7.1', '>=0.10.0 <7'))).toBeUndefined();
    expect(engineHint(`${warn('fetch-acme@5.7.1', '>=0.10.0 <7')}\n${warn('build-acme@3.0.0', '>=24')}`)).toContain('a package needs Node >=24 and this build ran on 22.23.3');
  });

  it('stops before npm when the repo asks for a Node nvm lacks', async () => {
    const m = machine(installed);
    writeFileSync(join(m.theme, '.nvmrc'), '16');
    const fake = fakeExec();
    const results = await runBuild(fake.exec, m.clone, { dir: 'wp-content/themes/acme', tool: 'npm', script: 'build' }, { home: m.home, panelNode: m.panelNode });
    expect(results).toEqual([{ code: 1, stdout: '', stderr: expect.stringContaining('run nvm install 16') }]);
    expect(fake.calls).toEqual([]);
  });
});

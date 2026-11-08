import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildsFor, runBuild } from '../src/sites/create.js';
import { fakeExec } from './helpers.js';

function clone() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-build-'));
  const theme = join(root, 'wp-content/themes/wandworks');
  mkdirSync(theme, { recursive: true });
  writeFileSync(join(theme, 'package.json'), JSON.stringify({ scripts: { prod: 'webpack --mode production' } }));
  writeFileSync(join(theme, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'composer.json'), '{}');
  return root;
}

describe('running the builds of an install', () => {
  it('runs each tool in its folder: npm ci with a lock file, then the script; composer install', async () => {
    const root = clone();
    const fake = fakeExec({ npm: { stdout: 'ok' }, composer: { stdout: 'ok' } });
    await runBuild(fake.exec, root, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'prod' }, { home: root });
    await runBuild(fake.exec, root, { dir: '', tool: 'composer' });
    expect(fake.calls.map((c) => [c.file, ...c.args])).toEqual([
      ['npm', 'ci', '--no-audit', '--no-fund'],
      ['npm', 'run', 'prod'],
      ['composer', 'install', '--no-interaction', '--no-progress'],
    ]);
  });

  it('skips a folder without its manifest, a script the package.json lost, and a folder that leaves the clone', async () => {
    const root = clone();
    const outside = mkdtempSync(join(tmpdir(), 'dmp-outside-'));
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    symlinkSync(outside, join(root, 'wp-content/themes/linked'));
    const fake = fakeExec({ npm: { stdout: 'ok' } });
    expect((await runBuild(fake.exec, root, { dir: 'wp-content/plugins/none', tool: 'npm', script: 'build' }))[0]?.stdout).toContain('no package.json, skipped');
    expect((await runBuild(fake.exec, root, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }))[0]?.stdout).toContain('has no build script, skipped');
    expect((await runBuild(fake.exec, root, { dir: 'wp-content/themes/linked', tool: 'npm', script: 'build' }))[0]?.stdout).toContain('skipped');
    expect(fake.calls).toEqual([]);
  });

  it('keeps webpack progress lines out of a build\'s output', async () => {
    const root = clone();
    const out = ['[theme] <s> [webpack.Progress] 9% setup compilation NoEmitOnErrorsPlugin', '[theme] compiled', '<s> [webpack.Progress] 100%'].join('\n');
    const fake = fakeExec({ 'npm ci': { stdout: 'ok' }, 'npm run': { stdout: out } });
    const results = await runBuild(fake.exec, root, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'prod' }, { home: root });
    expect(results.at(-1)?.stdout).toBe('[theme] compiled');
  });

  it('says so when concurrently --kill-others stopped a build that had not finished', async () => {
    const root = clone();
    const out = ['[blocks] compiled successfully', '--> Sending SIGTERM to other processes..', '[theme] webpack exited with code SIGTERM'].join('\n');
    const fake = fakeExec({ 'npm ci': { stdout: 'ok' }, 'npm run': { code: 1, stdout: out } });
    const results = await runBuild(fake.exec, root, { dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'prod' }, { home: root });
    expect(results.at(-1)?.stderr).toBe(
      'wp-content/themes/wandworks: the build failed: prod runs its builds with concurrently --kill-others, so the first to finish stopped the others; run one of its parts instead, or change it to --kill-others-on-fail in package.json',
    );
  });

  it('keeps the two older switches as builds at the repo root', () => {
    const base = { build: { composer: true, npm: true } } as Parameters<typeof buildsFor>[0];
    expect(buildsFor(base)).toEqual([{ dir: '', tool: 'composer' }, { dir: '', tool: 'npm', script: 'build' }]);
    expect(buildsFor({ ...base, builds: [] })).toEqual([]);
  });
});

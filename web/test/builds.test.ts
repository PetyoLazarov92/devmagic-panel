import type { RepoBuild } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { buildChoice, buildSteps } from '../src/lib/builds.js';

const theme: RepoBuild = { dir: 'wp-content/themes/wandworks', tool: 'npm', scripts: ['build', 'prod'], script: 'build', needed: true, why: 'dist/ is ignored by git' };
const slider: RepoBuild = { dir: 'wp-content/plugins/wandworks-slider', tool: 'npm', scripts: ['prod', 'dev'], script: 'prod', needed: false, why: 'its built files are in the repo' };
const root: RepoBuild = { dir: '', tool: 'composer', scripts: [], needed: true, why: 'vendor/ is ignored by git' };

describe('the build checklist', () => {
  it('runs what the lookup ticked, with its script', () => {
    expect(buildSteps([root, theme, slider], {}, [])).toEqual([{ repo: 0, dir: '', tool: 'composer' }, { repo: 0, dir: 'wp-content/themes/wandworks', tool: 'npm', script: 'build' }]);
  });

  it('ticks a build the docs name, with their script, and marks it as from the docs', () => {
    const docs = [{ folder: './wp-content/themes/wandworks/', command: 'cd wp-content/themes/wandworks && npm run prod' }, { folder: 'wp-content/plugins/wandworks-slider', command: 'npm run dev' }];
    expect(buildChoice(theme, {}, docs)).toEqual({ on: true, script: 'prod', fromDocs: true });
    expect(buildChoice(slider, {}, docs)).toEqual({ on: true, script: 'dev', fromDocs: true });
    // A script the package.json does not have is not taken from the docs.
    expect(buildChoice(theme, {}, [{ folder: 'wp-content/themes/wandworks', command: 'npm run deploy' }])).toEqual({ on: true, script: 'build', fromDocs: false });
  });

  it('leaves a build the docs name off when what it makes is in the repo, until you tick it', () => {
    const committed: RepoBuild = { ...slider, builtInRepo: true };
    const docs = [{ folder: 'wp-content/plugins/wandworks-slider', command: 'npm run dev' }];
    expect(buildChoice(committed, {}, docs)).toEqual({ on: false, script: 'dev', fromDocs: true });
    expect(buildChoice(committed, { 'npm:wp-content/plugins/wandworks-slider': { on: true, script: 'dev' } }, docs)).toEqual({ on: true, script: 'dev', fromDocs: false });
  });

  it('lets go of a remembered pick or a docs script that runs a gulp task the gulpfile lacks', () => {
    const gulp: RepoBuild = { dir: '', tool: 'npm', scripts: ['build', 'compile:css'], needed: false, why: 'dist/ is ignored by git: pick its build script', missingTasks: { build: 'build' } };
    // Remembered from an earlier install: build, which fails at once. It is off until you pick another script.
    expect(buildChoice(gulp, { 'npm:': { on: true, script: 'build' } }, [])).toEqual({ on: false, fromDocs: false });
    expect(buildChoice(gulp, {}, [{ folder: '', command: 'npm run build' }])).toEqual({ on: false, fromDocs: false });
    expect(buildChoice(gulp, { 'npm:': { on: true, script: 'compile:css' } }, [])).toEqual({ on: true, script: 'compile:css', fromDocs: false });
  });

  it('follows your ticks and scripts over the docs and the lookup', () => {
    const picks = { 'npm:wp-content/themes/wandworks': { on: false }, 'npm:wp-content/plugins/wandworks-slider': { on: true, script: 'dev' } };
    expect(buildSteps([theme, slider], picks, [{ folder: 'wp-content/themes/wandworks', command: 'npm run prod' }])).toEqual([{ repo: 0, dir: 'wp-content/plugins/wandworks-slider', tool: 'npm', script: 'dev' }]);
  });
});

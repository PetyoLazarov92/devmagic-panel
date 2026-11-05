import type { BuildTool } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { composerPlugins, ignoredFolder, ignoredOutput, planBuilds, type BuildFiles } from '../src/sites/builds.js';

/** A repo as the lookup sees it: every path, and the text of the few files it reads. */
function repo(text: Record<string, string>, more: string[] = []): BuildFiles {
  return { paths: new Set([...Object.keys(text), ...more]), text: new Map(Object.entries(text)) };
}
const all = new Set<BuildTool>(['composer', 'npm', 'yarn', 'pnpm']);
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const composer = (require: Record<string, string>) => JSON.stringify({ require });
const WPORG = '=== Acme Forms ===\nStable tag: 2.1.0\n';

describe('the builds of a repo', () => {
  it('marks scripts that stop their other builds when one finishes, and never picks one by default', () => {
    const [build] = planBuilds(
      repo({
        'wp-content/themes/acme/package.json': pkg({
          build: 'concurrently --kill-others -P "webpack --env=mode=production" "wp-scripts build"',
          'build-theme': 'webpack --env=mode=production',
          'build-short': 'concurrently -k "webpack" "wp-scripts build"',
          'build-safe': 'concurrently --kill-others-on-fail "webpack" "wp-scripts build"',
        }),
        'wp-content/themes/acme/.gitignore': 'dist/\n',
      }),
      all,
    );
    expect(build?.stopsOthers).toEqual(['build', 'build-short']);
    expect(build?.script).toBeUndefined();
  });

  it('says when what a build makes is in the repo already', () => {
    const builds = planBuilds(
      repo(
        {
          'wp-content/themes/acme/package.json': pkg({ build: 'webpack' }),
          'wp-content/themes/northwind/package.json': pkg({ build: 'webpack' }),
          'wp-content/themes/northwind/.gitignore': 'dist/\n',
          'composer.json': composer({ 'acme/lib': '^1' }),
        },
        ['wp-content/themes/acme/assets/dist/app.js', 'vendor/autoload.php'],
      ),
      all,
    );
    expect(Object.fromEntries(builds.map((b) => [b.dir, b.builtInRepo ?? false]))).toEqual({
      '': true,
      'wp-content/themes/acme': true,
      'wp-content/themes/northwind': false,
    });
  });

  it('ticks a theme or block plugin whose build output git ignores, with its build script', () => {
    const builds = planBuilds(
      repo({ 'wp-content/themes/acme/package.json': pkg({ build: 'wp-scripts build', start: 'wp-scripts start' }), 'wp-content/themes/acme/.gitignore': '/build\n' }, ['wp-content/themes/acme/package-lock.json']),
      all,
    );
    expect(builds).toEqual([{ dir: 'wp-content/themes/acme', tool: 'npm', scripts: ['build'], script: 'build', needed: true, why: 'build/ is ignored by git' }]);
  });

  it('leaves a plugin that ships its built files, a wordpress.org plugin and a missing tool unticked', () => {
    const builds = planBuilds(
      repo(
        {
          'wp-content/plugins/acme-slider/package.json': pkg({ watch: 'webpack --watch', prod: 'webpack --mode production', 'prod-bundle': 'webpack --mode production && zip', dev: 'webpack --mode development' }),
          'wp-content/plugins/acme-forms/package.json': pkg({ build: 'gulp build' }),
          'wp-content/plugins/acme-forms/readme.txt': WPORG,
          'wp-content/plugins/acme-forms/.gitignore': 'dist/\n',
          'wp-content/themes/acme/package.json': pkg({ build: 'vite build' }),
          'wp-content/themes/acme/.gitignore': 'dist\n',
        },
        ['wp-content/themes/acme/yarn.lock', 'wp-content/plugins/acme-slider/dist/app.js'],
      ),
      new Set<BuildTool>(['npm', 'composer']),
    );
    expect(builds.map((b) => [b.dir, b.needed, b.script, b.why])).toEqual([
      ['wp-content/plugins/acme-forms', false, 'build', 'a wordpress.org plugin, built already'],
      ['wp-content/plugins/acme-slider', false, 'prod', 'its built files are in the repo'],
      ['wp-content/themes/acme', false, 'build', 'yarn is not installed'],
    ]);
    // Watchers never show up, and prod wins when there is no build.
    expect(builds.find((b) => b.dir.endsWith('acme-slider'))?.scripts).toEqual(['prod', 'prod-bundle', 'dev']);
  });

  it('ticks composer install only for a project that ignores its vendor/ and needs packages to run', () => {
    const builds = planBuilds(
      repo(
        {
          '.gitignore': '/vendor/\nwp-content/plugins/acme-*/vendor\n',
          'composer.json': composer({ php: '>=8.1', 'composer/installers': '^2.0', 'wpackagist-plugin/query-monitor': '*' }),
          'wp-content/plugins/acme-api/composer.json': composer({ 'guzzlehttp/guzzle': '^7.0' }),
          'wp-content/plugins/acme-api/vendor/x/composer.json': composer({ 'y/z': '1' }),
          'wp-content/plugins/acme-cache/composer.json': composer({ 'psr/log': '^3' }),
          'wp-content/plugins/acme-tools/composer.json': JSON.stringify({ require: { php: '>=7.4' }, 'require-dev': { 'phpunit/phpunit': '^10' } }),
          'wp-content/plugins/acme-forms/composer.json': composer({ 'monolog/monolog': '^3' }),
          'wp-content/plugins/acme-forms/readme.txt': WPORG,
          'wp-content/plugins/bundled-maps/composer.json': composer({ 'symfony/polyfill-php80': '^1' }),
        },
        ['wp-content/plugins/acme-api/vendor/autoload.php'],
      ),
      all,
    );
    expect(builds.map((b) => [b.dir, b.needed, b.why])).toEqual([
      ['', true, 'vendor/ is ignored by git'],
      ['wp-content/plugins/acme-cache', true, 'vendor/ is ignored by git'],
      ['wp-content/plugins/acme-api', false, 'its vendor/ is in the repo'],
      ['wp-content/plugins/acme-forms', false, 'a wordpress.org plugin, built already'],
      ['wp-content/plugins/bundled-maps', false, 'vendor/ is not ignored by git: its libraries ship with it'],
    ]);
  });

  it('reads output folders from the .gitignore of the folder or one above, anchored or not, with globs', () => {
    const files = (rules: Record<string, string>) => repo(rules);
    expect(ignoredOutput('wp-content/themes/acme', files({ '.gitignore': '/wp-content/themes/acme/dist/\n' }))).toBe('dist');
    expect(ignoredOutput('wp-content/themes/acme', files({ '.gitignore': 'build\n' }))).toBe('build');
    expect(ignoredOutput('wp-content/themes/acme', files({ '.gitignore': '/build\n' }))).toBeNull();
    expect(ignoredOutput('wp-content/themes/acme', files({ '.gitignore': 'wp-content/themes/*/assets/dist\n' }))).toBe('assets/dist');
    expect(ignoredOutput('wp-content/themes/acme', files({ '.gitignore': '**/dist/**\n' }))).toBe('dist');
    expect(ignoredOutput('wp-content/themes/acme', files({ 'wp-content/themes/acme/.gitignore': '# built\nassets/dist/*\n' }))).toBe('assets/dist');
    expect(ignoredOutput('wp-content/themes/acme', files({ 'wp-content/themes/acme/.gitignore': 'node_modules\n!dist\n' }))).toBeNull();
    expect(ignoredFolder('wp-content/plugins/acme-api', files({ '.gitignore': 'vendor/\n' }), ['vendor'])).toBe('vendor');
  });

  it('skips a package.json without a build, and offers the scripts when none is called build or prod', () => {
    const builds = planBuilds(
      repo({ 'a/package.json': pkg({ start: 'vite', test: 'vitest' }), 'b/package.json': pkg({ 'gulp-dev': 'gulp' }), 'b/.gitignore': 'dist\n' }, ['b/package-lock.json']),
      all,
    );
    expect(builds).toEqual([{ dir: 'b', tool: 'npm', scripts: ['gulp-dev'], needed: false, why: 'dist/ is ignored by git: pick its build script' }]);
  });

  it('finds plugins Composer brings in from WordPress Packagist', () => {
    expect(composerPlugins(repo({ 'composer.json': JSON.stringify({ require: { 'wpackagist-plugin/query-monitor': '*' }, 'require-dev': { 'wpackagist-plugin/wp-crontrol': '*', 'wpackagist-theme/x': '*' } }) }))).toEqual(['query-monitor', 'wp-crontrol']);
  });
});

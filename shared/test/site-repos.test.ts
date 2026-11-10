import { describe, expect, it } from 'vitest';
import { actions, legacyCreateInput, presetPlacement } from '../src/actions.js';
import { cloneFolder, holdsCore, looksLikeTheme, placementForKind, themeFolderIn, placementForLayout, placementProblems, placementWarnings, repoBaseName, repoTarget, siteDir, throughCoreLink } from '../src/site-repos.js';

const URL = 'git@github.com:wandworks/wandworks-blocks.git';
const base = {
  source: 'repo',
  domain: 'local.spellbook.example',
  core: { mode: 'wpcore', version: '7.1.3' },
  admin: { user: 'admin', email: 'admin@local.spellbook.example' },
};
const create = (input: Record<string, unknown>) => actions['site.create'].input.safeParse({ ...base, ...input });

describe('where a repo goes', () => {
  it('names a repo after its URL, and gives each old layout its folder', () => {
    expect(repoBaseName(URL)).toBe('wandworks-blocks');
    expect(repoBaseName('https://gitlab.com/wandworks/web/store')).toBe('store');
    expect(placementForLayout('site-root', URL)).toEqual({ dir: '', folder: '' });
    expect(placementForLayout('wp-content', URL)).toEqual({ dir: '', folder: 'wp-content' });
    expect(placementForLayout('theme', URL)).toEqual({ dir: 'wp-content/themes', folder: 'wandworks-blocks' });
    expect(placementForLayout('plugin', URL)).toEqual({ dir: 'wp-content/plugins', folder: 'wandworks-blocks' });
    expect(placementForKind('other', URL)).toBeNull();
    expect(repoTarget({ dir: 'wp-content/plugins', folder: 'wandworks-blocks' })).toBe('wp-content/plugins/wandworks-blocks');
    expect(repoTarget({ dir: '', folder: '' })).toBe('');
  });

  it.each(['', 'wp-content', 'wp-content/plugins', 'app/modules/v2', 'wp-content/plugins/@wandworks'])('takes the folder %j', (dir) => {
    expect(siteDir.safeParse(dir).success).toBe(true);
  });

  it.each(['/etc', '../x', 'wp-content/../..', 'a//b', 'a/', './a', '.git', 'a/.hidden', 'a b', 'a;b', 'a/b/c/d/e/f/g/h/i'])('refuses the folder %j', (dir) => {
    expect(siteDir.safeParse(dir).success).toBe(false);
  });

  it('takes a plain folder name or none, never a path or a dot name', () => {
    expect(cloneFolder.safeParse('').success).toBe(true);
    expect(cloneFolder.safeParse('wandworks-blocks').success).toBe(true);
    for (const bad of ['a/b', '..', '.git', '-x', 'a b']) expect(cloneFolder.safeParse(bad).success).toBe(false);
  });

  it('allows one repo at the site root and one repo per path; a repo inside another is fine', () => {
    expect(placementProblems([{ dir: '', folder: '' }, { dir: 'wp-content/plugins', folder: 'x' }, { dir: 'wp-content/plugins/x', folder: 'inner' }])).toEqual([]);
    expect(placementProblems([{ dir: '', folder: '' }, { dir: '', folder: '' }])).toEqual(['Only one repo can be the site root']);
    expect(placementProblems([{ dir: 'wp-content/plugins', folder: 'x' }, { dir: 'wp-content', folder: 'plugins/x' as string }])).toEqual(['Two repos go to wp-content/plugins/x']);
  });

  it('finds a theme in a folder of its repo, style.css built or not, and sends that repo to wp-content/repos', () => {
    expect(looksLikeTheme(['style.css', 'functions.php'])).toBe(true);
    // The build makes style.css: functions.php, index.php and one more file only a theme has.
    expect(looksLikeTheme(['functions.php', 'index.php', 'header.php', 'sass'])).toBe(true);
    expect(looksLikeTheme(['functions.php', 'index.php'])).toBe(false);
    expect(looksLikeTheme(['style.css', 'index.php'])).toBe(false);
    const repo = ['package.json', 'gulpfile.js', 'README.md', 'wandworks/functions.php', 'wandworks/index.php', 'wandworks/screenshot.png', 'wandworks/inc/setup.php'];
    expect(themeFolderIn(repo)).toBe('wandworks');
    expect(themeFolderIn(['package.json', 'src/index.php'])).toBeUndefined();
    // Two themes in one repo, or one in a folder tools fill: you place it.
    expect(themeFolderIn([...repo, 'wandworks-child/functions.php', 'wandworks-child/style.css'])).toBeUndefined();
    expect(themeFolderIn(['vendor/functions.php', 'vendor/style.css'])).toBeUndefined();
    const url = 'git@github.com:wandworks/theme-kit.git';
    expect(placementForKind('theme', url)).toEqual({ dir: 'wp-content/themes', folder: 'theme-kit' });
    expect(placementForKind('theme', url, 'wandworks')).toEqual({ dir: 'wp-content/repos', folder: 'theme-kit' });
    expect(placementWarnings('wp-content/repos/theme-kit')).toEqual(['WordPress reads the theme inside this repo under its own name through Local mode, so Local mode has to stay on for this site']);
  });

  it('warns about core and uploads in a repo without refusing them', () => {
    expect(placementWarnings('wp-content/plugins/x')).toEqual([]);
    expect(placementWarnings('wp-includes/patches')).toHaveLength(1);
    expect(placementWarnings('wp-content/uploads')).toHaveLength(1);
    expect(throughCoreLink('wp-admin/tools')).toBe(true);
    expect(throughCoreLink('wp-content/wp-admin-tools')).toBe(false);
    expect(holdsCore(['wp-admin', 'wp-includes', 'wp-content', 'index.php'])).toBe(true);
    expect(holdsCore(['wp-content'])).toBe(false);
  });
});

describe('site.create with repos', () => {
  it('reads an input from before 1.28 with one repo and a layout as repos[0]', () => {
    const parsed = create({ repo: { url: URL, branch: 'main', layout: 'plugin' } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.repos).toEqual([{ url: URL, branch: 'main', dir: 'wp-content/plugins', folder: 'wandworks-blocks' }]);
    expect(parsed.data).not.toHaveProperty('repo');
    // repos wins when both come.
    expect(legacyCreateInput({ repo: { url: URL, branch: 'x', layout: 'theme' }, repos: [] })).toEqual({ repos: [] });
  });

  it('needs a repo for an install from a project, and none otherwise', () => {
    expect(create({ repos: [] }).success).toBe(false);
    expect(create({ source: 'wordpress', repos: [{ url: URL, branch: 'main', dir: '', folder: '' }] }).success).toBe(false);
  });

  it('takes several repos, each in its place, and refuses two at one path', () => {
    const site = { url: 'git@github.com:wandworks/site.git', branch: 'main', dir: '', folder: '' };
    const plugin = { url: URL, branch: 'main', dir: 'wp-content/plugins', folder: 'wandworks-blocks' };
    expect(create({ repos: [site, plugin] }).success).toBe(true);
    expect(create({ repos: [site, plugin, { ...plugin, url: 'git@github.com:wandworks/other.git' }] }).success).toBe(false);
    expect(create({ repos: [site, { ...plugin, dir: '../..' }] }).success).toBe(false);
  });

  it('builds name the repo they run in, and that repo must be there', () => {
    const repos = [{ url: URL, branch: 'main', dir: '', folder: '' }];
    expect(create({ repos, builds: [{ dir: '', tool: 'composer' }] }).data?.builds).toEqual([{ repo: 0, dir: '', tool: 'composer' }]);
    expect(create({ repos, builds: [{ repo: 1, dir: '', tool: 'composer' }] }).success).toBe(false);
  });

  it("uses the repo's own WordPress only with a repo at the site root, and needs a version otherwise", () => {
    const root = { url: URL, branch: 'main', dir: '', folder: '' };
    expect(create({ repos: [root], core: { mode: 'repo' } }).success).toBe(true);
    expect(create({ repos: [{ ...root, dir: 'wp-content/plugins', folder: 'x' }], core: { mode: 'repo' } }).success).toBe(false);
    expect(create({ repos: [root], core: { mode: 'wpcore' } }).success).toBe(false);
  });

  it('remembers the answers unless told not to', () => {
    const repos = [{ url: URL, branch: 'main', dir: '', folder: '' }];
    expect(create({ repos }).data?.remember).toBe(true);
    expect(create({ repos, remember: false }).data?.remember).toBe(false);
  });
});

describe('remembered answers', () => {
  it('read an old layout as a placement, and a new placement as it is', () => {
    expect(presetPlacement({ layout: 'theme' }, 'git@github.com:wandworks/Wandworks.git')).toEqual({ dir: 'wp-content/themes', folder: 'Wandworks' });
    expect(presetPlacement({ placement: { dir: 'app', folder: '' }, layout: 'theme' }, URL)).toEqual({ dir: 'app', folder: '' });
    expect(presetPlacement({}, URL)).toEqual({ dir: '', folder: '' });
  });
});

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/exec.js';
import { readTidyPreview, restoreBranches, tidy } from '../src/sites/git.js';
import { wpSiteTree } from './helpers.js';

/** A site whose folder is a clone of a bare origin in the temp tree, with git's own config kept out. */
function repo() {
  const t = wpSiteTree();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Alex Morgan', GIT_AUTHOR_EMAIL: 'alex@spellbook.example', GIT_COMMITTER_NAME: 'Alex Morgan', GIT_COMMITTER_EMAIL: 'alex@spellbook.example' };
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
  const origin = join(t.root, 'origin.git');
  run(t.root, 'init', '--bare', '-b', 'main', origin);
  run(t.docroot, 'init', '-b', 'main');
  run(t.docroot, 'remote', 'add', 'origin', origin);
  run(t.docroot, 'commit', '--allow-empty', '-m', 'first');
  run(t.docroot, 'push', '-u', 'origin', 'main');
  run(t.docroot, 'remote', 'set-head', 'origin', 'main');
  for (const [branch, merged] of [['feature/cart', true], ['feature/wishlist', false], ['feature/live', false]] as const) {
    run(t.docroot, 'switch', '-c', branch);
    run(t.docroot, 'commit', '--allow-empty', '-m', `work on ${branch}`);
    run(t.docroot, 'push', '-u', 'origin', branch);
    run(t.docroot, 'switch', 'main');
    if (merged) {
      run(t.docroot, 'merge', '--ff-only', branch);
      run(t.docroot, 'push', 'origin', 'main');
    }
  }
  // Two branches were deleted on origin, one is still there.
  run(t.docroot, 'push', 'origin', '--delete', 'feature/cart', 'feature/wishlist');
  // The panel's own git runs see the same clean config.
  const exec: typeof runCommand = (file, args, options) => runCommand(file, args, { ...options, env: { ...options?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return { ...t, exec, run };
}

describe('tidying up a repo', () => {
  it('lists branches gone from origin after a fetch with prune, deletes the ones asked, keeps them for Undo and puts them back', async () => {
    const r = repo();
    const ctx = { config: r.config, exec: r.exec };
    const at = new Date('2026-11-11T10:00:00Z');
    await r.exec('git', ['-C', r.docroot, 'fetch', '--prune', 'origin']);
    const preview = await readTidyPreview(r.exec, r.docroot, at);
    expect(preview.mainBranch).toBe('origin/main');
    expect(preview.gone.map((g) => [g.name, g.merged])).toEqual([['feature/cart', true], ['feature/wishlist', false]]);
    expect(preview.objectsBytes).toBeGreaterThan(0);

    const out = await tidy(ctx, { domain: 'local.shop.com', branches: ['feature/cart', 'feature/wishlist', 'feature/live', 'main'], gc: true }, at);
    const text = out.results.map((x) => x.stdout).join('\n');
    expect(text).toContain('deleted 2 branches gone from origin: feature/cart, feature/wishlist');
    expect(text).toMatch(/left as they are.*feature\/live, main/);
    expect(text).toMatch(/packed with git gc/);
    const heads = r.run(r.docroot, 'branch', '--format=%(refname:short)');
    expect(heads.split('\n').filter(Boolean).sort()).toEqual(['feature/live', 'main']);
    expect((await readTidyPreview(r.exec, r.docroot, at)).kept.map((k) => k.name).sort()).toEqual(['feature/cart', 'feature/wishlist']);

    const back = await restoreBranches(ctx, { domain: 'local.shop.com', branches: ['feature/wishlist'] });
    expect(back.results[0]?.stdout).toBe('put back feature/wishlist');
    expect(r.run(r.docroot, 'log', '-1', '--format=%s', 'feature/wishlist').trim()).toBe('work on feature/wishlist');

    // Two weeks on, the kept copy goes with the next tidy.
    const later = new Date(at.getTime() + 15 * 86_400_000);
    const again = await tidy(ctx, { domain: 'local.shop.com', branches: [], gc: false }, later);
    expect(again.results.map((x) => x.stdout).join('\n')).toContain('forgot 1 branch deleted more than 14 days ago');
    expect((await readTidyPreview(r.exec, r.docroot, later)).kept).toEqual([]);
  });
});

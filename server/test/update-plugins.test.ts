import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFileTrash } from '../src/sites/file-changes.js';
import { undoUpdates, updateItems } from '../src/sites/update-plugins.js';
import { fakeExec, type FakeResponse, wpSiteTree } from './helpers.js';

const HOST = 'local.shop.com';

/** A site with the plugin acf 6.2 on disk, and WP-CLI faked: update writes 6.3's files. */
function setup(update: FakeResponse = { stdout: 'Success: Updated 1 of 1 plugins.' }, checksums: FakeResponse = { stdout: 'Success: Verified 1 of 1 plugins.' }) {
  const t = wpSiteTree();
  const docroot = join(t.config.WEB_DIR, 'local.shop.com');
  const folder = join(docroot, 'wp-content', 'plugins', 'acf');
  mkdirSync(join(folder, 'includes'), { recursive: true });
  writeFileSync(join(folder, 'acf.php'), '<?php // 6.2');
  writeFileSync(join(folder, 'includes', 'old.php'), '<?php // only in 6.2');
  let version = '6.2';
  const wp = `wp --path=${docroot} --url=https://${HOST}/`;
  const fake = fakeExec({
    [`${wp} plugin get acf`]: () => ({ stdout: `${version}\n` }),
    [`${wp} plugin update acf`]: async (call) => {
      const answer = typeof update === 'function' ? await update(call) : update;
      if ((answer.code ?? 0) === 0) {
        rmSync(join(folder, 'includes', 'old.php'));
        writeFileSync(join(folder, 'acf.php'), '<?php // 6.3');
        writeFileSync(join(folder, 'includes', 'new.php'), '<?php // new in 6.3');
        version = '6.3';
      }
      return answer;
    },
    [`${wp} plugin verify-checksums acf`]: checksums,
    git: { stdout: '' },
  });
  const deps = { exec: fake.exec, docroot, host: HOST, trash: join(t.root, 'file-trash'), site: 'local.shop.com', files: { root: docroot, readRoots: [] } };
  return { deps, fake, folder, docroot };
}

describe('updating plugins', () => {
  it('keeps the folder from before in the file trash, updates, and Undo puts that version back as it was', async () => {
    const s = setup();
    const out = await updateItems(s.deps, 'plugin', ['acf']);
    expect(out.results.map((r) => r.stdout)).toContain('acf: 6.2 to 6.3');
    expect(out.failed).toEqual([]);
    expect(readFileSync(join(s.folder, 'acf.php'), 'utf8')).toBe('<?php // 6.3');
    expect(listFileTrash(s.deps.trash, s.deps.site)).toHaveLength(1);
    // WP-CLI runs as you, with nothing of the site loaded.
    const update = s.fake.calls.find((c) => c.args.includes('update'));
    expect(update?.args).toEqual(expect.arrayContaining(['plugin', 'update', 'acf', '--skip-plugins', '--skip-themes']));
    await undoUpdates(s.deps, out.updated);
    expect(readFileSync(join(s.folder, 'acf.php'), 'utf8')).toBe('<?php // 6.2');
    expect(existsSync(join(s.folder, 'includes', 'old.php'))).toBe(true);
    expect(existsSync(join(s.folder, 'includes', 'new.php'))).toBe(false);
  });

  it('puts the version from before back when the update fails or does not match the checksums, and goes on', async () => {
    const failed = setup(async () => {
      return { code: 1, stderr: 'Error: Download failed.' };
    });
    const a = await updateItems(failed.deps, 'plugin', ['acf']);
    expect(a.failed).toEqual(['acf']);
    expect(a.results.map((r) => r.stdout).join('\n')).toContain('warn: acf was not updated: Download failed.; 6.2 is back');
    expect(readFileSync(join(failed.folder, 'acf.php'), 'utf8')).toBe('<?php // 6.2');

    const differs = setup(undefined, { code: 1, stderr: "Warning: File doesn't verify against checksum: acf.php" });
    const b = await updateItems(differs.deps, 'plugin', ['acf']);
    expect(b.results.map((r) => r.stdout).join('\n')).toContain("warn: acf 6.3 did not match WordPress.org's checksums, so 6.2 is back");
    expect(readFileSync(join(differs.folder, 'acf.php'), 'utf8')).toBe('<?php // 6.2');
    expect(existsSync(join(differs.folder, 'includes', 'new.php'))).toBe(false);
  });

  it('leaves a link and a missing folder as they are, and says to commit one that is in a repo', async () => {
    const s = setup();
    mkdirSync(join(s.docroot, 'elsewhere'));
    symlinkSync(join(s.docroot, 'elsewhere'), join(s.docroot, 'wp-content', 'plugins', 'linked'));
    const out = await updateItems(s.deps, 'plugin', ['linked', 'gone']);
    expect(out.results.map((r) => r.stdout)).toEqual(expect.arrayContaining([
      'linked: wp-content/plugins/linked is a link: update it where it points; left as it is',
      'gone: no folder wp-content/plugins/gone: update it where it is kept; left as it is',
    ]));
    expect(s.fake.calls.some((c) => c.args.includes('update'))).toBe(false);

    const tracked = setup();
    tracked.fake.calls.length = 0;
    const inRepo = await updateItems({ ...tracked.deps, exec: async (file, args, options) => (file === 'git' ? { code: 0, stdout: 'acf.php\n', stderr: '' } : tracked.deps.exec(file, args, options)) }, 'plugin', ['acf']);
    expect(inRepo.results.map((r) => r.stdout)).toContain('acf: 6.2 to 6.3; it is in a git repo, so commit the update there');
  });
});

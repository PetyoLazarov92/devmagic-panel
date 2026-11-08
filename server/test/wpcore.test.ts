import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installedCores, keepRepoIndex, parseWpcoreConf } from '../src/wpcore.js';
import { fakeExec } from './helpers.js';

describe('parseWpcoreConf', () => {
  it('reads the quoted values wpcore init writes', () => {
    const conf = parseWpcoreConf('# wpcore\nCORES_DIR="/var/www/wp-cores"\nSITES_DIR="/var/www"\nSITE_PREFIX="local."\nWP_CLI="wp"\n');
    expect(conf).toEqual({ coresDir: '/var/www/wp-cores', sitesDir: '/var/www', sitePrefix: 'local.' });
  });

  it('accepts unquoted and single-quoted values, and falls back to defaults', () => {
    expect(parseWpcoreConf("CORES_DIR=/srv/cores\nSITES_DIR='/srv/www'\n")).toMatchObject({ coresDir: '/srv/cores', sitesDir: '/srv/www', sitePrefix: 'local.' });
    expect(parseWpcoreConf('')).toMatchObject({ coresDir: '/var/www/wp-cores' });
  });
});

describe('installedCores', () => {
  it('lists version folders newest first and ignores the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cores-'));
    for (const d of ['6.8.3', '7.1.3', '7.0.10', '7.0.4', 'tmp']) mkdirSync(join(dir, d));
    expect(installedCores(dir)).toEqual(['7.1.3', '7.0.10', '7.0.4', '6.8.3']);
  });
});

describe('keepRepoIndex', () => {
  /** A site folder whose index.php is wpcore's link to a core, or a file. */
  function site(index: 'link' | 'file') {
    const root = mkdtempSync(join(tmpdir(), 'dmp-index-'));
    const docroot = join(root, 'local.wandworks.example');
    mkdirSync(join(root, 'wp-cores/7.1.4'), { recursive: true });
    mkdirSync(docroot);
    writeFileSync(join(root, 'wp-cores/7.1.4/index.php'), '<?php\n');
    if (index === 'link') symlinkSync(join(root, 'wp-cores/7.1.4/index.php'), join(docroot, 'index.php'));
    else writeFileSync(join(docroot, 'index.php'), '<?php\n');
    return docroot;
  }

  it("puts the repo's index.php back over wpcore's link", async () => {
    const docroot = site('link');
    const fake = fakeExec({ git: {} });
    expect(await keepRepoIndex(fake.exec, docroot)).toEqual({ code: 0, stdout: "index.php is the repo's own again, not a link to the core", stderr: '' });
    expect(fake.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([
      `git -C ${docroot} ls-files --error-unmatch -- index.php`,
      `git -C ${docroot} checkout -- index.php`,
    ]);
  });

  it('keeps the link when the repo does not track index.php, or the folder is no repo', async () => {
    const docroot = site('link');
    const fake = fakeExec({ [`git -C ${docroot} ls-files`]: { code: 1, stderr: "error: pathspec 'index.php' did not match any file(s) known to git" } });
    expect(await keepRepoIndex(fake.exec, docroot)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(fake.calls).toHaveLength(1);
  });

  it('runs no git when index.php is a file already, or missing', async () => {
    const fake = fakeExec();
    expect((await keepRepoIndex(fake.exec, site('file'))).code).toBe(0);
    expect((await keepRepoIndex(fake.exec, join(tmpdir(), 'dmp-no-such-site'))).code).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('never fails the step when git cannot put it back: the link works as before', async () => {
    const docroot = site('link');
    const fake = fakeExec({ git: {}, [`git -C ${docroot} checkout`]: { code: 1, stderr: 'error: unable to unlink old index.php: Permission denied\n' } });
    expect(await keepRepoIndex(fake.exec, docroot)).toEqual({
      code: 0,
      stdout: "index.php stays a link to the core, as git could not put the repo's back: error: unable to unlink old index.php: Permission denied",
      stderr: '',
    });
  });
});

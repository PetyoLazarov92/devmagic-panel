import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selfChecks } from '../src/self-check.js';

/** A checkout, its installed root scripts and install.sh's list, all in a temp folder. */
function installed() {
  const root = mkdtempSync(join(tmpdir(), 'dmp-self-'));
  const repo = join(root, 'repo');
  const prefix = join(root, 'prefix');
  const state = join(root, 'state');
  const put = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  for (const name of ['dmp-root', 'dmp-restore', 'wpcore']) {
    put(join(repo, 'scripts', 'bin', name), `#!/bin/bash\n# ${name}\n`);
    put(join(prefix, 'bin', name), `#!/bin/bash\n# ${name}\n`);
  }
  put(join(repo, 'scripts', 'lib', 'trash.sh'), 'trash v1\n');
  put(join(prefix, 'lib', 'trash.sh'), 'trash v1\n');
  put(join(repo, 'package.json'), '{"version":"0.5.0"}');
  put(join(repo, 'server', 'src', 'index.ts'), 'code');
  put(join(repo, 'server', 'dist', 'index.js'), 'built');
  put(join(repo, 'web', 'dist', 'index.html'), 'built');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(repo, 'server', 'src', 'index.ts'), old, old);
  const sudoers = join(root, 'sudoers');
  put(sudoers, 'rule');
  put(join(state, 'installed-files'), `file\t${sudoers}\tremove\tsudoers rule\ndir\t${join(root, 'site-cert')}\tkeep\ta site's certificate\n`);
  const ctx = { repo, version: '0.5.0', stateDir: state, dmpRoot: join(prefix, 'bin', 'dmp-root') };
  return { root, repo, prefix, sudoers, ctx, put };
}

const status = (checks: ReturnType<typeof selfChecks>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('the panel checks its own installation', () => {
  it('is ok when every listed file is there, the root scripts match and the build is newer than the code', () => {
    const t = installed();
    // A site certificate the list keeps may go with its site; only files to remove on uninstall count.
    expect(status(selfChecks(t.ctx))).toEqual({ 'panel.files': 'ok', 'panel.scripts': 'ok', 'panel.build': 'ok' });
  });

  it('names a missing file, a changed root script, and code newer than its build', () => {
    const t = installed();
    rmSync(t.sudoers);
    t.put(join(t.repo, 'scripts', 'lib', 'trash.sh'), 'trash v2\n');
    t.put(join(t.repo, 'server', 'src', 'index.ts'), 'newer code');
    const built = new Date(Date.now() - 60_000);
    for (const f of [join(t.repo, 'server', 'dist', 'index.js'), join(t.repo, 'web', 'dist', 'index.html')]) utimesSync(f, built, built);
    const checks = selfChecks(t.ctx);
    expect(checks.find((c) => c.id === 'panel.files')).toMatchObject({ status: 'fail', detail: `missing: ${t.sudoers}. Run ${join(t.repo, 'install.sh')} to put them back` });
    expect(checks.find((c) => c.id === 'panel.scripts')).toMatchObject({ status: 'warn', detail: expect.stringContaining('lib/trash.sh changed since the last install') });
    expect(checks.find((c) => c.id === 'panel.build')).toMatchObject({ status: 'warn', detail: expect.stringContaining('the code changed after the last build') });
  });

  it('says when the code is a newer version than the running server, and when there is no list yet', () => {
    const t = installed();
    t.put(join(t.repo, 'package.json'), '{"version":"0.6.0"}');
    rmSync(join(t.ctx.stateDir, 'installed-files'));
    const checks = selfChecks(t.ctx);
    expect(checks.find((c) => c.id === 'panel.build')?.detail).toBe('running v0.5.0, the code is v0.6.0: run ./install.sh to build and restart');
    expect(checks.find((c) => c.id === 'panel.files')).toMatchObject({ status: 'warn', detail: expect.stringContaining('no list of installed files yet') });
  });

  it('for a release, points at its installer through current and reads the build from release.json', () => {
    const t = installed();
    const release = join(t.root, 'data', 'releases', 'v0.5.0');
    const scripts = join(release, 'scripts');
    t.put(join(release, 'release.json'), JSON.stringify({ name: 'v0.5.0', version: '0.5.0', commit: 'abc', built: '2026-10-25T09:00:00Z', installer: 'x', scripts: {} }));
    for (const name of ['dmp-root', 'dmp-restore', 'wpcore']) t.put(join(scripts, 'bin', name), `#!/bin/bash\n# ${name}\n`);
    t.put(join(scripts, 'lib', 'trash.sh'), 'trash v2\n');
    rmSync(t.sudoers);
    const checks = selfChecks({ ...t.ctx, repo: release });
    const command = join(t.root, 'data', 'current', 'install.sh');
    expect(checks.find((c) => c.id === 'panel.files')?.detail).toBe(`missing: ${t.sudoers}. Run ${command} to put them back`);
    expect(checks.find((c) => c.id === 'panel.scripts')?.detail).toContain(`lib/trash.sh changed since the last install: run ${command}`);
    expect(checks.find((c) => c.id === 'panel.build')).toMatchObject({ status: 'ok', detail: expect.stringContaining('release v0.5.0, built') });
  });
});

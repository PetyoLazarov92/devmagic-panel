import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { autostartEntry, autostartFile, encryptedHome, missingPaths, readAutostart, startEnabled, writeAutostart } from '../src/autostart.js';
import { checkEnvironment } from '../src/environment.js';
import { Jobs } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, healthyResponses, tempTree } from './helpers.js';

const mount = (point: string, type: string) => `/home/.ecryptfs/alex/.Private ${point} ${type} rw,nosuid,nodev,relatime 0 0`;

describe('encryptedHome', () => {
  it('sees a home folder on eCryptfs, itself or under an encrypted /home', () => {
    const t = tempTree();
    t.write('mounts', ['/dev/nvme0n1p2 / ext4 rw 0 0', mount('/home/alex', 'ecryptfs')].join('\n'));
    expect(encryptedHome('/home/alex', t.hostPaths.mounts)).toBe(true);
    expect(encryptedHome('/home/sam', t.hostPaths.mounts)).toBe(false);
    t.write('mounts', mount('/home', 'ecryptfs'));
    expect(encryptedHome('/home/alex', t.hostPaths.mounts)).toBe(true);
  });

  it('ignores an encrypted Private folder, another filesystem and a missing mounts file', () => {
    const t = tempTree();
    t.write('mounts', [mount('/home/alex/Private', 'ecryptfs'), '/dev/sda1 /home/alex ext4 rw 0 0'].join('\n'));
    expect(encryptedHome('/home/alex', t.hostPaths.mounts)).toBe(false);
    expect(encryptedHome('/home/alex', join(t.root, 'none'))).toBe(false);
  });

  it('reads a space in the path as /proc/mounts writes it', () => {
    const t = tempTree();
    t.write('mounts', mount('/home/alex\\040morgan', 'ecryptfs'));
    expect(encryptedHome('/home/alex morgan', t.hostPaths.mounts)).toBe(true);
  });
});

describe('the autostart entry', () => {
  it('runs the panel CLI with the panel node, quoting a path with a space, and reads back the same command', () => {
    const t = tempTree();
    const cli = join(t.root, 'data dir', 'current', 'server', 'dist', 'cli.js');
    const text = autostartEntry('/usr/local/bin/node', cli);
    expect(text).toContain(`Exec=/usr/local/bin/node --disable-warning=ExperimentalWarning "${cli}" autostart\n`);
    expect(text).toContain('X-GNOME-Autostart-enabled=true');
    writeAutostart(t.hostPaths.home, '/usr/local/bin/node', cli);
    expect(readAutostart(t.hostPaths.home)).toEqual({ command: ['/usr/local/bin/node', '--disable-warning=ExperimentalWarning', cli, 'autostart'], off: false });
  });

  it('names the paths that are gone and sees an entry turned off', () => {
    const t = tempTree();
    const cli = join(t.root, 'cli.js');
    writeFileSync(cli, '');
    writeAutostart(t.hostPaths.home, join(t.root, 'node-gone'), cli);
    const state = readAutostart(t.hostPaths.home);
    expect(state && missingPaths(state)).toEqual([join(t.root, 'node-gone')]);
    writeFileSync(autostartFile(t.hostPaths.home), `${readFileSync(autostartFile(t.hostPaths.home), 'utf8')}Hidden=true\n`);
    expect(readAutostart(t.hostPaths.home)?.off).toBe(true);
    expect(readAutostart(join(t.root, 'nobody'))).toBeNull();
  });
});

describe('startEnabled', () => {
  it('reloads the user services, then starts each of the panel that is enabled', async () => {
    const { exec, calls } = fakeExec({
      'systemctl --user is-enabled devmagic-panel.service': { stdout: 'enabled\n' },
      'systemctl --user is-enabled devmagic-panel-mailpit.service': { code: 1, stdout: 'not-found\n' },
    });
    await startEnabled(exec);
    expect(calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user is-enabled devmagic-panel.service',
      'systemctl --user start devmagic-panel.service',
      'systemctl --user is-enabled devmagic-panel-mailpit.service',
    ]);
  });
});

describe('panel.autostart', () => {
  it('writes the entry in the home folder, with the node that runs the panel', async () => {
    const t = tempTree();
    const { exec } = fakeExec();
    const store = new RunStore(':memory:');
    const ctx: ActionContext = {
      config: t.config, exec, store, dmpRoot: DMP, wpcoreBin: 'wpcore', wpcoreConf: t.hostPaths.wpcoreConf, home: t.hostPaths.home,
      jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    };
    const result = await runAction(ctx, 'panel.autostart', {});
    expect(result.ok).toBe(true);
    const state = readAutostart(t.hostPaths.home);
    expect(state?.command[0]).toBe(process.execPath);
    expect(state?.command.at(-2)).toMatch(/cli\.js$/);
    expect(state?.command.at(-1)).toBe('autostart');
  });
});

describe('the Environment check', () => {
  const report = async (t: ReturnType<typeof tempTree>) => {
    const { exec } = fakeExec(healthyResponses());
    const r = await checkEnvironment({ config: t.config, exec, secrets: null, paths: t.hostPaths, dmpRoot: DMP });
    return r.checks.find((c) => c.id === 'panel.autostart');
  };

  it('is not there on a home folder that is not encrypted', async () => {
    expect(await report(tempTree())).toBeUndefined();
  });

  it('warns on an encrypted home with no entry, with the fix that writes it', async () => {
    const t = tempTree();
    t.write('mounts', mount(t.hostPaths.home, 'ecryptfs'));
    const check = await report(t);
    expect(check).toMatchObject({ group: 'panel', status: 'warn' });
    expect(check?.detail).toContain('https://local.devmagic shows Service Unavailable');
    expect(check?.fixes).toEqual([{ action: 'panel.autostart', input: {}, label: 'Start them after login' }]);
  });

  it('is ok with a working entry, and offers to write it again once its node is gone or to turn it on', async () => {
    const t = tempTree();
    t.write('mounts', mount(t.hostPaths.home, 'ecryptfs'));
    const cli = join(t.root, 'cli.js');
    writeFileSync(cli, '');
    writeAutostart(t.hostPaths.home, process.execPath, cli);
    expect((await report(t))?.status).toBe('ok');

    const file = autostartFile(t.hostPaths.home);
    writeFileSync(file, readFileSync(file, 'utf8').replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
    expect((await report(t))?.fixes?.[0]?.label).toBe('Turn it on again');

    writeAutostart(t.hostPaths.home, join(t.root, 'node-gone'), cli);
    const gone = await report(t);
    expect(gone?.status).toBe('warn');
    expect(gone?.detail).toContain('node-gone, which is gone');
    expect(gone?.fixes?.[0]?.label).toBe('Write it again');
  });

  it('keeps checking an entry that is there after the home is no longer encrypted', async () => {
    const t = tempTree();
    mkdirSync(join(t.hostPaths.home, '.config', 'autostart'), { recursive: true });
    writeAutostart(t.hostPaths.home, join(t.root, 'node-gone'), join(t.root, 'cli.js'));
    expect(existsSync(autostartFile(t.hostPaths.home))).toBe(true);
    expect((await report(t))?.status).toBe('warn');
  });
});

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
import { RunStore } from '../src/store.js';
import { helperInstalled, helperPath, runHelper, windowsDrive, windowsDrives, windowsHostsPairs, windowsPath } from '../src/windows.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const HELPER = 'C:\\Program Files\\devmagic-panel\\dmp-win.ps1';

/** WSL 2 with the helper in place and interop registered, unless told otherwise. */
function setup({ wsl = true, helper = true, interop = true, repair = 0 } = {}) {
  const t = tempTree();
  if (wsl) t.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
  if (helper) t.write('dmp-win.ps1', '# the helper');
  mkdirSync(join(t.root, 'binfmt_misc'), { recursive: true });
  if (interop) t.write('binfmt_misc/WSLInterop');
  t.write(
    'hosts',
    `127.0.0.1 localhost\n10.0.0.5 nas.wandworks.test\n${HOSTS_BEGIN}\n127.0.0.1 local.spellbook.example www.local.spellbook.example\n127.0.0.2 local.wandworks-store.example\n10.0.0.9 local.odd.test\n${HOSTS_END}\n`,
  );
  const powershell = `${join(t.root, 'Windows')}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  const fake = fakeExec({
    [powershell]: { stdout: 'ok: done\n' },
    [`sudo -n ${DMP} wsl-interop`]: repair === 0 ? { stdout: 'ok: interop with Windows programs is registered again\n' } : { code: repair, stderr: 'error: this is not WSL\n' },
  });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '', wpcoreConf: '', home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    windows: { ...t.hostPaths.windows, kernelRelease: join(t.root, 'osrelease'), binfmtDir: join(t.root, 'binfmt_misc') },
  };
  return { ...t, ctx, calls: fake.calls, powershell };
}

// /proc/mounts as WSL 2.6 writes it, with C:, D: and a drive on a custom automount root with a space.
const MOUNTS = [
  'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/ 0 0',
  'D:\\134 /mnt/d 9p rw,noatime,aname=drvfs;path=D:\\;uid=1000;gid=1000;symlinkroot=/mnt/ 0 0',
  'E:\\134 /win\\040drives/e drvfs rw,noatime,path=E:\\ 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
].join('\n');

describe('windowsDrives', () => {
  it("reads WSL's drives from /proc/mounts, wherever they are mounted", () => {
    expect(windowsDrives(MOUNTS)).toEqual([
      { letter: 'C', mount: '/mnt/c' },
      { letter: 'D', mount: '/mnt/d' },
      { letter: 'E', mount: '/win drives/e' },
    ]);
  });
});

describe('windowsDrive', () => {
  it('finds the drive Windows runs from, also when it is not C:', () => {
    const t = tempTree();
    mkdirSync(join(t.root, 'c'), { recursive: true });
    mkdirSync(join(t.root, 'd/Windows/System32/WindowsPowerShell/v1.0'), { recursive: true });
    t.write('d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    t.write('mounts', `C:\\134 ${join(t.root, 'c')} 9p rw,aname=drvfs;path=C:\\ 0 0\nD:\\134 ${join(t.root, 'd')} 9p rw,aname=drvfs;path=D:\\ 0 0\n`);
    const paths = { mounts: join(t.root, 'mounts') };
    expect(windowsDrive(paths)).toEqual({ letter: 'D', mount: join(t.root, 'd') });
    expect(helperPath(paths)).toBe(`${join(t.root, 'd')}/Program Files/devmagic-panel/dmp-win.ps1`);
  });

  it('finds none when no drive has Windows, and the helper is then not installed', () => {
    const t = tempTree();
    t.write('mounts', 'tmpfs /run tmpfs rw 0 0\n');
    expect(windowsDrive({ mounts: join(t.root, 'mounts') })).toBeNull();
    expect(helperInstalled({ mounts: join(t.root, 'mounts') })).toBe(false);
  });
});

describe('windowsPath', () => {
  it('turns a WSL path on a Windows drive into a Windows path, by the drives WSL mounts', () => {
    const drives = windowsDrives(MOUNTS);
    expect(windowsPath('/mnt/c/Program Files/devmagic-panel/dmp-win.ps1', drives)).toBe('C:\\Program Files\\devmagic-panel\\dmp-win.ps1');
    expect(windowsPath('/mnt/d', drives)).toBe('D:\\');
    expect(windowsPath('/win drives/e/Program Files/x.ps1', drives)).toBe('E:\\Program Files\\x.ps1');
  });

  it('refuses a path on no Windows drive, and one only starting like a drive', () => {
    expect(() => windowsPath('/home/alex/dmp-win.ps1')).toThrow('not on a Windows drive');
    expect(() => windowsPath('/mnt/cdrom/x.ps1')).toThrow('not on a Windows drive');
  });
});

describe('runHelper', () => {
  it('runs Windows PowerShell by full path, from a Windows folder, with the helper and an argument array', async () => {
    const s = setup();
    await runHelper(s.ctx.exec, s.ctx.windows!, 'hosts-sync', ['local.shop.com=127.0.0.1']);
    expect(s.calls[0]).toMatchObject({ file: s.powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, 'hosts-sync', 'local.shop.com=127.0.0.1'] });
  });

  it('refuses an argument the helper would refuse, before Windows sees it', async () => {
    const s = setup();
    await expect(runHelper(s.ctx.exec, s.ctx.windows!, 'hosts-sync', ['local.shop.com=127.0.0.1 && calc'])).rejects.toThrow('not an argument');
    await expect(runHelper(s.ctx.exec, s.ctx.windows!, 'status', ['LOCAL.shop.com'])).rejects.toThrow('not an argument');
    await expect(runHelper(s.ctx.exec, s.ctx.windows!, 'wsl-restart' as never)).rejects.toThrow('not a helper command');
    expect(s.calls).toEqual([]);
  });
});

describe('windowsHostsPairs', () => {
  it("takes every name in the panel's block on the panel's addresses, and nothing outside it", () => {
    const s = setup();
    expect(windowsHostsPairs(s.config)).toEqual([
      'local.spellbook.example=127.0.0.1',
      'www.local.spellbook.example=127.0.0.1',
      'local.wandworks-store.example=127.0.0.2',
    ]);
  });
});

describe('the windows actions', () => {
  it("windows.hostsSync hands the helper this distro's names", async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'windows.hostsSync', {});
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(s.calls[0]?.args.slice(6)).toEqual(['hosts-sync', 'local.spellbook.example=127.0.0.1', 'www.local.spellbook.example=127.0.0.1', 'local.wandworks-store.example=127.0.0.2']);
  });

  it('windows.trustCa and windows.autostart run their helper command', async () => {
    const s = setup();
    await runAction(s.ctx, 'windows.trustCa', {});
    await runAction(s.ctx, 'windows.autostart', {});
    expect(s.calls.map((c) => c.args[6])).toEqual(['ca-trust', 'autostart-install']);
  });

  it('are refused outside WSL 2, and before get.ps1 put the helper in place', async () => {
    const notWsl = setup({ wsl: false });
    expect(await runAction(notWsl.ctx, 'windows.trustCa', {})).toMatchObject({ ok: false, output: expect.stringContaining('not WSL 2') });
    const noHelper = setup({ helper: false });
    expect(await runAction(noHelper.ctx, 'windows.hostsSync', {})).toMatchObject({ ok: false, output: expect.stringContaining('run get.ps1') });
    expect([...notWsl.calls, ...noHelper.calls]).toEqual([]);
  });

  it('wsl.repairInterop goes through dmp-root, which registers it again', async () => {
    const s = setup();
    await runAction(s.ctx, 'wsl.repairInterop', {});
    expect(s.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', DMP, 'wsl-interop'] });
  });

  it('registers interop again first when another distro took it away, then runs the step', async () => {
    const s = setup({ interop: false });
    expect(await runAction(s.ctx, 'windows.trustCa', {})).toMatchObject({ ok: true });
    expect(s.calls.map((c) => (c.file === 'sudo' ? c.args[2] : c.args[6]))).toEqual(['wsl-interop', 'ca-trust']);
  });

  it('runs no Windows step when interop cannot be registered again', async () => {
    const s = setup({ interop: false, repair: 1 });
    expect(await runAction(s.ctx, 'windows.trustCa', {})).toMatchObject({ ok: false });
    expect(s.calls.some((c) => c.file === s.powershell)).toBe(false);
  });

  it('leaves interop alone when it is registered', async () => {
    const s = setup();
    await runAction(s.ctx, 'windows.autostart', {});
    expect(s.calls.some((c) => c.file === 'sudo')).toBe(false);
  });
});

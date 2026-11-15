import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followWindowsHosts, followWindowsPortproxy, runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { helperInstalled, helperPath, keepInterop, openWindowsTerminal, runHelper, windowsDrive, windowsDrives, windowsHostsPairs, windowsPath, windowsPortproxyRules, wslDistro } from '../src/windows.js';
import { DMP, fakeExec, tempTree, wpSiteTree } from './helpers.js';

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

describe('keepInterop', () => {
  const paths = (t: ReturnType<typeof tempTree>) => ({ kernelRelease: join(t.root, 'osrelease'), binfmtDir: join(t.root, 'binfmt_misc'), wslConf: join(t.root, 'wsl.conf') });

  it('registers interop again under WSL 2 when it is gone, and says so', async () => {
    const t = tempTree();
    t.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
    mkdirSync(join(t.root, 'binfmt_misc'), { recursive: true });
    const fake = fakeExec({ [`sudo -n ${DMP} wsl-interop`]: { stdout: 'ok\n' } });
    expect(await keepInterop(fake.exec, DMP, paths(t))).toBe('registered interop with Windows programs again');
    expect(fake.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', DMP, 'wsl-interop'] });
  });

  it('does nothing when it is there, when wsl.conf turns it off, or outside WSL 2', async () => {
    const t = tempTree();
    t.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
    mkdirSync(join(t.root, 'binfmt_misc'), { recursive: true });
    t.write('binfmt_misc/WSLInterop');
    const fake = fakeExec();
    expect(await keepInterop(fake.exec, DMP, paths(t))).toBe('');
    const off = tempTree();
    off.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
    off.write('wsl.conf', '[interop]\nenabled = false\n');
    expect(await keepInterop(fake.exec, DMP, paths(off))).toBe('');
    const ubuntu = tempTree();
    ubuntu.write('osrelease', '6.8.0-48-generic\n');
    expect(await keepInterop(fake.exec, DMP, paths(ubuntu))).toBe('');
    expect(fake.calls).toEqual([]);
  });

  it('throws when dmp-root cannot register it', async () => {
    const t = tempTree();
    t.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
    const fake = fakeExec({ [`sudo -n ${DMP} wsl-interop`]: { code: 1, stderr: 'error: this is not WSL\n' } });
    await expect(keepInterop(fake.exec, DMP, paths(t))).rejects.toThrow('could not register interop again');
  });
});

describe("Windows' hosts block follows a change", () => {
  const status = (block: string[]) => JSON.stringify({ hosts: { path: 'C:\Windows\System32\drivers\etc\hosts', block } });
  const followSetup = (block: string[]) => {
    const s = setup();
    const helper = `${s.powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${HELPER}`;
    const fake = fakeExec({ [`${helper} status`]: { stdout: status(block) }, [`${helper} hosts-sync`]: { stdout: 'ok\n' }, [`sudo -n ${DMP} hosts-add`]: { stdout: 'ok\n' } });
    s.ctx.exec = fake.exec;
    return { ...s, calls: fake.calls };
  };
  const helperCommands = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.file.endsWith('powershell.exe')).map((c) => c.args[6]);

  it("syncs Windows when its block differs, as the windows.hostsSync action in run history", async () => {
    const s = followSetup(['127.0.0.1 local.spellbook.example']);
    await followWindowsHosts(s.ctx);
    expect(helperCommands(s.calls)).toEqual(['status', 'hosts-sync']);
    expect(s.ctx.store.recent(10).map((r) => r.action)).toContain('windows.hostsSync');
  });

  it('asks Windows nothing more when its block is the same already', async () => {
    const s = followSetup(['127.0.0.1 local.spellbook.example', '127.0.0.1 www.local.spellbook.example', '127.0.0.2 local.wandworks-store.example']);
    await followWindowsHosts(s.ctx);
    expect(helperCommands(s.calls)).toEqual(['status']);
  });

  it('does nothing where the app gives no Windows side', async () => {
    const s = followSetup([]);
    const { windows: _windows, ...ctx } = s.ctx;
    await followWindowsHosts(ctx);
    expect(s.calls).toEqual([]);
  });

  it('follows hosts.add by itself once the action is done', async () => {
    const s = followSetup([]);
    const result = await runAction(s.ctx, 'hosts.add', { domain: 'local.shop.com', aliases: [] });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(helperCommands(s.calls)).toEqual(['status', 'hosts-sync']));
  });
});

describe("Windows' relays to nginx", () => {
  const RELAYS = ['127.0.0.2:80=127.0.0.1:8080', '127.0.0.2:443=127.0.0.1:8443'];
  const relaySetup = (rules: string[] | null, nginx: boolean) => {
    const s = setup();
    if (nginx) s.write('nginx/conf.d/devmagic-panel.conf', `${VHOST_MARKER}\n`);
    const helper = `${s.powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${HELPER}`;
    const status = JSON.stringify({ hosts: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', block: [] }, ...(rules ? { portproxy: { rules, ipHelper: 'Running' } } : {}) });
    const fake = fakeExec({ [`${helper} status`]: { stdout: status }, [`${helper} portproxy-on`]: { stdout: 'ok\n' }, [`${helper} portproxy-off`]: { stdout: 'ok\n' } });
    s.ctx.exec = fake.exec;
    return { ...s, calls: fake.calls };
  };
  const helperArgs = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.file.endsWith('powershell.exe')).map((c) => c.args.slice(6).join(' '));

  it("are nginx's ports for Windows, from config.env", () => {
    const s = setup();
    expect(windowsPortproxyRules(s.config)).toEqual(RELAYS);
    expect(windowsPortproxyRules({ ...s.config, NGINX_WSL_HTTP_PORT: 18080, NGINX_WSL_HTTPS_PORT: 18443 })).toEqual(['127.0.0.2:80=127.0.0.1:18080', '127.0.0.2:443=127.0.0.1:18443']);
  });

  it('windows.portproxy relays both ports while nginx is set up, and removes them once it is off', async () => {
    const on = relaySetup([], true);
    expect(await runAction(on.ctx, 'windows.portproxy', {})).toMatchObject({ ok: true });
    expect(helperArgs(on.calls)).toEqual(['portproxy-on 8080 8443']);
    const off = relaySetup([], false);
    await runAction(off.ctx, 'windows.portproxy', {});
    expect(helperArgs(off.calls)).toEqual(['portproxy-off']);
  });

  it('follow nginx being set up, and being turned off, only when Windows differs', async () => {
    const missing = relaySetup([], true);
    await followWindowsPortproxy(missing.ctx);
    expect(helperArgs(missing.calls)).toEqual(['status', 'portproxy-on 8080 8443']);
    expect(missing.ctx.store.recent(10).map((r) => r.action)).toContain('windows.portproxy');
    const there = relaySetup([...RELAYS].reverse(), true);
    await followWindowsPortproxy(there.ctx);
    expect(helperArgs(there.calls)).toEqual(['status']);
    const leftOver = relaySetup(RELAYS, false);
    await followWindowsPortproxy(leftOver.ctx);
    expect(helperArgs(leftOver.calls)).toEqual(['status', 'portproxy-off']);
    const none = relaySetup([], false);
    await followWindowsPortproxy(none.ctx);
    expect(helperArgs(none.calls)).toEqual(['status']);
  });

  it('ask nothing more of a helper older than portproxy', async () => {
    const s = relaySetup(null, true);
    await followWindowsPortproxy(s.ctx);
    expect(helperArgs(s.calls)).toEqual(['status']);
  });
});

describe('a terminal in Windows', () => {
  const DIR = '/var/www/local.shop.com';
  const WSLPATH = { stdout: '\\\\wsl.localhost\\devmagic-panel\\\n' };
  /** Windows' cmd.exe in the test tree, with where answering for the programs Windows has. */
  const desktop = (has: string[], extra: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) => {
    const s = setup();
    const cmd = `${join(s.root, 'Windows')}/System32/cmd.exe`;
    const fake = fakeExec({
      '/usr/bin/wslpath -w /': WSLPATH,
      ...Object.fromEntries(['wt.exe', 'code'].map((p) => [`${cmd} /d /c where ${p}`, has.includes(p) ? { stdout: `C:\\Users\\me\\${p}\r\n` } : { code: 1, stderr: 'INFO: Could not find files' }])),
      [cmd]: { stdout: '' },
      ...extra,
    });
    return { ...s, cmd, fake, paths: s.ctx.windows! };
  };
  const cmdLines = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.file.endsWith('cmd.exe')).map((c) => c.args.join(' '));

  it('reads the distro from wslpath, on current and older WSL', async () => {
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': WSLPATH }).exec)).toBe('devmagic-panel');
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { stdout: '\\\\wsl$\\Ubuntu-24.04\\\n' } }).exec)).toBe('Ubuntu-24.04');
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { stdout: 'C:\\\n' } }).exec)).toBeNull();
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { code: 1, stderr: 'no' } }).exec)).toBeNull();
  });

  it('opens Windows Terminal in a new window at the folder in this distro, from Windows\' own folder', async () => {
    const d = desktop(['wt.exe']);
    expect(await openWindowsTerminal(d.fake.exec, d.paths, DIR)).toMatchObject({ code: 0, stdout: `Opened Windows Terminal in ${DIR} (devmagic-panel)` });
    expect(cmdLines(d.fake.calls)).toEqual(['/d /c where wt.exe', `/d /c wt.exe -w new wsl.exe -d devmagic-panel --cd ${DIR}`]);
  });

  it("opens WSL's own window where Windows has no Windows Terminal", async () => {
    const d = desktop([]);
    expect(await openWindowsTerminal(d.fake.exec, d.paths, DIR)).toMatchObject({ code: 0, stdout: expect.stringContaining('a WSL window') });
    expect(cmdLines(d.fake.calls).at(-1)).toBe(`/d /c start wsl.exe -d devmagic-panel --cd ${DIR}`);
  });

  it('puts nothing on a cmd line that cmd could read as more than words', async () => {
    const d = desktop(['wt.exe', 'code']);
    for (const dir of ['/var/www/a&calc', '/var/www/a b', '/var/www/%PATH%', 'relative', '/var/www/a"b']) {
      expect((await openWindowsTerminal(d.fake.exec, d.paths, dir)).code).toBe(1);
    }
    expect(d.fake.calls).toEqual([]);
  });

  it('says so when it cannot tell the distro, and starts nothing', async () => {
    const d = desktop(['wt.exe'], { '/usr/bin/wslpath -w /': { code: 1, stderr: 'wslpath: not WSL' } });
    expect(await openWindowsTerminal(d.fake.exec, d.paths, DIR)).toMatchObject({ code: 1, stderr: expect.stringContaining('which WSL distro') });
    expect(cmdLines(d.fake.calls)).toEqual([]);
  });

  it('site.openTerminal takes Windows under WSL 2, registering interop first when it is gone, and the desktop elsewhere', async () => {
    const t = wpSiteTree();
    const wsl = setup({ interop: false });
    const cmd = `${join(wsl.root, 'Windows')}/System32/cmd.exe`;
    const fake = fakeExec({ '/usr/bin/wslpath -w /': WSLPATH, [`${cmd} /d /c where`]: { stdout: 'C:\\x\r\n' }, [cmd]: { stdout: '' }, [`sudo -n ${DMP} wsl-interop`]: { stdout: 'ok\n' } });
    const ctx = { ...wsl.ctx, config: t.config, exec: fake.exec };
    expect(await runAction(ctx, 'site.openTerminal', { domain: 'local.shop.com' })).toMatchObject({ ok: true });
    expect(fake.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', DMP, 'wsl-interop'] });
    expect(cmdLines(fake.calls).at(-1)).toMatch(/^\/d \/c wt\.exe -w new wsl\.exe -d devmagic-panel --cd \/.*\/local\.shop\.com$/);
    const linux = fakeExec();
    const { windows: _windows, ...desktopCtx } = { ...wsl.ctx, config: t.config, exec: linux.exec };
    const result = await runAction(desktopCtx, 'site.openTerminal', { domain: 'local.shop.com' });
    expect(linux.calls.some((c) => c.file.endsWith('cmd.exe'))).toBe(false);
    expect(result.ok === false ? result.output : '').toMatch(/desktop session|No terminal found|Opened/);
  });
});

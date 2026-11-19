import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followWindowsHosts, followWindowsPortproxy, runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
import { VHOST_MARKER } from '../src/sites/vhost.js';
import { RunStore } from '../src/store.js';
import { helperInstalled, helperPath, keepInterop, noticeWindowsUpdate, openWindowsTerminal, runHelper, syncWindowsAppVersion, windowsReleaseTag, windowsDrive, windowsDrives, windowsHostsPairs, windowsPath, windowsPortproxyRules, wslDistro } from '../src/windows.js';
import { DMP, fakeExec, tempTree, wpSiteTree } from './helpers.js';
import { actions } from '@devmagic-panel/shared';

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
  const desktop = (has: string[], extra: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}, powershell: { code?: number; stdout?: string; stderr?: string } = { stdout: 'started\r\nfront\r\n' }) => {
    const s = setup();
    const cmd = `${join(s.root, 'Windows')}/System32/cmd.exe`;
    const fake = fakeExec({
      '/usr/bin/wslpath -w /': WSLPATH,
      ...Object.fromEntries(['wt.exe', 'code'].map((p) => [`${cmd} /d /c where ${p}`, has.includes(p) ? { stdout: `C:\\Users\\me\\${p}\r\n` } : { code: 1, stderr: 'INFO: Could not find files' }])),
      [cmd]: { stdout: '' },
      [`${join(s.root, 'Windows')}/System32/WindowsPowerShell/v1.0/powershell.exe`]: powershell,
      ...extra,
    });
    return { ...s, cmd, fake, paths: s.ctx.windows! };
  };
  const cmdLines = (calls: Array<{ file: string; args: string[] }>) => calls.filter((c) => c.file.endsWith('cmd.exe')).map((c) => c.args.join(' '));
  /** The scripts given to PowerShell, decoded. */
  const scripts = (calls: Array<{ file: string; args: string[] }>) =>
    calls.filter((c) => c.file.endsWith('powershell.exe')).map((c) => Buffer.from(c.args.at(-1) as string, 'base64').toString('utf16le'));

  it('reads the distro from wslpath, on current and older WSL', async () => {
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': WSLPATH }).exec)).toBe('devmagic-panel');
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { stdout: '\\\\wsl$\\Ubuntu-24.04\\\n' } }).exec)).toBe('Ubuntu-24.04');
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { stdout: 'C:\\\n' } }).exec)).toBeNull();
    expect(await wslDistro(fakeExec({ '/usr/bin/wslpath -w /': { code: 1, stderr: 'no' } }).exec)).toBeNull();
  });

  it('opens Windows Terminal in a new window at the folder in this distro, in front of the browser', async () => {
    const d = desktop(['wt.exe']);
    expect(await openWindowsTerminal(d.fake.exec, d.paths, DIR)).toMatchObject({ code: 0, stdout: `Opened Windows Terminal in ${DIR} (devmagic-panel)` });
    expect(cmdLines(d.fake.calls)).toEqual(['/d /c where wt.exe']);
    const [script] = scripts(d.fake.calls);
    expect(script).toContain(`Start-Process -FilePath 'wt.exe' -ArgumentList '-w new wsl.exe -d devmagic-panel --cd ${DIR}'`);
    // Its new window found by Windows Terminal's window class, restored and made the foreground window.
    expect(script).toContain("'CASCADIA_HOSTING_WINDOW_CLASS'");
    expect(script).toContain('SetForegroundWindow(h)');
  });

  it('still starts it with cmd.exe when PowerShell cannot, and never twice', async () => {
    // A PowerShell that cannot (a locked-down one): cmd.exe starts it, as before.
    const blocked = desktop(['wt.exe'], {}, { code: 1, stderr: 'Cannot add type. Compilation errors occurred.' });
    expect((await openWindowsTerminal(blocked.fake.exec, blocked.paths, DIR)).code).toBe(0);
    expect(cmdLines(blocked.fake.calls).at(-1)).toBe(`/d /c wt.exe -w new wsl.exe -d devmagic-panel --cd ${DIR}`);
    // Started, but Windows kept it behind: it is open, so nothing starts it again.
    const behind = desktop(['wt.exe'], {}, { stdout: 'started\r\nbehind\r\n' });
    expect((await openWindowsTerminal(behind.fake.exec, behind.paths, DIR)).code).toBe(0);
    expect(cmdLines(behind.fake.calls)).toEqual(['/d /c where wt.exe']);
  });

  it('starts a program in the new tab with wsl.exe --exec, no shell', async () => {
    const d = desktop(['wt.exe']);
    const command = { argv: ['/home/alex/.local/bin/claude', 'auth', 'login'], said: 'claude auth login' };
    expect(await openWindowsTerminal(d.fake.exec, d.paths, DIR, command)).toMatchObject({ code: 0, stdout: `Opened Windows Terminal in ${DIR} (devmagic-panel), running claude auth login: go on there` });
    expect(scripts(d.fake.calls).at(-1)).toContain(`-ArgumentList '-w new wsl.exe -d devmagic-panel --cd ${DIR} --exec /home/alex/.local/bin/claude auth login'`);
    const odd = { argv: ['/home/alex/my claude', '&calc'], said: 'it' };
    expect((await openWindowsTerminal(d.fake.exec, d.paths, DIR, odd)).code).toBe(1);
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
    // Whatever the machine running the tests has: no desktop, no terminal, or a terminal the fake does not start.
    expect(result.ok === false ? result.output : '').toMatch(/desktop session|No terminal found|Opened|did not start/);
  });
});

describe('the Windows part of a release', () => {
  it('is published under the release tag, and a development build has none', () => {
    expect(windowsReleaseTag('1.68.0')).toBe('v1.68.0');
    expect(windowsReleaseTag('1.68.0-rc.1')).toBe('v1.68.0-rc.1');
    expect(windowsReleaseTag('1.67.1-dev.684f1a4')).toBeNull();
    expect(windowsReleaseTag('1.68')).toBeNull();
    expect(windowsReleaseTag('v1.68.0')).toBeNull();
  });

  it('windows.update asks the helper for the setup of this release, or says a dev build has none', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'windows.update', {});
    const call = s.calls.find((c) => c.file.endsWith('powershell.exe'));
    if (windowsReleaseTag(JSON.parse((await import('node:fs')).readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version)) {
      expect(call?.args.slice(6)).toEqual(['update-windows', expect.stringMatching(/^v[0-9]+\.[0-9]+\.[0-9]+/)]);
    } else {
      expect(result).toMatchObject({ ok: false, output: expect.stringContaining('development build') });
      expect(call).toBeUndefined();
    }
  });
});

describe('an update that changes the Windows part', () => {
  it('says so when the release fingerprint differs from what the setup recorded, only for an update the panel installs', async () => {
    const { windowsSideOf } = await import('../src/windows.js');
    const installed = (part: string | null) => ({ hosts: { path: 'x', block: [] }, helper: { sha256: 'a'.repeat(64), repo: 'x' }, app: { version: '1.69.0', part } }) as never;
    const update = { available: true, mode: 'panel', windowsPart: 'c'.repeat(64) };
    expect(windowsSideOf(update, installed('d'.repeat(64)))).toEqual({ changes: true });
    expect(windowsSideOf(update, installed('c'.repeat(64)))).toEqual({ changes: false });
    expect(windowsSideOf(update, installed(null))).toEqual({ changes: true });
    // Nothing to say: no update, one that needs the terminal, a release without the fingerprint, no helper answer.
    expect(windowsSideOf({ ...update, available: false }, installed('d'.repeat(64)))).toBeNull();
    expect(windowsSideOf({ ...update, mode: 'terminal' }, installed('d'.repeat(64)))).toBeNull();
    expect(windowsSideOf({ available: true, mode: 'panel' }, installed('d'.repeat(64)))).toBeNull();
    expect(windowsSideOf(update, null)).toBeNull();
  });

  it('windows.update takes a newer release to install both parts, never an older one', async () => {
    const s = setup();
    await runAction(s.ctx, 'windows.update', { tag: 'v99.0.0' });
    expect(s.calls.find((c) => c.file.endsWith('powershell.exe'))?.args.slice(6)).toEqual(['update-windows', 'v99.0.0']);
    const older = await runAction(setup().ctx, 'windows.update', { tag: 'v0.1.0' });
    expect(older).toMatchObject({ ok: false, output: expect.stringContaining('older than the panel') });
    expect(actions['windows.update'].input.safeParse({ tag: 'v1.70.0;calc' }).success).toBe(false);
  });
});

describe('the version in Apps and features', () => {
  const HELPER_SUM = 'a'.repeat(64);
  const sync = async (app: unknown, helperSum = HELPER_SUM, releaseHelper: string | null = HELPER_SUM) => {
    const s = setup();
    const helper = `${s.powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${HELPER}`;
    const status = JSON.stringify({ hosts: { path: 'x', block: [] }, helper: { sha256: helperSum, repo: 'PetyoLazarov92/devmagic-panel' }, ...(app === undefined ? {} : { app }) });
    const fake = fakeExec({ [`${helper} status`]: { stdout: status }, [`${helper} set-app-version`]: { stdout: 'ok\n' } });
    const note = await syncWindowsAppVersion(fake.exec, s.ctx.windows!, '1.68.2', releaseHelper === null ? null : { windowsHelper: releaseHelper });
    return { note, commands: fake.calls.filter((c) => c.file.endsWith('powershell.exe')).map((c) => c.args.slice(6).join(' ')) };
  };

  it('follows a panel update when the Windows part is this release already', async () => {
    expect(await sync({ version: '1.68.1' })).toEqual({ note: 'Apps and features shows 1.68.2 now (was 1.68.1)', commands: ['status', 'set-app-version 1.68.2'] });
  });

  it('leaves it when it shows this version, when the Windows part needs its own update, and without an entry', async () => {
    expect((await sync({ version: '1.68.2' })).commands).toEqual(['status']);
    expect((await sync({ version: '1.68.1' }, 'b'.repeat(64))).commands).toEqual(['status']);
    expect((await sync({ version: null })).commands).toEqual(['status']);
    expect((await sync(undefined)).commands).toEqual(['status']);
  });

  it('asks Windows nothing for a checkout, whose release names no helper', async () => {
    expect(await sync({ version: '1.68.1' }, HELPER_SUM, null)).toEqual({ note: '', commands: [] });
  });
});

describe('the Windows part', () => {
  it('compares the fingerprint the setup recorded, and the helper for a release from before it', async () => {
    const { windowsPartCurrent } = await import('../src/windows.js');
    const status = (app: unknown, sha256 = 'a'.repeat(64)) => ({ hosts: { path: 'x', block: [] }, helper: { sha256, repo: 'x' }, app }) as never;
    expect(windowsPartCurrent(status({ version: '1', part: 'c' }), { windowsPart: 'c', windowsHelper: 'a'.repeat(64) })).toBe(true);
    expect(windowsPartCurrent(status({ version: '1', part: 'd' }), { windowsPart: 'c', windowsHelper: 'a'.repeat(64) })).toBe(false);
    expect(windowsPartCurrent(status({ version: '1', part: null }), { windowsPart: 'c' })).toBe(false);
    expect(windowsPartCurrent(status(undefined), { windowsHelper: 'a'.repeat(64) })).toBe(true);
    expect(windowsPartCurrent(status(undefined, 'b'.repeat(64)), { windowsHelper: 'a'.repeat(64) })).toBe(false);
    expect(windowsPartCurrent(status(undefined), null)).toBeNull();
  });
});

describe('the Windows notification of a new release', () => {
  const PART = 'c'.repeat(64);
  const out = { available: true, latest: 'v1.69.0', mode: 'panel', changelog: [{ version: '1.69.0', items: ['x'] }] };
  const notice = async (update: Parameters<typeof noticeWindowsUpdate>[2], opts: { part?: string | null; seen?: string; fails?: boolean } = {}) => {
    const s = setup();
    const helper = `${s.powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${HELPER}`;
    const status = JSON.stringify({ hosts: { path: 'x', block: [] }, helper: { sha256: 'a'.repeat(64), repo: 'PetyoLazarov92/devmagic-panel' }, app: { version: '1.68.2', part: opts.part === undefined ? PART : opts.part } });
    const fake = fakeExec({ [`${helper} status`]: { stdout: status }, [`${helper} notify-update`]: opts.fails ? { code: 1, stderr: 'no notifications' } : { stdout: 'ok\n' } });
    let seen = opts.seen;
    const note = await noticeWindowsUpdate(fake.exec, s.ctx.windows!, update, 'https://local.devmagic/update', { windowsPart: PART }, { get: () => seen, set: (tag) => (seen = tag) });
    return { note, seen, commands: fake.calls.filter((c) => c.file.endsWith('powershell.exe')).map((c) => c.args.slice(6).join(' ')) };
  };

  it('shows each new release once, with the Updates page', async () => {
    expect(await notice(out)).toEqual({ note: 'Windows shows that v1.69.0 is out', seen: 'v1.69.0', commands: ['status', 'notify-update v1.69.0 https://local.devmagic/update'] });
    expect((await notice(out, { seen: 'v1.69.0' })).commands).toEqual([]);
    expect((await notice(out, { seen: 'v1.68.3' })).commands).toEqual(['status', 'notify-update v1.69.0 https://local.devmagic/update']);
  });

  it('leaves out what the panel cannot install yet, and an older Windows part', async () => {
    expect((await notice({ available: false, latest: 'v1.68.2', changelog: [] })).commands).toEqual([]);
    expect((await notice({ ...out, changelog: [] })).commands).toEqual([]);
    expect((await notice({ ...out, error: 'could not read' })).commands).toEqual([]);
    expect((await notice({ ...out, mode: 'blocked' })).commands).toEqual([]);
    const older = await notice(out, { part: null });
    expect(older).toMatchObject({ seen: undefined, commands: ['status'] });
    expect(older.note).toContain('older than this panel');
  });

  it('tries again next time when Windows could not show it', async () => {
    const s = notice(out, { fails: true });
    await expect(s).rejects.toThrow('could not show the Windows notification: no notifications');
  });
});

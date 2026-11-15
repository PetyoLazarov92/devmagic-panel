import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs } from '../src/jobs.js';
import { HOSTS_BEGIN, HOSTS_END } from '../src/sites/hosts-block.js';
import { RunStore } from '../src/store.js';
import { runHelper, windowsHostsPairs, windowsPath } from '../src/windows.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const HELPER = 'C:\\Program Files\\devmagic-panel\\dmp-win.ps1';

/** WSL 2 with the helper in place, unless told otherwise. */
function setup({ wsl = true, helper = true } = {}) {
  const t = tempTree();
  if (wsl) t.write('osrelease', '6.6.87.2-microsoft-standard-WSL2\n');
  if (helper) t.write('dmp-win.ps1', '# the helper');
  t.write(
    'hosts',
    `127.0.0.1 localhost\n10.0.0.5 nas.wandworks.test\n${HOSTS_BEGIN}\n127.0.0.1 local.spellbook.example www.local.spellbook.example\n127.0.0.2 local.wandworks-store.example\n10.0.0.9 local.odd.test\n${HOSTS_END}\n`,
  );
  const powershell = `${join(t.root, 'Windows')}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  const fake = fakeExec({ [powershell]: { stdout: 'ok: done\n' } });
  const store = new RunStore(':memory:');
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '', wpcoreConf: '', home: t.hostPaths.home,
    jobs: new Jobs(store), uploadsDir: join(t.root, 'uploads'), secrets: null,
    windows: { ...t.hostPaths.windows, kernelRelease: join(t.root, 'osrelease') },
  };
  return { ...t, ctx, calls: fake.calls, powershell };
}

describe('windowsPath', () => {
  it('turns a WSL path on a Windows drive into a Windows path', () => {
    expect(windowsPath('/mnt/c/Program Files/devmagic-panel/dmp-win.ps1')).toBe('C:\\Program Files\\devmagic-panel\\dmp-win.ps1');
    expect(windowsPath('/mnt/d')).toBe('D:\\');
  });

  it('refuses a path on no Windows drive', () => {
    expect(() => windowsPath('/home/alex/dmp-win.ps1')).toThrow('not on a Windows drive');
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
});

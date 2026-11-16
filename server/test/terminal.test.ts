import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/exec.js';
import { openTerminal, terminalFor } from '../src/terminal.js';
import { fakeExec } from './helpers.js';

/** A PATH folder with these programs in it. */
function bin(...names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dmp-term-'));
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), '');
  return dir;
}

const SITE = '/var/www/local.wandworks.example';

describe('terminalFor', () => {
  it("runs the desktop's default terminal with its own folder option", () => {
    const path = bin('x-terminal-emulator', 'gnome-terminal', 'konsole');
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/gnome-terminal.wrapper' })).toEqual({ file: join(path, 'gnome-terminal'), args: [`--working-directory=${SITE}`], runs: false });
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/konsole' })).toEqual({ file: join(path, 'konsole'), args: ['--workdir', SITE], runs: false });
  });

  it('takes the first known terminal installed when the default is one it does not know, or there is none', () => {
    expect(terminalFor(SITE, { path: bin('x-terminal-emulator', 'kitty'), resolve: () => '/usr/bin/wandworks-term' })?.args).toEqual(['--directory', SITE]);
    expect(terminalFor(SITE, { path: bin('alacritty') })?.args).toEqual(['--working-directory', SITE]);
  });

  it('starts an unknown default without a folder option, as it opens where it is started; none at all is null', () => {
    const path = bin('x-terminal-emulator');
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/wandworks-term' })).toEqual({ file: join(path, 'x-terminal-emulator'), args: [], runs: false });
    expect(terminalFor(SITE, { path: bin() })).toBeNull();
  });

  it("starts a program in the terminals that can be told to, keeping the window open where it can", () => {
    const CMD = ['/home/alex/.local/bin/claude', 'auth', 'login'];
    const path = bin('x-terminal-emulator', 'gnome-terminal', 'konsole', 'ptyxis');
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/gnome-terminal.wrapper' }, CMD)).toEqual({ file: join(path, 'gnome-terminal'), args: [`--working-directory=${SITE}`, '--', ...CMD], runs: true });
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/konsole' }, CMD)?.args).toEqual(['--workdir', SITE, '--hold', '-e', ...CMD]);
    // A terminal it cannot tell opens the folder only, and says so.
    expect(terminalFor(SITE, { path, resolve: () => '/usr/bin/ptyxis' }, CMD)).toMatchObject({ args: ['--new-window', `--working-directory=${SITE}`], runs: false });
    // Debian's x-terminal-emulator takes -e.
    const unknown = bin('x-terminal-emulator');
    expect(terminalFor(SITE, { path: unknown, resolve: () => '/usr/bin/wandworks-term' }, CMD)).toEqual({ file: join(unknown, 'x-terminal-emulator'), args: ['-e', ...CMD], runs: true });
  });
});

describe('openTerminal', () => {
  it('starts it detached in the folder, without the service NODE_ENV', async () => {
    const path = bin('gnome-terminal');
    const fake = fakeExec({ [join(path, 'gnome-terminal')]: {} });
    expect(await openTerminal(fake.exec, SITE, { path, display: ':0' })).toEqual({ code: 0, stdout: `Opened gnome-terminal in ${SITE}`, stderr: '' });
    expect(fake.calls).toEqual([{ file: join(path, 'gnome-terminal'), args: [`--working-directory=${SITE}`], env: { NODE_ENV: undefined }, detach: { cwd: SITE } }]);
  });

  it('says why without a desktop session, without a terminal, or when it does not start', async () => {
    const fake = fakeExec();
    expect((await openTerminal(fake.exec, SITE, { path: bin('gnome-terminal'), display: '', wayland: '' })).stderr).toContain('without a desktop session');
    expect((await openTerminal(fake.exec, SITE, { path: bin(), display: ':0' })).stderr).toContain('No terminal found');
    expect(fake.calls).toEqual([]);
    const path = bin('konsole');
    const failing = fakeExec({ [join(path, 'konsole')]: { code: 127, stderr: 'spawn EACCES\n' } });
    expect(await openTerminal(failing.exec, SITE, { path, wayland: 'wayland-0' })).toEqual({ code: 1, stdout: '', stderr: 'konsole did not start: spawn EACCES' });
  });
});

describe('openTerminal with a program', () => {
  it('says the program runs there, or that you run it yourself', async () => {
    const path = bin('x-terminal-emulator', 'gnome-terminal', 'ptyxis');
    const fake = fakeExec({ [join(path, 'gnome-terminal')]: { stdout: '' }, [join(path, 'ptyxis')]: { stdout: '' } });
    const command = { argv: ['/home/alex/.local/bin/claude', 'auth', 'login'], said: 'claude auth login' };
    const env = (name: string) => ({ path, display: ':0', resolve: () => `/usr/bin/${name}` });
    expect((await openTerminal(fake.exec, SITE, env('gnome-terminal'), command)).stdout).toBe(`Opened gnome-terminal in ${SITE}, running claude auth login: go on there`);
    expect((await openTerminal(fake.exec, SITE, env('ptyxis'), command)).stdout).toContain('run claude auth login in it yourself');
  });
});

describe('a detached program', () => {
  it('answers once it starts, and 127 when it cannot', async () => {
    expect(await runCommand('true', [], { detach: true })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await runCommand(join(tmpdir(), 'dmp-no-such-program'), [], { detach: true })).code).toBe(127);
  });
});

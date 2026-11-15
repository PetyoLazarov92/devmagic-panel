import { afterEach, describe, expect, it } from 'vitest';
import { setVscodeDistro, vscodeUrl } from '../src/lib/vscode';

describe('vscodeUrl', () => {
  afterEach(() => setVscodeDistro(undefined));

  it('opens a local folder in a new window', () => {
    expect(vscodeUrl('/var/www/local.shop.com')).toBe('vscode://file/var/www/local.shop.com?windowId=_blank');
  });

  it("under WSL, opens it through VS Code's WSL remote in the panel's distro", () => {
    setVscodeDistro('devmagic-panel');
    expect(vscodeUrl('/var/www/local.shop.com')).toBe('vscode://vscode-remote/wsl+devmagic-panel/var/www/local.shop.com?windowId=_blank');
  });

  it('takes no distro name that could change the link', () => {
    setVscodeDistro('evil/../x?y');
    expect(vscodeUrl('/var/www/a')).toBe('vscode://file/var/www/a?windowId=_blank');
  });
});

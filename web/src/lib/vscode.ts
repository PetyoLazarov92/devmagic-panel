/** Under WSL, the distro the panel runs in (from the session): folders then open through VS Code's WSL remote. */
let vscodeDistro: string | null = null;
export function setVscodeDistro(distro: string | undefined): void {
  vscodeDistro = distro && /^[A-Za-z0-9._-]{1,64}$/.test(distro) ? distro : null;
}

/**
 * Opens a folder in VS Code through its URL handler. VS Code registers
 * vscode:// when installed, so the browser hands the folder to the editor on
 * the machine you browse from; the panel server runs nothing. windowId=_blank
 * opens a new window instead of reusing the last one. Under WSL the browser
 * runs in Windows and the folder is in the distro: vscode-remote/wsl+<distro>
 * opens it through VS Code's WSL remote (VS Code offers its WSL extension the
 * first time).
 */
export function vscodeUrl(folder: string): string {
  if (vscodeDistro) return `vscode://vscode-remote/wsl+${vscodeDistro}${encodeURI(folder)}?windowId=_blank`;
  return `vscode://file${encodeURI(folder)}?windowId=_blank`;
}

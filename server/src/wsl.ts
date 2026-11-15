import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * Ubuntu under WSL 2 on Windows. The panel runs there as on Ubuntu, but WSL
 * writes /etc/hosts anew at every start unless wsl.conf says
 * generateHosts = false, and forwards an Apache on every address to Windows
 * on ::1 only, one on 127.0.0.1 on 127.0.0.1. install.sh sets both; the
 * Machine checks show when one is off.
 */

export interface WslPaths {
  /** The kernel's name, like 6.6.87.2-microsoft-standard-WSL2; /proc/sys/kernel/osrelease by default. */
  kernelRelease?: string;
  /** /etc/wsl.conf by default. */
  wslConf?: string;
  /** Where WSL registers its interop with Windows programs; /proc/sys/fs/binfmt_misc by default. */
  binfmtDir?: string;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** 2 under WSL 2, 1 under WSL 1, null elsewhere. */
export function wslVersion(paths: WslPaths = {}): 1 | 2 | null {
  const release = read(paths.kernelRelease ?? '/proc/sys/kernel/osrelease') ?? '';
  if (/microsoft-standard|microsoft.*WSL2/i.test(release)) return 2;
  if (/microsoft/i.test(release)) return 1;
  return null;
}

/** The value of key in [section] of an ini file like wsl.conf, lowercased; null when not set. */
export function iniValue(text: string, section: string, key: string): string | null {
  let current = '';
  let value: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) {
      current = head[1]!.toLowerCase();
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair && current === section.toLowerCase() && pair[1]!.toLowerCase() === key.toLowerCase()) value = pair[2]!.trim().toLowerCase();
  }
  return value;
}

/** True when wsl.conf keeps /etc/hosts as it is: [network] generateHosts = false. */
export function hostsKept(paths: WslPaths = {}): boolean {
  const text = read(paths.wslConf ?? '/etc/wsl.conf');
  return text !== null && iniValue(text, 'network', 'generateHosts') === 'false';
}

/** True when wsl.conf turns interop off on purpose ([interop] enabled = false), which only a person changes. */
export function interopDisabled(paths: WslPaths = {}): boolean {
  const text = read(paths.wslConf ?? '/etc/wsl.conf');
  return text !== null && iniValue(text, 'interop', 'enabled') === 'false';
}

/** True when Windows programs can be started from this distro (WSLInterop registered in binfmt_misc). */
export function interopOn(paths: WslPaths = {}): boolean {
  const dir = paths.binfmtDir ?? '/proc/sys/fs/binfmt_misc';
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => name.startsWith('WSLInterop'));
  } catch {
    return false;
  }
}

/**
 * The Listen lines of Apache's ports.conf for port 80 or 443 that are not on
 * address, like "Listen 80" or "Listen [::]:443"; none means Apache answers
 * on that address only.
 */
export function listensOffAddress(portsConf: string, address: string): string[] {
  const text = read(portsConf);
  if (text === null) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^Listen\s+/i.test(line))
    .filter((line) => {
      const spec = line.split(/\s+/)[1] ?? '';
      const port = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
      return (port === '80' || port === '443') && !spec.startsWith(`${address}:`);
    });
}

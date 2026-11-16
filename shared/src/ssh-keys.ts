/** A file name in a .ssh folder the panel works with: no path, no option, no hidden file. */
export const SSH_KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** An SSH key the panel found, tested against GitHub. The private key itself is never read into the panel. */
export interface SshKey {
  /** The private key's file name. */
  name: string;
  /** In this machine's ~/.ssh, or (under WSL) in Windows' %USERPROFILE%\.ssh. */
  where: 'here' | 'windows';
  /** Like ED25519 or RSA, with its size in bits. */
  type: string;
  bits: number;
  fingerprint: string;
  comment?: string;
  /** It has a passphrase, which the panel cannot type: it can use it only when an agent holds it. */
  passphrase: boolean;
  /** The GitHub account that knows this key; null: GitHub does not; absent: not tested (a passphrase). */
  github?: string | null;
  /** The public key line, for a key here, to copy into GitHub's settings. */
  publicKey?: string;
  /** Windows' .ssh/config names it for github.com. */
  windowsForGithub?: boolean;
  /** A Windows key copied here already, under this name. */
  copiedAs?: string;
}

export interface SshKeysReport {
  keys: SshKey[];
  /** The key here the panel clones GitHub repos with over SSH; absent: ssh's own choice. */
  chosen?: string;
  /** How GitHub repos clone. */
  way: 'https' | 'ssh';
  /** Under WSL: whether Windows' keys could be read. */
  windows?: 'read' | 'unreachable';
}

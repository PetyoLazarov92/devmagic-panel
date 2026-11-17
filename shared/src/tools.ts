/**
 * Programs the panel installs as you, without root: each a release the panel
 * pins, checked against the SHA-256 its project publishes for it. One list for
 * the panel and install.sh; a release of the panel moves a pin.
 */
export interface PinnedTool {
  /** What Machine checks calls it. */
  name: string;
  version: string;
  /** The release archive, with {version} and {arch} (amd64 or arm64) filled in. */
  url: string;
  /** The program inside the archive, the only file taken from it. */
  member: string;
  /** A .zip (unpacked with unzip); a .tar.gz when left out. */
  archive?: 'zip';
  sha256: { amd64: string; arm64: string };
}

export const TOOLS = {
  gh: {
    name: 'GitHub CLI',
    version: '2.104.0',
    url: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_{arch}.tar.gz',
    member: 'gh_{version}_linux_{arch}/bin/gh',
    sha256: {
      amd64: '98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e',
      arm64: 'cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3',
    },
  },
  glab: {
    name: 'GitLab CLI',
    version: '1.130.0',
    url: 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/{version}/glab_{version}_linux_{arch}.tar.gz',
    member: 'bin/glab',
    sha256: {
      amd64: 'ce06313b2075af25180cd195ab3496d42bc5857c85a1c12ba996838dfe9d822c',
      arm64: '062d53acb0f2cbcc79a014600df1aa0fb440bb3a08a5d4900d3b49b553b22767',
    },
  },
  rclone: {
    name: 'rclone',
    version: '1.76.0',
    url: 'https://github.com/rclone/rclone/releases/download/v{version}/rclone-v{version}-linux-{arch}.zip',
    member: 'rclone-v{version}-linux-{arch}/rclone',
    archive: 'zip',
    sha256: {
      amd64: 'b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7',
      arm64: 'ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78',
    },
  },
} as const satisfies Record<string, PinnedTool>;

export type ToolId = keyof typeof TOOLS;
export const TOOL_IDS = Object.keys(TOOLS) as [ToolId, ...ToolId[]];
export type ToolArch = keyof PinnedTool['sha256'];

/** A pinned tool's archive URL or archive member for one processor. */
export const toolText = (template: string, tool: Pick<PinnedTool, 'version'>, arch: ToolArch): string =>
  template.replaceAll('{version}', tool.version).replaceAll('{arch}', arch);

/**
 * What Machine checks installs with your sudo password: apt packages from the
 * sources apt already has, and WP-CLI from its pinned release. Nothing else.
 */
export const SYSTEM_INSTALLS = ['nginx', 'composer', 'unzip', 'git', 'wp-cli', 'phpmyadmin'] as const;
export type SystemInstall = (typeof SYSTEM_INSTALLS)[number];

/** WP-CLI, a single PHP file, checked against the SHA-256 its release publishes. */
export const WP_CLI_RELEASE = {
  version: '2.12.0',
  url: 'https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar',
  sha256: 'ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c',
} as const;

/**
 * What a terminal the panel opens may start, by name, never a command line
 * from input: each is a fixed program and its arguments on the server.
 */
export const TERMINAL_RUNS = ['claude-login', 'gh-login', 'glab-login', 'rclone-drive'] as const;
export type TerminalRun = (typeof TERMINAL_RUNS)[number];
export const TERMINAL_RUN_LABELS: Record<TerminalRun, string> = {
  'claude-login': 'claude auth login',
  'gh-login': 'gh auth login',
  'glab-login': 'glab auth login',
  'rclone-drive': 'rclone config create (Google Drive, read only)',
};

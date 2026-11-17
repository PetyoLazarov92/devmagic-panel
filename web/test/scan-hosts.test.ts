import type { OrgStatus } from '@devmagic-panel/shared';
import { DEFAULT_ORG_SETTINGS } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { scanHosts } from '../src/lib/scan-hosts.js';

const status = (over: Partial<OrgStatus> = {}): OrgStatus => ({
  claude: { found: true, signedIn: true, claudeAi: true },
  gh: { installed: true, signedIn: true, user: 'wandworksco' },
  glab: { installed: true, hosts: [{ host: 'gitlab.com', installed: true, signedIn: true, user: 'wandworksco' }, { host: 'git.wandworks.test', installed: true, signedIn: false, problem: 'not signed in to git.wandworks.test' }] },
  rclone: { installed: false },
  settings: { ...DEFAULT_ORG_SETTINGS, gitlabHosts: ['git.wandworks.test'] },
  ...over,
});
const namespaces = [
  { ref: 'wandworks', label: 'wandworks', provider: 'github' as const, host: 'github.com' },
  { ref: 'wandworksco', label: 'wandworksco', provider: 'github' as const, host: 'github.com' },
  { ref: 'gitlab.com/wandworks-web', label: 'wandworks-web', provider: 'gitlab' as const, host: 'gitlab.com' },
];

describe('the hosts of the scan dialog', () => {
  it('lists GitHub, gitlab.com, then your own hosts, each with its state and its organizations', () => {
    const hosts = scanHosts(status(), namespaces, ['wandworks'], ['git.wandworks.test']);
    expect(hosts.map((h) => [h.name, h.state, h.own])).toEqual([
      ['GitHub', 'signed in as wandworksco', false],
      ['gitlab.com', 'signed in as wandworksco', false],
      ['git.wandworks.test', 'not signed in', true],
    ]);
    // Your own account says so.
    expect(hosts[0]?.items.map((i) => i.label)).toEqual(['wandworks', 'wandworksco (your account)']);
    expect(hosts[2]?.commands).toEqual(['glab auth login --hostname git.wandworks.test']);
    expect(hosts[0]?.commands).toEqual([]);
  });

  it('gives the install command first when a CLI is missing, and keeps a ticked organization the CLI no longer lists', () => {
    const hosts = scanHosts(status({ gh: { installed: false, signedIn: false } }), [], ['wandworks'], []);
    const github = hosts.find((h) => h.provider === 'github');
    expect(github?.state).toBe('the GitHub CLI is not installed');
    expect(github?.commands).toEqual(['sudo apt install gh', 'gh auth login']);
    expect(github?.items.map((i) => i.ref)).toEqual(['wandworks']);
  });
});

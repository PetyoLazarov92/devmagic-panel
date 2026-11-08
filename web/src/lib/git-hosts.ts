import { registerGitHosts, registerGitlabHosts, registerHostAliases } from '@devmagic-panel/shared';
import { api } from '@/lib/api';

/**
 * Your own GitLab hosts from the panel's settings, the GitLab and Gitea hosts
 * the panel found over SSH, and SSH aliases with their real host, so a remote
 * on git.wandworks.test or gitlab-work links to the right pages. Read once after
 * sign-in; the organization settings register theirs again on a save.
 */
export async function loadGitHosts(): Promise<void> {
  try {
    const hosts = await api.gitHosts();
    registerGitlabHosts(hosts.gitlab);
    registerGitHosts('detected', hosts.detected);
    registerHostAliases(hosts.aliases);
  } catch {
    // Not signed in yet, or the panel is restarting: links fall back to the host's name.
  }
}

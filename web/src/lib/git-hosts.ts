import { registerGitlabHosts } from '@devmagic-panel/shared';
import { api } from '@/lib/api';

/**
 * Your own GitLab hosts from the panel's settings, so a remote on
 * git.acme.test links to GitLab's pages, not GitHub-style ones. Read once
 * after sign-in; the organization settings register them again on a save.
 */
export async function loadGitHosts(): Promise<void> {
  try {
    registerGitlabHosts((await api.gitHosts()).gitlab);
  } catch {
    // Not signed in yet, or the panel is restarting: links fall back to the host's name.
  }
}

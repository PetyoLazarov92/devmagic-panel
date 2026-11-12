import type { ActionId, ActionRunResult } from '@devmagic-panel/shared';
import { navigate } from '@/lib/router';
import { api, isMockup } from '@/lib/api';
import { lastLine } from '@/lib/output';
import { toast } from '@/lib/toast';

export { lastLine };

/** Runs an action and reports the outcome as a toast. */
export async function runWithToast(id: ActionId, input: Record<string, unknown>, label: string): Promise<ActionRunResult | null> {
  try {
    const result = await api.runAction(id, input);
    // An action that starts a job (an update) has only started: the toast says so and opens its progress.
    const jobId = result.ok ? result.data?.jobId : undefined;
    toast(
      jobId ? { tone: 'success', title: `${label}: started`, action: { label: 'Show progress', run: () => navigate(`/jobs/${encodeURIComponent(jobId)}`) } }
      : result.ok ? { tone: 'success', title: label }
      : { tone: 'danger', title: `${label} failed`, detail: lastLine(result.output) },
    );
    return result;
  } catch (error) {
    toast({ tone: 'danger', title: `${label} failed`, detail: (error as Error).message });
    return null;
  }
}

/**
 * Opens wp-admin through a one-time login link. The tab is opened during the
 * click (browsers block tabs opened later) and pointed at the link once the
 * server has made it.
 */
/** A one-time login to wp-admin in a new tab; `site` is a domain, or a domain with the path of a site under it. */
export async function openWpAdmin(site: string | { domain: string; path?: string }, options: { siteUrl?: string; to?: 'admin' | 'network' } = {}): Promise<void> {
  const tab = isMockup ? null : window.open('about:blank', '_blank');
  const target = typeof site === 'string' ? { domain: site } : { domain: site.domain, ...(site.path ? { path: site.path } : {}) };
  try {
    const result = await api.runAction('site.login', { ...target, ...options });
    const url = result.data?.url;
    if (result.ok && url) {
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener');
      }
      return;
    }
    tab?.close();
    toast(
      isMockup
        ? { tone: 'info', title: 'Mockup: this opens wp-admin, already logged in' }
        : { tone: 'danger', title: 'Could not log in to wp-admin', detail: lastLine(result.output) },
    );
  } catch (error) {
    tab?.close();
    toast({ tone: 'danger', title: 'Could not log in to wp-admin', detail: (error as Error).message });
  }
}

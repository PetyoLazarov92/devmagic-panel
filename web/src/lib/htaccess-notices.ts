import { useEffect } from 'react';
import type { HtaccessChange } from '@devmagic-panel/shared';
import { api } from '@/lib/api';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';

const EVENT = 'dmp:htaccess-changed';

/** The site page of a change, its Server and PHP tab with the review open. */
export const reviewHref = (domain: string) => `/sites/${encodeURIComponent(domain)}?tab=php&review=htaccess`;

/** Tells an open .htaccess rules card that its site's files changed, so it reads them again. */
export function onHtaccessChanged(listener: (domain: string) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** The notice of one change: what nginx would get, and Review. */
function notice(change: HtaccessChange): void {
  const parts = [change.added ? `${change.added} rule${change.added === 1 ? '' : 's'} to add` : '', change.removed ? `${change.removed} to take out` : ''].filter(Boolean).join(' and ');
  toast({
    tone: 'info',
    key: `htaccess:${change.domain}`,
    title: `${change.domain}: .htaccess changed`,
    detail: change.kind === 'rules' ? `nginx does not have it yet: ${parts}.` : 'It has new rules nginx does nothing with.',
    action: { label: 'Review', run: () => navigate(reviewHref(change.domain)) },
  });
}

/**
 * Asks the panel every 20 seconds, while the page is in view, for changes to
 * the .htaccess files of sites on nginx since the last answer, and says so:
 * a notice with Review for a change nginx would need, nothing for a quiet one
 * (caches, WordPress's own rules). Nothing is applied without the review.
 */
export function useHtaccessNotices(): void {
  useEffect(() => {
    let since: string | undefined;
    let stopped = false;
    const look = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const answer = await api.htaccessChanges(since);
        if (stopped) return;
        // The first answer only sets where to ask from: changes before the page opened are on Aura.
        if (since !== undefined) {
          for (const change of answer.changes) {
            window.dispatchEvent(new CustomEvent(EVENT, { detail: change.domain }));
            if (change.kind !== 'quiet') notice(change);
          }
        }
        since = answer.now;
      } catch {
        // The panel restarting, or signed out: the next look tries again.
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), 20_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
}

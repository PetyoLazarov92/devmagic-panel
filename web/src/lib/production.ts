import type { ProductionSettings } from '@devmagic-panel/shared';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';

type SiteId = { domain: string; path?: string };

/**
 * Forgets the server saved for a site, so Refresh from production, missing
 * plugins and Uploads from production ask again. The toast's Undo saves it
 * back. done gets what the site has now: null, or the settings put back.
 */
export async function forgetProduction(site: SiteId, done: (now: ProductionSettings | null) => void): Promise<void> {
  try {
    const { forgotten } = await api.forgetProductionSettings(site.domain, site.path);
    done(null);
    if (!forgotten) return;
    toast({
      tone: 'success',
      title: `Forgot ${forgotten.host}`,
      detail: 'The site has no saved server now: Refresh from production, missing plugins and uploads ask for one.',
      action: {
        label: 'Undo',
        run: () =>
          void api.saveProductionSettings(site.domain, site.path, forgotten).then(
            (back) => done(back),
            (err: Error) => toast({ tone: 'danger', title: `${forgotten.host} was not put back`, detail: err.message }),
          ),
      },
    });
  } catch (err) {
    toast({ tone: 'danger', title: 'The server was not forgotten', detail: (err as Error).message });
  }
}

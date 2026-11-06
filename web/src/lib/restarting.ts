import { api } from '@/lib/api';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';

/**
 * Runs an action that restarts Apache. The panel itself sits behind Apache,
 * so the answer can be cut off by the restart; that is reported as likely
 * done, and the page checks again a moment later.
 */
export async function runRestarting(id: 'service.restart' | 'apache.reload' | 'nginx.reload' | 'apache.setModule' | 'php.setXdebug' | 'php.setModule' | 'php.setIni' | 'php.setCli', input: Record<string, unknown>, label: string, after: () => void) {
  try {
    const result = await api.runAction(id, input);
    toast(result.ok ? { tone: 'success', title: label } : { tone: 'danger', title: `${label} failed`, detail: lastLine(result.output) });
  } catch (error) {
    toast(
      error instanceof TypeError
        ? { tone: 'info', title: 'Apache is restarting', detail: 'The connection dropped during the restart; checking again shortly.' }
        : { tone: 'danger', title: `${label} failed`, detail: (error as Error).message },
    );
  }
  window.setTimeout(after, 1500);
}

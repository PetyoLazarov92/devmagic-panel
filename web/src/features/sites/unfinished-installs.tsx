import type { InstallDraft } from '@devmagic-panel/shared';
import { History } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardFooter, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { draftHref, draftProgress, KIND_LABEL, keptUntil } from '@/lib/drafts';
import { timeAgo } from '@/lib/format';
import { navigate } from '@/lib/router';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** How many show before Show all. */
const FIRST = 3;

/**
 * Installs started in the wizard and left, on the Sites page: continue one
 * where it stopped, or throw it away with its dump.
 */
export function UnfinishedInstalls({ drafts, onChanged, className }: { drafts: InstallDraft[]; onChanged: () => void; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (drafts.length === 0) return null;
  async function discard(draft: InstallDraft) {
    setBusy(draft.id);
    try {
      await api.discardDraft(draft.id);
      onChanged();
    } catch (err) {
      toast({ tone: 'danger', title: 'Not discarded', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }
  const shown = all ? drafts : drafts.slice(0, FIRST);
  return (
    <Card id="unfinished-installs" className={cn('scroll-mt-6', className)}>
      <CardHeader title="Unfinished installs" meta={<History className="size-4 text-muted-foreground" />} />
      <ul className="divide-y">
        {shown.map((d) => {
          const p = draftProgress(d);
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="max-w-full truncate font-mono text-dense font-medium">{d.title || 'New site'}</span>
                  <Badge className="shrink-0">{KIND_LABEL[p.kind]}</Badge>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {d.status === 'installing'
                    ? 'Installing now'
                    : `${d.status === 'failed' ? 'The install failed · ' : ''}Step ${p.at} of ${p.total}: ${p.label} · saved ${timeAgo(d.updatedAt)}${d.expiresAt ? ` · kept until ${keptUntil(d.expiresAt)}` : ''}`}
                </p>
              </div>
              {d.status !== 'installing' && (
                <div
                  role="progressbar"
                  aria-label={`Step ${p.at} of ${p.total}`}
                  aria-valuemin={0}
                  aria-valuemax={p.total}
                  aria-valuenow={p.at}
                  className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
                >
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(p.at / p.total) * 100}%` }} />
                </div>
              )}
              {d.status === 'installing' && d.jobId ? (
                <ButtonLink size="sm" variant="outline" href={`/jobs/${encodeURIComponent(d.jobId)}`}>See progress</ButtonLink>
              ) : (
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => navigate(draftHref(d.id, p.step))}>Continue</Button>
                  <Button size="sm" variant="soft" disabled={busy === d.id} onClick={() => void discard(d)}>Discard</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {drafts.length > FIRST && (
        <CardFooter>
          <Button size="sm" variant="soft" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${drafts.length}`}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

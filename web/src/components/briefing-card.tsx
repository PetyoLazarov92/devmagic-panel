import type { AuraItem } from '@devmagic-panel/shared';
import { Check, CircleAlert, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { runWithToast } from '@/lib/site-actions';
import { useAsync } from '@/lib/use-async';

/** A fix from the panel's own findings; Claude only chose which ones to show. */
function FixButton({ item }: { item: AuraItem }) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const fix = item.fix;
  if (!fix) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={state !== 'idle'}
      onClick={async () => {
        setState('running');
        const result = await runWithToast(fix.action, fix.input, item.domain ? `${fix.label} (${item.domain})` : fix.label);
        setState(result?.ok ? 'done' : 'idle');
      }}
    >
      {state === 'running' ? <LoaderCircle className="animate-spin" /> : state === 'done' ? <Check className="text-success" /> : <Wrench />}
      {fix.label}
      {item.domain && <span className="font-normal text-muted-foreground">{item.domain.replace(/^(www\.)?local\./, '')}</span>}
    </Button>
  );
}

/**
 * The login briefing. It loads after the page shows, so it never slows the
 * panel down, and shows nothing at all while the assistant is off.
 */
export function BriefingCard() {
  const { data, loading } = useAsync(() => api.briefing(), []);

  if (loading && !data) {
    return (
      <p className="mt-6 flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin text-primary" />
        Claude is reading your sites...
      </p>
    );
  }
  if (!data || data.status === 'off') return null;
  if (data.status === 'clear') {
    return <p className="mt-6 flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm"><Sparkles className="size-4 text-primary" />Nothing needs your attention today.</p>;
  }
  if (data.status === 'error') {
    return (
      <p className="mt-6 flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>No briefing: {data.error} The <Link href="/aura" className="font-medium text-foreground hover:underline">Aura</Link> page has every finding.</span>
      </p>
    );
  }

  return (
    <section className="mt-6 rounded-xl border bg-card" aria-label="Briefing">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{data.headline}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Briefing by Claude from the panel's own checks. Every fix below is one of the panel's buttons.</p>
        </div>
      </div>
      <ol className="divide-y">
        {data.points.map((point) => (
          <li key={point.text} className="grid gap-2 px-5 py-3 text-sm">
            <p>{point.text}</p>
            {point.items.some((i) => i.fix) && (
              <div className="flex flex-wrap gap-2">
                {point.items.filter((i, idx, all) => i.fix && all.findIndex((x) => JSON.stringify(x.fix) === JSON.stringify(i.fix)) === idx).map((item) => (
                  <FixButton key={`${item.id}:${item.domain ?? ''}`} item={item} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <details className="border-t px-5 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">What was sent to Claude ({data.model})</summary>
        <p className="mt-2">Only the panel's findings, with anything secret-looking blanked out. No database contents, passwords or keys.</p>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono whitespace-pre-wrap">{data.sent}</pre>
      </details>
    </section>
  );
}

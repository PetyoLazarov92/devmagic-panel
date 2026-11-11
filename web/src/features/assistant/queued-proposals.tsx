import type { QueuedProposal } from '@devmagic-panel/shared';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ProposalCard } from '@/features/assistant/assistant-drawer';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** What the button says: who suggests and how many, short enough for the bar. */
export function suggestionsLabel(count: number): string {
  return count === 1 ? '1 suggestion' : `${count} suggestions`;
}

/**
 * Changes an MCP client like Claude Code suggested, behind a button in the
 * bar next to the jobs: the page stays clear, and a suggestion that comes in
 * while you work says so once. They wait until you run or dismiss them;
 * nothing from outside the panel runs on its own.
 */
export function QueuedProposals() {
  const [queued, setQueued] = useState<QueuedProposal[]>([]);
  const [open, setOpen] = useState(false);
  // Cards that ran stay a little while so their result or job progress shows, though the queue no longer lists them.
  const [ran, setRan] = useState<QueuedProposal[]>([]);
  const box = useRef<HTMLDivElement>(null);
  // The ones already known: the first read tells nothing new, later ones do.
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.proposals().then((list) => {
        if (!alive) return;
        const before = known.current;
        const fresh = before ? list.filter((p) => !before.has(p.id)) : [];
        known.current = new Set(list.map((p) => p.id));
        setQueued(list);
        if (fresh.length) {
          const first = fresh[0] as QueuedProposal;
          toast({
            tone: 'info',
            key: 'suggestions',
            title: fresh.length === 1 ? `${first.source} suggests: ${first.title}` : `${first.source} suggests ${fresh.length} changes`,
            action: { label: 'Show', run: () => setOpen(true) },
          });
        }
      }, () => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const shown = [...queued, ...ran.filter((r) => !queued.some((q) => q.id === r.id))];
  if (shown.length === 0) return null;
  const sources = [...new Set(shown.map((p) => p.source))].join(', ');
  const label = suggestionsLabel(queued.length || shown.length);

  return (
    <div ref={box} className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={`${sources}: ${label}`} className={cn(queued.length > 0 && 'border-primary/40 text-primary hover:text-primary')}>
        <Sparkles />
        <span className="sm:hidden">{queued.length || shown.length}</span>
        <span className="hidden sm:inline">{label}</span>
      </Button>
      {open && (
        <div role="dialog" aria-label="Suggested changes" className="absolute right-0 z-30 mt-2 grid w-[min(26rem,calc(100vw-2rem))] rounded-lg border bg-card text-sm shadow-lg">
          <p className="border-b px-4 py-2.5 text-xs text-muted-foreground">
            {sources} {shown.length === 1 ? 'suggests a change' : `suggests ${shown.length} changes`}. Nothing runs until you press Run.
          </p>
          <div className="grid max-h-[70vh] gap-2 overflow-y-auto p-3">
            {shown.map((p) => (
              <div key={p.id} className="grid gap-1">
                <p className="text-2xs text-muted-foreground">From {p.source}, {timeAgo(p.createdAt)}</p>
                <ProposalCard
                  proposal={p}
                  onClose={(status) => {
                    void api.closeProposal(p.id, status).catch(() => undefined);
                    setQueued((all) => all.filter((x) => x.id !== p.id));
                    if (status === 'ran') {
                      setRan((all) => [...all, p]);
                      window.setTimeout(() => setRan((all) => all.filter((x) => x.id !== p.id)), 15_000);
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

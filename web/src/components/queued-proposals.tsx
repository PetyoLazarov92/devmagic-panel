import type { QueuedProposal } from '@devmagic-panel/shared';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProposalCard } from '@/components/assistant-drawer';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

/**
 * Changes an MCP client like Claude Code suggested. They wait here until you
 * run or dismiss them; nothing from outside the panel runs on its own.
 */
export function QueuedProposals() {
  const [queued, setQueued] = useState<QueuedProposal[]>([]);
  const [open, setOpen] = useState(true);
  // Cards that ran stay a little while so their result or job progress shows, though the queue no longer lists them.
  const [ran, setRan] = useState<QueuedProposal[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => api.proposals().then((list) => alive && setQueued(list), () => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const shown = [...queued, ...ran.filter((r) => !queued.some((q) => q.id === r.id))];
  if (shown.length === 0) return null;
  const sources = [...new Set(shown.map((p) => p.source))].join(', ');

  return (
    <aside className="fixed right-4 bottom-4 z-30 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-card shadow-lg" aria-label="Suggested changes">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium">
        <Sparkles className="size-4 text-primary" />
        <span className="flex-1">{sources} suggests {shown.length === 1 ? 'a change' : `${shown.length} changes`}</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto border-t p-3">
          {shown.map((p) => (
            <div key={p.id} className="grid gap-1">
              <p className="text-[11px] text-muted-foreground">From {p.source}, {timeAgo(p.createdAt)}</p>
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
      )}
    </aside>
  );
}

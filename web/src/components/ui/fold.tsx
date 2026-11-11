import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A titled part of a long card that folds: its title, a short note of what is inside ("2 set
 * here"), and the content under it when open. Folded content stays in the page, hidden, so a
 * form keeps what you typed. For a card that would run past the window, never a scroll box.
 */
export function Fold({ title, note, defaultOpen = false, children, className }: { title: ReactNode; note?: ReactNode; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn('grid gap-3', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm font-medium transition-colors hover:bg-muted/60"
      >
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="min-w-0 flex-1">{title}</span>
        {note && <span className="shrink-0 text-xs font-normal text-muted-foreground">{note}</span>}
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

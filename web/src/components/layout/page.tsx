import { Check, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePageName } from '@/lib/modes';

/**
 * The pieces every page is made of, so pages of one type look and behave the
 * same (see `.cursor/rules/ui-ux.mdc`, One layout per page type): the header
 * of a page, the bar at the top of a tab or view, a notice, an empty state, and
 * the one button that reads a page again.
 */

/** The least time the icon turns, so a read that answers at once still shows it ran. */
const CHECK_MIN_MS = 600;
/** How long "Checked" stays once the answer is in. */
const CHECKED_MS = 2000;

/**
 * Reads the page or view again: the same words and turning icon everywhere.
 * The icon turns until the answer is in (at least a moment), then the button
 * says Checked for two seconds, so a read that found nothing new still shows
 * it ran.
 */
export function CheckAgain({ onClick, loading = false, disabled = false, size }: { onClick: () => void; loading?: boolean; disabled?: boolean; size?: 'sm' }) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const started = useRef(0);

  useEffect(() => {
    if (phase === 'busy' && !loading) {
      const t = window.setTimeout(() => setPhase('done'), Math.max(0, CHECK_MIN_MS - (Date.now() - started.current)));
      return () => window.clearTimeout(t);
    }
    if (phase === 'done') {
      const t = window.setTimeout(() => setPhase('idle'), CHECKED_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [phase, loading]);

  const busy = loading || phase === 'busy';
  return (
    <Button
      variant="outline"
      {...(size ? { size } : {})}
      onClick={() => {
        started.current = Date.now();
        setPhase('busy');
        onClick();
      }}
      disabled={disabled || busy}
      aria-live="polite"
    >
      {phase === 'done' && !loading ? <Check className="text-success" /> : <RefreshCw className={cn(busy && 'animate-spin')} />}
      {phase === 'done' && !loading ? 'Checked' : 'Check again'}
    </Button>
  );
}

/** A page's title and what it is for on the left, its actions on the right, Check again last. */
export function PageHeader({ title, intro, actions, className }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode; className?: string }) {
  // A mode may give the page a name of its own (Mail is Ravens in Wizard); the Classic one stays in the tooltip.
  const name = usePageName();
  const shown = typeof title === 'string' ? name(title) : title;
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      {/* A fixed basis: the text wraps its own lines, so the buttons stay beside it whatever it says. */}
      <div className="min-w-0 flex-[1_1_20rem]">
        <h1 className="text-2xl font-semibold tracking-tight" data-ui="page-title" title={shown !== title && typeof title === 'string' ? title : undefined}>{shown}</h1>
        {intro && <p className="mt-1 text-sm text-muted-foreground">{intro}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The bar at the top of a tab or a view: what it is about (a picker, filters)
 * on the left, Check again on the right, and under it what was read and when.
 * With nothing on the left, the note takes its place, so the bar is one line.
 */
export function ViewBar({ children, actions, onCheck, loading = false, checkedAt, note, className }: {
  children?: ReactNode;
  actions?: ReactNode;
  onCheck?: () => void;
  loading?: boolean;
  /** When the view was read, as an ISO time: "read 2 min ago". */
  checkedAt?: string | undefined;
  note?: ReactNode;
  className?: string;
}) {
  const read = checkedAt ? `Read ${timeAgo(checkedAt)}.` : null;
  const left = children !== undefined && children !== null && children !== false;
  const line = (read || note) && (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground', !left && 'min-w-0 flex-[1_1_20rem]')}>
      {note && <span className="min-w-0">{note}</span>}
      {read && <span>{read}</span>}
    </p>
  );
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-3">
        {left ? children : line}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
          {onCheck && <CheckAgain size="sm" onClick={onCheck} loading={loading} />}
        </div>
      </div>
      {left && line}
    </div>
  );
}

/** Notice and EmptyState live with the other parts in components/ui; kept here for the pages that import them from this file. */
export { EmptyState, Notice } from '@/components/ui/notice';

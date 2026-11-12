import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The pieces every page is made of, so pages of one type look and behave the
 * same (see `.cursor/rules/ui-ux.mdc`, One layout per page type): the header
 * of a page, the bar at the top of a tab or view, a notice, an empty state, and
 * the one button that reads a page again.
 */

/** Reads the page or view again: the same words and turning icon everywhere. */
export function CheckAgain({ onClick, loading = false, disabled = false, size }: { onClick: () => void; loading?: boolean; disabled?: boolean; size?: 'sm' }) {
  return (
    <Button variant="outline" {...(size ? { size } : {})} onClick={onClick} disabled={disabled || loading}>
      <RefreshCw className={cn(loading && 'animate-spin')} />
      Check again
    </Button>
  );
}

/** A page's title and what it is for on the left, its actions on the right, Check again last. */
export function PageHeader({ title, intro, actions, className }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      {/* A fixed basis: the text wraps its own lines, so the buttons stay beside it whatever it says. */}
      <div className="min-w-0 flex-[1_1_20rem]">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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

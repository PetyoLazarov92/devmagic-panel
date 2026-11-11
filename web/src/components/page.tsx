import { CircleAlert, Info, RefreshCw, TriangleAlert } from 'lucide-react';
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
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-3">
        {children}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
          {onCheck && <CheckAgain size="sm" onClick={onCheck} loading={loading} />}
        </div>
      </div>
      {(read || note) && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {note && <span className="min-w-0">{note}</span>}
          {read && <span>{read}</span>}
        </p>
      )}
    </div>
  );
}

const TONES = {
  danger: { box: 'border-danger/30 bg-danger/8 text-danger', icon: CircleAlert },
  warning: { box: 'border-warning/30 bg-warning/8 text-foreground', icon: TriangleAlert },
  info: { box: 'bg-muted/50 text-muted-foreground', icon: Info },
} as const;

/**
 * Something the whole page or view should know, right under its header or bar:
 * an error (danger), a problem with a way out (warning), or a fact (info).
 * A field's own error stays next to the field.
 */
export function Notice({ tone = 'danger', children, action, className }: { tone?: keyof typeof TONES; children: ReactNode; action?: ReactNode; className?: string }) {
  const { box, icon: Icon } = TONES[tone];
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm', box, className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'warning' && 'text-warning')} aria-hidden />
      <div className="min-w-0 flex-[1_1_16rem] [overflow-wrap:anywhere]">{children}</div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** Nothing here yet: what would be here, and the way to get it. */
export function EmptyState({ icon: Icon, title, children, action, className }: { icon: typeof Info; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid justify-items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-12 text-center', className)}>
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

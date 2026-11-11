import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      primary: 'bg-primary/12 text-primary',
      success: 'bg-success/12 text-success',
      warning: 'bg-warning/15 text-warning',
      danger: 'bg-danger/12 text-danger',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/** A short label on a thing: what it is or how it stands. Coloured only for status. */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** A number in a tab, a menu item or a filter: only what needs a look is coloured. */
export function CountBadge({ count, tone = 'neutral', className }: { count: number; tone?: 'neutral' | 'warning' | 'danger' | 'primary'; className?: string }) {
  return <span className={cn(badgeVariants({ tone }), 'px-1.5 py-0 text-2xs tabular-nums', className)}>{count}</span>;
}

export type Status = 'ok' | 'warn' | 'fail' | 'off' | 'running';

const STATUS_TONE = { ok: 'success', warn: 'warning', fail: 'danger', off: 'neutral', running: 'primary' } as const;
const STATUS_WORD = { ok: 'Running', warn: 'Needs a look', fail: 'Failing', off: 'Stopped', running: 'Working' } as const;

/** How a service, check or site stands, always in the same colour for the same state. */
export function StatusBadge({ status, children, className }: { status: Status; children?: string; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {status === 'running' ? <Spinner className="size-3" /> : <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children ?? STATUS_WORD[status]}
    </Badge>
  );
}

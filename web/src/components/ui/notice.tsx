import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  danger: { box: 'border-danger/30 bg-danger/8 text-danger', icon: CircleAlert, iconTone: '' },
  warning: { box: 'border-warning/30 bg-warning/8 text-foreground', icon: TriangleAlert, iconTone: 'text-warning' },
  success: { box: 'border-success/30 bg-success/8 text-foreground', icon: CircleCheck, iconTone: 'text-success' },
  info: { box: 'bg-muted/50 text-muted-foreground', icon: Info, iconTone: '' },
} as const;

export type NoticeTone = keyof typeof TONES;

/**
 * The one tinted box. Something the whole page or view should know, right under its header or
 * bar: an error (danger), a problem with a way out (warning), a result (success) or a fact
 * (info). `inline` is the smaller one inside a card. One tone per box: a warning never sits in
 * a danger box. A field's own error stays next to the field.
 */
export function Notice({ tone = 'danger', size = 'default', children, action, icon = true, className }: { tone?: NoticeTone; size?: 'default' | 'inline'; children: ReactNode; action?: ReactNode; icon?: boolean; className?: string }) {
  const { box, icon: Icon, iconTone } = TONES[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-ui="notice"
      data-tone={tone}
      className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border', size === 'inline' ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm', box, className)}
    >
      {icon && <Icon className={cn('shrink-0', size === 'inline' ? 'mt-px size-3.5' : 'mt-0.5 size-4', iconTone)} aria-hidden />}
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

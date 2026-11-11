import type { ReactNode } from 'react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const SUB_TONE = { neutral: 'text-muted-foreground', success: 'text-success', warning: 'text-warning', danger: 'text-danger' } as const;

/**
 * One number or fact with its label and a short line under it, in a row of tiles: a summary
 * that opens the tab or card with the rest. The line takes the tone of what it says.
 */
export function StatTile({ label, value, sub, tone = 'neutral', href, onClick, className }: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof SUB_TONE;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      <span className="block truncate text-xs text-muted-foreground">{label}</span>
      <span className="block truncate text-sm font-semibold">{value}</span>
      {sub && <span className={cn('block truncate text-xs', SUB_TONE[tone])}>{sub}</span>}
    </>
  );
  const box = cn('block min-w-0 rounded-lg border bg-card px-3 py-2.5 text-left', (href || onClick) && 'transition-colors hover:border-ring/50 hover:bg-muted/40', tone === 'danger' && 'border-danger/30', tone === 'warning' && 'border-warning/30', className);
  if (href) return <Link href={href} className={box}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={box}>{body}</button>;
  return <div className={box}>{body}</div>;
}

/** Tiles side by side: as many as fit, each at least 9rem wide. */
export function StatTiles({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2', className)}>{children}</div>;
}

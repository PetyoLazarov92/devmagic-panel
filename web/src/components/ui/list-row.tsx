import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Rows in a card, between lines, reaching its edges: put it in a flush CardBody. */
export function RowList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul className={cn('divide-y', className)} aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One row of a list: something at its start (a switch, a status dot, an icon), its name and a
 * line under it (often mono: a slug, a path), badges, then its actions and a Menu.
 */
export function ListRow({ leading, title, sub, badges, actions, className, children }: {
  leading?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** More under the row, such as an open detail. */
  children?: ReactNode;
}) {
  return (
    <li className={cn('grid gap-2 px-5 py-3 text-sm', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {leading && <div className="flex shrink-0 items-center">{leading}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-medium">{title}</span>
            {badges}
          </div>
          {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </li>
  );
}

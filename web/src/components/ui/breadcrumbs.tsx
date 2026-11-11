import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: ReactNode;
  /** Where it goes; the last crumb, the page you are on, has none. */
  href?: string;
}

/**
 * Where a page sits, above its title: every page below the menu's top level has them
 * ("Sites / local.x / Database"), never a back arrow of its own. On a phone only the way back
 * to the page above shows.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const parent = [...items].reverse().find((c) => c.href);
  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0 text-sm', className)}>
      {parent?.href && (
        <Link href={parent.href} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground sm:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {parent.label}
        </Link>
      )}
      <ol className="hidden min-w-0 flex-wrap items-center gap-1 text-muted-foreground sm:flex">
        {items.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden />}
            <li className="min-w-0 truncate">
              {c.href && i < items.length - 1 ? (
                <Link href={c.href} className="hover:text-foreground hover:underline">{c.label}</Link>
              ) : (
                <span aria-current={i === items.length - 1 ? 'page' : undefined} className={cn(i === items.length - 1 && 'text-foreground')}>{c.label}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

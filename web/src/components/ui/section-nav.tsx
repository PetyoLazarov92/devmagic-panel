import { Fragment, type ReactNode } from 'react';
import { CountBadge } from '@/components/ui/badge';
import { type TabItem, Tabs } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * A detail page's sections (a site's Overview, Logs, Files...): a menu down the side on a wide
 * screen, in its groups with a line between them and each badge in view, so no section hides
 * under More; the usual tabs on a narrower one. Next to it, the section's content.
 */
export function SectionLayout<T extends string>({ label, items, value, onChange, children, className }: {
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-6 lg:grid-cols-[11.5rem_minmax(0,1fr)]', className)}>
      <div className="lg:hidden">
        <Tabs items={items} value={value} onChange={onChange} />
      </div>
      <nav aria-label={label} className="hidden lg:block">
        <ul className="sticky top-4 grid gap-0.5">
          {items.map((item, i) => {
            const on = item.value === value;
            return (
              <Fragment key={item.value}>
                {item.startsGroup && i > 0 && <li aria-hidden className="mx-2.5 my-1.5 border-t" />}
                <li>
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onChange(item.value)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                      on ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.count !== undefined && <CountBadge count={item.count} tone={item.tone ?? 'neutral'} />}
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

import { type ComponentType, Fragment, type ReactNode } from 'react';
import { CountBadge } from '@/components/ui/badge';
import { type TabItem, Tabs } from '@/components/ui/tabs';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

/**
 * A detail page's sections (a site's Overview, Logs, Files...): a menu down the side on a wide
 * screen, in a frame like the cards next to it, each section with its icon, in its groups with
 * a line between them and each badge in view, so no section hides under More; the usual tabs on
 * a narrower one. Next to it, the section's content.
 */
export function SectionLayout<T extends string>({ label, items, value, onChange, icons, views, children, className }: {
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** An icon per section for the side menu, as the main menu has. */
  icons?: Partial<Record<T, ComponentType<{ className?: string }>>>;
  /** The open section's own views, listed under it in the menu; the section draws them as small tabs below lg. */
  views?: { items: Array<{ value: string; label: string; href: string }>; value: string } | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]', className)}>
      <div className="lg:hidden">
        <Tabs items={items} value={value} onChange={onChange} />
      </div>
      <nav aria-label={label} className="hidden lg:block">
        <ul data-ui="section-nav" className="sticky top-4 grid gap-0.5 rounded-xl border bg-card p-1.5 shadow-xs">
          {items.map((item, i) => {
            const on = item.value === value;
            const Icon: ComponentType<{ className?: string }> | undefined = icons?.[item.value];
            return (
              <Fragment key={item.value}>
                {item.startsGroup && i > 0 && <li aria-hidden className="mx-2.5 my-1.5 border-t" />}
                <li>
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onChange(item.value)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      on ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {Icon && <Icon className="size-4 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.count !== undefined && <CountBadge count={item.count} tone={item.tone ?? 'neutral'} />}
                  </button>
                  {on && views && views.items.length > 1 && (
                    <ul aria-label={`${typeof item.label === 'string' ? item.label : item.value} views`} className={cn('mt-0.5 mb-1 grid gap-0.5 border-l', Icon ? 'ml-4.5 pl-2' : 'ml-3.5 pl-1.5')}>
                      {views.items.map((v) => {
                        const here = v.value === views.value;
                        return (
                          <li key={v.value}>
                            <Link
                              href={v.href}
                              aria-current={here ? 'page' : undefined}
                              className={cn(
                                // The open view in darker text only: no fill and no edge, so the section above stays the one marked.
                                'block truncate rounded-md px-2.5 py-1 text-dense transition-colors',
                                here ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {v.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </nav>
      {/* A container: the cards inside lay out by the room this column has, not by the window. */}
      <div className="@container min-w-0">{children}</div>
    </div>
  );
}

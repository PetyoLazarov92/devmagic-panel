import { Fragment, type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  /** Colors the count, for problems such as failing checks. */
  tone?: 'warning' | 'danger';
  /** Draws a thin line before the tab, between groups of related tabs. */
  startsGroup?: boolean;
}

interface Props<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** Underline tabs with arrow-key navigation (WAI-ARIA tabs pattern). */
export function Tabs<T extends string>({ items, value, onChange, className }: Props<T>) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKey(event: KeyboardEvent, index: number) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    onChange(item.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto overflow-y-hidden border-b', className)}>
      {items.map((item, i) => {
        const selected = item.value === value;
        return (
          <Fragment key={item.value}>
            {item.startsGroup && i > 0 && <span aria-hidden className="my-2 w-px shrink-0 bg-border" />}
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`${id}-${item.value}`}
              role="tab"
              type="button"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.value)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
                selected ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
              {item.count !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[11px] font-medium tabular-nums',
                    item.tone === 'danger' ? 'bg-danger/12 text-danger' : item.tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

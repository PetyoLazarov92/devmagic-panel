import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface FilterChip<T extends string> {
  value: T;
  label: string;
  count?: number;
  /** Colours the count when what it counts needs a look. */
  tone?: 'warning' | 'danger';
}

/**
 * Filters with counts, one picked: "All 13", "On 7", "Updates 3". The same control on every list
 * (Sites, Plugins, Mail, Cores); Segmented is for how one thing shows, not for filters.
 */
export function FilterChips<T extends string>({ label, value, onChange, options, className }: { label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<FilterChip<T>>; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-ui="chip"
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors',
              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:border-ring/50 hover:text-foreground',
            )}
          >
            {o.label}
            {o.count !== undefined && ' '}
            {o.count !== undefined && (
              <span className={cn('tabular-nums', !on && o.tone === 'danger' && 'text-danger', !on && o.tone === 'warning' && 'text-warning', on && 'opacity-80')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The bar over a list: a search on the left, filters after it, then pickers and the view
 * switch at its end. It wraps on a narrow screen and never scrolls sideways.
 */
/** One height for everything in a row of filters, whatever each control's own: the search, the chips, the pickers and the view switch line up. */
export const FILTER_ROW_HEIGHT = '[&_[data-ui=chip]]:h-9 [&_[data-ui=segmented]]:h-9 [&_input:not([type=checkbox],[type=radio])]:h-9 [&_select]:h-9';

export function FilterBar({ search, children, end, className }: { search?: ReactNode; children?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', FILTER_ROW_HEIGHT, className)}>
      {search && <div className="min-w-48 flex-[1_1_14rem]">{search}</div>}
      {children}
      {end && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
    </div>
  );
}

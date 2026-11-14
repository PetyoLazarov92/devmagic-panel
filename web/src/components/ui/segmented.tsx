import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

/** A few views of one thing side by side, one picked (a radio group drawn as joined buttons), each with an icon when given. */
export function Segmented<T extends string>({ label, value, onChange, options, className }: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string] | readonly [T, string, ComponentType<{ className?: string }>]>;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-ui="segmented" className={cn('inline-flex rounded-lg border bg-muted p-0.5 text-sm', className)}>
      {options.map(([v, text, Icon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1 whitespace-nowrap text-muted-foreground hover:text-foreground', value === v && 'bg-card text-foreground shadow-xs ring-1 ring-border')}
        >
          {Icon && <Icon className="size-3.5 shrink-0" />}
          {text}
        </button>
      ))}
    </div>
  );
}

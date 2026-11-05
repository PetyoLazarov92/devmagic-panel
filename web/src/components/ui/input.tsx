import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** React 19 passes `ref` as a prop, so ComponentProps carries it through to the input. */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
        className,
      )}
      {...props}
    />
  );
}

/** React 19 passes `ref` as a prop, so ComponentProps carries it through. */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-24 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
        className,
      )}
      {...props}
    />
  );
}

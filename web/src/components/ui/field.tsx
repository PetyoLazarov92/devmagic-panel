import type { ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Label, control and an optional hint, stacked. */
export function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: ReactNode; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A dropdown with the panel's arrow; its open list follows the theme where the browser allows (see .dmp-select). */
export function Select({ className, wrapClassName, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return (
    <div className={cn('relative', wrapClassName)}>
      <select
        className={cn(
          'dmp-select h-10 w-full cursor-pointer appearance-none rounded-md border border-input bg-card pr-9 pl-3 text-sm shadow-xs transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export function Checkbox({ id, checked, onChange, label, hint, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label htmlFor={id} className={cn('flex items-start gap-2.5 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input
        id={id}
        type="checkbox"
        disabled={disabled}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
